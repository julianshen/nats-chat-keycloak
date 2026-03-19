//go:build !testing

package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/XSAM/otelsql"
	otelhelper "github.com/example/nats-chat-otelhelper"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	_ "github.com/lib/pq"
	"github.com/nats-io/nats.go"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
)

// jwtMiddleware validates JWT tokens from Keycloak using the golang-jwt library.
func (a *jwtAuth) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		if !strings.HasPrefix(auth, "Bearer ") {
			http.Error(w, "missing token", http.StatusUnauthorized)
			return
		}
		tokenStr := strings.TrimPrefix(auth, "Bearer ")

		token, err := jwt.Parse(tokenStr, func(t *jwt.Token) (interface{}, error) {
			kid, ok := t.Header["kid"].(string)
			if !ok {
				return nil, jwt.ErrTokenMalformed
			}
			return a.getKey(kid)
		})
		if err != nil || !token.Valid {
			http.Error(w, "invalid token", http.StatusUnauthorized)
			return
		}

		claims, ok := token.Claims.(jwt.MapClaims)
		if !ok {
			http.Error(w, "invalid claims", http.StatusUnauthorized)
			return
		}

		username, _ := claims["preferred_username"].(string)
		if username == "" {
			http.Error(w, "no username in token", http.StatusUnauthorized)
			return
		}

		ctx := context.WithValue(r.Context(), ctxUsernameKey, username)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// handleFileInfoNATS handles NATS request/reply for file metadata.
func (h *handlers) handleFileInfoNATS(msg *nats.Msg) {
	_, span := otelhelper.StartServerSpan(context.Background(), msg, "file info")
	defer span.End()

	parts := strings.Split(msg.Subject, ".")
	if len(parts) < 3 {
		msg.Respond([]byte(`{"error":"invalid subject"}`))
		return
	}
	id := parts[2]
	span.SetAttributes(attribute.String("file.id", id))

	h.filesMu.RLock()
	meta, ok := h.files[id]
	h.filesMu.RUnlock()

	if !ok && h.db != nil {
		ctx := context.Background()
		row := h.db.QueryRowContext(ctx,
			`SELECT id, room, uploader, filename, size, content_type, EXTRACT(EPOCH FROM created_at)::bigint * 1000 FROM files WHERE id = $1`, id)
		if err := row.Scan(&meta.ID, &meta.Room, &meta.Uploader, &meta.Filename, &meta.Size, &meta.ContentType, &meta.CreatedAt); err == nil {
			ok = true
			h.filesMu.Lock()
			h.files[id] = meta
			h.filesMu.Unlock()
		}
	}

	if !ok {
		msg.Respond([]byte(`{"error":"not found"}`))
		return
	}

	data, _ := json.Marshal(meta)
	msg.Respond(data)
}

// handleFileListNATS handles NATS request/reply for listing files in a room.
func (h *handlers) handleFileListNATS(msg *nats.Msg) {
	ctx, span := otelhelper.StartServerSpan(context.Background(), msg, "file list")
	defer span.End()

	parts := strings.Split(msg.Subject, ".")
	if len(parts) < 3 {
		msg.Respond([]byte(`[]`))
		return
	}
	room := parts[2]
	span.SetAttributes(attribute.String("file.room", room))

	if h.db == nil {
		h.filesMu.RLock()
		var result []FileMetadata
		for _, f := range h.files {
			if f.Room == room {
				result = append(result, f)
			}
		}
		h.filesMu.RUnlock()
		if result == nil {
			result = []FileMetadata{}
		}
		data, _ := json.Marshal(result)
		msg.Respond(data)
		return
	}

	rows, err := h.db.QueryContext(ctx,
		`SELECT id, room, uploader, filename, size, content_type, EXTRACT(EPOCH FROM created_at)::bigint * 1000 FROM files WHERE room = $1 ORDER BY created_at DESC LIMIT 50`, room)
	if err != nil {
		slog.ErrorContext(ctx, "Failed to query files", "room", room, "error", err)
		msg.Respond([]byte(`[]`))
		return
	}
	defer rows.Close()

	var result []FileMetadata
	for rows.Next() {
		var f FileMetadata
		if err := rows.Scan(&f.ID, &f.Room, &f.Uploader, &f.Filename, &f.Size, &f.ContentType, &f.CreatedAt); err != nil {
			continue
		}
		result = append(result, f)
	}
	if result == nil {
		result = []FileMetadata{}
	}
	data, _ := json.Marshal(result)
	msg.Respond(data)
}

func main() {
	ctx := context.Background()

	otelShutdown, err := otelhelper.Init(ctx)
	if err != nil {
		slog.Error("Failed to initialize OpenTelemetry", "error", err)
		os.Exit(1)
	}
	defer otelShutdown(ctx)

	meter := otel.Meter("file-upload-service")
	uploadCounter, _ := meter.Int64Counter("file_uploads_total")
	uploadDuration, _ := otelhelper.NewDurationHistogram(meter, "file_upload_duration_seconds", "File upload duration")

	natsURL := envOrDefault("NATS_URL", "nats://localhost:4222")
	natsUser := envOrDefault("NATS_USER", "file-upload-service")
	natsPass := envOrDefault("NATS_PASS", "file-upload-service-secret")
	dbURL := envOrDefault("DATABASE_URL", "postgres://chat:chat-secret@localhost:5432/chatdb?sslmode=disable")
	jwksURL := envOrDefault("KEYCLOAK_JWKS_URL", "http://keycloak:8080/realms/nats-chat/protocol/openid-connect/certs")
	uploadDir := envOrDefault("UPLOAD_DIR", "/data/uploads")
	httpPort := envOrDefault("HTTP_PORT", "8094")
	maxUploadStr := envOrDefault("MAX_UPLOAD_SIZE", "52428800")

	maxUploadSize, err := strconv.ParseInt(maxUploadStr, 10, 64)
	if err != nil {
		maxUploadSize = 50 * 1024 * 1024
	}

	slog.Info("Starting File Upload Service", "port", httpPort, "upload_dir", uploadDir)

	// Connect to PostgreSQL
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

	// Connect to NATS
	var nc *nats.Conn
	for attempt := 1; attempt <= 30; attempt++ {
		nc, err = nats.Connect(natsURL,
			nats.UserInfo(natsUser, natsPass),
			nats.Name("file-upload-service"),
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

	// Initialize storage and handlers
	storage := NewLocalStorage(uploadDir)
	h := &handlers{
		storage:       storage,
		db:            db,
		maxUploadSize: maxUploadSize,
		genID:         func() string { return uuid.New().String() },
		files:         make(map[string]FileMetadata),
	}

	// NATS subscriptions for metadata queries
	_, err = nc.QueueSubscribe("file.info.*", "file-upload-workers", h.handleFileInfoNATS)
	if err != nil {
		slog.Error("Failed to subscribe to file.info.*", "error", err)
		os.Exit(1)
	}
	_, err = nc.QueueSubscribe("file.list.*", "file-upload-workers", h.handleFileListNATS)
	if err != nil {
		slog.Error("Failed to subscribe to file.list.*", "error", err)
		os.Exit(1)
	}
	slog.Info("Subscribed to file.info.* and file.list.* (queue group: file-upload-workers)")

	// JWT auth middleware
	auth := newJWTAuth(jwksURL)
	if err := auth.fetchKeys(); err != nil {
		slog.Warn("Initial JWKS fetch failed (will retry on first request)", "error", err)
	}

	// HTTP server with metrics-wrapped handlers
	mux := http.NewServeMux()
	mux.Handle("POST /upload", auth.middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		h.handleUpload(w, r)
		duration := time.Since(start).Seconds()
		uploadCounter.Add(r.Context(), 1)
		uploadDuration.Record(r.Context(), duration)
	})))
	mux.Handle("GET /files/{id}", auth.middleware(http.HandlerFunc(h.handleDownload)))

	handler := corsMiddleware(mux)

	server := &http.Server{
		Addr:    ":" + httpPort,
		Handler: handler,
	}

	go func() {
		slog.Info("HTTP server listening", "port", httpPort)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("HTTP server error", "error", err)
		}
	}()

	sigCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	<-sigCtx.Done()

	slog.Info("Shutting down file-upload service")
	nc.Drain()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	server.Shutdown(shutdownCtx)
}
