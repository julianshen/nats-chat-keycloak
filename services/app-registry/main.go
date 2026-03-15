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
	_ "github.com/lib/pq"
	"github.com/nats-io/nats.go"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
)

type App struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	Description   string `json:"description,omitempty"`
	IconURL       string `json:"iconUrl,omitempty"`
	ComponentURL  string `json:"componentUrl"`
	SubjectPrefix string `json:"subjectPrefix"`
}

type ChannelApp struct {
	App
	InstalledBy string                 `json:"installedBy"`
	InstalledAt string                 `json:"installedAt"`
	Config      map[string]interface{} `json:"config,omitempty"`
}

type installRequest struct {
	AppID  string                 `json:"appId"`
	Config map[string]interface{} `json:"config,omitempty"`
	User   string                 `json:"user"`
}

type uninstallRequest struct {
	AppID string `json:"appId"`
	User  string `json:"user"`
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

	meter := otel.Meter("app-registry-service")
	reqCounter, _ := meter.Int64Counter("app_registry_requests_total",
		metric.WithDescription("Total app registry requests"))
	reqDuration, _ := otelhelper.NewDurationHistogram(meter, "app_registry_request_duration_seconds", "Duration of app registry requests")

	natsURL := envOrDefault("NATS_URL", "nats://localhost:4222")
	natsUser := envOrDefault("NATS_USER", "app-registry-service")
	natsPass := envOrDefault("NATS_PASS", "app-registry-service-secret")
	dbURL := envOrDefault("DATABASE_URL", "postgres://chat:chat-secret@localhost:5432/chatdb?sslmode=disable")

	db, err := otelsql.Open("postgres", dbURL,
		otelsql.WithAttributes(semconv.DBSystemPostgreSQL))
	if err != nil {
		slog.Error("Failed to connect to database", "error", err)
		os.Exit(1)
	}
	defer db.Close()
	otelsql.RegisterDBStatsMetrics(db, otelsql.WithAttributes(semconv.DBSystemPostgreSQL))

	for i := 0; i < 30; i++ {
		if err = db.Ping(); err == nil {
			break
		}
		slog.Info("Waiting for database", "attempt", i+1, "error", err)
		time.Sleep(2 * time.Second)
	}
	if err != nil {
		slog.Error("Database not ready", "error", err)
		os.Exit(1)
	}

	slog.Info("Starting App Registry Service", "nats_url", natsURL)

	var nc *nats.Conn
	for attempt := 1; attempt <= 30; attempt++ {
		nc, err = nats.Connect(natsURL,
			nats.UserInfo(natsUser, natsPass),
			nats.Name("app-registry-service"),
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

	// apps.list — return all registered apps
	_, err = nc.QueueSubscribe("apps.list", "app-registry-workers", func(msg *nats.Msg) {
		start := time.Now()
		ctx, span := otelhelper.StartServerSpan(context.Background(), msg, "apps.list")
		defer span.End()

		rows, err := db.QueryContext(ctx,
			"SELECT id, name, COALESCE(description,''), COALESCE(icon_url,''), component_url, subject_prefix FROM apps ORDER BY name")
		if err != nil {
			slog.ErrorContext(ctx, "Failed to query apps", "error", err)
			span.RecordError(err)
			msg.Respond([]byte("[]"))
			return
		}
		defer rows.Close()

		var apps []App
		for rows.Next() {
			var a App
			if err := rows.Scan(&a.ID, &a.Name, &a.Description, &a.IconURL, &a.ComponentURL, &a.SubjectPrefix); err != nil {
				slog.ErrorContext(ctx, "Failed to scan app", "error", err)
				continue
			}
			apps = append(apps, a)
		}
		if apps == nil {
			apps = []App{}
		}

		data, _ := json.Marshal(apps)
		msg.Respond(data)
		reqCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("action", "list")))
		reqDuration.Record(ctx, time.Since(start).Seconds(), metric.WithAttributes(attribute.String("action", "list")))
	})
	if err != nil {
		slog.Error("Failed to subscribe to apps.list", "error", err)
		os.Exit(1)
	}

	// apps.room.{room} — return apps installed in a room
	_, err = nc.QueueSubscribe("apps.room.*", "app-registry-workers", func(msg *nats.Msg) {
		start := time.Now()
		ctx, span := otelhelper.StartServerSpan(context.Background(), msg, "apps.room")
		defer span.End()

		room := strings.TrimPrefix(msg.Subject, "apps.room.")
		span.SetAttributes(attribute.String("app.room", room))

		rows, err := db.QueryContext(ctx, `
			SELECT a.id, a.name, COALESCE(a.description,''), COALESCE(a.icon_url,''), a.component_url, a.subject_prefix,
			       ca.installed_by, ca.installed_at, ca.config
			FROM room_apps ca
			JOIN apps a ON a.id = ca.app_id
			WHERE ca.room = $1
			ORDER BY ca.installed_at`, room)
		if err != nil {
			slog.ErrorContext(ctx, "Failed to query room apps", "error", err, "room", room)
			span.RecordError(err)
			msg.Respond([]byte("[]"))
			return
		}
		defer rows.Close()

		var result []ChannelApp
		for rows.Next() {
			var ca ChannelApp
			var configJSON []byte
			var installedAt time.Time
			if err := rows.Scan(&ca.ID, &ca.Name, &ca.Description, &ca.IconURL, &ca.ComponentURL, &ca.SubjectPrefix,
				&ca.InstalledBy, &installedAt, &configJSON); err != nil {
				slog.ErrorContext(ctx, "Failed to scan channel app", "error", err)
				continue
			}
			ca.InstalledAt = installedAt.Format(time.RFC3339)
			if len(configJSON) > 0 {
				json.Unmarshal(configJSON, &ca.Config)
			}
			result = append(result, ca)
		}
		if result == nil {
			result = []ChannelApp{}
		}

		data, _ := json.Marshal(result)
		msg.Respond(data)
		reqCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("action", "room")))
		reqDuration.Record(ctx, time.Since(start).Seconds(), metric.WithAttributes(attribute.String("action", "room")))
	})
	if err != nil {
		slog.Error("Failed to subscribe to apps.room.*", "error", err)
		os.Exit(1)
	}

	// apps.install.{room} — install an app in a room
	_, err = nc.QueueSubscribe("apps.install.*", "app-registry-workers", func(msg *nats.Msg) {
		start := time.Now()
		ctx, span := otelhelper.StartServerSpan(context.Background(), msg, "apps.install")
		defer span.End()

		room := strings.TrimPrefix(msg.Subject, "apps.install.")

		var req installRequest
		if err := json.Unmarshal(msg.Data, &req); err != nil {
			slog.ErrorContext(ctx, "Invalid install request", "error", err)
			span.RecordError(err)
			msg.Respond([]byte(`{"error":"invalid request"}`))
			return
		}
		span.SetAttributes(attribute.String("app.room", room), attribute.String("app.id", req.AppID))

		configJSON, _ := json.Marshal(req.Config)
		if req.Config == nil {
			configJSON = []byte("{}")
		}

		_, err := db.ExecContext(ctx,
			"INSERT INTO room_apps (room, app_id, installed_by, config) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
			room, req.AppID, req.User, configJSON)
		if err != nil {
			slog.ErrorContext(ctx, "Failed to install app", "error", err, "room", room, "appId", req.AppID)
			span.RecordError(err)
			msg.Respond([]byte(`{"error":"install failed"}`))
			return
		}

		msg.Respond([]byte(`{"ok":true}`))
		slog.InfoContext(ctx, "App installed", "room", room, "appId", req.AppID, "by", req.User)
		reqCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("action", "install")))
		reqDuration.Record(ctx, time.Since(start).Seconds(), metric.WithAttributes(attribute.String("action", "install")))
	})
	if err != nil {
		slog.Error("Failed to subscribe to apps.install.*", "error", err)
		os.Exit(1)
	}

	// apps.uninstall.{room} — remove an app from a room
	_, err = nc.QueueSubscribe("apps.uninstall.*", "app-registry-workers", func(msg *nats.Msg) {
		start := time.Now()
		ctx, span := otelhelper.StartServerSpan(context.Background(), msg, "apps.uninstall")
		defer span.End()

		room := strings.TrimPrefix(msg.Subject, "apps.uninstall.")

		var req uninstallRequest
		if err := json.Unmarshal(msg.Data, &req); err != nil {
			slog.ErrorContext(ctx, "Invalid uninstall request", "error", err)
			span.RecordError(err)
			msg.Respond([]byte(`{"error":"invalid request"}`))
			return
		}
		span.SetAttributes(attribute.String("app.room", room), attribute.String("app.id", req.AppID))

		_, err := db.ExecContext(ctx,
			"DELETE FROM room_apps WHERE room = $1 AND app_id = $2",
			room, req.AppID)
		if err != nil {
			slog.ErrorContext(ctx, "Failed to uninstall app", "error", err, "room", room, "appId", req.AppID)
			span.RecordError(err)
			msg.Respond([]byte(`{"error":"uninstall failed"}`))
			return
		}

		msg.Respond([]byte(`{"ok":true}`))
		slog.InfoContext(ctx, "App uninstalled", "room", room, "appId", req.AppID, "by", req.User)
		reqCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("action", "uninstall")))
		reqDuration.Record(ctx, time.Since(start).Seconds(), metric.WithAttributes(attribute.String("action", "uninstall")))
	})
	if err != nil {
		slog.Error("Failed to subscribe to apps.uninstall.*", "error", err)
		os.Exit(1)
	}

	sigCtx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()

	slog.Info("App Registry Service ready")
	<-sigCtx.Done()
	slog.Info("Shutting down App Registry Service")
	nc.Drain()
}
