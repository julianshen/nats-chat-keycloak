package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	otelhelper "github.com/example/nats-chat-otelhelper"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

func envOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	ctx := context.Background()

	otelShutdown, err := otelhelper.Init(ctx)
	if err != nil {
		slog.Error("Failed to initialize OpenTelemetry", "error", err)
		os.Exit(1)
	}
	defer otelShutdown(ctx)

	meter := otel.Meter("e2ee-key-service")
	requestCounter, _ := meter.Int64Counter("e2ee_requests_total")

	natsURL := envOrDefault("NATS_URL", "nats://localhost:4222")
	natsUser := envOrDefault("NATS_USER", "e2ee-key-service")
	natsPass := envOrDefault("NATS_PASS", "e2ee-key-service-secret")

	slog.Info("Starting E2EE Key Service", "nats_url", natsURL)

	// Connect to NATS with retry
	var nc *nats.Conn
	for attempt := 1; attempt <= 30; attempt++ {
		nc, err = nats.Connect(natsURL,
			nats.UserInfo(natsUser, natsPass),
			nats.Name("e2ee-key-service"),
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

	// Create JetStream context for KV buckets
	js, err := jetstream.New(nc)
	if err != nil {
		slog.Error("Failed to create JetStream context", "error", err)
		os.Exit(1)
	}

	// Create KV buckets
	identityKV, err := js.CreateOrUpdateKeyValue(ctx, jetstream.KeyValueConfig{
		Bucket:  "E2EE_IDENTITY_KEYS",
		Storage: jetstream.FileStorage,
	})
	if err != nil {
		slog.Error("Failed to create E2EE_IDENTITY_KEYS bucket", "error", err)
		os.Exit(1)
	}
	slog.Info("KV bucket E2EE_IDENTITY_KEYS ready")

	roomKeysKV, err := js.CreateOrUpdateKeyValue(ctx, jetstream.KeyValueConfig{
		Bucket:  "E2EE_ROOM_KEYS",
		Storage: jetstream.FileStorage,
	})
	if err != nil {
		slog.Error("Failed to create E2EE_ROOM_KEYS bucket", "error", err)
		os.Exit(1)
	}
	slog.Info("KV bucket E2EE_ROOM_KEYS ready")

	roomMetaKV, err := js.CreateOrUpdateKeyValue(ctx, jetstream.KeyValueConfig{
		Bucket:  "E2EE_ROOM_META",
		Storage: jetstream.FileStorage,
	})
	if err != nil {
		slog.Error("Failed to create E2EE_ROOM_META bucket", "error", err)
		os.Exit(1)
	}
	slog.Info("KV bucket E2EE_ROOM_META ready")

	// Raw room keys for server-side decryption (persist-worker)
	roomKeysRawKV, err := js.CreateOrUpdateKeyValue(ctx, jetstream.KeyValueConfig{
		Bucket:  "E2EE_ROOM_KEYS_RAW",
		Storage: jetstream.FileStorage,
	})
	if err != nil {
		slog.Error("Failed to create E2EE_ROOM_KEYS_RAW bucket", "error", err)
		os.Exit(1)
	}
	slog.Info("KV bucket E2EE_ROOM_KEYS_RAW ready")

	// Handle identity key publish: e2ee.identity.publish
	_, err = nc.QueueSubscribe("e2ee.identity.publish", "e2ee-key-workers", func(msg *nats.Msg) {
		ctx, span := otelhelper.StartConsumerSpan(context.Background(), msg, "e2ee identity publish")
		defer span.End()

		var payload struct {
			Username  string          `json:"username"`
			PublicKey json.RawMessage `json:"publicKey"`
		}
		if err := json.Unmarshal(msg.Data, &payload); err != nil {
			slog.WarnContext(ctx, "Failed to unmarshal identity publish", "error", err)
			return
		}
		if payload.Username == "" {
			return
		}

		span.SetAttributes(attribute.String("e2ee.username", payload.Username))

		entry, _ := json.Marshal(map[string]interface{}{
			"publicKey": payload.PublicKey,
			"createdAt": time.Now().UnixMilli(),
		})

		if _, err := identityKV.Put(ctx, payload.Username, entry); err != nil {
			slog.ErrorContext(ctx, "Failed to store identity key", "error", err, "username", payload.Username)
			span.RecordError(err)
			return
		}

		requestCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("operation", "identity_publish")))
		slog.InfoContext(ctx, "Stored identity key", "username", payload.Username)
	})
	if err != nil {
		slog.Error("Failed to subscribe to e2ee.identity.publish", "error", err)
		os.Exit(1)
	}

	// Handle identity key get: e2ee.keys.get.{username}
	_, err = nc.QueueSubscribe("e2ee.keys.get.*", "e2ee-key-workers", func(msg *nats.Msg) {
		ctx, span := otelhelper.StartServerSpan(context.Background(), msg, "e2ee keys get")
		defer span.End()

		parts := strings.Split(msg.Subject, ".")
		if len(parts) < 4 {
			msg.Respond([]byte(`{"error":"invalid subject"}`))
			return
		}
		username := parts[3]
		span.SetAttributes(attribute.String("e2ee.username", username))

		entry, err := identityKV.Get(ctx, username)
		if err != nil {
			msg.Respond([]byte(`{"error":"not found"}`))
			return
		}

		msg.Respond(entry.Value())
		requestCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("operation", "keys_get")))
	})
	if err != nil {
		slog.Error("Failed to subscribe to e2ee.keys.get.*", "error", err)
		os.Exit(1)
	}

	// Handle room key distribute: e2ee.roomkey.distribute
	_, err = nc.QueueSubscribe("e2ee.roomkey.distribute", "e2ee-key-workers", func(msg *nats.Msg) {
		ctx, span := otelhelper.StartConsumerSpan(context.Background(), msg, "e2ee roomkey distribute")
		defer span.End()

		var payload struct {
			Room       string `json:"room"`
			Epoch      int    `json:"epoch"`
			Recipient  string `json:"recipient"`
			WrappedKey string `json:"wrappedKey"`
			Sender     string `json:"sender"`
		}
		if err := json.Unmarshal(msg.Data, &payload); err != nil {
			slog.WarnContext(ctx, "Failed to unmarshal roomkey distribute", "error", err)
			return
		}

		span.SetAttributes(
			attribute.String("e2ee.room", payload.Room),
			attribute.Int("e2ee.epoch", payload.Epoch),
			attribute.String("e2ee.recipient", payload.Recipient),
		)

		// Key format: {room}.{epoch}.{recipient}
		// NATS KV keys cannot contain dots in values that look like subjects,
		// so we use underscores as separators for room names that might contain dots
		kvKey := sanitizeKVKey(payload.Room) + "." + intToStr(payload.Epoch) + "." + payload.Recipient

		entry, _ := json.Marshal(map[string]interface{}{
			"wrappedKey": payload.WrappedKey,
			"sender":     payload.Sender,
			"epoch":      payload.Epoch,
		})

		if _, err := roomKeysKV.Put(ctx, kvKey, entry); err != nil {
			slog.ErrorContext(ctx, "Failed to store room key", "error", err, "room", payload.Room, "recipient", payload.Recipient)
			span.RecordError(err)
			return
		}

		requestCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("operation", "roomkey_distribute")))
		slog.InfoContext(ctx, "Stored wrapped room key", "room", payload.Room, "epoch", payload.Epoch, "recipient", payload.Recipient)
	})
	if err != nil {
		slog.Error("Failed to subscribe to e2ee.roomkey.distribute", "error", err)
		os.Exit(1)
	}

	// Handle room key get: e2ee.roomkey.get.{room}.{username}
	_, err = nc.QueueSubscribe("e2ee.roomkey.get.*.*", "e2ee-key-workers", func(msg *nats.Msg) {
		ctx, span := otelhelper.StartServerSpan(context.Background(), msg, "e2ee roomkey get")
		defer span.End()

		parts := strings.Split(msg.Subject, ".")
		if len(parts) < 5 {
			msg.Respond([]byte(`{"wrappedKeys":[]}`))
			return
		}
		room := parts[3]
		username := parts[4]
		span.SetAttributes(
			attribute.String("e2ee.room", room),
			attribute.String("e2ee.username", username),
		)

		// List all keys matching {room}.*.{username}
		prefix := sanitizeKVKey(room) + "."
		keys, err := roomKeysKV.Keys(ctx)
		if err != nil {
			msg.Respond([]byte(`{"wrappedKeys":[]}`))
			return
		}

		var wrappedKeys []json.RawMessage
		for _, key := range keys {
			if !strings.HasPrefix(key, prefix) {
				continue
			}
			if !strings.HasSuffix(key, "."+username) {
				continue
			}
			entry, err := roomKeysKV.Get(ctx, key)
			if err != nil {
				continue
			}
			wrappedKeys = append(wrappedKeys, entry.Value())
		}

		if wrappedKeys == nil {
			wrappedKeys = []json.RawMessage{}
		}

		resp, _ := json.Marshal(map[string]interface{}{
			"wrappedKeys": wrappedKeys,
		})
		msg.Respond(resp)
		requestCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("operation", "roomkey_get")))
	})
	if err != nil {
		slog.Error("Failed to subscribe to e2ee.roomkey.get.*.*", "error", err)
		os.Exit(1)
	}

	// Handle raw room key publish: e2ee.roomkey.raw
	// Browser publishes raw key so persist-worker can decrypt messages server-side
	_, err = nc.QueueSubscribe("e2ee.roomkey.raw", "e2ee-key-workers", func(msg *nats.Msg) {
		ctx, span := otelhelper.StartConsumerSpan(context.Background(), msg, "e2ee roomkey raw store")
		defer span.End()

		var payload struct {
			Room   string `json:"room"`
			Epoch  int    `json:"epoch"`
			RawKey string `json:"rawKey"` // base64-encoded AES-256-GCM key
		}
		if err := json.Unmarshal(msg.Data, &payload); err != nil {
			slog.WarnContext(ctx, "Failed to unmarshal roomkey raw", "error", err)
			return
		}

		span.SetAttributes(
			attribute.String("e2ee.room", payload.Room),
			attribute.Int("e2ee.epoch", payload.Epoch),
		)

		kvKey := sanitizeKVKey(payload.Room) + "." + intToStr(payload.Epoch)
		if _, err := roomKeysRawKV.Put(ctx, kvKey, []byte(payload.RawKey)); err != nil {
			slog.ErrorContext(ctx, "Failed to store raw room key", "error", err, "room", payload.Room)
			span.RecordError(err)
			return
		}

		requestCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("operation", "roomkey_raw_store")))
		slog.InfoContext(ctx, "Stored raw room key", "room", payload.Room, "epoch", payload.Epoch)
	})
	if err != nil {
		slog.Error("Failed to subscribe to e2ee.roomkey.raw", "error", err)
		os.Exit(1)
	}

	// Handle raw room key get: e2ee.roomkey.raw.get.{room}.{epoch}
	// Used by persist-worker to fetch key for decryption
	_, err = nc.QueueSubscribe("e2ee.roomkey.raw.get.*.*", "e2ee-key-workers", func(msg *nats.Msg) {
		ctx, span := otelhelper.StartServerSpan(context.Background(), msg, "e2ee roomkey raw get")
		defer span.End()

		parts := strings.Split(msg.Subject, ".")
		if len(parts) < 6 {
			msg.Respond([]byte(`{"error":"invalid subject"}`))
			return
		}
		room := parts[4]
		epoch := parts[5]
		span.SetAttributes(
			attribute.String("e2ee.room", room),
			attribute.String("e2ee.epoch", epoch),
		)

		kvKey := sanitizeKVKey(room) + "." + epoch
		entry, err := roomKeysRawKV.Get(ctx, kvKey)
		if err != nil {
			msg.Respond([]byte(`{"error":"not found"}`))
			return
		}

		resp, _ := json.Marshal(map[string]string{
			"rawKey": string(entry.Value()),
		})
		msg.Respond(resp)
		requestCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("operation", "roomkey_raw_get")))
	})
	if err != nil {
		slog.Error("Failed to subscribe to e2ee.roomkey.raw.get.*.*", "error", err)
		os.Exit(1)
	}

	// Handle room E2EE enable: e2ee.room.enable.{room}
	_, err = nc.QueueSubscribe("e2ee.room.enable.*", "e2ee-key-workers", func(msg *nats.Msg) {
		ctx, span := otelhelper.StartServerSpan(context.Background(), msg, "e2ee room enable")
		defer span.End()

		parts := strings.Split(msg.Subject, ".")
		if len(parts) < 4 {
			msg.Respond([]byte(`{"error":"invalid subject"}`))
			return
		}
		room := parts[3]

		var payload struct {
			Room         string `json:"room"`
			CurrentEpoch int    `json:"currentEpoch"`
			Initiator    string `json:"initiator"`
		}
		if err := json.Unmarshal(msg.Data, &payload); err != nil {
			slog.WarnContext(ctx, "Failed to unmarshal room enable", "error", err)
			msg.Respond([]byte(`{"error":"invalid payload"}`))
			return
		}

		span.SetAttributes(attribute.String("e2ee.room", room))

		meta, _ := json.Marshal(map[string]interface{}{
			"enabled":      true,
			"currentEpoch": payload.CurrentEpoch,
			"initiator":    payload.Initiator,
		})

		if _, err := roomMetaKV.Put(ctx, sanitizeKVKey(room), meta); err != nil {
			slog.ErrorContext(ctx, "Failed to enable E2EE for room", "error", err, "room", room)
			span.RecordError(err)
			msg.Respond([]byte(`{"error":"failed to store"}`))
			return
		}

		msg.Respond([]byte(`{"ok":true}`))
		requestCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("operation", "room_enable")))
		slog.InfoContext(ctx, "E2EE enabled for room", "room", room, "epoch", payload.CurrentEpoch, "initiator", payload.Initiator)
	})
	if err != nil {
		slog.Error("Failed to subscribe to e2ee.room.enable.*", "error", err)
		os.Exit(1)
	}

	// Handle room E2EE disable: e2ee.room.disable.{room}
	_, err = nc.QueueSubscribe("e2ee.room.disable.*", "e2ee-key-workers", func(msg *nats.Msg) {
		ctx, span := otelhelper.StartServerSpan(context.Background(), msg, "e2ee room disable")
		defer span.End()

		parts := strings.Split(msg.Subject, ".")
		if len(parts) < 4 {
			msg.Respond([]byte(`{"error":"invalid subject"}`))
			return
		}
		room := parts[3]
		span.SetAttributes(attribute.String("e2ee.room", room))

		meta, _ := json.Marshal(map[string]interface{}{
			"enabled": false,
		})

		if _, err := roomMetaKV.Put(ctx, sanitizeKVKey(room), meta); err != nil {
			slog.ErrorContext(ctx, "Failed to disable E2EE for room", "error", err, "room", room)
			span.RecordError(err)
			msg.Respond([]byte(`{"error":"failed to store"}`))
			return
		}

		msg.Respond([]byte(`{"ok":true}`))
		requestCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("operation", "room_disable")))
		slog.InfoContext(ctx, "E2EE disabled for room", "room", room)
	})
	if err != nil {
		slog.Error("Failed to subscribe to e2ee.room.disable.*", "error", err)
		os.Exit(1)
	}

	// Handle room meta get: e2ee.room.meta.{room}
	_, err = nc.QueueSubscribe("e2ee.room.meta.*", "e2ee-key-workers", func(msg *nats.Msg) {
		ctx, span := otelhelper.StartServerSpan(context.Background(), msg, "e2ee room meta")
		defer span.End()

		parts := strings.Split(msg.Subject, ".")
		if len(parts) < 4 {
			msg.Respond([]byte(`{"enabled":false}`))
			return
		}
		room := parts[3]
		span.SetAttributes(attribute.String("e2ee.room", room))

		entry, err := roomMetaKV.Get(ctx, sanitizeKVKey(room))
		if err != nil {
			msg.Respond([]byte(`{"enabled":false}`))
			return
		}

		msg.Respond(entry.Value())
		requestCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("operation", "room_meta")))
	})
	if err != nil {
		slog.Error("Failed to subscribe to e2ee.room.meta.*", "error", err)
		os.Exit(1)
	}

	// Handle room meta update (epoch bump): e2ee.room.epoch.{room}
	_, err = nc.QueueSubscribe("e2ee.room.epoch.*", "e2ee-key-workers", func(msg *nats.Msg) {
		ctx, span := otelhelper.StartServerSpan(context.Background(), msg, "e2ee room epoch update")
		defer span.End()

		parts := strings.Split(msg.Subject, ".")
		if len(parts) < 4 {
			msg.Respond([]byte(`{"error":"invalid subject"}`))
			return
		}
		room := parts[3]

		var payload struct {
			NewEpoch int `json:"newEpoch"`
		}
		if err := json.Unmarshal(msg.Data, &payload); err != nil {
			msg.Respond([]byte(`{"error":"invalid payload"}`))
			return
		}

		span.SetAttributes(attribute.String("e2ee.room", room), attribute.Int("e2ee.epoch", payload.NewEpoch))

		// Read current meta and update epoch
		entry, err := roomMetaKV.Get(ctx, sanitizeKVKey(room))
		if err != nil {
			msg.Respond([]byte(`{"error":"room not found"}`))
			return
		}

		var meta map[string]interface{}
		json.Unmarshal(entry.Value(), &meta)
		meta["currentEpoch"] = payload.NewEpoch

		updated, _ := json.Marshal(meta)
		if _, err := roomMetaKV.Put(ctx, sanitizeKVKey(room), updated); err != nil {
			msg.Respond([]byte(`{"error":"failed to update"}`))
			return
		}

		msg.Respond([]byte(`{"ok":true}`))
		requestCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("operation", "room_epoch_update")))
		slog.InfoContext(ctx, "Updated room epoch", "room", room, "newEpoch", payload.NewEpoch)
	})
	if err != nil {
		slog.Error("Failed to subscribe to e2ee.room.epoch.*", "error", err)
		os.Exit(1)
	}

	slog.Info("E2EE Key Service ready — subscriptions active")

	// Wait for shutdown
	sigCtx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()
	<-sigCtx.Done()

	slog.Info("Shutting down E2EE Key Service")
	nc.Drain()
}

// sanitizeKVKey replaces characters not allowed in NATS KV keys
func sanitizeKVKey(s string) string {
	// NATS KV keys allow alphanumeric, dash, underscore, forward slash, equals, dot
	// Room names may contain characters that need sanitizing
	return strings.ReplaceAll(s, " ", "_")
}

func intToStr(n int) string {
	return strconv.Itoa(n)
}
