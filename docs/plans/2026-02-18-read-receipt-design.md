# Read Receipt Feature Design

## Overview

Per-room read watermarks that track the last message timestamp each user has seen. Stored in NATS KV for fast reads/writes with periodic flush to PostgreSQL for durability. Read positions are visible to room members ("Read by N" indicators). A dedicated read-receipt-service owns all read state, following the same pattern as presence-service.

## Approach

**Dedicated read-receipt-service with KV + PostgreSQL.** The hot path (reads and writes) uses a NATS KV bucket `READ_STATE` with file-backed storage. Dirty entries are batched and flushed to a PostgreSQL `read_receipts` table every 15 seconds. On startup, the service rebuilds KV state from PostgreSQL. Broadcasts go to room members via the existing `deliver.{userId}.>` fan-out pattern.

Alternatives considered:
- **Extend history-service** — simpler but mixes read/write concerns and puts every read event through PostgreSQL directly.
- **KV only, no PostgreSQL** — simplest but lacks durable backup and can't support analytics queries.

## Data Model

### NATS KV Bucket `READ_STATE`

- **Key:** `{userId}.{room}` (e.g. `alice.general`)
- **Value:** `{"lastRead": 1708300000000}`
- **History:** 1 (latest only)
- **Storage:** FileStorage (survives restarts)

### PostgreSQL Table

```sql
CREATE TABLE IF NOT EXISTS read_receipts (
    user_id    VARCHAR(255) NOT NULL,
    room       VARCHAR(255) NOT NULL,
    last_read  BIGINT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, room)
);
```

One row per user per room. Upserted via `INSERT ... ON CONFLICT (user_id, room) DO UPDATE SET last_read = EXCLUDED.last_read, updated_at = NOW()`.

### Flush Strategy

- Service tracks dirty KV entries in a set
- Every 15 seconds, batch-upserts all dirty entries to PostgreSQL, then clears the dirty set
- On startup: `SELECT * FROM read_receipts` → populate KV bucket
- Worst case data loss on crash: 15 seconds of read receipts (acceptable)

## NATS Subjects

| Subject | Direction | Purpose |
|---------|-----------|---------|
| `read.update.{room}` | client → service | "I've read up to timestamp X in this room" |
| `read.state.{room}` | client ↔ service (request/reply) | "Give me all members' read positions" |
| `deliver.{userId}.read.{room}` | service → client | Broadcast: read positions changed |

## Service Logic (read-receipt-service)

### On `read.update.{room}` received:

1. Parse `{userId, lastRead}` from payload
2. Read current KV value for `{userId}.{room}` — if lastRead hasn't changed, skip (dedup)
3. Write new value to KV
4. Add `{userId}.{room}` to dirty set for next DB flush
5. Broadcast to room members (debounced: max one broadcast per room per 2 seconds)

### Broadcast format (`deliver.{member}.read.{room}`):

```json
{
  "room": "general",
  "readers": [
    {"userId": "alice", "lastRead": 1708300000000},
    {"userId": "bob", "lastRead": 1708299500000}
  ]
}
```

### On `read.state.{room}` request:

1. Look up room members from in-memory membership (same `room.join.*`/`room.leave.*` tracking as presence-service)
2. For each member, read their KV entry `{member}.{room}`
3. Respond with array of `{userId, lastRead}` pairs

### Periodic flush (every 15 seconds):

1. Collect all dirty entries
2. Batch upsert to PostgreSQL
3. Clear dirty set

### On startup:

1. Query all rows from `read_receipts` table
2. Put each into KV bucket
3. Begin normal operation

## Performance Characteristics

- **KV read/write:** sub-millisecond (NATS in-process with file backing)
- **Broadcast:** one publish per room member per read event (debounced at 2s per room)
- **DB writes:** batched every 15s — amortized to ~1 upsert per dirty user-room pair
- **No DB reads in hot path** — KV serves all queries
- **Storage:** one KV entry + one DB row per user-room pair. 100 users x 20 rooms = 2,000 entries

## Frontend Changes

### MessageProvider

- New state: `readReceipts: Record<string, Array<{userId: string, lastRead: number}>>` (per room)
- Handle `deliver.{userId}.read.{room}` events — update readReceipts state
- On room join: request `read.state.{room}` for initial data
- `markAsRead(room)` enhanced — publishes `read.update.{room}` with `{userId, lastRead: latestMessageTimestamp}`
- Unread counts now computed from: messages where `timestamp > myLastRead` for each room
- Client-side debounce: publish read updates at most once per 3 seconds while messages arrive

### MessageList

- Accept `readReceipts` prop
- After the last message each user has read, show "Read by N" indicator (grouped small avatars or text)
- Only display for messages visible on the current screen (not all historical messages)

### ChatRoom

- Pass `readReceipts` from context to MessageList
- On initial room load: compare history messages against own lastRead to compute initial unread line position

## Edge Cases

- **Offline user reconnects** — requests `read.state.{room}` which reads from KV (populated from PostgreSQL on service start). Unread count computed by comparing lastRead against room history.
- **Service restart** — KV rebuilt from PostgreSQL on startup. No data loss beyond the 15s flush window.
- **Rapid room switching** — client debounces read.update publishes. Service deduplicates unchanged lastRead values.
- **User in multiple tabs** — each tab publishes read.update independently. KV stores the latest. No conflict since lastRead is monotonically increasing.

## Files Summary

| Action | File | Purpose |
|--------|------|---------|
| CREATE | `read-receipt-service/main.go` | Read receipt service with KV, flush, broadcasts |
| CREATE | `read-receipt-service/Dockerfile` | Multi-stage Go build |
| CREATE | `read-receipt-service/go.mod` | Go module definition |
| MODIFY | `postgres/init.sql` | Add read_receipts table |
| MODIFY | `auth-service/permissions.go` | Add read.update.*, read.state.* to permissions |
| MODIFY | `nats/nats-server.conf` | Add read-receipt-service user |
| MODIFY | `docker-compose.yml` | Add read-receipt-service container |
| MODIFY | `web/src/providers/MessageProvider.tsx` | Read receipt state, markAsRead publish, unread from watermark |
| MODIFY | `web/src/components/MessageList.tsx` | "Read by" indicators |
| MODIFY | `web/src/components/ChatRoom.tsx` | Pass readReceipts, unread line |
