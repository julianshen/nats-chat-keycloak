# Room Apps Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a collaborative room app platform where Web Component micro-frontends run inside chat room tabs, communicating with backend app services through an injected bridge SDK over the host's existing NATS connection.

**Architecture:** Apps are Web Components loaded from a registry, sandboxed in Shadow DOM. An `AppBridge` SDK injected by the host scopes all communication to `app.{appId}.{room}.*` subjects, proxying through the host's single NATS WebSocket. Fanout-service is extended to route `app.>` messages to room members. A poll app demonstrates the full flow.

**Tech Stack:** React 18 + TypeScript (frontend), Go (backend services), PostgreSQL (registry + poll data), NATS (messaging), Web Components + Shadow DOM (app sandbox)

**Design doc:** `docs/plans/2026-02-22-room-apps-design.md`

---

## Task 1: Database Schema — App Registry & Poll Tables

**Files:**
- Modify: `postgres/init.sql`

**Step 1: Add app registry and poll tables to init.sql**

Append to the end of `postgres/init.sql`:

```sql
-- App registry tables
CREATE TABLE IF NOT EXISTS apps (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    description     TEXT,
    icon_url        TEXT,
    component_url   TEXT NOT NULL,
    subject_prefix  TEXT NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS channel_apps (
    room            TEXT NOT NULL,
    app_id          TEXT NOT NULL REFERENCES apps(id),
    installed_by    TEXT NOT NULL,
    installed_at    TIMESTAMPTZ DEFAULT NOW(),
    config          JSONB DEFAULT '{}',
    PRIMARY KEY (room, app_id)
);

-- Poll app tables
CREATE TABLE IF NOT EXISTS polls (
    id          TEXT PRIMARY KEY,
    room        TEXT NOT NULL,
    question    TEXT NOT NULL,
    options     JSONB NOT NULL,
    created_by  TEXT NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    closed      BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS poll_votes (
    poll_id     TEXT NOT NULL REFERENCES polls(id),
    user_id     TEXT NOT NULL,
    option_idx  INT NOT NULL,
    voted_at    TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (poll_id, user_id)
);

-- Seed poll app into registry
INSERT INTO apps (id, name, description, icon_url, component_url, subject_prefix) VALUES
  ('poll', 'Poll', 'Create polls and vote in real-time', NULL, 'http://localhost:8091/poll-app.js', 'app.poll')
ON CONFLICT DO NOTHING;
```

**Step 2: Apply schema to running database**

Run: `docker compose exec postgres psql -U chat -d chatdb -f /docker-entrypoint-initdb.d/init.sql`

Or restart postgres to re-run init: `docker compose down postgres && docker compose up -d postgres`

**Step 3: Commit**

```bash
git add postgres/init.sql
git commit -m "feat: add app registry and poll tables to database schema"
```

---

## Task 2: NATS Config — Add App Services

**Files:**
- Modify: `nats/nats-server.conf`

**Step 1: Add app-registry-service and poll-service users**

In `nats/nats-server.conf`, add two new users to the CHAT account (after line 26, the sticker-service entry):

```
      { user: app-registry-service, password: app-registry-service-secret }
      { user: poll-service, password: poll-service-secret }
```

And add them to the `auth_users` list on line 37:

```
    auth_users: [ auth, persist-worker, history-service, fanout-service, presence-service, read-receipt-service, user-search-service, room-service, translation-service, sticker-service, app-registry-service, poll-service ]
```

**Step 2: Commit**

```bash
git add nats/nats-server.conf
git commit -m "feat: add app-registry-service and poll-service to NATS config"
```

---

## Task 3: Auth Permissions — Allow App Subjects

**Files:**
- Modify: `auth-service/permissions.go`

**Step 1: Add app subjects to all three role blocks**

In `auth-service/permissions.go`:

**Admin block** (after line 41, `"stickers.product.*"`): Add:
```go
"app.*.*.>",
"apps.list",
"apps.room.*",
"apps.install.*",
"apps.uninstall.*",
```

**User block** (after line 69, `"stickers.product.*"`): Add the same 5 entries.

**No-role block** (after line 97, `"stickers.product.*"`): Add only read + communication:
```go
"app.*.*.>",
"apps.list",
"apps.room.*",
```

(No-role users can interact with installed apps but cannot install/uninstall.)

**Step 2: Build auth-service to verify**

Run: `cd auth-service && go build .`
Expected: Compiles with no errors.

**Step 3: Commit**

```bash
git add auth-service/permissions.go
git commit -m "feat: add app NATS subject permissions for all role tiers"
```

---

## Task 4: App Registry Service

**Files:**
- Create: `app-registry-service/main.go`
- Create: `app-registry-service/Dockerfile`
- Create: `app-registry-service/go.mod`

**Step 1: Create go.mod**

Create `app-registry-service/go.mod` following the sticker-service pattern:

```go
module github.com/example/nats-chat-app-registry-service

go 1.22.0

require (
	github.com/XSAM/otelsql v0.35.0
	github.com/example/nats-chat-otelhelper v0.0.0
	github.com/lib/pq v1.10.9
	github.com/nats-io/nats.go v1.38.0
	go.opentelemetry.io/otel v1.34.0
	go.opentelemetry.io/otel/metric v1.34.0
)

replace github.com/example/nats-chat-otelhelper => ../pkg/otelhelper
```

Then run: `cd app-registry-service && go mod tidy`

**Step 2: Create main.go**

Single-file Go service. Subscribes to 4 NATS subjects via queue group `app-registry-workers`:

- `apps.list` — Returns all registered apps from `apps` table
- `apps.room.{room}` — Returns apps installed in a room from `channel_apps` JOIN `apps`
- `apps.install.{room}` — Inserts into `channel_apps` (request payload: `{appId, config?}`)
- `apps.uninstall.{room}` — Deletes from `channel_apps` (request payload: `{appId}`)

```go
package main

import (
	"context"
	"database/sql"
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
	reqDuration, _ := meter.Float64Histogram("app_registry_request_duration_seconds",
		metric.WithDescription("Duration of app registry requests"))

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
			FROM channel_apps ca
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
			"INSERT INTO channel_apps (room, app_id, installed_by, config) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
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
			"DELETE FROM channel_apps WHERE room = $1 AND app_id = $2",
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
```

**Step 3: Create Dockerfile**

```dockerfile
FROM golang:1.22-alpine AS builder

WORKDIR /app

COPY app-registry-service/go.mod app-registry-service/go.sum ./
COPY pkg/otelhelper/ /pkg/otelhelper/
RUN go mod download

COPY app-registry-service/*.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -o /app-registry-service .

FROM alpine:3.19

RUN apk add --no-cache ca-certificates

COPY --from=builder /app-registry-service /app-registry-service

ENTRYPOINT ["/app-registry-service"]
```

**Step 4: Generate go.sum and verify build**

Run: `cd app-registry-service && go mod tidy && go build .`
Expected: Compiles with no errors, produces `app-registry-service` binary.

**Step 5: Commit**

```bash
git add app-registry-service/
git commit -m "feat: add app-registry-service for room app metadata and installation"
```

---

## Task 5: Poll Service

**Files:**
- Create: `poll-service/main.go`
- Create: `poll-service/Dockerfile`
- Create: `poll-service/go.mod`

**Step 1: Create go.mod**

Same pattern as app-registry-service. Then `cd poll-service && go mod tidy`.

```go
module github.com/example/nats-chat-poll-service

go 1.22.0

require (
	github.com/XSAM/otelsql v0.35.0
	github.com/example/nats-chat-otelhelper v0.0.0
	github.com/google/uuid v1.6.0
	github.com/lib/pq v1.10.9
	github.com/nats-io/nats.go v1.38.0
	go.opentelemetry.io/otel v1.34.0
	go.opentelemetry.io/otel/metric v1.34.0
)

replace github.com/example/nats-chat-otelhelper => ../pkg/otelhelper
```

**Step 2: Create main.go**

Single-file Go service. Subscribes to `app.poll.>` via queue group `poll-workers`. Handles 5 actions extracted from subject position 3+:

- `create` — Insert poll into `polls` table, return `{pollId}`
- `list` — Query active polls for room, return `{polls[]}`
- `vote` — Upsert into `poll_votes` (ON CONFLICT UPDATE), publish `app.poll.{room}.updated` for fanout
- `results` — Query poll + vote counts, return `{poll, votes}`
- `close` — Set `closed=true` (creator only), publish `app.poll.{room}.updated`

```go
package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
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

type createRequest struct {
	Question string   `json:"question"`
	Options  []string `json:"options"`
	User     string   `json:"user"`
}

type voteRequest struct {
	PollID    string `json:"pollId"`
	OptionIdx int    `json:"optionIdx"`
	User      string `json:"user"`
}

type closeRequest struct {
	PollID string `json:"pollId"`
	User   string `json:"user"`
}

type resultsRequest struct {
	PollID string `json:"pollId"`
	User   string `json:"user"`
}

type pollInfo struct {
	ID        string   `json:"id"`
	Room      string   `json:"room"`
	Question  string   `json:"question"`
	Options   []string `json:"options"`
	CreatedBy string   `json:"createdBy"`
	CreatedAt string   `json:"createdAt"`
	Closed    bool     `json:"closed"`
}

type voteCount struct {
	OptionIdx int `json:"optionIdx"`
	Count     int `json:"count"`
}

type pollResults struct {
	Poll      pollInfo    `json:"poll"`
	Votes     []voteCount `json:"votes"`
	UserVote  *int        `json:"userVote"`
	TotalVotes int        `json:"totalVotes"`
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

	meter := otel.Meter("poll-service")
	reqCounter, _ := meter.Int64Counter("poll_requests_total",
		metric.WithDescription("Total poll requests"))
	reqDuration, _ := meter.Float64Histogram("poll_request_duration_seconds",
		metric.WithDescription("Duration of poll requests"))

	natsURL := envOrDefault("NATS_URL", "nats://localhost:4222")
	natsUser := envOrDefault("NATS_USER", "poll-service")
	natsPass := envOrDefault("NATS_PASS", "poll-service-secret")
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

	slog.Info("Starting Poll Service", "nats_url", natsURL)

	var nc *nats.Conn
	for attempt := 1; attempt <= 30; attempt++ {
		nc, err = nats.Connect(natsURL,
			nats.UserInfo(natsUser, natsPass),
			nats.Name("poll-service"),
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

	// Helper to publish updated event for fanout delivery
	publishUpdated := func(room, pollId string) {
		data, _ := json.Marshal(map[string]string{"pollId": pollId})
		nc.Publish(fmt.Sprintf("app.poll.%s.updated", room), data)
	}

	// Helper to get poll results
	getPollResults := func(ctx context.Context, pollId, user string) (*pollResults, error) {
		var p pollInfo
		var optionsJSON []byte
		var createdAt time.Time
		err := db.QueryRowContext(ctx,
			"SELECT id, room, question, options, created_by, created_at, closed FROM polls WHERE id = $1", pollId).
			Scan(&p.ID, &p.Room, &p.Question, &optionsJSON, &p.CreatedBy, &createdAt, &p.Closed)
		if err != nil {
			return nil, err
		}
		json.Unmarshal(optionsJSON, &p.Options)
		p.CreatedAt = createdAt.Format(time.RFC3339)

		rows, err := db.QueryContext(ctx,
			"SELECT option_idx, COUNT(*) FROM poll_votes WHERE poll_id = $1 GROUP BY option_idx ORDER BY option_idx", pollId)
		if err != nil {
			return nil, err
		}
		defer rows.Close()

		votes := make([]voteCount, len(p.Options))
		for i := range votes {
			votes[i].OptionIdx = i
		}
		total := 0
		for rows.Next() {
			var idx, count int
			rows.Scan(&idx, &count)
			if idx >= 0 && idx < len(votes) {
				votes[idx].Count = count
				total += count
			}
		}

		var userVote *int
		var uv int
		err = db.QueryRowContext(ctx,
			"SELECT option_idx FROM poll_votes WHERE poll_id = $1 AND user_id = $2", pollId, user).Scan(&uv)
		if err == nil {
			userVote = &uv
		}

		return &pollResults{Poll: p, Votes: votes, UserVote: userVote, TotalVotes: total}, nil
	}

	// Subscribe to app.poll.> with queue group
	_, err = nc.QueueSubscribe("app.poll.>", "poll-workers", func(msg *nats.Msg) {
		start := time.Now()

		// Parse subject: app.poll.{room}.{action}
		parts := strings.Split(msg.Subject, ".")
		if len(parts) < 4 {
			return
		}
		room := parts[2]
		action := strings.Join(parts[3:], ".")

		ctx, span := otelhelper.StartServerSpan(context.Background(), msg, "poll."+action)
		defer span.End()
		span.SetAttributes(
			attribute.String("poll.room", room),
			attribute.String("poll.action", action),
		)

		switch action {
		case "create":
			var req createRequest
			if err := json.Unmarshal(msg.Data, &req); err != nil {
				msg.Respond([]byte(`{"error":"invalid request"}`))
				return
			}
			if req.Question == "" || len(req.Options) < 2 || req.User == "" {
				msg.Respond([]byte(`{"error":"question, at least 2 options, and user required"}`))
				return
			}

			pollId := uuid.New().String()[:8]
			optionsJSON, _ := json.Marshal(req.Options)

			_, err := db.ExecContext(ctx,
				"INSERT INTO polls (id, room, question, options, created_by) VALUES ($1, $2, $3, $4, $5)",
				pollId, room, req.Question, optionsJSON, req.User)
			if err != nil {
				slog.ErrorContext(ctx, "Failed to create poll", "error", err)
				span.RecordError(err)
				msg.Respond([]byte(`{"error":"create failed"}`))
				return
			}

			msg.Respond([]byte(fmt.Sprintf(`{"pollId":"%s"}`, pollId)))
			publishUpdated(room, pollId)
			slog.InfoContext(ctx, "Poll created", "pollId", pollId, "room", room, "by", req.User)

		case "list":
			var req struct{ User string `json:"user"` }
			json.Unmarshal(msg.Data, &req)

			rows, err := db.QueryContext(ctx,
				"SELECT id, room, question, options, created_by, created_at, closed FROM polls WHERE room = $1 ORDER BY created_at DESC", room)
			if err != nil {
				slog.ErrorContext(ctx, "Failed to list polls", "error", err)
				msg.Respond([]byte("[]"))
				return
			}
			defer rows.Close()

			var polls []pollInfo
			for rows.Next() {
				var p pollInfo
				var optJSON []byte
				var cat time.Time
				if err := rows.Scan(&p.ID, &p.Room, &p.Question, &optJSON, &p.CreatedBy, &cat, &p.Closed); err != nil {
					continue
				}
				json.Unmarshal(optJSON, &p.Options)
				p.CreatedAt = cat.Format(time.RFC3339)
				polls = append(polls, p)
			}
			if polls == nil {
				polls = []pollInfo{}
			}
			data, _ := json.Marshal(polls)
			msg.Respond(data)

		case "vote":
			var req voteRequest
			if err := json.Unmarshal(msg.Data, &req); err != nil {
				msg.Respond([]byte(`{"error":"invalid request"}`))
				return
			}

			// Check poll exists and not closed
			var closed bool
			err := db.QueryRowContext(ctx, "SELECT closed FROM polls WHERE id = $1", req.PollID).Scan(&closed)
			if err != nil {
				msg.Respond([]byte(`{"error":"poll not found"}`))
				return
			}
			if closed {
				msg.Respond([]byte(`{"error":"poll is closed"}`))
				return
			}

			_, err = db.ExecContext(ctx,
				`INSERT INTO poll_votes (poll_id, user_id, option_idx) VALUES ($1, $2, $3)
				 ON CONFLICT (poll_id, user_id) DO UPDATE SET option_idx = $3, voted_at = NOW()`,
				req.PollID, req.User, req.OptionIdx)
			if err != nil {
				slog.ErrorContext(ctx, "Failed to record vote", "error", err)
				msg.Respond([]byte(`{"error":"vote failed"}`))
				return
			}

			msg.Respond([]byte(`{"ok":true}`))
			publishUpdated(room, req.PollID)

		case "results":
			var req resultsRequest
			json.Unmarshal(msg.Data, &req)

			results, err := getPollResults(ctx, req.PollID, req.User)
			if err != nil {
				slog.ErrorContext(ctx, "Failed to get results", "error", err)
				msg.Respond([]byte(`{"error":"not found"}`))
				return
			}
			data, _ := json.Marshal(results)
			msg.Respond(data)

		case "close":
			var req closeRequest
			if err := json.Unmarshal(msg.Data, &req); err != nil {
				msg.Respond([]byte(`{"error":"invalid request"}`))
				return
			}

			// Only creator can close
			var createdBy string
			err := db.QueryRowContext(ctx, "SELECT created_by FROM polls WHERE id = $1", req.PollID).Scan(&createdBy)
			if err != nil {
				msg.Respond([]byte(`{"error":"poll not found"}`))
				return
			}
			if createdBy != req.User {
				msg.Respond([]byte(`{"error":"only creator can close"}`))
				return
			}

			_, err = db.ExecContext(ctx, "UPDATE polls SET closed = TRUE WHERE id = $1", req.PollID)
			if err != nil {
				slog.ErrorContext(ctx, "Failed to close poll", "error", err)
				msg.Respond([]byte(`{"error":"close failed"}`))
				return
			}

			msg.Respond([]byte(`{"ok":true}`))
			publishUpdated(room, req.PollID)
			slog.InfoContext(ctx, "Poll closed", "pollId", req.PollID, "room", room, "by", req.User)

		default:
			msg.Respond([]byte(`{"error":"unknown action"}`))
		}

		reqCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("action", action)))
		reqDuration.Record(ctx, time.Since(start).Seconds(), metric.WithAttributes(attribute.String("action", action)))
	})
	if err != nil {
		slog.Error("Failed to subscribe to app.poll.>", "error", err)
		os.Exit(1)
	}

	sigCtx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()

	slog.Info("Poll Service ready — listening on app.poll.>")
	<-sigCtx.Done()
	slog.Info("Shutting down Poll Service")
	nc.Drain()
}
```

**Step 3: Create Dockerfile**

```dockerfile
FROM golang:1.22-alpine AS builder

WORKDIR /app

COPY poll-service/go.mod poll-service/go.sum ./
COPY pkg/otelhelper/ /pkg/otelhelper/
RUN go mod download

COPY poll-service/*.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -o /poll-service .

FROM alpine:3.19

RUN apk add --no-cache ca-certificates

COPY --from=builder /poll-service /poll-service

ENTRYPOINT ["/poll-service"]
```

**Step 4: Generate go.sum and verify build**

Run: `cd poll-service && go mod tidy && go build .`
Expected: Compiles with no errors.

**Step 5: Commit**

```bash
git add poll-service/
git commit -m "feat: add poll-service with create/vote/results/close over NATS"
```

---

## Task 6: Fanout Service — Route App Messages

**Files:**
- Modify: `fanout-service/main.go`

**Step 1: Add `app.>` subscription**

After the `presence.event.*` subscription block (around line 460), add a new queue subscription for `app.>`:

```go
// Subscribe to app messages for room fanout
_, err = nc.QueueSubscribe("app.>", "fanout-workers", func(msg *nats.Msg) {
    // Parse subject: app.{appId}.{room}.{action...}
    parts := strings.Split(msg.Subject, ".")
    if len(parts) < 4 {
        return
    }
    room := parts[2]

    // Skip if this is a request/reply (has reply subject) — those go directly back
    if msg.Reply != "" {
        return
    }

    ctx, span := otelhelper.StartConsumerSpan(context.Background(), msg, "fanout app message")
    defer span.End()

    start := time.Now()

    members := getMembers(ctx, room)
    span.SetAttributes(
        attribute.String("app.subject", msg.Subject),
        attribute.String("app.room", room),
        attribute.Int("fanout.member_count", len(members)),
    )

    if len(members) > 0 {
        enqueueFanout(ctx, members, msg.Subject, msg.Data)
    }

    duration := time.Since(start).Seconds()
    fanoutCounter.Add(ctx, int64(len(members)), metric.WithAttributes(
        attribute.String("room", "app."+room),
    ))
    fanoutDuration.Record(ctx, duration, metric.WithAttributes(
        attribute.String("room", "app."+room),
    ))
})
if err != nil {
    slog.Error("Failed to subscribe to app.>", "error", err)
    os.Exit(1)
}
```

**Key design note:** Request/reply messages (`msg.Reply != ""`) are skipped because NATS handles those directly via `_INBOX`. Only pub/sub broadcasts (like `app.poll.general.updated`) need fanout.

**Step 2: Build to verify**

Run: `cd fanout-service && go build .`
Expected: Compiles with no errors.

**Step 3: Commit**

```bash
git add fanout-service/main.go
git commit -m "feat: extend fanout-service to route app.> messages to room members"
```

---

## Task 7: AppBridge SDK

**Files:**
- Create: `web/src/lib/AppBridge.ts`

**Step 1: Create the bridge SDK**

```typescript
import type { NatsConnection, StringCodec } from 'nats.ws';

export type AppCallback = (data: unknown) => void;

/**
 * Shared callback registry for all app bridges.
 * Key format: "{appId}.{room}.{event}"
 * MessageProvider routes matching deliver subjects to these callbacks.
 */
const appCallbacks = new Map<string, Set<AppCallback>>();

/** Called by MessageProvider to route incoming app messages to registered callbacks. */
export function routeAppMessage(appId: string, room: string, event: string, data: unknown): void {
  const key = `${appId}.${room}.${event}`;
  const cbs = appCallbacks.get(key);
  if (cbs) {
    for (const cb of cbs) {
      try { cb(data); } catch (e) { console.error('[AppBridge] Callback error:', e); }
    }
  }
}

export interface AppBridge {
  request(action: string, data?: unknown): Promise<unknown>;
  subscribe(event: string, callback: AppCallback): () => void;
  readonly user: { username: string };
  readonly room: string;
  readonly appId: string;
}

/**
 * Creates a frozen AppBridge for a guest app.
 * The bridge scopes all communication to app.{appId}.{room}.* and
 * injects the authenticated user into every outgoing payload.
 */
export function createAppBridge(
  nc: NatsConnection,
  sc: StringCodec,
  appId: string,
  room: string,
  username: string,
): AppBridge {
  const localSubs = new Set<string>();

  const validateAction = (action: string) => {
    if (/[.*>]/.test(action)) {
      throw new Error(`Invalid action name: "${action}" (contains wildcard characters)`);
    }
  };

  const bridge: AppBridge = {
    async request(action: string, data?: unknown): Promise<unknown> {
      validateAction(action);
      const subject = `app.${appId}.${room}.${action}`;
      const payload = { ...((data as Record<string, unknown>) || {}), user: username };
      const reply = await nc.request(subject, sc.encode(JSON.stringify(payload)), { timeout: 5000 });
      return JSON.parse(sc.decode(reply.data));
    },

    subscribe(event: string, callback: AppCallback): () => void {
      validateAction(event);
      const key = `${appId}.${room}.${event}`;
      if (!appCallbacks.has(key)) {
        appCallbacks.set(key, new Set());
      }
      appCallbacks.get(key)!.add(callback);
      localSubs.add(key);

      // Return unsubscribe function
      return () => {
        const cbs = appCallbacks.get(key);
        if (cbs) {
          cbs.delete(callback);
          if (cbs.size === 0) appCallbacks.delete(key);
        }
        localSubs.delete(key);
      };
    },

    user: Object.freeze({ username }),
    room,
    appId,
  };

  return Object.freeze(bridge);
}

/** Cleans up all subscriptions for a given app instance. */
export function destroyAppBridge(appId: string, room: string): void {
  const prefix = `${appId}.${room}.`;
  for (const key of appCallbacks.keys()) {
    if (key.startsWith(prefix)) {
      appCallbacks.delete(key);
    }
  }
}
```

**Step 2: Commit**

```bash
git add web/src/lib/AppBridge.ts
git commit -m "feat: add AppBridge SDK for guest app NATS communication"
```

---

## Task 8: MessageProvider — Route App Messages

**Files:**
- Modify: `web/src/providers/MessageProvider.tsx`

**Step 1: Import routeAppMessage**

At the top of `MessageProvider.tsx`, add:

```typescript
import { routeAppMessage } from '../lib/AppBridge';
```

**Step 2: Add app message routing**

In the deliver subscription handler (inside the `for await (const msg of sub)` loop), after the `translate` subject type handler and before the default chat/admin handler, add a new case:

```typescript
if (subjectType === 'app') {
  // deliver.{user}.app.{appId}.{room}.{event...}
  // parts = ["deliver", userId, "app", appId, room, ...event]
  if (parts.length >= 6) {
    const appId = parts[3];
    const appRoom = parts[4];
    const event = parts.slice(5).join('.');
    try {
      const data = JSON.parse(sc.decode(msg.data));
      routeAppMessage(appId, appRoom, event, data);
    } catch (e) {
      console.error('[MessageProvider] Failed to parse app message:', e);
    }
  }
  continue;
}
```

**Step 3: Type-check**

Run: `cd web && npx tsc --noEmit`
Expected: No type errors.

**Step 4: Commit**

```bash
git add web/src/providers/MessageProvider.tsx
git commit -m "feat: route app.* deliver messages to AppBridge callbacks"
```

---

## Task 9: ChatRoom — Tab Bar & App Loading

**Files:**
- Modify: `web/src/components/ChatRoom.tsx`

This is the largest UI change. The ChatRoom component gets a tab bar that shows installed apps, and clicking a tab loads the app's Web Component.

**Step 1: Add app-related state and hooks**

Add imports at top:

```typescript
import { createAppBridge, destroyAppBridge } from '../lib/AppBridge';
```

Inside the `ChatRoom` component, add state for tabs:

```typescript
const [installedApps, setInstalledApps] = useState<Array<{id: string, name: string, componentUrl: string}>>([]);
const [activeTab, setActiveTab] = useState<string>('chat');
const appContainerRef = useRef<HTMLDivElement>(null);
```

Add a useEffect to fetch installed apps when the room changes (skip for DM rooms):

```typescript
useEffect(() => {
  if (!nc || !connected || isDm) return;
  nc.request(`apps.room.${room}`, sc.encode(''), { timeout: 3000 })
    .then((reply) => {
      try {
        const apps = JSON.parse(sc.decode(reply.data));
        setInstalledApps(apps.map((a: any) => ({ id: a.id, name: a.name, componentUrl: a.componentUrl })));
      } catch (e) {
        console.error('[Apps] Failed to parse room apps:', e);
      }
    })
    .catch(() => { setInstalledApps([]); });
  setActiveTab('chat');
}, [nc, connected, room, isDm, sc]);
```

**Step 2: Add app loading effect**

When `activeTab` changes to an app, load and mount the Web Component:

```typescript
useEffect(() => {
  const container = appContainerRef.current;
  if (!container || activeTab === 'chat' || !nc || !userInfo) return;

  const app = installedApps.find(a => a.id === activeTab);
  if (!app) return;

  const tagName = `room-app-${app.id}`;

  const mountApp = () => {
    // Clear container safely
    while (container.firstChild) {
      container.removeChild(container.firstChild);
    }

    const el = document.createElement(tagName);
    container.appendChild(el);

    const bridge = createAppBridge(nc, sc, app.id, room, userInfo.username);
    (el as any).setBridge(bridge);
  };

  if (customElements.get(tagName)) {
    mountApp();
  } else {
    const script = document.createElement('script');
    script.src = app.componentUrl;
    script.onload = () => mountApp();
    script.onerror = () => console.error(`[Apps] Failed to load ${app.componentUrl}`);
    document.head.appendChild(script);
  }

  return () => {
    destroyAppBridge(app.id, room);
    while (container.firstChild) {
      container.removeChild(container.firstChild);
    }
  };
}, [activeTab, installedApps, nc, sc, room, userInfo]);
```

**Step 3: Add tab bar styles**

Add to the `styles` object:

```typescript
tabBar: {
  display: 'flex',
  gap: '0',
  borderBottom: '1px solid #1e293b',
  background: '#0f172a',
  paddingLeft: '12px',
},
tab: {
  padding: '8px 16px',
  fontSize: '13px',
  color: '#94a3b8',
  cursor: 'pointer',
  borderBottom: '2px solid transparent',
  background: 'none',
  border: 'none',
  fontFamily: 'inherit',
},
activeTab: {
  padding: '8px 16px',
  fontSize: '13px',
  color: '#f1f5f9',
  cursor: 'pointer',
  borderBottom: '2px solid #3b82f6',
  background: 'none',
  border: 'none',
  borderTop: 'none',
  borderLeft: 'none',
  borderRight: 'none',
  fontFamily: 'inherit',
},
appContainer: {
  flex: 1,
  overflow: 'auto',
},
```

**Step 4: Add tab bar to JSX**

After the room header `div` and before the error banner, add:

```tsx
{!isDm && installedApps.length > 0 && (
  <div style={styles.tabBar}>
    <button
      style={activeTab === 'chat' ? styles.activeTab : styles.tab}
      onClick={() => setActiveTab('chat')}
    >
      Chat
    </button>
    {installedApps.map(app => (
      <button
        key={app.id}
        style={activeTab === app.id ? styles.activeTab : styles.tab}
        onClick={() => setActiveTab(app.id)}
      >
        {app.name}
      </button>
    ))}
  </div>
)}
```

Then wrap the existing message list and input in a conditional, and add the app container:

```tsx
{activeTab === 'chat' ? (
  <>
    {(natsError || pubError) && (
      <div style={styles.errorBanner}>{natsError || pubError}</div>
    )}
    <MessageList ... />
    <MessageInput ... />
  </>
) : (
  <div ref={appContainerRef} style={styles.appContainer} />
)}
```

**Step 5: Type-check**

Run: `cd web && npx tsc --noEmit`
Expected: No type errors.

**Step 6: Commit**

```bash
git add web/src/components/ChatRoom.tsx
git commit -m "feat: add tab bar and Web Component app loading to ChatRoom"
```

---

## Task 10: Poll App Frontend — Web Component

**Files:**
- Create: `poll-app/poll-app.js`
- Create: `poll-app/Dockerfile`

**Step 1: Create poll-app.js**

A standalone Web Component (`<room-app-poll>`) with Shadow DOM. Features:
- Lists active polls with vote counts (horizontal bar chart)
- Create Poll form (question + options, add/remove fields)
- Click to vote, real-time result updates via `bridge.subscribe('updated')`
- Creator can close a poll

```javascript
class RoomAppPoll extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._bridge = null;
    this._polls = [];
    this._results = {};
    this._unsubscribe = null;
  }

  setBridge(bridge) {
    this._bridge = bridge;
    this._init();
  }

  async _init() {
    this._render();
    await this._loadPolls();

    this._unsubscribe = this._bridge.subscribe('updated', async (data) => {
      if (data && data.pollId && this._results[data.pollId] !== undefined) {
        const results = await this._bridge.request('results', { pollId: data.pollId });
        this._results[data.pollId] = results;
        this._renderPolls();
      } else {
        await this._loadPolls();
      }
    });
  }

  async _loadPolls() {
    try {
      const polls = await this._bridge.request('list');
      this._polls = polls || [];
      for (const p of this._polls) {
        const results = await this._bridge.request('results', { pollId: p.id });
        this._results[p.id] = results;
      }
      this._renderPolls();
    } catch (e) {
      console.error('[PollApp] Failed to load polls:', e);
    }
  }

  _render() {
    const style = document.createElement('style');
    style.textContent = `
      :host { display: flex; flex-direction: column; height: 100%; color: #e2e8f0; font-family: system-ui, sans-serif; }
      .container { flex: 1; overflow-y: auto; padding: 16px; }
      .create-form { padding: 16px; border-top: 1px solid #1e293b; background: #0f172a; }
      .form-row { display: flex; gap: 8px; margin-bottom: 8px; }
      input, button { font-family: inherit; font-size: 13px; }
      input { background: #1e293b; border: 1px solid #334155; color: #e2e8f0; padding: 6px 10px; border-radius: 4px; flex: 1; }
      input:focus { outline: none; border-color: #3b82f6; }
      button { cursor: pointer; border: none; border-radius: 4px; padding: 6px 12px; }
      .btn-primary { background: #3b82f6; color: white; }
      .btn-primary:hover { background: #2563eb; }
      .btn-danger { background: #ef4444; color: white; font-size: 11px; padding: 4px 8px; }
      .btn-secondary { background: #334155; color: #cbd5e1; font-size: 12px; }
      .poll-card { background: #1e293b; border-radius: 8px; padding: 14px; margin-bottom: 12px; }
      .poll-question { font-size: 15px; font-weight: 600; margin-bottom: 10px; }
      .poll-meta { font-size: 11px; color: #64748b; margin-bottom: 8px; }
      .option { margin-bottom: 6px; cursor: pointer; }
      .option.voted { cursor: default; }
      .option-bar { display: flex; align-items: center; gap: 8px; }
      .bar-bg { flex: 1; height: 24px; background: #0f172a; border-radius: 4px; overflow: hidden; position: relative; }
      .bar-fill { height: 100%; border-radius: 4px; transition: width 0.3s; display: flex; align-items: center; padding-left: 8px; font-size: 12px; min-width: fit-content; }
      .bar-fill.selected { background: #3b82f6; }
      .bar-fill.other { background: #334155; }
      .vote-count { font-size: 12px; color: #94a3b8; min-width: 30px; text-align: right; }
      .closed-badge { display: inline-block; background: #7f1d1d; color: #fca5a5; font-size: 11px; padding: 2px 6px; border-radius: 4px; margin-left: 8px; }
      .empty { text-align: center; color: #64748b; padding: 40px; }
      .add-option { font-size: 12px; color: #3b82f6; cursor: pointer; background: none; border: none; padding: 4px 0; }
    `;
    this.shadowRoot.appendChild(style);

    const container = document.createElement('div');
    container.className = 'container';
    container.setAttribute('id', 'polls-container');
    this.shadowRoot.appendChild(container);

    const form = document.createElement('div');
    form.className = 'create-form';
    form.setAttribute('id', 'create-form');
    this.shadowRoot.appendChild(form);
    this._renderCreateForm();
  }

  _renderCreateForm() {
    const form = this.shadowRoot.getElementById('create-form');
    while (form.firstChild) form.removeChild(form.firstChild);

    const title = document.createElement('div');
    title.style.cssText = 'font-size:13px;font-weight:600;margin-bottom:8px;';
    title.textContent = 'Create a Poll';
    form.appendChild(title);

    const qRow = document.createElement('div');
    qRow.className = 'form-row';
    const qInput = document.createElement('input');
    qInput.placeholder = 'Ask a question...';
    qInput.setAttribute('id', 'poll-question');
    qRow.appendChild(qInput);
    form.appendChild(qRow);

    const optionsDiv = document.createElement('div');
    optionsDiv.setAttribute('id', 'options-list');
    form.appendChild(optionsDiv);

    // Start with 2 options
    this._optionCount = 2;
    this._renderOptions();

    const actions = document.createElement('div');
    actions.className = 'form-row';
    actions.style.marginTop = '4px';

    const addBtn = document.createElement('button');
    addBtn.className = 'add-option';
    addBtn.textContent = '+ Add option';
    addBtn.onclick = () => { this._optionCount++; this._renderOptions(); };
    actions.appendChild(addBtn);

    const spacer = document.createElement('div');
    spacer.style.flex = '1';
    actions.appendChild(spacer);

    const submitBtn = document.createElement('button');
    submitBtn.className = 'btn-primary';
    submitBtn.textContent = 'Create Poll';
    submitBtn.onclick = () => this._handleCreate();
    actions.appendChild(submitBtn);
    form.appendChild(actions);
  }

  _renderOptions() {
    const list = this.shadowRoot.getElementById('options-list');
    while (list.firstChild) list.removeChild(list.firstChild);
    for (let i = 0; i < this._optionCount; i++) {
      const row = document.createElement('div');
      row.className = 'form-row';
      const input = document.createElement('input');
      input.placeholder = `Option ${i + 1}`;
      input.className = 'poll-option-input';
      row.appendChild(input);
      if (i >= 2) {
        const removeBtn = document.createElement('button');
        removeBtn.className = 'btn-danger';
        removeBtn.textContent = 'X';
        removeBtn.onclick = () => { this._optionCount--; this._renderOptions(); };
        row.appendChild(removeBtn);
      }
      list.appendChild(row);
    }
  }

  async _handleCreate() {
    const q = this.shadowRoot.getElementById('poll-question');
    const inputs = this.shadowRoot.querySelectorAll('.poll-option-input');
    const question = q.value.trim();
    const options = Array.from(inputs).map(i => i.value.trim()).filter(Boolean);
    if (!question || options.length < 2) return;

    try {
      await this._bridge.request('create', { question, options });
      q.value = '';
      inputs.forEach(i => { i.value = ''; });
      this._optionCount = 2;
      this._renderOptions();
      await this._loadPolls();
    } catch (e) {
      console.error('[PollApp] Create failed:', e);
    }
  }

  _renderPolls() {
    const container = this.shadowRoot.getElementById('polls-container');
    while (container.firstChild) container.removeChild(container.firstChild);

    if (this._polls.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No polls yet. Create one below!';
      container.appendChild(empty);
      return;
    }

    for (const poll of this._polls) {
      const r = this._results[poll.id];
      if (!r) continue;

      const card = document.createElement('div');
      card.className = 'poll-card';

      const question = document.createElement('div');
      question.className = 'poll-question';
      question.textContent = poll.question;
      if (poll.closed) {
        const badge = document.createElement('span');
        badge.className = 'closed-badge';
        badge.textContent = 'CLOSED';
        question.appendChild(badge);
      }
      card.appendChild(question);

      const meta = document.createElement('div');
      meta.className = 'poll-meta';
      meta.textContent = `by ${poll.createdBy} \u00B7 ${r.totalVotes} vote${r.totalVotes !== 1 ? 's' : ''}`;
      card.appendChild(meta);

      for (let i = 0; i < poll.options.length; i++) {
        const opt = document.createElement('div');
        opt.className = 'option' + (r.userVote != null ? ' voted' : '');
        const bar = document.createElement('div');
        bar.className = 'option-bar';

        const barBg = document.createElement('div');
        barBg.className = 'bar-bg';
        const barFill = document.createElement('div');
        const pct = r.totalVotes > 0 ? Math.round((r.votes[i].count / r.totalVotes) * 100) : 0;
        barFill.className = 'bar-fill ' + (r.userVote === i ? 'selected' : 'other');
        barFill.style.width = Math.max(pct, 0) + '%';
        barFill.textContent = poll.options[i];
        barBg.appendChild(barFill);
        bar.appendChild(barBg);

        const count = document.createElement('span');
        count.className = 'vote-count';
        count.textContent = pct + '%';
        bar.appendChild(count);

        opt.appendChild(bar);

        if (!poll.closed && r.userVote == null) {
          opt.style.cursor = 'pointer';
          const idx = i;
          opt.onclick = () => this._handleVote(poll.id, idx);
        }

        card.appendChild(opt);
      }

      // Close button for creator
      if (!poll.closed && poll.createdBy === this._bridge.user.username) {
        const closeBtn = document.createElement('button');
        closeBtn.className = 'btn-secondary';
        closeBtn.textContent = 'Close Poll';
        closeBtn.style.marginTop = '8px';
        closeBtn.onclick = () => this._handleClose(poll.id);
        card.appendChild(closeBtn);
      }

      container.appendChild(card);
    }
  }

  async _handleVote(pollId, optionIdx) {
    try {
      await this._bridge.request('vote', { pollId, optionIdx });
      const results = await this._bridge.request('results', { pollId });
      this._results[pollId] = results;
      this._renderPolls();
    } catch (e) {
      console.error('[PollApp] Vote failed:', e);
    }
  }

  async _handleClose(pollId) {
    try {
      await this._bridge.request('close', { pollId });
      await this._loadPolls();
    } catch (e) {
      console.error('[PollApp] Close failed:', e);
    }
  }

  disconnectedCallback() {
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
  }
}

customElements.define('room-app-poll', RoomAppPoll);
```

**Step 2: Create Dockerfile**

Simple nginx serving the JS file:

```dockerfile
FROM nginx:alpine

RUN mkdir -p /usr/share/nginx/html

COPY poll-app/poll-app.js /usr/share/nginx/html/poll-app.js

# Custom nginx config for CORS and correct Content-Type
RUN printf 'server {\n\
    listen 8091;\n\
    location / {\n\
        root /usr/share/nginx/html;\n\
        add_header Access-Control-Allow-Origin *;\n\
        add_header Content-Type application/javascript;\n\
    }\n\
    location /health {\n\
        return 200 "ok";\n\
    }\n\
}\n' > /etc/nginx/conf.d/default.conf

EXPOSE 8091
```

**Step 3: Commit**

```bash
git add poll-app/
git commit -m "feat: add poll-app Web Component with create/vote/results UI"
```

---

## Task 11: Docker Compose & .gitignore — Wire Everything Together

**Files:**
- Modify: `docker-compose.yml`
- Modify: `.gitignore`

**Step 1: Add 3 new services to docker-compose.yml**

After the `sticker-images` service and before `web`, add:

```yaml
  app-registry-service:
    build:
      context: .
      dockerfile: app-registry-service/Dockerfile
    environment:
      NATS_URL: nats://nats:4222
      NATS_USER: app-registry-service
      NATS_PASS: app-registry-service-secret
      DATABASE_URL: postgres://chat:chat-secret@postgres:5432/chatdb?sslmode=disable
      OTEL_EXPORTER_OTLP_ENDPOINT: http://otel-collector:4317
      OTEL_SERVICE_NAME: app-registry-service
    depends_on:
      - nats
      - postgres
      - otel-collector
    restart: unless-stopped

  poll-service:
    build:
      context: .
      dockerfile: poll-service/Dockerfile
    environment:
      NATS_URL: nats://nats:4222
      NATS_USER: poll-service
      NATS_PASS: poll-service-secret
      DATABASE_URL: postgres://chat:chat-secret@postgres:5432/chatdb?sslmode=disable
      OTEL_EXPORTER_OTLP_ENDPOINT: http://otel-collector:4317
      OTEL_SERVICE_NAME: poll-service
    depends_on:
      - nats
      - postgres
      - otel-collector
    restart: unless-stopped

  poll-app:
    build:
      context: .
      dockerfile: poll-app/Dockerfile
    ports:
      - "8091:8091"
    restart: unless-stopped
```

**Step 2: Add Go binaries to .gitignore**

Append to `.gitignore`:

```
app-registry-service/nats-chat-app-registry-service
poll-service/nats-chat-poll-service
```

**Step 3: Commit**

```bash
git add docker-compose.yml .gitignore
git commit -m "feat: add app-registry-service, poll-service, poll-app to Docker Compose"
```

---

## Task 12: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

Update CLAUDE.md with:
- New services (app-registry-service, poll-service, poll-app) in build commands and architecture diagram
- Room app architecture description
- New port 8091 for poll-app
- AppBridge SDK description
- Updated file list

**Commit:**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md with room app architecture and services"
```

---

## Task 13: Build & Integration Test

**Step 1: Build all modified services**

```bash
cd app-registry-service && go build . && cd ..
cd poll-service && go build . && cd ..
cd auth-service && go build . && cd ..
cd fanout-service && go build . && cd ..
cd web && npx tsc --noEmit && cd ..
```

**Step 2: Docker Compose build and run**

```bash
docker compose up -d --build
```

**Step 3: Install poll app in a room**

Using NATS CLI or the browser dev console, publish an install request:

```bash
nats pub apps.install.general '{"appId":"poll","user":"alice"}' --user=app-registry-service --password=app-registry-service-secret
```

Or from the browser console when logged in as alice, use the NATS connection to send the request.

**Step 4: Verify**

1. Open the chat app in browser, navigate to `#general`
2. A "Poll" tab should appear next to "Chat"
3. Click "Poll" tab — poll-app.js loads, create form appears
4. Create a poll with a question and 2+ options
5. Open a second browser tab (logged in as bob), navigate to general, click Poll
6. Bob sees the poll, clicks to vote — results update in real-time for both users
7. Alice can close her poll

**Step 5: Final commit**

If any integration fixes are needed, commit them. Then:

```bash
git add -A
git commit -m "feat: complete room apps platform with poll app demo"
```
