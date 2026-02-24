# Room + Channel Service Merge Design

## Overview

Room-service and channel-service were tightly coupled via NATS pub/sub: channel-service published `room.join/leave.*` for room-service to process, and room-service called `channel.check.*` back to channel-service for private channel authorization. This async coordination added latency (500ms timeouts) and created race conditions (kicked users receiving messages during the gap between DB and KV deletes). Merging both into a single room-service eliminates the NATS round-trips, replacing them with local function calls that execute atomically.

No frontend changes are required — all `channel.*` and `room.*` NATS subjects remain identical.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Merge direction | Channel into room-service | Room-service owns the KV membership state; channel operations are consumers of that state |
| Queue group | Shared `room-workers` for all handlers | Single scaling unit, simpler deployment, no cross-service coordination |
| Authorization | Local DB query (`checkChannelMembership()`) | Eliminates 500ms NATS timeout, fail-open on DB error matches previous behavior |
| Room mutations | Direct `addToRoom()`/`removeFromRoom()` helpers | Atomic KV write + cache update + delta publish in one call chain — no async gap |
| Private channel state | In-memory map loaded from DB at startup | Replaces `channel.created` event subscription — no event ordering concerns |
| `channel.check.*` subject | Removed entirely | Was only consumed by room-service internally; now a local function |
| Metrics | Preserved both `room_*` and `channel_*` metric families | Backward-compatible dashboards; both OTel counter/histogram names unchanged |

## Problem: Async Coordination Bugs

### Race Condition: Kicked User Receives Messages

```
BEFORE (two services, async):

1. Admin kicks bob from #private
2. channel-service: DELETE FROM channel_members (bob removed in DB)
3. channel-service: publish room.leave.private {userId: "bob"}   ← async
4. [WINDOW] Messages sent to #private are still fanned out to bob
5. room-service: receives room.leave.private
6. room-service: kv.Delete("private.bob")
7. room-service: mem.remove("private", "bob")
8. room-service: publish room.changed.private {action: "leave"}
9. fanout-service: removes bob from delivery list

Gap between step 3 and step 9 = ~50-200ms where bob still receives messages.
```

```
AFTER (merged, synchronous):

1. Admin kicks bob from #private
2. room-service: DELETE FROM channel_members (bob removed in DB)
3. room-service: removeFromRoom("private", "bob")
   3a. kv.Delete("private.bob")          ← immediate
   3b. mem.remove("private", "bob")      ← immediate
   3c. publish room.changed.private      ← immediate
4. fanout-service: removes bob from delivery list

No gap — steps 3a/3b/3c execute synchronously before responding to the admin.
```

### Latency: Authorization Round-Trip

```
BEFORE:

Browser publishes room.join.private {userId: "alice"}
  → room-service receives
  → nc.Request("channel.check.private", {userId: "alice"}, 500ms)
    → channel-service receives, queries DB, responds
  ← room-service gets response, proceeds with kv.Create()

Total: ~5-50ms (NATS RTT + DB query) with 500ms timeout risk
```

```
AFTER:

Browser publishes room.join.private {userId: "alice"}
  → room-service receives
  → checkChannelMembership(ctx, "private", "alice")  // local DB query
  → proceeds with addToRoom()

Total: ~1-5ms (DB query only), no timeout
```

## System Architecture

```
Browser (React + nats.ws)
  │  room.join.* / room.leave.*   ← public room membership
  │  channel.create / channel.list / channel.info.*
  │  channel.invite.* / channel.kick.* / channel.leave.*
  ▼
Room Service (Go, single process)
  ├─ NATS KV: ROOMS bucket (sharded per-key, FileStorage)
  │   └─ key = {room}.{userId} → {}
  ├─ PostgreSQL: channels + channel_members tables
  │   └─ Private channel metadata, membership roles, ownership
  ├─ In-memory:
  │   ├─ localMembership (forward-index: room → set<userId>)
  │   └─ privateChannels (map: channelName → true)
  └─ NATS subjects:
      ├─ room.join.* (QG: room-workers)      → addToRoom()
      ├─ room.leave.* (QG: room-workers)     → removeFromRoom()
      ├─ room.members.* (QG: room-members-workers) → local cache query
      ├─ room.changed.* (no QG)              → rebuild local index
      ├─ channel.create (QG: room-workers)   → DB + addToRoom()
      ├─ channel.list (QG: room-workers)     → DB query
      ├─ channel.info.* (QG: room-workers)   → DB query
      ├─ channel.invite.* (QG: room-workers) → DB + addToRoom()
      ├─ channel.kick.* (QG: room-workers)   → DB + removeFromRoom()
      └─ channel.leave.* (QG: room-workers)  → DB + removeFromRoom()

  Downstream (unchanged):
  ├─ fanout-service: subscribes room.changed.* → updates LRU cache
  ├─ presence-service: subscribes room.changed.* → updates dual-index
  └─ read-receipt-service: subscribes room.changed.* → updates forward-index
```

## Data Model

### NATS KV (unchanged)

```
Bucket: ROOMS (FileStorage, History: 1)
Key format: {room}.{userId}
Value: {} (empty JSON object)

Examples:
  general.alice → {}
  private-team.bob → {}
  dm-alice-bob.alice → {}
```

### PostgreSQL (unchanged, owned by room-service now)

```sql
-- Private channel definitions
CREATE TABLE channels (
    name         TEXT PRIMARY KEY,
    display_name TEXT,
    creator      TEXT NOT NULL,
    is_private   BOOLEAN DEFAULT TRUE,
    created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Channel membership with roles
CREATE TABLE channel_members (
    channel_name TEXT NOT NULL REFERENCES channels(name) ON DELETE CASCADE,
    username     TEXT NOT NULL,
    role         TEXT NOT NULL DEFAULT 'member',  -- owner | admin | member
    invited_by   TEXT,
    joined_at    TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (channel_name, username)
);
CREATE INDEX idx_channel_members_user ON channel_members(username);
```

### In-Memory State

| Structure | Type | Source | Purpose |
|-----------|------|--------|---------|
| `mem` (localMembership) | `map[string]map[string]bool` | ROOMS KV hydration + room.changed.* deltas | O(1) room.members.* query responses |
| `privateChannels` | `map[string]bool` | PostgreSQL `SELECT name FROM channels WHERE is_private = true` at startup | O(1) private channel check in room.join.* handler |

## Key Functions

### `addToRoom(ctx, room, userId) error`

Atomic helper that replaces the old pattern of publishing `room.join.*` and waiting for self-processing.

```
1. kv.Create(room + "." + userId, "{}")
   - ErrKeyExists → return nil (idempotent)
   - Other error → return error
2. mem.add(room, userId)          ← local cache updated immediately
3. joinCounter.Add(1)
4. publishDelta(room, "join", userId)  ← downstream services notified
5. slog.Info("User joined room")
```

### `removeFromRoom(ctx, room, userId) error`

Atomic helper that replaces the old pattern of publishing `room.leave.*` and waiting for self-processing.

```
1. kv.Delete(room + "." + userId)
   - ErrKeyNotFound → return nil (idempotent)
   - Other error → return error
2. mem.remove(room, userId)       ← local cache updated immediately
3. leaveCounter.Add(1)
4. publishDelta(room, "leave", userId)  ← downstream services notified
5. slog.Info("User left room")
```

### `checkChannelMembership(ctx, room, userId) (isPrivate, authorized bool)`

Replaces the `channel.check.*` NATS request/reply with a direct DB query.

```
1. SELECT is_private FROM channels WHERE name = $1
   - ErrNoRows → (false, true)     // not a channel, allow
   - DB error  → (false, true)     // fail-open
   - !isPrivate → (false, true)    // public channel, allow
2. SELECT COUNT(*) FROM channel_members
   WHERE channel_name = $1 AND username = $2
3. return (true, count > 0)
```

Fail-open behavior matches the previous channel-service implementation exactly.

## NATS Subject Map

### Room Subjects (unchanged behavior)

| Subject | Type | Queue Group | Handler |
|---------|------|-------------|---------|
| `room.join.*` | pub/sub | `room-workers` | Parse userId, check private channel auth, `addToRoom()` |
| `room.leave.*` | pub/sub | `room-workers` | Parse userId, `removeFromRoom()` |
| `room.members.*` | request/reply | `room-members-workers` | Return `mem.members(room)` as JSON array |
| `room.changed.*` | pub/sub | (no QG) | Update local forward-index from delta events |

### Channel Subjects (unchanged wire format)

| Subject | Type | Queue Group | Request Payload | Response |
|---------|------|-------------|-----------------|----------|
| `channel.create` | request/reply | `room-workers` | `{name, displayName, user}` | `Channel` object or `{error}` |
| `channel.list` | request/reply | `room-workers` | `{user}` | `Channel[]` (user's channels) |
| `channel.info.*` | request/reply | `room-workers` | (none) | `Channel` with `members[]` |
| `channel.invite.*` | request/reply | `room-workers` | `{target, user}` | `{ok: true}` or `{error}` |
| `channel.kick.*` | request/reply | `room-workers` | `{target, user}` | `{ok: true}` or `{error}` |
| `channel.leave.*` | request/reply | `room-workers` | `{user}` | `{ok: true}` or `{error}` |

### Removed Subjects

| Subject | Previous Purpose | Replacement |
|---------|-----------------|-------------|
| `channel.check.*` | Room-service queried channel-service for authorization | `checkChannelMembership()` local function |
| `channel.created` | Channel-service notified room-service of new private channels | `privateChannels[name] = true` set directly after DB insert |

## Channel Handler Details

### channel.create

```
1. Validate: name and user required
2. BEGIN transaction
3. INSERT INTO channels (name, display_name, creator)
   - duplicate key → respond "channel already exists"
4. INSERT INTO channel_members (channel_name, username, role='owner')
5. COMMIT
6. privateChannels[name] = true        ← local state update
7. addToRoom(ctx, name, user)          ← KV + cache + delta (atomic)
8. publishSystemMessage("X created the channel")
9. Respond with Channel object
```

### channel.invite.*

```
1. Parse channel name from subject
2. Check requester role: SELECT role FROM channel_members WHERE channel_name=$1 AND username=$2
   - Must be "owner" or "admin"
3. INSERT INTO channel_members (channel_name, target, role='member', invited_by)
   ON CONFLICT DO NOTHING
4. addToRoom(ctx, channel, target)     ← KV + cache + delta (atomic)
5. publishSystemMessage("X was invited by Y")
6. Respond {ok: true}
```

### channel.kick.*

```
1. Parse channel name from subject
2. Check requester role (must be owner/admin)
3. Check target role (cannot kick owner)
4. DELETE FROM channel_members WHERE channel_name=$1 AND username=$2
5. removeFromRoom(ctx, channel, target) ← KV + cache + delta (atomic)
6. publishSystemMessage("X was removed by Y")
7. Respond {ok: true}
```

### channel.leave.*

```
1. Parse channel name from subject
2. Check user's role
3. If owner:
   a. Find next owner candidate (prefer admins, then oldest member)
   b. If no candidates → DELETE channel, removeFromRoom(), respond {ok, deleted: true}
   c. Else → UPDATE new owner's role to 'owner'
4. DELETE FROM channel_members WHERE channel_name=$1 AND username=$2
5. removeFromRoom(ctx, channel, user)
6. publishSystemMessage("X left the channel")
7. Respond {ok: true}
```

## OTel Instrumentation

### Metrics (all preserved from both services)

| Metric | Type | Source |
|--------|------|--------|
| `room_joins_total` | Counter | room.join.* handler |
| `room_leaves_total` | Counter | room.leave.* handler |
| `room_queries_total` | Counter | room.members.* handler |
| `room_active_rooms` | Gauge (observable) | `mem.roomCount()` |
| `channel_requests_total{action}` | Counter | All channel.* handlers |
| `channel_request_duration_seconds{action}` | Histogram | All channel.* handlers |

### Spans

- `room join` / `room leave` — consumer spans on room.join/leave.* (attributes: `room.name`, `room.user`)
- `room members query` — server span on room.members.* (attributes: `room.name`, `room.member_count`)
- `channel.create/list/info/invite/kick/leave` — server spans on channel.* handlers (attributes: `channel.name`, `channel.creator`/`channel.target`/`channel.user`)

## Startup Sequence

```
1. OTel Init
2. PostgreSQL connect (30-attempt retry, 2s interval)
3. Load private channels from DB → privateChannels map
4. NATS connect (30-attempt retry, 2s interval)
   - Registers reconnect handler (re-hydrates KV on reconnect)
5. JetStream context + ROOMS KV bucket (FileStorage)
6. Subscribe room.changed.* (no QG) — MUST be before hydration
7. Hydrate local membership from KV (atomic swap)
8. Subscribe room.join.* (QG: room-workers)
9. Subscribe room.leave.* (QG: room-workers)
10. Subscribe room.members.* (QG: room-members-workers)
11. Subscribe channel.create (QG: room-workers)
12. Subscribe channel.list (QG: room-workers)
13. Subscribe channel.info.* (QG: room-workers)
14. Subscribe channel.invite.* (QG: room-workers)
15. Subscribe channel.kick.* (QG: room-workers)
16. Subscribe channel.leave.* (QG: room-workers)
17. Ready — wait for SIGINT/SIGTERM
```

**Ordering invariant:** Step 6 (subscribe to deltas) must happen before step 7 (KV hydration). This ensures no events are missed between hydration snapshot and live delta stream. Same pattern used by presence-service and fanout-service.

## Infrastructure Changes

### Docker Compose

| Change | Detail |
|--------|--------|
| room-service `DATABASE_URL` | Added `postgres://chat:chat-secret@postgres:5432/chatdb?sslmode=disable` |
| room-service `depends_on` | Added `postgres` |
| channel-service block | Deleted entirely |
| Container count | 22 → 21 |

### Kubernetes

| File | Change |
|------|--------|
| `k8s/base/room-service/deployment.yaml` | Added `DATABASE_URL` env from `postgres-credentials` secret |
| `k8s/base/kustomization.yaml` | Removed `channel-service/deployment.yaml` resource |
| `k8s/build-local.sh` | Removed `channel-service` from `GO_SERVICES` array |
| `k8s/base/postgres/configmap.yaml` | Removed `channel-service` service account row |
| `k8s/base/channel-service/` | Deleted directory |

### Go Module

Added to `room-service/go.mod`:
- `github.com/XSAM/otelsql v0.35.0` (SQL instrumentation)
- `github.com/lib/pq v1.10.9` (PostgreSQL driver)

## Migration & Compatibility

### Zero-Downtime Deployment

The merge requires no migration steps beyond deploying the new room-service and removing channel-service:

1. **NATS subjects unchanged** — All `channel.*` and `room.*` subjects have the same wire format. The browser and other backend services are unaware of the merge.
2. **DB schema unchanged** — The `channels` and `channel_members` tables are not modified. Room-service connects to the same PostgreSQL database.
3. **Service account unchanged** — Room-service still authenticates as `room-service`/`room-service-secret`. The `channel-service` service account can be left in the DB (harmless) or removed.

### Rollback

If issues arise, revert by:
1. Restoring the `channel-service/` directory
2. Restoring the old `room-service/main.go` (without DB connection or channel handlers)
3. Re-adding `channel-service` to docker-compose.yml
4. Restarting both services

No data migration is needed in either direction.

## What Changed vs What Didn't

### Changed

- Room-service binary now includes PostgreSQL driver and all channel handler logic
- Room-service connects to PostgreSQL (new dependency)
- `channel.check.*` subject no longer exists (was internal-only)
- `channel.created` subject no longer published (was internal-only)
- One fewer container/pod to manage

### Unchanged

- All browser-facing NATS subjects (`channel.create/list/info/invite/kick/leave`)
- All room NATS subjects (`room.join/leave/members/changed`)
- PostgreSQL schema (channels, channel_members tables)
- Frontend code (React components, MessageProvider)
- Downstream services (fanout, presence, read-receipt)
- Auth service permissions mapping
- Metrics names and labels (backward-compatible dashboards)
