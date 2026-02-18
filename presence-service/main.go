package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
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

// membership tracks which users are in which rooms.
type membership struct {
	mu    sync.RWMutex
	rooms map[string]map[string]bool // room -> set of userIds
}

func newMembership() *membership {
	return &membership{rooms: make(map[string]map[string]bool)}
}

func (m *membership) join(room, userId string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.rooms[room] == nil {
		m.rooms[room] = make(map[string]bool)
	}
	m.rooms[room][userId] = true
}

func (m *membership) leave(room, userId string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if members, ok := m.rooms[room]; ok {
		delete(members, userId)
		if len(members) == 0 {
			delete(m.rooms, room)
		}
	}
}

func (m *membership) members(room string) []string {
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

func (m *membership) allUsers() map[string]bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	users := make(map[string]bool)
	for _, members := range m.rooms {
		for uid := range members {
			users[uid] = true
		}
	}
	return users
}

func (m *membership) removeUserFromAll(userId string) []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	var affected []string
	for room, members := range m.rooms {
		if members[userId] {
			delete(members, userId)
			affected = append(affected, room)
			if len(members) == 0 {
				delete(m.rooms, room)
			}
		}
	}
	return affected
}

// userRooms returns all rooms a user is currently in.
func (m *membership) userRooms(userId string) []string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var rooms []string
	for room, members := range m.rooms {
		if members[userId] {
			rooms = append(rooms, room)
		}
	}
	return rooms
}

// MembershipEvent is the payload for room.join.* and room.leave.* messages.
type MembershipEvent struct {
	UserId string `json:"userId"`
}

// PresenceStatus is the value stored in KV for each user.
type PresenceStatus struct {
	Status   string `json:"status"`
	LastSeen int64  `json:"lastSeen"`
}

// PresenceUpdate is the payload clients send to presence.update.
type PresenceUpdate struct {
	UserId string `json:"userId"`
	Status string `json:"status"`
}

// PresenceMember represents a single member's presence in a room response/event.
type PresenceMember struct {
	UserId string `json:"userId"`
	Status string `json:"status"`
}

// PresenceEvent is broadcast to room members on presence changes.
type PresenceEvent struct {
	Type    string           `json:"type"`
	UserId  string           `json:"userId"`
	Room    string           `json:"room"`
	Members []PresenceMember `json:"members"`
}

// broadcastPresence publishes a presence snapshot to every member in the room.
func broadcastPresence(nc *nats.Conn, kv nats.KeyValue, mem *membership, room, eventType, userId string) {
	members := mem.members(room)
	if len(members) == 0 && eventType == "leave" {
		return
	}

	// Build member list with status from KV
	memberStatuses := make([]PresenceMember, 0, len(members))
	for _, uid := range members {
		status := "online" // default
		entry, err := kv.Get(uid)
		if err == nil {
			var ps PresenceStatus
			if json.Unmarshal(entry.Value(), &ps) == nil {
				status = ps.Status
			}
		}
		memberStatuses = append(memberStatuses, PresenceMember{UserId: uid, Status: status})
	}

	evt := PresenceEvent{
		Type:    eventType,
		UserId:  userId,
		Room:    room,
		Members: memberStatuses,
	}
	data, err := json.Marshal(evt)
	if err != nil {
		slog.Warn("Failed to marshal presence event", "error", err)
		return
	}
	for _, member := range members {
		subject := "deliver." + member + ".presence." + room
		nc.Publish(subject, data)
	}
	slog.Debug("Broadcast presence", "room", room, "type", eventType, "user", userId, "members", len(members))
}

// connzResponse is the subset of NATS /connz monitoring endpoint we need.
type connzResponse struct {
	Connections []connzEntry `json:"connections"`
}

type connzEntry struct {
	Name string `json:"name"`
}

// fetchConnectedUsers queries the NATS monitoring endpoint and returns the set of connected client names.
func fetchConnectedUsers(monitorURL string) (map[string]bool, error) {
	resp, err := http.Get(fmt.Sprintf("%s/connz?limit=1024", monitorURL))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	var connz connzResponse
	if err := json.Unmarshal(body, &connz); err != nil {
		return nil, err
	}
	users := make(map[string]bool, len(connz.Connections))
	for _, c := range connz.Connections {
		if c.Name != "" {
			users[c.Name] = true
		}
	}
	return users, nil
}

// startStaleCleanup periodically checks for members who are no longer connected to NATS
// and sets them offline in KV, broadcasting presence updates for affected rooms.
func startStaleCleanup(ctx context.Context, nc *nats.Conn, kv nats.KeyValue, mem *membership, monitorURL string, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			connected, err := fetchConnectedUsers(monitorURL)
			if err != nil {
				slog.Warn("Stale cleanup: failed to fetch connected users", "error", err)
				continue
			}
			tracked := mem.allUsers()
			for userId := range tracked {
				if connected[userId] {
					continue
				}
				// User is tracked but no longer connected — set offline in KV and remove from rooms
				offlineStatus := PresenceStatus{Status: "offline", LastSeen: time.Now().UnixMilli()}
				data, _ := json.Marshal(offlineStatus)
				kv.Put(userId, data)

				rooms := mem.removeUserFromAll(userId)
				for _, room := range rooms {
					broadcastPresence(nc, kv, mem, room, "leave", userId)
				}
				if len(rooms) > 0 {
					slog.Info("Stale cleanup: removed disconnected user", "user", userId, "rooms", len(rooms))
				}
			}
		}
	}
}

func envOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

var validStatuses = map[string]bool{
	"online": true, "away": true, "busy": true, "offline": true,
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

	meter := otel.Meter("presence-service")
	updateCounter, _ := meter.Int64Counter("presence_updates_total",
		metric.WithDescription("Total presence status updates"))
	queryCounter, _ := meter.Int64Counter("presence_queries_total",
		metric.WithDescription("Total presence room queries"))
	queryDuration, _ := meter.Float64Histogram("presence_query_duration_seconds",
		metric.WithDescription("Duration of presence room queries"))

	natsURL := envOrDefault("NATS_URL", "nats://localhost:4222")
	natsUser := envOrDefault("NATS_USER", "presence-service")
	natsPass := envOrDefault("NATS_PASS", "presence-service-secret")

	slog.Info("Starting Presence Service", "nats_url", natsURL)

	// Connect to NATS with retry
	var nc *nats.Conn
	for attempt := 1; attempt <= 30; attempt++ {
		nc, err = nats.Connect(natsURL,
			nats.UserInfo(natsUser, natsPass),
			nats.Name("presence-service"),
			nats.MaxReconnects(-1),
			nats.ReconnectWait(2*time.Second),
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

	// Create JetStream context and KV bucket
	js, err := nc.JetStream()
	if err != nil {
		slog.Error("Failed to create JetStream context", "error", err)
		os.Exit(1)
	}

	kv, err := js.CreateKeyValue(&nats.KeyValueConfig{
		Bucket:  "PRESENCE",
		History: 1,
		Storage: nats.MemoryStorage,
	})
	if err != nil {
		slog.Error("Failed to create KV bucket", "error", err)
		os.Exit(1)
	}
	slog.Info("NATS KV bucket ready", "bucket", "PRESENCE")

	mem := newMembership()

	// Subscribe to membership events (no queue group — need full state)
	_, err = nc.Subscribe("room.join.*", func(msg *nats.Msg) {
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

		mem.join(room, evt.UserId)

		// Set user online in KV if not already set
		ps := PresenceStatus{Status: "online", LastSeen: time.Now().UnixMilli()}
		data, _ := json.Marshal(ps)
		kv.Put(evt.UserId, data)

		slog.Debug("User joined room", "user", evt.UserId, "room", room)
		broadcastPresence(nc, kv, mem, room, "join", evt.UserId)
	})
	if err != nil {
		slog.Error("Failed to subscribe to room.join.*", "error", err)
		os.Exit(1)
	}

	_, err = nc.Subscribe("room.leave.*", func(msg *nats.Msg) {
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

		mem.leave(room, evt.UserId)
		slog.Debug("User left room", "user", evt.UserId, "room", room)
		broadcastPresence(nc, kv, mem, room, "leave", evt.UserId)
	})
	if err != nil {
		slog.Error("Failed to subscribe to room.leave.*", "error", err)
		os.Exit(1)
	}

	// Subscribe to presence.update — client status changes
	_, err = nc.Subscribe("presence.update", func(msg *nats.Msg) {
		var update PresenceUpdate
		if err := json.Unmarshal(msg.Data, &update); err != nil {
			slog.Warn("Invalid presence update", "error", err)
			return
		}

		if !validStatuses[update.Status] {
			slog.Warn("Invalid status in presence update", "status", update.Status)
			return
		}

		ps := PresenceStatus{Status: update.Status, LastSeen: time.Now().UnixMilli()}
		data, _ := json.Marshal(ps)
		kv.Put(update.UserId, data)

		updateCounter.Add(context.Background(), 1, metric.WithAttributes(
			attribute.String("status", update.Status),
		))

		slog.Debug("Presence update", "user", update.UserId, "status", update.Status)

		// Broadcast to all rooms this user is in
		rooms := mem.userRooms(update.UserId)
		for _, room := range rooms {
			broadcastPresence(nc, kv, mem, room, "status_change", update.UserId)
		}
	})
	if err != nil {
		slog.Error("Failed to subscribe to presence.update", "error", err)
		os.Exit(1)
	}

	// Subscribe to presence.room.* — request/reply for room presence queries
	_, err = nc.Subscribe("presence.room.*", func(msg *nats.Msg) {
		start := time.Now()
		ctx, span := otelhelper.StartServerSpan(context.Background(), msg, "presence room query")
		defer span.End()

		parts := strings.Split(msg.Subject, ".")
		if len(parts) < 3 {
			msg.Respond([]byte("[]"))
			return
		}
		room := parts[2]
		span.SetAttributes(attribute.String("presence.room", room))

		members := mem.members(room)
		memberStatuses := make([]PresenceMember, 0, len(members))
		for _, uid := range members {
			status := "online"
			entry, err := kv.Get(uid)
			if err == nil {
				var ps PresenceStatus
				if json.Unmarshal(entry.Value(), &ps) == nil {
					status = ps.Status
				}
			}
			memberStatuses = append(memberStatuses, PresenceMember{UserId: uid, Status: status})
		}

		data, err := json.Marshal(memberStatuses)
		if err != nil {
			slog.ErrorContext(ctx, "Failed to marshal presence response", "error", err)
			span.RecordError(err)
			msg.Respond([]byte("[]"))
			return
		}

		msg.Respond(data)

		duration := time.Since(start).Seconds()
		attrs := metric.WithAttributes(attribute.String("room", room))
		queryCounter.Add(ctx, 1, attrs)
		queryDuration.Record(ctx, duration, attrs)

		span.SetAttributes(attribute.Int("presence.member_count", len(memberStatuses)))
		slog.DebugContext(ctx, "Served presence query", "room", room, "members", len(memberStatuses))
	})
	if err != nil {
		slog.Error("Failed to subscribe to presence.room.*", "error", err)
		os.Exit(1)
	}

	slog.Info("Presence service ready — listening for room.join.*, room.leave.*, presence.update, presence.room.*")

	// Start periodic stale member cleanup
	monitorURL := envOrDefault("NATS_MONITOR_URL", "http://localhost:8222")
	cleanupCtx, cleanupCancel := context.WithCancel(ctx)
	defer cleanupCancel()
	go startStaleCleanup(cleanupCtx, nc, kv, mem, monitorURL, 15*time.Second)

	// Wait for shutdown
	sigCtx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()
	<-sigCtx.Done()

	slog.Info("Shutting down presence service")
	nc.Drain()
}
