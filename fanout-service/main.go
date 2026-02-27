package main

import (
	"container/list"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	otelhelper "github.com/example/nats-chat-otelhelper"
	"github.com/nats-io/nats.go"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

const (
	defaultRateLimitPerMinute = 60
	maxRateLimitPerMinute     = 10000
	minRateLimitPerMinute     = 1
	rateLimitWindowSeconds    = 60
)

type RateLimitFallback string

const (
	FallbackAllow RateLimitFallback = "allow"
	FallbackBlock RateLimitFallback = "block"
	FallbackWarn  RateLimitFallback = "warn"
)

type CircuitBreakerState int32

const (
	CircuitBreakerClosed CircuitBreakerState = iota
	CircuitBreakerOpen
	CircuitBreakerHalfOpen
)

type CircuitBreaker struct {
	state           atomic.Int32
	failures        atomic.Int64
	lastFailure     atomic.Int64
	threshold       int64
	cooldownSeconds int64
}

func NewCircuitBreaker(threshold int, cooldownSeconds int) *CircuitBreaker {
	cb := &CircuitBreaker{
		threshold:       int64(threshold),
		cooldownSeconds: int64(cooldownSeconds),
	}
	cb.state.Store(int32(CircuitBreakerClosed))
	return cb
}

func (cb *CircuitBreaker) Allow() bool {
	state := CircuitBreakerState(cb.state.Load())
	if state == CircuitBreakerClosed {
		return true
	}
	if state == CircuitBreakerOpen {
		now := time.Now().Unix()
		lastFail := cb.lastFailure.Load()
		if now-lastFail >= cb.cooldownSeconds {
			cb.state.Store(int32(CircuitBreakerHalfOpen))
			return true
		}
		return false
	}
	return true
}

func (cb *CircuitBreaker) RecordFailure() {
	cb.failures.Add(1)
	cb.lastFailure.Store(time.Now().Unix())
	if cb.failures.Load() >= cb.threshold {
		cb.state.Store(int32(CircuitBreakerOpen))
	}
}

func (cb *CircuitBreaker) RecordSuccess() {
	cb.failures.Store(0)
	cb.state.Store(int32(CircuitBreakerClosed))
}

func (cb *CircuitBreaker) State() CircuitBreakerState {
	return CircuitBreakerState(cb.state.Load())
}

// RoomChangedEvent is a delta event from room-service.
type RoomChangedEvent struct {
	Room   string `json:"room"`
	Action string `json:"action"` // "join" or "leave"
	UserId string `json:"userId"`
	Type   string `json:"type,omitempty"` // "private", "dm", or "" (public)
}

// chatPayload extracts metadata from a chat message for notification building.
type chatPayload struct {
	User       string  `json:"user"`
	Action     string  `json:"action,omitempty"`
	Timestamp  float64 `json:"timestamp"`
	Emoji      string  `json:"emoji,omitempty"`
	TargetUser string  `json:"targetUser,omitempty"`
}

// chatNotification is the lightweight ID-stream payload sent to room.notify.{room}.
// Contains only metadata — never message text content.
type chatNotification struct {
	NotifyId   string  `json:"notifyId"`
	Room       string  `json:"room"`
	Action     string  `json:"action"` // "message", "edit", "delete", "react", "sticker", "system"
	User       string  `json:"user"`
	Timestamp  float64 `json:"timestamp,omitempty"`
	ThreadId   string  `json:"threadId,omitempty"`
	Emoji      string  `json:"emoji,omitempty"`
	TargetUser string  `json:"targetUser,omitempty"`
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

// isMember checks if a user is in a room's cached member set.
// Returns (member, cached). If cached=false, the room is not in cache (miss).
func (c *lruCache) isMember(room, userId string) (member bool, cached bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	el, ok := c.index[room]
	if !ok {
		return false, false
	}
	c.list.MoveToFront(el)
	entry := el.Value.(*lruEntry)
	return entry.members[userId], true
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
	rejectCounter, _ := meter.Int64Counter("fanout_rejected_total",
		metric.WithDescription("Total messages rejected from non-members"))
	rateLimitCounter, _ := meter.Int64Counter("fanout_rate_limited_total",
		metric.WithDescription("Total messages rate limited"))
	rateLimitErrorCounter, _ := meter.Int64Counter("fanout_rate_limit_errors_total",
		metric.WithDescription("Total rate limit KV operation errors"))
	rateLimitKVFailures, _ := meter.Int64Counter("fanout_rate_limit_kv_failures_total",
		metric.WithDescription("Total rate limit KV failures (circuit breaker trips)"))
	notifyCounter, _ := meter.Int64Counter("fanout_notifications_total",
		metric.WithDescription("Total notifications published to ID stream"))
	fetchCounter, _ := meter.Int64Counter("fanout_fetches_total",
		metric.WithDescription("Total msg.get fetch requests"))

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

	rateLimitPerMinute := defaultRateLimitPerMinute
	if v := os.Getenv("FANOUT_RATE_LIMIT_PER_MINUTE"); v != "" {
		if n, err := strconv.Atoi(v); err != nil {
			slog.Warn("Invalid FANOUT_RATE_LIMIT_PER_MINUTE value, using default", "value", v, "default", defaultRateLimitPerMinute)
		} else if n < minRateLimitPerMinute {
			slog.Warn("FANOUT_RATE_LIMIT_PER_MINUTE below minimum, using minimum", "value", n, "minimum", minRateLimitPerMinute)
			rateLimitPerMinute = minRateLimitPerMinute
		} else if n > maxRateLimitPerMinute {
			slog.Warn("FANOUT_RATE_LIMIT_PER_MINUTE above maximum, using maximum", "value", n, "maximum", maxRateLimitPerMinute)
			rateLimitPerMinute = maxRateLimitPerMinute
		} else {
			rateLimitPerMinute = n
		}
	}

	rateLimitFallback := FallbackAllow
	if v := os.Getenv("FANOUT_RATE_LIMIT_FALLBACK"); v != "" {
		switch strings.ToLower(v) {
		case "allow":
			rateLimitFallback = FallbackAllow
		case "block":
			rateLimitFallback = FallbackBlock
		case "warn":
			rateLimitFallback = FallbackWarn
		default:
			slog.Warn("Invalid FANOUT_RATE_LIMIT_FALLBACK value, using default", "value", v, "default", "allow")
		}
	}

	rateLimitEnabled := rateLimitPerMinute > 0

	slog.Info("Starting Fanout Service (two-stream: ID notify + message)", "nats_url", natsURL, "lru_capacity", lruCapacity, "workers", workerCount, "rate_limit_per_minute", rateLimitPerMinute)

	cache := newLRUCache(lruCapacity)
	sf := newSingleflight()

	// Track room types from room.changed deltas.
	// Key: room name, Value: "private", "dm", or "" (public).
	var roomTypesMu sync.RWMutex
	roomTypes := make(map[string]string)

	isPrivateRoom := func(room string) bool {
		roomTypesMu.RLock()
		defer roomTypesMu.RUnlock()
		return roomTypes[room] == "private"
	}

	// Crypto helpers for unpredictable notification IDs
	randomHex := func(n int) string {
		b := make([]byte, n)
		rand.Read(b)
		return hex.EncodeToString(b)
	}
	instanceId := randomHex(4)

	// Monotonic counter for unique notification IDs
	var notifySeq atomic.Int64

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

	// Create JetStream context and MSG_CACHE KV bucket for message content.
	// Browsers receive lightweight notifications (ID stream) and fetch full
	// content from this cache via msg.get request/reply (permission-checked).
	js, err := nc.JetStream()
	if err != nil {
		slog.Error("Failed to create JetStream context", "error", err)
		os.Exit(1)
	}
	msgCache, err := js.CreateKeyValue(&nats.KeyValueConfig{
		Bucket:  "MSG_CACHE",
		TTL:     5 * time.Minute,
		Storage: nats.MemoryStorage,
		History: 1,
	})
	if err != nil {
		slog.Error("Failed to create MSG_CACHE KV bucket", "error", err)
		os.Exit(1)
	}
	slog.Info("MSG_CACHE KV bucket ready", "ttl", "5m", "storage", "MemoryStorage")

	var rateLimitKV nats.KeyValue
	var rateLimitCB *CircuitBreaker
	if rateLimitEnabled {
		rateLimitKV, err = js.CreateKeyValue(&nats.KeyValueConfig{
			Bucket:  "RATE_LIMIT",
			TTL:     2 * time.Minute,
			Storage: nats.MemoryStorage,
			History: 1,
		})
		if err != nil {
			slog.Error("Failed to create RATE_LIMIT KV bucket", "error", err)
			os.Exit(1)
		}
		rateLimitCB = NewCircuitBreaker(5, 30)
		slog.Info("RATE_LIMIT KV bucket ready", "ttl", "2m", "limit_per_minute", rateLimitPerMinute, "fallback", rateLimitFallback)
	}

	// Register OTel gauge callbacks
	membershipGauge, _ := meter.Int64ObservableGauge("fanout_room_count",
		metric.WithDescription("Number of cached rooms"))
	membersGauge, _ := meter.Int64ObservableGauge("fanout_total_members",
		metric.WithDescription("Total cached room memberships"))
	circuitBreakerGauge, _ := meter.Int64ObservableGauge("fanout_rate_limit_circuit_breaker_state",
		metric.WithDescription("Rate limit circuit breaker state (0=closed, 1=open, 2=half-open)"))
	_, _ = meter.RegisterCallback(func(_ context.Context, o metric.Observer) error {
		o.ObserveInt64(membershipGauge, int64(cache.roomCount()))
		o.ObserveInt64(membersGauge, int64(cache.totalMembers()))
		if rateLimitCB != nil {
			var state int64
			switch rateLimitCB.State() {
			case CircuitBreakerClosed:
				state = 0
			case CircuitBreakerOpen:
				state = 1
			case CircuitBreakerHalfOpen:
				state = 2
			}
			o.ObserveInt64(circuitBreakerGauge, state)
		}
		return nil
	}, membershipGauge, membersGauge, circuitBreakerGauge)

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

	// checkMembership returns true if the user is a member of the room.
	checkMembership := func(ctx context.Context, room, userId string) bool {
		if member, cached := cache.isMember(room, userId); cached {
			return member
		}
		members := getMembers(ctx, room)
		if members == nil {
			return false // fail-closed: deny on RPC failure
		}
		for _, uid := range members {
			if uid == userId {
				return true
			}
		}
		return false
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

	// generateNotifyId creates a unique, unpredictable notification ID for the message cache key.
	// Includes instance ID (avoids collisions across instances) and a crypto-random token
	// (makes notifyIds a capability — knowing the ID is proof of authorization).
	generateNotifyId := func(room string) string {
		seq := notifySeq.Add(1)
		token := randomHex(8)
		return fmt.Sprintf("%s.%d.%s.%s", room, seq, instanceId, token)
	}

	checkRateLimit := func(ctx context.Context, userId string) (allowed bool, err error) {
		if !rateLimitEnabled || rateLimitKV == nil {
			return true, nil
		}

		if rateLimitCB != nil && !rateLimitCB.Allow() {
			rateLimitKVFailures.Add(ctx, 1, metric.WithAttributes(
				attribute.String("user", userId),
				attribute.String("state", "circuit_breaker_open"),
			))
			switch rateLimitFallback {
			case FallbackBlock:
				return false, fmt.Errorf("rate limiting unavailable (circuit breaker open)")
			case FallbackWarn:
				slog.Warn("Rate limiting unavailable, allowing message (fallback=warn)", "user", userId)
				return true, nil
			default:
				return true, nil
			}
		}

		window := time.Now().Unix() / 60
		key := fmt.Sprintf("%s.%d", userId, window)

		entry, err := rateLimitKV.Get(key)
		if err != nil {
			if err == nats.ErrKeyNotFound {
				_, createErr := rateLimitKV.Create(key, []byte("1"))
				if createErr != nil {
					if rateLimitCB != nil {
						rateLimitCB.RecordFailure()
					}
					rateLimitErrorCounter.Add(ctx, 1, metric.WithAttributes(
						attribute.String("user", userId),
						attribute.String("operation", "create"),
					))
					slog.Warn("Rate limit create failed", "user", userId, "error", createErr)
					switch rateLimitFallback {
					case FallbackBlock:
						return false, createErr
					case FallbackWarn:
						slog.Warn("Rate limiting KV error, allowing message (fallback=warn)", "user", userId)
						return true, nil
					default:
						return true, nil
					}
				}
				if rateLimitCB != nil {
					rateLimitCB.RecordSuccess()
				}
				return true, nil
			}

			if rateLimitCB != nil {
				rateLimitCB.RecordFailure()
			}
			rateLimitErrorCounter.Add(ctx, 1, metric.WithAttributes(
				attribute.String("user", userId),
				attribute.String("operation", "get"),
			))
			slog.Warn("Rate limit get failed", "user", userId, "error", err)
			switch rateLimitFallback {
			case FallbackBlock:
				return false, err
			case FallbackWarn:
				slog.Warn("Rate limiting KV error, allowing message (fallback=warn)", "user", userId)
				return true, nil
			default:
				return true, nil
			}
		}

		count, _ := strconv.Atoi(string(entry.Value()))
		if count >= rateLimitPerMinute {
			if rateLimitCB != nil {
				rateLimitCB.RecordSuccess()
			}
			return false, nil
		}

		_, updateErr := rateLimitKV.Update(key, []byte(strconv.Itoa(count+1)), entry.Revision())
		if updateErr != nil {
			if rateLimitCB != nil {
				rateLimitCB.RecordFailure()
			}
			rateLimitErrorCounter.Add(ctx, 1, metric.WithAttributes(
				attribute.String("user", userId),
				attribute.String("operation", "update"),
			))
			slog.Warn("Rate limit update failed", "user", userId, "error", updateErr)
			switch rateLimitFallback {
			case FallbackBlock:
				return false, updateErr
			case FallbackWarn:
				slog.Warn("Rate limiting KV error, allowing message (fallback=warn)", "user", userId)
				return true, nil
			default:
				return true, nil
			}
		}

		if rateLimitCB != nil {
			rateLimitCB.RecordSuccess()
		}
		return true, nil
	}

	// Subscribe to room.changed.* (no QG) — apply deltas to LRU cache
	_, err = nc.Subscribe("room.changed.*", func(msg *nats.Msg) {
		var evt RoomChangedEvent
		if err := json.Unmarshal(msg.Data, &evt); err != nil {
			slog.Warn("Invalid room.changed event", "error", err)
			return
		}
		// Track room type from delta events (private rooms use per-user delivery)
		if evt.Type != "" {
			roomTypesMu.Lock()
			roomTypes[evt.Room] = evt.Type
			roomTypesMu.Unlock()
		}
		if cache.applyDelta(evt.Room, evt.Action, evt.UserId) {
			slog.Debug("Applied delta to LRU cache", "room", evt.Room, "action", evt.Action, "user", evt.UserId)
		}
	})
	if err != nil {
		slog.Error("Failed to subscribe to room.changed.*", "error", err)
		os.Exit(1)
	}

	// ──────────────────────────────────────────────────────────────
	// INGEST: deliver.*.send.> — user messages enter the system here.
	// Users publish to deliver.{userId}.send.{room}[.thread.{threadId}].
	// This handler validates sender + membership, then publishes the
	// full message to the chat.{room} message stream (JetStream).
	// ──────────────────────────────────────────────────────────────
	_, err = nc.QueueSubscribe("deliver.*.send.>", "fanout-workers", func(msg *nats.Msg) {
		// Parse subject: deliver.{userId}.send.{room}[.thread.{threadId}]
		parts := strings.Split(msg.Subject, ".")
		if len(parts) < 4 {
			return
		}
		userId := parts[1]
		// Reconstruct the chat subject from parts[3:] → chat.{room}[.thread.{threadId}]
		chatSubject := "chat." + strings.Join(parts[3:], ".")
		room := parts[3]

		ctx, span := otelhelper.StartConsumerSpan(context.Background(), msg, "ingest user message")
		defer span.End()
		span.SetAttributes(
			attribute.String("ingest.user", userId),
			attribute.String("ingest.room", room),
			attribute.String("ingest.chat_subject", chatSubject),
		)

		// Rate limit check (per-user, sliding window)
		allowed, rateLimitErr := checkRateLimit(ctx, userId)
		if !allowed {
			rateLimitCounter.Add(ctx, 1, metric.WithAttributes(
				attribute.String("user", userId),
				attribute.String("room", room),
			))
			if rateLimitErr != nil {
				slog.Warn("Rate limit check failed", "user", userId, "room", room, "error", rateLimitErr)
			} else {
				slog.Warn("Rate limited", "user", userId, "room", room, "limit", rateLimitPerMinute)
			}
			span.SetAttributes(attribute.Bool("ingest.rate_limited", true))
			return
		}

		// Validate sender matches the scoped deliver subject (anti-impersonation)
		var payload chatPayload
		if err := json.Unmarshal(msg.Data, &payload); err != nil {
			slog.Warn("Invalid ingest payload", "error", err)
			return
		}
		if payload.User != "" && payload.User != userId {
			rejectCounter.Add(ctx, 1, metric.WithAttributes(
				attribute.String("room", room),
				attribute.String("user", payload.User),
			))
			slog.Warn("Rejected ingest: sender mismatch", "subject_user", userId, "payload_user", payload.User)
			span.SetAttributes(attribute.Bool("ingest.rejected", true))
			return
		}

		// Validate membership (skip for __system__ messages)
		if payload.User != "__system__" && !checkMembership(ctx, room, userId) {
			rejectCounter.Add(ctx, 1, metric.WithAttributes(
				attribute.String("room", room),
				attribute.String("user", userId),
			))
			slog.Warn("Rejected ingest: non-member", "user", userId, "room", room)
			span.SetAttributes(attribute.Bool("ingest.rejected", true))
			return
		}

		// Publish full message to the chat stream (JetStream captures for persist-worker)
		otelhelper.TracedPublish(ctx, nc, chatSubject, msg.Data)
		slog.Debug("Ingested user message", "user", userId, "room", room, "chat_subject", chatSubject)
	})
	if err != nil {
		slog.Error("Failed to subscribe to deliver.*.send.>", "error", err)
		os.Exit(1)
	}

	// ──────────────────────────────────────────────────────────────
	// NOTIFY: chat.> — all messages (user + backend) arrive here via
	// JetStream. This handler stores the full message in MSG_CACHE KV
	// and publishes a lightweight notification to the ID stream.
	// ──────────────────────────────────────────────────────────────
	_, err = nc.QueueSubscribe("chat.>", "fanout-workers", func(msg *nats.Msg) {
		if strings.HasPrefix(msg.Subject, "chat.history") {
			return
		}

		ctx, span := otelhelper.StartConsumerSpan(context.Background(), msg, "fanout notify")
		defer span.End()

		start := time.Now()

		remainder := strings.TrimPrefix(msg.Subject, "chat.")
		room := remainder
		isThread := false
		threadId := ""
		if idx := strings.Index(remainder, "."); idx != -1 {
			room = remainder[:idx]
			if strings.Contains(remainder, ".thread.") {
				isThread = true
				threadId = remainder[strings.Index(remainder, ".thread.")+len(".thread."):]
			}
		}

		// Extract metadata for the notification
		var payload chatPayload
		json.Unmarshal(msg.Data, &payload)
		action := payload.Action
		if action == "" {
			action = "message"
		}

		// Generate a unique notifyId and store full message in KV cache
		notifyId := generateNotifyId(room)
		if _, err := msgCache.Put(notifyId, msg.Data); err != nil {
			slog.Warn("Failed to cache message in MSG_CACHE", "notifyId", notifyId, "error", err)
			// Continue anyway — notification still goes out; client fetch will miss
		}

		// Build the notification (never contains message text)
		notification := chatNotification{
			NotifyId:   notifyId,
			Room:       room,
			Action:     action,
			User:       payload.User,
			Timestamp:  payload.Timestamp,
			ThreadId:   threadId,
			Emoji:      payload.Emoji,
			TargetUser: payload.TargetUser,
		}
		notifyData, _ := json.Marshal(notification)

		isDM := strings.HasPrefix(room, "dm-")
		isPrivate := isPrivateRoom(room)

		if isDM || isPrivate {
			// DM + private rooms: per-user notification delivery (hides metadata from non-participants)
			members := getMembers(ctx, room)
			span.SetAttributes(
				attribute.String("chat.room", room),
				attribute.Int("fanout.member_count", len(members)),
				attribute.Bool("fanout.dm", isDM),
				attribute.Bool("fanout.private", isPrivate),
			)
			if len(members) > 0 {
				enqueueFanout(ctx, members, "notify."+room, notifyData)
			}
			duration := time.Since(start).Seconds()
			fanoutCounter.Add(ctx, int64(len(members)), metric.WithAttributes(attribute.String("room", room)))
			fanoutDuration.Record(ctx, duration, metric.WithAttributes(attribute.String("room", room)))
		} else {
			// Public rooms: multicast notification to room.notify.{room}
			// Content is NOT in the notification — browsers fetch via msg.get.
			// NotifyIds are unpredictable (capability-based access to msg.get).
			otelhelper.TracedPublish(ctx, nc, "room.notify."+room, notifyData)
			span.SetAttributes(
				attribute.String("chat.room", room),
				attribute.String("fanout.target", "room.notify."+room),
				attribute.Bool("fanout.thread", isThread),
			)
			duration := time.Since(start).Seconds()
			fanoutCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("room", room)))
			fanoutDuration.Record(ctx, duration, metric.WithAttributes(attribute.String("room", room)))
		}
		notifyCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("room", room)))
	})
	if err != nil {
		slog.Error("Failed to subscribe to chat.>", "error", err)
		os.Exit(1)
	}

	// ──────────────────────────────────────────────────────────────
	// FETCH: msg.get — request/reply to get full message content.
	// Capability-based: knowing the unpredictable notifyId IS the
	// authorization. NotifyIds contain crypto-random tokens, so only
	// notification recipients (room members) can fetch content.
	// ──────────────────────────────────────────────────────────────
	_, err = nc.QueueSubscribe("msg.get", "msg-get-workers", func(msg *nats.Msg) {
		if msg.Reply == "" {
			return
		}

		ctx, span := otelhelper.StartServerSpan(context.Background(), msg, "msg.get")
		defer span.End()

		var req struct {
			NotifyId string `json:"notifyId"`
			Room     string `json:"room"` // optional, for metrics/tracing only
		}
		if err := json.Unmarshal(msg.Data, &req); err != nil {
			msg.Respond([]byte(`{"error":"invalid request"}`))
			return
		}
		span.SetAttributes(
			attribute.String("fetch.notifyId", req.NotifyId),
			attribute.String("fetch.room", req.Room),
		)

		fetchCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("room", req.Room)))

		// Look up message in KV cache
		entry, err := msgCache.Get(req.NotifyId)
		if err != nil {
			msg.Respond([]byte(`{"error":"not_found"}`))
			span.SetAttributes(attribute.Bool("fetch.not_found", true))
			return
		}

		msg.Respond(entry.Value())
	})
	if err != nil {
		slog.Error("Failed to subscribe to msg.get", "error", err)
		os.Exit(1)
	}

	// Subscribe to admin messages via queue group (unchanged — per-user delivery of full content)
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

	// Presence diffs now publish directly to room.presence.{room} (NATS multicast).
	// No fanout needed — clients subscribe to room.presence.{room} per joined room.

	// Subscribe to app messages for room fanout (pub/sub broadcasts only)
	_, err = nc.QueueSubscribe("app.>", "fanout-workers", func(msg *nats.Msg) {
		// Parse subject: app.{appId}.{room}.{action...}
		parts := strings.Split(msg.Subject, ".")
		if len(parts) < 4 {
			return
		}
		room := parts[2]

		// Skip request/reply — NATS handles those directly via _INBOX
		if msg.Reply != "" {
			return
		}

		ctx, span := otelhelper.StartConsumerSpan(context.Background(), msg, "fanout app message")
		defer span.End()

		start := time.Now()

		members := getMembers(ctx, room)
		span.SetAttributes(
			attribute.String("app.subject", msg.Subject),
			attribute.String("app.room", room),
			attribute.Int("fanout.member_count", len(members)),
		)

		if len(members) > 0 {
			enqueueFanout(ctx, members, msg.Subject, msg.Data)
		}

		duration := time.Since(start).Seconds()
		fanoutCounter.Add(ctx, int64(len(members)), metric.WithAttributes(
			attribute.String("room", "app."+room),
		))
		fanoutDuration.Record(ctx, duration, metric.WithAttributes(
			attribute.String("room", "app."+room),
		))
	})
	if err != nil {
		slog.Error("Failed to subscribe to app.>", "error", err)
		os.Exit(1)
	}

	slog.Info("Fanout service ready — two-stream model: deliver.*.send.> (ingest), chat.> (notify), msg.get (fetch), admin.*, app.>, room.changed.*")

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
