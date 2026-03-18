package main

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
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

type E2EEInfo struct {
	Epoch int `json:"epoch"`
	V     int `json:"v"`
}

type ChatMessage struct {
	User            string    `json:"user"`
	Text            string    `json:"text"`
	Timestamp       int64     `json:"timestamp"`
	Room            string    `json:"room"`
	ThreadId        string    `json:"threadId,omitempty"`
	ParentTimestamp int64     `json:"parentTimestamp,omitempty"`
	Broadcast       bool      `json:"broadcast,omitempty"`
	Action          string    `json:"action,omitempty"`
	Emoji           string    `json:"emoji,omitempty"`
	TargetUser      string    `json:"targetUser,omitempty"`
	StickerURL      string    `json:"stickerUrl,omitempty"`
	E2EE            *E2EEInfo `json:"e2ee,omitempty"`
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

func nullableE2EEEpoch(e2ee *E2EEInfo) interface{} {
	if e2ee == nil {
		return nil
	}
	return e2ee.Epoch
}

func roomFromSubject(subject string) string {
	if !strings.HasPrefix(subject, "chat.") {
		return subject
	}
	rest := strings.TrimPrefix(subject, "chat.")
	if idx := strings.Index(rest, ".thread."); idx >= 0 {
		return rest[:idx]
	}
	return rest
}

// roomKeyCache caches raw AES-256-GCM keys fetched from e2ee-key-service.
// Bounded to maxKeys entries; evicts in FIFO (insertion order) when full.
type roomKeyCache struct {
	mu      sync.RWMutex
	keys    map[string][]byte // "room.epoch" → raw key bytes
	order   []string          // insertion order for eviction
	maxKeys int
}

const defaultMaxCacheKeys = 1000

func newRoomKeyCache() *roomKeyCache {
	return &roomKeyCache{
		keys:    make(map[string][]byte),
		maxKeys: defaultMaxCacheKeys,
	}
}

func (c *roomKeyCache) get(room string, epoch int) ([]byte, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	k, ok := c.keys[room+"\x00"+strconv.Itoa(epoch)]
	return k, ok
}

func (c *roomKeyCache) put(room string, epoch int, key []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	cacheKey := room + "\x00" + strconv.Itoa(epoch)
	if _, exists := c.keys[cacheKey]; exists {
		c.keys[cacheKey] = key
		return
	}
	// Evict oldest if at capacity
	if len(c.keys) >= c.maxKeys && len(c.order) > 0 {
		evict := c.order[0]
		c.order = c.order[1:]
		delete(c.keys, evict)
	}
	c.keys[cacheKey] = key
	c.order = append(c.order, cacheKey)
}

func (c *roomKeyCache) invalidate(room string, epoch int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	cacheKey := room + "\x00" + strconv.Itoa(epoch)
	if _, ok := c.keys[cacheKey]; !ok {
		return
	}
	delete(c.keys, cacheKey)
	// Remove from order to keep keys/order in sync
	for i, k := range c.order {
		if k == cacheKey {
			c.order = append(c.order[:i], c.order[i+1:]...)
			break
		}
	}
}

// fetchRoomKey fetches a raw room key from e2ee-key-service via NATS request/reply
func fetchRoomKey(nc *nats.Conn, room string, epoch int) ([]byte, error) {
	subject := fmt.Sprintf("e2ee.roomkey.raw.get.%s.%d", room, epoch)
	resp, err := nc.Request(subject, nil, 5*time.Second)
	if err != nil {
		return nil, fmt.Errorf("request raw key: %w", err)
	}
	var result struct {
		RawKey string `json:"rawKey"`
		Error  string `json:"error"`
	}
	if err := json.Unmarshal(resp.Data, &result); err != nil {
		return nil, fmt.Errorf("unmarshal raw key response: %w", err)
	}
	if result.Error != "" {
		return nil, fmt.Errorf("e2ee-key-service: %s", result.Error)
	}
	keyBytes, err := base64.StdEncoding.DecodeString(result.RawKey)
	if err != nil {
		return nil, fmt.Errorf("decode raw key: %w", err)
	}
	if len(keyBytes) != 32 {
		return nil, fmt.Errorf("invalid key length: got %d bytes, want 32 (AES-256)", len(keyBytes))
	}
	return keyBytes, nil
}

// decryptE2EEText decrypts an AES-256-GCM encrypted message text
// Format: base64(12-byte-IV || ciphertext || 16-byte-authTag)
// AAD: JSON({room, user, timestamp, epoch})
func decryptE2EEText(ciphertextB64 string, key []byte, room, user string, timestamp int64, epoch int) (string, error) {
	raw, err := base64.StdEncoding.DecodeString(ciphertextB64)
	if err != nil {
		return "", fmt.Errorf("decode ciphertext: %w", err)
	}

	// IV (12 bytes) + tag (16 bytes) minimum; GCM allows empty plaintext
	if len(raw) < 12+16 {
		return "", fmt.Errorf("ciphertext too short: %d bytes", len(raw))
	}

	iv := raw[:12]
	ciphertext := raw[12:] // includes auth tag (GCM appends it)

	block, err := aes.NewCipher(key)
	if err != nil {
		return "", fmt.Errorf("create cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("create GCM: %w", err)
	}

	// Build AAD matching the browser's JSON.stringify({room, user, timestamp, epoch}) key order.
	// CRITICAL: Must use a struct (not map) to guarantee field order matches the browser.
	// Go's json.Marshal sorts map keys lexicographically; browser produces insertion order.
	type aadPayload struct {
		Room      string `json:"room"`
		User      string `json:"user"`
		Timestamp int64  `json:"timestamp"`
		Epoch     int    `json:"epoch"`
	}
	aad, err := json.Marshal(aadPayload{Room: room, User: user, Timestamp: timestamp, Epoch: epoch})
	if err != nil {
		return "", fmt.Errorf("marshal AAD: %w", err)
	}

	plaintext, err := gcm.Open(nil, iv, ciphertext, aad)
	if err != nil {
		return "", fmt.Errorf("GCM decrypt: %w", err)
	}

	return string(plaintext), nil
}

func generateInstanceID() string {
	b := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		slog.Warn("Failed to generate random instance ID, using fallback", "error", err)
		return "00000000"
	}
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
	persistedCounter, err := meter.Int64Counter("messages_persisted_total")
	if err != nil {
		slog.Warn("Failed to create persistedCounter metric", "error", err)
	}
	errorCounter, err := meter.Int64Counter("messages_persist_errors_total")
	if err != nil {
		slog.Warn("Failed to create errorCounter metric", "error", err)
	}
	editedCounter, err := meter.Int64Counter("messages_edited_total")
	if err != nil {
		slog.Warn("Failed to create editedCounter metric", "error", err)
	}
	deletedCounter, err := meter.Int64Counter("messages_deleted_total")
	if err != nil {
		slog.Warn("Failed to create deletedCounter metric", "error", err)
	}
	reactedCounter, err := meter.Int64Counter("reactions_toggled_total")
	if err != nil {
		slog.Warn("Failed to create reactedCounter metric", "error", err)
	}
	instanceGauge, err := meter.Int64ObservableGauge("persist_worker_instance",
		metric.WithDescription("Persist worker instance identifier"))
	if err != nil {
		slog.Warn("Failed to create instanceGauge metric", "error", err)
	}
	_, err = meter.RegisterCallback(func(_ context.Context, o metric.Observer) error {
		o.ObserveInt64(instanceGauge, 1, metric.WithAttributes(
			attribute.String("instance_id", instanceID),
		))
		return nil
	}, instanceGauge)
	if err != nil {
		slog.Warn("Failed to register instanceGauge callback", "error", err)
	}

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

	// E2EE room key cache for server-side decryption
	keyCache := newRoomKeyCache()

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
		"INSERT INTO messages (room, username, text, timestamp, thread_id, parent_timestamp, broadcast, sticker_url, e2ee_epoch) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
	)
	if err != nil {
		slog.Error("Failed to prepare insert statement", "error", err)
		os.Exit(1)
	}
	defer insertStmt.Close()

	// Prepare soft-delete statement
	softDeleteStmt, err := db.Prepare(
		"UPDATE messages SET is_deleted = TRUE WHERE (room = $1 OR room = 'chat.' || $1) AND timestamp = $2 AND username = $3 AND is_deleted = FALSE",
	)
	if err != nil {
		slog.Error("Failed to prepare soft-delete statement", "error", err)
		os.Exit(1)
	}
	defer softDeleteStmt.Close()

	// Prepare edit statement (update text + edited_at)
	editStmt, err := db.Prepare(
		"UPDATE messages SET text = $1, edited_at = $2 WHERE (room = $3 OR room = 'chat.' || $3) AND timestamp = $4 AND username = $5 AND is_deleted = FALSE",
	)
	if err != nil {
		slog.Error("Failed to prepare edit statement", "error", err)
		os.Exit(1)
	}
	defer editStmt.Close()

	// Prepare save-version statement
	saveVersionStmt, err := db.Prepare(
		"INSERT INTO message_versions (room, message_timestamp, text, edited_at) SELECT $2, timestamp, text, $1 FROM messages WHERE (room = $2 OR room = 'chat.' || $2) AND timestamp = $3 AND username = $4 AND is_deleted = FALSE",
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

	// decryptIfE2EE attempts to decrypt the message text if E2EE info is present.
	// Returns (plaintext, true) on success or non-E2EE, (text, false) on decryption failure.
	// On decryption failure with a cached key, invalidates the cache so a fresh key is fetched on retry.
	decryptIfE2EE := func(ctx context.Context, chatMsg *ChatMessage) (string, bool) {
		if chatMsg.E2EE == nil || chatMsg.Text == "" {
			return chatMsg.Text, true
		}
		epoch := chatMsg.E2EE.Epoch
		rawKey, wasCached := keyCache.get(chatMsg.Room, epoch)
		if !wasCached {
			fetched, fetchErr := fetchRoomKey(nc, chatMsg.Room, epoch)
			if fetchErr != nil {
				slog.WarnContext(ctx, "Failed to fetch E2EE room key, will retry", "error", fetchErr, "room", chatMsg.Room, "epoch", epoch)
				return chatMsg.Text, false
			}
			rawKey = fetched
			keyCache.put(chatMsg.Room, epoch, rawKey)
		}
		plaintext, decErr := decryptE2EEText(chatMsg.Text, rawKey, chatMsg.Room, chatMsg.User, chatMsg.Timestamp, epoch)
		if decErr != nil {
			// Invalidate cached key so next retry fetches a fresh one
			keyCache.invalidate(chatMsg.Room, epoch)
			slog.WarnContext(ctx, "Failed to decrypt E2EE message, invalidated cached key",
				"error", decErr, "room", chatMsg.Room, "epoch", epoch, "wasCached", wasCached)
			return chatMsg.Text, false
		}
		return plaintext, true
	}

	// maxE2EERetries limits how many times a message is NAKed for E2EE decryption failure
	// before it is stored as ciphertext to prevent infinite retry loops.
	const maxE2EERetries = 10

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
			chatMsg.Room = roomFromSubject(msg.Subject())
		} else {
			chatMsg.Room = strings.TrimPrefix(chatMsg.Room, "chat.")
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
			// Decrypt edited text if E2EE
			editText, decOk := decryptIfE2EE(ctx, &chatMsg)
			if !decOk {
				numDel, metaErr := msg.Metadata()
				if metaErr != nil {
					slog.WarnContext(ctx, "Failed to read message metadata for edit, storing ciphertext as fallback",
						"error", metaErr, "room", chatMsg.Room)
				}
				if metaErr != nil || (numDel != nil && numDel.NumDelivered > uint64(maxE2EERetries)) {
					slog.ErrorContext(ctx, "E2EE decryption permanently failed for edit, storing ciphertext",
						"room", chatMsg.Room)
					editText = chatMsg.Text // store ciphertext as fallback
				} else {
					slog.WarnContext(ctx, "E2EE decryption failed for edit, will retry", "room", chatMsg.Room)
					span.RecordError(fmt.Errorf("E2EE decryption failed"))
					errorCounter.Add(ctx, 1, roomAttr)
					msg.NakWithDelay(5 * time.Second)
					return
				}
			}

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

			// Update the message text (decrypted plaintext)
			if _, err := tx.StmtContext(ctx, editStmt).ExecContext(ctx, editText, editedAt, chatMsg.Room, chatMsg.Timestamp, chatMsg.User); err != nil {
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
			// Decrypt E2EE message text before persisting
			textToStore, decOk := decryptIfE2EE(ctx, &chatMsg)
			if !decOk {
				numDel, metaErr := msg.Metadata()
				if metaErr != nil {
					slog.WarnContext(ctx, "Failed to read message metadata, storing ciphertext as fallback",
						"error", metaErr, "room", chatMsg.Room)
				}
				if metaErr != nil || (numDel != nil && numDel.NumDelivered > uint64(maxE2EERetries)) {
					slog.ErrorContext(ctx, "E2EE decryption permanently failed, storing ciphertext",
						"room", chatMsg.Room)
					textToStore = chatMsg.Text // store ciphertext as fallback
				} else {
					slog.WarnContext(ctx, "E2EE decryption failed, will retry", "room", chatMsg.Room)
					span.RecordError(fmt.Errorf("E2EE decryption failed"))
					errorCounter.Add(ctx, 1, roomAttr)
					msg.NakWithDelay(5 * time.Second)
					return
				}
			}
			if textToStore != chatMsg.Text {
				span.SetAttributes(attribute.Bool("e2ee.decrypted", true))
			}

			// Normal message insert (plaintext after decryption)
			_, err := insertStmt.ExecContext(ctx, chatMsg.Room, chatMsg.User, textToStore, chatMsg.Timestamp, nullableString(chatMsg.ThreadId), nullableInt64(chatMsg.ParentTimestamp), chatMsg.Broadcast, nullableString(chatMsg.StickerURL), nullableE2EEEpoch(chatMsg.E2EE))
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
