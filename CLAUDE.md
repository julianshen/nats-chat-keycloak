# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A demonstration of NATS Auth Callout integration with Keycloak OIDC. The system authenticates users via Keycloak, then a Go auth service validates tokens and maps Keycloak realm roles to NATS pub/sub permissions, enabling role-based real-time chat over WebSocket.

## Build & Run Commands

```bash
# Start all services (Keycloak, NATS, auth-service, web)
docker compose up -d --build

# Run individual services for development
docker compose up keycloak nats -d
cd auth-service && go run .
cd web && npm install && npm run dev

# Web app commands
cd web && npm run dev      # Dev server on port 3000
cd web && npm run build    # TypeScript compile + Vite production build

# Auth service
cd auth-service && go build -o auth-service .
```

No test suites or linters are configured.

## Architecture

```
Browser (React + nats.ws)
  │  1. OIDC login → Keycloak → access_token
  │  2. WebSocket CONNECT to NATS (token = access_token)
  ▼
NATS Server (auth_callout enabled)
  │  3. Forwards auth to $SYS.REQ.USER.AUTH
  ▼
Auth Service (Go)
     • Decrypts XKey-encrypted auth request
     • Validates Keycloak JWT via JWKS endpoint
     • Maps realm roles → NATS permissions
     • Returns signed NATS user JWT (encrypted)
```

### Service Ports

| Service | Port | Purpose |
|---------|------|---------|
| Keycloak | 8080 | OIDC provider (admin: admin/admin) |
| NATS | 4222/9222/8222 | TCP / WebSocket / Monitoring |
| Web | 3000 | React frontend |

### Auth Service (`auth-service/`)

Four Go files, each with a single responsibility:
- **main.go** — Initialization, NATS connection with retry, subscription to `$SYS.REQ.USER.AUTH`
- **handler.go** — Core auth callout: decrypt request → validate JWT → build NATS user JWT → encrypt response
- **keycloak.go** — JWKS key fetching/caching via `keyfunc` library, with retry on startup
- **permissions.go** — Role-to-permission mapping (admin → `chat.>` + `admin.>`, user → `chat.>`, no role → subscribe-only)

Auth callout uses NKeys for JWT signing and XKey (Curve25519) for payload encryption between NATS server and auth service.

### Web Frontend (`web/`)

React 18 + TypeScript + Vite. No CSS framework — all styles are inline TypeScript objects with a dark theme.

**State management via two Context providers (no Redux):**
- **AuthProvider** — Wraps entire app. Manages Keycloak lifecycle, token refresh (30s interval), exposes `authenticated`, `token`, `userInfo`
- **NatsProvider** — Nested inside ChatApp (requires auth). Manages WebSocket NATS connection using the Keycloak access token

**Component tree:** `App → ChatApp → [Header, RoomSelector, ChatRoom → [MessageList, MessageInput]]`

Room names map to NATS subjects: room "general" → subject `chat.general`, admin rooms → `admin.chat`.

### NATS Configuration (`nats/nats-server.conf`)

Three accounts: AUTH (service credentials), CHAT (application users), SYS (system). Auth callout is configured with a static issuer NKey and XKey. WebSocket on port 9222 (no TLS).

### Keycloak Configuration (`keycloak/realm-export.json`)

Realm "nats-chat" with client "nats-chat-app" (public SPA, PKCE). Pre-configured test users:
- alice/alice123 (admin + user roles)
- bob/bob123 (user role)
- charlie/charlie123 (no roles, read-only)

## Key Design Decisions

- **All NKeys/XKeys in config are demo-only** — hardcoded in docker-compose.yml and nats-server.conf for ease of setup
- **Stateless architecture** — no database; auth state lives in Keycloak, messages are ephemeral in NATS
- **Auth service retries** — 30 attempts with 2s wait for both NATS and Keycloak connections (handles Docker Compose startup ordering)
- **Token as NATS credential** — browser passes Keycloak access_token directly as NATS connection token; auth callout validates it server-side
- **Environment variables** — web app uses `VITE_` prefix (Vite convention) for Keycloak/NATS URLs; auth-service reads `NATS_URL`, `KEYCLOAK_URL`, `ISSUER_NKEY_SEED`, `XKEY_SEED`
