//go:build !testing

package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/XSAM/otelsql"
	otelhelper "github.com/example/nats-chat-otelhelper"
	"github.com/google/uuid"
	_ "github.com/lib/pq"
	"github.com/nats-io/nats.go"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
)

func getNatsUser(msg *nats.Msg) string {
	if msg.Header != nil {
		if u := msg.Header.Get("Nats-User"); u != "" {
			return u
		}
	}
	// Fallback: parse from request body if the sender included it
	var body struct {
		Username string `json:"username"`
	}
	if err := json.Unmarshal(msg.Data, &body); err == nil && body.Username != "" {
		return body.Username
	}
	return ""
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
	requestCounter, _ := meter.Int64Counter("file_requests_total")
	requestDuration, _ := otelhelper.NewDurationHistogram(meter, "file_request_duration_seconds", "Request duration")

	natsURL := envOrDefault("NATS_URL", "nats://localhost:4222")
	natsUser := envOrDefault("NATS_USER", "file-upload-service")
	natsPass := envOrDefault("NATS_PASS", "file-upload-service-secret")
	dbURL := envOrDefault("DATABASE_URL", "postgres://chat:chat-secret@localhost:5432/chatdb?sslmode=disable")
	mediaBaseURL := envOrDefault("MEDIA_BASE_URL", "http://media-server:8095")
	tokenSecret := envOrDefault("MEDIA_TOKEN_SECRET", "change-me-in-production")
	tokenTTLStr := envOrDefault("TOKEN_TTL_SECONDS", "300")

	tokenTTL := 5 * time.Minute
	if v, err := time.ParseDuration(tokenTTLStr + "s"); err == nil {
		tokenTTL = v
	}

	slog.Info("Starting File Upload Service (NATS microservice)")

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

	svc := &service{
		db:           db,
		mediaBaseURL: mediaBaseURL,
		tokenSecret:  []byte(tokenSecret),
		tokenTTL:     tokenTTL,
		genID:        func() string { return uuid.New().String() },
		checkMembership: func(room, username string) bool {
			reply, err := nc.Request("room.members."+room, []byte("{}"), 2*time.Second)
			if err != nil {
				slog.Warn("Membership check failed (fail-closed)", "room", room, "user", username, "error", err)
				return false
			}
			var members []string
			if err := json.Unmarshal(reply.Data, &members); err != nil {
				slog.Warn("Invalid room.members response", "room", room, "error", err)
				return false
			}
			for _, m := range members {
				if m == username {
					return true
				}
			}
			return false
		},
	}

	// file.upload.request — check membership, return pre-signed upload URL
	nc.QueueSubscribe("file.upload.request", "file-upload-workers", func(msg *nats.Msg) {
		start := time.Now()
		_, span := otelhelper.StartServerSpan(context.Background(), msg, "file upload request")
		defer span.End()

		username := getNatsUser(msg)
		span.SetAttributes(attribute.String("user", username))

		resp, _ := svc.handleUploadRequest(username, msg.Data)
		msg.Respond(resp)

		requestCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("type", "upload_request")))
		requestDuration.Record(ctx, time.Since(start).Seconds(), metric.WithAttributes(attribute.String("type", "upload_request")))
	})

	// file.download.request — check membership, return pre-signed download URL
	nc.QueueSubscribe("file.download.request", "file-upload-workers", func(msg *nats.Msg) {
		start := time.Now()
		_, span := otelhelper.StartServerSpan(context.Background(), msg, "file download request")
		defer span.End()

		username := getNatsUser(msg)
		span.SetAttributes(attribute.String("user", username))

		resp, _ := svc.handleDownloadRequest(username, msg.Data)
		msg.Respond(resp)

		requestCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("type", "download_request")))
		requestDuration.Record(ctx, time.Since(start).Seconds(), metric.WithAttributes(attribute.String("type", "download_request")))
	})

	// file.uploaded — persist metadata after successful upload
	nc.QueueSubscribe("file.uploaded", "file-upload-workers", func(msg *nats.Msg) {
		_, span := otelhelper.StartServerSpan(context.Background(), msg, "file uploaded")
		defer span.End()

		username := getNatsUser(msg)
		resp, _ := svc.handleUploaded(username, msg.Data)
		msg.Respond(resp)
	})

	// file.info.* — file metadata by ID
	nc.QueueSubscribe("file.info.*", "file-upload-workers", func(msg *nats.Msg) {
		_, span := otelhelper.StartServerSpan(context.Background(), msg, "file info")
		defer span.End()

		parts := strings.Split(msg.Subject, ".")
		if len(parts) < 3 {
			msg.Respond([]byte(`{"error":"invalid subject"}`))
			return
		}
		fileID := parts[2]
		span.SetAttributes(attribute.String("file.id", fileID))

		resp, _ := svc.handleFileInfo(fileID)
		msg.Respond(resp)
	})

	// file.list.* — list files in a room
	nc.QueueSubscribe("file.list.*", "file-upload-workers", func(msg *nats.Msg) {
		_, span := otelhelper.StartServerSpan(context.Background(), msg, "file list")
		defer span.End()

		parts := strings.Split(msg.Subject, ".")
		if len(parts) < 3 {
			msg.Respond([]byte(`[]`))
			return
		}
		room := parts[2]
		span.SetAttributes(attribute.String("file.room", room))

		resp, _ := svc.handleFileList(room)
		msg.Respond(resp)
	})

	slog.Info("Subscribed to file.upload.request, file.download.request, file.uploaded, file.info.*, file.list.*")

	sigCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	<-sigCtx.Done()

	slog.Info("Shutting down file-upload service")
	nc.Drain()
}
