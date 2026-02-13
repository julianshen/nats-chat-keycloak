package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/nats-io/nats.go"
)

func main() {
	cfg := loadConfig()

	log.Printf("Starting NATS Auth Callout Service")
	log.Printf("  NATS URL:       %s", cfg.NatsURL)
	log.Printf("  Keycloak URL:   %s", cfg.KeycloakURL)
	log.Printf("  Keycloak Realm: %s", cfg.KeycloakRealm)

	// Initialize the Keycloak JWKS validator
	// KeycloakIssuerURL overrides the issuer for token validation (browser tokens
	// use the external URL, but JWKS must be fetched via the internal Docker URL).
	validator, err := NewKeycloakValidator(cfg.KeycloakURL, cfg.KeycloakRealm, cfg.KeycloakIssuerURL)
	if err != nil {
		log.Fatalf("Failed to initialize Keycloak validator: %v", err)
	}
	defer validator.Close()

	// Build the auth handler
	handler, err := NewAuthHandler(cfg, validator)
	if err != nil {
		log.Fatalf("Failed to create auth handler: %v", err)
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
				log.Printf("NATS disconnected: %v", err)
			}),
			nats.ReconnectHandler(func(_ *nats.Conn) {
				log.Printf("NATS reconnected")
			}),
		)
		if err == nil {
			break
		}
		log.Printf("Attempt %d: waiting for NATS server... (%v)", attempt, err)
		time.Sleep(2 * time.Second)
	}
	if err != nil {
		log.Fatalf("Failed to connect to NATS after retries: %v", err)
	}
	defer nc.Close()
	log.Printf("Connected to NATS at %s", nc.ConnectedUrl())

	// Subscribe to the auth callout subject
	sub, err := nc.Subscribe("$SYS.REQ.USER.AUTH", handler.Handle)
	if err != nil {
		log.Fatalf("Failed to subscribe to auth callout subject: %v", err)
	}
	defer sub.Unsubscribe()
	log.Printf("Subscribed to $SYS.REQ.USER.AUTH — ready to handle auth requests")

	// Wait for shutdown signal
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	<-ctx.Done()

	log.Printf("Shutting down auth callout service...")
	nc.Drain()
}

// Config holds the service configuration.
type Config struct {
	NatsURL            string
	NatsUser           string
	NatsPass           string
	KeycloakURL        string
	KeycloakRealm      string
	KeycloakIssuerURL  string
	IssuerSeed         string
	XKeySeed           string
	ChatAccountPub     string
}

func loadConfig() Config {
	return Config{
		NatsURL:        envOrDefault("NATS_URL", "nats://localhost:4222"),
		NatsUser:       envOrDefault("NATS_USER", "auth"),
		NatsPass:       envOrDefault("NATS_PASS", "auth-secret-password"),
		KeycloakURL:       envOrDefault("KEYCLOAK_URL", "http://localhost:8080"),
		KeycloakRealm:    envOrDefault("KEYCLOAK_REALM", "nats-chat"),
		KeycloakIssuerURL: envOrDefault("KEYCLOAK_ISSUER_URL", ""),
		IssuerSeed:     envOrDefault("ISSUER_NKEY_SEED", "SAANDLKMXL6CUS3CP52WIXBEDN6YJ545GDKC65U5JZPPV6WH6ESWUA6YAI"),
		XKeySeed:       envOrDefault("XKEY_SEED", "SXAAXMRAEP6JWWHNB6IKFL554IE6LZVT6EY5MBRICPILTLOPHAG73I3YX4"),
		ChatAccountPub: envOrDefault("CHAT_ACCOUNT_PUBLIC_KEY", ""),
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
