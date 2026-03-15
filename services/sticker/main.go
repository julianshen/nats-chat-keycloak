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

type StickerProduct struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	ThumbnailURL string `json:"thumbnailUrl"`
}

type Sticker struct {
	ID       string `json:"id"`
	ImageURL string `json:"imageUrl"`
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

	meter := otel.Meter("sticker-service")
	requestCounter, _ := meter.Int64Counter("sticker_requests_total",
		metric.WithDescription("Total sticker requests"))
	requestDuration, _ := otelhelper.NewDurationHistogram(meter, "sticker_request_duration_seconds", "Duration of sticker requests")

	natsURL := envOrDefault("NATS_URL", "nats://localhost:4222")
	natsUser := envOrDefault("NATS_USER", "sticker-service")
	natsPass := envOrDefault("NATS_PASS", "sticker-service-secret")
	dbURL := envOrDefault("DATABASE_URL", "postgres://chat:chat-secret@localhost:5432/chatdb?sslmode=disable")
	baseURL := envOrDefault("STICKER_BASE_URL", "http://localhost:8090/images")

	slog.Info("Starting Sticker Service", "nats_url", natsURL, "base_url", baseURL)

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

	// Connect to NATS with retry
	var nc *nats.Conn
	for attempt := 1; attempt <= 30; attempt++ {
		nc, err = nats.Connect(natsURL,
			nats.UserInfo(natsUser, natsPass),
			nats.Name("sticker-service"),
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

	// Prepare queries
	productsStmt, err := db.Prepare(
		"SELECT id, name, thumbnail FROM sticker_products ORDER BY name",
	)
	if err != nil {
		slog.Error("Failed to prepare products query", "error", err)
		os.Exit(1)
	}
	defer productsStmt.Close()

	stickersStmt, err := db.Prepare(
		"SELECT id, image_file FROM stickers WHERE product_id = $1 ORDER BY sort_order",
	)
	if err != nil {
		slog.Error("Failed to prepare stickers query", "error", err)
		os.Exit(1)
	}
	defer stickersStmt.Close()

	// Subscribe: stickers.products → return all sticker packs
	_, err = nc.Subscribe("stickers.products", func(msg *nats.Msg) {
		start := time.Now()
		ctx, span := otelhelper.StartServerSpan(context.Background(), msg, "stickers.products")
		defer span.End()

		rows, err := productsStmt.QueryContext(ctx)
		if err != nil {
			slog.ErrorContext(ctx, "Products query failed", "error", err)
			span.RecordError(err)
			msg.Respond([]byte("[]"))
			return
		}
		defer rows.Close()

		var products []StickerProduct
		for rows.Next() {
			var p StickerProduct
			var thumb string
			if err := rows.Scan(&p.ID, &p.Name, &thumb); err != nil {
				slog.WarnContext(ctx, "Failed to scan product row", "error", err)
				continue
			}
			p.ThumbnailURL = baseURL + "/" + thumb
			products = append(products, p)
		}
		if products == nil {
			products = []StickerProduct{}
		}

		data, _ := json.Marshal(products)
		msg.Respond(data)

		duration := time.Since(start).Seconds()
		requestCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("type", "products")))
		requestDuration.Record(ctx, duration, metric.WithAttributes(attribute.String("type", "products")))
	})
	if err != nil {
		slog.Error("Failed to subscribe to stickers.products", "error", err)
		os.Exit(1)
	}

	// Subscribe: stickers.product.* → return stickers for a given product
	_, err = nc.Subscribe("stickers.product.*", func(msg *nats.Msg) {
		start := time.Now()
		ctx, span := otelhelper.StartServerSpan(context.Background(), msg, "stickers.product")
		defer span.End()

		parts := strings.Split(msg.Subject, ".")
		if len(parts) < 3 {
			msg.Respond([]byte("[]"))
			return
		}
		productId := parts[2]
		span.SetAttributes(attribute.String("sticker.product_id", productId))

		rows, err := stickersStmt.QueryContext(ctx, productId)
		if err != nil {
			slog.ErrorContext(ctx, "Stickers query failed", "product_id", productId, "error", err)
			span.RecordError(err)
			msg.Respond([]byte("[]"))
			return
		}
		defer rows.Close()

		var stickers []Sticker
		for rows.Next() {
			var s Sticker
			var imageFile string
			if err := rows.Scan(&s.ID, &imageFile); err != nil {
				slog.WarnContext(ctx, "Failed to scan sticker row", "error", err)
				continue
			}
			s.ImageURL = baseURL + "/" + imageFile
			stickers = append(stickers, s)
		}
		if stickers == nil {
			stickers = []Sticker{}
		}

		data, _ := json.Marshal(stickers)
		msg.Respond(data)

		duration := time.Since(start).Seconds()
		requestCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("type", "stickers")))
		requestDuration.Record(ctx, duration, metric.WithAttributes(attribute.String("type", "stickers")))
	})
	if err != nil {
		slog.Error("Failed to subscribe to stickers.product.*", "error", err)
		os.Exit(1)
	}

	slog.Info("NATS subscriptions ready")
	slog.Info("Sticker service ready")

	// Wait for shutdown
	sigCtx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()
	<-sigCtx.Done()

	slog.Info("Shutting down sticker service")
	nc.Drain()
}
