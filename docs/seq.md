# NATS Chat Keycloak - Sequence Diagrams

## Table of Contents

1. [User Login Flow](#1-user-login-flow)
2. [Message Sending Flow](#2-message-sending-flow)
3. [Message Delivery Flow (Public Room)](#3-message-delivery-flow-public-room)
4. [Message Delivery Flow (Private Room)](#4-message-delivery-flow-private-room)
5. [Room Join/Leave Flow](#5-room-joinleave-flow)
6. [Presence Tracking Flow](#6-presence-tracking-flow)
7. [Translation Service Flow](#7-translation-service-flow)
8. [App Integration Flow](#8-app-integration-flow)
9. [Service Startup Flow](#9-service-startup-flow)

---

## 1. User Login Flow

```mermaid
sequenceDiagram
    participant B as Browser
    participant K as Keycloak
    participant A as Auth-Service
    participant N as NATS

    B->>K: GET /auth/realms/nats-chat/protocol/openid-connect/auth
    K->>B: Redirect to login page
    B->>K: POST /auth/realms/nats-chat/login
    K->>B: Redirect with authorization code
    B->>K: POST /auth/realms/nats-chat/protocol/openid-connect/token
    K->>B: Access token + refresh token

    B->>N: WebSocket CONNECT (token as password)
    N->>A: $SYS.REQ.USER.AUTH (auth callout)
    A->>K: GET /realms/nats-chat/protocol/openid-connect/certs
    K->>A: JWKS public keys
    A->>A: Validate JWT + extract roles
    A->>A: Map roles → scoped permissions
    A->>N: Signed JWT with permissions
    N->>B: Connection accepted

    Note over B: Store token in AuthProvider
    Note over B: Initialize NatsProvider
    Note over B: Subscribe to deliver.{userId}.>
```

---

## 2. Message Sending Flow

```mermaid
sequenceDiagram
    participant B as Browser
    participant N as NATS
    participant F as Fanout-Service
    participant R as Room-Service
    participant P as Persist-Worker
    participant DB as PostgreSQL
    participant KV as MSG_CACHE
    participant RL as RATE_LIMIT_KV

    B->>B: Build message payload
    B->>N: publish deliver.{userId}.send.{room}
    Note over N: Subject matches user permissions

    N->>F: Message received (fanout-workers QG)
    
    F->>RL: Check rate limit (sliding window)
    alt Rate limit exceeded
        RL->>F: Limit exceeded
        F->>B: Rate limit rejection
    else KV unavailable (circuit breaker open)
        RL->>F: Circuit breaker tripped
        alt Fallback = allow
            F->>F: Allow message with warning
        else Fallback = block
            F->>B: Rate limit service unavailable
        end
    else Rate limit OK
        RL->>F: Allow
        F->>RL: Increment counter
    end
    
    F->>R: request room.members.{room}
    R->>F: Member list (or error)
    
    alt Validation passes
        F->>F: Check userId matches payload.user
        F->>F: Check user in member list
        F->>N: publish chat.{room}
        Note over N: JetStream captures in CHAT_MESSAGES stream
    else Validation fails
        F->>B: Rejection notification
    end

    N->>P: Consume from CHAT_MESSAGES stream
    P->>DB: INSERT INTO messages
    P->>N: ACK (stream acknowledgment)

    F->>KV: Put message content (TTL=5min)
    F->>F: Build notification (notifyId only)
    
    alt Public room
        F->>N: publish room.notify.{room}
        Note over N: NATS multicast to all subscribers
    else Private room
        loop For each member
            F->>N: publish deliver.{userId}.notify.{room}
        end
    end

    N->>B: Notification received
    B->>N: request msg.get {notifyId}
    N->>F: msg.get request
    F->>KV: Get message content
    F->>B: Full message content
```

---

## 3. Message Delivery Flow (Public Room)

```mermaid
sequenceDiagram
    participant B1 as Browser (Alice)
    participant B2 as Browser (Bob)
    participant N as NATS
    participant F as Fanout-Service
    participant KV as MSG_CACHE

    B1->>N: publish deliver.alice.send.general
    N->>F: Message received
    
    F->>F: Validate + process
    F->>N: publish chat.general
    F->>KV: Store message content
    F->>N: publish room.notify.general

    Note over N: NATS kernel multicasts to all subscribers

    N->>B1: room.notify.general {notifyId}
    N->>B2: room.notify.general {notifyId}

    par Content fetch (Alice)
        B1->>N: request msg.get {notifyId}
        N->>F: Forward request
        F->>KV: Lookup content
        F->>B1: Message content
    and Content fetch (Bob)
        B2->>N: request msg.get {notifyId}
        N->>F: Forward request
        F->>KV: Lookup content
        F->>B2: Message content
    end

    Note over B1,B2: Both browsers receive same message
    Note over N: Single publish, N subscribers receive
```

---

## 4. Message Delivery Flow (Private Room)

```mermaid
sequenceDiagram
    participant B1 as Browser (Alice)
    participant B2 as Browser (Bob)
    participant B3 as Browser (Charlie - not member)
    participant N as NATS
    participant F as Fanout-Service
    participant R as Room-Service
    participant KV as MSG_CACHE

    B1->>N: publish deliver.alice.send.private-room
    N->>F: Message received
    
    F->>R: request room.members.private-room
    R->>F: [alice, bob]

    F->>F: Validate alice is member
    F->>N: publish chat.private-room
    F->>KV: Store message content

    Note over F: Per-user delivery for private rooms
    F->>N: publish deliver.alice.notify.private-room
    F->>N: publish deliver.bob.notify.private-room

    N->>B1: deliver.alice.notify.private-room
    N->>B2: deliver.bob.notify.private-room
    Note over B3: Charlie receives nothing (not subscribed)

    par Content fetch (Alice)
        B1->>N: request msg.get {notifyId}
        N->>F: Forward request
        F->>KV: Lookup content
        F->>B1: Message content
    and Content fetch (Bob)
        B2->>N: request msg.get {notifyId}
        N->>F: Forward request
        F->>KV: Lookup content
        F->>B2: Message content
    end

    Note over B3: Charlie never sees message or notification
```

---

## 5. Room Join/Leave Flow

```mermaid
sequenceDiagram
    participant B as Browser
    participant N as NATS
    participant R as Room-Service
    participant P as Presence-Service
    participant F as Fanout-Service
    participant KV as ROOMS_KV

    Note over B: === JOIN FLOW ===
    
    B->>N: publish room.join.{room}
    Note over N: Queue group: room-workers
    N->>R: room.join.{room}

    alt Private room
        R->>R: Check room type
        R->>R: Query DB for membership
    end

    R->>KV: Create {room}.{userId}
    Note over KV: O(1) idempotent operation
    R->>N: publish room.changed.{room} {action:join, userId}

    par Presence update
        N->>P: room.changed.{room}
        P->>P: Update dual-index
        P->>P: Build presence diff
        P->>N: publish room.presence.{room} {action:online, userId}
    and Fanout update
        N->>F: room.changed.{room}
        F->>F: Update LRU cache
    end

    B->>N: subscribe room.notify.{room}
    B->>N: subscribe room.presence.{room}
    B->>P: request presence.room.{room}
    P->>B: Current presence state

    Note over B: === LEAVE FLOW ===

    B->>N: unsubscribe room.notify.{room}
    B->>N: unsubscribe room.presence.{room}
    
    B->>N: publish room.leave.{room}
    N->>R: room.leave.{room}

    R->>KV: Delete {room}.{userId}
    Note over KV: O(1) operation
    R->>N: publish room.changed.{room} {action:leave, userId}

    par Presence update
        N->>P: room.changed.{room}
        P->>P: Update dual-index
        P->>N: publish room.presence.{room} {action:offline, userId}
    and Fanout update
        N->>F: room.changed.{room}
        F->>F: Update LRU cache
    end
```

---

## 6. Presence Tracking Flow

```mermaid
sequenceDiagram
    participant B as Browser (Tab)
    participant N as NATS
    participant P as Presence-Service
    participant PKV as PRESENCE_KV
    participant CKV as PRESENCE_CONN_KV

    Note over B: === HEARTBEAT (every 10s) ===
    
    B->>B: Generate connId (per tab)
    B->>N: publish presence.heartbeat {userId, connId}
    Note over N: Queue group: presence-workers
    N->>P: presence.heartbeat

    P->>CKV: Put {userId}.{connId} = {}
    Note over CKV: TTL = 45s (auto-expires)

    P->>PKV: Get {userId}
    alt Was offline
        P->>PKV: Put {userId} = {status:online}
        P->>N: publish room.presence.{room} {action:online, userId}
        Note over N: Multicast to room subscribers
    else Was online
        Note over P: No change, just update lastSeen
    end

    Note over B: === STATUS CHANGE ===
    
    B->>N: publish presence.update {userId, status:away}
    N->>P: presence.update

    P->>PKV: Put {userId} = {status:away}
    P->>N: publish room.presence.{room} {action:status, userId, status:away}

    Note over B: === GRACEFUL DISCONNECT (tab close) ===
    
    B->>N: publish presence.disconnect {userId, connId}
    N->>P: presence.disconnect

    P->>CKV: Delete {userId}.{connId}
    P->>CKV: List {userId}.* keys
    alt Last connection
        P->>PKV: Put {userId} = {status:offline}
        P->>N: publish room.presence.{room} {action:offline, userId}
    else Other connections exist
        Note over P: User stays online
    end

    Note over P: === EXPIRED KEY (tab crash) ===
    
    Note over CKV: Key expires after 45s
    P->>P: KV watcher detects expired key
    P->>CKV: List {userId}.* keys
    alt No connections remain
        P->>PKV: Put {userId} = {status:offline}
        P->>N: publish room.presence.{room} {action:offline, userId}
    end
```

---

## 7. Translation Service Flow

```mermaid
sequenceDiagram
    participant B as Browser
    participant N as NATS
    participant T as Translation-Service
    participant O as Ollama

    Note over B: === INITIAL HEALTH CHECK ===
    
    B->>N: request translate.ping
    Note over N: No queue group (lightweight)
    N->>T: translate.ping
    T->>T: Check atomic.Bool health flag
    T->>B: {available: true/false}

    Note over B: === TRANSLATION REQUEST ===
    
    B->>N: publish translate.request {text, targetLang, user, msgKey}
    Note over N: Queue group: translate-workers
    N->>T: translate.request

    T->>T: Check availability
    T->>O: POST /api/generate (streaming)

    loop Streaming chunks
        O->>T: Chunk of translated text
        T->>N: publish deliver.{user}.translate.response {translatedText, targetLang, msgKey, done:false}
        N->>B: Chunk received
        B->>B: Accumulate in translationResults[msgKey]
    end

    O->>T: Final chunk
    T->>N: publish deliver.{user}.translate.response {translatedText, targetLang, msgKey, done:true}
    N->>B: Final chunk
    B->>B: Update UI with complete translation

    Note over T: === BACKGROUND HEALTH PROBE (every 30s) ===
    
    T->>O: GET /api/tags (model check)
    alt Ollama healthy
        T->>T: Set atomic.Bool = true
    else Ollama down
        T->>T: Set atomic.Bool = false
    end

    Note over B: === RECOVERY POLLING ===
    
    loop Every 60s while unavailable
        B->>N: request translate.ping
        N->>T: translate.ping
        T->>B: {available: true/false}
    end
```

---

## 8. App Integration Flow

```mermaid
sequenceDiagram
    participant B as Browser
    participant N as NATS
    participant AR as App-Registry-Service
    participant AS as App-Service
    participant DB as PostgreSQL

    Note over B: === APP DISCOVERY ===
    
    B->>N: request apps.room.{room}
    Note over N: Queue group: app-registry-workers
    N->>AR: apps.room.{room}
    AR->>DB: SELECT apps JOIN room_apps
    DB->>AR: Installed apps list
    AR->>B: [{id, name, componentUrl, subjectPrefix}]

    Note over B: === APP LOADING ===
    
    loop For each app
        B->>B: Check customElements.get(appId)
        alt Not loaded
            B->>B: Load <script src="{componentUrl}">
            B->>B: Create <room-app-{appId}> element
        end
        B->>B: Create AppBridge(nc, sc, appId, room, username)
        B->>B: element.setBridge(bridge)
    end

    Note over B: === APP RPC CALL ===
    
    B->>B: bridge.request(action, data)
    Note over B: Bridge injects user into payload
    B->>N: request app.{appId}.{room}.{action} {data, user}
    Note over N: Queue group: {appId}-workers
    N->>AS: app.{appId}.{room}.{action}
    
    AS->>AS: Process action (create, list, vote, etc.)
    AS->>DB: INSERT/SELECT/UPDATE
    DB->>AS: Result
    AS->>N: publish app.{appId}.{room}.updated
    AS->>B: Reply with result

    Note over B: === REAL-TIME UPDATE ===
    
    N->>B: deliver.{user}.app.{appId}.{room}.updated
    B->>B: Route to AppBridge callback
    B->>B: Update app UI

    Note over B: === APP CLEANUP (leave room) ===
    
    B->>B: destroyAppBridge(appId, room)
    B->>B: Remove all callbacks
    B->>N: Unsubscribe app subjects
```

---

## 9. Service Startup Flow

```mermaid
sequenceDiagram
    participant DC as Docker-Compose
    participant N as NATS
    participant PG as PostgreSQL
    participant KC as Keycloak
    participant AS as Auth-Service
    participant FS as Fanout-Service
    participant RS as Room-Service
    participant PS as Presence-Service
    participant PW as Persist-Worker
    participant HS as History-Service
    participant WB as Web

    Note over DC: === INFRASTRUCTURE LAYER ===
    
    par Infrastructure services
        DC->>PG: Start (health check)
        PG->>PG: Initialize database
        PG->>PG: Create tables
        PG->>PG: Insert demo data
    and
        DC->>KC: Start (health check)
        KC->>KC: Import realm-export.json
        KC->>KC: Create nats-chat realm
        KC->>KC: Create demo users
    and
        DC->>N: Start (depends_on postgres)
        N->>N: Initialize JetStream
        N->>N: Create CHAT_MESSAGES stream
        N->>N: Create KV buckets
    end

    Note over DC: === SERVICE LAYER (30 retries × 2s) ===
    
    DC->>AS: Start
    loop Retry until connected
        AS->>KC: GET /realms/nats-chat/protocol/openid-connect/certs
        AS->>N: Connect (auth callout)
        AS->>PG: Connect
        AS->>AS: Load service_accounts cache
    end

    par Backend services
        DC->>FS: Start
        FS->>N: Connect
        FS->>FS: Subscribe chat.> (fanout-workers)
        FS->>FS: Subscribe admin.* (fanout-workers)
        FS->>FS: Subscribe msg.get (msg-get-workers)
    and
        DC->>RS: Start
        RS->>N: Connect
        RS->>RS: Subscribe room.join.* (room-workers)
        RS->>RS: Subscribe room.leave.* (room-workers)
        RS->>RS: Subscribe room.members.* (room-members-workers)
        RS->>RS: Subscribe room.changed.* (no QG)
    and
        DC->>PS: Start
        PS->>N: Connect
        PS->>PS: Subscribe presence.heartbeat (presence-workers)
        PS->>PS: Subscribe presence.disconnect (presence-workers)
        PS->>PS: Subscribe presence.update (presence-workers)
        PS->>PS: Subscribe room.changed.* (no QG)
        PS->>PS: Start KV watcher for PRESENCE_CONN
    and
        DC->>PW: Start
        PW->>N: Connect
        PW->>PW: Create JetStream consumer
        PW->>PW: Subscribe CHAT_MESSAGES stream
    and
        DC->>HS: Start
        HS->>N: Connect
        HS->>HS: Subscribe chat.history.* (request/reply)
        HS->>HS: Subscribe chat.history.*.thread.* (request/reply)
    end

    Note over DC: === FRONTEND LAYER ===
    
    DC->>WB: Start (health check on port 3000)
    WB->>KC: Check connectivity
    WB->>N: Check WebSocket connectivity

    Note over DC: All services healthy
    Note over DC: System ready
```

---

## Key Flow Characteristics

### Security Boundaries
- **Authentication**: Keycloak OIDC → JWT → NATS auth callout → scoped permissions
- **Authorization**: Ingest validation + capability-based content access
- **Data Isolation**: Two-stream model prevents metadata leakage

### Performance Optimizations
- **Multicast vs Unicast**: Public rooms use NATS multicast (O(1) publish), private rooms use per-user delivery
- **Caching**: MSG_CACHE KV with 5-minute TTL for on-demand content fetch
- **Queue Groups**: Horizontal scaling for all services with message queuing
- **Delta Events**: Room membership changes propagate as compact delta events (~50 bytes)

### Failure Handling
- **Retry Logic**: 30 retries × 2s for service startup ordering
- **Graceful Degradation**: Translation service unavailability handled via health flag
- **Fail-Closed**: Ingest validation denies messages from non-members
- **Eventual Consistency**: Presence tracking uses CAS for offline transitions

### Scalability Patterns
- **Sharded KV**: Room membership uses per-key sharding for O(1) operations
- **Hybrid Delivery**: Public rooms scale to thousands of users, private rooms scale to room size
- **Singleflight**: Prevents thundering herd on concurrent cache misses
- **LRU Caching**: Configurable capacity for room membership cache

---

*These sequence diagrams illustrate the key flows in the NATS Chat Keycloak system, showing how the various components interact to provide a secure, scalable, real-time chat application.*
