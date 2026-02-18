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

	otelhelper "github.com/example/nats-chat-otelhelper"
	_ "github.com/lib/pq"
	"github.com/nats-io/nats.go"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

// membership tracks which users are in which rooms.
type membership struct {
	mu    sync.RWMutex
	rooms map[string]map[string]bool
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

// MembershipEvent is the payload for room.join.* and room.leave.* messages.
type MembershipEvent struct {
	UserId string `json:"userId"`
}

// ReadState is the KV value for a user-room read position.
type ReadState struct {
	LastRead int64 `json:"lastRead"`
}

// ReadUpdate is the payload clients send to read.update.{room}.
type ReadUpdate struct {
	UserId   string `json:"userId"`
	LastRead int64  `json:"lastRead"`
}

// ReadReceipt represents one member's read position in a broadcast/response.
type ReadReceipt struct {
	UserId   string `json:"userId"`
	LastRead int64  `json:"lastRead"`
}

// dirtySet tracks KV entries that need flushing to PostgreSQL.
type dirtySet struct {
	mu      sync.Mutex
	entries map[string]bool // key = "userId.room"
}

func newDirtySet() *dirtySet {
	return &dirtySet{entries: make(map[string]bool)}
}

func (d *dirtySet) add(key string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.entries[key] = true
}

func (d *dirtySet) drain() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	keys := make([]string, 0, len(d.entries))
	for k := range d.entries {
		keys = append(keys, k)
	}
	d.entries = make(map[string]bool)
	return keys
}

// flushToPostgres batch-upserts dirty entries from KV to PostgreSQL.
func flushToPostgres(ctx context.Context, db *sql.DB, kv nats.KeyValue, dirty *dirtySet, flushCounter metric.Int64Counter) {
	keys := dirty.drain()
	if len(keys) == 0 {
		return
	}

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		slog.Warn("Flush: failed to begin transaction", "error", err)
		// Re-add keys to dirty set for next flush
		for _, k := range keys {
			dirty.add(k)
		}
		return
	}

	stmt, err := tx.PrepareContext(ctx,
		"INSERT INTO read_receipts (user_id, room, last_read, updated_at) VALUES ($1, $2, $3, NOW()) "+
			"ON CONFLICT (user_id, room) DO UPDATE SET last_read = EXCLUDED.last_read, updated_at = NOW()")
	if err != nil {
		slog.Warn("Flush: failed to prepare statement", "error", err)
		tx.Rollback()
		for _, k := range keys {
			dirty.add(k)
		}
		return
	}
	defer stmt.Close()

	flushed := 0
	for _, key := range keys {
		entry, err := kv.Get(key)
		if err != nil {
			continue
		}
		var rs ReadState
		if json.Unmarshal(entry.Value(), &rs) != nil {
			continue
		}
		// key = "userId.room" — split on first dot
		parts := strings.SplitN(key, ".", 2)
		if len(parts) != 2 {
			continue
		}
		userId, room := parts[0], parts[1]
		if _, err := stmt.ExecContext(ctx, userId, room, rs.LastRead); err != nil {
			slog.Warn("Flush: failed to upsert", "key", key, "error", err)
			continue
		}
		flushed++
	}

	if err := tx.Commit(); err != nil {
		slog.Warn("Flush: failed to commit", "error", err)
		return
	}

	if flushed > 0 {
		flushCounter.Add(ctx, int64(flushed))
		slog.Info("Flushed read receipts to PostgreSQL", "count", flushed)
	}
}

// loadFromPostgres populates KV bucket from PostgreSQL on startup.
func loadFromPostgres(ctx context.Context, db *sql.DB, kv nats.KeyValue) error {
	rows, err := db.QueryContext(ctx, "SELECT user_id, room, last_read FROM read_receipts")
	if err != nil {
		return fmt.Errorf("query read_receipts: %w", err)
	}
	defer rows.Close()

	count := 0
	for rows.Next() {
		var userId, room string
		var lastRead int64
		if err := rows.Scan(&userId, &room, &lastRead); err != nil {
			slog.Warn("Load: failed to scan row", "error", err)
			continue
		}
		key := userId + "." + room
		data, _ := json.Marshal(ReadState{LastRead: lastRead})
		if _, err := kv.Put(key, data); err != nil {
			slog.Warn("Load: failed to put KV entry", "key", key, "error", err)
			continue
		}
		count++
	}
	slog.Info("Loaded read receipts from PostgreSQL into KV", "count", count)
	return rows.Err()
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

	meter := otel.Meter("read-receipt-service")
	updateCounter, _ := meter.Int64Counter("read_receipt_updates_total",
		metric.WithDescription("Total read receipt updates received"))
	queryCounter, _ := meter.Int64Counter("read_receipt_queries_total",
		metric.WithDescription("Total read state queries"))
	queryDuration, _ := meter.Float64Histogram("read_receipt_query_duration_seconds",
		metric.WithDescription("Duration of read state queries"))
	flushCounter, _ := meter.Int64Counter("read_receipt_flush_total",
		metric.WithDescription("Total entries flushed to PostgreSQL"))

	natsURL := envOrDefault("NATS_URL", "nats://localhost:4222")
	natsUser := envOrDefault("NATS_USER", "read-receipt-service")
	natsPass := envOrDefault("NATS_PASS", "read-receipt-service-secret")
	dbURL := envOrDefault("DATABASE_URL", "postgres://chat:chat-secret@localhost:5432/chatdb?sslmode=disable")

	slog.Info("Starting Read Receipt Service", "nats_url", natsURL)

	// Connect to PostgreSQL
	db, err := sql.Open("postgres", dbURL)
	if err != nil {
		slog.Error("Failed to open database", "error", err)
		os.Exit(1)
	}
	defer db.Close()
	db.SetMaxOpenConns(5)
	db.SetMaxIdleConns(2)

	// Retry DB ping
	for attempt := 1; attempt <= 30; attempt++ {
		if err = db.PingContext(ctx); err == nil {
			break
		}
		slog.Info("Waiting for PostgreSQL", "attempt", attempt, "error", err)
		time.Sleep(2 * time.Second)
	}
	if err != nil {
		slog.Error("Failed to connect to PostgreSQL", "error", err)
		os.Exit(1)
	}
	slog.Info("Connected to PostgreSQL")

	// Connect to NATS with retry
	var nc *nats.Conn
	for attempt := 1; attempt <= 30; attempt++ {
		nc, err = nats.Connect(natsURL,
			nats.UserInfo(natsUser, natsPass),
			nats.Name("read-receipt-service"),
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
		Bucket:  "READ_STATE",
		History: 1,
		Storage: nats.FileStorage,
	})
	if err != nil {
		slog.Error("Failed to create KV bucket", "error", err)
		os.Exit(1)
	}
	slog.Info("NATS KV bucket ready", "bucket", "READ_STATE")

	// Load existing read state from PostgreSQL into KV
	if err := loadFromPostgres(ctx, db, kv); err != nil {
		slog.Error("Failed to load read state from PostgreSQL", "error", err)
		os.Exit(1)
	}

	mem := newMembership()
	dirty := newDirtySet()

	// Subscribe to membership events
	_, err = nc.Subscribe("room.join.*", func(msg *nats.Msg) {
		parts := strings.Split(msg.Subject, ".")
		if len(parts) < 3 {
			return
		}
		room := parts[2]
		var evt MembershipEvent
		if err := json.Unmarshal(msg.Data, &evt); err != nil {
			return
		}
		mem.join(room, evt.UserId)
		slog.Debug("User joined room", "user", evt.UserId, "room", room)
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
			return
		}
		mem.leave(room, evt.UserId)
		slog.Debug("User left room", "user", evt.UserId, "room", room)
	})
	if err != nil {
		slog.Error("Failed to subscribe to room.leave.*", "error", err)
		os.Exit(1)
	}

	// Subscribe to read.update.{room} — client reports "I've read up to timestamp X"
	_, err = nc.Subscribe("read.update.*", func(msg *nats.Msg) {
		parts := strings.Split(msg.Subject, ".")
		if len(parts) < 3 {
			return
		}
		room := parts[2]

		var update ReadUpdate
		if err := json.Unmarshal(msg.Data, &update); err != nil {
			slog.Warn("Invalid read update", "error", err)
			return
		}

		key := update.UserId + "." + room

		// Dedup: skip if lastRead hasn't changed
		entry, err := kv.Get(key)
		if err == nil {
			var existing ReadState
			if json.Unmarshal(entry.Value(), &existing) == nil && existing.LastRead >= update.LastRead {
				return
			}
		}

		// Write to KV
		data, _ := json.Marshal(ReadState{LastRead: update.LastRead})
		if _, err := kv.Put(key, data); err != nil {
			slog.Warn("Failed to put read state", "key", key, "error", err)
			return
		}

		dirty.add(key)
		updateCounter.Add(context.Background(), 1, metric.WithAttributes(
			attribute.String("room", room),
		))

		slog.Debug("Read update", "user", update.UserId, "room", room, "lastRead", update.LastRead)
	})
	if err != nil {
		slog.Error("Failed to subscribe to read.update.*", "error", err)
		os.Exit(1)
	}

	// Subscribe to read.state.{room} — request/reply for current read positions
	_, err = nc.Subscribe("read.state.*", func(msg *nats.Msg) {
		start := time.Now()
		ctx, span := otelhelper.StartServerSpan(context.Background(), msg, "read state query")
		defer span.End()

		parts := strings.Split(msg.Subject, ".")
		if len(parts) < 3 {
			msg.Respond([]byte("[]"))
			return
		}
		room := parts[2]
		span.SetAttributes(attribute.String("read.room", room))

		members := mem.members(room)
		readers := make([]ReadReceipt, 0, len(members))
		for _, uid := range members {
			key := uid + "." + room
			entry, err := kv.Get(key)
			if err == nil {
				var rs ReadState
				if json.Unmarshal(entry.Value(), &rs) == nil {
					readers = append(readers, ReadReceipt{UserId: uid, LastRead: rs.LastRead})
				}
			}
		}

		data, err := json.Marshal(readers)
		if err != nil {
			slog.ErrorContext(ctx, "Failed to marshal read state response", "error", err)
			span.RecordError(err)
			msg.Respond([]byte("[]"))
			return
		}
		msg.Respond(data)

		duration := time.Since(start).Seconds()
		attrs := metric.WithAttributes(attribute.String("room", room))
		queryCounter.Add(ctx, 1, attrs)
		queryDuration.Record(ctx, duration, attrs)

		span.SetAttributes(attribute.Int("read.reader_count", len(readers)))
		slog.DebugContext(ctx, "Served read state query", "room", room, "readers", len(readers))
	})
	if err != nil {
		slog.Error("Failed to subscribe to read.state.*", "error", err)
		os.Exit(1)
	}

	slog.Info("Read receipt service ready — listening for room.join.*, room.leave.*, read.update.*, read.state.*")

	// Periodic flush to PostgreSQL
	flushCtx, flushCancel := context.WithCancel(ctx)
	defer flushCancel()
	go func() {
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-flushCtx.Done():
				// Final flush on shutdown
				flushToPostgres(context.Background(), db, kv, dirty, flushCounter)
				return
			case <-ticker.C:
				flushToPostgres(flushCtx, db, kv, dirty, flushCounter)
			}
		}
	}()

	// Wait for shutdown
	sigCtx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()
	<-sigCtx.Done()

	slog.Info("Shutting down read receipt service")
	flushCancel() // triggers final flush
	time.Sleep(500 * time.Millisecond) // wait for final flush
	nc.Drain()
}
