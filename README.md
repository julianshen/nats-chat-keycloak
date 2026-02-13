# NATS Chat with Auth Callout + Keycloak

A real-time chat application demonstrating **NATS Auth Callout** integrated with **Keycloak** (OIDC) for authentication and **nats.ws** for browser-based messaging.

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
                └── 3. Delegates auth to Go service ($SYS.REQ.USER.AUTH)
                        │
                        ├── 4. Validates Keycloak JWT via JWKS
                        ├── 5. Maps roles → NATS permissions
                        └── 6. Returns signed user JWT → client connected
```

## Components

| Service | Technology | Port | Purpose |
|---------|-----------|------|---------|
| **Keycloak** | Keycloak 26 | 8080 | Identity provider (OIDC) |
| **NATS Server** | NATS 2.10 | 4222 (TCP), 9222 (WS) | Message broker |
| **Auth Service** | Go | — | Auth callout handler |
| **Web App** | React + Vite | 3000 | Chat UI |

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

## Key Configuration

### NATS Server (`nats/nats-server.conf`)

Three accounts: `AUTH` (callout service), `CHAT` (app users), `SYS` (system). Auth callout with XKey encryption enabled.

### Keycloak

Realm `nats-chat` with client `nats-chat-app` (public SPA). Roles: `admin`, `user`. Pre-configured users imported on startup.

### Auth Callout Service

- Connects to NATS as `auth` user (bypasses callout)
- Subscribes to `$SYS.REQ.USER.AUTH`
- Validates Keycloak tokens using cached JWKS
- Maps `admin` role → full permissions, `user` role → chat-only

## Development

```bash
# Run individual services for development:

# Keycloak
docker compose up keycloak -d

# NATS
docker compose up nats -d

# Auth service (Go)
cd auth-service
go run .

# Web app (React)
cd web
npm install
npm run dev
```

### Keycloak Admin Console

http://localhost:8080 — login with `admin` / `admin`

### NATS Monitoring

http://localhost:8222 — NATS server monitoring endpoint

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
