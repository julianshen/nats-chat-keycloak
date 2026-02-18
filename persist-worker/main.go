package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/XSAM/otelsql"
	otelhelper "github.com/example/nats-chat-otelhelper"
	_ "github.com/lib/pq"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
)

type ChatMessage struct {
	User            string `json:"user"`
	Text            string `json:"text"`
	Timestamp       int64  `json:"timestamp"`
	Room            string `json:"room"`
	ThreadId        string `json:"threadId,omitempty"`
	ParentTimestamp int64  `json:"parentTimestamp,omitempty"`
	Broadcast       bool   `json:"broadcast,omitempty"`
}

func envOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func nullableString(s string) interface{} {
	if s == "" {
		return nil
	}
	return s
}

func nullableInt64(n int64) interface{} {
	if n == 0 {
		return nil
	}
	return n
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

	meter := otel.Meter("persist-worker")
	persistedCounter, _ := meter.Int64Counter("messages_persisted_total")
	errorCounter, _ := meter.Int64Counter("messages_persist_errors_total")

	natsURL := envOrDefault("NATS_URL", "nats://localhost:4222")
	natsUser := envOrDefault("NATS_USER", "persist-worker")
	natsPass := envOrDefault("NATS_PASS", "persist-worker-secret")
	dbURL := envOrDefault("DATABASE_URL", "postgres://chat:chat-secret@localhost:5432/chatdb?sslmode=disable")

	slog.Info("Starting Persist Worker", "nats_url", natsURL)

	// Connect to PostgreSQL with otelsql for automatic query tracing
	db, err := otelsql.Open("postgres", dbURL,
		otelsql.WithAttributes(semconv.DBSystemPostgreSQL),
	)
	if err != nil {
		slog.Error("Failed to open database", "error", err)
		os.Exit(1)
	}
	for attempt := 1; attempt <= 30; attempt++ {
		err = db.Ping()
		if err == nil {
			break
		}
		slog.Info("Waiting for PostgreSQL", "attempt", attempt, "error", err)
		time.Sleep(2 * time.Second)
	}
	if err != nil {
		slog.Error("Failed to connect to PostgreSQL", "error", err)
		os.Exit(1)
	}
	defer db.Close()
	slog.Info("Connected to PostgreSQL")

	// Connect to NATS with retry
	var nc *nats.Conn
	for attempt := 1; attempt <= 30; attempt++ {
		nc, err = nats.Connect(natsURL,
			nats.UserInfo(natsUser, natsPass),
			nats.Name("persist-worker"),
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

	// Create JetStream context
	js, err := jetstream.New(nc)
	if err != nil {
		slog.Error("Failed to create JetStream context", "error", err)
		os.Exit(1)
	}

	// Ensure stream exists
	_, err = js.CreateOrUpdateStream(ctx, jetstream.StreamConfig{
		Name:      "CHAT_MESSAGES",
		Subjects:  []string{"chat.*", "chat.*.thread.*", "admin.*"},
		Retention: jetstream.LimitsPolicy,
		MaxMsgs:   10000,
		MaxAge:    7 * 24 * time.Hour,
		Storage:   jetstream.FileStorage,
	})
	if err != nil {
		slog.Error("Failed to create/update stream", "error", err)
		os.Exit(1)
	}
	slog.Info("JetStream stream CHAT_MESSAGES ready")

	// Create durable consumer
	stream, err := js.Stream(ctx, "CHAT_MESSAGES")
	if err != nil {
		slog.Error("Failed to get stream", "error", err)
		os.Exit(1)
	}

	cons, err := stream.CreateOrUpdateConsumer(ctx, jetstream.ConsumerConfig{
		Durable:       "persist-worker",
		AckPolicy:     jetstream.AckExplicitPolicy,
		DeliverPolicy: jetstream.DeliverAllPolicy,
	})
	if err != nil {
		slog.Error("Failed to create consumer", "error", err)
		os.Exit(1)
	}
	slog.Info("JetStream consumer ready", "name", "persist-worker")

	// Prepare insert statement
	insertStmt, err := db.Prepare(
		"INSERT INTO messages (room, username, text, timestamp, thread_id, parent_timestamp, broadcast) VALUES ($1, $2, $3, $4, $5, $6, $7)",
	)
	if err != nil {
		slog.Error("Failed to prepare insert statement", "error", err)
		os.Exit(1)
	}
	defer insertStmt.Close()

	// Consume messages with tracing
	cc, err := cons.Consume(func(msg jetstream.Msg) {
		// Extract trace context from JetStream message headers and start span
		natsMsg := &nats.Msg{
			Subject: msg.Subject(),
			Data:    msg.Data(),
			Header:  msg.Headers(),
		}
		ctx, span := otelhelper.StartConsumerSpan(context.Background(), natsMsg, "persist message")
		defer span.End()

		var chatMsg ChatMessage
		if err := json.Unmarshal(msg.Data(), &chatMsg); err != nil {
			slog.WarnContext(ctx, "Failed to unmarshal message", "error", err)
			span.RecordError(err)
			msg.Ack()
			return
		}

		if chatMsg.Room == "" {
			chatMsg.Room = msg.Subject()
		}

		span.SetAttributes(
			attribute.String("chat.room", chatMsg.Room),
			attribute.String("chat.user", chatMsg.User),
		)

		_, err := insertStmt.ExecContext(ctx, chatMsg.Room, chatMsg.User, chatMsg.Text, chatMsg.Timestamp, nullableString(chatMsg.ThreadId), nullableInt64(chatMsg.ParentTimestamp), chatMsg.Broadcast)
		if err != nil {
			slog.ErrorContext(ctx, "Failed to insert message", "error", err, "room", chatMsg.Room)
			span.RecordError(err)
			errorCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("room", chatMsg.Room)))
			msg.Nak()
			return
		}

		persistedCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("room", chatMsg.Room)))
		msg.Ack()
	})
	if err != nil {
		slog.Error("Failed to start consumer", "error", err)
		os.Exit(1)
	}
	defer cc.Stop()

	slog.Info("Consuming messages from CHAT_MESSAGES stream")

	// Wait for shutdown
	sigCtx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()
	<-sigCtx.Done()

	slog.Info("Shutting down persist worker")
}
