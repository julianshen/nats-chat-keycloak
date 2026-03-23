# Dual-Plane NATS Design (Core + JetStream)

## Objective

Implement a two-plane messaging model:

- **Core NATS plane** for ephemeral, low-reliability traffic.
- **JetStream plane** for durable, replayable traffic.

This design keeps the current single NATS deployment (JetStream enabled), but enforces reliability boundaries by **subject namespace + stream policy**.

## Why this change

Current architecture already mixes fanout ingest, notify, KV cache, and persistence:

- Clients publish user messages to `deliver.{user}.send.>`.
- Fanout validates and republishes to `chat.{room}[.thread.{id}]`.
- Persist worker consumes `CHAT_MESSAGES` stream on chat subjects and writes to PostgreSQL.
- Clients consume room notifications and fetch full content through `msg.get`.

This proposal formalizes reliability by separating traffic classes so features can opt in/out of persistence intentionally.

## Traffic Classification Matrix

| Class | Plane | Delivery Requirement | Subject Namespace | Persistence |
|---|---|---|---|---|
| Chat message create/edit/delete/react (room/thread/DM) | JetStream | At-least-once + replay | `chat.msg.*`, `chat.msg.*.thread.*`, `chat.msg.dm.*` | Yes |
| Message history query (request/reply) | Core NATS | Low-latency RPC | `chat.history.*` | No |
| Room membership/control events | Core NATS | Best effort | `room.join.*`, `room.leave.*`, `room.changed.*` | No |
| Presence heartbeat + status deltas | Core NATS | Best effort, lossy tolerated | `presence.*`, `room.presence.*` | No |
| Room notification IDs (content fetch indirection) | Core NATS | Best effort | `room.notify.*`, `deliver.*.notify.*` | No |
| Message content fetch by notifyId | Core NATS | RPC with timeout | `msg.get` | No |
| E2EE key exchange and epoch control | Core NATS (default) | Request/reply + fanout | `e2ee.*` | No (unless audit required) |
| Optional compliance/audit event mirror | JetStream (optional) | Replay + retention | `audit.chat.*` | Yes |

## Subject Taxonomy

### Durable subjects (JetStream)

- `chat.msg.{room}`
- `chat.msg.{room}.thread.{threadId}`
- `chat.msg.dm.{conversationId}`

### Ephemeral subjects (Core)

- `deliver.{username}.send.{room}[.thread.{threadId}]` (ingest entrypoint)
- `room.notify.{room}` / `deliver.{username}.notify.{room}`
- `room.presence.{room}`
- `presence.update`, `presence.heartbeat`, `presence.disconnect`
- `room.changed.{room}`
- `msg.get`
- `chat.history.{room}`

## JetStream Stream Design

### Stream: `CHAT_DURABLE`

- **Subjects:**
  - `chat.msg.*`
  - `chat.msg.*.thread.*`
  - `chat.msg.dm.*`
- **Retention:** `LimitsPolicy`
- **Storage:** `FileStorage`
- **Suggested limits (initial):**
  - `MaxAge`: `7d`
  - `MaxMsgs`: `5_000_000`
  - `Replicas`: `1` (local dev), `3` (prod)
- **Discard policy:** `DiscardOld`

### Consumer: `persist-worker`

- **Durable name:** `persist-worker`
- **Ack policy:** `AckExplicit`
- **Deliver policy:** `DeliverAll`
- **Replay policy:** `ReplayInstant`
- **MaxAckPending:** tune by DB throughput (start: `2000`)

### Optional stream: `CHAT_AUDIT`

- **Subjects:** `audit.chat.*`
- **Purpose:** immutable compliance/event replay independent of chat UX history.

## Producer/Consumer Routing Rules

## Fanout service

1. Subscribe to `deliver.*.send.>` (unchanged ingress).
2. Validate sender + membership + rate limits.
3. Publish **durable payload** to `chat.msg...` namespace (instead of `chat...`).
4. Continue publishing notification envelopes to `room.notify.*` / `deliver.*.notify.*`.
5. Continue caching full payload in KV (`MSG_CACHE`) for `msg.get` fetch path.

## Persist worker

1. Consume from `CHAT_DURABLE`.
2. Parse payload action (`message`, `edit`, `delete`, `react`, ...).
3. Apply idempotent writes to PostgreSQL.
4. Ack only after successful DB transaction.
5. NAK/retry with bounded backoff on transient failures.

## History service

- Remains request/reply on `chat.history.*`.
- Reads PostgreSQL only.
- No JetStream subscription needed.

## Permission Model Changes

Keep existing role model but update publish/subscribe subjects.

### User/Admin publish allow (delta)

- Keep: `deliver.{username}.send.>`
- Keep: `chat.history.>`
- Keep: `msg.get`
- Keep: room/presence/app/file/e2ee request subjects
- **Do not grant clients direct publish to `chat.msg.*`** (fanout/service-only)

### User/Admin subscribe allow (delta)

- Keep: `deliver.{username}.>`
- Keep: `room.notify.*`
- Keep: `room.presence.*`

### Service account permissions

- Fanout/persist/history remain broad (`>`), or tighten per service later:
  - fanout: pub `chat.msg.>`, `room.notify.>`, `deliver.*.notify.>`; sub `deliver.*.send.>`, `room.changed.>`, `chat.msg.>` (if local notify path consumes durable stream)
  - persist-worker: sub `chat.msg.>` + JetStream API
  - history: sub `chat.history.*`, pub replies

## Rollout Plan (No Downtime)

## Phase 0 — Prep

- Add new stream `CHAT_DURABLE` for `chat.msg.>` subjects.
- Add dashboard panels for stream lag and consumer ack latency.

## Phase 1 — Dual write

- Fanout publishes to both old (`chat.*`) and new (`chat.msg.*`) subjects.
- Persist worker still consumes old stream.
- Validate parity in DB writes and counters.

## Phase 2 — Consumer cutover

- Switch persist worker to consume `CHAT_DURABLE` only.
- Keep dual write temporarily.
- Verify no data loss (lag=0, write counts stable).

## Phase 3 — Read path stabilization

- Keep history service unchanged (DB-backed).
- Ensure edits/deletes/reactions parity from new stream.

## Phase 4 — Decommission old durable subject

- Remove old `chat.*` stream bindings.
- Keep notify and control-plane subjects as Core-only.

## Observability/SLO Additions

Track both planes separately:

- Core plane:
  - dropped notification count
  - `msg.get` timeout/error rate
  - presence publish and subscription lag indicators
- JetStream plane:
  - stream bytes/messages
  - consumer lag (`persist-worker`)
  - redelivery count
  - ack latency p95/p99
- DB sink:
  - insert/update error rate
  - write latency

Suggested alert starters:

- `persist_worker_consumer_lag > 10_000 for 5m`
- `persist_worker_redeliveries > 100/min`
- `msg_get_error_rate > 1% for 10m`

## Failure Semantics

- If Core notify path degrades: users may miss live updates, but durable messages remain in JetStream and history remains correct.
- If persist worker or DB degrades: JetStream backlog grows; no message loss within retention window.
- If history service degrades: live chat can continue; history paging fails.

## Data Contracts

Standardize envelope for `chat.msg.*` payloads:

```json
{
  "v": 1,
  "action": "message|edit|delete|react|system",
  "room": "general",
  "threadId": "optional",
  "user": "alice",
  "timestamp": 1735689600000,
  "text": "...",
  "emoji": "👍",
  "targetUser": "bob",
  "fileId": "optional",
  "fileIds": ["optional"],
  "e2ee": { "epoch": 12, "v": 1 }
}
```

Notes:

- Subject remains source of truth for room/thread routing.
- Payload room is informational and validated/overridden by consumer.

## Implementation Checklist

- [ ] Add stream config for `CHAT_DURABLE` in persist-worker startup.
- [ ] Update fanout publish target from `chat.*` to `chat.msg.*`.
- [ ] Keep notify model unchanged (`room.notify.*` + `msg.get`).
- [ ] Update auth permissions docs/config comments for new durable namespace.
- [ ] Add metrics for dual-plane success/failure by subject prefix.
- [ ] Add migration runbook for dual-write and cutover rollback.

## Open Decisions

1. Should DM durable events share `CHAT_DURABLE` or get a dedicated `CHAT_DM_DURABLE` stream?
2. Do we need a separate compliance/audit stream now, or defer?
3. Should `room.notify.*` remain wildcard-visible for metadata, or move to per-user-only notify for private rooms?
4. What exact retention targets are required by product/legal per room type?
