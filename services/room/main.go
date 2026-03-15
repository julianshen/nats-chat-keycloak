package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/XSAM/otelsql"
	otelhelper "github.com/example/nats-chat-otelhelper"
	_ "github.com/lib/pq"
	"github.com/nats-io/nats.go"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
	"go.opentelemetry.io/otel/trace"
)

// MembershipEvent is the payload for room.join.* and room.leave.* messages.
type MembershipEvent struct {
	UserId string `json:"userId"`
}

// RoomChangedEvent is a delta event published to room.changed.{room}.
type RoomChangedEvent struct {
	Room   string `json:"room"`
	Action string `json:"action"` // "join" or "leave"
	UserId string `json:"userId"`
	Type   string `json:"type,omitempty"` // "private", "dm", or "" (public)
}

// Room management types
type RoomInfo struct {
	Name        string       `json:"name"`
	DisplayName string       `json:"displayName,omitempty"`
	Creator     string       `json:"creator"`
	Type        string       `json:"type"`
	CreatedAt   string       `json:"createdAt,omitempty"`
	Members     []RoomMember `json:"members,omitempty"`
	MemberCount int          `json:"memberCount,omitempty"`
}

type RoomMember struct {
	Username string `json:"username"`
	Role     string `json:"role"`
}

type createRequest struct {
	Name        string `json:"name"`
	DisplayName string `json:"displayName"`
	User        string `json:"user"`
}

type listRequest struct {
	User string `json:"user"`
}

type inviteRequest struct {
	Target string `json:"target"`
	User   string `json:"user"`
}

type kickRequest struct {
	Target string `json:"target"`
	User   string `json:"user"`
}

type leaveRequest struct {
	User string `json:"user"`
}

// localMembership is a thread-safe forward-index rebuilt from room.changed deltas.
type localMembership struct {
	mu    sync.RWMutex
	rooms map[string]map[string]bool // room -> set of userIds
}

func newLocalMembership() *localMembership {
	return &localMembership{rooms: make(map[string]map[string]bool)}
}

func (m *localMembership) add(room, userId string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.rooms[room] == nil {
		m.rooms[room] = make(map[string]bool)
	}
	m.rooms[room][userId] = true
}

func (m *localMembership) remove(room, userId string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if members, ok := m.rooms[room]; ok {
		delete(members, userId)
		if len(members) == 0 {
			delete(m.rooms, room)
		}
	}
}

func (m *localMembership) members(room string) []string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	members := m.rooms[room]
	if len(members) == 0 {
		return nil
	}
	result := make([]string, 0, len(members))
	for uid := range members {
		result = append(result, uid)
	}
	return result
}

func (m *localMembership) roomCount() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.rooms)
}

func (m *localMembership) reset() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.rooms = make(map[string]map[string]bool)
}

// swapFrom atomically replaces the membership data with another instance's data.
func (m *localMembership) swapFrom(other *localMembership) {
	other.mu.RLock()
	rooms := other.rooms
	other.mu.RUnlock()

	m.mu.Lock()
	defer m.mu.Unlock()
	m.rooms = rooms
}

func envOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func publishSystemMessage(ctx context.Context, nc *nats.Conn, room, text string) {
	msg := map[string]interface{}{
		"user":      "__system__",
		"text":      text,
		"timestamp": time.Now().UnixMilli(),
		"room":      room,
		"action":    "system",
	}
	data, _ := json.Marshal(msg)
	otelhelper.TracedPublish(ctx, nc, "chat."+room, data)
}

func main() {
	ctx := context.Background()

	// Initialize OpenTelemetry
	otelShutdown, err := otelhelper.Init(ctx)
	if err != nil {
		slog.Error("Failed to initialize OpenTelemetry", "error", err)
		os.Exit(1)
	}
	defer otelShutdown(ctx)

	meter := otel.Meter("room-service")
	joinCounter, _ := meter.Int64Counter("room_joins_total",
		metric.WithDescription("Total room join events processed"))
	leaveCounter, _ := meter.Int64Counter("room_leaves_total",
		metric.WithDescription("Total room leave events processed"))
	queryCounter, _ := meter.Int64Counter("room_queries_total",
		metric.WithDescription("Total room membership queries"))
	roomReqCounter, _ := meter.Int64Counter("room_requests_total",
		metric.WithDescription("Total room management requests"))
	roomReqDuration, _ := otelhelper.NewDurationHistogram(meter, "room_request_duration_seconds", "Duration of room management requests")

	natsURL := envOrDefault("NATS_URL", "nats://localhost:4222")
	natsUser := envOrDefault("NATS_USER", "room-service")
	natsPass := envOrDefault("NATS_PASS", "room-service-secret")
	dbURL := envOrDefault("DATABASE_URL", "postgres://chat:chat-secret@localhost:5432/chatdb?sslmode=disable")

	// Connect to PostgreSQL (for room management)
	db, err := otelsql.Open("postgres", dbURL,
		otelsql.WithAttributes(semconv.DBSystemPostgreSQL))
	if err != nil {
		slog.Error("Failed to connect to database", "error", err)
		os.Exit(1)
	}
	defer db.Close()
	otelsql.RegisterDBStatsMetrics(db, otelsql.WithAttributes(semconv.DBSystemPostgreSQL))

	for i := 0; i < 30; i++ {
		if err = db.Ping(); err == nil {
			break
		}
		slog.Info("Waiting for database", "attempt", i+1, "error", err)
		time.Sleep(2 * time.Second)
	}
	if err != nil {
		slog.Error("Database not ready", "error", err)
		os.Exit(1)
	}

	slog.Info("Starting Room Service (sharded per-key KV + room management)", "nats_url", natsURL)

	mem := newLocalMembership()

	// Track known private rooms (loaded from DB at startup)
	var privateRoomsMu sync.RWMutex
	privateRooms := make(map[string]bool)

	// Load private rooms from DB
	rows, err := db.Query("SELECT name FROM rooms WHERE type = 'private'")
	if err != nil {
		slog.Error("Failed to load private rooms", "error", err)
		os.Exit(1)
	}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err == nil {
			privateRooms[name] = true
		}
	}
	rows.Close()
	slog.Info("Loaded private rooms from DB", "count", len(privateRooms))

	// createKVBucket creates (or re-binds to) the ROOMS KV bucket with FileStorage.
	createKVBucket := func(js nats.JetStreamContext) (nats.KeyValue, error) {
		return js.CreateKeyValue(&nats.KeyValueConfig{
			Bucket:  "ROOMS",
			History: 1,
			Storage: nats.FileStorage,
		})
	}

	// hydrateFromKV populates the local forward-index from existing KV keys.
	// Builds into a temporary localMembership then atomically swaps.
	// Keys are formatted as "{room}.{userId}".
	hydrateFromKV := func(kv nats.KeyValue) {
		tmp := newLocalMembership()
		watcher, err := kv.WatchAll(nats.IgnoreDeletes())
		if err != nil {
			slog.Error("Failed to start KV watcher for hydration", "error", err)
			return
		}
		defer watcher.Stop()

		count := 0
		for entry := range watcher.Updates() {
			if entry == nil {
				break // end of initial values
			}
			key := entry.Key()
			dotIdx := strings.LastIndex(key, ".")
			if dotIdx < 0 {
				continue
			}
			room := key[:dotIdx]
			userId := key[dotIdx+1:]
			tmp.add(room, userId)
			count++
		}
		mem.swapFrom(tmp)
		slog.Info("Hydrated local membership from KV (atomic swap)", "entries", count, "rooms", mem.roomCount())
	}

	// Connect to NATS with retry
	var nc *nats.Conn
	for attempt := 1; attempt <= 30; attempt++ {
		nc, err = nats.Connect(natsURL,
			nats.UserInfo(natsUser, natsPass),
			nats.Name("room-service"),
			nats.MaxReconnects(-1),
			nats.ReconnectWait(2*time.Second),
			nats.DisconnectErrHandler(func(_ *nats.Conn, err error) {
				slog.Warn("NATS disconnected", "error", err)
			}),
			nats.ReconnectHandler(func(nc *nats.Conn) {
				slog.Info("NATS reconnected — re-hydrating local membership from KV")
				js, jsErr := nc.JetStream()
				if jsErr != nil {
					slog.Error("Failed to get JetStream after reconnect", "error", jsErr)
					return
				}
				kv, kvErr := createKVBucket(js)
				if kvErr != nil {
					slog.Error("Failed to bind ROOMS KV after reconnect", "error", kvErr)
					return
				}
				hydrateFromKV(kv)
			}),
		)
		if err == nil {
			break
		}
		slog.Info("Waiting for NATS", "attempt", attempt, "error", err)
		time.Sleep(2 * time.Second)
	}
	if err != nil {
		slog.Error("Failed to connect to NATS", "error", err)
		os.Exit(1)
	}
	defer nc.Close()
	slog.Info("Connected to NATS", "url", nc.ConnectedUrl())

	// Create JetStream context and ROOMS KV bucket
	js, err := nc.JetStream()
	if err != nil {
		slog.Error("Failed to create JetStream context", "error", err)
		os.Exit(1)
	}

	roomsKV, err := createKVBucket(js)
	if err != nil {
		slog.Error("Failed to create ROOMS KV bucket", "error", err)
		os.Exit(1)
	}
	slog.Info("NATS KV bucket ready", "bucket", "ROOMS", "storage", "FileStorage")

	// Register active rooms gauge (from local cache)
	activeRoomsGauge, _ := meter.Int64ObservableGauge("room_active_rooms",
		metric.WithDescription("Number of active rooms with members"))
	_, _ = meter.RegisterCallback(func(_ context.Context, o metric.Observer) error {
		o.ObserveInt64(activeRoomsGauge, int64(mem.roomCount()))
		return nil
	}, activeRoomsGauge)

	// Subscribe to room.changed.* (no QG) — rebuild local forward-index from all deltas
	// This MUST be subscribed BEFORE hydration to ensure no missed events.
	_, err = nc.Subscribe("room.changed.*", func(msg *nats.Msg) {
		var evt RoomChangedEvent
		if err := json.Unmarshal(msg.Data, &evt); err != nil {
			slog.Warn("Invalid room.changed event", "error", err)
			return
		}
		switch evt.Action {
		case "join":
			mem.add(evt.Room, evt.UserId)
		case "leave":
			mem.remove(evt.Room, evt.UserId)
		}
	})
	if err != nil {
		slog.Error("Failed to subscribe to room.changed.*", "error", err)
		os.Exit(1)
	}

	// Hydrate local membership from KV (after subscribing to deltas)
	hydrateFromKV(roomsKV)

	// roomType returns the type of a room for delta events.
	roomType := func(room string) string {
		if strings.HasPrefix(room, "dm-") {
			return "dm"
		}
		privateRoomsMu.RLock()
		isPrivate := privateRooms[room]
		privateRoomsMu.RUnlock()
		if isPrivate {
			return "private"
		}
		return ""
	}

	// publishDelta publishes a delta room.changed.{room} event.
	publishDelta := func(ctx context.Context, room, action, userId string) {
		evt := RoomChangedEvent{
			Room:   room,
			Action: action,
			UserId: userId,
			Type:   roomType(room),
		}
		data, err := json.Marshal(evt)
		if err != nil {
			slog.WarnContext(ctx, "Failed to marshal room.changed delta", "error", err)
			return
		}
		otelhelper.TracedPublish(ctx, nc, "room.changed."+room, data)
		slog.DebugContext(ctx, "Published room.changed delta", "room", room, "action", action, "user", userId)
	}

	// addToRoom directly adds a user to a room: KV write + local cache + delta publish.
	// Replaces the old pattern of publishing room.join.* and waiting for self-processing.
	addToRoom := func(ctx context.Context, room, userId string) error {
		key := room + "." + userId
		_, err := roomsKV.Create(key, []byte("{}"))
		if err != nil {
			if err == nats.ErrKeyExists || strings.Contains(err.Error(), "key exists") {
				slog.DebugContext(ctx, "User already in room (addToRoom idempotent)", "user", userId, "room", room)
				return nil
			}
			return fmt.Errorf("kv.Create(%s): %w", key, err)
		}
		mem.add(room, userId)
		joinCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("room", room)))
		publishDelta(ctx, room, "join", userId)
		slog.InfoContext(ctx, "User joined room", "user", userId, "room", room)
		return nil
	}

	// removeFromRoom directly removes a user from a room: KV delete + local cache + delta publish.
	removeFromRoom := func(ctx context.Context, room, userId string) error {
		key := room + "." + userId
		err := roomsKV.Delete(key)
		if err != nil {
			if err == nats.ErrKeyNotFound || strings.Contains(err.Error(), "key not found") {
				slog.DebugContext(ctx, "User not in room (removeFromRoom no-op)", "user", userId, "room", room)
				return nil
			}
			return fmt.Errorf("kv.Delete(%s): %w", key, err)
		}
		mem.remove(room, userId)
		leaveCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("room", room)))
		publishDelta(ctx, room, "leave", userId)
		slog.InfoContext(ctx, "User left room", "user", userId, "room", room)
		return nil
	}

	// checkRoomAccess checks if a room is private and if the user is authorized.
	// Returns (isPrivate, authorized). Fail-open on DB errors.
	checkRoomAccess := func(ctx context.Context, room, userId string) (bool, bool) {
		var roomType string
		err := db.QueryRowContext(ctx, "SELECT type FROM rooms WHERE name = $1", room).Scan(&roomType)
		if err != nil {
			if err == sql.ErrNoRows {
				return false, true // not a managed room — allow
			}
			slog.ErrorContext(ctx, "Failed to check room access", "error", err)
			return false, true // fail-open on DB error
		}
		isPrivate := roomType == "private"
		if !isPrivate {
			return false, true
		}
		var count int
		db.QueryRowContext(ctx,
			"SELECT COUNT(*) FROM room_members WHERE room_name = $1 AND username = $2",
			room, userId).Scan(&count)
		return true, count > 0
	}

	// Subscribe to room.join.* via queue group (horizontally scalable)
	_, err = nc.QueueSubscribe("room.join.*", "room-workers", func(msg *nats.Msg) {
		ctx, span := otelhelper.StartConsumerSpan(context.Background(), msg, "room join")
		defer span.End()

		parts := strings.Split(msg.Subject, ".")
		if len(parts) < 3 {
			return
		}
		room := parts[2]

		var evt MembershipEvent
		if err := json.Unmarshal(msg.Data, &evt); err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, err.Error())
			slog.WarnContext(ctx, "Invalid join event", "error", err)
			return
		}

		span.SetAttributes(
			attribute.String("chat.room", room),
			attribute.String("chat.user", evt.UserId),
		)

		// Guard: KV key format is "{room}.{userId}" — dots in either would break parsing
		if strings.Contains(evt.UserId, ".") {
			span.AddEvent("rejected_join", trace.WithAttributes(
				attribute.String("chat.room", room),
				attribute.String("chat.user", evt.UserId),
				attribute.String("reason", "userId contains dot"),
			))
			slog.WarnContext(ctx, "Rejected join: userId contains dot", "user", evt.UserId, "room", room)
			return
		}

		// Authorization gate for private rooms (local DB query, no NATS round-trip)
		isPrivate, authorized := checkRoomAccess(ctx, room, evt.UserId)
		if isPrivate && !authorized {
			span.AddEvent("access_denied", trace.WithAttributes(
				attribute.String("chat.room", room),
				attribute.String("chat.user", evt.UserId),
			))
			slog.WarnContext(ctx, "Rejected join: unauthorized for private room", "user", evt.UserId, "room", room)
			return
		}

		if err := addToRoom(ctx, room, evt.UserId); err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, err.Error())
			slog.ErrorContext(ctx, "Failed to add user to room", "error", err, "user", evt.UserId, "room", room)
			return
		}
		span.AddEvent("kv_create", trace.WithAttributes(attribute.String("chat.room", room)))
	})
	if err != nil {
		slog.Error("Failed to subscribe to room.join.*", "error", err)
		os.Exit(1)
	}

	// Subscribe to room.leave.* via queue group (horizontally scalable)
	_, err = nc.QueueSubscribe("room.leave.*", "room-workers", func(msg *nats.Msg) {
		ctx, span := otelhelper.StartConsumerSpan(context.Background(), msg, "room leave")
		defer span.End()

		parts := strings.Split(msg.Subject, ".")
		if len(parts) < 3 {
			return
		}
		room := parts[2]

		var evt MembershipEvent
		if err := json.Unmarshal(msg.Data, &evt); err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, err.Error())
			slog.WarnContext(ctx, "Invalid leave event", "error", err)
			return
		}

		span.SetAttributes(
			attribute.String("chat.room", room),
			attribute.String("chat.user", evt.UserId),
		)

		if err := removeFromRoom(ctx, room, evt.UserId); err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, err.Error())
			slog.ErrorContext(ctx, "Failed to remove user from room", "error", err, "user", evt.UserId, "room", room)
			return
		}
		span.AddEvent("kv_delete", trace.WithAttributes(attribute.String("chat.room", room)))
	})
	if err != nil {
		slog.Error("Failed to subscribe to room.leave.*", "error", err)
		os.Exit(1)
	}

	// Subscribe to room.members.* — request/reply via queue group for scaling
	_, err = nc.QueueSubscribe("room.members.*", "room-members-workers", func(msg *nats.Msg) {
		ctx, span := otelhelper.StartServerSpan(context.Background(), msg, "room members query")
		defer span.End()

		parts := strings.Split(msg.Subject, ".")
		if len(parts) < 3 {
			msg.Respond([]byte("[]"))
			return
		}
		room := parts[2]
		span.SetAttributes(attribute.String("chat.room", room))

		members := mem.members(room)
		if members == nil {
			msg.Respond([]byte("[]"))
			queryCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("room", room)))
			return
		}

		data, _ := json.Marshal(members)
		msg.Respond(data)

		queryCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("room", room)))
		span.SetAttributes(attribute.Int("room.member_count", len(members)))
		slog.DebugContext(ctx, "Served room members query", "room", room, "members", len(members))
	})
	if err != nil {
		slog.Error("Failed to subscribe to room.members.*", "error", err)
		os.Exit(1)
	}

	// ──────────────────────────────────────────────────────────────
	// Room management handlers
	// ──────────────────────────────────────────────────────────────

	// room.create — create a new private room
	_, err = nc.QueueSubscribe("room.create", "room-workers", func(msg *nats.Msg) {
		start := time.Now()
		ctx, span := otelhelper.StartServerSpan(context.Background(), msg, "room.create")
		defer span.End()

		var req createRequest
		if err := json.Unmarshal(msg.Data, &req); err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, err.Error())
			msg.Respond([]byte(`{"error":"invalid request"}`))
			return
		}
		span.SetAttributes(
			attribute.String("chat.room", req.Name),
			attribute.String("chat.user", req.User),
		)

		if req.Name == "" || req.User == "" {
			msg.Respond([]byte(`{"error":"name and user are required"}`))
			return
		}

		displayName := req.DisplayName
		if displayName == "" {
			displayName = req.Name
		}

		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, err.Error())
			slog.ErrorContext(ctx, "Failed to begin transaction", "error", err)
			msg.Respond([]byte(`{"error":"internal error"}`))
			return
		}
		defer tx.Rollback()

		_, err = tx.ExecContext(ctx,
			"INSERT INTO rooms (name, display_name, creator, type) VALUES ($1, $2, $3, 'private')",
			req.Name, displayName, req.User)
		if err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, err.Error())
			if strings.Contains(err.Error(), "duplicate key") {
				msg.Respond([]byte(`{"error":"room already exists"}`))
			} else {
				slog.ErrorContext(ctx, "Failed to create room", "error", err)
				msg.Respond([]byte(`{"error":"internal error"}`))
			}
			return
		}

		_, err = tx.ExecContext(ctx,
			"INSERT INTO room_members (room_name, username, role) VALUES ($1, $2, 'owner')",
			req.Name, req.User)
		if err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, err.Error())
			slog.ErrorContext(ctx, "Failed to add creator as member", "error", err)
			msg.Respond([]byte(`{"error":"internal error"}`))
			return
		}

		if err := tx.Commit(); err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, err.Error())
			slog.ErrorContext(ctx, "Failed to commit", "error", err)
			msg.Respond([]byte(`{"error":"internal error"}`))
			return
		}

		// Mark as private locally
		privateRoomsMu.Lock()
		privateRooms[req.Name] = true
		privateRoomsMu.Unlock()

		// Add creator to room directly (replaces publishMembership → room.join round-trip)
		if err := addToRoom(ctx, req.Name, req.User); err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, err.Error())
			slog.ErrorContext(ctx, "Failed to add creator to room", "error", err)
		}

		span.AddEvent("room_created", trace.WithAttributes(
			attribute.String("chat.room", req.Name),
			attribute.String("chat.user", req.User),
		))
		publishSystemMessage(ctx, nc, req.Name, fmt.Sprintf("%s created the room", req.User))

		ri := RoomInfo{
			Name:        req.Name,
			DisplayName: displayName,
			Creator:     req.User,
			Type:        "private",
		}
		data, _ := json.Marshal(ri)
		msg.Respond(data)

		slog.InfoContext(ctx, "Room created", "room", req.Name, "creator", req.User)
		roomReqCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("action", "create")))
		roomReqDuration.Record(ctx, time.Since(start).Seconds(), metric.WithAttributes(attribute.String("action", "create")))
	})
	if err != nil {
		slog.Error("Failed to subscribe to room.create", "error", err)
		os.Exit(1)
	}

	// room.list — list user's private rooms
	_, err = nc.QueueSubscribe("room.list", "room-workers", func(msg *nats.Msg) {
		start := time.Now()
		ctx, span := otelhelper.StartServerSpan(context.Background(), msg, "room.list")
		defer span.End()

		var req listRequest
		if err := json.Unmarshal(msg.Data, &req); err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, err.Error())
			msg.Respond([]byte("[]"))
			return
		}
		span.SetAttributes(attribute.String("chat.user", req.User))

		rows, err := db.QueryContext(ctx, `
			SELECT c.name, COALESCE(c.display_name,''), c.creator, c.type, cm.role,
			       (SELECT COUNT(*) FROM room_members WHERE room_name = c.name) as member_count
			FROM rooms c
			JOIN room_members cm ON cm.room_name = c.name AND cm.username = $1
			ORDER BY c.name`, req.User)
		if err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, err.Error())
			slog.ErrorContext(ctx, "Failed to query rooms", "error", err)
			msg.Respond([]byte("[]"))
			return
		}
		defer rows.Close()

		var rooms []RoomInfo
		for rows.Next() {
			var ri RoomInfo
			var role string
			if err := rows.Scan(&ri.Name, &ri.DisplayName, &ri.Creator, &ri.Type, &role, &ri.MemberCount); err != nil {
				span.RecordError(err)
				slog.ErrorContext(ctx, "Failed to scan room", "error", err)
				continue
			}
			rooms = append(rooms, ri)
		}
		if rooms == nil {
			rooms = []RoomInfo{}
		}

		data, _ := json.Marshal(rooms)
		msg.Respond(data)

		span.SetAttributes(attribute.Int("room.list_count", len(rooms)))
		roomReqCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("action", "list")))
		roomReqDuration.Record(ctx, time.Since(start).Seconds(), metric.WithAttributes(attribute.String("action", "list")))
	})
	if err != nil {
		slog.Error("Failed to subscribe to room.list", "error", err)
		os.Exit(1)
	}

	// room.info.{room} — room metadata + member list
	_, err = nc.QueueSubscribe("room.info.*", "room-workers", func(msg *nats.Msg) {
		start := time.Now()
		ctx, span := otelhelper.StartServerSpan(context.Background(), msg, "room.info")
		defer span.End()

		roomName := strings.TrimPrefix(msg.Subject, "room.info.")
		span.SetAttributes(attribute.String("chat.room", roomName))

		var ri RoomInfo
		err := db.QueryRowContext(ctx,
			"SELECT name, COALESCE(display_name,''), creator, type FROM rooms WHERE name = $1",
			roomName).Scan(&ri.Name, &ri.DisplayName, &ri.Creator, &ri.Type)
		if err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, err.Error())
			if err == sql.ErrNoRows {
				msg.Respond([]byte(`{"error":"not found"}`))
			} else {
				slog.ErrorContext(ctx, "Failed to query room", "error", err)
				msg.Respond([]byte(`{"error":"internal error"}`))
			}
			return
		}

		rows, err := db.QueryContext(ctx,
			"SELECT username, role FROM room_members WHERE room_name = $1 ORDER BY joined_at",
			roomName)
		if err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, err.Error())
			slog.ErrorContext(ctx, "Failed to query members", "error", err)
			msg.Respond([]byte(`{"error":"internal error"}`))
			return
		}
		defer rows.Close()

		for rows.Next() {
			var m RoomMember
			if err := rows.Scan(&m.Username, &m.Role); err != nil {
				span.RecordError(err)
				continue
			}
			ri.Members = append(ri.Members, m)
		}
		ri.MemberCount = len(ri.Members)

		data, _ := json.Marshal(ri)
		msg.Respond(data)

		span.SetAttributes(attribute.Int("room.member_count", ri.MemberCount))
		roomReqCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("action", "info")))
		roomReqDuration.Record(ctx, time.Since(start).Seconds(), metric.WithAttributes(attribute.String("action", "info")))
	})
	if err != nil {
		slog.Error("Failed to subscribe to room.info.*", "error", err)
		os.Exit(1)
	}

	// room.invite.{room} — owner/admin invites a user
	_, err = nc.QueueSubscribe("room.invite.*", "room-workers", func(msg *nats.Msg) {
		start := time.Now()
		ctx, span := otelhelper.StartServerSpan(context.Background(), msg, "room.invite")
		defer span.End()

		roomName := strings.TrimPrefix(msg.Subject, "room.invite.")

		var req inviteRequest
		if err := json.Unmarshal(msg.Data, &req); err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, err.Error())
			msg.Respond([]byte(`{"error":"invalid request"}`))
			return
		}
		span.SetAttributes(
			attribute.String("chat.room", roomName),
			attribute.String("chat.user", req.User),
			attribute.String("chat.target", req.Target),
		)

		// Check requester is owner or admin
		var requesterRole string
		err := db.QueryRowContext(ctx,
			"SELECT role FROM room_members WHERE room_name = $1 AND username = $2",
			roomName, req.User).Scan(&requesterRole)
		if err != nil || (requesterRole != "owner" && requesterRole != "admin") {
			span.AddEvent("access_denied", trace.WithAttributes(
				attribute.String("chat.room", roomName),
				attribute.String("chat.user", req.User),
			))
			if err != nil {
				span.RecordError(err)
				span.SetStatus(codes.Error, err.Error())
			}
			msg.Respond([]byte(`{"error":"unauthorized"}`))
			return
		}

		// Add target as member
		_, err = db.ExecContext(ctx,
			"INSERT INTO room_members (room_name, username, role, invited_by) VALUES ($1, $2, 'member', $3) ON CONFLICT DO NOTHING",
			roomName, req.Target, req.User)
		if err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, err.Error())
			slog.ErrorContext(ctx, "Failed to invite user", "error", err)
			msg.Respond([]byte(`{"error":"internal error"}`))
			return
		}

		// Add to room directly (replaces publishMembership → room.join round-trip)
		if err := addToRoom(ctx, roomName, req.Target); err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, err.Error())
			slog.ErrorContext(ctx, "Failed to add invited user to room", "error", err)
		}

		publishSystemMessage(ctx, nc, roomName, fmt.Sprintf("%s was invited by %s", req.Target, req.User))

		msg.Respond([]byte(`{"ok":true}`))
		slog.InfoContext(ctx, "User invited to room", "room", roomName, "target", req.Target, "by", req.User)
		roomReqCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("action", "invite")))
		roomReqDuration.Record(ctx, time.Since(start).Seconds(), metric.WithAttributes(attribute.String("action", "invite")))
	})
	if err != nil {
		slog.Error("Failed to subscribe to room.invite.*", "error", err)
		os.Exit(1)
	}

	// room.kick.{room} — owner/admin removes a user
	_, err = nc.QueueSubscribe("room.kick.*", "room-workers", func(msg *nats.Msg) {
		start := time.Now()
		ctx, span := otelhelper.StartServerSpan(context.Background(), msg, "room.kick")
		defer span.End()

		roomName := strings.TrimPrefix(msg.Subject, "room.kick.")

		var req kickRequest
		if err := json.Unmarshal(msg.Data, &req); err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, err.Error())
			msg.Respond([]byte(`{"error":"invalid request"}`))
			return
		}
		span.SetAttributes(
			attribute.String("chat.room", roomName),
			attribute.String("chat.user", req.User),
			attribute.String("chat.target", req.Target),
		)

		// Check requester is owner or admin
		var requesterRole string
		err := db.QueryRowContext(ctx,
			"SELECT role FROM room_members WHERE room_name = $1 AND username = $2",
			roomName, req.User).Scan(&requesterRole)
		if err != nil || (requesterRole != "owner" && requesterRole != "admin") {
			span.AddEvent("access_denied", trace.WithAttributes(
				attribute.String("chat.room", roomName),
				attribute.String("chat.user", req.User),
			))
			if err != nil {
				span.RecordError(err)
				span.SetStatus(codes.Error, err.Error())
			}
			msg.Respond([]byte(`{"error":"unauthorized"}`))
			return
		}

		// Cannot kick owner
		var targetRole string
		db.QueryRowContext(ctx,
			"SELECT role FROM room_members WHERE room_name = $1 AND username = $2",
			roomName, req.Target).Scan(&targetRole)
		if targetRole == "owner" {
			msg.Respond([]byte(`{"error":"cannot kick owner"}`))
			return
		}

		_, err = db.ExecContext(ctx,
			"DELETE FROM room_members WHERE room_name = $1 AND username = $2",
			roomName, req.Target)
		if err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, err.Error())
			slog.ErrorContext(ctx, "Failed to kick user", "error", err)
			msg.Respond([]byte(`{"error":"internal error"}`))
			return
		}

		// Remove from room directly (replaces publishMembership → room.leave round-trip)
		if err := removeFromRoom(ctx, roomName, req.Target); err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, err.Error())
			slog.ErrorContext(ctx, "Failed to remove kicked user from room", "error", err)
		}

		publishSystemMessage(ctx, nc, roomName, fmt.Sprintf("%s was removed by %s", req.Target, req.User))

		msg.Respond([]byte(`{"ok":true}`))
		slog.InfoContext(ctx, "User kicked from room", "room", roomName, "target", req.Target, "by", req.User)
		roomReqCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("action", "kick")))
		roomReqDuration.Record(ctx, time.Since(start).Seconds(), metric.WithAttributes(attribute.String("action", "kick")))
	})
	if err != nil {
		slog.Error("Failed to subscribe to room.kick.*", "error", err)
		os.Exit(1)
	}

	// room.depart.{room} — user voluntarily leaves a managed room
	_, err = nc.QueueSubscribe("room.depart.*", "room-workers", func(msg *nats.Msg) {
		start := time.Now()
		ctx, span := otelhelper.StartServerSpan(context.Background(), msg, "room.depart")
		defer span.End()

		roomName := strings.TrimPrefix(msg.Subject, "room.depart.")

		var req leaveRequest
		if err := json.Unmarshal(msg.Data, &req); err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, err.Error())
			msg.Respond([]byte(`{"error":"invalid request"}`))
			return
		}
		span.SetAttributes(
			attribute.String("chat.room", roomName),
			attribute.String("chat.user", req.User),
		)

		// Check if user is owner
		var role string
		db.QueryRowContext(ctx,
			"SELECT role FROM room_members WHERE room_name = $1 AND username = $2",
			roomName, req.User).Scan(&role)

		if role == "owner" {
			// Transfer ownership to next admin or oldest member, or delete room
			var newOwner string
			err := db.QueryRowContext(ctx, `
				SELECT username FROM room_members
				WHERE room_name = $1 AND username != $2
				ORDER BY CASE WHEN role = 'admin' THEN 0 ELSE 1 END, joined_at
				LIMIT 1`, roomName, req.User).Scan(&newOwner)
			if err != nil {
				// No other members — delete room
				if _, execErr := db.ExecContext(ctx, "DELETE FROM rooms WHERE name = $1", roomName); execErr != nil {
					span.RecordError(execErr)
					span.SetStatus(codes.Error, execErr.Error())
					slog.ErrorContext(ctx, "Failed to delete room", "error", execErr, "room", roomName)
				}
				if rmErr := removeFromRoom(ctx, roomName, req.User); rmErr != nil {
					span.RecordError(rmErr)
					span.SetStatus(codes.Error, rmErr.Error())
					slog.ErrorContext(ctx, "Failed to remove user from room", "error", rmErr, "room", roomName)
				}

				// Remove from private rooms map
				privateRoomsMu.Lock()
				delete(privateRooms, roomName)
				privateRoomsMu.Unlock()

				span.AddEvent("room_deleted", trace.WithAttributes(attribute.String("chat.room", roomName)))
				msg.Respond([]byte(`{"ok":true,"deleted":true}`))
				slog.InfoContext(ctx, "Room deleted (last member left)", "room", roomName)
				roomReqCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("action", "depart")))
				roomReqDuration.Record(ctx, time.Since(start).Seconds(), metric.WithAttributes(attribute.String("action", "depart")))
				return
			}
			// Transfer ownership
			if _, execErr := db.ExecContext(ctx, "UPDATE room_members SET role = 'owner' WHERE room_name = $1 AND username = $2", roomName, newOwner); execErr != nil {
				span.RecordError(execErr)
				span.SetStatus(codes.Error, execErr.Error())
				slog.ErrorContext(ctx, "Failed to transfer ownership", "error", execErr, "room", roomName, "newOwner", newOwner)
			}
		}

		_, err := db.ExecContext(ctx,
			"DELETE FROM room_members WHERE room_name = $1 AND username = $2",
			roomName, req.User)
		if err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, err.Error())
			slog.ErrorContext(ctx, "Failed to leave room", "error", err)
			msg.Respond([]byte(`{"error":"internal error"}`))
			return
		}

		// Remove from room directly (replaces publishMembership → room.leave round-trip)
		if rmErr := removeFromRoom(ctx, roomName, req.User); rmErr != nil {
			span.RecordError(rmErr)
			span.SetStatus(codes.Error, rmErr.Error())
			slog.ErrorContext(ctx, "Failed to remove user from room", "error", rmErr, "room", roomName)
		}
		span.AddEvent("kv_delete", trace.WithAttributes(attribute.String("chat.room", roomName)))
		publishSystemMessage(ctx, nc, roomName, fmt.Sprintf("%s left the room", req.User))

		msg.Respond([]byte(`{"ok":true}`))
		slog.InfoContext(ctx, "User left room", "room", roomName, "user", req.User)
		roomReqCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("action", "depart")))
		roomReqDuration.Record(ctx, time.Since(start).Seconds(), metric.WithAttributes(attribute.String("action", "depart")))
	})
	if err != nil {
		slog.Error("Failed to subscribe to room.depart.*", "error", err)
		os.Exit(1)
	}

	slog.Info("Room service ready — listening for room.join/leave/members/create/list/info/invite/kick/depart.* (QG), room.changed.* (delta)")

	// Wait for shutdown
	sigCtx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()
	<-sigCtx.Done()

	slog.Info("Shutting down room service")
	nc.Drain()
}
