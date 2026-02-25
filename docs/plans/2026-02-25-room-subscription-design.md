# Room Subscription Design

Consolidated design document for the unified room model and two-stream message delivery architecture. Covers all message delivery paths with sequence diagrams.

## Architecture Overview

The system uses a **two-stream model** separating notification metadata from message content, combined with per-room presence multicast:

| Stream | Subject pattern | Content | Mechanism | Used for |
|---|---|---|---|---|
| **Ingest** (user → system) | `deliver.{userId}.send.{room}[.thread.{threadId}]` | Full message | Scoped publish, fanout validates + republishes to `chat.>` | All user messages |
| **Notification** (system → user) | `room.notify.{room}` | Metadata only (notifyId, action, user, timestamp) | NATS multicast | Public room notifications |
| **Notification** (system → user) | `deliver.{userId}.notify.{room}` | Metadata only | Per-user delivery | Private/DM room notifications |
| **Content fetch** | `msg.get` | Full message | Request/reply, capability-based (unpredictable notifyId) | On-demand content retrieval |
| **Presence** | `room.presence.{room}` | Diffs (action, userId, status) | NATS multicast | Presence changes |
| **Per-user delivery** | `deliver.{userId}.admin.{room}` | Full message | Fanout service N-copy | Admin messages |
| **Per-user delivery** | `deliver.{userId}.translate.response` | Streaming chunks | Direct publish | Translation streaming |
| **Per-user delivery** | `deliver.{userId}.app.{appId}.{room}.{event}` | App data | Fanout service N-copy | Room app events |

### Security Model

The two-stream model provides defense-in-depth for private/DM rooms:

1. **Ingest validation**: Users publish to `deliver.{userId}.send.>` (NATS auth scopes this per-user). Fanout-service validates sender identity (subject userId must match payload user) and room membership before republishing to `chat.>`.
2. **Notification routing**: Public rooms use multicast (`room.notify.{room}`). Private/DM rooms use per-user delivery (`deliver.{userId}.notify.{room}`), hiding even metadata from non-members.
3. **Capability-based content fetch**: NotifyIds contain crypto-random tokens (`{room}.{seq}.{instanceId}.{randomHex}`). Knowing the notifyId IS the authorization — no user identity in the request.
4. **Fail-closed membership check**: Ingest membership validation returns `false` when room-service is unavailable (denies on uncertainty).

### Browser Subscriptions per User

```
deliver.{userId}.>                     # 1 wildcard (notifications, admin, translate, apps)
room.notify.{room₁}                   # N per-room (public room notifications)
room.notify.{room₂}
...
room.presence.{room₁}                 # N per-room (presence diffs)
room.presence.{room₂}
...
_INBOX.>                               # 1 wildcard (request/reply)
```

Total: `2N + 2` subscriptions where N = number of joined rooms.

Private/DM room notifications arrive via the `deliver.{userId}.>` wildcard — no additional per-room subscription needed.

---

## Sequence Diagrams

### 1. Regular Chat Message (Two-Stream: Notify + Fetch)

A user sends a message in a public room. The fanout service validates, persists via JetStream, caches the content, and publishes a lightweight notification. Browsers fetch content on demand.

```mermaid
sequenceDiagram
    participant Alice as Alice (Browser)
    participant NATS as NATS Server
    participant Fanout as Fanout Service
    participant JS as JetStream
    participant Cache as MSG_CACHE KV
    participant Persist as Persist Worker
    participant Bob as Bob (Browser)

    Note over Alice,Bob: Alice, Bob subscribed to room.notify.general

    Alice->>NATS: PUB deliver.alice.send.general {user:"alice", text:"hello", timestamp:T}
    NATS->>Fanout: deliver.alice.send.general (queue: fanout-workers)

    Note over Fanout: Validate: subject userId == payload user ✓
    Note over Fanout: Validate: checkMembership("general", "alice") ✓

    Fanout->>NATS: PUB chat.general {user:"alice", text:"hello", timestamp:T}

    par Fanout processes notification
        NATS->>Fanout: chat.general (queue: fanout-workers)
        Fanout->>Cache: kv.Put("general.42.a1b2.c3d4e5f6", fullMessage)
        Fanout->>NATS: PUB room.notify.general {notifyId:"general.42.a1b2.c3d4e5f6", action:"message", user:"alice"}
        Note over Fanout: Notification contains NO message text
    and JetStream captures for persistence
        NATS->>JS: chat.general → CHAT_MESSAGES stream
        JS->>Persist: Consumer delivers message
        Persist->>Persist: INSERT INTO messages (room, user, text, timestamp)
    end

    par Browsers receive notification + fetch content
        NATS->>Alice: room.notify.general {notifyId:..., action:"message"}
        Alice->>NATS: REQ msg.get {notifyId:"general.42.a1b2.c3d4e5f6", room:"general"}
        NATS->>Fanout: msg.get (queue: msg-get-workers)
        Fanout->>Cache: kv.Get("general.42.a1b2.c3d4e5f6")
        Fanout-->>Alice: {user:"alice", text:"hello", timestamp:T}
    and
        NATS->>Bob: room.notify.general {notifyId:..., action:"message"}
        Bob->>NATS: REQ msg.get {notifyId:..., room:"general"}
        Fanout-->>Bob: {user:"alice", text:"hello", timestamp:T}
    end
```

### 2. Private Room Message (Per-User Notification Delivery)

Private room messages use per-user notification delivery. Non-members never see even the notification metadata.

```mermaid
sequenceDiagram
    participant Alice as Alice (Browser)
    participant NATS as NATS Server
    participant Fanout as Fanout Service
    participant Cache as MSG_CACHE KV
    participant Bob as Bob (Browser)
    participant Eve as Eve (Non-member)

    Note over Alice,Eve: Alice and Bob are members of "secret-project"
    Note over Alice,Eve: Eve is NOT a member

    Alice->>NATS: PUB deliver.alice.send.secret-project {user:"alice", text:"classified"}
    NATS->>Fanout: deliver.alice.send.secret-project (ingest)
    Note over Fanout: checkMembership("secret-project", "alice") ✓
    Fanout->>NATS: PUB chat.secret-project {full message}

    NATS->>Fanout: chat.secret-project (notify handler)
    Note over Fanout: isPrivateRoom("secret-project") → true
    Fanout->>Fanout: getMembers("secret-project") → [alice, bob]
    Fanout->>Cache: kv.Put(notifyId, fullMessage)

    par Per-user notification delivery (only members)
        Fanout->>NATS: PUB deliver.alice.notify.secret-project {notifyId:..., action:"message"}
        Fanout->>NATS: PUB deliver.bob.notify.secret-project {notifyId:..., action:"message"}
    end

    Note over Eve: Eve receives NOTHING — no notification,<br/>no metadata, no content

    par Members fetch content via msg.get
        NATS->>Alice: deliver.alice.notify.secret-project
        Alice->>NATS: REQ msg.get {notifyId:...}
        Fanout-->>Alice: {user:"alice", text:"classified"}
    and
        NATS->>Bob: deliver.bob.notify.secret-project
        Bob->>NATS: REQ msg.get {notifyId:...}
        Fanout-->>Bob: {user:"alice", text:"classified"}
    end
```

### 3. Thread Reply

Thread replies flow through the same two-stream model. Optional broadcast sends a second copy to the room timeline.

```mermaid
sequenceDiagram
    participant Alice as Alice (Browser)
    participant NATS as NATS Server
    participant Fanout as Fanout Service
    participant Bob as Bob (Browser)

    Note over Alice,Bob: Alice replies in thread with "Also send to room" checked

    Alice->>NATS: PUB deliver.alice.send.general.thread.general-12345 {text:"reply", broadcast:true}
    Alice->>NATS: PUB deliver.alice.send.general {text:"reply", broadcast:true, threadId:"general-12345"}

    par Thread notification
        NATS->>Fanout: chat.general.thread.general-12345
        Fanout->>NATS: PUB room.notify.general {notifyId:..., action:"message", threadId:"general-12345"}
    and Broadcast notification (room timeline)
        NATS->>Fanout: chat.general
        Fanout->>NATS: PUB room.notify.general {notifyId:..., action:"message"}
    end

    par Browsers fetch content on demand
        NATS->>Alice: room.notify.general (thread notification)
        Alice->>NATS: REQ msg.get {notifyId:...}
        Note over Alice: → threadMessagesByThreadId + room timeline
        NATS->>Bob: room.notify.general
        Bob->>NATS: REQ msg.get {notifyId:...}
    end
```

### 4. Room Join (Public Room)

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
        NATS->>Fanout: room.changed.general → LRU cache delta + roomTypes update
        NATS->>Presence: room.changed.general → dual-index add
        NATS->>RoomSvc: room.changed.general → forward-index rebuild
    end

    Browser->>NATS: SUB room.notify.general
    Browser->>NATS: SUB room.presence.general

    Browser->>NATS: REQ presence.room.general
    NATS->>Presence: presence.room.general (queue: presence-workers)
    Presence-->>Browser: [{userId:"bob", status:"online"}, ...]

    Note over Browser: Room ready — receiving notifications + presence
```

### 5. Room Join (Private Room — Authorization)

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

    Note over Browser: Subscribes to room.notify.secret-project + room.presence.secret-project
    Note over Browser: Private room notifications also arrive via deliver.alice.notify.secret-project
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

### 6. Private Room Invite

An owner/admin invites a user. The invitee receives a notification via per-user delivery.

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
    RoomSvc->>NATS: PUB room.changed.secret-project {action:"join", userId:"bob", type:"private"}

    RoomSvc->>NATS: PUB chat.secret-project {user:"__system__", text:"bob was invited by alice"}
    RoomSvc-->>Alice: {ok: true}

    Note over NATS: System message → fanout → per-user notification (private room)

    NATS->>Fanout: chat.secret-project → per-user delivery
    Fanout->>NATS: PUB deliver.bob.notify.secret-project {notifyId:..., action:"system"}

    Note over Bob: Notification arrives via deliver.bob.>
    Bob->>NATS: REQ room.info.secret-project
    NATS->>RoomSvc: room.info.secret-project
    RoomSvc-->>Bob: {name:"secret-project", type:"private", members:[...]}

    Note over Bob: Adds to privateRooms, calls joinRoom()
    Bob->>NATS: SUB room.notify.secret-project
    Bob->>NATS: SUB room.presence.secret-project
```

### 7. Room Kick

An owner/admin removes a user. The removal is atomic (DB + KV + cache in one call chain). Per-user delivery ensures the kicked user stops receiving notifications immediately.

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

    Note over Fanout: Bob is ALREADY removed from member list<br/>Per-user delivery will NOT include bob for future messages
```

### 8. Presence: Heartbeat → Online Detection → Diff Broadcast

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

### 9. Presence: Tab Close → Offline Detection

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

### 10. Presence: Tab Crash (KV TTL Expiry)

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

### 11. Status Change (Away/Busy/Online)

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

### 12. DM Message Flow

DMs use canonical room names (`dm-alice-bob`) and per-user notification delivery (same as private rooms).

```mermaid
sequenceDiagram
    participant Alice as Alice (Browser)
    participant NATS as NATS Server
    participant RoomSvc as Room Service
    participant Fanout as Fanout Service
    participant Cache as MSG_CACHE KV
    participant Bob as Bob (Browser)

    Note over Alice: Initiating DM with bob → room = "dm-alice-bob"

    Alice->>NATS: PUB room.join.dm-alice-bob {userId:"alice"}
    Alice->>NATS: PUB room.join.dm-alice-bob {userId:"bob"}
    Note over Alice: Joins both users (idempotent)

    Alice->>NATS: SUB room.notify.dm-alice-bob
    Alice->>NATS: SUB room.presence.dm-alice-bob

    NATS->>RoomSvc: room.join.dm-alice-bob (×2)
    RoomSvc->>RoomSvc: checkRoomAccess → not in privateRooms → allow

    Alice->>NATS: PUB deliver.alice.send.dm-alice-bob {user:"alice", text:"hey!"}
    NATS->>Fanout: deliver.alice.send.dm-alice-bob (ingest)
    Fanout->>NATS: PUB chat.dm-alice-bob {user:"alice", text:"hey!"}

    NATS->>Fanout: chat.dm-alice-bob (notify handler)
    Note over Fanout: isDM("dm-alice-bob") → true → per-user delivery
    Fanout->>Cache: kv.Put(notifyId, fullMessage)
    Fanout->>NATS: PUB deliver.alice.notify.dm-alice-bob {notifyId:...}
    Fanout->>NATS: PUB deliver.bob.notify.dm-alice-bob {notifyId:...}

    NATS->>Alice: deliver.alice.notify.dm-alice-bob
    Alice->>NATS: REQ msg.get {notifyId:...}
    Fanout-->>Alice: {user:"alice", text:"hey!"}

    NATS->>Bob: deliver.bob.notify.dm-alice-bob
    Note over Bob: Auto-discovers DM room from notification
```

### 13. Reconnection Flow

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
        Browser->>NATS: SUB room.notify.{room}
        Browser->>NATS: SUB room.presence.{room}
        Browser->>Browser: joinedRoomsRef.add(room)
    end

    Browser->>NATS: SUB deliver.{userId}.>
    Browser->>NATS: PUB presence.heartbeat {userId, connId}

    Note over Browser: All subscriptions restored,<br/>server-side membership re-registered
```

### 14. Room Creation (Private Room)

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
    RoomSvc->>NATS: PUB room.changed.engineering {action:"join", userId:"alice", type:"private"}

    NATS->>Fanout: room.changed.engineering → LRU cache + roomTypes updated

    RoomSvc->>NATS: PUB chat.engineering {user:"__system__", text:"alice created the room"}
    RoomSvc-->>Alice: {name:"engineering", type:"private", creator:"alice"}

    Alice->>NATS: SUB room.notify.engineering
    Alice->>NATS: SUB room.presence.engineering
```

### 15. Room Departure (Voluntary Leave with Ownership Transfer)

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

    Alice->>NATS: UNSUB room.notify.engineering
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

### NATS KV

```
Bucket: ROOMS (FileStorage, History: 1)
Key:    {room}.{userId} → {}

general.alice → {}
secret-project.bob → {}
dm-alice-bob.alice → {}

Bucket: MSG_CACHE (MemoryStorage, TTL: 5m, History: 1)
Key:    {room}.{seq}.{instanceId}.{randomHex} → full message JSON
Purpose: Temporary cache for two-stream content fetch via msg.get
```

### In-Memory State (Room Service)

| Structure | Type | Source | Purpose |
|---|---|---|---|
| `localMembership` | `map[string]map[string]bool` | KV hydration + `room.changed.*` deltas | O(1) `room.members.*` responses |
| `privateRooms` | `map[string]bool` | `SELECT name FROM rooms WHERE type='private'` at startup | O(1) authorization check in `room.join.*` |

### In-Memory State (Fanout Service)

| Structure | Type | Source | Purpose |
|---|---|---|---|
| LRU cache | `lruCache` (room → member set) | `room.members.*` RPC + `room.changed.*` deltas | O(1) membership check, member list for per-user delivery |
| `roomTypes` | `map[string]string` | `room.changed.*` delta events (Type field) | Determine notification routing (multicast vs per-user) |
| `notifySeq` | `atomic.Int64` | Per-instance monotonic counter | Part of notifyId generation |
| `instanceId` | `string` | `randomHex(4)` at startup | Part of notifyId — avoids collision across instances |

---

## NATS Subject Reference

### Ingest (user → system, QG: fanout-workers)

| Subject | Payload | Handler |
|---|---|---|
| `deliver.{userId}.send.{room}` | Full chat message | Validate sender + membership, republish to `chat.{room}` |
| `deliver.{userId}.send.{room}.thread.{threadId}` | Full thread reply | Same as above, republish to `chat.{room}.thread.{threadId}` |

### Notification (system → user)

| Subject | Payload | Routing |
|---|---|---|
| `room.notify.{room}` | `{notifyId, room, action, user, timestamp, threadId?, emoji?, targetUser?}` | NATS multicast (public rooms only) |
| `deliver.{userId}.notify.{room}` | Same notification format | Per-user delivery (private/DM rooms) |

### Content Fetch (request/reply, QG: msg-get-workers)

| Subject | Request | Response |
|---|---|---|
| `msg.get` | `{notifyId, room}` | Full message JSON or `{error}` |

### Chat Messages (internal — JetStream captured)

| Subject | Published by | Consumed by |
|---|---|---|
| `chat.{room}` | Fanout ingest handler | Fanout notify handler + JetStream → persist-worker |
| `chat.{room}.thread.{threadId}` | Fanout ingest handler | Fanout notify handler + JetStream → persist-worker |
| `admin.{room}` | Backend services | Fanout → `deliver.{userId}.admin.{room}` |

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
| `room.changed.*` | _(none)_ | `{action, userId, type?}` | Room Service |
| `room.members.*` | `room-members-workers` | _(request/reply)_ | Fanout (cache miss) |

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
| Message delivery | Two-stream: notification ID + content fetch | Notifications never contain message text; content retrieval is capability-gated |
| Ingest path | `deliver.{userId}.send.>` | NATS auth scopes publish per-user; fanout validates sender identity from subject |
| Public room notifications | Per-room multicast (`room.notify.*`) | Eliminates O(members) publish amplification; NATS kernel-level sendmsg |
| Private/DM room notifications | Per-user delivery (`deliver.{userId}.notify.*`) | Hides even notification metadata from non-members |
| Content authorization | Capability-based (unpredictable notifyId) | No forgeable user identity; knowing the notifyId = proof of notification receipt |
| NotifyId format | `{room}.{seq}.{instanceId}.{randomHex}` | Instance ID avoids cross-replica collision; random token prevents enumeration |
| MSG_CACHE storage | MemoryStorage, 5min TTL | Ephemeral cache — messages are persisted to PostgreSQL via JetStream independently |
| Membership check failure | Fail-closed (deny) | Rejects ingest when room-service is unavailable; security over availability |
| Room type tracking | `roomTypes` map from `room.changed.*` deltas | Fanout-service decides delivery path (multicast vs per-user) without DB access |
| Presence delivery | Per-room multicast (`room.presence.*`) | Diffs are tiny (~50 bytes); multicast avoids N-copy overhead |
| Presence format | Diff events (`{action, userId, status}`) | O(1) payload vs O(members) full snapshot; client applies incrementally |
| Initial presence | Request/reply (`presence.room.*`) | Full snapshot needed once on room join; subsequent updates via diffs |
| Private room auth | DB query in `room.join.*` handler | Local function call, no NATS round-trip; fail-open on DB error |
| Room mutations | `addToRoom()`/`removeFromRoom()` helpers | Atomic KV + cache + delta — no async gap for race conditions |
| DM rooms | Canonical `dm-{sorted-users}` naming | Reuses all room infrastructure with zero special-casing |
| Unified type field | `rooms.type` enum (public/private/dm) | Replaces `is_private` boolean; extensible for future room types |
| Message dedup | Synchronous ref-based `timestamp+user` guard | Prevents duplicate display and unread count increments during token refresh reconnections |

---

## Message Deduplication

### Problem

During Keycloak token refresh (every 30s), the NATS WebSocket connection is replaced. There is a brief window where both the old and new connections have active subscriptions to `room.notify.{room}`. Notifications arriving during this overlap are processed twice, causing duplicate content fetches, display, and double-counting of unread notifications.

### Solution

MessageProvider applies a **synchronous dedup guard** before processing each incoming message. The guard checks `messagesByRoomRef.current` (a React ref mirroring the latest state) for an existing message with the same `timestamp + user` combination.

```
Incoming notification on room.notify.{room}:

1. Fetch content via msg.get (notifyId → full message)
2. isDup = messagesByRoomRef.current[room].some(
     m => m.timestamp === data.timestamp && m.user === data.user
   )
3. if (isDup) return;             ← skip ALL processing (no state updates, no unread increment)
4. setMessagesByRoom(...)         ← add to room timeline
5. Update unread counts           ← only runs if not a duplicate
```

**Critical detail:** The dedup check uses a synchronous ref (`messagesByRoomRef.current`), not an async state setter callback. This ensures the unread count increment (step 5) is also skipped for duplicates.

### Dedup Scope

| Message type | Dedup key | Location |
|---|---|---|
| Room messages (`room.notify.*` / `deliver.*.notify.*`) | `timestamp + user` | Synchronous guard in `processRoomChatMessage` before `setMessagesByRoom` |
| Thread messages (via notification fetch) | `timestamp + user` | Inside `setThreadMessagesByThreadId` setter (no unread tracking for threads) |
| Admin messages (`deliver.*.admin.*`) | `timestamp + user` | Synchronous guard before `setMessagesByRoom` |

---

## Known Limitations

### Presence metadata leakage for private rooms

Presence-service publishes `room.presence.{room}` for all rooms via NATS multicast. Since browsers subscribe to `room.presence.*`, a non-member could subscribe to `room.presence.{privateRoom}` and observe who is online. This is a separate concern from the two-stream model and requires presence-service changes to route private room presence via per-user delivery. Tracked as a follow-up.
