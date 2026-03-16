# User Login Flow

Complete authentication flow from browser login to NATS connection with role-based permissions.

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│  Browser  │────>│ Keycloak │────>│   NATS   │────>│  Auth    │────>│  NATS    │
│  (React)  │<────│  (OIDC)  │<────│  Server  │<────│ Service  │<────│  Server  │
└──────────┘     └──────────┘     └──────────┘     └──────────┘     └──────────┘
  1. Redirect      2. Login         3. CONNECT       4. Validate      5. Permit
  to login         + JWT            + JWT token       + sign JWT       connection
```

---

## Stage 1: OIDC Login via Keycloak

**File:** `web/src/providers/AuthProvider.tsx`

The browser initializes Keycloak with PKCE and redirects to the login page.

```typescript
// AuthProvider.tsx:42-54
const keycloak = new Keycloak({
  url: KEYCLOAK_URL,         // http://localhost:8080
  realm: KEYCLOAK_REALM,     // nats-chat
  clientId: KEYCLOAK_CLIENT_ID, // nats-chat-app
});

keycloak.init({
  onLoad: 'login-required',   // redirect immediately if not logged in
  checkLoginIframe: false,
  ...(window.crypto?.subtle ? { pkceMethod: 'S256' as const } : {}),
});
```

After login, the token is parsed for user info:

```typescript
// AuthProvider.tsx:61-71
const parsed = keycloak.tokenParsed;
const roles = parsed.realm_access?.roles || [];
setUserInfo({
  username: parsed.preferred_username || 'unknown',
  email: parsed.email || '',
  roles: roles.filter(r =>
    r !== 'default-roles-nats-chat' &&
    r !== 'offline_access' &&
    r !== 'uma_authorization'
  ),
});
```

Token refresh runs every 30 seconds:

```typescript
// AuthProvider.tsx:74-84
setInterval(() => {
  keycloak.updateToken(30)
    .then(refreshed => { if (refreshed) setToken(keycloak.token); })
    .catch(() => keycloak.logout());
}, 30000);
```

**Keycloak realm config:** `infra/keycloak/realm-export.json`
- Client: `nats-chat-app` (public, no secret, PKCE)
- Access token lifespan: 300s (5 minutes)
- SSO session idle: 1800s (30 minutes)
- Roles: `admin`, `user` (default for new users)
- Test users: alice/alice123 (admin+user), bob/bob123 (user), charlie/charlie123 (no roles)

**Output:** JWT access token containing `preferred_username`, `realm_access.roles`, `exp`, `iss`

---

## Stage 2: Connect to NATS WebSocket

**File:** `web/src/providers/NatsProvider.tsx`

When `authenticated && token` are set, the browser connects to NATS via WebSocket:

```typescript
// NatsProvider.tsx:51-57
const conn = await connect({
  servers: NATS_WS_URL,           // ws://localhost:9222
  token: authToken,                // Keycloak JWT
  name: userInfo?.username,        // e.g. "alice"
  maxReconnectAttempts: -1,        // infinite reconnects
  reconnectTimeWait: 2000,         // 2s between retries
});
```

Connection status is monitored with a guard against stale connections:

```typescript
// NatsProvider.tsx:66-82
for await (const s of conn.status()) {
  if (ncRef.current !== conn) break;  // connection was replaced
  switch (s.type) {
    case 'disconnect': setConnected(false); break;
    case 'reconnect':  setConnected(true);  break;
    case 'error':      setError(s.data);    break;
  }
}
```

**Output:** NATS CONNECT frame sent to server with `token` field containing Keycloak JWT

---

## Stage 3: NATS Auth Callout

**File:** `infra/nats/nats-server.conf`

NATS server intercepts the CONNECT and forwards it to the auth service:

```
# nats-server.conf:24-31
authorization {
  auth_callout {
    issuer: ABJHLOVMPA4CI6R5KLNGOB4GSLNIY7IOUPAJC4YFNDLQVIOBYQGUWVLA
    auth_users: [ auth ]
    account: AUTH
    xkey: XAB3NANV3M6N7AHSQP2U5FRWKKUT7EG2ZXXABV4XVXYQRJGM4S2CZGHT
  }
}
```

The server publishes an encrypted `AuthorizationRequest` to `$SYS.REQ.USER.AUTH` containing:
- Server XKey (ephemeral, for response encryption)
- Client info (name, host)
- Connect options (token or username/password)
- User NKey (ephemeral, for signing the response JWT)

---

## Stage 4: Auth Service Queue Group

**File:** `services/auth/main.go`

All auth-service instances subscribe to the auth callout subject using a queue group.
NATS load-balances `$SYS.REQ.USER.AUTH` requests across available auth-service pods:

```go
// main.go
sub, err := nc.QueueSubscribe("$SYS.REQ.USER.AUTH", "auth-workers", func(msg *nats.Msg) {
    ok, _ := pool.Submit(msg)
    if !ok {
        handler.RespondAuthError(msg, "auth service overloaded")
    }
})
if err != nil {
    slog.Error("Failed to subscribe to auth callout subject", "error", err)
    os.Exit(1)
}
```

This enables horizontal scaling: adding auth-service replicas increases auth callout
throughput while preserving one responder per request.

Each auth-service instance also uses a bounded local worker pool to process callouts:
- Queue size and worker count are configurable (`AUTH_QUEUE_SIZE`, `AUTH_WORKER_COUNT`)
- Requests are rejected when the queue is full and receive explicit auth error responses (`auth_rejections_total{reason="queue_full"}`)
- Slow or timed-out requests are tracked (`auth_timeouts_total`), and timed-out requests receive explicit auth error responses

---

## Stage 5: JWT Validation

**File:** `services/auth/handler.go`, `services/auth/keycloak.go`

The handler decrypts the request and determines the auth type:

```go
// handler.go:72-97
serverXKey := msg.Header.Get("Nats-Server-Xkey")
requestData, _ := h.decryptRequest(msg.Data, serverXKey)
reqClaims, _ := jwt.DecodeAuthorizationRequestClaims(string(requestData))

userNKey := reqClaims.UserNkey
connectOpts := reqClaims.ConnectOptions
```

**Browser auth (token present):**

```go
// handler.go:111-129
if connectOpts.Token != "" {
    claims, err := h.validator.ValidateToken(connectOpts.Token)
    // ValidateToken checks: signature (JWKS), issuer, expiration
    username = claims.PreferredUsername
    perms = mapPermissions(claims.RealmRoles, username)
    expiry = min(claims.ExpiresAt, now + 1 hour)
}
```

Token validation in `keycloak.go`:

```go
// keycloak.go:94-121
token, err := jwt.ParseWithClaims(tokenString, claims, v.jwks.Keyfunc,
    jwt.WithIssuer(v.issuerURL),       // must match exactly
    jwt.WithExpirationRequired(),       // exp claim required
)
```

**Service auth (username/password):**

```go
// handler.go:131-144
if connectOpts.Username != "" && connectOpts.Password != "" {
    if !h.serviceAccounts.Authenticate(connectOpts.Username, connectOpts.Password) {
        return  // rejected, no response
    }
    username = connectOpts.Username
    perms = servicePermissions()  // wildcard publish/subscribe
    expiry = now + 24 hours
}
```

Service accounts are cached from PostgreSQL, refreshed every 5 minutes:

```go
// service_accounts.go:73-78
func (c *ServiceAccountCache) Authenticate(username, password string) bool {
    c.mu.RLock()
    cached, ok := c.accounts[username]
    c.mu.RUnlock()
    return ok && cached == password
}
```

---

## Stage 6: Permission Mapping

**File:** `services/auth/permissions.go`

Keycloak roles are converted to NATS publish/subscribe permissions:

```go
// permissions.go:36-182
func mapPermissions(roles []string, username string) jwt.Permissions {
    deliverSubject := fmt.Sprintf("deliver.%s.>", username)
    sendSubject := fmt.Sprintf("deliver.%s.send.>", username)

    if roleSet["admin"] {
        // Full access: sendSubject, admin.>, room.create, apps.install.*, ...
    } else if roleSet["user"] {
        // Standard access: sendSubject, room.create, ... (no admin.>)
    } else {
        // Read-only: chat.history.>, msg.get, room.join.* (no sendSubject)
    }
}
```

| Role | Publish | Subscribe | Key Differences |
|------|---------|-----------|-----------------|
| **admin** | `deliver.{user}.send.>`, `admin.>`, `room.create`, `apps.install.*`, E2EE full | `deliver.{user}.>`, `room.notify.*`, `room.presence.*`, E2EE sub | Has `admin.>` |
| **user** | `deliver.{user}.send.>`, `room.create`, `apps.install.*`, E2EE full | Same as admin | No `admin.>` |
| **none** | `chat.history.>`, `msg.get`, `room.join.*`, `presence.update`, E2EE read-only | `deliver.{user}.>`, `room.notify.*`, `room.presence.*` | No `sendSubject`, no `room.create`, no app install |

---

## Stage 7: Response JWT & Connection

**File:** `services/auth/handler.go`

The auth service builds a NATS user JWT and sends it back:

```go
// handler.go:158-201
userClaims := jwt.NewUserClaims(userNKey)
userClaims.Name = username
userClaims.Audience = "CHAT"           // account
userClaims.BearerToken = true
userClaims.Permissions = perms
userClaims.Expires = expiry

userJWT, _ := userClaims.Encode(h.issuerKP)  // sign with issuer NKey

response := jwt.NewAuthorizationResponseClaims(userNKey)
response.Audience = serverID
response.Jwt = userJWT
responseJWT, _ := response.Encode(h.issuerKP)

// Encrypt with server's ephemeral XKey
encrypted, _ := h.xkeyKP.Seal([]byte(responseJWT), serverXKey)
msg.Respond(encrypted)
```

NATS server receives the response, verifies the issuer signature, and permits the connection with the embedded permissions.

---

## Stage 8: Post-Auth Initialization

**Files:** `web/src/App.tsx`, `web/src/providers/MessageProvider.tsx`, `web/src/providers/E2EEProvider.tsx`

Once connected, the browser sets up subscriptions and initializes E2EE:

```
AuthProvider ─── token ──> NatsProvider ─── nc ──> E2EEProvider ─── ready ──> MessageProvider
                                                       │                          │
                                                  Publish identity           Subscribe to:
                                                  key to KV                  - deliver.{user}.>
                                                                             - room.notify.{room}
                                                                             - room.presence.{room}
```

**Room joining (App.tsx:78-82):**
1. Join default rooms (`general`, etc.)
2. Fetch private rooms via `room.list` request/reply
3. Discover DM rooms via `chat.dms` request/reply
4. For each room: subscribe to `room.notify.{room}` + `room.presence.{room}`

**E2EE initialization (E2EEProvider.tsx:84-120):**
1. Generate/load ECDH P-256 identity keypair (IndexedDB)
2. Publish public key to `e2ee.identity.publish`
3. For E2EE-enabled rooms: fetch wrapped room keys

---

## Sequence Diagram

```
Browser              Keycloak             NATS Server           Auth Service
   │                    │                     │                      │
   │── GET /login ─────>│                     │                      │
   │<── Login page ─────│                     │                      │
   │── POST creds ─────>│                     │                      │
   │<── JWT (code) ─────│                     │                      │
   │── Exchange code ──>│                     │                      │
   │<── Access token ───│                     │                      │
   │                    │                     │                      │
   │── WS CONNECT (token) ──────────────────>│                      │
   │                    │                     │── $SYS.REQ.USER.AUTH │
   │                    │                     │   (encrypted req) ──>│
   │                    │                     │                      │── Decrypt
   │                    │                     │                      │── Validate JWT
   │                    │                     │                      │   (JWKS sig + iss + exp)
   │                    │                     │                      │── Map roles → perms
   │                    │                     │                      │── Sign user JWT
   │                    │                     │<── (encrypted resp) ─│
   │                    │                     │── Verify issuer sig  │
   │<── Connected ──────────────────────────>│                      │
   │                    │                     │                      │
   │── SUB deliver.alice.> ────────────────>│                      │
   │── SUB room.notify.general ────────────>│                      │
   │── PUB room.join.general ──────────────>│                      │
   │── PUB e2ee.identity.publish ──────────>│                      │
   │                    │                     │                      │
```

---

## Error Scenarios

| Stage | Error | Behavior |
|-------|-------|----------|
| Keycloak init | Network error | Shows error with retry button |
| Token refresh | Refresh fails | Calls `logout()`, redirects to login |
| NATS connect | Connection refused | Retries every 2s, infinite attempts |
| Auth callout | Token invalid (sig/iss/exp) | No response sent → NATS rejects connection |
| Auth callout | Service password wrong | No response sent → NATS rejects connection |
| Auth callout | JWT encode fails | Logged, no response → NATS rejects connection |
| NATS disconnect | Network drop | Auto-reconnects, re-subscribes to rooms |
| E2EE init | Identity publish fails | E2EE disabled, messages sent as plaintext |

---

## Key Files Reference

| File | Purpose |
|------|---------|
| `web/src/providers/AuthProvider.tsx` | Keycloak OIDC init, token management |
| `web/src/providers/NatsProvider.tsx` | WebSocket connection to NATS with JWT |
| `web/src/providers/E2EEProvider.tsx` | Identity key + room key initialization |
| `web/src/providers/MessageProvider.tsx` | Room subscriptions + message handling |
| `web/src/App.tsx` | Room joining orchestration |
| `infra/nats/nats-server.conf` | Auth callout config |
| `infra/keycloak/realm-export.json` | OIDC realm, roles, client config |
| `services/auth/main.go` | Service init, queue-group subscription |
| `services/auth/handler.go` | Auth callout handler (decrypt → validate → sign → respond) |
| `services/auth/keycloak.go` | JWKS fetching + JWT validation |
| `services/auth/permissions.go` | Role → NATS permission mapping |
| `services/auth/service_accounts.go` | DB-backed service credential cache |
