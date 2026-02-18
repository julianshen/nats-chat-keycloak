package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/XSAM/otelsql"
	otelhelper "github.com/example/nats-chat-otelhelper"
	_ "github.com/lib/pq"
	"github.com/nats-io/nats.go"
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
	ReplyCount      int    `json:"replyCount,omitempty"`
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

	meter := otel.Meter("history-service")
	requestCounter, _ := meter.Int64Counter("history_requests_total")
	requestDuration, _ := meter.Float64Histogram("history_request_duration_seconds")

	natsURL := envOrDefault("NATS_URL", "nats://localhost:4222")
	natsUser := envOrDefault("NATS_USER", "history-service")
	natsPass := envOrDefault("NATS_PASS", "history-service-secret")
	dbURL := envOrDefault("DATABASE_URL", "postgres://chat:chat-secret@localhost:5432/chatdb?sslmode=disable")

	slog.Info("Starting History Service")

	// Connect to PostgreSQL with otelsql
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
			nats.Name("history-service"),
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

	// Prepare query statement
	queryStmt, err := db.Prepare(
		`SELECT m.room, m.username, m.text, m.timestamp, m.thread_id,
		        COALESCE((SELECT COUNT(*) FROM messages t WHERE t.thread_id = m.room || '-' || m.timestamp::text), 0) AS reply_count
		 FROM messages m
		 WHERE m.room = $1 AND m.thread_id IS NULL
		 ORDER BY m.timestamp DESC LIMIT 50`,
	)
	if err != nil {
		slog.Error("Failed to prepare query", "error", err)
		os.Exit(1)
	}
	defer queryStmt.Close()

	// Subscribe to history requests with tracing
	_, err = nc.Subscribe("chat.history.*", func(msg *nats.Msg) {
		start := time.Now()
		ctx, span := otelhelper.StartServerSpan(context.Background(), msg, "history request")
		defer span.End()

		parts := strings.Split(msg.Subject, ".")
		if len(parts) < 3 {
			msg.Respond([]byte("[]"))
			return
		}
		room := parts[2]
		span.SetAttributes(attribute.String("chat.room", room))

		rows, err := queryStmt.QueryContext(ctx, room)
		if err != nil {
			slog.ErrorContext(ctx, "Query failed", "room", room, "error", err)
			span.RecordError(err)
			msg.Respond([]byte("[]"))
			return
		}
		defer rows.Close()

		var messages []ChatMessage
		for rows.Next() {
			var m ChatMessage
			var threadId sql.NullString
			var replyCount int
			if err := rows.Scan(&m.Room, &m.User, &m.Text, &m.Timestamp, &threadId, &replyCount); err != nil {
				slog.WarnContext(ctx, "Failed to scan row", "error", err)
				continue
			}
			if threadId.Valid {
				m.ThreadId = threadId.String
			}
			m.ReplyCount = replyCount
			messages = append(messages, m)
		}

		// Reverse to chronological order (query was DESC)
		for i, j := 0, len(messages)-1; i < j; i, j = i+1, j-1 {
			messages[i], messages[j] = messages[j], messages[i]
		}

		if messages == nil {
			messages = []ChatMessage{}
		}

		data, err := json.Marshal(messages)
		if err != nil {
			slog.ErrorContext(ctx, "Failed to marshal history", "error", err)
			span.RecordError(err)
			msg.Respond([]byte("[]"))
			return
		}

		msg.Respond(data)

		duration := time.Since(start).Seconds()
		attrs := metric.WithAttributes(attribute.String("room", room))
		requestCounter.Add(ctx, 1, attrs)
		requestDuration.Record(ctx, duration, attrs)

		span.SetAttributes(attribute.Int("history.message_count", len(messages)))
		slog.InfoContext(ctx, "Served history", "room", room, "count", len(messages), "duration_ms", time.Since(start).Milliseconds())
	})
	if err != nil {
		slog.Error("Failed to subscribe", "error", err)
		os.Exit(1)
	}
	slog.Info("Subscribed to chat.history.* — ready to serve history requests")

	// Prepare thread query statement
	threadQueryStmt, err := db.Prepare(
		`SELECT room, username, text, timestamp, thread_id, parent_timestamp
		 FROM messages
		 WHERE thread_id = $1
		 ORDER BY timestamp ASC LIMIT 200`,
	)
	if err != nil {
		slog.Error("Failed to prepare thread query", "error", err)
		os.Exit(1)
	}
	defer threadQueryStmt.Close()

	// Subscribe to thread history requests: chat.history.{room}.thread.{threadId}
	_, err = nc.Subscribe("chat.history.*.thread.*", func(msg *nats.Msg) {
		start := time.Now()
		ctx, span := otelhelper.StartServerSpan(context.Background(), msg, "thread history request")
		defer span.End()

		parts := strings.Split(msg.Subject, ".")
		if len(parts) < 5 {
			msg.Respond([]byte("[]"))
			return
		}
		threadId := parts[4]
		span.SetAttributes(attribute.String("chat.threadId", threadId))

		rows, err := threadQueryStmt.QueryContext(ctx, threadId)
		if err != nil {
			slog.ErrorContext(ctx, "Thread query failed", "threadId", threadId, "error", err)
			span.RecordError(err)
			msg.Respond([]byte("[]"))
			return
		}
		defer rows.Close()

		var messages []ChatMessage
		for rows.Next() {
			var m ChatMessage
			var tid sql.NullString
			var pts sql.NullInt64
			if err := rows.Scan(&m.Room, &m.User, &m.Text, &m.Timestamp, &tid, &pts); err != nil {
				slog.WarnContext(ctx, "Failed to scan thread row", "error", err)
				continue
			}
			if tid.Valid {
				m.ThreadId = tid.String
			}
			if pts.Valid {
				m.ParentTimestamp = pts.Int64
			}
			messages = append(messages, m)
		}

		if messages == nil {
			messages = []ChatMessage{}
		}

		data, err := json.Marshal(messages)
		if err != nil {
			slog.ErrorContext(ctx, "Failed to marshal thread history", "error", err)
			span.RecordError(err)
			msg.Respond([]byte("[]"))
			return
		}

		msg.Respond(data)

		duration := time.Since(start).Seconds()
		attrs := metric.WithAttributes(attribute.String("threadId", threadId))
		requestCounter.Add(ctx, 1, attrs)
		requestDuration.Record(ctx, duration, attrs)

		span.SetAttributes(attribute.Int("history.message_count", len(messages)))
		slog.InfoContext(ctx, "Served thread history", "threadId", threadId, "count", len(messages), "duration_ms", time.Since(start).Milliseconds())
	})
	if err != nil {
		slog.Error("Failed to subscribe to thread history", "error", err)
		os.Exit(1)
	}
	slog.Info("Subscribed to chat.history.*.thread.* — ready to serve thread history requests")

	// Wait for shutdown
	sigCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	<-sigCtx.Done()

	slog.Info("Shutting down history service")
	nc.Drain()
}
