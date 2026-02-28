package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	otelhelper "github.com/example/nats-chat-otelhelper"
	"github.com/nats-io/nats.go"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

// UserResult is the response structure sent back to clients.
type UserResult struct {
	Username  string `json:"username"`
	FirstName string `json:"firstName"`
	LastName  string `json:"lastName"`
}

// keycloakUser represents a user from the Keycloak Admin API.
type keycloakUser struct {
	Username  string `json:"username"`
	FirstName string `json:"firstName"`
	LastName  string `json:"lastName"`
}

// tokenCache holds a cached Keycloak admin access token.
type tokenCache struct {
	mu        sync.Mutex
	token     string
	expiresAt time.Time
}

func (tc *tokenCache) get(keycloakURL string) (string, error) {
	tc.mu.Lock()
	defer tc.mu.Unlock()

	if tc.token != "" && time.Now().Before(tc.expiresAt) {
		return tc.token, nil
	}

	token, expiresIn, err := fetchAdminToken(keycloakURL)
	if err != nil {
		return "", err
	}
	tc.token = token
	// Refresh 30 seconds before expiry
	tc.expiresAt = time.Now().Add(time.Duration(expiresIn-30) * time.Second)
	return tc.token, nil
}

// fetchAdminToken obtains an admin access token from Keycloak.
func fetchAdminToken(keycloakURL string) (string, int, error) {
	adminUser := envOrDefault("KEYCLOAK_ADMIN_USER", "admin")
	adminPass := envOrDefault("KEYCLOAK_ADMIN_PASS", "admin")

	tokenURL := fmt.Sprintf("%s/realms/master/protocol/openid-connect/token", keycloakURL)
	data := url.Values{
		"grant_type": {"password"},
		"client_id":  {"admin-cli"},
		"username":   {adminUser},
		"password":   {adminPass},
	}

	resp, err := http.PostForm(tokenURL, data)
	if err != nil {
		return "", 0, fmt.Errorf("token request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return "", 0, fmt.Errorf("token request returned %d: %s", resp.StatusCode, string(body))
	}

	var tokenResp struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&tokenResp); err != nil {
		return "", 0, fmt.Errorf("failed to decode token response: %w", err)
	}

	return tokenResp.AccessToken, tokenResp.ExpiresIn, nil
}

// searchUsers queries the Keycloak Admin API for users matching a search string.
func searchUsers(keycloakURL, realm, adminToken, query string) ([]UserResult, error) {
	searchURL := fmt.Sprintf("%s/admin/realms/%s/users?search=%s&max=20",
		keycloakURL, realm, url.QueryEscape(query))

	req, err := http.NewRequest("GET", searchURL, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+adminToken)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("search request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("search returned %d: %s", resp.StatusCode, string(body))
	}

	var users []keycloakUser
	if err := json.NewDecoder(resp.Body).Decode(&users); err != nil {
		return nil, fmt.Errorf("failed to decode users: %w", err)
	}

	results := make([]UserResult, len(users))
	for i, u := range users {
		results[i] = UserResult{
			Username:  u.Username,
			FirstName: u.FirstName,
			LastName:  u.LastName,
		}
	}
	return results, nil
}

func envOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	ctx := context.Background()

	// Initialize OpenTelemetry
	otelShutdown, err := otelhelper.Init(ctx)
	if err != nil {
		slog.Error("Failed to initialize OpenTelemetry", "error", err)
		os.Exit(1)
	}
	defer otelShutdown(ctx)

	meter := otel.Meter("user-search-service")
	searchCounter, _ := meter.Int64Counter("user_search_requests_total",
		metric.WithDescription("Total user search requests"))
	searchDuration, _ := otelhelper.NewDurationHistogram(meter, "user_search_duration_seconds", "Duration of user search requests")

	natsURL := envOrDefault("NATS_URL", "nats://localhost:4222")
	natsUser := envOrDefault("NATS_USER", "user-search-service")
	natsPass := envOrDefault("NATS_PASS", "user-search-service-secret")
	keycloakURL := envOrDefault("KEYCLOAK_URL", "http://localhost:8080")
	realm := envOrDefault("KEYCLOAK_REALM", "nats-chat")

	slog.Info("Starting User Search Service", "nats_url", natsURL, "keycloak_url", keycloakURL)

	// Wait for Keycloak to be ready and fetch initial admin token
	tc := &tokenCache{}
	for attempt := 1; attempt <= 30; attempt++ {
		if _, err = tc.get(keycloakURL); err == nil {
			break
		}
		slog.Info("Waiting for Keycloak", "attempt", attempt, "error", err)
		time.Sleep(2 * time.Second)
	}
	if err != nil {
		slog.Error("Failed to get Keycloak admin token", "error", err)
		os.Exit(1)
	}
	slog.Info("Keycloak admin token acquired")

	// Connect to NATS with retry
	var nc *nats.Conn
	for attempt := 1; attempt <= 30; attempt++ {
		nc, err = nats.Connect(natsURL,
			nats.UserInfo(natsUser, natsPass),
			nats.Name("user-search-service"),
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

	// Subscribe to users.search (request/reply)
	_, err = nc.Subscribe("users.search", func(msg *nats.Msg) {
		start := time.Now()
		ctx, span := otelhelper.StartServerSpan(context.Background(), msg, "user search")
		defer span.End()

		query := strings.TrimSpace(string(msg.Data))
		span.SetAttributes(
			attribute.String("chat.user", query),
			attribute.String("search.query", query),
		)

		if query == "" {
			msg.Respond([]byte("[]"))
			return
		}

		token, err := tc.get(keycloakURL)
		if err != nil {
			slog.ErrorContext(ctx, "Failed to get admin token", "error", err)
			span.RecordError(err)
			msg.Respond([]byte("[]"))
			return
		}

		results, err := searchUsers(keycloakURL, realm, token, query)
		if err != nil {
			slog.ErrorContext(ctx, "User search failed", "error", err)
			span.RecordError(err)
			msg.Respond([]byte("[]"))
			return
		}

		data, err := json.Marshal(results)
		if err != nil {
			slog.ErrorContext(ctx, "Failed to marshal results", "error", err)
			span.RecordError(err)
			msg.Respond([]byte("[]"))
			return
		}
		msg.Respond(data)

		duration := time.Since(start).Seconds()
		searchCounter.Add(ctx, 1)
		searchDuration.Record(ctx, duration)
		span.SetAttributes(attribute.Int("search.result_count", len(results)))
		slog.DebugContext(ctx, "User search completed", "query", query, "results", len(results), "duration_ms", duration*1000)
	})
	if err != nil {
		slog.Error("Failed to subscribe to users.search", "error", err)
		os.Exit(1)
	}

	slog.Info("User search service ready - listening on users.search")

	// Wait for shutdown
	sigCtx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()
	<-sigCtx.Done()

	slog.Info("Shutting down user search service")
	nc.Drain()
}
