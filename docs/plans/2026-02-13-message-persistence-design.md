# Message Persistence Design

## Summary

Add message persistence using JetStream as a WAL and PostgreSQL as the query store. Two new Go services: a persist worker that consumes from JetStream and writes to PostgreSQL, and a history service that serves message history via NATS request/reply.

## Architecture

```
Browser publishes to --> NATS --> JetStream Stream (chat.>)
                                       |
                          +------------+
                          v
                   Persist Worker (Go)
                   - JetStream durable consumer on chat.>
                   - Writes each message to PostgreSQL
                   - Acks after successful DB write
                          |
                          v
                     PostgreSQL
                          ^
                          |
                   History Service (Go)
                   - Subscribes to chat.history.{room} (request/reply)
                   - Queries PostgreSQL for recent messages
                   - Returns JSON array
                          ^
                          |
               Browser sends NATS request on room enter
```

## Components

### 1. NATS JetStream Stream

- Stream name: `CHAT_MESSAGES`
- Subjects: `chat.>`
- Retention: limits-based (10,000 messages + 7 days, whichever hits first)
- Storage: file
- Configured by the persist worker on startup

### 2. Persist Worker (`persist-worker/`)

Go service. Connects to NATS as an AUTH account user. On startup:

1. Ensures JetStream stream `CHAT_MESSAGES` exists with correct config
2. Creates a durable push or pull consumer (deliver-all, ack-explicit)
3. For each message: parse ChatMessage JSON, INSERT into PostgreSQL, then ack
4. Retry on DB write failure (nack/redelivery)

Environment variables: `NATS_URL`, `NATS_USER`, `NATS_PASS`, `DATABASE_URL`

### 3. PostgreSQL

Added as a Docker Compose service. Single table schema:

```sql
CREATE TABLE messages (
    id          BIGSERIAL PRIMARY KEY,
    room        VARCHAR(255) NOT NULL,
    username    VARCHAR(255) NOT NULL,
    text        TEXT NOT NULL,
    timestamp   BIGINT NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_messages_room_ts ON messages(room, timestamp DESC);
```

### 4. History Service (`history-service/`)

Go service. Connects to NATS as an AUTH account user. Subscribes to `chat.history.*` for request/reply.

When a request arrives on `chat.history.general`:
1. Extract room name from subject (`general`)
2. Query PostgreSQL: `SELECT * FROM messages WHERE room = $1 ORDER BY timestamp DESC LIMIT 50`
3. Reverse results to chronological order
4. Reply with JSON array of ChatMessage objects

Environment variables: `NATS_URL`, `NATS_USER`, `NATS_PASS`, `DATABASE_URL`

### 5. Web Client Changes

In `ChatRoom.tsx`, when entering a room (or on mount):
1. Send NATS request to `chat.history.{room}`
2. Parse JSON array response
3. Set as initial messages before live subscription messages arrive

### 6. NATS Configuration Changes

Add two new users to the AUTH account in `nats-server.conf` for the persist worker and history service. Both need credentials for NATS connection.

Enable JetStream in `nats-server.conf`.

### 7. Docker Compose Changes

Add three new services:
- `postgres` — PostgreSQL container with init script for schema
- `persist-worker` — Go service, depends on nats and postgres
- `history-service` — Go service, depends on nats and postgres

## Data Flow

1. User sends message -> published to `chat.general`
2. JetStream captures it in the `CHAT_MESSAGES` stream
3. Persist worker's consumer receives it -> INSERT into PostgreSQL -> ack
4. New user joins room -> browser sends NATS request to `chat.history.general`
5. History service queries PostgreSQL -> replies with last 50 messages
6. Browser prepends history to message list

## Service Authentication

Both new services connect as AUTH account users with explicit credentials (like auth-service). They are trusted internal services; no auth callout needed for them.

## Retention Policy

- JetStream stream: 10,000 messages max + 7-day max age (whichever triggers first)
- PostgreSQL: no automatic cleanup initially (can add later with a cron/retention job)
