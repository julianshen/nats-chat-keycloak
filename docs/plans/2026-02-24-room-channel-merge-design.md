# Room + Channel Service Merge Design

## Overview

Room-service and channel-service were tightly coupled via NATS pub/sub: channel-service published `room.join/leave.*` for room-service to process, and room-service called `channel.check.*` back to channel-service for private channel authorization. This async coordination added latency (500ms timeouts) and created race conditions (kicked users receiving messages during the gap between DB and KV deletes). Merging both into a single room-service eliminates the NATS round-trips, replacing them with local function calls that execute atomically.

No frontend changes were required — all NATS subjects use the unified `room.*` namespace.

**Status:** Completed. The `channel.*` subjects have been fully renamed to `room.*`. The `channels`/`channel_members` tables have been replaced by `rooms`/`room_members` with a `type` enum (public/private/dm) instead of `is_private` boolean. See the [Room Subscription Design](2026-02-25-room-subscription-design.md) for the current architecture.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Merge direction | Channel into room-service | Room-service owns the KV membership state; channel operations are consumers of that state |
| Queue group | Shared `room-workers` for all handlers | Single scaling unit, simpler deployment, no cross-service coordination |
| Authorization | Local DB query (`checkRoomAccess()`) | Eliminates 500ms NATS timeout, fail-open on DB error matches previous behavior |
| Room mutations | Direct `addToRoom()`/`removeFromRoom()` helpers | Atomic KV write + cache update + delta publish in one call chain — no async gap |
| Private room state | In-memory map loaded from DB at startup | Replaces event subscription — no event ordering concerns |
| Unified naming | `room.*` subjects, `rooms`/`room_members` tables | Single namespace for public rooms, private rooms, and DMs |
| Room type | `type` enum (public/private/dm) | Replaces `is_private` boolean; extensible for future room types |
| Voluntary leave | `room.depart.*` subject | Avoids collision with `room.leave.*` (KV membership handler with different payload semantics) |

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
2. room-service: DELETE FROM room_members (bob removed in DB)
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
  → checkRoomAccess("private", "alice")  // local DB query
  → proceeds with addToRoom()

Total: ~1-5ms (DB query only), no timeout
```

## System Architecture

```
Browser (React + nats.ws)
  │  room.join.* / room.leave.*   ← public room membership
  │  room.create / room.list / room.info.*
  │  room.invite.* / room.kick.* / room.depart.*
  ▼
Room Service (Go, single process)
  ├─ NATS KV: ROOMS bucket (sharded per-key, FileStorage)
  │   └─ key = {room}.{userId} → {}
  ├─ PostgreSQL: rooms + room_members tables
  │   └─ Room metadata (type: public/private/dm), membership roles, ownership
  ├─ In-memory:
  │   ├─ localMembership (forward-index: room → set<userId>)
  │   └─ privateRooms (map: roomName → true)
  └─ NATS subjects:
      ├─ room.join.* (QG: room-workers)      → checkRoomAccess() + addToRoom()
      ├─ room.leave.* (QG: room-workers)     → removeFromRoom()
      ├─ room.members.* (QG: room-members-workers) → local cache query
      ├─ room.changed.* (no QG)              → rebuild local index
      ├─ room.create (QG: room-workers)      → DB + addToRoom()
      ├─ room.list (QG: room-workers)        → DB query
      ├─ room.info.* (QG: room-workers)      → DB query
      ├─ room.invite.* (QG: room-workers)    → DB + addToRoom()
      ├─ room.kick.* (QG: room-workers)      → DB + removeFromRoom()
      └─ room.depart.* (QG: room-workers)    → DB + removeFromRoom()

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
  secret-project.bob → {}
  dm-alice-bob.alice → {}
```

### PostgreSQL

```sql
-- Unified room entity (public, private, DM)
CREATE TABLE rooms (
    name         TEXT PRIMARY KEY,
    display_name TEXT,
    creator      TEXT NOT NULL,
    type         TEXT NOT NULL DEFAULT 'private',  -- public | private | dm
    created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Room membership with roles
CREATE TABLE room_members (
    room_name    TEXT NOT NULL REFERENCES rooms(name) ON DELETE CASCADE,
    username     TEXT NOT NULL,
    role         TEXT NOT NULL DEFAULT 'member',  -- owner | admin | member
    invited_by   TEXT,
    joined_at    TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (room_name, username)
);
```

### In-Memory State

| Structure | Type | Source | Purpose |
|-----------|------|--------|---------|
| `localMembership` | `map[string]map[string]bool` | ROOMS KV hydration + room.changed.* deltas | O(1) room.members.* query responses |
| `privateRooms` | `map[string]bool` | PostgreSQL `SELECT name FROM rooms WHERE type IN ('private', 'dm')` at startup | O(1) private room check in room.join.* handler |

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

### `checkRoomAccess(ctx, room, userId) (isPrivate, authorized bool)`

Replaces the old `channel.check.*` NATS request/reply with a direct DB query.

```
1. Check privateRooms map: room in privateRooms?
   - Not found → (false, true)     // public room, allow
2. SELECT type FROM rooms WHERE name = $1
   - ErrNoRows → (false, true)     // not a room, allow
   - DB error  → (false, true)     // fail-open
3. SELECT COUNT(*) FROM room_members
   WHERE room_name = $1 AND username = $2
4. return (true, count > 0)
```

Fail-open behavior matches the previous channel-service implementation exactly.

## NATS Subject Map

### Room Membership (pub/sub)

| Subject | QG | Payload | Handler |
|---------|-------------|---------|---------|
| `room.join.*` | `room-workers` | `{userId}` | checkRoomAccess() + addToRoom() |
| `room.leave.*` | `room-workers` | `{userId}` | removeFromRoom() |
| `room.members.*` | `room-members-workers` | _(request/reply)_ | Return local cache as JSON array |
| `room.changed.*` | _(none)_ | `{action, userId}` | Update local forward-index from delta |

### Room Management (request/reply, QG: room-workers)

| Subject | Request Payload | Response |
|---------|-----------------|----------|
| `room.create` | `{name, displayName, user}` | `RoomInfo` or `{error}` |
| `room.list` | `{user}` | `RoomInfo[]` (user's rooms) |
| `room.info.*` | _(empty)_ | `RoomInfo` with `members[]` |
| `room.invite.*` | `{target, user}` | `{ok: true}` or `{error}` |
| `room.kick.*` | `{target, user}` | `{ok: true}` or `{error}` |
| `room.depart.*` | `{user}` | `{ok: true}` or `{error}` |

### Removed Subjects

| Subject | Previous Purpose | Replacement |
|---------|-----------------|-------------|
| `channel.check.*` | Room-service queried channel-service for authorization | `checkRoomAccess()` local function |
| `channel.created` | Channel-service notified room-service of new private channels | `privateRooms[name] = true` set directly after DB insert |
| `channel.create/list/info/invite/kick/leave` | Channel management | Renamed to `room.create/list/info/invite/kick/depart` |

## Room Management Handler Details

### room.create

```
1. Validate: name and user required
2. BEGIN transaction
3. INSERT INTO rooms (name, display_name, creator, type)
   - duplicate key → respond "room already exists"
4. INSERT INTO room_members (room_name, username, role='owner')
5. COMMIT
6. privateRooms[name] = true            ← local state update
7. addToRoom(ctx, name, user)           ← KV + cache + delta (atomic)
8. publishSystemMessage("X created the room")
9. Respond with RoomInfo object
```

### room.invite.*

```
1. Parse room name from subject
2. Check requester role: SELECT role FROM room_members WHERE room_name=$1 AND username=$2
   - Must be "owner" or "admin"
3. INSERT INTO room_members (room_name, target, role='member', invited_by)
   ON CONFLICT DO NOTHING
4. addToRoom(ctx, room, target)         ← KV + cache + delta (atomic)
5. publishSystemMessage("X was invited by Y")
6. Respond {ok: true}
```

### room.kick.*

```
1. Parse room name from subject
2. Check requester role (must be owner/admin)
3. Check target role (cannot kick owner)
4. DELETE FROM room_members WHERE room_name=$1 AND username=$2
5. removeFromRoom(ctx, room, target)    ← KV + cache + delta (atomic)
6. publishSystemMessage("X was removed by Y")
7. Respond {ok: true}
```

### room.depart.*

```
1. Parse room name from subject
2. Check user's role
3. If owner:
   a. Find next owner candidate (prefer admins, then oldest member)
   b. If no candidates → DELETE room, removeFromRoom(), respond {ok, deleted: true}
   c. Else → UPDATE new owner's role to 'owner'
4. DELETE FROM room_members WHERE room_name=$1 AND username=$2
5. removeFromRoom(ctx, room, user)
6. publishSystemMessage("X left the room")
7. Respond {ok: true}
```

## OTel Instrumentation

### Metrics

| Metric | Type | Source |
|--------|------|--------|
| `room_joins_total` | Counter | room.join.* handler |
| `room_leaves_total` | Counter | room.leave.* handler |
| `room_queries_total` | Counter | room.members.* handler |
| `room_active_rooms` | Gauge (observable) | `mem.roomCount()` |
| `room_requests_total{action}` | Counter | All room management handlers |
| `room_request_duration_seconds{action}` | Histogram | All room management handlers |

### Spans

- `room join` / `room leave` — consumer spans on room.join/leave.* (attributes: `room.name`, `room.user`)
- `room members query` — server span on room.members.* (attributes: `room.name`, `room.member_count`)
- `room.create/list/info/invite/kick/depart` — server spans on room management handlers (attributes: `room.name`, `room.creator`/`room.target`/`room.user`)

## Startup Sequence

```
1. OTel Init
2. PostgreSQL connect (30-attempt retry, 2s interval)
3. Load private rooms from DB → privateRooms map
4. NATS connect (30-attempt retry, 2s interval)
   - Registers reconnect handler (re-hydrates KV on reconnect)
5. JetStream context + ROOMS KV bucket (FileStorage)
6. Subscribe room.changed.* (no QG) — MUST be before hydration
7. Hydrate local membership from KV (atomic swap)
8. Subscribe room.join.* (QG: room-workers)
9. Subscribe room.leave.* (QG: room-workers)
10. Subscribe room.members.* (QG: room-members-workers)
11. Subscribe room.create (QG: room-workers)
12. Subscribe room.list (QG: room-workers)
13. Subscribe room.info.* (QG: room-workers)
14. Subscribe room.invite.* (QG: room-workers)
15. Subscribe room.kick.* (QG: room-workers)
16. Subscribe room.depart.* (QG: room-workers)
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

## What Changed vs What Didn't

### Changed

- Room-service binary includes PostgreSQL driver and all room management handler logic
- Room-service connects to PostgreSQL (new dependency)
- `channel.*` subjects renamed to `room.*` (with `room.depart.*` replacing `channel.leave.*`)
- `channels`/`channel_members` tables replaced by `rooms`/`room_members` with `type` enum
- `is_private` boolean replaced by `type` field (public/private/dm)
- `checkChannelMembership()` renamed to `checkRoomAccess()`
- `privateChannels` map renamed to `privateRooms`
- One fewer container/pod to manage

### Unchanged

- All browser-facing NATS subject semantics (payloads and responses)
- NATS KV membership model (per-key sharding, FileStorage)
- `addToRoom()`/`removeFromRoom()` atomic helper pattern
- Downstream services (fanout, presence, read-receipt) — consume `room.changed.*` deltas
- Auth service permissions mapping
- Metrics semantics (names updated to `room_*` prefix)
