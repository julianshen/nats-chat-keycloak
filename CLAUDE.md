# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A real-time chat application demonstrating NATS Auth Callout integration with Keycloak OIDC. The system authenticates users via Keycloak, then a Go auth service validates tokens and maps Keycloak realm roles to NATS pub/sub permissions, enabling role-based real-time chat over WebSocket. Messages are persisted to PostgreSQL via JetStream, and the entire system is instrumented with OpenTelemetry for distributed tracing, metrics, and logs.

## Build & Run Commands

```bash
# Start all 15 services
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
cd room-service && go build -o room-service .
```

No test suites or linters are configured.

## Architecture

```
Browser (React + nats.ws)
  │  1. OIDC login → Keycloak → access_token
  │  2. WebSocket CONNECT to NATS (token = access_token)
  │  3. Subscribe to deliver.{userId}.> (single subscription per user)
  │  4. Publish room.join.{room} / room.leave.{room} for membership
  │  5. Heartbeat presence.heartbeat / presence.disconnect / request presence.room.{room}
  ▼
NATS Server 2.12 (auth_callout + JetStream)
  │  6. Forwards auth to $SYS.REQ.USER.AUTH
  │  7. Messages published to chat.{room} or chat.{room}.thread.{threadId} → JetStream CHAT_MESSAGES stream
  ▼
Auth Service (Go)     Fanout Service (Go)      Persist Worker (Go)     History Service (Go)
  • Validates JWT       • Subscribes chat.>       • Consumes JetStream     • Listens chat.history.*
  • Maps roles →        • LRU cache for room      • Writes to PostgreSQL     and chat.history.*.thread.*
    permissions           membership (no KV watch) • Persists thread fields • Returns JSON via reply
  • Per-user deliver    • Cache miss → room.members  (thread_id, broadcast)   with reply counts
    subject scoping       request/reply to room-svc • OTel instrumented     • OTel instrumented
                        • Delta room.changed.* updates cached rooms only
                        • 32-goroutine worker pool for parallel publishes
                        • Subscribes presence.event.* for presence delivery

Room Service (Go)
  • Sharded per-key KV: ROOMS bucket, key = {room}.{userId} → {} (FileStorage)
  • Queue group room-workers (horizontally scalable, N instances)
  • room.join.* → kv.Create() O(1) idempotent, room.leave.* → kv.Delete() O(1)
  • Publishes delta room.changed.{room} {action, userId} (no full member list)
  • Subscribes room.changed.* (no QG) to rebuild local forward-index
  • Responds to room.members.{room} via QG from local cache
  • OTel instrumented

Presence Service (Go)
  • Two KV buckets: PRESENCE (user status), PRESENCE_CONN (per-connection, 45s TTL)
  • Dual-index membership: forward (room→users) + reverse (user→rooms) for O(1) userRooms
  • Subscribes room.changed.* (delta) + hydrates from ROOMS KV on startup
  • Subscribes presence.heartbeat + presence.disconnect (queue group)
  • Subscribes presence.update (client status changes, queue group)
  • Responds to presence.room.{room} (request/reply queries)
  • KV watcher on PRESENCE_CONN detects expired keys → offline cleanup
  • Publishes presence.event.{room} for fanout delivery
  • Multi-device: user online while any connection heartbeating

User Search Service (Go)
  • Queries Keycloak Admin API for user search
  • Subscribes users.search (request/reply)
  • Caches admin token, auto-refreshes on expiry
  • OTel instrumented

Translation Service (Go)
  • Subscribes translate.request (queue group translate-workers)
  • Calls Ollama streaming API (translategemma model)
  • Async: publishes result to deliver.{user}.translate.response
  • Supports: en, ja, hi, pl, de, zh-TW
  • OTel instrumented

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
- **permissions.go** — Role-to-permission mapping. Users publish to `chat.>` and subscribe to `deliver.{username}.>` (per-user scoped delivery). Includes `room.join.*`/`room.leave.*` for fan-out membership, and `presence.update`/`presence.heartbeat`/`presence.disconnect`/`presence.room.*` for presence status.

Auth callout uses NKeys for JWT signing and XKey (Curve25519) for payload encryption between NATS server and auth service.

### Fanout Service (`fanout-service/`)

Single-file Go service that manages per-user message delivery. Subscribes to `chat.>` and `admin.*` via a `fanout-workers` queue group (horizontally scalable). Uses an **LRU cache** (capacity configurable via `FANOUT_LRU_CAPACITY`, default 100) instead of watching the entire ROOMS KV bucket. Subscribes to `room.changed.*` (no QG) to apply delta updates to cached rooms only — uncached rooms are discarded. On cache miss, fetches membership via `room.members.{room}` request/reply to room-service. A **32-goroutine worker pool** (configurable via `FANOUT_WORKERS`) parallelizes `deliver.{userId}.{subject}` publishes. Also subscribes to `presence.event.*` (queue group) to fan out presence events to room members. OTel instrumented with `fanout_messages_total`, `fanout_duration_seconds`, `fanout_room_count`, `fanout_total_members`, and `fanout_cache_misses_total` metrics.

### Room Service (`room-service/`)

Single-file Go service that manages room membership via a **sharded per-key KV layout**. The ROOMS KV bucket (FileStorage, History: 1) uses keys formatted as `{room}.{userId}` → `{}` instead of storing arrays per room. Subscribes to `room.join.*` and `room.leave.*` via **`room-workers` queue group** (horizontally scalable, N instances — no single-writer bottleneck). On join: `kv.Create(room+"."+userId)` — O(1), idempotent via `ErrKeyExists`. On leave: `kv.Delete(room+"."+userId)` — O(1), no-op if not found. Publishes **delta** `room.changed.{room}` events containing only `{action, userId}` (no full member list). Subscribes to `room.changed.*` (no QG) to rebuild a local forward-index from all deltas (including its own). Responds to `room.members.{room}` via `room-members-workers` queue group from the local cache. Hydrates local membership from KV on startup using subscribe-first pattern. OTel instrumented with `room_joins_total`, `room_leaves_total`, `room_queries_total`, and `room_active_rooms` gauge.

### Presence Service (`presence-service/`)

Single-file Go service that manages user presence status using two NATS KV buckets. `PRESENCE` (no TTL) stores aggregated user status keyed by userId. `PRESENCE_CONN` (45s TTL, in-memory) stores per-connection heartbeats keyed by `{userId}.{connId}` — auto-expires if not refreshed. Clients send heartbeats every 10s to `presence.heartbeat` and publish `presence.disconnect` on graceful tab close. A `connTracker` in-memory mirror avoids full KV scans. A KV watcher on `PRESENCE_CONN` detects expired keys (tab crash) and cleans up. Multi-device support: user stays online while any connection is alive. Heartbeat, disconnect, and status update handlers use `presence-workers` queue group for horizontal scaling. Uses a **`dualMembership`** with both forward (room→users) and reverse (user→rooms) indexes — `userRooms()` is O(1) via reverse index, `removeUserFromAll()` is O(user's rooms). Receives room membership via `room.changed.*` **delta events** from room-service (no queue group). Hydrates from ROOMS KV on startup using subscribe-first pattern. Responds to `presence.room.*` queries with liveness cross-check, and publishes presence snapshots to `presence.event.{room}` (fanout-service handles per-member delivery). OTel instrumented with `presence_updates_total`, `presence_queries_total`, `presence_query_duration_seconds`, `presence_heartbeats_total`, `presence_disconnects_total`, and `presence_expirations_total` metrics.

### Persist Worker (`persist-worker/`)

Single-file Go service that consumes from the JetStream `CHAT_MESSAGES` stream (subjects: `chat.>`, `admin.*`) and writes messages to PostgreSQL, including thread fields (`thread_id`, `parent_timestamp`, `broadcast`). Instrumented with OTel consumer spans, `otelsql` for DB tracing, and `messages_persisted_total`/`messages_persist_errors_total` counters.

### History Service (`history-service/`)

Single-file Go service that listens on `chat.history.*` and `chat.history.*.thread.*` via NATS request/reply. Room history queries return the last 50 messages (excluding thread replies where `thread_id IS NULL`) annotated with `replyCount` via a correlated subquery. Thread history queries return up to 200 replies for a given `thread_id` in ascending order. Instrumented with OTel server spans, `otelsql`, and `history_requests_total`/`history_request_duration_seconds` metrics.

### User Search Service (`user-search-service/`)

Single-file Go service that queries the Keycloak Admin API for user search and exposes results via NATS request/reply on `users.search`. Fetches admin token from Keycloak (`POST /realms/master/protocol/openid-connect/token`) with caching and auto-refresh. Search queries call `GET /admin/realms/{realm}/users?search={query}&max=20` and return `[{username, firstName, lastName}]`. OTel instrumented with `user_search_requests_total` and `user_search_duration_seconds` metrics.

### Translation Service (`translation-service/`)

Single-file Go service that provides on-demand message translation via Ollama using async publish/subscribe (no request/reply timeout). Subscribes to `translate.request` via `translate-workers` queue group (horizontally scalable). Request payload: `{ "text": "...", "targetLang": "ja", "user": "alice", "msgKey": "1234-alice" }`. Calls Ollama streaming API (`POST /api/generate` with `translategemma` model) using the recommended prompt format (professional translator preamble with language codes, two blank lines before text). Publishes result to the requesting user's deliver subject: `deliver.{user}.translate.response` with payload `{ "translatedText": "...", "targetLang": "ja", "msgKey": "1234-alice" }`. The browser's existing `deliver.{username}.>` subscription receives the result asynchronously — no timeout constraint on LLM inference. Supported languages: `en` (English), `ja` (Japanese), `hi` (Hindi), `pl` (Polish), `de` (German), `zh-TW` (Traditional Chinese). Requires Ollama running on host with `translategemma` model. OTel instrumented with `translate_requests_total` and `translate_duration_seconds` metrics. `OLLAMA_URL` env var configurable (default `http://localhost:11434`).

### Shared OTel Helper (`pkg/otelhelper/`)

Shared Go module (`github.com/example/nats-chat-otelhelper`) used by all Go services:
- **otel.go** — `Init(ctx)` sets up trace, metric, and log providers via OTLP/gRPC. Reads `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_SERVICE_NAME` env vars.
- **nats.go** — NATS trace propagation: `NatsHeaderCarrier` (W3C Trace Context over NATS headers), `TracedPublish`, `TracedRequest`, `StartConsumerSpan`, `StartServerSpan`.

Go services reference this module via `replace` directive in their `go.mod` files. Dockerfiles copy `pkg/otelhelper/` into the build context.

### Web Frontend (`web/`)

React 18 + TypeScript + Vite. No CSS framework — all styles are inline TypeScript objects with a dark theme.

**State management via three Context providers (no Redux):**
- **AuthProvider** — Wraps entire app. Manages Keycloak lifecycle, token refresh (30s interval), exposes `authenticated`, `token`, `userInfo`
- **NatsProvider** — Nested inside ChatApp (requires auth). Manages WebSocket NATS connection using the Keycloak access token
- **MessageProvider** — Nested inside NatsProvider. Subscribes to `deliver.{username}.>` once, tracks room membership via `room.join.*`/`room.leave.*` events, dispatches messages to rooms. Routes thread messages (detected via `.thread.` in deliver subject) to separate `threadMessagesByThreadId` state and tracks `replyCounts`. Routes translation responses (detected via `translate` subject type) to `translationResults` state keyed by `msgKey`. Manages active thread panel state via `openThread`/`closeThread`. Also manages user presence: generates a per-tab `connId`, heartbeats every 10s to `presence.heartbeat`, publishes `presence.disconnect` on tab close, and queries via `presence.room.*` request/reply. Exposes `setStatus()` and per-room `onlineUsers` with status info (online/away/busy/offline)

**Component tree:** `App → ChatApp → NatsProvider → MessageProvider → ChatContent → [Header, RoomSelector, ChatRoom → [MessageList, MessageInput, ThreadPanel?]]`

Room names map to NATS subjects for publishing: room "general" → subject `chat.general`, admin rooms → `admin.chat`. Thread replies publish to `chat.{room}.thread.{threadId}` where `threadId` = `{room}-{parentTimestamp}`. Messages are received via per-user delivery subjects: `deliver.{username}.chat.{room}` (main) or `deliver.{username}.chat.{room}.thread.{threadId}` (thread). ThreadPanel is a slide-in side panel that loads thread history, displays replies, and provides a reply input with an "Also send to channel" broadcast checkbox.

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
- **Per-user fan-out delivery** — clients subscribe to a single `deliver.{username}.>` subject instead of per-room subscriptions. A fan-out service subscribes to `chat.>`/`admin.*` via queue group, looks up room members in-memory, and re-publishes to each member's delivery subject. This reduces client subscriptions from O(rooms) to O(1) and allows the server to scale via queue group replication.
- **Thread as sub-subject** — thread replies publish to `chat.{room}.thread.{threadId}` where `threadId` = `{room}-{parentTimestamp}`. This leverages NATS multi-level wildcards (`chat.>`) to route thread messages through the same fan-out and persistence infrastructure. Thread replies default to thread-only but can optionally broadcast to the main room timeline (two publishes). No thread nesting — all replies in a thread are flat. PostgreSQL stores `thread_id`, `parent_timestamp`, and `broadcast` columns with an index on `(thread_id, timestamp)`.
- **Sharded per-key room membership** — the ROOMS KV bucket uses per-membership keys (`{room}.{userId}` → `{}`) instead of whole-room arrays. This enables O(1) `kv.Create()`/`kv.Delete()` per join/leave (no read-modify-write), per-key writes eliminate conflicts between room-service instances (horizontally scalable via `room-workers` queue group), FileStorage supports 10M+ keys surviving NATS restarts, and delta events (`{action, userId}`) keep payloads constant-size (~50 bytes) instead of O(members). Downstream services maintain their own local state from the delta stream: fanout uses an LRU cache, presence uses a dual-index, read-receipt uses a forward-index.
- **Presence broadcast via fanout** — presence-service publishes presence snapshots to `presence.event.{room}` instead of directly to per-member `deliver.{member}.presence.{room}` subjects. Fanout-service subscribes to `presence.event.*` (queue group) and handles per-member delivery using its LRU membership cache. This eliminates N-copy broadcasts when multiple presence-service instances run.
- **Presence via heartbeat + NATS KV** — two KV buckets: `PRESENCE` (no TTL) for aggregated user status, `PRESENCE_CONN` (45s TTL) for per-connection heartbeats keyed by `{userId}.{connId}`. Each browser tab generates a unique connId, heartbeats every 10s to `presence.heartbeat`, and sends `presence.disconnect` on tab close. A KV watcher detects expired keys (tab crash/no heartbeat) and cleans up. Multi-device: user stays online while any connection has an active heartbeat. Handlers use `presence-workers` queue group for horizontal scaling. No single-server HTTP polling dependency.
- **Direct messages as canonical rooms** — DMs use `dm-` + sorted usernames (e.g. `dm-alice-bob`) as a single-segment room name. This reuses existing `chat.>` fanout, persist-worker, and history-service infrastructure with zero changes. The initiator publishes `room.join` for both users, establishing fanout membership. Recipients auto-discover DMs from incoming messages. DM room list persists in localStorage.
- **User search via Keycloak Admin API** — A dedicated `user-search-service` queries Keycloak's Admin REST API server-side, keeping admin credentials out of the browser. Results are exposed via NATS `users.search` request/reply.
- **W3C Trace Context over NATS** — trace context propagated in NATS message headers, linking producer/consumer spans across services
- **End-to-end browser-to-backend tracing** — the web client generates W3C `traceparent` headers using `crypto.getRandomValues()` and injects them into every NATS publish/request via `nats.ws` headers API (`web/src/utils/tracing.ts`). Zero npm dependencies added. Go backend services extract these via `otelhelper.StartConsumerSpan`/`StartServerSpan`, creating linked traces from browser action to database write. `pkg/otelhelper/otel.go` wraps the default slog handler with `tracingHandler` to auto-inject `trace_id`/`span_id` into all log records, enabling Grafana Loki→Tempo cross-linking
- **Async translation via Ollama** — translation-service subscribes to `translate.request` via queue group, calls Ollama streaming API with the `translategemma` model using its recommended prompt format. Browser fire-and-forgets a publish to `translate.request` (including `user` and `msgKey`), then receives the result asynchronously via `deliver.{user}.translate.response` through the existing deliver subscription — no timeout constraint, so LLM inference can take as long as needed. MessageProvider routes translation responses to `translationResults` state; ChatRoom tracks `translatingKeys` locally and clears them when results arrive. `OLLAMA_URL` defaults to `host.docker.internal:11434` in Docker (host GPU access).
