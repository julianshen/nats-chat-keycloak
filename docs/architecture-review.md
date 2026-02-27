# Architecture Review — NATS Chat with Keycloak

**Date:** 2026-02-25
**Scope:** Full system review — 13 backend services, React frontend, NATS messaging, PostgreSQL persistence, Kubernetes deployment, observability stack
**Commit:** `b59591a` (post two-stream architecture merge)

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Service Inventory](#2-service-inventory)
3. [Message Delivery Architecture](#3-message-delivery-architecture)
4. [Security Model](#4-security-model)
5. [Data Storage](#5-data-storage)
6. [Frontend Architecture](#6-frontend-architecture)
7. [Scalability Analysis](#7-scalability-analysis)
8. [Failure Modes & Resilience](#8-failure-modes--resilience)
9. [Observability](#9-observability)
10. [Deployment Topology](#10-deployment-topology)
11. [Strengths](#11-strengths)
12. [Known Limitations & Risks](#12-known-limitations--risks)
13. [Recommendations](#13-recommendations)

---

## 1. System Overview

A real-time chat application built on **NATS 2.12** with **Keycloak OIDC** authentication. The system uses a **two-stream message delivery model**: lightweight notification IDs via `room.notify.*` and on-demand content fetch via `msg.get`. All backend services communicate exclusively through NATS pub/sub (no HTTP inter-service calls). Messages are persisted to PostgreSQL via JetStream. The entire system is instrumented with OpenTelemetry for distributed tracing, metrics, and logs.

### High-Level Data Flow

```
Browser (React + nats.ws)
  │  1. OIDC login → Keycloak → access_token
  │  2. WebSocket CONNECT to NATS (token = access_token)
  │  3. Publish to deliver.{userId}.send.{room} (ingest path)
  │  4. Subscribe to room.notify.{room} (notification IDs)
  │  5. Fetch content via msg.get request/reply (capability-based)
  ▼
NATS Server (auth_callout + JetStream)
  │  6. Auth callout → auth-service validates JWT → scoped permissions
  │  7. Fanout-service ingests → validates → publishes to chat.{room}
  │  8. JetStream CHAT_MESSAGES stream captures all messages
  │  9. Fanout-service caches content in MSG_CACHE KV, publishes notification
  ▼
13 Backend Services (Go + Java, all NATS-only — no HTTP inter-service)
```

---

## 2. Service Inventory

### Core Services

| Service | Language | Queue Group | Scaling | Purpose |
|---------|----------|------------|---------|---------|
| **auth-service** | Go | — (auth callout) | Single | JWT validation, role→permission mapping |
| **fanout-service** | Go | `fanout-workers`, `msg-get-workers` | Horizontal (QG) + 32-goroutine pool | Message ingest, notification publish, content cache |
| **room-service** | Go | `room-workers`, `room-members-workers` | Horizontal (QG) | Room membership (KV), private room management (DB) |
| **presence-service** | Go | `presence-workers` | Horizontal (QG) + CAS | User presence, heartbeat tracking, presence diffs |
| **persist-worker** | Go | JetStream durable consumer | Single consumer | JetStream → PostgreSQL persistence |
| **history-service** | Go | — (request/reply) | Single | Message history queries from PostgreSQL |

### Supporting Services

| Service | Language | Queue Group | Purpose |
|---------|----------|------------|---------|
| **user-search-service** | Go | — | Keycloak Admin API proxy for user search |
| **translation-service** | Go | `translate-workers` | Ollama-based message translation (streaming) |
| **sticker-service** | Go | — | Sticker metadata from PostgreSQL |
| **read-receipt-service** | Go | — | Read position tracking (KV + periodic DB flush) |
| **app-registry-service** | Go | `app-registry-workers` | Room app registry CRUD |

### Room App Services

| Service | Language | Queue Group | Purpose |
|---------|----------|------------|---------|
| **poll-service** | Go | `poll-workers` | Poll creation, voting, results |
| **kb-service** | Java/Spring | `kb-workers` | Knowledge base pages, editing presence |
| **whiteboard-service** | Node.js | `whiteboard-workers` | Collaborative whiteboard |

### Static Servers (nginx)

| Server | Port | Content |
|--------|------|---------|
| **web** | 3000 | React SPA + reverse proxy (K8s) |
| **sticker-images** | 8090 | Static sticker SVGs |
| **poll-app** | 8091 | Poll Web Component JS |
| **whiteboard-app** | 8092 | Whiteboard Web Component JS |
| **kb-app** | 8093 | KB Web Component JS (Angular 19) |

---

## 3. Message Delivery Architecture

### Two-Stream Model

The system separates **notification** from **content delivery**:

**Stream 1 — Notification (ID stream):**
- Fanout-service publishes lightweight `chatNotification` structs to `room.notify.{room}` (public) or `deliver.{userId}.notify.{room}` (private/DM)
- Contains: `notifyId`, `room`, `action`, `user`, `timestamp` — **never message text**
- Browsers receive notification, then decide whether to fetch content

**Stream 2 — Content Fetch (on-demand):**
- Full message stored in `MSG_CACHE` KV bucket (MemoryStorage, 5-minute TTL)
- Browser sends `msg.get` request with `notifyId` → receives full message JSON
- **Capability-based**: notifyId contains crypto-random token (`{room}.{seq}.{instanceId}.{randomHex(16)}`)
- Knowing the notifyId IS the authorization — no user identity checked

### Ingest Path

Users never publish directly to `chat.{room}`. Instead:

```
Browser → deliver.{userId}.send.{room} → fanout-service (validates) → chat.{room} (JetStream)
```

Fanout-service validates:
1. Subject userId matches payload user (anti-impersonation)
2. User is a member of the room (fail-closed on RPC failure)

### Routing by Room Type

| Room Type | Notification Subject | Content | Why |
|-----------|---------------------|---------|-----|
| **Public** | `room.notify.{room}` (NATS multicast) | `msg.get` | Scalable: single publish to all subscribers |
| **Private** | `deliver.{userId}.notify.{room}` (per-user) | `msg.get` | Metadata hidden from non-members |
| **DM** | `deliver.{userId}.notify.{room}` (per-user) | `msg.get` | Metadata hidden from non-participants |
| **Thread** | Same as parent room type | `msg.get` | Includes `threadId` in notification |
| **Admin** | `deliver.{userId}.admin.{room}` (per-user) | Full content in delivery | Legacy: no two-stream |
| **App event** | `deliver.{userId}.app.{appId}.{room}.{event}` (per-user) | Full content in delivery | Low volume, no caching needed |

### NATS Subject Reference

#### Ingest Subjects (browser → fanout-service → JetStream)

| Subject | Publisher | Purpose |
|---------|-----------|---------|
| `deliver.{userId}.send.{room}` | Browser | Main room message |
| `deliver.{userId}.send.{room}.thread.{threadId}` | Browser | Thread reply |

#### Notification Subjects (fanout-service → browser)

| Subject | Publisher | Subscriber | Purpose |
|---------|-----------|-----------|---------|
| `room.notify.{room}` | Fanout | Browser (per-room sub) | Public room notification |
| `deliver.{userId}.notify.{room}` | Fanout | Browser (deliver sub) | Private/DM notification |
| `room.presence.{room}` | Presence | Browser (per-room sub) | Presence diffs |

#### Request/Reply Subjects

| Subject | Responder | Purpose |
|---------|-----------|---------|
| `msg.get` | Fanout | Fetch message content by notifyId |
| `chat.history.{room}` | History | Room message history (paginated) |
| `chat.history.{room}.thread.{threadId}` | History | Thread reply history |
| `chat.dms` | History | List user's DM rooms |
| `room.members.{room}` | Room | Room member list |
| `room.create` / `room.list` / `room.info.*` | Room | Room management |
| `room.invite.*` / `room.kick.*` / `room.depart.*` | Room | Room membership management |
| `presence.room.{room}` | Presence | Query room presence |
| `read.state.{room}` | Read Receipt | Query read positions |
| `users.search` | User Search | Keycloak user search |
| `translate.ping` | Translation | Health check |
| `stickers.products` / `stickers.product.*` | Sticker | Sticker metadata |
| `apps.list` / `apps.room.*` / `apps.install.*` / `apps.uninstall.*` | App Registry | App management |
| `app.{appId}.{room}.{action}` | App Service | Room app RPC |

#### Internal Event Subjects

| Subject | Publisher | Subscribers | Purpose |
|---------|-----------|------------|---------|
| `room.changed.{room}` | Room | Fanout, Presence, Read Receipt | Membership delta |
| `room.join.{room}` / `room.leave.{room}` | Browser/Presence | Room | Join/leave request |
| `presence.heartbeat` | Browser | Presence | Heartbeat (10s interval) |
| `presence.disconnect` | Browser | Presence | Graceful tab close |
| `presence.update` | Browser | Presence | Status change |
| `read.update.{room}` | Browser | Read Receipt | Read position report |
| `translate.request` | Browser | Translation | Fire-and-forget translation |

---

## 4. Security Model

### Authentication Layers

```
Layer 1: Keycloak OIDC (browser → Keycloak → JWT)
Layer 2: NATS Auth Callout (auth-service validates JWT → scoped permissions)
Layer 3: Ingest Validation (fanout-service validates sender + membership)
Layer 4: Content Authorization (capability-based notifyId for msg.get)
Layer 5: Private Room Authorization (room-service DB-backed access check)
```

### Permission Tiers

Three role tiers with progressively restricted capabilities:

| Capability | Admin | User | No Role |
|---|:---:|:---:|:---:|
| Send messages (`deliver.{self}.send.>`) | Yes | Yes | **No** |
| Admin rooms (`admin.>`) | Yes | **No** | **No** |
| Install/uninstall apps | Yes | Yes | **No** |
| Create/manage rooms | Yes | Yes | **No** |
| Read messages (history, msg.get) | Yes | Yes | Yes |
| Join rooms, presence, read receipts | Yes | Yes | Yes |

**Subscribe permissions are identical** across all tiers: `deliver.{self}.>`, `room.notify.*`, `room.presence.*`, `_INBOX.>`.

### Service Account Authentication

- Stored in PostgreSQL `service_accounts` table (username/password)
- Auth-service loads into in-memory cache, refreshes every 5 minutes
- No NATS restart needed to add new service accounts — just `INSERT INTO service_accounts`
- Services get broad `>` pub/sub permissions with 24h JWT expiry

### Security Properties

| Property | Mechanism |
|----------|-----------|
| Anti-impersonation | Ingest validates subject userId == payload user |
| Membership enforcement | Ingest checks membership (fail-closed on RPC failure) |
| Content confidentiality | Two-stream: notifications contain no text; msg.get requires unpredictable notifyId |
| Private room metadata hiding | Per-user delivery (non-members never see `room.notify.{room}`) |
| App sandboxing | AppBridge scopes subjects to `app.{appId}.{room}.*`; action validation rejects wildcards |
| Token lifecycle | 30s refresh interval; auth callout sets JWT expiry to min(token_exp, 1h) |

### Known Security Gaps

1. **Presence metadata leakage**: `room.presence.{room}` uses NATS multicast — any authenticated user could subscribe to see who's in a private room. Mitigation: private room presence could be routed per-user (like notifications)
2. **Service account passwords in plaintext**: PostgreSQL `service_accounts` stores plain passwords. Mitigation: hash passwords (bcrypt)
3. **No rate limiting**: Ingest path has no per-user rate limiting. A compromised session could flood the system
4. **MSG_CACHE TTL window**: Messages are fetchable by anyone with the notifyId for 5 minutes. If a notifyId leaks, it grants temporary access

---

## 5. Data Storage

### PostgreSQL Schema (single `chatdb` database)

```
messages               — Chat messages (room, user, text, timestamp, thread_id, sticker_url, is_deleted, edited_at)
message_versions       — Edit history (audit trail, max 5 per message)
message_reactions      — Emoji reactions (unique per user+emoji per message)
read_receipts          — Read positions (user_id + room → last_read timestamp)
rooms                  — Room metadata (name, display_name, creator, type: public/private/dm)
room_members           — Private room membership (room, user, role: owner/admin/member)
service_accounts       — NATS service auth (username, password, description)
sticker_products       — Sticker packs
stickers               — Individual sticker images
apps                   — Registered room apps (id, name, component_url, subject_prefix)
room_apps              — Per-room app installations
polls                  — Poll questions and options
poll_votes             — Poll votes (unique per user per poll)
whiteboard_boards      — Whiteboard canvas state (elements as JSONB)
kb_pages               — Knowledge base pages (title, content, created_by, updated_by)
```

### NATS KV Buckets

| Bucket | Storage | TTL | Key Format | Purpose |
|--------|---------|-----|------------|---------|
| `ROOMS` | File | — | `{room}.{userId}` → `{}` | Per-membership room membership |
| `PRESENCE` | Memory | — | `{userId}` → `{status, lastSeen}` | Aggregated user status |
| `PRESENCE_CONN` | Memory | 45s | `{userId}.{connId}` → `{}` | Per-connection heartbeat (auto-expires) |
| `MSG_CACHE` | Memory | 5min | `{room}.{seq}.{instance}.{random}` → message JSON | Message content for on-demand fetch |
| `READ_STATE` | File | — | `{userId}.{room}` → `{lastRead}` | Read positions (flushed to DB every 15s) |

### JetStream Streams

| Stream | Subjects | Purpose |
|--------|----------|---------|
| `CHAT_MESSAGES` | `chat.*`, `chat.*.thread.*`, `admin.*` | Message persistence pipeline |

---

## 6. Frontend Architecture

### Provider Hierarchy

```
App
└─ AuthProvider (Keycloak OIDC lifecycle, token refresh)
   └─ ChatApp (renders after auth)
      └─ NatsProvider (WebSocket connection, token-based auth)
         └─ MessageProvider (subscriptions, state, presence)
            └─ ChatContent
               ├─ Header (user info, status selector)
               ├─ RoomSelector (room list, DM list, unread badges)
               └─ ChatRoom (per-room view)
                  ├─ MessageList (timeline, reactions, edit/delete)
                  ├─ MessageInput (text, stickers, mentions)
                  ├─ ThreadPanel (slide-in side panel, optional)
                  └─ App Container (dynamic Web Component mount)
```

### Subscription Lifecycle

**On NATS connect:**
1. Subscribe to `deliver.{username}.>` (single global subscription)
2. Ping `translate.ping` for translation service health
3. Start heartbeat interval (10s → `presence.heartbeat`)

**On room join:**
1. Publish `room.join.{room}`
2. Subscribe to `room.notify.{room}` (notification IDs)
3. Subscribe to `room.presence.{room}` (presence diffs)
4. Request `presence.room.{room}` for initial presence state

**On room leave:**
1. Unsubscribe room.notify + room.presence
2. Publish `room.leave.{room}`

**On tab close (beforeunload):**
1. Publish `presence.disconnect`
2. Publish `room.leave.*` for all joined rooms
3. Flush NATS connection (best-effort)

**On NATS reconnect:**
1. Clear all subscription refs
2. Re-join previously joined rooms (from `joinedRoomsRef`)
3. Re-subscribe to room.notify + room.presence per room

### State Management

No external state libraries. Three React Context providers with refs for synchronous access:

| State | Type | Purpose |
|-------|------|---------|
| `messagesByRoom` | `Record<room, ChatMessage[]>` | Live messages (max 200/room) |
| `messagesByRoomRef` | `MutableRef` | Synchronous dedup access |
| `messageUpdates` | `Record<key, MessageUpdate>` | Edit/delete/react mutations |
| `threadMessagesByThreadId` | `Record<threadId, ChatMessage[]>` | Thread replies |
| `unreadCounts` / `mentionCounts` | `Record<room, number>` | Badge counters |
| `onlineUsers` | `Record<room, PresenceMember[]>` | Per-room presence |
| `translationResults` | `Record<msgKey, Translation>` | Streaming translation chunks |
| `roomSubsRef` | `Map<room, {msgSub, presSub}>` | Active per-room subscriptions |
| `joinedRoomsRef` | `Set<room>` | Rooms to restore on reconnect |

### Message Deduplication

During Keycloak token refresh (every 30s), old and new NATS connections briefly overlap. The dedup guard prevents double-display:

```typescript
const isDup = (messagesByRoomRef.current[room] || []).some(
  m => m.timestamp === data.timestamp && m.user === data.user
);
if (isDup) return;
```

### Room App Integration (Micro-Frontend)

Guest apps are Web Components loaded dynamically from the app registry:

```
ChatRoom → fetch apps.room.{room} → for each installed app:
  1. Load <script src="{componentUrl}"> (cached via customElements.get)
  2. Create <room-app-{appId}> element
  3. Inject AppBridge: createAppBridge(nc, sc, appId, room, username)
  4. Call element.setBridge(bridge)
```

**AppBridge API:**
- `request(action, data)` → scoped `app.{appId}.{room}.{action}` (request/reply)
- `subscribe(event, callback)` → registers in global `appCallbacks` map
- `user` / `room` / `appId` — read-only properties
- Validated: rejects wildcard characters in action names
- Cleanup: `destroyAppBridge()` removes all callbacks on unmount

**Polyglot apps:** Poll (vanilla JS + Go), Whiteboard (React + Node.js), KB (Angular 19 + Java/Spring Boot) — proves language-agnostic architecture.

---

## 7. Scalability Analysis

### Horizontal Scaling via Queue Groups

| Service | Queue Group | Notes |
|---------|-------------|-------|
| fanout-service | `fanout-workers` | Multiple instances share ingest + notify load |
| room-service | `room-workers` | Per-key KV ops eliminate write conflicts |
| presence-service | `presence-workers` | CAS on PRESENCE KV for offline transitions |
| translation-service | `translate-workers` | Each instance can process independent translations |
| app-registry-service | `app-registry-workers` | Stateless DB reads/writes |
| poll-service | `poll-workers` | Stateless DB operations |
| kb-service | `kb-workers` | Editing presence is per-instance (no cross-instance sync) |

### O(1) Room Membership Operations

Room-service uses **sharded per-key KV** (`{room}.{userId}` → `{}`) instead of per-room arrays:
- **Join:** `kv.Create()` — O(1), idempotent via `ErrKeyExists`
- **Leave:** `kv.Delete()` — O(1), no-op if not found
- **No read-modify-write:** eliminates conflicts between instances
- **Delta events:** `room.changed.{room}` contains `{action, userId}` (~50 bytes), not full member list

### Public Room Message Scalability

Public room messages use NATS native multicast:
- Fanout publishes once to `room.notify.{room}`
- NATS kernel delivers to all subscribers
- **O(1) publisher cost** regardless of room size (vs O(members) for per-user delivery)

### Bottleneck Analysis

| Component | Bottleneck | Mitigation |
|-----------|-----------|------------|
| **Fanout-service worker pool** | 32 goroutines, 1000-job channel | Configurable via env vars; drops messages if full |
| **MSG_CACHE KV** | MemoryStorage, single NATS node | 5-minute TTL limits memory; could use replicated KV |
| **Persist-worker** | Single JetStream consumer | JetStream supports consumer groups for parallel consumption |
| **History-service** | Single instance, DB reads | Read replicas; connection pooling |
| **Auth-service** | Single instance, auth callout | Auth callout is per-connection (not per-message); low frequency |
| **LRU cache** | 100-room capacity (configurable) | Cache misses trigger singleflight RPC; adjustable via `FANOUT_LRU_CAPACITY` |

### Estimated Capacity (Single Node)

| Metric | Estimate | Limiting Factor |
|--------|----------|-----------------|
| Concurrent WebSocket connections | ~10K | NATS server memory + file descriptors |
| Messages/sec (public rooms) | ~50K | NATS throughput; each message = 1 publish + 1 KV put + 1 notification |
| Messages/sec (private rooms) | ~5K per room | Per-user delivery: O(members) publishes per message |
| Active rooms | ~10K | ROOMS KV supports 10M+ keys (FileStorage) |
| Thread messages/sec | ~5K | Per-user delivery through worker pool |

---

## 8. Failure Modes & Resilience

### Connection Failures

| Failure | Detection | Recovery |
|---------|-----------|----------|
| NATS server down | Connection error | 30 retries × 2s (startup); unlimited reconnect (runtime) |
| Keycloak down | Token refresh fails | AuthProvider error state; retry on next interval |
| PostgreSQL down | Query error | Services log errors; persist-worker NAKs (JetStream redelivers) |
| Ollama down | Health probe fails | `atomic.Bool` flag; `translate.ping` returns `{available: false}` |

### Message Loss Scenarios

| Scenario | Impact | Mitigation |
|----------|--------|------------|
| MSG_CACHE KV eviction (5min TTL) | Browser can't fetch old notifications | History fallback: messages persisted to PostgreSQL within seconds |
| Worker queue full (1000 jobs) | Private/DM messages dropped | `fanout_drops_total` metric; increase channel size or worker count |
| JetStream unavailable | Messages not persisted | Messages still delivered in real-time; history incomplete until recovery |
| NATS reconnect during token refresh | Brief subscription overlap | Dedup guard: `(timestamp, user)` tuple check |

### Fail-Closed vs Fail-Open

| Check | Behavior | Rationale |
|-------|----------|-----------|
| Ingest membership check | **Fail-closed** (deny) | Security: non-members must not send to private rooms |
| Private room join | **Fail-open** (allow if DB error) | Availability: don't lock out users during DB issues |
| msg.get cache miss | Returns `not_found` error | Browser retries or falls back to history |

### Graceful Shutdown

Fanout-service implements ordered shutdown:
1. `nc.Drain()` — stops accepting new messages, waits for in-flight callbacks
2. `close(jobCh)` — signals workers to finish remaining jobs
3. `workerWg.Wait()` — blocks until all workers exit

---

## 9. Observability

### Telemetry Pipeline

```
All Go Services (OTLP/gRPC)
  ├─ Traces → OTel Collector → Tempo
  ├─ Metrics → OTel Collector → Prometheus (remote write)
  └─ Logs → OTel Collector → Loki (OTLP endpoint)

Browser (W3C Trace Context)
  └─ traceparent header in NATS messages → linked to backend spans

Grafana: Tempo + Prometheus + Loki with cross-linking (trace_id in logs)
```

### Service Metrics

| Service | Key Metrics |
|---------|-------------|
| **auth-service** | `auth_requests_total` (result: authorized/rejected/error), `auth_request_duration_seconds` |
| **fanout-service** | `fanout_messages_total`, `fanout_duration_seconds`, `fanout_drops_total`, `fanout_rejected_total`, `fanout_notifications_total`, `fanout_fetches_total`, `fanout_cache_misses_total`, `fanout_room_count` (gauge), `fanout_total_members` (gauge) |
| **room-service** | `room_joins_total`, `room_leaves_total`, `room_queries_total`, `room_requests_total`, `room_request_duration_seconds`, `room_active_rooms` (gauge) |
| **presence-service** | `presence_updates_total`, `presence_queries_total`, `presence_heartbeats_total`, `presence_disconnects_total`, `presence_expirations_total` |
| **persist-worker** | `messages_persisted_total`, `messages_persist_errors_total`, `messages_edited_total`, `messages_deleted_total`, `reactions_toggled_total` |
| **history-service** | `history_requests_total`, `history_request_duration_seconds` |
| **read-receipt-service** | `read_receipt_updates_total`, `read_receipt_queries_total`, `read_receipt_flush_total` |
| **translation-service** | `translate_requests_total`, `translate_duration_seconds` |
| **sticker-service** | `sticker_requests_total`, `sticker_request_duration_seconds` |
| **app-registry-service** | `app_registry_requests_total`, `app_registry_request_duration_seconds` |
| **poll-service** | `poll_requests_total`, `poll_request_duration_seconds` |
| **kb-service** | (no custom metrics — Spring Boot auto-instrumentation) |

### End-to-End Tracing

Browser generates W3C `traceparent` headers using `crypto.getRandomValues()` and injects into every NATS publish/request. Backend services extract via `otelhelper.StartConsumerSpan`/`StartServerSpan`, creating linked traces from browser action to database write. Log records auto-injected with `trace_id`/`span_id` for Grafana Loki→Tempo cross-linking.

### Observability Gaps

1. **KB Service (Java):** No custom OTel metrics. Spring Boot auto-instrumentation may cover JVM metrics but not app-specific counters
2. **Browser metrics:** No client-side metrics exported (e.g., message latency, render performance, connection drops)
3. **NATS server metrics:** Relied on NATS monitoring port (`8222`) but no scrape config in Prometheus
4. **No alerting rules:** Prometheus has no alert configurations for critical thresholds

---

## 10. Deployment Topology

### Docker Compose (Development)

21+ services on a single host. Direct port mapping. Services connect via Docker DNS names. JetStream data persisted to named volumes. Keycloak realm auto-imported on first start.

### Kubernetes (Kustomize Base + Overlays)

```
k8s/
├─ base/                    # Environment-neutral manifests
│  ├─ nats/                 # StatefulSet + ConfigMap
│  ├─ postgres/             # StatefulSet + ConfigMap + init Job
│  ├─ keycloak/             # Deployment + ConfigMap (realm-export)
│  ├─ {13 backend services} # Deployments only (no Service — NATS-only)
│  ├─ {5 nginx servers}     # Deployment + Service
│  └─ {observability}       # OTel Collector, Tempo, Prometheus, Loki, Grafana
├─ overlays/local/          # NodePort 30000, localhost URLs, demo Secrets
└─ overlays/cloud/          # TLS Ingress, prod URLs, image tag overrides
```

**Resource Summary:**
- 5 StatefulSets: NATS, PostgreSQL, Tempo, Prometheus, Loki
- 21 Deployments: All stateless services
- 20 Services: Infrastructure + nginx + observability (not backend Go services)
- 9 ConfigMaps: nats-server.conf, init.sql, realm-export, env.js, OTel/Tempo/Prometheus/Loki/Grafana
- 1 Job: postgres-init (idempotent SQL with `sed`-based URL substitution)
- 3 Secrets (local overlay): postgres-credentials, auth-service-nkeys, keycloak-admin

**Single-Port Reverse Proxy (local):**

Web nginx container doubles as reverse proxy at NodePort 30000:

| Path | Backend | Notes |
|------|---------|-------|
| `/` | Static SPA | `try_files` fallback to `index.html` |
| `/auth/` | Keycloak | `X-Forwarded-*` headers, large OIDC buffers |
| `/nats-ws` | NATS WebSocket | Upgrade headers, 3600s timeout |
| `/sticker-images/` | sticker-images:8090 | Prefix rewrite |
| `/apps/poll/` | poll-app:8091 | Prefix strip |
| `/apps/whiteboard/` | whiteboard-app:8092 | Prefix strip |
| `/apps/kb/` | kb-app:8093 | Prefix strip |
| `/grafana/` | grafana:3000 | Sub-path via `GF_SERVER_SERVE_FROM_SUB_PATH` |

### Runtime Configuration

| Environment | Config Source | Mechanism |
|-------------|-------------|-----------|
| `npm run dev` | `import.meta.env.VITE_*` | Vite build-time injection |
| Docker Compose | `import.meta.env.VITE_*` | Vite build-time injection |
| K8s Production | `window.__env__` from `env.js` ConfigMap | Runtime injection (mounted into nginx) |

---

## 11. Strengths

### Architecture

1. **Pure NATS inter-service communication** — No HTTP service mesh, no service discovery complexity. NATS provides built-in pub/sub, request/reply, queue groups, and KV store. Adding a new service requires only connecting to NATS
2. **Two-stream security model** — Separating notification metadata from content prevents accidental exposure of message text in notifications. Capability-based notifyId eliminates a whole class of authorization bugs
3. **Sharded per-key room membership** — O(1) join/leave operations with zero write conflicts. FileStorage persists through NATS restarts. Scales to millions of memberships
4. **Delta-based state propagation** — `room.changed.*` events carry only `{action, userId}` (~50 bytes). Each downstream service builds its own optimized local view (LRU in fanout, dual-index in presence, forward-index in read-receipt)
5. **Unified room model** — Public, private, and DM rooms share the same infrastructure (KV membership, fanout, persistence, history). Room type only controls access behavior, not data flow
6. **DB-backed service accounts** — No NATS restart to add new services. INSERT + wait 5 minutes for cache refresh
7. **Polyglot room apps** — Three languages (JS, Java, Go) + three frameworks prove the architecture is truly language-agnostic

### Operations

8. **End-to-end distributed tracing** — Browser-generated W3C traceparent headers link to backend spans. Zero npm dependencies for client-side tracing
9. **Comprehensive OTel instrumentation** — 40+ custom metrics across 11 Go services with trace context propagation and log correlation
10. **Single-port K8s access** — nginx reverse proxy consolidates 8 services behind one NodePort, simplifying both development and production access

### Code Quality

11. **Small service footprint** — Most services are single-file Go (200-600 lines). Clear separation of concerns
12. **Connection guard pattern** — NatsProvider's `ncRef.current === conn` check prevents a subtle race condition during token refresh that would leave the UI disabled
13. **Singleflight for cache misses** — Prevents thundering herd on concurrent cache-miss RPCs in fanout-service

---

## 12. Known Limitations & Risks

### Security

| # | Issue | Severity | Impact |
|---|-------|----------|--------|
| S1 | **Presence leaks for private rooms**: `room.presence.{room}` uses NATS multicast — any authenticated user could subscribe to observe who's in a private room | Medium | Privacy: non-members learn user activity in private rooms |
| S2 | **Service account passwords in plaintext**: `service_accounts` table stores plain passwords | Low (internal) | If DB is compromised, all service credentials are exposed |
| S3 | ~~**No per-user rate limiting**: Ingest path has no throttling~~ | ~~Medium~~ | ~~A compromised session could flood rooms with messages~~ **RESOLVED**: Per-user rate limiting implemented via RATE_LIMIT KV bucket with configurable limit (default 60/min) |
| S4 | **MSG_CACHE notifyId leakage window**: If a notifyId is shared outside the room, anyone can fetch the message for 5 minutes | Low | Limited window; requires notifyId to be leaked |

### Scalability

| # | Issue | Severity | Impact |
|---|-------|----------|--------|
| C1 | **Single-node NATS**: No clustering configured. JetStream, KV buckets, and MSG_CACHE all run on one node | High | Single point of failure for all real-time communication |
| C2 | **Persist-worker is single consumer**: Only one instance consumes from CHAT_MESSAGES stream | Medium | Persistence throughput limited to one instance's DB write speed |
| C3 | **History-service is single instance**: No queue group, no read replicas | Low | History queries could bottleneck under high load |
| C4 | **Auth-service is single instance**: Auth callout has no queue group (NATS limitation) | Low | New connections blocked if auth-service is slow |
| C5 | **LRU cache cold start**: After fanout-service restart, cache is empty — initial messages trigger cache-miss RPCs | Low | Singleflight deduplicates concurrent misses; warm-up is brief |
| C6 | **KB editing presence is per-instance**: `EditingPresenceTracker` uses local ConcurrentHashMap with no cross-instance sync | Low | Multiple kb-service instances show inconsistent editing indicators |

### Consistency

| # | Issue | Severity | Impact |
|---|-------|----------|--------|
| D1 | **Message timestamp as identity**: Messages are identified by `(timestamp, user)` which is millisecond-precision `Date.now()`. Two messages from the same user in the same millisecond could collide | Low | Extremely unlikely in normal usage; could cause dedup false positives |
| D2 | **Read-receipt eventual consistency**: KV updates are flushed to PostgreSQL every 15 seconds | Low | Up to 15s of read position data lost on crash |
| D3 | **Room type tracking in fanout**: `roomTypes` map is populated from `room.changed.*` deltas. If fanout-service misses a delta (restart), public rooms may have unknown type (treated as public — correct default) | Low | Default is safe (public rooms use multicast); private rooms whose type is unknown get multicast instead of per-user |

### Operations

| # | Issue | Severity | Impact |
|---|-------|----------|--------|
| O1 | **No health checks for NATS-only services**: Go backend services have no HTTP health endpoint. K8s can only detect process crash, not deadlock | Medium | A deadlocked service stays "Running" in K8s but processes no messages |
| O2 | **No NATS server metrics scraping**: Prometheus lacks scrape config for NATS monitoring port (8222) | Low | Missing NATS-level metrics (connections, slow consumers, JetStream lag) |
| O3 | **No alerting rules**: No Prometheus alert configurations for thresholds (e.g., `fanout_drops_total > 0`, `messages_persist_errors_total > 0`) | Medium | Issues only discovered through manual dashboard inspection |
| O4 | **Startup ordering dependency**: Auth-service must connect to both Keycloak and NATS. If Keycloak is slow (realm import), auth-service may exhaust 30 retries | Low | Documented workaround: restart auth-service after Keycloak is healthy |

---

## 13. Recommendations

### High Priority

1. **NATS Clustering** (C1): Configure a 3-node NATS cluster with JetStream replication for production. Currently the single NATS node is a single point of failure for the entire system

2. **NATS health probes for backend services** (O1): Add a lightweight health check mechanism — either a NATS-based ping/pong pattern or minimal HTTP health endpoint — so Kubernetes can detect stuck services

	3. ~~**Per-user rate limiting in ingest** (S3): Add a token-bucket or sliding-window rate limiter in the fanout-service ingest handler. Could use NATS KV with TTL for distributed rate state~~ **IMPLEMENTED**: Sliding-window rate limiter added with `FANOUT_RATE_LIMIT_PER_MINUTE` env var (default 60), uses RATE_LIMIT KV bucket for distributed state

4. **Alerting rules** (O3): Add Prometheus alerting for critical conditions: `fanout_drops_total > 0`, `messages_persist_errors_total > 0`, `auth_requests_total{result="error"} > threshold`, `presence_expirations_total` spike

### Medium Priority

5. **Private room presence routing** (S1): Route `room.presence.{room}` via per-user delivery for private rooms (like notifications). This matches the existing pattern in fanout-service

6. **NATS server monitoring** (O2): Add Prometheus scrape config for NATS monitoring endpoints (`/varz`, `/connz`, `/jsz`). Critical for understanding connection counts, slow consumers, and JetStream lag

7. **Parallel persist-workers** (C2): Use JetStream consumer groups to allow multiple persist-worker instances to consume in parallel. Requires idempotent writes (already have `ON CONFLICT` for reactions)

8. **Service account password hashing** (S2): Hash passwords with bcrypt in the `service_accounts` table. Modify auth-service to compare against hashed values

### Low Priority

9. **Client-side metrics** (observability gap): Export browser metrics (message latency, render performance, WebSocket reconnect count) via NATS pub to a metrics collection subject

10. **Message UUID**: Replace `(timestamp, user)` identity with server-generated UUIDs (D1). This would require changes to persist-worker, history-service, and frontend dedup logic

11. **KB editing presence sync** (C6): If multiple kb-service instances are needed, use NATS KV for editing presence instead of local ConcurrentHashMap

12. **History-service queue group** (C3): Add a queue group to history-service for horizontal scaling under high query load

---

*This review reflects the architecture as of commit `b59591a`. The system demonstrates sophisticated distributed systems design with clear separation of concerns, strong security boundaries, and comprehensive observability. The two-stream message delivery model and sharded per-key room membership are particularly well-designed for scalability.*
