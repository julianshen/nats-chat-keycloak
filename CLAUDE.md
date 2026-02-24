# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A real-time chat application demonstrating NATS Auth Callout integration with Keycloak OIDC. The system authenticates users via Keycloak, then a Go auth service validates tokens and maps Keycloak realm roles to NATS pub/sub permissions, enabling role-based real-time chat over WebSocket. Messages are persisted to PostgreSQL via JetStream, and the entire system is instrumented with OpenTelemetry for distributed tracing, metrics, and logs.

## Build & Run Commands

```bash
# Start all 22 services (Docker Compose)
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
cd sticker-service && go build -o sticker-service .
cd app-registry-service && go build -o app-registry-service .
cd poll-service && go build -o poll-service .

# Java services
cd apps/kb/service && mvn package -DskipTests

# Angular apps
cd apps/kb/app && npm install && npx ng build --configuration=production && node build.mjs

# Kubernetes (local) — build images + deploy to OrbStack/K3S
./k8s/build-local.sh

# Kubernetes (manual)
kubectl apply -k k8s/overlays/local    # Local dev (access web at http://localhost:30000)
kubectl apply -k k8s/overlays/cloud    # Production
kubectl -n nats-chat get pods           # Check status (27 pods + 1 completed init Job)
kubectl -n nats-chat rollout restart deployment web  # Redeploy after image rebuild
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
  • Dual auth callout:   • Subscribes chat.>       • Consumes JetStream     • Listens chat.history.*
    browser (JWT) +      • LRU cache for room      • Writes to PostgreSQL     and chat.history.*.thread.*
    service (user/pass)    membership (no KV watch) • Persists thread fields • Returns JSON via reply
  • DB-backed service   • Cache miss → room.members  (thread_id, broadcast)   with reply counts
    accounts (cached)     request/reply to room-svc • OTel instrumented     • OTel instrumented
  • Maps roles → perms
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
  • Subscribes translate.ping (no queue group) → responds {available: bool}
  • Calls Ollama SDK streaming API (translategemma model)
  • Health tracking: atomic.Bool probed at startup + every 30s + on translate success/failure
  • Async: publishes streaming chunks to deliver.{user}.translate.response
  • Supports: en, ja, hi, pl, de, zh-TW
  • OTel instrumented

Sticker Service (Go)              Sticker Images (nginx)
  • Pure NATS service (no HTTP)     • nginx:alpine serving static SVGs
  • stickers.products → all packs   • Port 8090, /images/ with CORS
  • stickers.product.* → pack items • Health check at /health
  • Reads from PostgreSQL           • No dependencies
  • OTel instrumented

App Registry Service (Go)         Poll Service (Go)                 Poll App (nginx)
  • apps.list → all registered      • Subscribes app.poll.> (QG       • nginx:alpine serving poll-app.js
    apps                               poll-workers)                  • Port 8091, CORS headers
  • apps.room.* → per-room         • create/list/vote/results/close  • Web Component <room-app-poll>
    installed apps                   • Publishes app.poll.{room}.      loaded by host ChatRoom
  • apps.install/uninstall.*          updated for real-time fanout
  • Reads/writes PostgreSQL         • Reads/writes PostgreSQL
  • OTel instrumented               • OTel instrumented

KB Service (Java/Spring Boot)     KB App (nginx)
  • Subscribes app.kb.> (QG          • nginx:alpine serving kb-app.js
    kb-workers)                      • Port 8093, CORS headers
  • list/create/load/save/delete     • Angular 19 Web Component
  • Editing presence tracking          (zoneless, light DOM)
    (ConcurrentHashMap + 60s expiry) • Rich text editor (contenteditable)
  • Publishes app.kb.{room}.presence • Auto-save debounced at 2s
  • Reads/writes PostgreSQL          • Real-time editing indicators
  • Spring Boot 3.2, no HTTP server

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
| Sticker Images | 8090 | Static sticker image server (nginx) |
| Poll App | 8091 | Poll app Web Component (nginx) |
| Whiteboard App | 8092 | Whiteboard app Web Component (nginx) |
| KB App | 8093 | Knowledge Base app Web Component (nginx) |
| Grafana | 3001 | Observability dashboards |

### Auth Service (`auth-service/`)

Five Go files, each with a single responsibility:
- **main.go** — Initialization, OTel setup, PostgreSQL connection with retry, service account cache, NATS connection with retry, subscription to `$SYS.REQ.USER.AUTH`
- **handler.go** — Core auth callout with dual auth: detects token-based (browser) vs username/password (service) connections. Browser auth validates Keycloak JWT and maps roles to scoped permissions. Service auth checks credentials against the in-memory cache and grants broad `>` pub/sub. Instrumented with tracing spans (`auth.type` attribute: "browser" or "service") and `auth_requests_total`/`auth_request_duration_seconds` metrics.
- **keycloak.go** — JWKS key fetching/caching via `keyfunc` library, with retry on startup
- **permissions.go** — Role-to-permission mapping for browser users (scoped `deliver.{username}.>` + role-specific subjects). `servicePermissions()` returns broad `>` pub/sub for backend services.
- **service_accounts.go** — `ServiceAccountCache` loads all service accounts from PostgreSQL `service_accounts` table into memory on startup, refreshes every 5 minutes. `Authenticate(username, password)` checks against the cache. Adding a new room app service only requires an `INSERT INTO service_accounts` — no NATS restart needed.

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

Single-file Go service that provides on-demand message translation via Ollama using async publish/subscribe (no request/reply timeout). Subscribes to `translate.request` via `translate-workers` queue group (horizontally scalable). Also subscribes to `translate.ping` (no queue group — lightweight, avoids blocking behind busy translate workers) for health probes, responding with `{"available": true/false}` based on an `atomic.Bool` health flag. Health is determined by: startup model probe via Ollama SDK `Show()`, success/failure of each translation, and a background goroutine re-probing Ollama every 30s. Request payload: `{ "text": "...", "targetLang": "ja", "user": "alice", "msgKey": "1234-alice" }`. Uses the Ollama Go SDK (`github.com/ollama/ollama/api`) with streaming callbacks to publish translation chunks to `deliver.{user}.translate.response` with payload `{ "translatedText": "...", "targetLang": "ja", "msgKey": "1234-alice", "done": false }`. Chunks are batched at 100ms intervals; the final chunk has `done: true`. The browser's existing `deliver.{username}.>` subscription receives chunks asynchronously — no timeout constraint on LLM inference. Supported languages: `en` (English), `ja` (Japanese), `hi` (Hindi), `pl` (Polish), `de` (German), `zh-TW` (Traditional Chinese). Requires Ollama running on host with `translategemma` model. OTel instrumented with `translate_requests_total` and `translate_duration_seconds` metrics. `OLLAMA_URL` env var configurable (default `http://localhost:11434`).

### Sticker Service (`sticker-service/`)

Single-file Go service that provides sticker metadata via NATS request/reply, backed by PostgreSQL. Subscribes to `stickers.products` (returns all sticker packs with thumbnail URLs) and `stickers.product.*` (returns stickers for a given pack with image URLs). Constructs full image URLs using `STICKER_BASE_URL` env var (default `http://localhost:8090/images`). Pure NATS service — no HTTP server. OTel instrumented with `sticker_requests_total` and `sticker_request_duration_seconds` metrics.

### Sticker Images (`sticker-images/`)

Lightweight nginx:alpine container serving static sticker SVG images on port 8090. Serves `/images/` with CORS headers (`Access-Control-Allow-Origin: *`) and a `/health` endpoint. Decoupled from sticker-service so the NATS metadata service and static file server can scale independently. No dependencies on other services.

### App Registry Service (`app-registry-service/`)

Single-file Go service that manages the room app registry and per-room app installations via NATS request/reply, backed by PostgreSQL. Subscribes to `apps.list` (returns all registered apps), `apps.room.*` (returns apps installed in a room via JOIN), `apps.install.*` (inserts into `channel_apps`), and `apps.uninstall.*` (deletes from `channel_apps`). All handlers use `app-registry-workers` queue group (horizontally scalable). OTel instrumented with `app_registry_requests_total` and `app_registry_request_duration_seconds` metrics.

### Poll Service (`poll-service/`)

Single-file Go service implementing the poll room app backend. Subscribes to `app.poll.>` via `poll-workers` queue group. Parses subject as `app.poll.{room}.{action}` and dispatches to handlers: `create` (insert poll), `list` (active polls for room), `vote` (upsert with ON CONFLICT), `results` (poll + vote counts + user's vote), `close` (creator only). On vote/create/close, publishes `app.poll.{room}.updated` for real-time fanout to room members. Uses PostgreSQL tables `polls` and `poll_votes`. OTel instrumented with `poll_requests_total` and `poll_request_duration_seconds` metrics.

### Poll App (`poll-app/`)

Standalone Web Component (`<room-app-poll>`) served as a single JS file by nginx on port 8091. Features: list active polls with horizontal bar chart results, create poll form (question + dynamic options), click to vote with real-time updates via `bridge.subscribe('updated')`, creator can close polls. Uses Shadow DOM for style isolation. Communicates exclusively through the host-injected `AppBridge` SDK — no direct network access.

### KB Service (`apps/kb/service/`)

Java/Spring Boot 3.2 service implementing the knowledge base room app backend. Runs with `spring.main.web-application-type=none` (no HTTP server — pure NATS). Connects to NATS on startup with 30-attempt retry (matching Go services). Subscribes to `app.kb.>` via `kb-workers` queue group (horizontally scalable). Parses subject as `app.kb.{room}.{action}` and dispatches to handlers: `list` (pages for room), `create` (insert page with UUID), `load` (page + current editors), `save` (update title/content/updatedBy), `delete` (remove page), `editing` (add user to presence tracker), `stopedit` (remove user from presence tracker). On editing/stopedit, publishes `app.kb.{room}.presence` with `{pageId, editors: [...]}` for real-time editing awareness. Uses Spring JDBC (`JdbcTemplate`) for PostgreSQL access. `EditingPresenceTracker` uses `ConcurrentHashMap<String, ConcurrentHashMap<String, Instant>>` (pageId → {username → lastSeen}) with a background `ScheduledExecutorService` cleaning entries older than 60s every 30s. The AppBridge injects `user` (not `username`) into every request payload.

### KB App (`apps/kb/app/`)

Angular 19 standalone Web Component (`<room-app-kb>`) served as a single JS file by nginx on port 8093. Uses **zoneless change detection** (`provideExperimentalZonelessChangeDetection()`) to avoid zone.js conflicts with the host React app — all async state changes use `ChangeDetectorRef.markForCheck()`. Built with Angular's `application` builder; a `build.mjs` post-build script concatenates all output chunks + CSS into a single `kb-app.js` IIFE. Uses light DOM (`ViewEncapsulation.None`) with `.kb-` prefixed class names for style isolation. Features: page list with create/navigate, rich text editor using `contenteditable` + `document.execCommand()` (bold, italic, headings, lists, links), editable title field, 2s debounced auto-save, real-time editing presence indicators (colored chips showing "X is editing"), and page deletion. The `setBridge()` method stores the bridge globally, creates a `<kb-root>` element, and calls `bootstrapApplication(AppComponent)` to mount Angular into it. Communicates exclusively through the host-injected `AppBridge` SDK.

### AppBridge SDK (`web/src/lib/AppBridge.ts`)

TypeScript module providing the bridge between guest Web Component apps and the host's NATS connection. Exports `createAppBridge(nc, sc, appId, room, username)` which returns a frozen `AppBridge` object with `request(action, data)` (scoped to `app.{appId}.{room}.{action}`) and `subscribe(event, callback)` (registers in shared `appCallbacks` map). User context is injected into every outgoing payload. Action names validated against wildcard characters. `routeAppMessage(appId, room, event, data)` is called by MessageProvider to dispatch incoming `deliver.{user}.app.*` messages to registered callbacks. `destroyAppBridge(appId, room)` cleans up all subscriptions on app unmount.

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
- **MessageProvider** — Nested inside NatsProvider. Subscribes to `deliver.{username}.>` once, tracks room membership via `room.join.*`/`room.leave.*` events, dispatches messages to rooms. Routes thread messages (detected via `.thread.` in deliver subject) to separate `threadMessagesByThreadId` state and tracks `replyCounts`. Routes translation responses (detected via `translate` subject type) to `translationResults` state keyed by `msgKey`, accumulating streaming chunks. Manages active thread panel state via `openThread`/`closeThread`. Also manages user presence: generates a per-tab `connId`, heartbeats every 10s to `presence.heartbeat`, publishes `presence.disconnect` on tab close, and queries via `presence.room.*` request/reply. Exposes `setStatus()` and per-room `onlineUsers` with status info (online/away/busy/offline). Pings `translate.ping` once on NATS connect; exposes `translationAvailable` boolean and `markTranslationUnavailable()` callback. Recovery polling (60s) runs only while unavailable, checked via ref to avoid useEffect dependency loops.

**Component tree:** `App → ChatApp → NatsProvider → MessageProvider → ChatContent → [Header, RoomSelector, ChatRoom → [MessageList, MessageInput, ThreadPanel?]]`

Room names map to NATS subjects for publishing: room "general" → subject `chat.general`, admin rooms → `admin.chat`. Thread replies publish to `chat.{room}.thread.{threadId}` where `threadId` = `{room}-{parentTimestamp}`. Messages are received via per-user delivery subjects: `deliver.{username}.chat.{room}` (main) or `deliver.{username}.chat.{room}.thread.{threadId}` (thread). ThreadPanel is a slide-in side panel that loads thread history, displays replies, and provides a reply input with an "Also send to channel" broadcast checkbox.

### NATS Configuration (`nats/nats-server.conf`)

Three accounts: AUTH (auth service only), CHAT (dynamically authenticated users and services), SYS (system). Only the `auth` user is listed in `auth_users` (bypasses auth callout). All other connections — both browser users and backend services — are authenticated via the auth callout handler, which returns a signed JWT placing them in the CHAT account. WebSocket on port 9222 (no TLS). JetStream enabled with `CHAT_MESSAGES` stream for message persistence.

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

## Kubernetes Deployment (`k8s/`)

Kustomize base + overlay structure supporting both local (OrbStack/K3S) and cloud (GKE/EKS/AKS) environments. Docker Compose remains the primary local dev workflow; K8s is an alternative deployment target.

### Directory Structure

```
k8s/
  base/                          # Environment-neutral manifests
    kustomization.yaml           # Lists all resources, configMapGenerator for realm-export.json
    namespace.yaml               # nats-chat namespace
    nats/                        # StatefulSet + Service + ConfigMap (nats-server.conf)
    postgres/                    # StatefulSet + Service + ConfigMap (init.sql) + init Job
    keycloak/                    # Deployment + Service + realm-export.json
    {service}/deployment.yaml    # 14 backend services (Go + Java, NATS-only — no Service needed)
    {static-server}/             # 4 nginx servers + web: Deployment + Service
    {observability}/             # OTel Collector, Tempo, Prometheus, Loki, Grafana
  overlays/
    local/                       # Localhost URLs, NodePort services, demo Secrets
    cloud/                       # Production URLs, TLS Ingress, image tag overrides
  build-local.sh                 # Builds all images + applies local overlay
```

### Resource Types

- **StatefulSets** (5): NATS, PostgreSQL, Tempo, Prometheus, Loki — need persistent storage
- **Deployments** (22): All stateless services — Go/Java backends, nginx static servers, web, Keycloak, Grafana, OTel Collector
- **Services** (20): Infrastructure + nginx servers + web + observability. Go backend services have no Service (they're NATS subscribers, not HTTP servers)
- **ConfigMaps** (9): nats-server.conf, init.sql, realm-export.json, env.js, OTel/Tempo/Prometheus/Loki/Grafana configs
- **Jobs** (1): postgres-init — runs `sed` to replace `${APP_BASE_URL}` in init.sql component_url values, then pipes to `psql` (alpine lacks `envsubst`)
- **Secrets** (3, in local overlay): postgres-credentials, auth-service-nkeys, keycloak-admin — cloud creates these out-of-band

### URL Parameterization (6 places overlays patch)

| What | Base Value | Local Overlay | Cloud Overlay |
|------|-----------|---------------|---------------|
| `KEYCLOAK_ISSUER_URL` in auth-service | `http://keycloak:8080/realms/nats-chat` | `http://localhost:30000/auth/realms/nats-chat` | `https://auth.example.com/realms/nats-chat` |
| `KC_HOSTNAME_URL` in keycloak | (none) | `http://localhost:30000/auth` | `https://auth.example.com` |
| `VITE_KEYCLOAK_URL` in web env.js | `http://keycloak:8080` | `http://localhost:30000/auth` | `https://auth.example.com` |
| `VITE_NATS_WS_URL` in web env.js | `ws://nats:9222` | `ws://localhost:30000/nats-ws` | `wss://nats.example.com` |
| `STICKER_BASE_URL` in sticker-service | `http://sticker-images:8090/images` | `http://localhost:30000/sticker-images` | `https://apps.example.com:8090/images` |
| `APP_BASE_URL` in postgres init Job | `http://localhost` | `http://localhost:30000` | `https://apps.example.com` |

### Web Frontend Runtime Config

Production builds use `web/Dockerfile.prod` (multi-stage: node builder → nginx:alpine) with `web/nginx.conf` for SPA routing and reverse proxying. Runtime environment injection via `<script src="/env.js">` in `index.html` — the `env.js` file is a ConfigMap mounted into nginx's static root. Providers read `window.__env__` with fallback to `import.meta.env` for backward compatibility with the Vite dev server and Docker Compose workflow. In K8s, `nginx.conf` also contains reverse proxy `location` blocks for Keycloak (`/auth/`), NATS WebSocket (`/nats-ws`), sticker images (`/sticker-images/`), room apps (`/apps/{poll,whiteboard,kb}/`), and Grafana (`/grafana/`), consolidating all browser traffic through a single port.

### Local Overlay Access

Local overlay exposes a single NodePort (30000) running nginx as a reverse proxy. All browser-facing services are routed through path-based locations in `web/nginx.conf`:

| Path | Backend | Notes |
|------|---------|-------|
| `/` | static SPA files | `try_files` fallback to `index.html` |
| `/auth/` | `keycloak:8080` | Strips prefix, `X-Forwarded-*` headers, large buffers for OIDC |
| `/nats-ws` | `nats:9222` | WebSocket upgrade, 3600s read/send timeout |
| `/sticker-images/` | `sticker-images:8090/images/` | Rewrites prefix |
| `/apps/poll/` | `poll-app:8091` | Strips prefix |
| `/apps/whiteboard/` | `whiteboard-app:8092` | Strips prefix |
| `/apps/kb/` | `kb-app:8093` | Strips prefix |
| `/grafana/` | `grafana:3000` | Grafana serves from sub-path via `GF_SERVER_SERVE_FROM_SUB_PATH` |

### Deployment Gotchas

- **`imagePullPolicy: IfNotPresent`** — required for all local image deployments; default `Always` fails for locally-built images not in a registry
- **Keycloak 26 health probes** — health endpoints require `--health-enabled=true` and are served on management port 9000, not the main HTTP port 8080. First-time realm import is slow; `livenessProbe.initialDelaySeconds: 120` prevents premature restarts
- **NATS monitoring port** — `http_port: 8222` must be set in `nats-server.conf` for health probe endpoints (`/healthz`); without it, liveness probes fail and NATS enters CrashLoopBackOff
- **postgres:16-alpine lacks `envsubst`** — the init Job uses `sed "s|\${APP_BASE_URL}|$APP_BASE_URL|g"` instead
- **Service startup ordering** — auth-service must connect to both Keycloak and NATS; if Keycloak is slow (realm import), auth-service may exhaust its 30 retries. Backend services that connect via auth callout will fail until auth-service is ready. Restart auth-service after Keycloak becomes healthy if needed
- **Keycloak behind reverse proxy** — `KC_PROXY_HEADERS: xforwarded` (base) tells Keycloak to trust `X-Forwarded-*` headers. `KC_HOSTNAME_URL` (local overlay) sets the public URL used in token `iss` claims and OIDC discovery. The auth-service `KEYCLOAK_ISSUER_URL` must match the `iss` claim exactly or JWT validation fails. JWKS is fetched via internal `http://keycloak:8080` (unaffected by `KC_HOSTNAME_URL`)
- **postgres-init Job is idempotent for app URLs** — app registry `INSERT` statements use `ON CONFLICT (id) DO UPDATE SET component_url = EXCLUDED.component_url`, so re-running the init Job after changing `APP_BASE_URL` updates existing rows. Delete the old Job before re-applying: `kubectl -n nats-chat delete job postgres-init`

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
- **Sticker service split** — sticker-service is a pure NATS metadata service (like user-search-service), while sticker-images is a separate nginx container serving static SVGs. This clean separation means the Go service scales via NATS queue groups without carrying static file overhead, and nginx handles caching/sendfile efficiently. Sticker data (products, stickers) lives in PostgreSQL; image URLs are constructed from `STICKER_BASE_URL`. Messages with stickers set `stickerUrl` in the payload (persisted via `sticker_url` column in messages table).
- **Async translation via Ollama** — translation-service subscribes to `translate.request` via queue group, uses the Ollama Go SDK with streaming callbacks to publish translation chunks at 100ms intervals to `deliver.{user}.translate.response`. Browser fire-and-forgets a publish to `translate.request` (including `user` and `msgKey`), then receives streaming chunks asynchronously via the existing deliver subscription — no timeout constraint, so LLM inference can take as long as needed. MessageProvider accumulates chunks into `translationResults` state; ChatRoom tracks `translatingKeys` locally and clears them when `done: true` arrives. `OLLAMA_URL` defaults to `host.docker.internal:11434` in Docker (host GPU access).
- **Translation service availability detection** — translation-service tracks health via `atomic.Bool` (probed at startup, updated on each translation success/failure, re-probed every 30s in a background goroutine). Responds to `translate.ping` (no queue group — avoids blocking behind busy translate workers) with `{"available": true/false}`. Browser pings once on NATS connect; if unavailable, polls every 60s for recovery (using a ref to avoid React useEffect dependency loops). ChatRoom conditionally renders the Translate button via `translationAvailable`; a 15s timeout on pending translations with no streaming response triggers `markTranslationUnavailable()`, which activates recovery polling. Covers three failure modes: no service instances (NATS "no responders"), Ollama down (responds `available: false`), and mid-stream stalls.
- **DB-backed service account auth via auth callout** — service account credentials (username/password) are stored in PostgreSQL `service_accounts` table instead of being hardcoded in `nats-server.conf`. The auth-service loads all accounts into an in-memory cache on startup and refreshes every 5 minutes. When a connection arrives at auth callout, the handler checks `ConnectOptions`: if `Token` is present → browser auth (Keycloak JWT validation); if `Username`+`Password` are present → service auth (cache lookup). Services get broad `>` pub/sub permissions in the CHAT account with 24h JWT expiry. This eliminates the need to restart NATS when adding new room app services — just `INSERT INTO service_accounts` and wait up to 5 minutes for cache refresh.
- **Polyglot room apps** — room apps demonstrate language diversity: poll-app uses vanilla JS Web Component with Go backend, whiteboard uses React + Vite with Node.js/TypeScript backend, and KB uses Angular 19 with Java/Spring Boot backend. All communicate through the same AppBridge SDK and `app.{appId}.{room}.{action}` NATS subject convention, proving the architecture is language-agnostic.
- **Zoneless Angular for Web Components** — the KB app uses Angular 19's `provideExperimentalZonelessChangeDetection()` instead of zone.js. Loading zone.js inside a host app that already has its own event loop causes `Cannot read properties of undefined (reading 'type')` errors from zone.js patching `alert`/`prompt`/`confirm`. Zoneless mode eliminates this entirely but requires explicit `ChangeDetectorRef.markForCheck()` after every async state change (bridge requests, setTimeout callbacks, subscription callbacks).
- **Room apps as Web Components** — collaborative micro-frontend apps run inside chat room tabs as Web Components loaded dynamically from a registry. Apps are sandboxed in Shadow DOM with CSP `connect-src` restriction — they never touch the network directly. An injected `AppBridge` SDK scopes all communication to `app.{appId}.{room}.*` subjects, proxying through the host's single NATS WebSocket connection. Subject structure embeds room for server-side routing without payload parsing. Two-tier permission model: room-level access enforced by the bridge (app installed + user is member), per-user permissions enforced by the app service. Fanout-service extended to subscribe `app.>` and deliver to room members (skips request/reply via `msg.Reply` check). MessageProvider routes `deliver.{user}.app.{appId}.{room}.{event}` to registered AppBridge callbacks. Tab bar appears when apps are installed; only one app active at a time; switching unmounts previous app and cleans up its bridge. DM rooms skip app registry fetch.
- **Single-port nginx reverse proxy for K8s local** — the web nginx container doubles as a reverse proxy, routing all browser traffic through `localhost:30000` via path-based `location` blocks in `web/nginx.conf`. This consolidates 8 NodePort services into 1, reducing port exposure and simplifying access. Keycloak gets `X-Forwarded-*` headers and large buffers for OIDC, NATS WebSocket gets `Upgrade`/`Connection` headers with 3600s timeouts, Grafana serves from `/grafana/` sub-path. The proxy locations only resolve in K8s (internal DNS names like `keycloak:8080`); Docker Compose and `npm run dev` continue using direct ports.
- **Kustomize base/overlay for K8s** — Kustomize (no Helm) provides the right complexity level for this project. Base holds environment-neutral manifests with internal K8s DNS names (e.g. `nats:4222`). Overlays patch only what differs between environments — primarily external URLs that browsers need to reach. Internal service-to-service communication uses K8s DNS unchanged across overlays.
- **No K8s Services for NATS-only backends** — Go backend services communicate exclusively via NATS pub/sub (they're subscribers, not HTTP servers), so they don't need a `Service` resource. Only infrastructure (NATS, Postgres, Keycloak) and nginx-based static servers that the browser fetches from need Services.
- **Web runtime config via env.js ConfigMap** — production web builds use nginx serving static assets. A `window.__env__` object loaded from a ConfigMap-mounted `env.js` file provides runtime environment variables, replacing Vite's build-time `import.meta.env`. Providers use a `window.__env__ || import.meta.env` fallback chain, keeping backward compatibility with `docker compose` and `npm run dev`.
- **postgres-init Job with sed** — room app `component_url` values in init.sql contain `${APP_BASE_URL}` placeholders. A Kubernetes Job runs `sed` to substitute these before piping to `psql`, allowing overlays to set the correct base URL for each environment without maintaining separate SQL files. Uses `sed` instead of `envsubst` because `postgres:16-alpine` doesn't include the `gettext` package.
- **NatsProvider connection guard** — when the NATS WebSocket connection is replaced (token refresh, reconnect), the old connection's `closed()` callback and status monitor check `ncRef.current === conn` before updating state. Without this guard, the old connection's async close handler overwrites the new connection's `connected`/`nc` state, leaving the UI disabled while messages still flow through the subscription loop.
