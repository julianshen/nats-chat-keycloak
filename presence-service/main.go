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

// dualMembership tracks room membership with both forward and reverse indexes.
// Forward: room → set of userIds (for room queries and presence broadcasts)
// Reverse: userId → set of rooms (for O(1) userRooms lookup)
type dualMembership struct {
	mu    sync.RWMutex
	rooms map[string]map[string]bool // forward: room → users
	users map[string]map[string]bool // reverse: user → rooms
}

func newDualMembership() *dualMembership {
	return &dualMembership{
		rooms: make(map[string]map[string]bool),
		users: make(map[string]map[string]bool),
	}
}

func (m *dualMembership) add(room, userId string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.rooms[room] == nil {
		m.rooms[room] = make(map[string]bool)
	}
	m.rooms[room][userId] = true
	if m.users[userId] == nil {
		m.users[userId] = make(map[string]bool)
	}
	m.users[userId][room] = true
}

func (m *dualMembership) remove(room, userId string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if members, ok := m.rooms[room]; ok {
		delete(members, userId)
		if len(members) == 0 {
			delete(m.rooms, room)
		}
	}
	if rooms, ok := m.users[userId]; ok {
		delete(rooms, room)
		if len(rooms) == 0 {
			delete(m.users, userId)
		}
	}
}

func (m *dualMembership) members(room string) []string {
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

// userRooms returns all rooms a user is in — O(1) via reverse index.
func (m *dualMembership) userRooms(userId string) []string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	rooms := m.users[userId]
	if len(rooms) == 0 {
		return nil
	}
	result := make([]string, 0, len(rooms))
	for room := range rooms {
		result = append(result, room)
	}
	return result
}

// removeUserFromAll removes a user from all rooms — O(user's rooms) via reverse index.
func (m *dualMembership) removeUserFromAll(userId string) []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	rooms, ok := m.users[userId]
	if !ok {
		return nil
	}
	affected := make([]string, 0, len(rooms))
	for room := range rooms {
		affected = append(affected, room)
		if members, ok := m.rooms[room]; ok {
			delete(members, userId)
			if len(members) == 0 {
				delete(m.rooms, room)
			}
		}
	}
	delete(m.users, userId)
	return affected
}

func (m *dualMembership) reset() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.rooms = make(map[string]map[string]bool)
	m.users = make(map[string]map[string]bool)
}

// swapFrom atomically replaces membership data with another instance's data.
func (m *dualMembership) swapFrom(other *dualMembership) {
	other.mu.RLock()
	rooms := other.rooms
	users := other.users
	other.mu.RUnlock()

	m.mu.Lock()
	defer m.mu.Unlock()
	m.rooms = rooms
	m.users = users
}

// RoomChangedEvent is a delta event from room-service.
type RoomChangedEvent struct {
	Room   string `json:"room"`
	Action string `json:"action"` // "join" or "leave"
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

// HeartbeatPayload is the payload clients send to presence.heartbeat.
type HeartbeatPayload struct {
	UserId string `json:"userId"`
	ConnId string `json:"connId"`
}

// DisconnectPayload is the payload clients send to presence.disconnect.
type DisconnectPayload struct {
	UserId string `json:"userId"`
	ConnId string `json:"connId"`
}

// MembershipEvent is the payload for room.leave.* messages (published by presence on offline).
type MembershipEvent struct {
	UserId string `json:"userId"`
}

// connTracker is a thread-safe in-memory mirror of the PRESENCE_CONN KV bucket.
type connTracker struct {
	mu    sync.RWMutex
	conns map[string]map[string]bool // userId → set of connIds
}

func newConnTracker() *connTracker {
	return &connTracker{conns: make(map[string]map[string]bool)}
}

func (ct *connTracker) add(userId, connId string) {
	ct.mu.Lock()
	defer ct.mu.Unlock()
	if ct.conns[userId] == nil {
		ct.conns[userId] = make(map[string]bool)
	}
	ct.conns[userId][connId] = true
}

func (ct *connTracker) remove(userId, connId string) bool {
	ct.mu.Lock()
	defer ct.mu.Unlock()
	if conns, ok := ct.conns[userId]; ok {
		delete(conns, connId)
		if len(conns) == 0 {
			delete(ct.conns, userId)
			return true
		}
	}
	return false
}

func (ct *connTracker) reset() {
	ct.mu.Lock()
	defer ct.mu.Unlock()
	ct.conns = make(map[string]map[string]bool)
}

func (ct *connTracker) hasConns(userId string) bool {
	ct.mu.RLock()
	defer ct.mu.RUnlock()
	return len(ct.conns[userId]) > 0
}

// publishPresenceEvent publishes a presence snapshot to presence.event.{room}
// for fanout-service to deliver to all room members.
func publishPresenceEvent(nc *nats.Conn, statusKV nats.KeyValue, mem *dualMembership, ct *connTracker, room, eventType, userId string) {
	members := mem.members(room)
	if len(members) == 0 && eventType == "leave" {
		return
	}

	memberStatuses := make([]PresenceMember, 0, len(members))
	for _, uid := range members {
		if !ct.hasConns(uid) {
			memberStatuses = append(memberStatuses, PresenceMember{UserId: uid, Status: "offline"})
			continue
		}
		status := "online"
		entry, err := statusKV.Get(uid)
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
	nc.Publish("presence.event."+room, data)
	slog.Debug("Published presence event", "room", room, "type", eventType, "user", userId, "members", len(members))
}

// handleUserOffline handles the cleanup when a user's last connection is gone.
// Uses CAS (Compare-And-Swap) on the PRESENCE KV to deduplicate across N instances:
// only the instance that successfully CAS-updates the status to "offline" proceeds
// with room.leave cleanup. Others get a revision mismatch and skip.
func handleUserOffline(nc *nats.Conn, statusKV nats.KeyValue, mem *dualMembership, userId string) {
	entry, err := statusKV.Get(userId)
	if err != nil {
		// No entry — user may have been purged; publish leaves defensively
		rooms := mem.removeUserFromAll(userId)
		for _, room := range rooms {
			leaveData, _ := json.Marshal(MembershipEvent{UserId: userId})
			nc.Publish("room.leave."+room, leaveData)
		}
		return
	}

	var ps PresenceStatus
	if json.Unmarshal(entry.Value(), &ps) == nil && ps.Status == "offline" {
		return // already offline — another instance handled it
	}

	offlineStatus := PresenceStatus{Status: "offline", LastSeen: time.Now().UnixMilli()}
	data, _ := json.Marshal(offlineStatus)

	// CAS: only one instance wins the race
	_, err = statusKV.Update(userId, data, entry.Revision())
	if err != nil {
		slog.Debug("CAS failed for handleUserOffline — another instance won", "user", userId)
		return
	}

	// Only the CAS winner proceeds with room.leave cleanup
	rooms := mem.removeUserFromAll(userId)
	for _, room := range rooms {
		leaveData, _ := json.Marshal(MembershipEvent{UserId: userId})
		nc.Publish("room.leave."+room, leaveData)
	}
	if len(rooms) > 0 {
		slog.Info("User went offline (CAS winner)", "user", userId, "rooms", len(rooms))
	}
}

// startKVWatcher watches the PRESENCE_CONN bucket for expiration events.
func startKVWatcher(ctx context.Context, nc *nats.Conn, connKV nats.KeyValue, statusKV nats.KeyValue, mem *dualMembership, ct *connTracker, expirationCounter metric.Int64Counter) {
	watcher, err := connKV.WatchAll(nats.IgnoreDeletes())
	if err != nil {
		slog.Error("Failed to start KV watcher", "error", err)
		return
	}
	defer watcher.Stop()

	for entry := range watcher.Updates() {
		if entry == nil {
			break
		}
		parts := strings.SplitN(entry.Key(), ".", 2)
		if len(parts) == 2 {
			ct.add(parts[0], parts[1])
		}
	}
	slog.Info("KV watcher initialized, connTracker synced")

	watcher.Stop()
	watcher, err = connKV.WatchAll()
	if err != nil {
		slog.Error("Failed to restart KV watcher with deletes", "error", err)
		return
	}
	defer watcher.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case entry, ok := <-watcher.Updates():
			if !ok {
				return
			}
			if entry == nil {
				continue
			}

			parts := strings.SplitN(entry.Key(), ".", 2)
			if len(parts) != 2 {
				continue
			}
			userId, connId := parts[0], parts[1]

			switch entry.Operation() {
			case nats.KeyValuePut:
				ct.add(userId, connId)
			case nats.KeyValueDelete, nats.KeyValuePurge:
				wasLast := ct.remove(userId, connId)
				if wasLast {
					expirationCounter.Add(context.Background(), 1, metric.WithAttributes(
						attribute.String("user", userId),
					))
					slog.Info("Connection expired (KV TTL), last connection gone", "user", userId, "connId", connId)
					handleUserOffline(nc, statusKV, mem, userId)
				} else {
					slog.Debug("Connection expired, user has other connections", "user", userId, "connId", connId)
				}
			}
		}
	}
}

// hydrateRoomMembership populates the dualMembership from the ROOMS KV bucket.
// Builds into a temporary dualMembership then atomically swaps — no partial-result window.
// Keys are formatted as "{room}.{userId}".
func hydrateRoomMembership(kv nats.KeyValue, mem *dualMembership) {
	tmp := newDualMembership()
	watcher, err := kv.WatchAll(nats.IgnoreDeletes())
	if err != nil {
		slog.Error("Failed to start ROOMS KV watcher for hydration", "error", err)
		return
	}
	defer watcher.Stop()

	count := 0
	for entry := range watcher.Updates() {
		if entry == nil {
			break
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
	slog.Info("Hydrated room membership from ROOMS KV (atomic swap)", "entries", count)
}

// bindRoomsKV retries binding to the ROOMS KV bucket until room-service creates it.
func bindRoomsKV(js nats.JetStreamContext) (nats.KeyValue, error) {
	var kv nats.KeyValue
	var err error
	for attempt := 1; attempt <= 60; attempt++ {
		kv, err = js.KeyValue("ROOMS")
		if err == nil {
			slog.Info("Bound to ROOMS KV bucket")
			return kv, nil
		}
		if attempt%10 == 1 {
			slog.Info("Waiting for ROOMS KV bucket (room-service may not be ready yet)", "attempt", attempt, "error", err)
		}
		time.Sleep(2 * time.Second)
	}
	return nil, err
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
	heartbeatCounter, _ := meter.Int64Counter("presence_heartbeats_total",
		metric.WithDescription("Total heartbeats received"))
	disconnectCounter, _ := meter.Int64Counter("presence_disconnects_total",
		metric.WithDescription("Total graceful disconnects"))
	expirationCounter, _ := meter.Int64Counter("presence_expirations_total",
		metric.WithDescription("Total connection expirations (KV TTL)"))

	natsURL := envOrDefault("NATS_URL", "nats://localhost:4222")
	natsUser := envOrDefault("NATS_USER", "presence-service")
	natsPass := envOrDefault("NATS_PASS", "presence-service-secret")

	slog.Info("Starting Presence Service", "nats_url", natsURL)

	mem := newDualMembership()
	ct := newConnTracker()

	var watcherMu sync.Mutex
	var watcherCancel context.CancelFunc

	createKVBuckets := func(js nats.JetStreamContext) error {
		var kvErr error
		if _, kvErr = js.CreateKeyValue(&nats.KeyValueConfig{
			Bucket:  "PRESENCE",
			History: 1,
			Storage: nats.MemoryStorage,
		}); kvErr != nil {
			return kvErr
		}
		if _, kvErr = js.CreateKeyValue(&nats.KeyValueConfig{
			Bucket:  "PRESENCE_CONN",
			History: 1,
			TTL:     45 * time.Second,
			Storage: nats.MemoryStorage,
		}); kvErr != nil {
			return kvErr
		}
		return nil
	}

	// Connect to NATS with retry
	var nc *nats.Conn
	for attempt := 1; attempt <= 30; attempt++ {
		nc, err = nats.Connect(natsURL,
			nats.UserInfo(natsUser, natsPass),
			nats.Name("presence-service"),
			nats.MaxReconnects(-1),
			nats.ReconnectWait(2*time.Second),
			nats.DisconnectErrHandler(func(_ *nats.Conn, err error) {
				slog.Warn("NATS disconnected", "error", err)
			}),
			nats.ReconnectHandler(func(nc *nats.Conn) {
				slog.Info("NATS reconnected — recreating KV buckets and resetting state")

				js, jsErr := nc.JetStream()
				if jsErr != nil {
					slog.Error("Failed to get JetStream after reconnect", "error", jsErr)
					return
				}
				if kvErr := createKVBuckets(js); kvErr != nil {
					slog.Error("Failed to recreate KV buckets after reconnect", "error", kvErr)
					return
				}

				ct.reset()
				mem.reset()
				slog.Info("In-memory state cleared, starting background re-hydration")

				connKV, _ := js.KeyValue("PRESENCE_CONN")
				statusKV, _ := js.KeyValue("PRESENCE")
				watcherMu.Lock()
				if watcherCancel != nil {
					watcherCancel()
				}
				newCtx, newCancel := context.WithCancel(context.Background())
				watcherCancel = newCancel
				watcherMu.Unlock()
				go startKVWatcher(newCtx, nc, connKV, statusKV, mem, ct, expirationCounter)
				slog.Info("KV watcher restarted")

				// Re-hydrate room membership in background — avoids blocking NATS reconnect handler
				go func() {
					roomsKV, kvErr := bindRoomsKV(js)
					if kvErr != nil {
						slog.Error("Failed to bind ROOMS KV after reconnect", "error", kvErr)
						return
					}
					hydrateRoomMembership(roomsKV, mem)
					slog.Info("Background room membership re-hydration complete")
				}()
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

	js, err := nc.JetStream()
	if err != nil {
		slog.Error("Failed to create JetStream context", "error", err)
		os.Exit(1)
	}

	if err := createKVBuckets(js); err != nil {
		slog.Error("Failed to create KV buckets", "error", err)
		os.Exit(1)
	}
	slog.Info("NATS KV buckets ready", "buckets", "PRESENCE, PRESENCE_CONN")

	statusKV, _ := js.KeyValue("PRESENCE")
	connKV, _ := js.KeyValue("PRESENCE_CONN")

	// Subscribe to room.changed.* (no QG) — delta events from room-service
	// MUST subscribe BEFORE hydration (subscribe-first pattern)
	_, err = nc.Subscribe("room.changed.*", func(msg *nats.Msg) {
		var evt RoomChangedEvent
		if err := json.Unmarshal(msg.Data, &evt); err != nil {
			slog.Warn("Invalid room.changed event", "error", err)
			return
		}

		switch evt.Action {
		case "join":
			mem.add(evt.Room, evt.UserId)
			// On join, set user online in PRESENCE KV if they have active connections
			if ct.hasConns(evt.UserId) {
				ps := PresenceStatus{Status: "online", LastSeen: time.Now().UnixMilli()}
				data, _ := json.Marshal(ps)
				statusKV.Put(evt.UserId, data)
			}
		case "leave":
			mem.remove(evt.Room, evt.UserId)
		}

		slog.Debug("Room membership updated (delta)", "room", evt.Room, "action", evt.Action, "user", evt.UserId)

		publishPresenceEvent(nc, statusKV, mem, ct, evt.Room, evt.Action, evt.UserId)
	})
	if err != nil {
		slog.Error("Failed to subscribe to room.changed.*", "error", err)
		os.Exit(1)
	}

	// Hydrate room membership from ROOMS KV (after subscribing to deltas)
	roomsKV, kvErr := bindRoomsKV(js)
	if kvErr != nil {
		slog.Warn("Could not bind ROOMS KV for hydration — room-service may not be ready", "error", kvErr)
	} else {
		hydrateRoomMembership(roomsKV, mem)
	}

	// Subscribe to presence.heartbeat
	_, err = nc.QueueSubscribe("presence.heartbeat", "presence-workers", func(msg *nats.Msg) {
		var hb HeartbeatPayload
		if err := json.Unmarshal(msg.Data, &hb); err != nil || hb.UserId == "" || hb.ConnId == "" {
			return
		}

		key := hb.UserId + "." + hb.ConnId
		connKV.Put(key, []byte(`{}`))
		ct.add(hb.UserId, hb.ConnId)

		heartbeatCounter.Add(context.Background(), 1, metric.WithAttributes(
			attribute.String("user", hb.UserId),
		))
	})
	if err != nil {
		slog.Error("Failed to subscribe to presence.heartbeat", "error", err)
		os.Exit(1)
	}

	// Subscribe to presence.disconnect
	_, err = nc.QueueSubscribe("presence.disconnect", "presence-workers", func(msg *nats.Msg) {
		var dc DisconnectPayload
		if err := json.Unmarshal(msg.Data, &dc); err != nil || dc.UserId == "" || dc.ConnId == "" {
			return
		}

		key := dc.UserId + "." + dc.ConnId
		connKV.Delete(key)

		wasLast := ct.remove(dc.UserId, dc.ConnId)

		disconnectCounter.Add(context.Background(), 1, metric.WithAttributes(
			attribute.String("user", dc.UserId),
		))

		if wasLast {
			slog.Info("Graceful disconnect, last connection gone", "user", dc.UserId, "connId", dc.ConnId)
			handleUserOffline(nc, statusKV, mem, dc.UserId)
		} else {
			slog.Debug("Graceful disconnect, user has other connections", "user", dc.UserId, "connId", dc.ConnId)
		}
	})
	if err != nil {
		slog.Error("Failed to subscribe to presence.disconnect", "error", err)
		os.Exit(1)
	}

	// Subscribe to presence.update
	_, err = nc.QueueSubscribe("presence.update", "presence-workers", func(msg *nats.Msg) {
		var update PresenceUpdate
		if err := json.Unmarshal(msg.Data, &update); err != nil {
			slog.Warn("Invalid presence update", "error", err)
			return
		}

		if !validStatuses[update.Status] {
			slog.Warn("Invalid status in presence update", "status", update.Status)
			return
		}

		if update.Status != "offline" && !ct.hasConns(update.UserId) {
			slog.Debug("Ignoring status update for user with no connections", "user", update.UserId, "status", update.Status)
			return
		}

		ps := PresenceStatus{Status: update.Status, LastSeen: time.Now().UnixMilli()}
		data, _ := json.Marshal(ps)
		statusKV.Put(update.UserId, data)

		updateCounter.Add(context.Background(), 1, metric.WithAttributes(
			attribute.String("status", update.Status),
		))

		slog.Debug("Presence update", "user", update.UserId, "status", update.Status)

		// O(1) userRooms via reverse index
		rooms := mem.userRooms(update.UserId)
		for _, room := range rooms {
			publishPresenceEvent(nc, statusKV, mem, ct, room, "status_change", update.UserId)
		}
	})
	if err != nil {
		slog.Error("Failed to subscribe to presence.update", "error", err)
		os.Exit(1)
	}

	// Subscribe to presence.room.*
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
			if !ct.hasConns(uid) {
				memberStatuses = append(memberStatuses, PresenceMember{UserId: uid, Status: "offline"})
				continue
			}
			status := "online"
			entry, err := statusKV.Get(uid)
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

	slog.Info("Presence service ready — dual-index membership, listening for room.changed.* (delta), presence.heartbeat, presence.disconnect, presence.update, presence.room.*")

	// Start KV watcher for connection expiry detection
	watcherMu.Lock()
	initialCtx, initialCancel := context.WithCancel(ctx)
	watcherCancel = initialCancel
	watcherMu.Unlock()
	go startKVWatcher(initialCtx, nc, connKV, statusKV, mem, ct, expirationCounter)

	// Wait for shutdown
	sigCtx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()
	<-sigCtx.Done()

	slog.Info("Shutting down presence service")
	// Cancel KV watcher first to stop processing expiration events during drain
	watcherMu.Lock()
	if watcherCancel != nil {
		watcherCancel()
	}
	watcherMu.Unlock()
	nc.Drain()
	slog.Info("Presence service shutdown complete")
}
