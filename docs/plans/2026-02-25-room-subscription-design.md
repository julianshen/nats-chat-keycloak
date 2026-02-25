# Room Subscription Design

Consolidated design document for the unified room model and hybrid subscription architecture. Covers all message delivery paths with sequence diagrams.

## Architecture Overview

The system uses a **hybrid subscription model** combining per-room NATS multicast (high-volume chat) with per-user delivery (low-volume targeted messages):

| Delivery path | Subject pattern | Mechanism | Used for |
|---|---|---|---|
| Per-room multicast | `room.msg.{room}` | NATS native multicast | Main room chat messages |
| Per-room multicast | `room.presence.{room}` | NATS native multicast | Presence diffs (online/offline/status) |
| Per-user delivery | `deliver.{userId}.chat.{room}.thread.{threadId}` | Fanout service N-copy | Thread replies |
| Per-user delivery | `deliver.{userId}.admin.{room}` | Fanout service N-copy | Admin messages |
| Per-user delivery | `deliver.{userId}.translate.response` | Direct publish | Translation streaming |
| Per-user delivery | `deliver.{userId}.app.{appId}.{room}.{event}` | Fanout service N-copy | Room app events |

### Browser Subscriptions per User

```
deliver.{userId}.>                     # 1 wildcard (threads, admin, translate, apps)
room.msg.{room₁}                      # N per-room (chat messages)
room.msg.{room₂}
...
room.presence.{room₁}                 # N per-room (presence diffs)
room.presence.{room₂}
...
_INBOX.>                               # 1 wildcard (request/reply)
```

Total: `2N + 2` subscriptions where N = number of joined rooms.

---

## Sequence Diagrams

### 1. Regular Chat Message (Per-Room Multicast)

A user sends a message in a public room. The fanout service re-publishes to `room.msg.{room}` and NATS multicasts to all subscribers.

```mermaid
sequenceDiagram
    participant Alice as Alice (Browser)
    participant NATS as NATS Server
    participant Fanout as Fanout Service
    participant JS as JetStream
    participant Persist as Persist Worker
    participant Bob as Bob (Browser)
    participant Carol as Carol (Browser)

    Note over Alice,Carol: Alice, Bob, Carol all subscribed to room.msg.general
    Note over Alice,Carol: All receive via native NATS multicast — O(1) publish by fanout

    Alice->>NATS: PUB chat.general {user:"alice", text:"hello", timestamp:T}

    par Fanout receives via QG
        NATS->>Fanout: chat.general (queue: fanout-workers)
        Fanout->>NATS: PUB room.msg.general {same payload}
        Note over Fanout: Single publish, no member lookup needed
    and JetStream captures for persistence
        NATS->>JS: chat.general → CHAT_MESSAGES stream
        JS->>Persist: Consumer delivers message
        Persist->>Persist: INSERT INTO messages (room, user, text, timestamp)
    end

    par NATS multicasts to all subscribers
        NATS->>Alice: room.msg.general {user:"alice", text:"hello", timestamp:T}
        NATS->>Bob: room.msg.general {user:"alice", text:"hello", timestamp:T}
        NATS->>Carol: room.msg.general {user:"alice", text:"hello", timestamp:T}
    end

    
```

### 2. Thread Reply (Per-User Delivery)

Thread replies use per-user `deliver.{userId}.*` delivery. Optional broadcast sends a second copy through `room.msg.*`.

```mermaid
sequenceDiagram
    participant Alice as Alice (Browser)
    participant NATS as NATS Server
    participant Fanout as Fanout Service
    participant Bob as Bob (Browser)
    participant Carol as Carol (Browser)

    Note over Alice,Carol: Alice replies in thread with "Also send to channel" checked
    Note over Alice,Carol: Thread panel shows reply; room timeline shows broadcast copy

    Alice->>NATS: PUB chat.general.thread.general-12345 {text:"reply", broadcast:true}
    Alice->>NATS: PUB chat.general {text:"reply", broadcast:true, threadId:"general-12345"}
    
    par Thread copy → per-user fanout
        NATS->>Fanout: chat.general.thread.general-12345 (queue: fanout-workers)
        Fanout->>Fanout: getMembers("general") → [alice, bob, carol]
        par Worker pool (32 goroutines)
            Fanout->>NATS: PUB deliver.alice.chat.general.thread.general-12345
            Fanout->>NATS: PUB deliver.bob.chat.general.thread.general-12345
            Fanout->>NATS: PUB deliver.carol.chat.general.thread.general-12345
        end
    and Broadcast copy → room.msg multicast
        NATS->>Fanout: chat.general (queue: fanout-workers)
        Fanout->>NATS: PUB room.msg.general {broadcast copy}
    end

    par Thread replies via deliver.*
        NATS->>Alice: deliver.alice.chat.general.thread.general-12345
        Note over Alice: → threadMessagesByThreadId
        NATS->>Bob: deliver.bob.chat.general.thread.general-12345
        Note over Bob: → threadMessagesByThreadId
    end

    par Broadcast copy via room.msg.*
        NATS->>Alice: room.msg.general {broadcast copy}
        Note over Alice: → messagesByRoom (room timeline)
        NATS->>Bob: room.msg.general {broadcast copy}
        NATS->>Carol: room.msg.general {broadcast copy}
    end

    
```

### 3. Room Join (Public Room)

A user joins a public room. Room-service creates a KV entry, publishes a delta, and the browser subscribes to per-room subjects.

```mermaid
sequenceDiagram
    participant Browser as Alice (Browser)
    participant NATS as NATS Server
    participant RoomSvc as Room Service
    participant KV as NATS KV (ROOMS)
    participant Fanout as Fanout Service
    participant Presence as Presence Service

    Browser->>NATS: PUB room.join.general {userId:"alice"}
    NATS->>RoomSvc: room.join.general (queue: room-workers)

    RoomSvc->>RoomSvc: checkRoomAccess("general", "alice")
    Note over RoomSvc: Not in privateRooms map → allow

    RoomSvc->>KV: kv.Create("general.alice", "{}")
    Note over KV: O(1) idempotent, ErrKeyExists → no-op

    RoomSvc->>RoomSvc: mem.add("general", "alice")
    RoomSvc->>NATS: PUB room.changed.general {action:"join", userId:"alice"}

    par Downstream services update caches
        NATS->>Fanout: room.changed.general → LRU cache delta
        NATS->>Presence: room.changed.general → dual-index add
        NATS->>RoomSvc: room.changed.general → forward-index rebuild
    end

    Browser->>NATS: SUB room.msg.general
    Browser->>NATS: SUB room.presence.general

    Browser->>NATS: REQ presence.room.general
    NATS->>Presence: presence.room.general (queue: presence-workers)
    Presence-->>Browser: [{userId:"bob", status:"online"}, ...]

    Note over Browser: Room ready — receiving chat + presence
```

### 4. Room Join (Private Room — Authorization)

Private rooms require DB-backed membership check before allowing join.

```mermaid
sequenceDiagram
    participant Browser as Alice (Browser)
    participant NATS as NATS Server
    participant RoomSvc as Room Service
    participant DB as PostgreSQL
    participant KV as NATS KV (ROOMS)

    Browser->>NATS: PUB room.join.secret-project {userId:"alice"}
    NATS->>RoomSvc: room.join.secret-project (queue: room-workers)

    RoomSvc->>RoomSvc: checkRoomAccess("secret-project", "alice")
    Note over RoomSvc: "secret-project" in privateRooms map → check DB

    RoomSvc->>DB: SELECT type FROM rooms WHERE name = 'secret-project'
    DB-->>RoomSvc: type = 'private'

    RoomSvc->>DB: SELECT COUNT(*) FROM room_members<br/>WHERE room_name = 'secret-project' AND username = 'alice'
    DB-->>RoomSvc: count = 1 (member)

    Note over RoomSvc: Authorized — proceed with join

    RoomSvc->>KV: kv.Create("secret-project.alice", "{}")
    RoomSvc->>RoomSvc: mem.add("secret-project", "alice")
    RoomSvc->>NATS: PUB room.changed.secret-project {action:"join", userId:"alice"}

    Note over Browser: Subscribes to room.msg.secret-project + room.presence.secret-project
```

```mermaid
sequenceDiagram
    participant Browser as Eve (Browser)
    participant NATS as NATS Server
    participant RoomSvc as Room Service
    participant DB as PostgreSQL

    Browser->>NATS: PUB room.join.secret-project {userId:"eve"}
    NATS->>RoomSvc: room.join.secret-project (queue: room-workers)

    RoomSvc->>RoomSvc: checkRoomAccess("secret-project", "eve")
    RoomSvc->>DB: SELECT type FROM rooms WHERE name = 'secret-project'
    DB-->>RoomSvc: type = 'private'
    RoomSvc->>DB: SELECT COUNT(*) FROM room_members<br/>WHERE room_name = 'secret-project' AND username = 'eve'
    DB-->>RoomSvc: count = 0 (not a member)

    Note over RoomSvc: REJECTED — not a member of private room
    Note over Browser: No KV entry created, no room.changed published
```

### 5. Private Room Invite

An owner/admin invites a user. The invitee's browser auto-discovers the room.

```mermaid
sequenceDiagram
    participant Alice as Alice (Browser, owner)
    participant NATS as NATS Server
    participant RoomSvc as Room Service
    participant DB as PostgreSQL
    participant KV as NATS KV (ROOMS)
    participant Fanout as Fanout Service
    participant Bob as Bob (Browser)

    Alice->>NATS: REQ room.invite.secret-project {target:"bob", user:"alice"}
    NATS->>RoomSvc: room.invite.secret-project (queue: room-workers)

    RoomSvc->>DB: SELECT role FROM room_members<br/>WHERE room_name='secret-project' AND username='alice'
    DB-->>RoomSvc: role = 'owner' ✓

    RoomSvc->>DB: INSERT INTO room_members (room_name, username, role, invited_by)<br/>VALUES ('secret-project', 'bob', 'member', 'alice')

    RoomSvc->>KV: kv.Create("secret-project.bob", "{}")
    RoomSvc->>RoomSvc: mem.add("secret-project", "bob")
    RoomSvc->>NATS: PUB room.changed.secret-project {action:"join", userId:"bob"}

    RoomSvc->>NATS: PUB chat.secret-project {user:"__system__", text:"bob was invited by alice"}
    RoomSvc-->>Alice: {ok: true}

    Note over NATS: System message flows through normal fanout pipeline

    NATS->>Fanout: chat.secret-project → PUB room.msg.secret-project
    NATS->>Bob: deliver.bob.chat... (system msg via thread fallback)

    Note over Bob: Auto-discovery: unknown room in unreadCounts
    Bob->>NATS: REQ room.info.secret-project
    NATS->>RoomSvc: room.info.secret-project
    RoomSvc-->>Bob: {name:"secret-project", type:"private", members:[...]}

    Note over Bob: Adds to privateRooms, calls joinRoom()
    Bob->>NATS: SUB room.msg.secret-project
    Bob->>NATS: SUB room.presence.secret-project
```

### 6. Room Kick

An owner/admin removes a user. The removal is atomic (DB + KV + cache in one call chain).

```mermaid
sequenceDiagram
    participant Alice as Alice (Browser, owner)
    participant NATS as NATS Server
    participant RoomSvc as Room Service
    participant DB as PostgreSQL
    participant KV as NATS KV (ROOMS)
    participant Fanout as Fanout Service
    participant Bob as Bob (Browser)

    Alice->>NATS: REQ room.kick.secret-project {target:"bob", user:"alice"}
    NATS->>RoomSvc: room.kick.secret-project (queue: room-workers)

    RoomSvc->>DB: Verify alice is owner/admin ✓
    RoomSvc->>DB: Verify bob is not owner ✓
    RoomSvc->>DB: DELETE FROM room_members WHERE room_name='secret-project' AND username='bob'

    Note over RoomSvc: removeFromRoom() — atomic, no async gap

    RoomSvc->>KV: kv.Delete("secret-project.bob")
    RoomSvc->>RoomSvc: mem.remove("secret-project", "bob")
    RoomSvc->>NATS: PUB room.changed.secret-project {action:"leave", userId:"bob"}

    NATS->>Fanout: room.changed.secret-project → removes bob from LRU cache

    RoomSvc->>NATS: PUB chat.secret-project {user:"__system__", text:"bob was removed by alice"}
    RoomSvc-->>Alice: {ok: true}

    Note over Fanout: Bob is ALREADY removed from delivery list<br/>No async gap where bob could receive messages

    Note over Bob: Next access to channel → room.info shows not a member<br/>UI renders: 🔒 "You are no longer a member"
```

### 7. Presence: Heartbeat → Online Detection → Diff Broadcast

Presence uses two KV buckets and publishes diffs to `room.presence.{room}` (NATS multicast).

```mermaid
sequenceDiagram
    participant Browser as Alice (Browser)
    participant NATS as NATS Server
    participant Presence as Presence Service
    participant ConnKV as NATS KV<br/>(PRESENCE_CONN, 45s TTL)
    participant PresKV as NATS KV<br/>(PRESENCE, no TTL)
    participant Bob as Bob (Browser)

    Note over Browser: Tab opened, connId = "abc123"

    loop Every 10 seconds
        Browser->>NATS: PUB presence.heartbeat {userId:"alice", connId:"abc123"}
        NATS->>Presence: presence.heartbeat (queue: presence-workers)
        Presence->>ConnKV: kv.Put("alice.abc123", "online") [45s TTL refreshed]

        alt First heartbeat (alice was offline)
            Presence->>PresKV: kv.Put("alice", "online")
            Presence->>Presence: userRooms("alice") → ["general", "random", "secret-project"]

            par Publish diff to each room
                Presence->>NATS: PUB room.presence.general {action:"online", userId:"alice", status:"online"}
                Presence->>NATS: PUB room.presence.random {action:"online", userId:"alice", status:"online"}
                Presence->>NATS: PUB room.presence.secret-project {action:"online", userId:"alice", status:"online"}
            end

            par NATS multicasts to room subscribers
                NATS->>Bob: room.presence.general {action:"online", userId:"alice"}
                Note over Bob: setOnlineUsers: add alice to general
            end
        else Subsequent heartbeat (already online)
            Note over Presence: Already online — no diff published
        end
    end
```

### 8. Presence: Tab Close → Offline Detection

```mermaid
sequenceDiagram
    participant Browser as Alice (Browser)
    participant NATS as NATS Server
    participant Presence as Presence Service
    participant ConnKV as NATS KV<br/>(PRESENCE_CONN, 45s TTL)
    participant PresKV as NATS KV<br/>(PRESENCE, no TTL)
    participant Bob as Bob (Browser)

    Note over Browser: Tab closing (beforeunload)

    Browser->>NATS: PUB presence.disconnect {userId:"alice", connId:"abc123"}
    NATS->>Presence: presence.disconnect (queue: presence-workers)

    Presence->>ConnKV: kv.Delete("alice.abc123")
    Presence->>Presence: connTracker.hasAnyConn("alice")?

    alt No other tabs open
        Presence->>PresKV: kv.Put("alice", "offline")
        Presence->>Presence: userRooms("alice") → ["general", "random"]

        par Publish offline diff to each room
            Presence->>NATS: PUB room.presence.general {action:"offline", userId:"alice"}
            Presence->>NATS: PUB room.presence.random {action:"offline", userId:"alice"}
        end

        NATS->>Bob: room.presence.general {action:"offline", userId:"alice"}
        Note over Bob: setOnlineUsers: remove alice from general
    else Another tab still has active heartbeat
        Note over Presence: User still online — no diff published
    end
```

### 9. Presence: Tab Crash (KV TTL Expiry)

```mermaid
sequenceDiagram
    participant ConnKV as NATS KV<br/>(PRESENCE_CONN, 45s TTL)
    participant Presence as Presence Service
    participant PresKV as NATS KV<br/>(PRESENCE, no TTL)
    participant NATS as NATS Server
    participant Bob as Bob (Browser)

    Note over ConnKV: Key "alice.abc123" not refreshed for 45s → EXPIRED

    ConnKV->>Presence: KV Watcher: key="alice.abc123", op=DELETE (TTL expiry)

    Presence->>Presence: connTracker.remove("alice", "abc123")
    Presence->>Presence: connTracker.hasAnyConn("alice")?

    alt No other connections
        Presence->>PresKV: CAS kv.Update("alice", "offline", revision)
        Note over Presence: CAS prevents duplicate offline<br/>if two instances race
        Presence->>Presence: userRooms("alice") → ["general"]

        Presence->>NATS: PUB room.presence.general {action:"offline", userId:"alice"}
        NATS->>Bob: room.presence.general {action:"offline", userId:"alice"}
    end
```

### 10. Status Change (Away/Busy/Online)

```mermaid
sequenceDiagram
    participant Browser as Alice (Browser)
    participant NATS as NATS Server
    participant Presence as Presence Service
    participant PresKV as NATS KV (PRESENCE)
    participant Bob as Bob (Browser)

    Browser->>NATS: PUB presence.update {userId:"alice", status:"away"}
    NATS->>Presence: presence.update (queue: presence-workers)

    Presence->>PresKV: kv.Put("alice", "away")
    Presence->>Presence: userRooms("alice") → ["general", "random"]

    par Publish status diff to each room
        Presence->>NATS: PUB room.presence.general {action:"status", userId:"alice", status:"away"}
        Presence->>NATS: PUB room.presence.random {action:"status", userId:"alice", status:"away"}
    end

    NATS->>Bob: room.presence.general {action:"status", userId:"alice", status:"away"}
    Note over Bob: setOnlineUsers: update alice's status to "away"
```

### 11. DM Message Flow

DMs use canonical room names (`dm-alice-bob`) and flow through the same infrastructure.

```mermaid
sequenceDiagram
    participant Alice as Alice (Browser)
    participant NATS as NATS Server
    participant RoomSvc as Room Service
    participant Fanout as Fanout Service
    participant Bob as Bob (Browser)

    Note over Alice: Initiating DM with bob → room = "dm-alice-bob"

    Alice->>NATS: PUB room.join.dm-alice-bob {userId:"alice"}
    Alice->>NATS: PUB room.join.dm-alice-bob {userId:"bob"}
    Note over Alice: Joins both users (idempotent)

    Alice->>NATS: SUB room.msg.dm-alice-bob
    Alice->>NATS: SUB room.presence.dm-alice-bob

    NATS->>RoomSvc: room.join.dm-alice-bob (×2)
    RoomSvc->>RoomSvc: checkRoomAccess → not in privateRooms → allow
    Note over RoomSvc: KV create for both users

    Alice->>NATS: PUB chat.dm-alice-bob {user:"alice", text:"hey!"}
    NATS->>Fanout: chat.dm-alice-bob (queue: fanout-workers)
    Fanout->>NATS: PUB room.msg.dm-alice-bob {same payload}

    NATS->>Alice: room.msg.dm-alice-bob
    NATS->>Bob: room.msg.dm-alice-bob
    Note over Bob: If not subscribed yet, message arrives<br/>via deliver.bob.> → auto-discovers DM room
```

### 12. Reconnection Flow

When the NATS WebSocket reconnects, the browser re-joins all rooms and re-subscribes.

```mermaid
sequenceDiagram
    participant Browser as Browser (MessageProvider)
    participant NATS as NATS Server
    participant RoomSvc as Room Service

    Note over Browser: NATS connection dropped and reconnected

    Browser->>Browser: previousRooms = copy of joinedRoomsRef
    Browser->>Browser: Clear roomSubsRef + joinedRoomsRef

    loop For each room in previousRooms
        Browser->>NATS: PUB room.join.{room} {userId}
        Browser->>NATS: SUB room.msg.{room}
        Browser->>NATS: SUB room.presence.{room}
        Browser->>Browser: joinedRoomsRef.add(room)
    end

    Browser->>NATS: SUB deliver.{userId}.>
    Browser->>NATS: PUB presence.heartbeat {userId, connId}

    Note over Browser: All subscriptions restored,<br/>server-side membership re-registered
```

### 13. Room Creation (Private Room)

```mermaid
sequenceDiagram
    participant Alice as Alice (Browser)
    participant NATS as NATS Server
    participant RoomSvc as Room Service
    participant DB as PostgreSQL
    participant KV as NATS KV (ROOMS)
    participant Fanout as Fanout Service

    Alice->>NATS: REQ room.create {name:"engineering", displayName:"Engineering", user:"alice"}
    NATS->>RoomSvc: room.create (queue: room-workers)

    RoomSvc->>DB: BEGIN
    RoomSvc->>DB: INSERT INTO rooms (name, display_name, creator, type)<br/>VALUES ('engineering', 'Engineering', 'alice', 'private')
    RoomSvc->>DB: INSERT INTO room_members (room_name, username, role)<br/>VALUES ('engineering', 'alice', 'owner')
    RoomSvc->>DB: COMMIT

    RoomSvc->>RoomSvc: privateRooms["engineering"] = true

    Note over RoomSvc: addToRoom() — atomic helper

    RoomSvc->>KV: kv.Create("engineering.alice", "{}")
    RoomSvc->>RoomSvc: mem.add("engineering", "alice")
    RoomSvc->>NATS: PUB room.changed.engineering {action:"join", userId:"alice"}

    NATS->>Fanout: room.changed.engineering → LRU cache updated

    RoomSvc->>NATS: PUB chat.engineering {user:"__system__", text:"alice created the room"}
    RoomSvc-->>Alice: {name:"engineering", type:"private", creator:"alice"}

    Alice->>NATS: SUB room.msg.engineering
    Alice->>NATS: SUB room.presence.engineering
```

### 14. Room Departure (Voluntary Leave with Ownership Transfer)

```mermaid
sequenceDiagram
    participant Alice as Alice (Browser, owner)
    participant NATS as NATS Server
    participant RoomSvc as Room Service
    participant DB as PostgreSQL
    participant KV as NATS KV (ROOMS)

    Alice->>NATS: REQ room.depart.engineering {user:"alice"}
    NATS->>RoomSvc: room.depart.engineering (queue: room-workers)

    RoomSvc->>DB: SELECT role FROM room_members<br/>WHERE room_name='engineering' AND username='alice'
    DB-->>RoomSvc: role = 'owner'

    RoomSvc->>DB: SELECT username, role FROM room_members<br/>WHERE room_name='engineering' AND username != 'alice'<br/>ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, joined_at
    DB-->>RoomSvc: [{username:"bob", role:"admin"}]

    RoomSvc->>DB: UPDATE room_members SET role='owner'<br/>WHERE room_name='engineering' AND username='bob'
    Note over RoomSvc: Ownership transferred to bob

    RoomSvc->>DB: DELETE FROM room_members<br/>WHERE room_name='engineering' AND username='alice'

    Note over RoomSvc: removeFromRoom() — atomic

    RoomSvc->>KV: kv.Delete("engineering.alice")
    RoomSvc->>RoomSvc: mem.remove("engineering", "alice")
    RoomSvc->>NATS: PUB room.changed.engineering {action:"leave", userId:"alice"}

    RoomSvc->>NATS: PUB chat.engineering {user:"__system__", text:"alice left the room"}
    RoomSvc-->>Alice: {ok: true}

    Alice->>NATS: UNSUB room.msg.engineering
    Alice->>NATS: UNSUB room.presence.engineering
    Note over Alice: UI switches to "general"
```

---

## Data Model

### Unified Room Entity

```sql
CREATE TABLE rooms (
    name         TEXT PRIMARY KEY,
    display_name TEXT,
    creator      TEXT NOT NULL,
    type         TEXT NOT NULL DEFAULT 'private',  -- public | private | dm
    created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE room_members (
    room_name    TEXT NOT NULL REFERENCES rooms(name) ON DELETE CASCADE,
    username     TEXT NOT NULL,
    role         TEXT NOT NULL DEFAULT 'member',  -- owner | admin | member
    invited_by   TEXT,
    joined_at    TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (room_name, username)
);
```

### NATS KV (ROOMS Bucket)

```
Bucket: ROOMS (FileStorage, History: 1)
Key:    {room}.{userId} → {}

general.alice → {}
secret-project.bob → {}
dm-alice-bob.alice → {}
```

### In-Memory State (Room Service)

| Structure | Type | Source | Purpose |
|---|---|---|---|
| `localMembership` | `map[string]map[string]bool` | KV hydration + `room.changed.*` deltas | O(1) `room.members.*` responses |
| `privateRooms` | `map[string]bool` | `SELECT name FROM rooms WHERE type='private'` at startup | O(1) authorization check in `room.join.*` |

---

## NATS Subject Reference

### Room Management (request/reply, QG: room-workers)

| Subject | Payload | Response |
|---|---|---|
| `room.create` | `{name, displayName, user}` | `RoomInfo` or `{error}` |
| `room.list` | `{user}` | `RoomInfo[]` |
| `room.info.*` | _(empty)_ | `RoomInfo` with `members[]` |
| `room.invite.*` | `{target, user}` | `{ok: true}` or `{error}` |
| `room.kick.*` | `{target, user}` | `{ok: true}` or `{error}` |
| `room.depart.*` | `{user}` | `{ok: true}` or `{error}` |

### Room Membership (pub/sub)

| Subject | QG | Payload | Publisher |
|---|---|---|---|
| `room.join.*` | `room-workers` | `{userId}` | Browser |
| `room.leave.*` | `room-workers` | `{userId}` | Browser (tab close) |
| `room.changed.*` | _(none)_ | `{action, userId}` | Room Service |
| `room.members.*` | `room-members-workers` | _(request/reply)_ | Fanout (cache miss) |

### Chat Messages

| Subject | Captured by | Delivered via |
|---|---|---|
| `chat.{room}` | JetStream + Fanout | `room.msg.{room}` (multicast) |
| `chat.{room}.thread.{threadId}` | JetStream + Fanout | `deliver.{userId}.chat.{room}.thread.{threadId}` |
| `admin.{room}` | JetStream + Fanout | `deliver.{userId}.admin.{room}` |

### Presence

| Subject | QG | Payload |
|---|---|---|
| `presence.heartbeat` | `presence-workers` | `{userId, connId}` |
| `presence.disconnect` | `presence-workers` | `{userId, connId}` |
| `presence.update` | `presence-workers` | `{userId, status}` |
| `presence.room.*` | `presence-workers` | _(request/reply → `PresenceMember[]`)_ |
| `room.presence.*` | _(none, multicast)_ | `{action, userId, status?}` |

---

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Main chat delivery | Per-room multicast (`room.msg.*`) | Eliminates O(members) publish amplification; NATS kernel-level sendmsg |
| Thread delivery | Per-user (`deliver.{userId}.*`) | Lower volume; needs per-user subject for MessageProvider routing |
| Presence delivery | Per-room multicast (`room.presence.*`) | Diffs are tiny (~50 bytes); multicast avoids N-copy overhead |
| Presence format | Diff events (`{action, userId, status}`) | O(1) payload vs O(members) full snapshot; client applies incrementally |
| Initial presence | Request/reply (`presence.room.*`) | Full snapshot needed once on room join; subsequent updates via diffs |
| Private room auth | DB query in `room.join.*` handler | Replaces NATS `channel.check.*` round-trip; fail-open on DB error |
| Room mutations | `addToRoom()`/`removeFromRoom()` helpers | Atomic KV + cache + delta — no async gap for race conditions |
| DM rooms | Canonical `dm-{sorted-users}` naming | Reuses all room infrastructure with zero special-casing |
| Unified type field | `rooms.type` enum (public/private/dm) | Replaces `is_private` boolean; extensible for future room types |
