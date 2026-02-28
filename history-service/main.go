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
	User            string              `json:"user"`
	Text            string              `json:"text"`
	Timestamp       int64               `json:"timestamp"`
	Room            string              `json:"room"`
	ThreadId        string              `json:"threadId,omitempty"`
	ParentTimestamp int64               `json:"parentTimestamp,omitempty"`
	ReplyCount      int                 `json:"replyCount,omitempty"`
	IsDeleted       bool                `json:"isDeleted,omitempty"`
	EditedAt        int64               `json:"editedAt,omitempty"`
	Reactions       map[string][]string `json:"reactions,omitempty"`
	StickerURL      string              `json:"stickerUrl,omitempty"`
}

type HistoryRequest struct {
	Before int64 `json:"before,omitempty"`
}

type HistoryResponse struct {
	Messages []ChatMessage `json:"messages"`
	HasMore  bool          `json:"hasMore"`
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
	requestDuration, _ := otelhelper.NewDurationHistogram(meter, "history_request_duration_seconds", "History request duration")

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

	// Prepare query statements: one without cursor, one with cursor
	// Fetch 26 rows (pageSize+1) to detect hasMore without a COUNT query
	const pageSize = 25

	queryLatestStmt, err := db.Prepare(
		`SELECT m.room, m.username, m.text, m.timestamp, m.thread_id,
		        COALESCE((SELECT COUNT(*) FROM messages t WHERE t.thread_id = m.room || '-' || m.timestamp::text), 0) AS reply_count,
		        m.is_deleted, m.edited_at,
		        (SELECT json_object_agg(sub.emoji, sub.users) FROM (
		            SELECT emoji, json_agg(user_id ORDER BY created_at) AS users
		            FROM message_reactions
		            WHERE room = m.room AND message_timestamp = m.timestamp
		            GROUP BY emoji
		        ) sub) AS reactions,
		        m.sticker_url
		 FROM messages m
		 WHERE m.room = $1 AND m.thread_id IS NULL
		 ORDER BY m.timestamp DESC LIMIT $2`,
	)
	if err != nil {
		slog.Error("Failed to prepare latest query", "error", err)
		os.Exit(1)
	}
	defer queryLatestStmt.Close()

	queryCursorStmt, err := db.Prepare(
		`SELECT m.room, m.username, m.text, m.timestamp, m.thread_id,
		        COALESCE((SELECT COUNT(*) FROM messages t WHERE t.thread_id = m.room || '-' || m.timestamp::text), 0) AS reply_count,
		        m.is_deleted, m.edited_at,
		        (SELECT json_object_agg(sub.emoji, sub.users) FROM (
		            SELECT emoji, json_agg(user_id ORDER BY created_at) AS users
		            FROM message_reactions
		            WHERE room = m.room AND message_timestamp = m.timestamp
		            GROUP BY emoji
		        ) sub) AS reactions,
		        m.sticker_url
		 FROM messages m
		 WHERE m.room = $1 AND m.thread_id IS NULL AND m.timestamp < $2
		 ORDER BY m.timestamp DESC LIMIT $3`,
	)
	if err != nil {
		slog.Error("Failed to prepare cursor query", "error", err)
		os.Exit(1)
	}
	defer queryCursorStmt.Close()

	// Subscribe to history requests with tracing (queue group for horizontal scaling)
	_, err = nc.QueueSubscribe("chat.history.*", "history-workers", func(msg *nats.Msg) {
		start := time.Now()
		ctx, span := otelhelper.StartServerSpan(context.Background(), msg, "history request")
		defer span.End()

		parts := strings.Split(msg.Subject, ".")
		if len(parts) < 3 {
			msg.Respond([]byte(`{"messages":[],"hasMore":false}`))
			return
		}
		room := parts[2]
		span.SetAttributes(attribute.String("chat.room", room))

		// Parse optional cursor from request body
		var req HistoryRequest
		if len(msg.Data) > 0 {
			_ = json.Unmarshal(msg.Data, &req)
		}

		var rows *sql.Rows
		if req.Before > 0 {
			rows, err = queryCursorStmt.QueryContext(ctx, room, req.Before, pageSize+1)
		} else {
			rows, err = queryLatestStmt.QueryContext(ctx, room, pageSize+1)
		}
		if err != nil {
			slog.ErrorContext(ctx, "Query failed", "room", room, "error", err)
			span.RecordError(err)
			msg.Respond([]byte(`{"messages":[],"hasMore":false}`))
			return
		}
		defer rows.Close()

		var messages []ChatMessage
		for rows.Next() {
			var m ChatMessage
			var threadId sql.NullString
			var replyCount int
			var isDeleted sql.NullBool
			var editedAt sql.NullInt64
			var reactionsJSON sql.NullString
			var stickerURL sql.NullString
			if err := rows.Scan(&m.Room, &m.User, &m.Text, &m.Timestamp, &threadId, &replyCount, &isDeleted, &editedAt, &reactionsJSON, &stickerURL); err != nil {
				slog.WarnContext(ctx, "Failed to scan row", "error", err)
				continue
			}
			if threadId.Valid {
				m.ThreadId = threadId.String
			}
			m.ReplyCount = replyCount
			if isDeleted.Valid && isDeleted.Bool {
				m.IsDeleted = true
				m.Text = ""
			}
			if editedAt.Valid {
				m.EditedAt = editedAt.Int64
			}
			if reactionsJSON.Valid {
				_ = json.Unmarshal([]byte(reactionsJSON.String), &m.Reactions)
			}
			if stickerURL.Valid {
				m.StickerURL = stickerURL.String
			}
			messages = append(messages, m)
		}

		// Determine hasMore: if we got pageSize+1 rows, there are more
		hasMore := len(messages) > pageSize
		if hasMore {
			messages = messages[:pageSize]
		}

		// Reverse to chronological order (query was DESC)
		for i, j := 0, len(messages)-1; i < j; i, j = i+1, j-1 {
			messages[i], messages[j] = messages[j], messages[i]
		}

		if messages == nil {
			messages = []ChatMessage{}
		}

		resp := HistoryResponse{Messages: messages, HasMore: hasMore}
		data, err := json.Marshal(resp)
		if err != nil {
			slog.ErrorContext(ctx, "Failed to marshal history", "error", err)
			span.RecordError(err)
			msg.Respond([]byte(`{"messages":[],"hasMore":false}`))
			return
		}

		msg.Respond(data)

		duration := time.Since(start).Seconds()
		attrs := metric.WithAttributes(attribute.String("room", room))
		requestCounter.Add(ctx, 1, attrs)
		requestDuration.Record(ctx, duration, attrs)

		span.SetAttributes(attribute.Int("history.message_count", len(messages)))
		slog.InfoContext(ctx, "Served history", "room", room, "count", len(messages), "hasMore", hasMore, "duration_ms", time.Since(start).Milliseconds())
	})
	if err != nil {
		slog.Error("Failed to subscribe", "error", err)
		os.Exit(1)
	}
	slog.Info("Subscribed to chat.history.* (queue group: history-workers) — ready to serve history requests")

	// Prepare thread query statement
	threadQueryStmt, err := db.Prepare(
		`SELECT m.room, m.username, m.text, m.timestamp, m.thread_id, m.parent_timestamp, m.is_deleted, m.edited_at,
		        (SELECT json_object_agg(sub.emoji, sub.users) FROM (
		            SELECT emoji, json_agg(user_id ORDER BY created_at) AS users
		            FROM message_reactions
		            WHERE room = m.room AND message_timestamp = m.timestamp
		            GROUP BY emoji
		        ) sub) AS reactions,
		        m.sticker_url
		 FROM messages m
		 WHERE m.thread_id = $1
		 ORDER BY m.timestamp ASC LIMIT 200`,
	)
	if err != nil {
		slog.Error("Failed to prepare thread query", "error", err)
		os.Exit(1)
	}
	defer threadQueryStmt.Close()

	// Subscribe to thread history requests: chat.history.{room}.thread.{threadId}
	// Queue group for horizontal scaling
	_, err = nc.QueueSubscribe("chat.history.*.thread.*", "history-workers", func(msg *nats.Msg) {
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
			var isDeleted sql.NullBool
			var editedAt sql.NullInt64
			var reactionsJSON sql.NullString
			var stickerURL sql.NullString
			if err := rows.Scan(&m.Room, &m.User, &m.Text, &m.Timestamp, &tid, &pts, &isDeleted, &editedAt, &reactionsJSON, &stickerURL); err != nil {
				slog.WarnContext(ctx, "Failed to scan thread row", "error", err)
				continue
			}
			if tid.Valid {
				m.ThreadId = tid.String
			}
			if pts.Valid {
				m.ParentTimestamp = pts.Int64
			}
			if isDeleted.Valid && isDeleted.Bool {
				m.IsDeleted = true
				m.Text = ""
			}
			if editedAt.Valid {
				m.EditedAt = editedAt.Int64
			}
			if reactionsJSON.Valid {
				_ = json.Unmarshal([]byte(reactionsJSON.String), &m.Reactions)
			}
			if stickerURL.Valid {
				m.StickerURL = stickerURL.String
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
	slog.Info("Subscribed to chat.history.*.thread.* (queue group: history-workers) — ready to serve thread history requests")

	// Prepare DM discovery query: find distinct DM rooms a user participates in
	dmDiscoveryStmt, err := db.Prepare(
		`SELECT DISTINCT room FROM messages
		 WHERE room LIKE 'dm-%'
		   AND (room LIKE 'dm-' || $1 || '-%' OR room LIKE '%-' || $1)
		 ORDER BY room`)
	if err != nil {
		slog.Error("Failed to prepare DM discovery query", "error", err)
		os.Exit(1)
	}
	defer dmDiscoveryStmt.Close()

	// Subscribe to DM discovery requests: chat.dms (body = username)
	// Queue group for horizontal scaling
	_, err = nc.QueueSubscribe("chat.dms", "history-workers", func(msg *nats.Msg) {
		start := time.Now()
		ctx, span := otelhelper.StartServerSpan(context.Background(), msg, "dm discovery")
		defer span.End()

		username := strings.TrimSpace(string(msg.Data))
		if username == "" {
			msg.Respond([]byte("[]"))
			return
		}
		span.SetAttributes(attribute.String("chat.username", username))

		rows, err := dmDiscoveryStmt.QueryContext(ctx, username)
		if err != nil {
			slog.ErrorContext(ctx, "DM discovery query failed", "username", username, "error", err)
			span.RecordError(err)
			msg.Respond([]byte("[]"))
			return
		}
		defer rows.Close()

		var rooms []string
		for rows.Next() {
			var room string
			if err := rows.Scan(&room); err != nil {
				continue
			}
			rooms = append(rooms, room)
		}
		if rooms == nil {
			rooms = []string{}
		}

		data, _ := json.Marshal(rooms)
		msg.Respond(data)

		duration := time.Since(start).Seconds()
		requestCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("type", "dm_discovery")))
		requestDuration.Record(ctx, duration, metric.WithAttributes(attribute.String("type", "dm_discovery")))
		slog.InfoContext(ctx, "Served DM discovery", "username", username, "count", len(rooms), "duration_ms", time.Since(start).Milliseconds())
	})
	if err != nil {
		slog.Error("Failed to subscribe to chat.dms", "error", err)
		os.Exit(1)
	}
	slog.Info("Subscribed to chat.dms (queue group: history-workers) — ready to serve DM discovery requests")

	// Wait for shutdown
	sigCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	<-sigCtx.Done()

	slog.Info("Shutting down history service")
	nc.Drain()
}
