package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
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

// roomMeta is the KV-stored metadata for a room's E2EE state.
type roomMeta struct {
	Enabled      bool   `json:"enabled"`
	CurrentEpoch int    `json:"currentEpoch,omitempty"`
	Initiator    string `json:"initiator,omitempty"`
}

// identityEntry is the KV-stored identity key for a user.
type identityEntry struct {
	PublicKey json.RawMessage `json:"publicKey"`
	CreatedAt int64           `json:"createdAt"`
}

// wrappedKeyEntry is the KV-stored wrapped room key for a recipient.
type wrappedKeyEntry struct {
	WrappedKey string `json:"wrappedKey"`
	Sender     string `json:"sender"`
	Epoch      int    `json:"epoch"`
}

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
	requestCounter, err := meter.Int64Counter("e2ee_requests_total")
	if err != nil {
		// OTel SDK guarantees a non-nil no-op counter on error
		slog.Warn("Failed to create metrics counter", "error", err)
	}

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

	// getNatsUser extracts the authenticated username from the Nats-User header.
	// Returns empty string if the header is missing or the message has no headers.
	getNatsUser := func(msg *nats.Msg) string {
		if msg.Header != nil {
			return msg.Header.Get("Nats-User")
		}
		return ""
	}

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
			respondIfReply(msg, []byte(`{"error":"invalid payload"}`))
			return
		}
		if payload.Username == "" {
			respondIfReply(msg, []byte(`{"error":"missing username"}`))
			return
		}

		span.SetAttributes(attribute.String("e2ee.username", payload.Username))

		// Verify the caller's authenticated username matches the publish target
		// to prevent users from overwriting other users' identity keys.
		callerUser := getNatsUser(msg)
		if callerUser == "" {
			slog.WarnContext(ctx, "Identity publish rejected: missing Nats-User header", "target", payload.Username)
			respondIfReply(msg, []byte(`{"error":"unauthorized"}`))
			return
		}
		if callerUser != payload.Username {
			slog.WarnContext(ctx, "Identity publish rejected: caller does not match username", "caller", callerUser, "target", payload.Username)
			respondIfReply(msg, []byte(`{"error":"caller does not match username"}`))
			return
		}

		// Validate JWK structure for ECDH P-256
		var jwk map[string]interface{}
		if err := json.Unmarshal(payload.PublicKey, &jwk); err != nil {
			slog.WarnContext(ctx, "Identity publish rejected: invalid JWK", "error", err)
			respondIfReply(msg, []byte(`{"error":"invalid JWK"}`))
			return
		}
		if jwk["kty"] != "EC" || jwk["crv"] != "P-256" {
			slog.WarnContext(ctx, "Identity publish rejected: JWK must be EC P-256", "kty", jwk["kty"], "crv", jwk["crv"])
			respondIfReply(msg, []byte(`{"error":"JWK must be EC P-256"}`))
			return
		}
		if jwk["x"] == nil || jwk["y"] == nil {
			slog.WarnContext(ctx, "Identity publish rejected: JWK missing x or y coordinates")
			respondIfReply(msg, []byte(`{"error":"JWK missing coordinates"}`))
			return
		}

		entry, err := json.Marshal(identityEntry{
			PublicKey: payload.PublicKey,
			CreatedAt: time.Now().UnixMilli(),
		})
		if err != nil {
			slog.ErrorContext(ctx, "Failed to marshal identity key entry", "error", err)
			span.RecordError(err)
			respondIfReply(msg, []byte(`{"error":"internal error"}`))
			return
		}

		if _, err := identityKV.Put(ctx, payload.Username, entry); err != nil {
			slog.ErrorContext(ctx, "Failed to store identity key", "error", err, "username", payload.Username)
			span.RecordError(err)
			respondIfReply(msg, []byte(`{"error":"storage failed"}`))
			return
		}

		requestCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("operation", "identity_publish")))
		slog.InfoContext(ctx, "Stored identity key", "username", payload.Username)
		respondIfReply(msg, []byte(`{"ok":true}`))
	})
	if err != nil {
		slog.Error("Failed to subscribe to e2ee.identity.publish", "error", err)
		os.Exit(1)
	}

	// Handle identity key get: e2ee.keys.get.{username}
	_, err = nc.QueueSubscribe("e2ee.keys.get.>", "e2ee-key-workers", func(msg *nats.Msg) {
		ctx, span := otelhelper.StartServerSpan(context.Background(), msg, "e2ee keys get")
		defer span.End()

		parts := strings.Split(msg.Subject, ".")
		if len(parts) < 4 {
			if err := msg.Respond([]byte(`{"error":"invalid subject"}`)); err != nil {
				slog.WarnContext(ctx, "Failed to respond", "error", err)
			}
			return
		}
		username := strings.Join(parts[3:], ".")
		span.SetAttributes(attribute.String("e2ee.username", username))

		entry, err := identityKV.Get(ctx, username)
		if err != nil {
			if errors.Is(err, jetstream.ErrKeyNotFound) {
				if err := msg.Respond([]byte(`{"error":"not found"}`)); err != nil {
					slog.WarnContext(ctx, "Failed to respond", "error", err)
				}
			} else {
				slog.ErrorContext(ctx, "KV infrastructure error fetching identity key", "error", err, "username", username)
				span.RecordError(err)
				if err := msg.Respond([]byte(`{"error":"internal error"}`)); err != nil {
					slog.WarnContext(ctx, "Failed to respond", "error", err)
				}
			}
			return
		}

		if err := msg.Respond(entry.Value()); err != nil {
			slog.WarnContext(ctx, "Failed to respond with identity key", "error", err)
		}
		requestCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("operation", "keys_get")))
	})
	if err != nil {
		slog.Error("Failed to subscribe to e2ee.keys.get.>", "error", err)
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
			respondIfReply(msg, []byte(`{"error":"invalid payload"}`))
			return
		}

		span.SetAttributes(
			attribute.String("e2ee.room", payload.Room),
			attribute.Int("e2ee.epoch", payload.Epoch),
			attribute.String("e2ee.recipient", payload.Recipient),
		)

		// Verify the caller's authenticated username matches the sender field
		// to prevent users from injecting wrapped keys claiming to be another user.
		callerUser := getNatsUser(msg)
		if callerUser == "" {
			slog.WarnContext(ctx, "Roomkey distribute rejected: missing Nats-User header",
				"room", payload.Room, "recipient", payload.Recipient)
			respondIfReply(msg, []byte(`{"error":"unauthorized"}`))
			return
		}
		if callerUser != payload.Sender {
			slog.WarnContext(ctx, "Roomkey distribute rejected: caller does not match sender",
				"caller", callerUser, "sender", payload.Sender, "room", payload.Room)
			respondIfReply(msg, []byte(`{"error":"caller does not match sender"}`))
			return
		}

		// Verify caller is a member of the room
		membersReply, membersErr := nc.Request("room.members."+payload.Room, nil, 3*time.Second)
		if membersErr != nil {
			slog.WarnContext(ctx, "Roomkey distribute rejected: membership check failed",
				"caller", callerUser, "room", payload.Room, "error", membersErr)
			respondIfReply(msg, []byte(`{"error":"membership check failed"}`))
			return
		}
		var members []string
		if err := json.Unmarshal(membersReply.Data, &members); err != nil {
			slog.WarnContext(ctx, "Roomkey distribute rejected: failed to parse members list",
				"caller", callerUser, "room", payload.Room, "error", err)
			respondIfReply(msg, []byte(`{"error":"membership check failed"}`))
			return
		}
		isMember := false
		for _, m := range members {
			if m == callerUser {
				isMember = true
				break
			}
		}
		if !isMember {
			slog.WarnContext(ctx, "Roomkey distribute rejected: caller is not a room member",
				"caller", callerUser, "room", payload.Room)
			respondIfReply(msg, []byte(`{"error":"not a room member"}`))
			return
		}

		// Key format: {room}.{epoch}.{recipient}
		kvKey := sanitizeKVKey(payload.Room) + "." + intToStr(payload.Epoch) + "." + sanitizeKVKey(payload.Recipient)

		entry, err := json.Marshal(wrappedKeyEntry{
			WrappedKey: payload.WrappedKey,
			Sender:     payload.Sender,
			Epoch:      payload.Epoch,
		})
		if err != nil {
			slog.ErrorContext(ctx, "Failed to marshal room key entry", "error", err)
			span.RecordError(err)
			respondIfReply(msg, []byte(`{"error":"internal error"}`))
			return
		}

		if _, err := roomKeysKV.Put(ctx, kvKey, entry); err != nil {
			slog.ErrorContext(ctx, "Failed to store room key", "error", err, "room", payload.Room, "recipient", payload.Recipient)
			span.RecordError(err)
			respondIfReply(msg, []byte(`{"error":"storage failed"}`))
			return
		}

		requestCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("operation", "roomkey_distribute")))
		slog.InfoContext(ctx, "Stored wrapped room key", "room", payload.Room, "epoch", payload.Epoch, "recipient", payload.Recipient)
		respondIfReply(msg, []byte(`{"ok":true}`))
	})
	if err != nil {
		slog.Error("Failed to subscribe to e2ee.roomkey.distribute", "error", err)
		os.Exit(1)
	}

	// Handle room key get: e2ee.roomkey.get.{room}.{username}
	// Uses ">" wildcard to support room names that may contain dots.
	// Username is always the last token; room is everything between "get." and the last token.
	_, err = nc.QueueSubscribe("e2ee.roomkey.get.>", "e2ee-key-workers", func(msg *nats.Msg) {
		ctx, span := otelhelper.StartServerSpan(context.Background(), msg, "e2ee roomkey get")
		defer span.End()

		parts := strings.Split(msg.Subject, ".")
		if len(parts) < 5 {
			if err := msg.Respond([]byte(`{"wrappedKeys":[]}`)); err != nil {
				slog.WarnContext(ctx, "Failed to respond", "error", err)
			}
			return
		}
		// Username is last token, room is everything between index 3 and last
		username := parts[len(parts)-1]
		room := strings.Join(parts[3:len(parts)-1], ".")
		span.SetAttributes(
			attribute.String("e2ee.room", room),
			attribute.String("e2ee.username", username),
		)

		// List keys matching {room}.*.{username} using prefix-based listing
		sanitizedRoom := sanitizeKVKey(room)
		sanitizedUser := sanitizeKVKey(username)
		prefix := sanitizedRoom + "."
		suffix := "." + sanitizedUser

		var wrappedKeys []json.RawMessage
		lister, err := roomKeysKV.ListKeys(ctx, jetstream.MetaOnly())
		if err != nil {
			slog.WarnContext(ctx, "Failed to list room keys", "error", err, "room", room, "username", username)
			resp, _ := json.Marshal(map[string]interface{}{"error": "key lookup failed"})
			if err := msg.Respond(resp); err != nil {
				slog.WarnContext(ctx, "Failed to respond with error", "error", err)
			}
			return
		}
		for key := range lister.Keys() {
			if !strings.HasPrefix(key, prefix) {
				continue
			}
			if !strings.HasSuffix(key, suffix) {
				continue
			}
			entry, err := roomKeysKV.Get(ctx, key)
			if err != nil {
				slog.WarnContext(ctx, "Failed to get room key entry", "error", err, "key", key)
				continue
			}
			wrappedKeys = append(wrappedKeys, entry.Value())
		}

		if wrappedKeys == nil {
			wrappedKeys = []json.RawMessage{}
		}

		resp, err := json.Marshal(map[string]interface{}{
			"wrappedKeys": wrappedKeys,
		})
		if err != nil {
			slog.ErrorContext(ctx, "Failed to marshal wrapped keys response", "error", err)
			if err := msg.Respond([]byte(`{"error":"marshal failed"}`)); err != nil {
				slog.WarnContext(ctx, "Failed to respond", "error", err)
			}
			return
		}
		if err := msg.Respond(resp); err != nil {
			slog.WarnContext(ctx, "Failed to respond with wrapped keys", "error", err)
		}
		requestCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("operation", "roomkey_get")))
	})
	if err != nil {
		slog.Error("Failed to subscribe to e2ee.roomkey.get.>", "error", err)
		os.Exit(1)
	}

	// Handle raw room key publish: e2ee.roomkey.raw
	// Browser publishes raw key so persist-worker can decrypt messages server-side.
	// Any authenticated room member may publish (e.g. after winning a CAS race during key rotation).
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

		// Verify that the caller is authenticated
		callerUser := getNatsUser(msg)
		if callerUser == "" {
			slog.WarnContext(ctx, "Raw key publish rejected: missing Nats-User header", "room", payload.Room)
			respondIfReply(msg, []byte(`{"error":"unauthorized"}`))
			return
		}

		// Validate raw key: must be a valid base64-encoded 32-byte AES-256 key
		keyBytes, decodeErr := base64.StdEncoding.DecodeString(payload.RawKey)
		if decodeErr != nil || len(keyBytes) != 32 {
			slog.WarnContext(ctx, "Raw key publish rejected: invalid key (must be 32 bytes base64)",
				"caller", callerUser, "room", payload.Room, "decodedLen", len(keyBytes))
			respondIfReply(msg, []byte(`{"error":"invalid key format"}`))
			return
		}

		// Verify caller is a member of the room
		membersReply, membersErr := nc.Request("room.members."+payload.Room, nil, 3*time.Second)
		if membersErr != nil {
			slog.WarnContext(ctx, "Raw key publish rejected: membership check failed",
				"caller", callerUser, "room", payload.Room, "error", membersErr)
			respondIfReply(msg, []byte(`{"error":"membership check failed"}`))
			return
		}
		var members []string
		if err := json.Unmarshal(membersReply.Data, &members); err != nil {
			slog.WarnContext(ctx, "Raw key publish rejected: failed to parse members list",
				"caller", callerUser, "room", payload.Room, "error", err)
			respondIfReply(msg, []byte(`{"error":"membership check failed"}`))
			return
		}
		isMember := false
		for _, m := range members {
			if m == callerUser {
				isMember = true
				break
			}
		}
		if !isMember {
			slog.WarnContext(ctx, "Raw key publish rejected: caller is not a room member",
				"caller", callerUser, "room", payload.Room)
			respondIfReply(msg, []byte(`{"error":"not a room member"}`))
			return
		}

		kvKey := sanitizeKVKey(payload.Room) + "." + intToStr(payload.Epoch)
		if _, err := roomKeysRawKV.Put(ctx, kvKey, []byte(payload.RawKey)); err != nil {
			slog.ErrorContext(ctx, "Failed to store raw room key", "error", err, "room", payload.Room)
			span.RecordError(err)
			respondIfReply(msg, []byte(`{"error":"storage failed"}`))
			return
		}

		requestCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("operation", "roomkey_raw_store")))
		slog.InfoContext(ctx, "Stored raw room key", "room", payload.Room, "epoch", payload.Epoch)
		respondIfReply(msg, []byte(`{"ok":true}`))
	})
	if err != nil {
		slog.Error("Failed to subscribe to e2ee.roomkey.raw", "error", err)
		os.Exit(1)
	}

	// Handle raw room key get: e2ee.roomkey.raw.get.{room}.{epoch}
	// Used by persist-worker to fetch key for decryption.
	// Uses ">" wildcard to support room names with dots. Epoch is always the last token.
	_, err = nc.QueueSubscribe("e2ee.roomkey.raw.get.>", "e2ee-key-workers", func(msg *nats.Msg) {
		ctx, span := otelhelper.StartServerSpan(context.Background(), msg, "e2ee roomkey raw get")
		defer span.End()

		parts := strings.Split(msg.Subject, ".")
		if len(parts) < 6 {
			if err := msg.Respond([]byte(`{"error":"invalid subject"}`)); err != nil {
				slog.WarnContext(ctx, "Failed to respond", "error", err)
			}
			return
		}
		// Epoch is last token, room is everything between index 4 and last
		epoch := parts[len(parts)-1]
		room := strings.Join(parts[4:len(parts)-1], ".")
		span.SetAttributes(
			attribute.String("e2ee.room", room),
			attribute.String("e2ee.epoch", epoch),
		)

		kvKey := sanitizeKVKey(room) + "." + epoch
		entry, err := roomKeysRawKV.Get(ctx, kvKey)
		if err != nil {
			if errors.Is(err, jetstream.ErrKeyNotFound) {
				if err := msg.Respond([]byte(`{"error":"not found"}`)); err != nil {
					slog.WarnContext(ctx, "Failed to respond", "error", err)
				}
			} else {
				slog.ErrorContext(ctx, "KV infrastructure error fetching raw key", "error", err, "room", room, "epoch", epoch)
				span.RecordError(err)
				if err := msg.Respond([]byte(`{"error":"internal error"}`)); err != nil {
					slog.WarnContext(ctx, "Failed to respond", "error", err)
				}
			}
			return
		}

		resp, err := json.Marshal(map[string]string{
			"rawKey": string(entry.Value()),
		})
		if err != nil {
			slog.ErrorContext(ctx, "Failed to marshal raw key response", "error", err)
			if err := msg.Respond([]byte(`{"error":"marshal failed"}`)); err != nil {
				slog.WarnContext(ctx, "Failed to respond", "error", err)
			}
			return
		}
		if err := msg.Respond(resp); err != nil {
			slog.WarnContext(ctx, "Failed to respond with raw key", "error", err)
		}
		requestCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("operation", "roomkey_raw_get")))
	})
	if err != nil {
		slog.Error("Failed to subscribe to e2ee.roomkey.raw.get.>", "error", err)
		os.Exit(1)
	}

	// Handle room E2EE enable: e2ee.room.enable.{room}
	_, err = nc.QueueSubscribe("e2ee.room.enable.>", "e2ee-key-workers", func(msg *nats.Msg) {
		ctx, span := otelhelper.StartServerSpan(context.Background(), msg, "e2ee room enable")
		defer span.End()

		parts := strings.Split(msg.Subject, ".")
		if len(parts) < 4 {
			if err := msg.Respond([]byte(`{"error":"invalid subject"}`)); err != nil {
				slog.WarnContext(ctx, "Failed to respond", "error", err)
			}
			return
		}
		room := strings.Join(parts[3:], ".")

		var payload struct {
			Room         string `json:"room"`
			CurrentEpoch int    `json:"currentEpoch"`
			Initiator    string `json:"initiator"`
		}
		if err := json.Unmarshal(msg.Data, &payload); err != nil {
			slog.WarnContext(ctx, "Failed to unmarshal room enable", "error", err)
			if err := msg.Respond([]byte(`{"error":"invalid payload"}`)); err != nil {
				slog.WarnContext(ctx, "Failed to respond", "error", err)
			}
			return
		}

		span.SetAttributes(attribute.String("e2ee.room", room))

		// Verify the caller's authenticated identity matches the claimed initiator
		callerUser := getNatsUser(msg)
		if callerUser == "" {
			slog.WarnContext(ctx, "Room enable rejected: missing Nats-User header", "room", room)
			if err := msg.Respond([]byte(`{"error":"unauthorized"}`)); err != nil {
				slog.WarnContext(ctx, "Failed to respond", "error", err)
			}
			return
		}
		if callerUser != payload.Initiator {
			slog.WarnContext(ctx, "Room enable rejected: caller does not match initiator",
				"caller", callerUser, "initiator", payload.Initiator, "room", room)
			if err := msg.Respond([]byte(`{"error":"caller does not match initiator"}`)); err != nil {
				slog.WarnContext(ctx, "Failed to respond", "error", err)
			}
			return
		}

		meta, err := json.Marshal(roomMeta{
			Enabled:      true,
			CurrentEpoch: payload.CurrentEpoch,
			Initiator:    payload.Initiator,
		})
		if err != nil {
			slog.ErrorContext(ctx, "Failed to marshal room enable meta", "error", err)
			span.RecordError(err)
			if err := msg.Respond([]byte(`{"error":"marshal failed"}`)); err != nil {
				slog.WarnContext(ctx, "Failed to respond", "error", err)
			}
			return
		}

		if _, err := roomMetaKV.Put(ctx, sanitizeKVKey(room), meta); err != nil {
			slog.ErrorContext(ctx, "Failed to enable E2EE for room", "error", err, "room", room)
			span.RecordError(err)
			if err := msg.Respond([]byte(`{"error":"failed to store"}`)); err != nil {
				slog.WarnContext(ctx, "Failed to respond", "error", err)
			}
			return
		}

		if err := msg.Respond([]byte(`{"ok":true}`)); err != nil {
			slog.WarnContext(ctx, "Failed to respond", "error", err)
		}
		requestCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("operation", "room_enable")))
		slog.InfoContext(ctx, "E2EE enabled for room", "room", room, "epoch", payload.CurrentEpoch, "initiator", payload.Initiator)
	})
	if err != nil {
		slog.Error("Failed to subscribe to e2ee.room.enable.>", "error", err)
		os.Exit(1)
	}

	// Handle room E2EE disable: e2ee.room.disable.{room}
	_, err = nc.QueueSubscribe("e2ee.room.disable.>", "e2ee-key-workers", func(msg *nats.Msg) {
		ctx, span := otelhelper.StartServerSpan(context.Background(), msg, "e2ee room disable")
		defer span.End()

		parts := strings.Split(msg.Subject, ".")
		if len(parts) < 4 {
			if err := msg.Respond([]byte(`{"error":"invalid subject"}`)); err != nil {
				slog.WarnContext(ctx, "Failed to respond", "error", err)
			}
			return
		}
		room := strings.Join(parts[3:], ".")
		span.SetAttributes(attribute.String("e2ee.room", room))

		// Verify caller identity
		callerUser := getNatsUser(msg)
		if callerUser == "" {
			slog.WarnContext(ctx, "Room disable rejected: missing Nats-User header", "room", room)
			if err := msg.Respond([]byte(`{"error":"unauthorized"}`)); err != nil {
				slog.WarnContext(ctx, "Failed to respond", "error", err)
			}
			return
		}

		// Only the original initiator can disable E2EE
		existingEntry, existingErr := roomMetaKV.Get(ctx, sanitizeKVKey(room))
		if existingErr == nil {
			var existingMeta roomMeta
			if json.Unmarshal(existingEntry.Value(), &existingMeta) == nil && existingMeta.Initiator != "" && existingMeta.Initiator != callerUser {
				slog.WarnContext(ctx, "Room disable rejected: caller is not room initiator",
					"caller", callerUser, "initiator", existingMeta.Initiator, "room", room)
				if err := msg.Respond([]byte(`{"error":"only initiator can disable E2EE"}`)); err != nil {
					slog.WarnContext(ctx, "Failed to respond", "error", err)
				}
				return
			}
		}

		meta, err := json.Marshal(roomMeta{
			Enabled: false,
		})
		if err != nil {
			slog.ErrorContext(ctx, "Failed to marshal room disable meta", "error", err)
			span.RecordError(err)
			if err := msg.Respond([]byte(`{"error":"marshal failed"}`)); err != nil {
				slog.WarnContext(ctx, "Failed to respond", "error", err)
			}
			return
		}

		if _, err := roomMetaKV.Put(ctx, sanitizeKVKey(room), meta); err != nil {
			slog.ErrorContext(ctx, "Failed to disable E2EE for room", "error", err, "room", room)
			span.RecordError(err)
			if err := msg.Respond([]byte(`{"error":"failed to store"}`)); err != nil {
				slog.WarnContext(ctx, "Failed to respond", "error", err)
			}
			return
		}

		if err := msg.Respond([]byte(`{"ok":true}`)); err != nil {
			slog.WarnContext(ctx, "Failed to respond", "error", err)
		}
		requestCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("operation", "room_disable")))
		slog.InfoContext(ctx, "E2EE disabled for room", "room", room)
	})
	if err != nil {
		slog.Error("Failed to subscribe to e2ee.room.disable.>", "error", err)
		os.Exit(1)
	}

	// Handle room meta get: e2ee.room.meta.{room}
	_, err = nc.QueueSubscribe("e2ee.room.meta.>", "e2ee-key-workers", func(msg *nats.Msg) {
		ctx, span := otelhelper.StartServerSpan(context.Background(), msg, "e2ee room meta")
		defer span.End()

		parts := strings.Split(msg.Subject, ".")
		if len(parts) < 4 {
			if err := msg.Respond([]byte(`{"enabled":false}`)); err != nil {
				slog.WarnContext(ctx, "Failed to respond", "error", err)
			}
			return
		}
		room := strings.Join(parts[3:], ".")
		span.SetAttributes(attribute.String("e2ee.room", room))

		entry, err := roomMetaKV.Get(ctx, sanitizeKVKey(room))
		if err != nil {
			if errors.Is(err, jetstream.ErrKeyNotFound) {
				if err := msg.Respond([]byte(`{"enabled":false}`)); err != nil {
					slog.WarnContext(ctx, "Failed to respond", "error", err)
				}
			} else {
				slog.ErrorContext(ctx, "KV infrastructure error fetching room meta", "error", err, "room", room)
				span.RecordError(err)
				if err := msg.Respond([]byte(`{"error":"internal error"}`)); err != nil {
					slog.WarnContext(ctx, "Failed to respond", "error", err)
				}
			}
			return
		}

		if err := msg.Respond(entry.Value()); err != nil {
			slog.WarnContext(ctx, "Failed to respond with room meta", "error", err)
		}
		requestCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("operation", "room_meta")))
	})
	if err != nil {
		slog.Error("Failed to subscribe to e2ee.room.meta.>", "error", err)
		os.Exit(1)
	}

	// Handle room meta update (epoch bump): e2ee.room.epoch.{room}
	_, err = nc.QueueSubscribe("e2ee.room.epoch.>", "e2ee-key-workers", func(msg *nats.Msg) {
		ctx, span := otelhelper.StartServerSpan(context.Background(), msg, "e2ee room epoch update")
		defer span.End()

		parts := strings.Split(msg.Subject, ".")
		if len(parts) < 4 {
			if err := msg.Respond([]byte(`{"error":"invalid subject"}`)); err != nil {
				slog.WarnContext(ctx, "Failed to respond", "error", err)
			}
			return
		}
		room := strings.Join(parts[3:], ".")

		var payload struct {
			NewEpoch int `json:"newEpoch"`
		}
		if err := json.Unmarshal(msg.Data, &payload); err != nil {
			if err := msg.Respond([]byte(`{"error":"invalid payload"}`)); err != nil {
				slog.WarnContext(ctx, "Failed to respond", "error", err)
			}
			return
		}

		span.SetAttributes(attribute.String("e2ee.room", room), attribute.Int("e2ee.epoch", payload.NewEpoch))

		// Verify caller identity
		callerUser := getNatsUser(msg)
		if callerUser == "" {
			slog.WarnContext(ctx, "Epoch update rejected: missing Nats-User header", "room", room)
			if err := msg.Respond([]byte(`{"error":"unauthorized"}`)); err != nil {
				slog.WarnContext(ctx, "Failed to respond", "error", err)
			}
			return
		}

		// Read current meta and update epoch using CAS (compare-and-swap)
		// to prevent race conditions when multiple clients try to bump epoch concurrently.
		entry, err := roomMetaKV.Get(ctx, sanitizeKVKey(room))
		if err != nil {
			if err := msg.Respond([]byte(`{"error":"room not found"}`)); err != nil {
				slog.WarnContext(ctx, "Failed to respond", "error", err)
			}
			return
		}

		var meta roomMeta
		if err := json.Unmarshal(entry.Value(), &meta); err != nil {
			if err := msg.Respond([]byte(`{"error":"corrupt meta"}`)); err != nil {
				slog.WarnContext(ctx, "Failed to respond", "error", err)
			}
			return
		}

		// Enforce monotonically increasing epochs to prevent rollback attacks
		if payload.NewEpoch <= meta.CurrentEpoch {
			if err := msg.Respond([]byte(`{"error":"epoch must be greater than current"}`)); err != nil {
				slog.WarnContext(ctx, "Failed to respond", "error", err)
			}
			return
		}
		meta.CurrentEpoch = payload.NewEpoch

		updated, err := json.Marshal(meta)
		if err != nil {
			if err := msg.Respond([]byte(`{"error":"marshal failed"}`)); err != nil {
				slog.WarnContext(ctx, "Failed to respond", "error", err)
			}
			return
		}
		if _, err := roomMetaKV.Update(ctx, sanitizeKVKey(room), updated, entry.Revision()); err != nil {
			slog.WarnContext(ctx, "Epoch CAS conflict — client should retry", "error", err, "room", room)
			if err := msg.Respond([]byte(`{"error":"conflict, retry"}`)); err != nil {
				slog.WarnContext(ctx, "Failed to respond", "error", err)
			}
			return
		}

		if err := msg.Respond([]byte(`{"ok":true}`)); err != nil {
			slog.WarnContext(ctx, "Failed to respond", "error", err)
		}
		requestCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("operation", "room_epoch_update")))
		slog.InfoContext(ctx, "Updated room epoch", "room", room, "newEpoch", payload.NewEpoch)
	})
	if err != nil {
		slog.Error("Failed to subscribe to e2ee.room.epoch.>", "error", err)
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

// respondIfReply sends a response only if the message has a reply subject (request/reply pattern).
// Safe to call on fire-and-forget messages — it's a no-op if there's no reply subject.
func respondIfReply(msg *nats.Msg, data []byte) {
	if msg.Reply != "" {
		if err := msg.Respond(data); err != nil {
			slog.Warn("Failed to send reply", "error", err, "subject", msg.Subject)
		}
	}
}

// sanitizeKVKey replaces characters not allowed or ambiguous in NATS KV keys.
// Dots are replaced because the composite key format uses dots as delimiters
// (e.g. {room}.{epoch}.{recipient}). Wildcards and spaces are also replaced.
// WARNING: This creates a collision risk — "my.room" and "my_room" produce the same key.
// Acceptable because room names are constrained by the room-service and don't use underscores.
func sanitizeKVKey(s string) string {
	r := strings.NewReplacer(
		" ", "_",
		"*", "_",
		">", "_",
		".", "_",
	)
	return r.Replace(s)
}

func intToStr(n int) string {
	return strconv.Itoa(n)
}
