# Thread Feature Design

## Overview

Slack-style message threading for the NATS chat application. Users reply to any message to start a thread. Thread replies live in a side panel. Parent messages show a reply count badge in the main timeline. Replies default to thread-only but can optionally broadcast to the main room timeline. Thread messages are persisted to PostgreSQL and loadable on demand.

## Approach

**Thread as a sub-subject.** Thread replies publish to `chat.{room}.thread.{threadId}` where `threadId` is `{room}-{parentTimestamp}`. This fits naturally with the existing NATS subject hierarchy, keeps thread messages separate from the main timeline at the routing level, and reuses existing persist/history infrastructure with minor extensions.

Alternatives considered:
- **Payload field only** — simpler but floods the main room stream with all thread replies, requiring client-side filtering and delivering noise to every room member.
- **Separate thread service** — clean isolation but over-engineered for the current scope (new service, stream, permissions, DB table).

## Data Model

### Extended ChatMessage

```typescript
interface ChatMessage {
  user: string;
  text: string;
  timestamp: number;
  room: string;
  threadId?: string;       // "{room}-{parentTimestamp}" — present on thread replies
  parentTimestamp?: number; // timestamp of the parent message
  replyCount?: number;     // populated on parent messages when loading history
  broadcast?: boolean;     // true = also show in main timeline
}
```

### NATS Subjects

| Subject | Purpose |
|---------|---------|
| `chat.{room}` | Main room messages (unchanged) |
| `chat.{room}.thread.{threadId}` | Thread replies (new) |
| `chat.history.{room}` | Room history query (unchanged) |
| `chat.history.{room}.thread.{threadId}` | Thread history query (new) |

### JetStream Stream

Update `CHAT_MESSAGES` subjects from `["chat.*", "admin.*"]` to `["chat.>", "admin.*"]` so thread messages are also captured and persisted.

### PostgreSQL Schema

```sql
ALTER TABLE messages ADD COLUMN thread_id VARCHAR(255);
ALTER TABLE messages ADD COLUMN parent_timestamp BIGINT;
ALTER TABLE messages ADD COLUMN broadcast BOOLEAN DEFAULT FALSE;
CREATE INDEX idx_messages_thread ON messages(thread_id, timestamp);
```

## Backend Changes

### persist-worker

Parse the extended `ChatMessage` fields (`threadId`, `parentTimestamp`, `broadcast`) and insert into the new columns. No behavioral change — it already consumes from `CHAT_MESSAGES`, which will now include thread messages.

### history-service

- Add subscription on `chat.history.*.thread.*` — queries thread replies by `thread_id` ordered by timestamp ascending.
- Existing `chat.history.*` subscription — annotate parent messages with `replyCount` via a subquery counting rows with matching `thread_id`.

### fanout-service

Change `chat.*` QueueSubscribe to `chat.>` so thread messages (`chat.{room}.thread.{threadId}`) are also fanned out to room members. Thread replies go to all room members; the client filters them into the thread panel or discards if the panel isn't open. This matches Slack's model where thread activity is visible as a badge.

### auth-service

No changes needed — users already have `chat.>` publish permission.

## Frontend Changes

### ThreadPanel (new component)

Slide-in panel on the right side of the chat area. Shows the parent message at the top, then thread replies below. Has its own `MessageInput` with a "Also send to channel" checkbox.

- On open: sends NATS request to `chat.history.{room}.thread.{threadId}` for history
- On reply: publishes to `chat.{room}.thread.{threadId}` with `threadId`, `parentTimestamp`, `broadcast` fields
- If broadcast checked: also publishes to `chat.{room}` (two publishes)

### MessageList

- Add hover "Reply" action button on each message
- Show clickable "N replies" badge on parent messages with `replyCount > 0`
- Filter out thread-only replies from the main timeline (messages with `threadId` and `broadcast !== true`)

### MessageProvider

- Route delivered thread messages (`deliver.{userId}.chat.{room}.thread.{threadId}`) to thread-specific state
- Track reply counts per parent timestamp, incrementing when new thread messages arrive
- Expose thread messages getter and active thread state via context

### ChatRoom

- Layout changes to render `ThreadPanel` beside the message area when a thread is open
- Manage active thread state (which thread is open, close handler)

## Broadcast Replies

When `broadcast: true`, the client publishes the message to both subjects:
1. `chat.{room}.thread.{threadId}` — appears in the thread panel
2. `chat.{room}` — appears in the main room timeline with `threadId` set, showing "replied in thread" context

## Edge Cases

- **No thread nesting** — replies to thread messages don't create sub-threads. All replies in a thread are flat.
- **Thread history on open** — loaded on demand via request/reply, not eagerly.
- **Reply counts in room history** — history-service annotates parent messages, so reply badges appear immediately on room load.
- **Thread panel close** — thread messages still accumulate in state (for badge counts) but aren't rendered.

## Files Summary

| Action | File | Purpose |
|--------|------|---------|
| MODIFY | `web/src/types.ts` | Add thread fields to ChatMessage |
| MODIFY | `postgres/init.sql` | Add thread columns + index |
| MODIFY | `persist-worker/main.go` | Persist thread fields |
| MODIFY | `history-service/main.go` | Thread history endpoint, reply counts |
| MODIFY | `fanout-service/main.go` | Change `chat.*` to `chat.>` |
| MODIFY | `web/src/providers/MessageProvider.tsx` | Thread message routing, reply counts |
| CREATE | `web/src/components/ThreadPanel.tsx` | Thread side panel |
| MODIFY | `web/src/components/MessageList.tsx` | Reply action, reply badge, filter |
| MODIFY | `web/src/components/ChatRoom.tsx` | Side panel layout, thread state |
