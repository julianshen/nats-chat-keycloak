# CLAUDE.md

Real-time chat app: Keycloak OIDC → NATS Auth Callout → role-based pub/sub over WebSocket. PostgreSQL persistence via JetStream. Full OpenTelemetry instrumentation.

## Build & Run

```bash
docker compose up -d --build          # All 21 services
docker compose up keycloak nats postgres -d  # Infrastructure only
cd web && npm run dev                  # React dev server (port 3000)
cd auth-service && go run .            # Any Go service: cd <service> && go run .
cd apps/kb/service && mvn package -DskipTests  # Java KB service
cd apps/kb/app && npm install && npx ng build --configuration=production && node build.mjs  # Angular KB app

# Kubernetes (local)
./k8s/build-local.sh                   # Build images + deploy to OrbStack/K3S
kubectl apply -k k8s/overlays/local    # Manual apply (web at http://localhost:30000)
kubectl -n nats-chat get pods          # 26 pods + 1 completed init Job
```

No test suites or linters are configured.

## Architecture

```
Browser (React + nats.ws)
  → OIDC login via Keycloak → access_token
  → WebSocket CONNECT to NATS (token = access_token)
  → Subscribes: deliver.{user}.> + room.msg.{room} + room.presence.{room} per room

NATS Server 2.12 (auth_callout + JetStream)
  → Auth forwarded to $SYS.REQ.USER.AUTH
  → Messages to chat.{room} / chat.{room}.thread.{threadId} → JetStream CHAT_MESSAGES

All Go/Java backend services are pure NATS subscribers (no HTTP). OTel instrumented via OTLP/gRPC.
OTel Collector → Tempo (traces) + Prometheus (metrics) + Loki (logs) → Grafana
```

### Services

| Service | Path | Purpose |
|---------|------|---------|
| Auth | `auth-service/` | Dual auth callout: JWT (browser) + user/pass (services). DB-backed service accounts cached, refreshed every 5m |
| Fanout | `fanout-service/` | Hybrid delivery: `room.msg.{room}` multicast for main msgs, per-user `deliver.{userId}.*` for threads (32-goroutine pool, LRU cache) |
| Room | `room-service/` | Sharded per-key KV membership (`{room}.{userId}` → `{}`). Private rooms via PostgreSQL. Delta events `room.changed.*` |
| Presence | `presence-service/` | Two KV buckets: PRESENCE (status) + PRESENCE_CONN (45s TTL heartbeats). Publishes diffs to `room.presence.{room}` |
| Persist Worker | `persist-worker/` | JetStream consumer → PostgreSQL writer |
| History | `history-service/` | Request/reply on `chat.history.*` — last 50 msgs with reply counts |
| User Search | `user-search-service/` | Queries Keycloak Admin API via `users.search` request/reply |
| Translation | `translation-service/` | Ollama streaming via `translate.request` → `deliver.{user}.translate.response`. Requires `translategemma` model |
| Sticker | `sticker-service/` | NATS metadata service. Static SVGs served by `sticker-images/` (nginx:8090) |
| App Registry | `app-registry-service/` | Room app registry + per-room installations via `apps.*` |
| Poll | `poll-service/` | Poll app backend via `app.poll.{room}.*`. Web Component at `poll-app/` (nginx:8091) |
| KB | `apps/kb/service/` | Java/Spring Boot KB backend via `app.kb.{room}.*`. Angular 19 Web Component at `apps/kb/app/` (nginx:8093) |
| OTel Helper | `pkg/otelhelper/` | Shared Go module: OTel init + NATS trace propagation (W3C headers). Used via `replace` in go.mod |

### Ports

| Service | Port | Notes |
|---------|------|-------|
| Keycloak | 8080 | Admin: admin/admin |
| NATS | 4222/9222/8222 | TCP / WebSocket / Monitoring |
| PostgreSQL | 5432 | DB: chat/chat-secret |
| Web | 3000 | React frontend |
| Grafana | 3001 | Dashboards |
| Sticker Images | 8090 | Static SVGs (nginx) |
| Poll App | 8091 | Web Component (nginx) |
| KB App | 8093 | Web Component (nginx) |

### Test Users (Keycloak realm: nats-chat)

- alice/alice123 — admin + user roles
- bob/bob123 — user role
- charlie/charlie123 — no roles (read-only)

## Web Frontend (`web/`)

React 18 + TypeScript + Vite. Inline styles (dark theme, no CSS framework).

**Providers (nested):** AuthProvider → NatsProvider → MessageProvider
**Components:** `App → ChatApp → NatsProvider → MessageProvider → ChatContent → [Header, RoomSelector, ChatRoom → [MessageList, MessageInput, ThreadPanel?]]`

Hybrid subscriptions: `deliver.{user}.>` (threads, admin, translations, apps) + `room.msg.{room}` + `room.presence.{room}` per joined room. Runtime config via `window.__env__` (K8s env.js ConfigMap) with `import.meta.env` fallback (Vite dev).

## Code Conventions

- **Go services**: single-file (`main.go`), queue groups for horizontal scaling, `pkg/otelhelper` for tracing
- **NATS subjects**: `chat.{room}` for messages, `app.{appId}.{room}.{action}` for room apps, `deliver.{user}.*` for per-user delivery
- **Room apps**: Web Components via AppBridge SDK (`web/src/lib/AppBridge.ts`), no direct network access
- **All services** retry NATS + Keycloak connections: 30 attempts, 2s wait
- **Environment vars**: Go services use `NATS_URL`, `DATABASE_URL`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`. Web uses `VITE_` prefix

## Key Design Patterns

- **Sharded KV membership**: ROOMS bucket keys = `{room}.{userId}` → O(1) join/leave, no read-modify-write conflicts
- **Delta events**: `room.changed.{room}` carries `{action, userId}` (~50 bytes). Downstream services build local state from stream
- **Hybrid delivery**: main room msgs → NATS multicast (`room.msg.{room}`); thread msgs → per-user (`deliver.{userId}.*`)
- **Unified room model**: public/private/dm all use same Room entity with `type` field. DMs = `dm-` + sorted usernames
- **DB-backed service accounts**: `INSERT INTO service_accounts` → cache refreshes in ≤5m → no NATS restart needed
- **Browser-to-backend tracing**: web generates W3C `traceparent` headers (`web/src/utils/tracing.ts`), Go services extract via `otelhelper.StartConsumerSpan`

## Gotchas

- **slog deadlock**: Never wrap `slog.Default().Handler()` — it deadlocks via `log.Logger` mutex. Use `slog.NewTextHandler(os.Stderr, nil)` as inner handler in `pkg/otelhelper/otel.go`
- **NKeys/XKeys are demo-only**: hardcoded in docker-compose.yml and nats-server.conf
- **Keycloak behind proxy (K8s)**: `KC_HOSTNAME` must include context path (`http://localhost:30000/auth`). Auth-service `KEYCLOAK_ISSUER_URL` must match `iss` claim exactly or JWT validation fails
- **NATS health probes**: `http_port: 8222` required in nats-server.conf or liveness probes fail → CrashLoopBackOff
- **K8s imagePullPolicy**: must be `IfNotPresent` for local images (default `Always` fails without registry)
- **Startup ordering**: auth-service needs both Keycloak + NATS. If Keycloak is slow (realm import), restart auth-service after it's healthy
- **Zoneless Angular**: KB app uses `provideExperimentalZonelessChangeDetection()` — requires explicit `ChangeDetectorRef.markForCheck()` after async ops
- **NatsProvider connection guard**: old connection's `closed()` callback must check `ncRef.current === conn` before updating state to avoid overwriting new connection
- **Tempo pinned to v2.7.2**: v3 has incompatible single-binary config
- **postgres-init Job**: uses `sed` not `envsubst` (alpine lacks gettext). Delete old Job before re-applying: `kubectl -n nats-chat delete job postgres-init`

## Kubernetes (`k8s/`)

Kustomize base + overlays (local/cloud). Docker Compose is the primary local dev workflow. K8s local: single NodePort (30000) with nginx reverse proxy routing `/auth/`, `/nats-ws`, `/sticker-images/`, `/apps/*`, `/grafana/` to internal services. Go backends have no K8s Service (pure NATS subscribers).
