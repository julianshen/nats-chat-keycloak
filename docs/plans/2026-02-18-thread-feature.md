# Thread Feature Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Slack-style message threading — reply to any message to start a thread in a side panel, with optional broadcast to the main timeline, persisted to PostgreSQL.

**Architecture:** Thread replies publish to `chat.{room}.thread.{threadId}` where `threadId` = `{room}-{parentTimestamp}`. The JetStream stream, persist-worker, and fanout-service widen their subject filters from `chat.*` to `chat.>` to capture thread messages. The history-service adds a thread history endpoint. The frontend adds a `ThreadPanel` side panel component and routes thread messages separately.

**Tech Stack:** Go (backend services), React 18 + TypeScript (frontend), PostgreSQL, NATS JetStream

---

### Task 1: Add thread columns to PostgreSQL schema

**Files:**
- Modify: `postgres/init.sql`

**Step 1: Add thread columns and index to init.sql**

Add three new columns and an index after the existing `CREATE INDEX` statement in `postgres/init.sql`:

```sql
ALTER TABLE messages ADD COLUMN IF NOT EXISTS thread_id VARCHAR(255);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS parent_timestamp BIGINT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS broadcast BOOLEAN DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, timestamp);
```

Append these four lines after line 10 (`CREATE INDEX IF NOT EXISTS idx_messages_room_ts ...`).

**Step 2: Verify syntax**

Run: `docker compose exec postgres psql -U chat -d chatdb -c "\d messages"`
Expected: Table exists. (The new columns will appear after container restart with fresh volume, or can be applied manually.)

**Step 3: Apply migration to running database**

Run: `docker compose exec postgres psql -U chat -d chatdb -c "ALTER TABLE messages ADD COLUMN IF NOT EXISTS thread_id VARCHAR(255); ALTER TABLE messages ADD COLUMN IF NOT EXISTS parent_timestamp BIGINT; ALTER TABLE messages ADD COLUMN IF NOT EXISTS broadcast BOOLEAN DEFAULT FALSE;"`
Run: `docker compose exec postgres psql -U chat -d chatdb -c "CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, timestamp);"`

Expected: `ALTER TABLE` and `CREATE INDEX` succeed.

**Step 4: Commit**

```bash
git add postgres/init.sql
git commit -m "feat(db): add thread_id, parent_timestamp, broadcast columns to messages table"
```

---

### Task 2: Extend TypeScript ChatMessage type

**Files:**
- Modify: `web/src/types.ts`

**Step 1: Add thread fields to ChatMessage interface**

In `web/src/types.ts`, add four optional fields to the `ChatMessage` interface:

```typescript
export interface ChatMessage {
  user: string;
  text: string;
  timestamp: number;
  room: string;
  threadId?: string;        // "{room}-{parentTimestamp}" — present on thread replies
  parentTimestamp?: number;  // timestamp of the parent message
  replyCount?: number;      // populated on parent messages when loading history
  broadcast?: boolean;      // true = also show in main timeline
}
```

**Step 2: Verify types compile**

Run: `cd web && npx tsc --noEmit`
Expected: No errors.

**Step 3: Commit**

```bash
git add web/src/types.ts
git commit -m "feat(types): add thread fields to ChatMessage interface"
```

---

### Task 3: Update persist-worker to store thread fields

**Files:**
- Modify: `persist-worker/main.go`

**Step 1: Extend ChatMessage struct**

In `persist-worker/main.go`, add three fields to the `ChatMessage` struct (after line 27, `Room` field):

```go
type ChatMessage struct {
	User            string `json:"user"`
	Text            string `json:"text"`
	Timestamp       int64  `json:"timestamp"`
	Room            string `json:"room"`
	ThreadId        string `json:"threadId,omitempty"`
	ParentTimestamp int64  `json:"parentTimestamp,omitempty"`
	Broadcast       bool   `json:"broadcast,omitempty"`
}
```

**Step 2: Update the INSERT statement**

Change the prepared statement at line 145-147 from:

```go
insertStmt, err := db.Prepare(
    "INSERT INTO messages (room, username, text, timestamp) VALUES ($1, $2, $3, $4)",
)
```

To:

```go
insertStmt, err := db.Prepare(
    "INSERT INTO messages (room, username, text, timestamp, thread_id, parent_timestamp, broadcast) VALUES ($1, $2, $3, $4, $5, $6, $7)",
)
```

**Step 3: Update the ExecContext call**

Change line 182 from:

```go
_, err := insertStmt.ExecContext(ctx, chatMsg.Room, chatMsg.User, chatMsg.Text, chatMsg.Timestamp)
```

To:

```go
_, err := insertStmt.ExecContext(ctx, chatMsg.Room, chatMsg.User, chatMsg.Text, chatMsg.Timestamp, nullableString(chatMsg.ThreadId), nullableInt64(chatMsg.ParentTimestamp), chatMsg.Broadcast)
```

**Step 4: Add nullable helper functions**

Add two helper functions before `main()` (after `envOrDefault`):

```go
func nullableString(s string) interface{} {
	if s == "" {
		return nil
	}
	return s
}

func nullableInt64(n int64) interface{} {
	if n == 0 {
		return nil
	}
	return n
}
```

**Step 5: Update JetStream stream subjects**

Change the stream subjects at line 113 from:

```go
Subjects:  []string{"chat.*", "admin.*"},
```

To:

```go
Subjects:  []string{"chat.>", "admin.*"},
```

This ensures thread messages (`chat.{room}.thread.{threadId}`) are captured by JetStream.

**Step 6: Verify it compiles**

Run: `cd persist-worker && go build -o /dev/null .`
Expected: Build succeeds.

**Step 7: Commit**

```bash
git add persist-worker/main.go
git commit -m "feat(persist-worker): persist thread fields and widen stream subjects to chat.>"
```

---

### Task 4: Update history-service with thread history and reply counts

**Files:**
- Modify: `history-service/main.go`

**Step 1: Extend ChatMessage struct**

In `history-service/main.go`, add three fields to the `ChatMessage` struct:

```go
type ChatMessage struct {
	User            string `json:"user"`
	Text            string `json:"text"`
	Timestamp       int64  `json:"timestamp"`
	Room            string `json:"room"`
	ThreadId        string `json:"threadId,omitempty"`
	ParentTimestamp int64  `json:"parentTimestamp,omitempty"`
	ReplyCount      int    `json:"replyCount,omitempty"`
}
```

**Step 2: Add `database/sql` import**

Add `"database/sql"` to the imports block. This is needed for `sql.NullString` and `sql.NullInt64` when scanning nullable columns.

**Step 3: Update the room history query to include reply counts**

Change the prepared query at lines 105-107 from:

```go
queryStmt, err := db.Prepare(
    "SELECT room, username, text, timestamp FROM messages WHERE room = $1 ORDER BY timestamp DESC LIMIT 50",
)
```

To:

```go
queryStmt, err := db.Prepare(
    `SELECT m.room, m.username, m.text, m.timestamp, m.thread_id,
            COALESCE((SELECT COUNT(*) FROM messages t WHERE t.thread_id = m.room || '-' || m.timestamp::text), 0) AS reply_count
     FROM messages m
     WHERE m.room = $1 AND m.thread_id IS NULL
     ORDER BY m.timestamp DESC LIMIT 50`,
)
```

Key changes: (1) filters out thread replies from the main timeline (`thread_id IS NULL`), (2) counts replies for each parent message via correlated subquery.

**Step 4: Update the row scanner**

Change the scanning loop (lines 138-145) from:

```go
for rows.Next() {
    var m ChatMessage
    if err := rows.Scan(&m.Room, &m.User, &m.Text, &m.Timestamp); err != nil {
        slog.WarnContext(ctx, "Failed to scan row", "error", err)
        continue
    }
    messages = append(messages, m)
}
```

To:

```go
for rows.Next() {
    var m ChatMessage
    var threadId sql.NullString
    var replyCount int
    if err := rows.Scan(&m.Room, &m.User, &m.Text, &m.Timestamp, &threadId, &replyCount); err != nil {
        slog.WarnContext(ctx, "Failed to scan row", "error", err)
        continue
    }
    if threadId.Valid {
        m.ThreadId = threadId.String
    }
    m.ReplyCount = replyCount
    messages = append(messages, m)
}
```

**Step 5: Add thread history subscription**

After the `chat.history.*` subscription (after line 173), add a new subscription for thread history:

```go
// Prepare thread query statement
threadQueryStmt, err := db.Prepare(
    `SELECT room, username, text, timestamp, thread_id, parent_timestamp
     FROM messages
     WHERE thread_id = $1
     ORDER BY timestamp ASC LIMIT 200`,
)
if err != nil {
    slog.Error("Failed to prepare thread query", "error", err)
    os.Exit(1)
}
defer threadQueryStmt.Close()

// Subscribe to thread history requests: chat.history.{room}.thread.{threadId}
_, err = nc.Subscribe("chat.history.*.thread.*", func(msg *nats.Msg) {
    start := time.Now()
    ctx, span := otelhelper.StartServerSpan(context.Background(), msg, "thread history request")
    defer span.End()

    parts := strings.Split(msg.Subject, ".")
    if len(parts) < 5 {
        msg.Respond([]byte("[]"))
        return
    }
    threadId := parts[4]
    span.SetAttributes(attribute.String("chat.threadId", threadId))

    rows, err := threadQueryStmt.QueryContext(ctx, threadId)
    if err != nil {
        slog.ErrorContext(ctx, "Thread query failed", "threadId", threadId, "error", err)
        span.RecordError(err)
        msg.Respond([]byte("[]"))
        return
    }
    defer rows.Close()

    var messages []ChatMessage
    for rows.Next() {
        var m ChatMessage
        var tid sql.NullString
        var pts sql.NullInt64
        if err := rows.Scan(&m.Room, &m.User, &m.Text, &m.Timestamp, &tid, &pts); err != nil {
            slog.WarnContext(ctx, "Failed to scan thread row", "error", err)
            continue
        }
        if tid.Valid {
            m.ThreadId = tid.String
        }
        if pts.Valid {
            m.ParentTimestamp = pts.Int64
        }
        messages = append(messages, m)
    }

    if messages == nil {
        messages = []ChatMessage{}
    }

    data, err := json.Marshal(messages)
    if err != nil {
        slog.ErrorContext(ctx, "Failed to marshal thread history", "error", err)
        span.RecordError(err)
        msg.Respond([]byte("[]"))
        return
    }

    msg.Respond(data)

    duration := time.Since(start).Seconds()
    attrs := metric.WithAttributes(attribute.String("threadId", threadId))
    requestCounter.Add(ctx, 1, attrs)
    requestDuration.Record(ctx, duration, attrs)

    span.SetAttributes(attribute.Int("history.message_count", len(messages)))
    slog.InfoContext(ctx, "Served thread history", "threadId", threadId, "count", len(messages), "duration_ms", time.Since(start).Milliseconds())
})
if err != nil {
    slog.Error("Failed to subscribe to thread history", "error", err)
    os.Exit(1)
}
slog.Info("Subscribed to chat.history.*.thread.* — ready to serve thread history requests")
```

**Step 6: Verify it compiles**

Run: `cd history-service && go build -o /dev/null .`
Expected: Build succeeds.

**Step 7: Commit**

```bash
git add history-service/main.go
git commit -m "feat(history-service): add thread history endpoint and reply counts on room history"
```

---

### Task 5: Widen fanout-service subscription from `chat.*` to `chat.>`

**Files:**
- Modify: `fanout-service/main.go`

**Step 1: Change QueueSubscribe subject**

Change line 195 from:

```go
_, err = nc.QueueSubscribe("chat.*", "fanout-workers", func(msg *nats.Msg) {
```

To:

```go
_, err = nc.QueueSubscribe("chat.>", "fanout-workers", func(msg *nats.Msg) {
```

**Step 2: Update room extraction logic**

The current `room` extraction at line 205 uses `strings.TrimPrefix(msg.Subject, "chat.")` which would give `general.thread.general-123` for thread messages. The fanout still works because it looks up membership by the full trimmed string — but thread messages need to be fanned out to the *room's* members, not a thread-specific key.

Change lines 201-207 from:

```go
		ctx, span := otelhelper.StartConsumerSpan(context.Background(), msg, "fanout chat message")
		defer span.End()

		start := time.Now()
		room := strings.TrimPrefix(msg.Subject, "chat.")

		members := mem.members(room)
```

To:

```go
		ctx, span := otelhelper.StartConsumerSpan(context.Background(), msg, "fanout chat message")
		defer span.End()

		start := time.Now()

		// Extract room name: "chat.general" → "general", "chat.general.thread.xyz" → "general"
		remainder := strings.TrimPrefix(msg.Subject, "chat.")
		room := remainder
		if idx := strings.Index(remainder, "."); idx != -1 {
			room = remainder[:idx]
		}

		members := mem.members(room)
```

**Step 3: Update the log line and ready message**

Change line 269 from:

```go
slog.Info("Fanout service ready — listening for chat.*, admin.*, room.join.*, room.leave.*")
```

To:

```go
slog.Info("Fanout service ready — listening for chat.>, admin.*, room.join.*, room.leave.*")
```

**Step 4: Verify it compiles**

Run: `cd fanout-service && go build -o /dev/null .`
Expected: Build succeeds.

**Step 5: Commit**

```bash
git add fanout-service/main.go
git commit -m "feat(fanout-service): widen subscription to chat.> for thread message fan-out"
```

---

### Task 6: Update MessageProvider to route thread messages and track reply counts

**Files:**
- Modify: `web/src/providers/MessageProvider.tsx`

**Step 1: Add thread-related state and context fields**

Add these new state variables after line 58 (`const [currentStatus, setCurrentStatus] = ...`):

```typescript
const [threadMessagesByThreadId, setThreadMessagesByThreadId] = useState<Record<string, ChatMessage[]>>({});
const [replyCounts, setReplyCounts] = useState<Record<string, number>>({});
const [activeThread, setActiveThread] = useState<{ room: string; threadId: string; parentMessage: ChatMessage } | null>(null);
```

**Step 2: Update MessageContextType interface**

Add these fields to the `MessageContextType` interface (after `currentStatus: string`):

```typescript
/** Thread messages for a specific threadId */
getThreadMessages: (threadId: string) => ChatMessage[];
/** Reply counts per parent timestamp key "{room}-{timestamp}" */
replyCounts: Record<string, number>;
/** Currently active thread (open in side panel) */
activeThread: { room: string; threadId: string; parentMessage: ChatMessage } | null;
/** Open a thread panel */
openThread: (room: string, parentMessage: ChatMessage) => void;
/** Close the thread panel */
closeThread: () => void;
```

**Step 3: Update the context default values**

Add to the `createContext` default values:

```typescript
getThreadMessages: () => [],
replyCounts: {},
activeThread: null,
openThread: () => {},
closeThread: () => {},
```

**Step 4: Update the deliver message routing logic**

In the message processing loop (inside the `for await (const msg of sub)` block, around lines 77-127), after extracting `subjectType` and `roomName`, add thread message detection.

Replace the section from line 105 to line 127 (the `// Determine room key` block and the `setMessagesByRoom` / unread counting block) with:

```typescript
            // Determine room key for internal use
            let roomKey: string;
            if (subjectType === 'admin') {
              roomKey = '__admin__';
            } else {
              roomKey = roomName;
            }

            // Check if this is a thread message: deliver.{userId}.chat.{room}.thread.{threadId}
            // roomName would be "{room}.thread.{threadId}" in that case
            const threadMatch = roomKey.match(/^([^.]+)\.thread\.(.+)$/);
            if (threadMatch) {
              const threadId = threadMatch[2];
              const parentRoom = threadMatch[1];

              // Store in thread messages
              setThreadMessagesByThreadId((prev) => {
                const existing = prev[threadId] || [];
                return {
                  ...prev,
                  [threadId]: [...existing.slice(-(MAX_MESSAGES_PER_ROOM - 1)), data],
                };
              });

              // Increment reply count
              setReplyCounts((prev) => ({
                ...prev,
                [threadId]: (prev[threadId] || 0) + 1,
              }));

              // If broadcast, also add to main timeline
              if (data.broadcast) {
                setMessagesByRoom((prev) => {
                  const existing = prev[parentRoom] || [];
                  return {
                    ...prev,
                    [parentRoom]: [...existing.slice(-(MAX_MESSAGES_PER_ROOM - 1)), data],
                  };
                });
              }

              continue;
            }

            setMessagesByRoom((prev) => {
              const existing = prev[roomKey] || [];
              return {
                ...prev,
                [roomKey]: [...existing.slice(-(MAX_MESSAGES_PER_ROOM - 1)), data],
              };
            });

            // Increment unread count if this room is not currently active
            if (roomKey !== activeRoomRef.current) {
              setUnreadCounts((prev) => ({
                ...prev,
                [roomKey]: (prev[roomKey] || 0) + 1,
              }));
            }
```

**Step 5: Add openThread, closeThread, getThreadMessages callbacks**

After `markAsRead` callback (around line 227), add:

```typescript
const getThreadMessages = useCallback((threadId: string) => {
  return threadMessagesByThreadId[threadId] || [];
}, [threadMessagesByThreadId]);

const openThread = useCallback((room: string, parentMessage: ChatMessage) => {
  const threadId = `${room}-${parentMessage.timestamp}`;
  setActiveThread({ room, threadId, parentMessage });
}, []);

const closeThread = useCallback(() => {
  setActiveThread(null);
}, []);
```

**Step 6: Update the Provider value**

Add the new fields to the context provider value:

```typescript
<MessageContext.Provider value={{
  getMessages, joinRoom, leaveRoom, unreadCounts, markAsRead,
  onlineUsers, setStatus, currentStatus,
  getThreadMessages, replyCounts, activeThread, openThread, closeThread
}}>
```

**Step 7: Verify types compile**

Run: `cd web && npx tsc --noEmit`
Expected: No errors.

**Step 8: Commit**

```bash
git add web/src/providers/MessageProvider.tsx
git commit -m "feat(message-provider): route thread messages, track reply counts, manage thread state"
```

---

### Task 7: Update MessageList with reply action and reply count badge

**Files:**
- Modify: `web/src/components/MessageList.tsx`

**Step 1: Add onReplyClick prop and import ChatMessage type**

Update the Props interface to include `onReplyClick` and `replyCounts`:

```typescript
interface Props {
  messages: ChatMessage[];
  currentUser: string;
  memberStatusMap?: Record<string, string>;
  replyCounts?: Record<string, number>;
  onReplyClick?: (message: ChatMessage) => void;
}
```

**Step 2: Add new styles**

Add these styles to the `styles` object:

```typescript
messageHoverArea: {
  position: 'relative' as const,
  padding: '6px 0',
  display: 'flex',
  gap: '10px',
  alignItems: 'flex-start',
},
replyButton: {
  position: 'absolute' as const,
  top: '4px',
  right: '4px',
  padding: '2px 8px',
  background: '#334155',
  border: '1px solid #475569',
  borderRadius: '4px',
  color: '#94a3b8',
  fontSize: '11px',
  cursor: 'pointer',
  opacity: 0,
  transition: 'opacity 0.15s',
},
replyBadge: {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '4px',
  marginTop: '4px',
  padding: '2px 8px',
  background: 'transparent',
  border: 'none',
  color: '#3b82f6',
  fontSize: '12px',
  cursor: 'pointer',
  fontWeight: 600,
},
```

**Step 3: Update the component to use hover state and reply features**

Replace the component body with hover support. Since inline styles can't handle `:hover` on children, use state for the hovered message index:

Add a `hoveredIndex` state inside the component:

```typescript
const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
```

Add `useState` to the React import.

Update the message map to show reply button on hover and reply count badge:

```tsx
{messages.map((msg, i) => {
  const color = getColor(msg.user);
  const isOwn = msg.user === currentUser;
  const userStatus = memberStatusMap?.[msg.user];
  const dotColor = userStatus ? STATUS_COLORS[userStatus] || STATUS_COLORS.offline : undefined;
  const threadId = `${msg.room}-${msg.timestamp}`;
  const replyCount = (replyCounts?.[threadId] || 0) + (msg.replyCount || 0);
  const isHovered = hoveredIndex === i;
  return (
    <div
      key={`${msg.timestamp}-${i}`}
      style={styles.messageHoverArea}
      onMouseEnter={() => setHoveredIndex(i)}
      onMouseLeave={() => setHoveredIndex(null)}
    >
      <div style={styles.avatarWrapper}>
        <div style={{ ...styles.avatar, background: color }}>
          {msg.user.charAt(0).toUpperCase()}
        </div>
        {dotColor && <span style={{ ...styles.statusDot, backgroundColor: dotColor }} />}
      </div>
      <div style={styles.content}>
        <div style={styles.header}>
          <span style={{ ...styles.username, color: isOwn ? '#60a5fa' : color }}>
            {msg.user}
          </span>
          <span style={styles.time}>{formatTime(msg.timestamp)}</span>
        </div>
        <div style={styles.text}>{msg.text}</div>
        {replyCount > 0 && (
          <button
            style={styles.replyBadge}
            onClick={() => onReplyClick?.(msg)}
          >
            {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
          </button>
        )}
      </div>
      {isHovered && !msg.threadId && onReplyClick && (
        <button
          style={{ ...styles.replyButton, opacity: 1 }}
          onClick={() => onReplyClick(msg)}
        >
          Reply
        </button>
      )}
    </div>
  );
})}
```

**Step 4: Update the component signature**

```typescript
export const MessageList: React.FC<Props> = ({ messages, currentUser, memberStatusMap, replyCounts, onReplyClick }) => {
```

**Step 5: Verify types compile**

Run: `cd web && npx tsc --noEmit`
Expected: No errors.

**Step 6: Commit**

```bash
git add web/src/components/MessageList.tsx
git commit -m "feat(message-list): add reply button on hover and reply count badges"
```

---

### Task 8: Create ThreadPanel component

**Files:**
- Create: `web/src/components/ThreadPanel.tsx`

**Step 1: Create the ThreadPanel component**

Create `web/src/components/ThreadPanel.tsx`:

```tsx
import React, { useEffect, useState, useCallback } from 'react';
import { useNats } from '../providers/NatsProvider';
import { useAuth } from '../providers/AuthProvider';
import { useMessages } from '../providers/MessageProvider';
import { MessageList } from './MessageList';
import type { ChatMessage } from '../types';

interface Props {
  room: string;
  threadId: string;
  parentMessage: ChatMessage;
  onClose: () => void;
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    width: '400px',
    borderLeft: '1px solid #334155',
    display: 'flex',
    flexDirection: 'column',
    background: '#0f172a',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 16px',
    borderBottom: '1px solid #1e293b',
    background: '#0f172a',
  },
  headerTitle: {
    fontSize: '15px',
    fontWeight: 700,
    color: '#f1f5f9',
  },
  closeBtn: {
    background: 'transparent',
    border: 'none',
    color: '#64748b',
    fontSize: '18px',
    cursor: 'pointer',
    padding: '4px 8px',
    borderRadius: '4px',
  },
  parentSection: {
    padding: '12px 16px',
    borderBottom: '1px solid #1e293b',
    background: '#1e293b',
  },
  parentUser: {
    fontWeight: 700,
    fontSize: '13px',
    color: '#e2e8f0',
    marginBottom: '4px',
  },
  parentText: {
    fontSize: '14px',
    color: '#cbd5e1',
    lineHeight: 1.5,
    wordBreak: 'break-word' as const,
  },
  parentTime: {
    fontSize: '11px',
    color: '#64748b',
    marginTop: '4px',
  },
  repliesSection: {
    flex: 1,
    overflowY: 'auto' as const,
  },
  inputArea: {
    padding: '12px 16px',
    borderTop: '1px solid #334155',
    background: '#1e293b',
  },
  form: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '8px',
  },
  inputRow: {
    display: 'flex',
    gap: '8px',
  },
  input: {
    flex: 1,
    padding: '8px 12px',
    background: '#0f172a',
    border: '1px solid #334155',
    borderRadius: '6px',
    color: '#e2e8f0',
    fontSize: '13px',
    outline: 'none',
  },
  sendBtn: {
    padding: '8px 16px',
    background: '#3b82f6',
    border: 'none',
    borderRadius: '6px',
    color: '#fff',
    fontWeight: 600,
    fontSize: '13px',
    cursor: 'pointer',
  },
  disabledBtn: {
    opacity: 0.5,
    cursor: 'not-allowed',
  },
  broadcastRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    fontSize: '12px',
    color: '#94a3b8',
  },
};

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export const ThreadPanel: React.FC<Props> = ({ room, threadId, parentMessage, onClose }) => {
  const { nc, connected, sc } = useNats();
  const { userInfo } = useAuth();
  const { getThreadMessages } = useMessages();
  const [historyMessages, setHistoryMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState('');
  const [broadcast, setBroadcast] = useState(false);

  // Fetch thread history on mount
  useEffect(() => {
    if (!nc || !connected) return;

    const historySubject = `chat.history.${room}.thread.${threadId}`;
    nc.request(historySubject, sc.encode(''), { timeout: 5000 })
      .then((reply) => {
        try {
          const history = JSON.parse(sc.decode(reply.data)) as ChatMessage[];
          if (history.length > 0) {
            setHistoryMessages(history);
          }
        } catch {
          console.log('[Thread] Failed to parse thread history');
        }
      })
      .catch((err) => {
        console.log('[Thread] Thread history request failed:', err);
      });
  }, [nc, connected, sc, room, threadId]);

  // Combine history with live thread messages
  const liveMessages = getThreadMessages(threadId);
  const allReplies = React.useMemo(() => {
    if (historyMessages.length === 0) return liveMessages;
    if (liveMessages.length === 0) return historyMessages;

    const lastHistoryTs = historyMessages[historyMessages.length - 1]?.timestamp || 0;
    const newLiveMessages = liveMessages.filter((m) => m.timestamp > lastHistoryTs);
    return [...historyMessages, ...newLiveMessages];
  }, [historyMessages, liveMessages]);

  // Send thread reply
  const handleSend = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || !nc || !connected || !userInfo) return;

    const msg: ChatMessage = {
      user: userInfo.username,
      text: trimmed,
      timestamp: Date.now(),
      room,
      threadId,
      parentTimestamp: parentMessage.timestamp,
      broadcast,
    };

    const threadSubject = `chat.${room}.thread.${threadId}`;
    nc.publish(threadSubject, sc.encode(JSON.stringify(msg)));

    // If broadcast, also publish to main room timeline
    if (broadcast) {
      const roomSubject = `chat.${room}`;
      nc.publish(roomSubject, sc.encode(JSON.stringify(msg)));
    }

    setText('');
  }, [nc, connected, userInfo, text, room, threadId, parentMessage.timestamp, broadcast, sc]);

  return (
    <div style={styles.panel}>
      <div style={styles.header}>
        <span style={styles.headerTitle}>Thread</span>
        <button style={styles.closeBtn} onClick={onClose}>X</button>
      </div>
      <div style={styles.parentSection}>
        <div style={styles.parentUser}>{parentMessage.user}</div>
        <div style={styles.parentText}>{parentMessage.text}</div>
        <div style={styles.parentTime}>{formatTime(parentMessage.timestamp)}</div>
      </div>
      <div style={styles.repliesSection}>
        <MessageList
          messages={allReplies}
          currentUser={userInfo?.username || ''}
        />
      </div>
      <div style={styles.inputArea}>
        <form style={styles.form} onSubmit={handleSend}>
          <div style={styles.inputRow}>
            <input
              style={styles.input}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Reply in thread..."
              disabled={!connected}
              autoFocus
            />
            <button
              type="submit"
              style={{
                ...styles.sendBtn,
                ...(!connected || !text.trim() ? styles.disabledBtn : {}),
              }}
              disabled={!connected || !text.trim()}
            >
              Reply
            </button>
          </div>
          <label style={styles.broadcastRow}>
            <input
              type="checkbox"
              checked={broadcast}
              onChange={(e) => setBroadcast(e.target.checked)}
            />
            Also send to #{room}
          </label>
        </form>
      </div>
    </div>
  );
};
```

**Step 2: Verify types compile**

Run: `cd web && npx tsc --noEmit`
Expected: No errors.

**Step 3: Commit**

```bash
git add web/src/components/ThreadPanel.tsx
git commit -m "feat(thread-panel): add ThreadPanel component with history, replies, and broadcast option"
```

---

### Task 9: Update ChatRoom to render ThreadPanel and pass reply handlers

**Files:**
- Modify: `web/src/components/ChatRoom.tsx`

**Step 1: Import ThreadPanel and useMessages thread fields**

Add `ThreadPanel` import:

```typescript
import { ThreadPanel } from './ThreadPanel';
```

Update the `useMessages` destructure to include thread-related fields:

```typescript
const { getMessages, joinRoom, markAsRead, onlineUsers, replyCounts, activeThread, openThread, closeThread } = useMessages();
```

**Step 2: Add layout wrapper style**

Add a style for the horizontal layout (message area + thread panel):

```typescript
outerContainer: {
  flex: 1,
  display: 'flex',
  overflow: 'hidden',
},
innerContainer: {
  flex: 1,
  display: 'flex',
  flexDirection: 'column' as const,
  overflow: 'hidden',
  minWidth: 0,
},
```

**Step 3: Add reply handler**

Add a reply click handler that opens the thread panel:

```typescript
const handleReplyClick = useCallback((message: ChatMessage) => {
  openThread(room, message);
}, [room, openThread]);
```

Import `ChatMessage`:

```typescript
import type { ChatMessage } from '../types';
```

(This import already exists in the file.)

**Step 4: Update the return JSX**

Wrap the existing layout to include the thread panel beside the message area. The outer div should use flexbox to place the message area and ThreadPanel side by side:

```tsx
return (
  <div style={styles.outerContainer}>
    <div style={styles.innerContainer}>
      <div style={styles.roomHeader}>
        <div style={styles.roomName}># {displayRoom}</div>
        <div style={styles.roomSubject}>subject: {subject}</div>
        {roomMembers.length > 0 && (
          <div style={styles.presenceBar}>
            <span style={styles.presenceIndicator}>
              <span style={{ ...styles.statusDot, backgroundColor: '#22c55e' }} />
              {onlineCount} online
            </span>
            {roomMembers.map((member) => (
              <span key={member.userId} style={styles.memberPill}>
                <span style={{ ...styles.statusDot, backgroundColor: STATUS_COLORS[member.status] || '#64748b' }} />
                {member.userId}
              </span>
            ))}
          </div>
        )}
      </div>
      {(natsError || pubError) && (
        <div style={styles.errorBanner}>
          {natsError || pubError}
        </div>
      )}
      <MessageList
        messages={allMessages}
        currentUser={userInfo?.username || ''}
        memberStatusMap={statusMap}
        replyCounts={replyCounts}
        onReplyClick={handleReplyClick}
      />
      <MessageInput onSend={handleSend} disabled={!connected} room={displayRoom} />
    </div>
    {activeThread && activeThread.room === room && (
      <ThreadPanel
        room={room}
        threadId={activeThread.threadId}
        parentMessage={activeThread.parentMessage}
        onClose={closeThread}
      />
    )}
  </div>
);
```

Remove the old `container` style usage from the outermost div (it used to be `styles.container` which has `flex: 1, flexDirection: column`). The new `outerContainer` is the flex row, and `innerContainer` is the flex column.

**Step 5: Verify types compile**

Run: `cd web && npx tsc --noEmit`
Expected: No errors.

**Step 6: Commit**

```bash
git add web/src/components/ChatRoom.tsx
git commit -m "feat(chat-room): integrate ThreadPanel side panel with reply handlers"
```

---

### Task 10: Filter thread-only messages from main timeline

**Files:**
- Modify: `web/src/components/ChatRoom.tsx`

**Step 1: Filter out thread-only replies from allMessages**

In the `allMessages` useMemo computation, add filtering so thread replies that weren't broadcast don't appear in the main timeline:

```typescript
const allMessages = React.useMemo(() => {
  let combined: ChatMessage[];
  if (historyMessages.length === 0) combined = liveMessages;
  else if (liveMessages.length === 0) combined = historyMessages;
  else {
    const lastHistoryTs = historyMessages[historyMessages.length - 1]?.timestamp || 0;
    const newLiveMessages = liveMessages.filter((m) => m.timestamp > lastHistoryTs);
    combined = [...historyMessages, ...newLiveMessages];
  }
  // Filter out thread-only replies (messages with threadId that aren't broadcast)
  return combined.filter((m) => !m.threadId || m.broadcast);
}, [historyMessages, liveMessages]);
```

**Step 2: Verify types compile**

Run: `cd web && npx tsc --noEmit`
Expected: No errors.

**Step 3: Commit**

```bash
git add web/src/components/ChatRoom.tsx
git commit -m "feat(chat-room): filter thread-only replies from main timeline"
```

---

### Task 11: Build and verify all services

**Step 1: Verify all Go services compile**

Run: `cd persist-worker && go build -o /dev/null .`
Run: `cd history-service && go build -o /dev/null .`
Run: `cd fanout-service && go build -o /dev/null .`
Expected: All three succeed.

**Step 2: Verify frontend compiles**

Run: `cd web && npx tsc --noEmit`
Expected: No errors.

**Step 3: Rebuild and restart all services**

Run: `docker compose up -d --build`
Expected: All services start successfully.

**Step 4: Verify thread columns in database**

Run: `docker compose exec postgres psql -U chat -d chatdb -c "\d messages"`
Expected: Shows `thread_id`, `parent_timestamp`, `broadcast` columns.

**Step 5: Smoke test**

1. Open browser to `http://localhost:3000`
2. Log in as alice, join "general" room
3. Send a message in general
4. Hover over the message — "Reply" button should appear
5. Click "Reply" — ThreadPanel should open on the right
6. Type a reply, send — reply appears in thread panel, main timeline shows reply count badge
7. Check "Also send to #general" and send another reply — reply appears in both thread panel and main timeline
8. Close thread panel — badge should show reply count

**Step 6: Final commit**

```bash
git add -A
git commit -m "feat: add Slack-style message threading with side panel, reply counts, and broadcast option"
```

---

## Files Summary

| Task | Action | File | Purpose |
|------|--------|------|---------|
| 1 | MODIFY | `postgres/init.sql` | Add thread_id, parent_timestamp, broadcast columns |
| 2 | MODIFY | `web/src/types.ts` | Add thread fields to ChatMessage |
| 3 | MODIFY | `persist-worker/main.go` | Persist thread fields, widen stream to chat.> |
| 4 | MODIFY | `history-service/main.go` | Thread history endpoint, reply counts |
| 5 | MODIFY | `fanout-service/main.go` | Widen to chat.> for thread fan-out |
| 6 | MODIFY | `web/src/providers/MessageProvider.tsx` | Thread routing, reply counts, thread state |
| 7 | MODIFY | `web/src/components/MessageList.tsx` | Reply button, reply count badges |
| 8 | CREATE | `web/src/components/ThreadPanel.tsx` | Thread side panel with history + input |
| 9 | MODIFY | `web/src/components/ChatRoom.tsx` | Side panel layout, reply handlers |
| 10 | MODIFY | `web/src/components/ChatRoom.tsx` | Filter thread-only from main timeline |
| 11 | — | All services | Build verification + smoke test |
