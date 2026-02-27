package main

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	otelhelper "github.com/example/nats-chat-otelhelper"
	_ "github.com/lib/pq"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

func main() {
	ctx := context.Background()

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

	validator, err := NewKeycloakValidator(cfg.KeycloakURL, cfg.KeycloakRealm, cfg.KeycloakIssuerURL)
	if err != nil {
		slog.Error("Failed to initialize Keycloak validator", "error", err)
		os.Exit(1)
	}
	defer validator.Close()

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

	serviceAccounts, err := NewServiceAccountCache(db)
	if err != nil {
		slog.Error("Failed to load service accounts", "error", err)
		os.Exit(1)
	}
	defer serviceAccounts.Close()

	meter := otel.Meter("auth-service")
	handler, err := NewAuthHandler(cfg, validator, serviceAccounts, meter)
	if err != nil {
		slog.Error("Failed to create auth handler", "error", err)
		os.Exit(1)
	}

	isLeaderGauge, _ := meter.Int64ObservableGauge("auth_service_is_leader",
		metric.WithDescription("Whether this instance is the leader (1=leader, 0=follower)"))
	var leaderElection *LeaderElection
	_, _ = meter.RegisterCallback(func(_ context.Context, o metric.Observer) error {
		if leaderElection != nil {
			var v int64
			if leaderElection.IsLeader() {
				v = 1
			}
			o.ObserveInt64(isLeaderGauge, v, metric.WithAttributes(
				attribute.String("instance_id", leaderElection.InstanceID()),
			))
		}
		return nil
	}, isLeaderGauge)

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

	js, err := jetstream.New(nc)
	if err != nil {
		slog.Error("Failed to create JetStream context", "error", err)
		os.Exit(1)
	}

	leaderElection, err = NewLeaderElection(js, "AUTH_LEADER", "auth-callout-leader", 10*time.Second, 3*time.Second)
	if err != nil {
		slog.Error("Failed to create leader election", "error", err)
		os.Exit(1)
	}

	sigCtx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()

	var sub *nats.Subscription
	var subMu sync.Mutex

	leaderCtx, leaderCancel := context.WithCancel(context.Background())
	go func() {
		leaderElection.Start(leaderCtx)
	}()

	go func() {
		ticker := time.NewTicker(500 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-sigCtx.Done():
				return
			case <-ticker.C:
				subMu.Lock()
				isLeader := leaderElection.IsLeader()
				hasSub := sub != nil
				subMu.Unlock()

				if isLeader && !hasSub {
					subMu.Lock()
					var subErr error
					sub, subErr = nc.Subscribe("$SYS.REQ.USER.AUTH", handler.Handle)
					if subErr != nil {
						slog.Error("Failed to subscribe to auth callout subject", "error", subErr)
						sub = nil
					} else {
						slog.Info("Subscribed to $SYS.REQ.USER.AUTH as leader", "instance_id", leaderElection.InstanceID())
					}
					subMu.Unlock()
				} else if !isLeader && hasSub {
					subMu.Lock()
					if sub != nil {
						sub.Unsubscribe()
						sub = nil
						slog.Info("Unsubscribed from $SYS.REQ.USER.AUTH (no longer leader)", "instance_id", leaderElection.InstanceID())
					}
					subMu.Unlock()
				}
			}
		}
	}()

	slog.Info("Auth service ready - participating in leader election", "instance_id", leaderElection.InstanceID())

	<-sigCtx.Done()

	slog.Info("Shutting down auth callout service")
	leaderCancel()
	leaderElection.Stop()

	subMu.Lock()
	if sub != nil {
		sub.Unsubscribe()
	}
	subMu.Unlock()

	nc.Drain()
}

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
