package main

import (
	"container/list"
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"os/signal"
	"strconv"
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

// RoomChangedEvent is a delta event from room-service.
type RoomChangedEvent struct {
	Room   string `json:"room"`
	Action string `json:"action"` // "join" or "leave"
	UserId string `json:"userId"`
}

// PresenceEvent is the payload from presence-service published to presence.event.{room}.
type PresenceEvent struct {
	Type    string          `json:"type"`
	UserId  string          `json:"userId"`
	Room    string          `json:"room"`
	Members json.RawMessage `json:"members"`
}

// lruEntry stores a room's member list in the LRU cache.
type lruEntry struct {
	room    string
	members map[string]bool
}

// lruCache is a thread-safe LRU cache for room membership.
type lruCache struct {
	mu    sync.Mutex
	cap   int
	list  *list.List               // front = MRU
	index map[string]*list.Element // room → list element
}

func newLRUCache(capacity int) *lruCache {
	return &lruCache{
		cap:   capacity,
		list:  list.New(),
		index: make(map[string]*list.Element),
	}
}

func (c *lruCache) get(room string) ([]string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	el, ok := c.index[room]
	if !ok {
		return nil, false
	}
	c.list.MoveToFront(el)
	entry := el.Value.(*lruEntry)
	result := make([]string, 0, len(entry.members))
	for uid := range entry.members {
		result = append(result, uid)
	}
	return result, true
}

func (c *lruCache) set(room string, members []string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if el, ok := c.index[room]; ok {
		c.list.MoveToFront(el)
		entry := el.Value.(*lruEntry)
		entry.members = make(map[string]bool, len(members))
		for _, uid := range members {
			entry.members[uid] = true
		}
		return
	}
	if c.list.Len() >= c.cap {
		back := c.list.Back()
		if back != nil {
			evicted := c.list.Remove(back).(*lruEntry)
			delete(c.index, evicted.room)
		}
	}
	entry := &lruEntry{room: room, members: make(map[string]bool, len(members))}
	for _, uid := range members {
		entry.members[uid] = true
	}
	el := c.list.PushFront(entry)
	c.index[room] = el
}

func (c *lruCache) applyDelta(room, action, userId string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	el, ok := c.index[room]
	if !ok {
		return false
	}
	entry := el.Value.(*lruEntry)
	switch action {
	case "join":
		entry.members[userId] = true
	case "leave":
		delete(entry.members, userId)
		if len(entry.members) == 0 {
			c.list.Remove(el)
			delete(c.index, room)
		}
	}
	return true
}

func (c *lruCache) reset() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.list.Init()
	c.index = make(map[string]*list.Element)
}

func (c *lruCache) roomCount() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.index)
}

func (c *lruCache) totalMembers() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	total := 0
	for el := c.list.Front(); el != nil; el = el.Next() {
		total += len(el.Value.(*lruEntry).members)
	}
	return total
}

// singleflight deduplicates concurrent cache-miss RPCs for the same room.
type singleflight struct {
	mu      sync.Mutex
	pending map[string]*flightCall
}

type flightCall struct {
	wg      sync.WaitGroup
	members []string
}

func newSingleflight() *singleflight {
	return &singleflight{pending: make(map[string]*flightCall)}
}

// do executes fn only once for concurrent calls with the same key.
// Subsequent callers block and receive the same result.
func (sf *singleflight) do(key string, fn func() []string) []string {
	sf.mu.Lock()
	if c, ok := sf.pending[key]; ok {
		sf.mu.Unlock()
		c.wg.Wait()
		return c.members
	}
	c := &flightCall{}
	c.wg.Add(1)
	sf.pending[key] = c
	sf.mu.Unlock()

	c.members = fn()
	c.wg.Done()

	sf.mu.Lock()
	delete(sf.pending, key)
	sf.mu.Unlock()

	return c.members
}

// fanoutJob represents a batch fanout task: one message → all room members.
// Each job is a single channel item regardless of member count, preventing
// subscriber goroutine blocking on large rooms.
type fanoutJob struct {
	ctx     context.Context
	nc      *nats.Conn
	members []string
	subject string // original subject (e.g., "chat.general")
	data    []byte
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

	meter := otel.Meter("fanout-service")
	fanoutCounter, _ := meter.Int64Counter("fanout_messages_total",
		metric.WithDescription("Total messages fanned out to users"))
	fanoutDuration, _ := meter.Float64Histogram("fanout_duration_seconds",
		metric.WithDescription("Time to fan out a single message to all members"))
	cacheMissCounter, _ := meter.Int64Counter("fanout_cache_misses_total",
		metric.WithDescription("Total LRU cache misses requiring room.members RPC"))
	dropCounter, _ := meter.Int64Counter("fanout_drops_total",
		metric.WithDescription("Total messages dropped due to full worker queue"))

	natsURL := envOrDefault("NATS_URL", "nats://localhost:4222")
	natsUser := envOrDefault("NATS_USER", "fanout-service")
	natsPass := envOrDefault("NATS_PASS", "fanout-service-secret")

	lruCapacity := 100
	if v := os.Getenv("FANOUT_LRU_CAPACITY"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			lruCapacity = n
		}
	}
	workerCount := 32
	if v := os.Getenv("FANOUT_WORKERS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			workerCount = n
		}
	}

	slog.Info("Starting Fanout Service (LRU + singleflight + worker pool)", "nats_url", natsURL, "lru_capacity", lruCapacity, "workers", workerCount)

	cache := newLRUCache(lruCapacity)
	sf := newSingleflight()

	// Connect to NATS with retry
	var nc *nats.Conn
	for attempt := 1; attempt <= 30; attempt++ {
		nc, err = nats.Connect(natsURL,
			nats.UserInfo(natsUser, natsPass),
			nats.Name("fanout-service"),
			nats.MaxReconnects(-1),
			nats.ReconnectWait(2*time.Second),
			nats.DisconnectErrHandler(func(_ *nats.Conn, err error) {
				slog.Warn("NATS disconnected", "error", err)
			}),
			nats.ReconnectHandler(func(_ *nats.Conn) {
				slog.Info("NATS reconnected — resetting LRU cache")
				cache.reset()
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

	// Register OTel gauge callbacks
	membershipGauge, _ := meter.Int64ObservableGauge("fanout_room_count",
		metric.WithDescription("Number of cached rooms"))
	membersGauge, _ := meter.Int64ObservableGauge("fanout_total_members",
		metric.WithDescription("Total cached room memberships"))
	_, _ = meter.RegisterCallback(func(_ context.Context, o metric.Observer) error {
		o.ObserveInt64(membershipGauge, int64(cache.roomCount()))
		o.ObserveInt64(membersGauge, int64(cache.totalMembers()))
		return nil
	}, membershipGauge, membersGauge)

	// Worker pool processes batch jobs (one job = one message → all room members).
	// Channel sized for batch jobs, not per-member items, so subscriber never blocks.
	var workerWg sync.WaitGroup
	jobCh := make(chan fanoutJob, 1000)
	for i := 0; i < workerCount; i++ {
		workerWg.Add(1)
		go func() {
			defer workerWg.Done()
			for job := range jobCh {
				for _, userId := range job.members {
					deliverSubject := "deliver." + userId + "." + job.subject
					otelhelper.TracedPublish(job.ctx, job.nc, deliverSubject, job.data)
				}
			}
		}()
	}

	// getMembers returns room members from cache, falling back to room.members RPC.
	// Uses singleflight to deduplicate concurrent cache-miss RPCs for the same room.
	getMembers := func(ctx context.Context, room string) []string {
		if members, ok := cache.get(room); ok {
			return members
		}
		// Singleflight: only one concurrent RPC per room
		return sf.do(room, func() []string {
			// Double-check cache (another goroutine may have populated it)
			if members, ok := cache.get(room); ok {
				return members
			}
			cacheMissCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("room", room)))
			reply, err := otelhelper.TracedRequest(ctx, nc, "room.members."+room, []byte("{}"))
			if err != nil {
				slog.Warn("Cache miss: room.members request failed", "room", room, "error", err)
				return nil
			}
			var members []string
			if err := json.Unmarshal(reply.Data, &members); err != nil {
				slog.Warn("Cache miss: invalid room.members response", "room", room, "error", err)
				return nil
			}
			cache.set(room, members)
			return members
		})
	}

	// enqueueFanout sends a batch job to the worker pool. Non-blocking: if the
	// channel is full, the message is dropped and counted (avoids slow consumer).
	enqueueFanout := func(ctx context.Context, members []string, subject string, data []byte) {
		select {
		case jobCh <- fanoutJob{ctx: ctx, nc: nc, members: members, subject: subject, data: data}:
		default:
			dropCounter.Add(ctx, 1)
			slog.Warn("Worker queue full, dropping fanout", "subject", subject, "members", len(members))
		}
	}

	// Subscribe to room.changed.* (no QG) — apply deltas to LRU cache
	_, err = nc.Subscribe("room.changed.*", func(msg *nats.Msg) {
		var evt RoomChangedEvent
		if err := json.Unmarshal(msg.Data, &evt); err != nil {
			slog.Warn("Invalid room.changed event", "error", err)
			return
		}
		if cache.applyDelta(evt.Room, evt.Action, evt.UserId) {
			slog.Debug("Applied delta to LRU cache", "room", evt.Room, "action", evt.Action, "user", evt.UserId)
		}
	})
	if err != nil {
		slog.Error("Failed to subscribe to room.changed.*", "error", err)
		os.Exit(1)
	}

	// Subscribe to chat messages via queue group
	_, err = nc.QueueSubscribe("chat.>", "fanout-workers", func(msg *nats.Msg) {
		if strings.HasPrefix(msg.Subject, "chat.history") {
			return
		}

		ctx, span := otelhelper.StartConsumerSpan(context.Background(), msg, "fanout chat message")
		defer span.End()

		start := time.Now()

		remainder := strings.TrimPrefix(msg.Subject, "chat.")
		room := remainder
		if idx := strings.Index(remainder, "."); idx != -1 {
			room = remainder[:idx]
		}

		members := getMembers(ctx, room)
		span.SetAttributes(
			attribute.String("chat.room", room),
			attribute.Int("fanout.member_count", len(members)),
		)

		if len(members) > 0 {
			enqueueFanout(ctx, members, msg.Subject, msg.Data)
		}

		duration := time.Since(start).Seconds()
		fanoutCounter.Add(ctx, int64(len(members)), metric.WithAttributes(
			attribute.String("room", room),
		))
		fanoutDuration.Record(ctx, duration, metric.WithAttributes(
			attribute.String("room", room),
		))

		if len(members) > 0 {
			slog.DebugContext(ctx, "Fanned out message", "room", room, "members", len(members), "duration_ms", time.Since(start).Milliseconds())
		}
	})
	if err != nil {
		slog.Error("Failed to subscribe to chat.>", "error", err)
		os.Exit(1)
	}

	// Subscribe to admin messages via same queue group
	_, err = nc.QueueSubscribe("admin.*", "fanout-workers", func(msg *nats.Msg) {
		ctx, span := otelhelper.StartConsumerSpan(context.Background(), msg, "fanout admin message")
		defer span.End()

		start := time.Now()
		room := strings.TrimPrefix(msg.Subject, "admin.")

		memberKey := "__admin__" + room
		members := getMembers(ctx, memberKey)
		span.SetAttributes(
			attribute.String("chat.room", "admin."+room),
			attribute.Int("fanout.member_count", len(members)),
		)

		if len(members) > 0 {
			enqueueFanout(ctx, members, msg.Subject, msg.Data)
		}

		duration := time.Since(start).Seconds()
		fanoutCounter.Add(ctx, int64(len(members)), metric.WithAttributes(
			attribute.String("room", "admin."+room),
		))
		fanoutDuration.Record(ctx, duration, metric.WithAttributes(
			attribute.String("room", "admin."+room),
		))
	})
	if err != nil {
		slog.Error("Failed to subscribe to admin.*", "error", err)
		os.Exit(1)
	}

	// Subscribe to presence.event.* via queue group
	_, err = nc.QueueSubscribe("presence.event.*", "fanout-workers", func(msg *nats.Msg) {
		parts := strings.Split(msg.Subject, ".")
		if len(parts) < 3 {
			return
		}
		room := parts[2]

		members := getMembers(context.Background(), room)
		for _, member := range members {
			subject := "deliver." + member + ".presence." + room
			nc.Publish(subject, msg.Data)
		}

		if len(members) > 0 {
			slog.Debug("Fanned out presence event", "room", room, "members", len(members))
		}
	})
	if err != nil {
		slog.Error("Failed to subscribe to presence.event.*", "error", err)
		os.Exit(1)
	}

	slog.Info("Fanout service ready — LRU + singleflight + worker pool, listening for chat.>, admin.*, presence.event.*, room.changed.*")

	// Wait for shutdown
	sigCtx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()
	<-sigCtx.Done()

	slog.Info("Shutting down fanout service")
	// 1. Drain NATS — stops accepting new messages, waits for in-flight callbacks
	nc.Drain()
	// 2. Close worker channel — workers finish remaining jobs then exit
	close(jobCh)
	workerWg.Wait()
	slog.Info("Fanout service shutdown complete")
}
