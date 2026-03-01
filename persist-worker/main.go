package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
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
	"go.opentelemetry.io/otel/trace"
)

type ChatMessage struct {
	User            string `json:"user"`
	Text            string `json:"text"`
	Timestamp       int64  `json:"timestamp"`
	Room            string `json:"room"`
	ThreadId        string `json:"threadId,omitempty"`
	ParentTimestamp int64  `json:"parentTimestamp,omitempty"`
	Broadcast       bool   `json:"broadcast,omitempty"`
	Action          string `json:"action,omitempty"`
	Emoji           string `json:"emoji,omitempty"`
	TargetUser      string `json:"targetUser,omitempty"`
	StickerURL      string `json:"stickerUrl,omitempty"`
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

func generateInstanceID() string {
	b := make([]byte, 4)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func main() {
	ctx := context.Background()

	instanceID := generateInstanceID()

	otelShutdown, err := otelhelper.Init(ctx)
	if err != nil {
		slog.Error("Failed to initialize OpenTelemetry", "error", err)
		os.Exit(1)
	}
	defer otelShutdown(ctx)

	meter := otel.Meter("persist-worker")
	persistedCounter, _ := meter.Int64Counter("messages_persisted_total")
	errorCounter, _ := meter.Int64Counter("messages_persist_errors_total")
	editedCounter, _ := meter.Int64Counter("messages_edited_total")
	deletedCounter, _ := meter.Int64Counter("messages_deleted_total")
	reactedCounter, _ := meter.Int64Counter("reactions_toggled_total")
	instanceGauge, _ := meter.Int64ObservableGauge("persist_worker_instance",
		metric.WithDescription("Persist worker instance identifier"))
	_, _ = meter.RegisterCallback(func(_ context.Context, o metric.Observer) error {
		o.ObserveInt64(instanceGauge, 1, metric.WithAttributes(
			attribute.String("instance_id", instanceID),
		))
		return nil
	}, instanceGauge)

	natsURL := envOrDefault("NATS_URL", "nats://localhost:4222")
	natsUser := envOrDefault("NATS_USER", "persist-worker")
	natsPass := envOrDefault("NATS_PASS", "persist-worker-secret")
	dbURL := envOrDefault("DATABASE_URL", "postgres://chat:chat-secret@localhost:5432/chatdb?sslmode=disable")

	slog.Info("Starting Persist Worker", "nats_url", natsURL, "instance_id", instanceID)

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
		Subjects:  []string{"chat.*", "chat.*.thread.*"},
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
	slog.Info("JetStream consumer ready", "name", "persist-worker", "instance_id", instanceID, "note", "multiple instances can share this consumer for horizontal scaling")

	// Prepare insert statement
	insertStmt, err := db.Prepare(
		"INSERT INTO messages (room, username, text, timestamp, thread_id, parent_timestamp, broadcast, sticker_url) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
	)
	if err != nil {
		slog.Error("Failed to prepare insert statement", "error", err)
		os.Exit(1)
	}
	defer insertStmt.Close()

	// Prepare soft-delete statement
	softDeleteStmt, err := db.Prepare(
		"UPDATE messages SET is_deleted = TRUE WHERE room = $1 AND timestamp = $2 AND username = $3 AND is_deleted = FALSE",
	)
	if err != nil {
		slog.Error("Failed to prepare soft-delete statement", "error", err)
		os.Exit(1)
	}
	defer softDeleteStmt.Close()

	// Prepare edit statement (update text + edited_at)
	editStmt, err := db.Prepare(
		"UPDATE messages SET text = $1, edited_at = $2 WHERE room = $3 AND timestamp = $4 AND username = $5 AND is_deleted = FALSE",
	)
	if err != nil {
		slog.Error("Failed to prepare edit statement", "error", err)
		os.Exit(1)
	}
	defer editStmt.Close()

	// Prepare save-version statement
	saveVersionStmt, err := db.Prepare(
		"INSERT INTO message_versions (room, message_timestamp, text, edited_at) SELECT room, timestamp, text, $1 FROM messages WHERE room = $2 AND timestamp = $3 AND username = $4 AND is_deleted = FALSE",
	)
	if err != nil {
		slog.Error("Failed to prepare save-version statement", "error", err)
		os.Exit(1)
	}
	defer saveVersionStmt.Close()

	// Prepare trim-versions statement (keep only 5 most recent)
	trimVersionsStmt, err := db.Prepare(
		`DELETE FROM message_versions WHERE room = $1 AND message_timestamp = $2 AND id NOT IN (
			SELECT id FROM message_versions WHERE room = $1 AND message_timestamp = $2 ORDER BY edited_at DESC LIMIT 5
		)`,
	)
	if err != nil {
		slog.Error("Failed to prepare trim-versions statement", "error", err)
		os.Exit(1)
	}
	defer trimVersionsStmt.Close()

	// Prepare reaction insert statement (toggle: try insert, if 0 rows then delete)
	insertReactionStmt, err := db.Prepare(
		"INSERT INTO message_reactions (room, message_timestamp, user_id, emoji) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
	)
	if err != nil {
		slog.Error("Failed to prepare insert-reaction statement", "error", err)
		os.Exit(1)
	}
	defer insertReactionStmt.Close()

	deleteReactionStmt, err := db.Prepare(
		"DELETE FROM message_reactions WHERE room = $1 AND message_timestamp = $2 AND user_id = $3 AND emoji = $4",
	)
	if err != nil {
		slog.Error("Failed to prepare delete-reaction statement", "error", err)
		os.Exit(1)
	}
	defer deleteReactionStmt.Close()

	// Consume messages with tracing
	cc, err := cons.Consume(func(msg jetstream.Msg) {
		// Skip non-message subjects (e.g. chat.dms is a request-reply endpoint, not a chat message)
		if msg.Subject() == "chat.dms" {
			msg.Ack()
			return
		}

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
			attribute.String("chat.action", chatMsg.Action),
		)

		roomAttr := metric.WithAttributes(attribute.String("room", chatMsg.Room))

		switch chatMsg.Action {
		case "delete":
			_, err := softDeleteStmt.ExecContext(ctx, chatMsg.Room, chatMsg.Timestamp, chatMsg.User)
			if err != nil {
				slog.ErrorContext(ctx, "Failed to soft-delete message", "error", err, "room", chatMsg.Room)
				span.RecordError(err)
				errorCounter.Add(ctx, 1, roomAttr)
				msg.Nak()
				return
			}
			span.AddEvent("message_deleted", trace.WithAttributes(
				attribute.String("chat.room", chatMsg.Room),
				attribute.String("chat.user", chatMsg.User),
			))
			deletedCounter.Add(ctx, 1, roomAttr)

		case "edit":
			tx, err := db.BeginTx(ctx, nil)
			if err != nil {
				slog.ErrorContext(ctx, "Failed to begin tx for edit", "error", err)
				span.RecordError(err)
				errorCounter.Add(ctx, 1, roomAttr)
				msg.Nak()
				return
			}

			editedAt := time.Now().UnixMilli()

			// Save current text as a version before overwriting
			if _, err := tx.StmtContext(ctx, saveVersionStmt).ExecContext(ctx, editedAt, chatMsg.Room, chatMsg.Timestamp, chatMsg.User); err != nil {
				tx.Rollback()
				slog.ErrorContext(ctx, "Failed to save version", "error", err, "room", chatMsg.Room)
				span.RecordError(err)
				errorCounter.Add(ctx, 1, roomAttr)
				msg.Nak()
				return
			}

			// Update the message text
			if _, err := tx.StmtContext(ctx, editStmt).ExecContext(ctx, chatMsg.Text, editedAt, chatMsg.Room, chatMsg.Timestamp, chatMsg.User); err != nil {
				tx.Rollback()
				slog.ErrorContext(ctx, "Failed to update message", "error", err, "room", chatMsg.Room)
				span.RecordError(err)
				errorCounter.Add(ctx, 1, roomAttr)
				msg.Nak()
				return
			}

			// Trim old versions to keep at most 5
			if _, err := tx.StmtContext(ctx, trimVersionsStmt).ExecContext(ctx, chatMsg.Room, chatMsg.Timestamp); err != nil {
				tx.Rollback()
				slog.ErrorContext(ctx, "Failed to trim versions", "error", err, "room", chatMsg.Room)
				span.RecordError(err)
				errorCounter.Add(ctx, 1, roomAttr)
				msg.Nak()
				return
			}

			if err := tx.Commit(); err != nil {
				slog.ErrorContext(ctx, "Failed to commit edit tx", "error", err, "room", chatMsg.Room)
				span.RecordError(err)
				errorCounter.Add(ctx, 1, roomAttr)
				msg.Nak()
				return
			}
			span.AddEvent("message_edited", trace.WithAttributes(
				attribute.String("chat.room", chatMsg.Room),
				attribute.String("chat.user", chatMsg.User),
			))
			editedCounter.Add(ctx, 1, roomAttr)

		case "react":
			res, err := insertReactionStmt.ExecContext(ctx, chatMsg.Room, chatMsg.Timestamp, chatMsg.User, chatMsg.Emoji)
			if err != nil {
				slog.ErrorContext(ctx, "Failed to insert reaction", "error", err, "room", chatMsg.Room)
				span.RecordError(err)
				errorCounter.Add(ctx, 1, roomAttr)
				msg.Nak()
				return
			}
			rows, _ := res.RowsAffected()
			if rows == 0 {
				// Already existed → toggle off (delete)
				_, err = deleteReactionStmt.ExecContext(ctx, chatMsg.Room, chatMsg.Timestamp, chatMsg.User, chatMsg.Emoji)
				if err != nil {
					slog.ErrorContext(ctx, "Failed to delete reaction", "error", err, "room", chatMsg.Room)
					span.RecordError(err)
					errorCounter.Add(ctx, 1, roomAttr)
					msg.Nak()
					return
				}
			}
			span.AddEvent("reaction_toggled", trace.WithAttributes(
				attribute.String("chat.room", chatMsg.Room),
				attribute.String("chat.user", chatMsg.User),
			))
			reactedCounter.Add(ctx, 1, roomAttr)

		default:
			// Normal message insert
			_, err := insertStmt.ExecContext(ctx, chatMsg.Room, chatMsg.User, chatMsg.Text, chatMsg.Timestamp, nullableString(chatMsg.ThreadId), nullableInt64(chatMsg.ParentTimestamp), chatMsg.Broadcast, nullableString(chatMsg.StickerURL))
			if err != nil {
				slog.ErrorContext(ctx, "Failed to insert message", "error", err, "room", chatMsg.Room)
				span.RecordError(err)
				errorCounter.Add(ctx, 1, roomAttr)
				msg.Nak()
				return
			}
			span.AddEvent("message_persisted", trace.WithAttributes(
				attribute.String("chat.room", chatMsg.Room),
				attribute.String("chat.user", chatMsg.User),
			))
			persistedCounter.Add(ctx, 1, roomAttr)
		}

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
