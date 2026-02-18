# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A real-time chat application demonstrating NATS Auth Callout integration with Keycloak OIDC. The system authenticates users via Keycloak, then a Go auth service validates tokens and maps Keycloak realm roles to NATS pub/sub permissions, enabling role-based real-time chat over WebSocket. Messages are persisted to PostgreSQL via JetStream, and the entire system is instrumented with OpenTelemetry for distributed tracing, metrics, and logs.

## Build & Run Commands

```bash
# Start all 14 services
docker compose up -d --build

# Run individual services for development
docker compose up keycloak nats postgres -d
cd auth-service && go run .
cd persist-worker && go run .
cd history-service && go run .
cd web && npm install && npm run dev

# Web app commands
cd web && npm run dev      # Dev server on port 3000
cd web && npm run build    # TypeScript compile + Vite production build

# Go services
cd auth-service && go build -o auth-service .
cd persist-worker && go build -o persist-worker .
cd history-service && go build -o history-service .
cd fanout-service && go build -o fanout-service .
cd presence-service && go build -o presence-service .
```

No test suites or linters are configured.

## Architecture

```
Browser (React + nats.ws)
  │  1. OIDC login → Keycloak → access_token
  │  2. WebSocket CONNECT to NATS (token = access_token)
  │  3. Subscribe to deliver.{userId}.> (single subscription per user)
  │  4. Publish room.join.{room} / room.leave.{room} for membership
  │  5. Publish presence.update / request presence.room.{room}
  ▼
NATS Server 2.12 (auth_callout + JetStream)
  │  6. Forwards auth to $SYS.REQ.USER.AUTH
  │  7. Messages published to chat.{room} → JetStream CHAT_MESSAGES stream
  ▼
Auth Service (Go)     Fanout Service (Go)      Persist Worker (Go)     History Service (Go)
  • Validates JWT       • Subscribes chat.*       • Consumes JetStream     • Listens chat.history.*
  • Maps roles →        • Tracks room members     • Writes to PostgreSQL   • Queries PostgreSQL
    permissions           in-memory               • OTel instrumented      • Returns JSON via reply
  • Per-user deliver    • Fans out to                                      • OTel instrumented
    subject scoping       deliver.{userId}.{subj}
                        • Queue group for scaling

Presence Service (Go)
  • NATS KV bucket "PRESENCE" (in-memory storage)
  • Subscribes presence.update (client status changes)
  • Responds to presence.room.{room} (request/reply queries)
  • Tracks room membership via room.join.*/room.leave.*
  • Broadcasts deliver.{member}.presence.{room} on changes
  • Periodic /connz stale cleanup → sets offline in KV

  ─── All services export telemetry via OTLP/gRPC ───
  ▼
OTel Collector → Tempo (traces) + Prometheus (metrics) + Loki (logs) → Grafana
```

### Service Ports

| Service | Port | Purpose |
|---------|------|---------|
| Keycloak | 8080 | OIDC provider (admin: admin/admin) |
| NATS | 4222/9222/8222 | TCP / WebSocket / Monitoring |
| PostgreSQL | 5432 | Message persistence (chat/chat-secret) |
| Web | 3000 | React frontend |
| OTel Collector | 4317 | OTLP gRPC receiver |
| Prometheus | 9090 | Metrics |
| Grafana | 3001 | Observability dashboards |

### Auth Service (`auth-service/`)

Four Go files, each with a single responsibility:
- **main.go** — Initialization, OTel setup, NATS connection with retry, subscription to `$SYS.REQ.USER.AUTH`
- **handler.go** — Core auth callout: decrypt request → validate JWT → build NATS user JWT → encrypt response. Instrumented with tracing spans and `auth_requests_total`/`auth_request_duration_seconds` metrics.
- **keycloak.go** — JWKS key fetching/caching via `keyfunc` library, with retry on startup
- **permissions.go** — Role-to-permission mapping. Users publish to `chat.>` and subscribe to `deliver.{username}.>` (per-user scoped delivery). Includes `room.join.*`/`room.leave.*` for fan-out membership, and `presence.update`/`presence.room.*` for presence status.

Auth callout uses NKeys for JWT signing and XKey (Curve25519) for payload encryption between NATS server and auth service.

### Fanout Service (`fanout-service/`)

Single-file Go service that manages per-user message delivery. Subscribes to `chat.*` and `admin.*` via a `fanout-workers` queue group (horizontally scalable). Maintains room membership in-memory via `room.join.*`/`room.leave.*` events from clients. When a message arrives, fans it out by publishing to `deliver.{userId}.{originalSubject}` for each room member. This reduces client subscriptions from O(rooms) to O(1). OTel instrumented with `fanout_messages_total`, `fanout_duration_seconds`, `fanout_room_count`, and `fanout_total_members` metrics.

### Presence Service (`presence-service/`)

Single-file Go service that manages user presence status backed by a NATS KV bucket (`PRESENCE`, in-memory storage, history=1). Tracks room membership via `room.join.*`/`room.leave.*` events. Subscribes to `presence.update` for client status changes (online/away/busy/offline), stores status in KV keyed by userId. Responds to `presence.room.*` request/reply queries with per-member status arrays. Broadcasts presence events to room members via `deliver.{member}.presence.{room}` on any status or membership change. Periodic stale cleanup polls NATS `/connz` to detect disconnected users and set them offline in KV. OTel instrumented with `presence_updates_total`, `presence_queries_total`, and `presence_query_duration_seconds` metrics.

### Persist Worker (`persist-worker/`)

Single-file Go service that consumes from the JetStream `CHAT_MESSAGES` stream and writes messages to PostgreSQL. Instrumented with OTel consumer spans, `otelsql` for DB tracing, and `messages_persisted_total`/`messages_persist_errors_total` counters.

### History Service (`history-service/`)

Single-file Go service that listens on `chat.history.*` via NATS request/reply. Queries PostgreSQL for the last 50 messages in a room and returns JSON. Instrumented with OTel server spans, `otelsql`, and `history_requests_total`/`history_request_duration_seconds` metrics.

### Shared OTel Helper (`pkg/otelhelper/`)

Shared Go module (`github.com/example/nats-chat-otelhelper`) used by all five Go services:
- **otel.go** — `Init(ctx)` sets up trace, metric, and log providers via OTLP/gRPC. Reads `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_SERVICE_NAME` env vars.
- **nats.go** — NATS trace propagation: `NatsHeaderCarrier` (W3C Trace Context over NATS headers), `TracedPublish`, `TracedRequest`, `StartConsumerSpan`, `StartServerSpan`.

Go services reference this module via `replace` directive in their `go.mod` files. Dockerfiles copy `pkg/otelhelper/` into the build context.

### Web Frontend (`web/`)

React 18 + TypeScript + Vite. No CSS framework — all styles are inline TypeScript objects with a dark theme.

**State management via three Context providers (no Redux):**
- **AuthProvider** — Wraps entire app. Manages Keycloak lifecycle, token refresh (30s interval), exposes `authenticated`, `token`, `userInfo`
- **NatsProvider** — Nested inside ChatApp (requires auth). Manages WebSocket NATS connection using the Keycloak access token
- **MessageProvider** — Nested inside NatsProvider. Subscribes to `deliver.{username}.>` once, tracks room membership via `room.join.*`/`room.leave.*` events, dispatches messages to rooms. Manages user presence status via `presence.update` publish and `presence.room.*` request/reply queries. Exposes `setStatus()` and per-room `onlineUsers` with status info (online/away/busy/offline)

**Component tree:** `App → ChatApp → NatsProvider → MessageProvider → ChatContent → [Header, RoomSelector, ChatRoom → [MessageList, MessageInput]]`

Room names map to NATS subjects for publishing: room "general" → subject `chat.general`, admin rooms → `admin.chat`. Messages are received via per-user delivery subjects: `deliver.{username}.chat.{room}`.

### NATS Configuration (`nats/nats-server.conf`)

Three accounts: AUTH (service credentials), CHAT (application users), SYS (system). Auth callout is configured with a static issuer NKey and XKey. WebSocket on port 9222 (no TLS). JetStream enabled with `CHAT_MESSAGES` stream for message persistence.

### Keycloak Configuration (`keycloak/realm-export.json`)

Realm "nats-chat" with client "nats-chat-app" (public SPA, PKCE). Pre-configured test users:
- alice/alice123 (admin + user roles)
- bob/bob123 (user role)
- charlie/charlie123 (no roles, read-only)

### Observability Stack

- **OTel Collector** (`otel/otel-collector-config.yaml`) — Routes traces to Tempo, metrics to Prometheus (remote write), logs to Loki (native OTLP endpoint)
- **Tempo** (`tempo/tempo.yaml`) — Trace storage, pinned to v2.7.2 (v3 has incompatible single-binary config)
- **Prometheus** (`prometheus/prometheus.yaml`) — Metrics storage with remote write receiver enabled via CLI flag
- **Loki** (`loki/loki.yaml`) — Log aggregation with TSDB storage and structured metadata
- **Grafana** (`grafana/provisioning/`) — Auto-provisioned datasources (Tempo, Prometheus, Loki with cross-linking) and a pre-built "NATS Chat - Distributed Tracing" dashboard

## Key Design Decisions

- **All NKeys/XKeys in config are demo-only** — hardcoded in docker-compose.yml and nats-server.conf for ease of setup
- **Message persistence** — JetStream streams chat messages; persist-worker consumes and writes to PostgreSQL; history-service queries on demand via NATS request/reply
- **Auth service retries** — 30 attempts with 2s wait for both NATS and Keycloak connections (handles Docker Compose startup ordering)
- **Token as NATS credential** — browser passes Keycloak access_token directly as NATS connection token; auth callout validates it server-side
- **Environment variables** — web app uses `VITE_` prefix (Vite convention) for Keycloak/NATS URLs; Go services read `NATS_URL`, `DATABASE_URL`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`
- **Shared OTel module** — `pkg/otelhelper/` is referenced via Go module `replace` directives; Dockerfiles use root build context to copy shared code
- **Per-user fan-out delivery** — clients subscribe to a single `deliver.{username}.>` subject instead of per-room subscriptions. A fan-out service subscribes to `chat.*`/`admin.*` via queue group, looks up room members in-memory, and re-publishes to each member's delivery subject. This reduces client subscriptions from O(rooms) to O(1) and allows the server to scale via queue group replication.
- **Room membership via pub/sub** — clients publish `room.join.{room}` and `room.leave.{room}` events. Both fanout-service and presence-service maintain membership in-memory independently. Stale entries are cleaned up by presence-service via periodic `/connz` polling.
- **Presence via NATS KV** — user statuses (online/away/busy/offline) are stored in a NATS KV bucket (`PRESENCE`, in-memory, history=1). Presence-service writes to KV on status updates, reads from KV for room queries, and broadcasts changes to room members via `deliver.{member}.presence.{room}`. Clients set status via `presence.update` and query via `presence.room.*` request/reply.
- **W3C Trace Context over NATS** — trace context propagated in NATS message headers, linking producer/consumer spans across services
