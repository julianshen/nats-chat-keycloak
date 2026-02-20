package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	otelhelper "github.com/example/nats-chat-otelhelper"
	"github.com/nats-io/nats.go"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
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
}

// localMembership is a thread-safe forward-index rebuilt from room.changed deltas.
type localMembership struct {
	mu    sync.RWMutex
	rooms map[string]map[string]bool // room → set of userIds
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

	natsURL := envOrDefault("NATS_URL", "nats://localhost:4222")
	natsUser := envOrDefault("NATS_USER", "room-service")
	natsPass := envOrDefault("NATS_PASS", "room-service-secret")

	slog.Info("Starting Room Service (sharded per-key KV)", "nats_url", natsURL)

	mem := newLocalMembership()

	// createKVBucket creates (or re-binds to) the ROOMS KV bucket with FileStorage.
	createKVBucket := func(js nats.JetStreamContext) (nats.KeyValue, error) {
		return js.CreateKeyValue(&nats.KeyValueConfig{
			Bucket:  "ROOMS",
			History: 1,
			Storage: nats.FileStorage,
		})
	}

	// hydrateFromKV populates the local forward-index from existing KV keys.
	// Builds into a temporary localMembership then atomically swaps — no partial-result window.
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

	// publishDelta publishes a delta room.changed.{room} event.
	publishDelta := func(ctx context.Context, room, action, userId string) {
		evt := RoomChangedEvent{
			Room:   room,
			Action: action,
			UserId: userId,
		}
		data, err := json.Marshal(evt)
		if err != nil {
			slog.WarnContext(ctx, "Failed to marshal room.changed delta", "error", err)
			return
		}
		otelhelper.TracedPublish(ctx, nc, "room.changed."+room, data)
		slog.Debug("Published room.changed delta", "room", room, "action", action, "user", userId)
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
			slog.Warn("Invalid join event", "error", err)
			return
		}

		span.SetAttributes(
			attribute.String("room.name", room),
			attribute.String("room.user", evt.UserId),
		)

		// Guard: KV key format is "{room}.{userId}" — dots in either would break parsing
		if strings.Contains(evt.UserId, ".") {
			slog.Warn("Rejected join: userId contains dot", "user", evt.UserId, "room", room)
			return
		}

		// Per-key write: idempotent via Create (returns ErrKeyExists if already joined)
		key := room + "." + evt.UserId
		_, err := roomsKV.Create(key, []byte("{}"))
		if err != nil {
			// ErrKeyExists means user already in room — no-op, no event
			if err == nats.ErrKeyExists {
				slog.Debug("User already in room (kv.Create idempotent)", "user", evt.UserId, "room", room)
				return
			}
			slog.Error("Failed to create ROOMS KV key", "key", key, "error", err)
			return
		}

		joinCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("room", room)))
		slog.Info("User joined room", "user", evt.UserId, "room", room)

		publishDelta(ctx, room, "join", evt.UserId)
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
			slog.Warn("Invalid leave event", "error", err)
			return
		}

		span.SetAttributes(
			attribute.String("room.name", room),
			attribute.String("room.user", evt.UserId),
		)

		// Per-key delete: returns ErrKeyNotFound if user not in room — no-op
		key := room + "." + evt.UserId
		err := roomsKV.Delete(key)
		if err != nil {
			if err == nats.ErrKeyNotFound {
				slog.Debug("User not in room, skipping leave", "user", evt.UserId, "room", room)
				return
			}
			slog.Error("Failed to delete ROOMS KV key", "key", key, "error", err)
			return
		}

		leaveCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("room", room)))
		slog.Info("User left room", "user", evt.UserId, "room", room)

		publishDelta(ctx, room, "leave", evt.UserId)
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
		span.SetAttributes(attribute.String("room.name", room))

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
		slog.Debug("Served room members query", "room", room, "members", len(members))
	})
	if err != nil {
		slog.Error("Failed to subscribe to room.members.*", "error", err)
		os.Exit(1)
	}

	slog.Info("Room service ready — listening for room.join.* (QG), room.leave.* (QG), room.members.* (QG), room.changed.* (delta rebuild)")

	// Wait for shutdown
	sigCtx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()
	<-sigCtx.Done()

	slog.Info("Shutting down room service")
	nc.Drain()
}
