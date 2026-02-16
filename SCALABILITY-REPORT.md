# Scalability Analysis Report: NATS Chat System

## Executive Summary

The current architecture has **three structural bottlenecks** that would cause degradation or failure at the scale described (2000+ rooms/user, 10K+ members/room, 100K+ online users). The most critical is the **message fan-out model**; the others are **single-instance backend services** and **unbounded database pressure**. Below is a detailed breakdown organized by three scenarios.

---

## Scenario Analysis

### Scenario 1: A User Subscribes to 2,000+ Rooms

**Current Behavior:** The frontend subscribes to **one room at a time** (`App.tsx:110` — `<ChatRoom key={activeRoom}>`). Switching rooms unmounts the component and creates a new subscription. So today this scenario cannot occur.

**If the design evolved to support multi-room presence** (like Slack/Discord where you receive notifications from all rooms):

| Concern | Impact | Severity |
|---------|--------|----------|
| **Subscription count** | 2,000 subs per user x 100K users = **200M subscriptions** in the NATS interest graph | HIGH |
| **Message delivery** | Each message in any of a user's 2,000 rooms is delivered to their WebSocket. A user in 2,000 active rooms could receive **thousands of messages/sec** | CRITICAL |
| **Client memory** | Browser must buffer messages for 2,000 rooms. Current code keeps 200 msgs/room = **400K messages in memory** | HIGH |
| **History load storm** | On login, 2,000 concurrent `chat.history.*` requests hit the single history-service instance | CRITICAL |
| **Auth callout** | One-time cost per connection (not per subscription), so manageable | LOW |

> **Note on NATS subscription efficiency:** NATS core subscriptions are cheap (~100 bytes each). A single NATS server can handle **10M+ subscriptions**. The bottleneck is not subscription management itself — it's the **message delivery fan-out** that results from many subscriptions. Each message published to a subject must be copied to every matching subscriber's write buffer.

**NATS-specific constraint:** The wildcard permission `chat.>` in `permissions.go:38-44` **authorizes** subscription to all rooms but doesn't **create** subscriptions. The actual subscription is per-room. However, nothing prevents a malicious or buggy client from subscribing to `chat.>` directly, which would receive every message from every room — a self-inflicted DoS.

---

### Scenario 2: A Room with 10K+ Members

This is the **most dangerous scenario** for the current architecture.

**Fan-out math for a single message in a 10K-member room:**

```
1 message published to "chat.general"
  -> NATS routes to 10,000 subscribers
  -> 10,000 WebSocket writes (one per connection)
  -> Each write ~ 200 bytes (JSON message)
  -> Per message: 2MB of network I/O from NATS server
```

**At 100 messages/second in that room:**

```
100 msgs/sec x 10,000 fans = 1,000,000 message deliveries/sec
Network egress: ~200 MB/sec from NATS server (for ONE room)
```

| Component | Bottleneck | Severity |
|-----------|-----------|----------|
| **NATS server** | Single server handles all fan-out. 1M deliveries/sec is near the limit for a single node with WebSocket clients | CRITICAL |
| **WebSocket layer** | 10K concurrent WebSocket connections each receiving 100 msgs/sec. `nats-server.conf:37-39` — no connection limits configured | HIGH |
| **JetStream** | Every message to `chat.*` also writes to the `CHAT_MESSAGES` stream (`persist-worker/main.go:114`). 100 msgs/sec to JetStream with `max_mem: 64M` will thrash storage | HIGH |
| **Persist worker** | Single consumer, synchronous INSERT per message (`persist-worker/main.go:155-193`). At 100 msgs/sec, this is **100 sequential DB inserts/sec** — manageable but no headroom | MEDIUM |
| **PostgreSQL** | No connection pool config (Go defaults: `MaxIdleConns=2`). Under burst load, will open too many connections or queue up | MEDIUM |

> **WebSocket vs TCP fan-out:** NATS is extremely efficient at pub/sub fan-out over **TCP** connections (millions of msgs/sec). But **WebSocket** connections add overhead: HTTP upgrade, per-frame masking, and no_tls still requires framing. The practical fan-out limit for WebSocket clients on a single NATS node is roughly **200K-500K deliveries/sec**, significantly lower than TCP. A 10K-member room at 100 msgs/sec already consumes 1M deliveries/sec — beyond a single node's WebSocket capacity.

---

### Scenario 3: 100K+ Online Users

**Connection math:**

```
100,000 WebSocket connections
  x ~50KB memory per connection (NATS + OS buffers)
  = ~5 GB RAM just for connections

Auth callout on connect:
  100K users logging in over, say, 1 hour = ~28 auth requests/sec
  Peak (everyone reconnects after restart) = 100K in seconds -> auth-service overwhelmed
```

| Component | Bottleneck | Analysis |
|-----------|-----------|----------|
| **Auth service** | `main.go:81` — single `nc.Subscribe("$SYS.REQ.USER.AUTH")`, no queue group. **Cannot handle burst of 100K connections** | CRITICAL |
| **NATS server** | Single node. 100K WebSocket connections are achievable but leave no headroom. NATS recommends clustering at ~50K connections | HIGH |
| **JetStream limits** | `nats-server.conf:5-6` — `max_mem: 64M`, `max_file: 256M`. With 100K users generating messages, the stream fills in minutes. `MaxMsgs: 10000` (`persist-worker/main.go:116`) means messages are evicted before persist-worker can process them | CRITICAL |
| **History service** | `main.go:115` — single subscriber, no queue group. 100K users joining rooms = 100K history queries hitting one instance | CRITICAL |
| **PostgreSQL** | Default `max_connections=100` in PostgreSQL. All three Go services share one DB with no pool limits. Under load, connections exhausted | HIGH |
| **Keycloak** | Token refresh every 30s across 100K users = **~3,333 refresh requests/sec** to Keycloak. Default Keycloak setup won't handle this | HIGH |

---

## Structural Issues (Code-Level)

### 1. No Horizontal Scaling for Backend Services

All three Go services run as **singletons** with no queue group subscriptions:

| Service | Subject | Code Location | Fix |
|---------|---------|---------------|-----|
| Auth | `$SYS.REQ.USER.AUTH` | `auth-service/main.go:81` | Use `nc.QueueSubscribe()` |
| History | `chat.history.*` | `history-service/main.go:115` | Use `nc.QueueSubscribe()` |
| Persist Worker | JetStream durable consumer `persist-worker` | `persist-worker/main.go:133-137` | Does not apply (see note below) |

> For the persist worker, the JetStream durable consumer named `"persist-worker"` is actually **already horizontally scalable** — multiple instances with the same durable name will load-balance via NATS's push consumer delivery. However, the current single-stream, single-consumer design limits throughput.

### 2. JetStream Stream Limits Are Dangerously Low

```go
// persist-worker/main.go:112-119
MaxMsgs: 10000,    // At 100 msgs/sec -> full in 100 seconds
MaxAge:  7 days,   // Reasonable, but MaxMsgs hits first
max_mem: 64M,      // nats-server.conf:5 — fills quickly
max_file: 256M,    // nats-server.conf:6 — fills quickly
```

With the `LimitsPolicy` retention, **old messages are silently dropped** when limits are hit. If persist-worker falls behind (DB slow, consumer restart), messages are lost permanently.

### 3. Database Has No Write Batching or Read Caching

- **Writes**: One INSERT per message (`persist-worker/main.go:182`). PostgreSQL can handle ~10K inserts/sec with prepared statements, but this leaves no headroom.
- **Reads**: Every history request queries PostgreSQL directly (`history-service/main.go:128`). No cache layer. The same "general" room history is re-queried for every user who joins.
- **No connection pool tuning**: Neither service calls `db.SetMaxOpenConns()` or `db.SetMaxIdleConns()`.

### 4. No Rate Limiting Anywhere

- Clients can publish messages at unlimited rate (`ChatRoom.tsx:124`)
- Auth callout has no rate limiting on validation
- History requests have no throttling

---

## Scaling Recommendations

### Option A: Vertical + Config Tuning (Low Effort, Handles ~10K Users)

**Approach:** Keep single-node architecture, fix configuration limits.

| Change | What | Effort |
|--------|------|--------|
| Increase JetStream limits | `max_mem: 1G`, `max_file: 10G`, `MaxMsgs: 1000000` | Config change |
| Add queue groups | `QueueSubscribe` for auth-service and history-service | 1-line change per service |
| DB connection pool | `db.SetMaxOpenConns(25)`, `db.SetMaxIdleConns(10)` | 2 lines per service |
| Batch inserts in persist-worker | Buffer 100 messages, bulk INSERT | ~50 lines |
| Add Redis cache for history | Cache recent 50 msgs per room, TTL 60s | ~100 lines |
| Client-side rate limiting | Debounce publish to 5 msgs/sec | ~10 lines |

**Pros:** Minimal code changes, quick wins
**Cons:** Still single NATS node (SPOF), won't scale beyond ~10K concurrent users
**Estimated effort:** S (1-2 days)

### Option B: NATS Cluster + Service Replication (Medium Effort, Handles ~100K Users)

**Approach:** Deploy 3-node NATS cluster, replicate backend services, add caching layer.

```
                     Load Balancer (WebSocket)
                    /          |          \
             NATS-1        NATS-2        NATS-3    (JetStream R=3)
                    \          |          /
              +-----------------------------+
              |  Auth x3   History x3       |   (queue groups)
              |  Persist x3 (consumer group)|
              |  Redis (history cache)      |
              |  PostgreSQL (primary+replica)|
              +-----------------------------+
```

| Change | What | Effort |
|--------|------|--------|
| NATS cluster | 3-node cluster with JetStream replication factor 3 | Infra config |
| Service replicas | Run 3 instances of each Go service with queue groups | Docker Compose `deploy.replicas: 3` + code changes |
| Redis cache | Cache history queries, invalidate on new message | New service + ~200 lines |
| PostgreSQL read replica | History-service reads from replica | Infra config |
| Stream partitioning | Multiple streams or stream-per-room-category | Medium code change |
| WebSocket load balancing | Sticky sessions or NATS leaf nodes | Infra config |

**Pros:** High availability, horizontal scaling, no SPOF
**Cons:** Operational complexity, requires orchestration (K8s or similar)
**Estimated effort:** M (1-2 weeks)

### Option C: Re-Architecture for 100K+ with Large Rooms (High Effort)

**Approach:** Introduce a gateway layer, topic-based sharding, and tiered fan-out.

```
  Clients --> WS Gateway Cluster (fan-out, rate limiting, auth)
                    |
              NATS Supercluster (leaf nodes per region)
                    |
        +-----------+-----------+
    Stream: chat.general.*   Stream: chat.random.*  ...
        |                       |
   Persist Workers (partitioned by room hash)
        |
   PostgreSQL (partitioned by room, TimescaleDB for time-range)
```

Key design changes:

- **WebSocket Gateway**: Dedicated gateway service handles connection management, authentication, rate limiting, and message fan-out to browsers. NATS handles only server-to-server communication.
- **Subject hierarchy**: `chat.{room}.{shard}` for large rooms, allowing parallel consumers.
- **Tiered fan-out**: For 10K-member rooms, gateway nodes form a tree — NATS publishes once to N gateways, each gateway fans out to M clients.
- **Room-based stream partitioning**: Separate JetStream streams per room category to isolate load.
- **Cursor-based pagination**: Replace fixed `LIMIT 50` with cursor-based queries.
- **Table partitioning**: Partition messages table by room or time range.

**Pros:** Can scale to 1M+ users, handles 100K-member rooms
**Cons:** Significant re-architecture, needs dedicated team
**Estimated effort:** L (1-3 months)

---

## Recommendation

Based on this being a demo/reference architecture:

**Start with Option A** (immediate), then **evolve to Option B** if you need production readiness. Option C is warranted only if you're building a Slack/Discord-class system.

The **highest-impact single change** is adding **queue groups** to auth-service and history-service — it's literally a one-line change per service (`nc.Subscribe` -> `nc.QueueSubscribe`) and immediately enables horizontal scaling of the most critical bottleneck.

The **highest-risk issue** is the JetStream `MaxMsgs: 10000` limit combined with `LimitsPolicy`. Under load, messages will be evicted before persist-worker processes them, causing **silent data loss**. Increasing this to 1M+ is a single number change.

---

## Quick-Reference: Numbers That Matter

| Metric | Current Limit | Needed for 100K Users |
|--------|--------------|----------------------|
| NATS connections | Single server (~50K practical) | 3-node cluster (150K+) |
| JetStream max messages | 10,000 | 1,000,000+ |
| JetStream memory | 64 MB | 1+ GB |
| JetStream file storage | 256 MB | 10+ GB |
| DB max connections | Default (unlimited open, 2 idle) | 25 open, 10 idle per service |
| Auth service instances | 1 | 3+ (queue group) |
| History service instances | 1 | 3+ (queue group) |
| History cache | None | Redis, 60s TTL |
| Client rate limit | None | 5 msgs/sec |
| Message batch size | 1 (single INSERT) | 100-500 (bulk INSERT) |
