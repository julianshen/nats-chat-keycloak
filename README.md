# NATS Chat with Auth Callout + Keycloak

A real-time chat application demonstrating **NATS Auth Callout** integrated with **Keycloak** (OIDC) for authentication, **nats.ws** for browser-based messaging, message persistence via **JetStream + PostgreSQL**, and full distributed tracing with **OpenTelemetry**.

## Architecture

```
Browser (React + nats.ws)
    │
    ├── 1. OIDC login via Keycloak → receives access_token
    │
    └── 2. WebSocket CONNECT to NATS (token = access_token)
                │
          NATS Server (auth_callout enabled)
                │
                ├── 3. Delegates auth to Go service ($SYS.REQ.USER.AUTH)
                │       ├── Validates Keycloak JWT via JWKS
                │       ├── Maps roles → NATS permissions
                │       └── Returns signed user JWT → client connected
                │
                ├── 4. Messages published to chat.{room} subjects
                │       └── JetStream persists to CHAT_MESSAGES stream
                │
                ├── 5. Persist Worker consumes from JetStream → PostgreSQL
                │
                └── 6. History Service serves message history (request/reply)
                        └── chat.history.{room} → query PostgreSQL

          OTel Collector → Tempo (traces) / Prometheus (metrics) / Loki (logs)
                              └── Grafana (visualization)
```

## Components

| Service | Technology | Port | Purpose |
|---------|-----------|------|---------|
| **Keycloak** | Keycloak 26 | 8080 | Identity provider (OIDC) |
| **NATS Server** | NATS 2.12 | 4222 (TCP), 9222 (WS), 8222 (monitoring) | Message broker with JetStream |
| **Auth Service** | Go | — | Auth callout handler |
| **Persist Worker** | Go | — | JetStream consumer → PostgreSQL writer |
| **History Service** | Go | — | Message history via NATS request/reply |
| **PostgreSQL** | PostgreSQL 16 | 5432 | Message persistence |
| **Web App** | React + Vite | 3000 | Chat UI |
| **OTel Collector** | OTel Collector Contrib | 4317 (gRPC) | Telemetry routing |
| **Tempo** | Grafana Tempo 2.7.2 | — | Distributed trace storage |
| **Prometheus** | Prometheus | 9090 | Metrics storage |
| **Loki** | Grafana Loki | — | Log aggregation |
| **Grafana** | Grafana | 3001 | Observability dashboards |

## Quick Start

```bash
# Start all services
docker compose up -d --build

# Wait ~30s for Keycloak to initialize, then open:
# http://localhost:3000
```

## Test Users

| User | Password | Role | Permissions |
|------|----------|------|-------------|
| `alice` | `alice123` | admin | pub/sub on `chat.>` and `admin.>` |
| `bob` | `bob123` | user | pub/sub on `chat.>` only |
| `charlie` | `charlie123` | (none) | subscribe `chat.>`, no publish |

## How It Works

1. **User opens the app** → Keycloak login page
2. **User logs in** → Keycloak issues an OIDC access token (JWT)
3. **App connects to NATS** via WebSocket, passing the Keycloak token
4. **NATS delegates auth** to the Go callout service via `$SYS.REQ.USER.AUTH`
5. **Callout service validates** the Keycloak JWT against the JWKS endpoint
6. **Callout service maps** Keycloak roles → NATS pub/sub permissions
7. **Callout service returns** a signed NATS user JWT
8. **NATS applies permissions** and the client is connected to the `CHAT` account
9. **Users chat** by publishing/subscribing to `chat.{room}` subjects
10. **Messages are persisted** — JetStream streams messages to the persist worker, which writes them to PostgreSQL
11. **History is loaded** — when a user enters a room, the app requests history via `chat.history.{room}` (NATS request/reply)

## Observability

All Go services are instrumented with OpenTelemetry, exporting traces, metrics, and structured logs via OTLP/gRPC to the OTel Collector.

### Dashboards

Open **Grafana** at http://localhost:3001 (anonymous access enabled).

A pre-provisioned **NATS Chat - Distributed Tracing** dashboard includes:
- Service overview stats (messages persisted, history requests, auth requests)
- Request rates and error rates
- Latency percentiles (p50/p95/p99) for auth and history services
- Auth result breakdown (authorized/rejected/error)
- Tempo trace search with service filter
- Loki log viewer

### Metrics

| Metric | Service | Description |
|--------|---------|-------------|
| `messages_persisted_total` | persist-worker | Messages written to PostgreSQL |
| `messages_persist_errors_total` | persist-worker | Persistence failures |
| `history_requests_total` | history-service | History queries served |
| `history_request_duration_seconds` | history-service | History query latency |
| `auth_requests_total` | auth-service | Auth callout requests (by result) |
| `auth_request_duration_seconds` | auth-service | Auth callout latency |

### Trace Propagation

W3C Trace Context is propagated through NATS message headers, linking producer and consumer spans across services. The `otelsql` library provides automatic tracing of PostgreSQL queries.

## Key Configuration

### NATS Server (`nats/nats-server.conf`)

Three accounts: `AUTH` (callout service), `CHAT` (app users), `SYS` (system). Auth callout with XKey encryption enabled. JetStream enabled for message persistence.

### Keycloak

Realm `nats-chat` with client `nats-chat-app` (public SPA, PKCE). Roles: `admin`, `user`. Pre-configured users imported on startup.

### Auth Callout Service

- Connects to NATS as `auth` user (bypasses callout)
- Subscribes to `$SYS.REQ.USER.AUTH`
- Validates Keycloak tokens using cached JWKS
- Maps `admin` role → full permissions, `user` role → chat-only

## Development

```bash
# Run individual services for development:

# Infrastructure
docker compose up keycloak nats postgres -d

# Auth service (Go)
cd auth-service && go run .

# Persist worker (Go)
cd persist-worker && go run .

# History service (Go)
cd history-service && go run .

# Web app (React)
cd web && npm install && npm run dev
```

### Admin Consoles

- **Keycloak**: http://localhost:8080 — login with `admin` / `admin`
- **NATS Monitoring**: http://localhost:8222
- **Grafana**: http://localhost:3001
- **Prometheus**: http://localhost:9090

## NKeys Used

These are static demo keys. **Generate your own for production!**

```
# Account NKey (issuer)
nsc generate nkey --account

# XKey (encryption)
nsc generate nkey --curve
```

## Troubleshooting

**"Failed to initialize authentication"**: Keycloak may still be starting. Wait 30 seconds and refresh.

**NATS connection fails**: Check that the auth service is running and connected. Check docker compose logs: `docker compose logs auth-service`.

**Permission denied on publish**: The user's Keycloak role doesn't grant publish access to that subject. Check the role mapping in `auth-service/permissions.go`.

**No traces in Grafana**: Ensure the OTel Collector is running (`docker compose logs otel-collector`). Go services need the collector available to export telemetry.
