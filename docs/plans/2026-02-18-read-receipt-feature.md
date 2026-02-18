# Read Receipt Feature Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add per-room read watermarks so users can see "Read by N" indicators and compute unread counts from durable read positions.

**Architecture:** A dedicated read-receipt-service owns all read state. Hot path uses NATS KV bucket `READ_STATE` (FileStorage). Dirty entries are batched and flushed to PostgreSQL every 15 seconds. On startup, KV is rebuilt from PostgreSQL. Broadcasts go to room members via `deliver.{member}.read.{room}`.

**Tech Stack:** Go (read-receipt-service), NATS KV (JetStream), PostgreSQL, React/TypeScript (frontend)

---

### Task 1: Add `read_receipts` PostgreSQL Table

**Files:**
- Modify: `postgres/init.sql`

**Step 1: Add schema**

Append to the end of `postgres/init.sql`:

```sql
CREATE TABLE IF NOT EXISTS read_receipts (
    user_id    VARCHAR(255) NOT NULL,
    room       VARCHAR(255) NOT NULL,
    last_read  BIGINT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, room)
);
```

**Step 2: Verify syntax**

Run: `docker compose exec postgres psql -U chat -d chatdb -c "CREATE TABLE IF NOT EXISTS read_receipts (user_id VARCHAR(255) NOT NULL, room VARCHAR(255) NOT NULL, last_read BIGINT NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (user_id, room));"`
Expected: `CREATE TABLE`

**Step 3: Commit**

```bash
git add postgres/init.sql
git commit -m "feat(read-receipt): add read_receipts table schema"
```

---

### Task 2: Add `read-receipt-service` User to NATS and Auth

**Files:**
- Modify: `nats/nats-server.conf`
- Modify: `auth-service/permissions.go`

**Step 1: Add user to NATS config**

In `nats/nats-server.conf`, in the `CHAT` account `users` array (after the `presence-service` line), add:

```
      { user: read-receipt-service, password: read-receipt-service-secret }
```

In the `auth_callout` section `auth_users` array, append `read-receipt-service`:

```
    auth_users: [ auth, persist-worker, history-service, fanout-service, presence-service, read-receipt-service ]
```

**Step 2: Add read receipt subjects to permissions**

In `auth-service/permissions.go`, add `"read.update.*"` and `"read.state.*"` to the `Pub.Allow` list for all three permission tiers (admin, user, and no-role).

For the **admin** tier (line ~27), the `Pub.Allow` becomes:

```go
		perms.Pub.Allow = jwt.StringList{
			"chat.>",
			"admin.>",
			"room.join.*",
			"room.leave.*",
			"presence.update",
			"presence.room.*",
			"read.update.*",
			"read.state.*",
			"_INBOX.>",
		}
```

For the **user** tier (line ~47), the `Pub.Allow` becomes:

```go
		perms.Pub.Allow = jwt.StringList{
			"chat.>",
			"room.join.*",
			"room.leave.*",
			"presence.update",
			"presence.room.*",
			"read.update.*",
			"read.state.*",
			"_INBOX.>",
		}
```

For the **no-role** tier (line ~64), the `Pub.Allow` becomes:

```go
		perms.Pub.Allow = jwt.StringList{
			"room.join.*",
			"room.leave.*",
			"presence.update",
			"presence.room.*",
			"read.update.*",
			"read.state.*",
			"_INBOX.>",
		}
```

**Step 3: Verify auth-service compiles**

Run: `cd auth-service && go build -o /dev/null .`
Expected: clean compile, no errors

**Step 4: Commit**

```bash
git add nats/nats-server.conf auth-service/permissions.go
git commit -m "feat(read-receipt): add NATS user and read subjects to permissions"
```

---

### Task 3: Create `read-receipt-service/go.mod`

**Files:**
- Create: `read-receipt-service/go.mod`

**Step 1: Create go.mod**

```go
module github.com/example/nats-chat-read-receipt-service

go 1.22.0

require (
	github.com/example/nats-chat-otelhelper v0.0.0
	github.com/lib/pq v1.10.9
	github.com/nats-io/nats.go v1.38.0
	go.opentelemetry.io/otel v1.34.0
	go.opentelemetry.io/otel/metric v1.34.0
)

replace github.com/example/nats-chat-otelhelper => ../pkg/otelhelper
```

**Step 2: Run go mod tidy**

Run: `cd read-receipt-service && go mod tidy`
Expected: downloads dependencies, generates `go.sum`

**Step 3: Commit**

```bash
git add read-receipt-service/go.mod read-receipt-service/go.sum
git commit -m "feat(read-receipt): add go module definition"
```

---

### Task 4: Create `read-receipt-service/main.go`

This is the core service. It follows the same pattern as `presence-service/main.go` but adds PostgreSQL integration with batched flushing.

**Files:**
- Create: `read-receipt-service/main.go`

**Step 1: Write the service**

```go
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

// ReadBroadcast is the payload sent to deliver.{member}.read.{room}.
type ReadBroadcast struct {
	Room    string        `json:"room"`
	Readers []ReadReceipt `json:"readers"`
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

// broadcastReadState publishes a read state snapshot to every member in the room.
func broadcastReadState(nc *nats.Conn, kv nats.KeyValue, mem *membership, room string) {
	members := mem.members(room)
	if len(members) == 0 {
		return
	}

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

	evt := ReadBroadcast{Room: room, Readers: readers}
	data, err := json.Marshal(evt)
	if err != nil {
		slog.Warn("Failed to marshal read broadcast", "error", err)
		return
	}
	for _, member := range members {
		subject := "deliver." + member + ".read." + room
		nc.Publish(subject, data)
	}
	slog.Debug("Broadcast read state", "room", room, "readers", len(readers))
}

// debouncer limits broadcasts to at most once per interval per room.
type debouncer struct {
	mu       sync.Mutex
	pending  map[string]bool
	interval time.Duration
}

func newDebouncer(interval time.Duration) *debouncer {
	return &debouncer{
		pending:  make(map[string]bool),
		interval: interval,
	}
}

// trigger schedules a broadcast for a room. Returns true if a new timer was started.
func (d *debouncer) trigger(room string, fn func()) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.pending[room] {
		return false
	}
	d.pending[room] = true
	go func() {
		time.Sleep(d.interval)
		d.mu.Lock()
		delete(d.pending, room)
		d.mu.Unlock()
		fn()
	}()
	return true
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
	broadcastCounter, _ := meter.Int64Counter("read_receipt_broadcasts_total",
		metric.WithDescription("Total read receipt broadcasts"))

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
	deb := newDebouncer(2 * time.Second)

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

		// Debounced broadcast to room members
		deb.trigger(room, func() {
			broadcastReadState(nc, kv, mem, room)
			broadcastCounter.Add(context.Background(), 1, metric.WithAttributes(
				attribute.String("room", room),
			))
		})
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
```

**Step 2: Verify compilation**

Run: `cd read-receipt-service && go build -o /dev/null .`
Expected: clean compile, no errors

**Step 3: Commit**

```bash
git add read-receipt-service/main.go
git commit -m "feat(read-receipt): add read-receipt-service with KV and PostgreSQL flush"
```

---

### Task 5: Create `read-receipt-service/Dockerfile`

**Files:**
- Create: `read-receipt-service/Dockerfile`

**Step 1: Create Dockerfile**

```dockerfile
FROM golang:1.22-alpine AS builder

WORKDIR /app

COPY read-receipt-service/go.mod read-receipt-service/go.sum ./
COPY pkg/otelhelper/ /pkg/otelhelper/
RUN go mod download

COPY read-receipt-service/*.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -o /read-receipt-service .

FROM alpine:3.19

RUN apk add --no-cache ca-certificates

COPY --from=builder /read-receipt-service /read-receipt-service

ENTRYPOINT ["/read-receipt-service"]
```

**Step 2: Commit**

```bash
git add read-receipt-service/Dockerfile
git commit -m "feat(read-receipt): add Dockerfile for read-receipt-service"
```

---

### Task 6: Add `read-receipt-service` to `docker-compose.yml`

**Files:**
- Modify: `docker-compose.yml`

**Step 1: Add service container**

After the `presence-service` block (around line 133), add:

```yaml
  read-receipt-service:
    build:
      context: .
      dockerfile: read-receipt-service/Dockerfile
    environment:
      NATS_URL: nats://nats:4222
      NATS_USER: read-receipt-service
      NATS_PASS: read-receipt-service-secret
      DATABASE_URL: postgres://chat:chat-secret@postgres:5432/chatdb?sslmode=disable
      OTEL_EXPORTER_OTLP_ENDPOINT: http://otel-collector:4317
      OTEL_SERVICE_NAME: read-receipt-service
    depends_on:
      - nats
      - postgres
      - otel-collector
    restart: unless-stopped
```

**Step 2: Commit**

```bash
git add docker-compose.yml
git commit -m "feat(read-receipt): add read-receipt-service to docker-compose"
```

---

### Task 7: Update `MessageProvider` with Read Receipt State

This is the largest frontend change. We add: readReceipts state, handle `deliver.{userId}.read.{room}` events, enhance `markAsRead` to publish `read.update.{room}`, request initial read state on room join, compute unread counts from watermarks, and add client-side debounce.

**Files:**
- Modify: `web/src/providers/MessageProvider.tsx`

**Step 1: Add read receipt types and state**

Add to `MessageContextType` interface (after `closeThread`):

```typescript
  /** Read receipts per room: array of {userId, lastRead} */
  readReceipts: Record<string, Array<{userId: string, lastRead: number}>>;
```

Add to the default context value:

```typescript
  readReceipts: {},
```

Add state inside `MessageProvider`:

```typescript
const [readReceipts, setReadReceipts] = useState<Record<string, Array<{userId: string, lastRead: number}>>>({});
const readUpdateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
```

**Step 2: Handle `deliver.{userId}.read.{room}` events**

In the deliver subscription message handler (inside the `for await` loop), add a new handler for the `"read"` subjectType, right after the existing `"presence"` handler:

```typescript
            // Handle read receipt events (deliver.{userId}.read.{room})
            if (subjectType === 'read') {
              const readData = JSON.parse(sc.decode(msg.data)) as {
                room: string;
                readers: Array<{userId: string; lastRead: number}>;
              };
              const readRoomKey = roomName === '__admin__chat' ? '__admin__' : roomName;
              setReadReceipts((prev) => ({
                ...prev,
                [readRoomKey]: readData.readers,
              }));
              continue;
            }
```

**Step 3: Enhance `markAsRead` to publish read position**

Replace the existing `markAsRead` callback with:

```typescript
  const markAsRead = useCallback((room: string) => {
    activeRoomRef.current = room;
    setUnreadCounts((prev) => {
      if (!prev[room]) return prev;
      const next = { ...prev };
      delete next[room];
      return next;
    });

    // Publish read position to read-receipt-service (debounced)
    if (!nc || !connected || !userInfo) return;
    if (readUpdateTimerRef.current) clearTimeout(readUpdateTimerRef.current);
    readUpdateTimerRef.current = setTimeout(() => {
      const messages = messagesByRoom[room] || [];
      if (messages.length === 0) return;
      const latestTs = messages[messages.length - 1].timestamp;
      const memberKey = roomToMemberKey(room);
      const payload = JSON.stringify({ userId: userInfo.username, lastRead: latestTs });
      nc.publish(`read.update.${memberKey}`, sc.encode(payload));
    }, 3000);
  }, [nc, connected, userInfo, sc, messagesByRoom]);
```

**Step 4: Request initial read state on room join**

Inside the `joinRoom` callback, after the existing `nc.request('presence.room...')` block, add:

```typescript
    // Request initial read receipts for this room
    nc.request(`read.state.${memberKey}`, sc.encode(''), { timeout: 5000 })
      .then((reply) => {
        try {
          const readers = JSON.parse(sc.decode(reply.data)) as Array<{userId: string; lastRead: number}>;
          const readRoomKey = room;
          setReadReceipts((prev) => ({
            ...prev,
            [readRoomKey]: readers,
          }));
        } catch {
          console.log('[ReadReceipt] Failed to parse read state response');
        }
      })
      .catch((err) => {
        console.log('[ReadReceipt] Read state request failed:', err);
      });
```

**Step 5: Expose readReceipts in context**

Add `readReceipts` to the Provider value:

```typescript
    <MessageContext.Provider value={{
      getMessages, joinRoom, leaveRoom, unreadCounts, markAsRead,
      onlineUsers, setStatus, currentStatus,
      getThreadMessages, replyCounts, activeThread, openThread, closeThread,
      readReceipts
    }}>
```

**Step 6: Verify TypeScript compiles**

Run: `cd web && npx tsc --noEmit`
Expected: clean compile, no errors

**Step 7: Commit**

```bash
git add web/src/providers/MessageProvider.tsx
git commit -m "feat(read-receipt): add read receipt state and publishing to MessageProvider"
```

---

### Task 8: Add "Read by" Indicators to `MessageList`

**Files:**
- Modify: `web/src/components/MessageList.tsx`

**Step 1: Add readReceipts prop**

Add to the `Props` interface:

```typescript
  readReceipts?: Array<{userId: string; lastRead: number}>;
```

Add `readReceipts` to the component destructuring:

```typescript
export const MessageList: React.FC<Props> = ({ messages, currentUser, memberStatusMap, replyCounts, onReplyClick, readReceipts }) => {
```

**Step 2: Add "Read by" style**

Add to the `styles` object:

```typescript
  readBy: {
    fontSize: '11px',
    color: '#64748b',
    marginTop: '2px',
    paddingLeft: '2px',
  },
```

**Step 3: Compute and display "Read by N" after messages**

Inside the `messages.map` callback, after the reply badge block, add the read-by indicator. The logic: for each message, find all readers (other than the sender) whose `lastRead` >= this message's timestamp but < the next message's timestamp (or for the last message, just >= this message's timestamp):

```typescript
              {readReceipts && readReceipts.length > 0 && (() => {
                const nextTs = i < messages.length - 1 ? messages[i + 1].timestamp : Infinity;
                const readByUsers = readReceipts.filter(
                  (r) => r.userId !== msg.user && r.userId !== currentUser &&
                    r.lastRead >= msg.timestamp && r.lastRead < nextTs
                );
                if (readByUsers.length === 0) return null;
                const names = readByUsers.length <= 3
                  ? readByUsers.map((r) => r.userId).join(', ')
                  : `${readByUsers.slice(0, 2).map((r) => r.userId).join(', ')} +${readByUsers.length - 2}`;
                return <div style={styles.readBy}>Read by {names}</div>;
              })()}
```

Place this inside the `<div style={styles.content}>` block, after the replyBadge button.

**Step 4: Verify TypeScript compiles**

Run: `cd web && npx tsc --noEmit`
Expected: clean compile, no errors

**Step 5: Commit**

```bash
git add web/src/components/MessageList.tsx
git commit -m "feat(read-receipt): add 'Read by' indicators to message list"
```

---

### Task 9: Pass `readReceipts` from `ChatRoom` to `MessageList`

**Files:**
- Modify: `web/src/components/ChatRoom.tsx`

**Step 1: Destructure readReceipts from context**

Update the `useMessages()` destructuring to include `readReceipts`:

```typescript
  const { getMessages, joinRoom, markAsRead, onlineUsers, replyCounts, activeThread, openThread, closeThread, readReceipts } = useMessages();
```

**Step 2: Pass readReceipts to MessageList**

Add the `readReceipts` prop to the `<MessageList>` component:

```typescript
        <MessageList
          messages={allMessages}
          currentUser={userInfo?.username || ''}
          memberStatusMap={statusMap}
          replyCounts={replyCounts}
          onReplyClick={handleReplyClick}
          readReceipts={readReceipts[room] || []}
        />
```

**Step 3: Verify TypeScript compiles**

Run: `cd web && npx tsc --noEmit`
Expected: clean compile, no errors

**Step 4: Commit**

```bash
git add web/src/components/ChatRoom.tsx
git commit -m "feat(read-receipt): pass read receipts from ChatRoom to MessageList"
```

---

### Task 10: Build Verification

**Step 1: Verify all Go services compile**

Run in parallel:
- `cd read-receipt-service && go build -o /dev/null .`
- `cd auth-service && go build -o /dev/null .`

Expected: both compile cleanly

**Step 2: Verify TypeScript compiles**

Run: `cd web && npx tsc --noEmit`
Expected: clean compile, no errors

**Step 3: Rebuild all services**

Run: `docker compose up -d --build`
Expected: all containers start, including new `read-receipt-service`

**Step 4: Apply DB migration**

Run: `docker compose exec postgres psql -U chat -d chatdb -c "CREATE TABLE IF NOT EXISTS read_receipts (user_id VARCHAR(255) NOT NULL, room VARCHAR(255) NOT NULL, last_read BIGINT NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (user_id, room));"`
Expected: `CREATE TABLE`

**Step 5: Verify service health**

Run: `docker compose ps`
Expected: all services running, including `read-receipt-service`

---

## Files Summary

| Action | File | Purpose |
|--------|------|---------|
| MODIFY | `postgres/init.sql` | Add `read_receipts` table |
| MODIFY | `nats/nats-server.conf` | Add `read-receipt-service` user |
| MODIFY | `auth-service/permissions.go` | Add `read.update.*`, `read.state.*` to permissions |
| CREATE | `read-receipt-service/go.mod` | Go module definition |
| CREATE | `read-receipt-service/main.go` | Read receipt service: KV, flush, broadcasts |
| CREATE | `read-receipt-service/Dockerfile` | Multi-stage Go build |
| MODIFY | `docker-compose.yml` | Add `read-receipt-service` container |
| MODIFY | `web/src/providers/MessageProvider.tsx` | Read receipt state, publish, handle events |
| MODIFY | `web/src/components/MessageList.tsx` | "Read by" indicators |
| MODIFY | `web/src/components/ChatRoom.tsx` | Pass readReceipts prop |
