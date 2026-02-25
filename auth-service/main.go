package main

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	otelhelper "github.com/example/nats-chat-otelhelper"
	_ "github.com/lib/pq"
	"github.com/nats-io/nats.go"
	"go.opentelemetry.io/otel"
)

func main() {
	ctx := context.Background()

	// Initialize OpenTelemetry
	otelShutdown, err := otelhelper.Init(ctx)
	if err != nil {
		slog.Error("Failed to initialize OpenTelemetry", "error", err)
		os.Exit(1)
	}
	defer otelShutdown(ctx)

	cfg := loadConfig()

	slog.Info("Starting NATS Auth Callout Service",
		"nats_url", cfg.NatsURL,
		"keycloak_url", cfg.KeycloakURL,
		"keycloak_realm", cfg.KeycloakRealm,
	)

	// Initialize the Keycloak JWKS validator
	validator, err := NewKeycloakValidator(cfg.KeycloakURL, cfg.KeycloakRealm, cfg.KeycloakIssuerURL)
	if err != nil {
		slog.Error("Failed to initialize Keycloak validator", "error", err)
		os.Exit(1)
	}
	defer validator.Close()

	// Connect to PostgreSQL for service account lookup
	var db *sql.DB
	for attempt := 1; attempt <= 30; attempt++ {
		db, err = sql.Open("postgres", cfg.DatabaseURL)
		if err == nil {
			err = db.Ping()
		}
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

	// Load service accounts into memory cache
	serviceAccounts, err := NewServiceAccountCache(db)
	if err != nil {
		slog.Error("Failed to load service accounts", "error", err)
		os.Exit(1)
	}
	defer serviceAccounts.Close()

	// Build the auth handler
	meter := otel.Meter("auth-service")
	handler, err := NewAuthHandler(cfg, validator, serviceAccounts, meter)
	if err != nil {
		slog.Error("Failed to create auth handler", "error", err)
		os.Exit(1)
	}

	// Connect to NATS as the auth callout user
	var nc *nats.Conn
	for attempt := 1; attempt <= 30; attempt++ {
		nc, err = nats.Connect(cfg.NatsURL,
			nats.UserInfo(cfg.NatsUser, cfg.NatsPass),
			nats.Name("auth-callout-service"),
			nats.MaxReconnects(-1),
			nats.ReconnectWait(2*time.Second),
			nats.DisconnectErrHandler(func(_ *nats.Conn, err error) {
				slog.Warn("NATS disconnected", "error", err)
			}),
			nats.ReconnectHandler(func(_ *nats.Conn) {
				slog.Info("NATS reconnected")
			}),
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

	// Subscribe to the auth callout subject
	sub, err := nc.Subscribe("$SYS.REQ.USER.AUTH", handler.Handle)
	if err != nil {
		slog.Error("Failed to subscribe to auth callout subject", "error", err)
		os.Exit(1)
	}
	defer sub.Unsubscribe()
	slog.Info("Subscribed to $SYS.REQ.USER.AUTH — ready to handle auth requests")

	// Wait for shutdown signal
	sigCtx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()
	<-sigCtx.Done()

	slog.Info("Shutting down auth callout service")
	nc.Drain()
}

// Config holds the service configuration.
type Config struct {
	NatsURL           string
	NatsUser          string
	NatsPass          string
	KeycloakURL       string
	KeycloakRealm     string
	KeycloakIssuerURL string
	IssuerSeed        string
	XKeySeed          string
	ChatAccountPub    string
	DatabaseURL       string
}

func loadConfig() Config {
	return Config{
		NatsURL:           envOrDefault("NATS_URL", "nats://localhost:4222"),
		NatsUser:          envOrDefault("NATS_USER", "auth"),
		NatsPass:          envOrDefault("NATS_PASS", "auth-secret-password"),
		KeycloakURL:       envOrDefault("KEYCLOAK_URL", "http://localhost:8080"),
		KeycloakRealm:     envOrDefault("KEYCLOAK_REALM", "nats-chat"),
		KeycloakIssuerURL: envOrDefault("KEYCLOAK_ISSUER_URL", ""),
		IssuerSeed:        envOrDefault("ISSUER_NKEY_SEED", "SAANDLKMXL6CUS3CP52WIXBEDN6YJ545GDKC65U5JZPPV6WH6ESWUA6YAI"),
		XKeySeed:          envOrDefault("XKEY_SEED", "SXAAXMRAEP6JWWHNB6IKFL554IE6LZVT6EY5MBRICPILTLOPHAG73I3YX4"),
		ChatAccountPub:    envOrDefault("CHAT_ACCOUNT_PUBLIC_KEY", ""),
		DatabaseURL:       envOrDefault("DATABASE_URL", "postgres://chat:chat-secret@localhost:5432/chatdb?sslmode=disable"),
	}
}

func envOrDefault(key, defaultVal string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return defaultVal
}

func mustEnv(key string) string {
	v := os.Getenv(key)
	if v == "" {
		panic(fmt.Sprintf("required environment variable %s is not set", key))
	}
	return v
}
