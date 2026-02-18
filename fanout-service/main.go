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

func (m *membership) roomCount() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.rooms)
}

func (m *membership) totalMembers() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	total := 0
	for _, members := range m.rooms {
		total += len(members)
	}
	return total
}

// MembershipEvent is the payload for room.join.* and room.leave.* messages.
type MembershipEvent struct {
	UserId string `json:"userId"`
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
	membershipGauge, _ := meter.Int64ObservableGauge("fanout_room_count",
		metric.WithDescription("Number of active rooms"))
	membersGauge, _ := meter.Int64ObservableGauge("fanout_total_members",
		metric.WithDescription("Total room memberships"))

	natsURL := envOrDefault("NATS_URL", "nats://localhost:4222")
	natsUser := envOrDefault("NATS_USER", "fanout-service")
	natsPass := envOrDefault("NATS_PASS", "fanout-service-secret")

	slog.Info("Starting Fanout Service", "nats_url", natsURL)

	// Connect to NATS with retry
	var nc *nats.Conn
	for attempt := 1; attempt <= 30; attempt++ {
		nc, err = nats.Connect(natsURL,
			nats.UserInfo(natsUser, natsPass),
			nats.Name("fanout-service"),
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

	mem := newMembership()

	// Register OTel gauge callbacks
	_, _ = meter.RegisterCallback(func(_ context.Context, o metric.Observer) error {
		o.ObserveInt64(membershipGauge, int64(mem.roomCount()))
		o.ObserveInt64(membersGauge, int64(mem.totalMembers()))
		return nil
	}, membershipGauge, membersGauge)

	// Subscribe to membership events (no queue group — all instances need full state)
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
			slog.Warn("Invalid leave event", "error", err)
			return
		}

		mem.leave(room, evt.UserId)
		slog.Debug("User left room", "user", evt.UserId, "room", room)
	})
	if err != nil {
		slog.Error("Failed to subscribe to room.leave.*", "error", err)
		os.Exit(1)
	}

	// Subscribe to chat messages via queue group (load-balanced across instances)
	_, err = nc.QueueSubscribe("chat.*", "fanout-workers", func(msg *nats.Msg) {
		// Skip history requests (chat.history.* won't match chat.* anyway, but be safe)
		if strings.HasPrefix(msg.Subject, "chat.history") {
			return
		}

		ctx, span := otelhelper.StartConsumerSpan(context.Background(), msg, "fanout chat message")
		defer span.End()

		start := time.Now()
		room := strings.TrimPrefix(msg.Subject, "chat.")

		members := mem.members(room)
		span.SetAttributes(
			attribute.String("chat.room", room),
			attribute.Int("fanout.member_count", len(members)),
		)

		for _, userId := range members {
			deliverSubject := "deliver." + userId + "." + msg.Subject
			otelhelper.TracedPublish(ctx, nc, deliverSubject, msg.Data)
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
		slog.Error("Failed to subscribe to chat.*", "error", err)
		os.Exit(1)
	}

	// Subscribe to admin messages via same queue group
	_, err = nc.QueueSubscribe("admin.*", "fanout-workers", func(msg *nats.Msg) {
		ctx, span := otelhelper.StartConsumerSpan(context.Background(), msg, "fanout admin message")
		defer span.End()

		start := time.Now()
		room := strings.TrimPrefix(msg.Subject, "admin.")

		// Admin rooms use "admin.{room}" as the membership key
		memberKey := "__admin__" + room
		members := mem.members(memberKey)
		span.SetAttributes(
			attribute.String("chat.room", "admin."+room),
			attribute.Int("fanout.member_count", len(members)),
		)

		for _, userId := range members {
			deliverSubject := "deliver." + userId + "." + msg.Subject
			otelhelper.TracedPublish(ctx, nc, deliverSubject, msg.Data)
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

	slog.Info("Fanout service ready — listening for chat.*, admin.*, room.join.*, room.leave.*")

	// Wait for shutdown
	sigCtx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()
	<-sigCtx.Done()

	slog.Info("Shutting down fanout service")
	nc.Drain()
}
