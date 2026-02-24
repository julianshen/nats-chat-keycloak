# Unified Rooms + Scalability Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Unify room/channel into a single "Room" concept with a `type` enum (public/private/dm), and add per-room NATS multicast + presence diffs for scalability to 10K users/room.

**Architecture:** Replace per-user delivery (`deliver.{userId}.chat.{room}`) with per-room subscriptions (`room.msg.{room}`) for chat messages, keeping per-user delivery for DMs, threads, translations, app events, and presence. Rename all `channel.*` NATS subjects to `room.*` management subjects. Replace presence full-snapshot broadcasts with diffs. Rename DB tables `channels`→`rooms`, `channel_members`→`room_members`.

**Tech Stack:** Go (room-service, fanout-service, presence-service), React 18 + TypeScript (web), PostgreSQL, NATS 2.12 JetStream KV, nats.ws

---

## Summary of Changes

| Layer | Before | After |
|-------|--------|-------|
| Chat delivery (hot path) | `chat.{room}` → fanout → N × `deliver.{user}.chat.{room}` | `chat.{room}` → fanout → 1 × `room.msg.{room}` (NATS multicast) |
| Presence delivery | `presence.event.{room}` → fanout → N × `deliver.{user}.presence.{room}` (full snapshot) | `room.presence.{room}` (diff: `{action, userId, status}`) — NATS multicast |
| NATS subjects | `channel.create/list/info/invite/kick/leave` | `room.create/room.list/room.info/room.invite/room.kick/room.leave` |
| DB tables | `channels`, `channel_members` | `rooms`, `room_members` |
| Frontend type | `ChannelInfo` | `RoomInfo` |
| Browser subscriptions | 1 × `deliver.{user}.>` | `deliver.{user}.>` + N × `room.msg.{room}` + N × `room.presence.{room}` |

## File Inventory

### Backend (Go)

| File | Action | Purpose |
|------|--------|---------|
| `room-service/main.go` | Modify | Rename channel→room subjects, types, DB queries; publish to `room.msg.*` |
| `fanout-service/main.go` | Modify | `chat.>` handler publishes to `room.msg.{room}` instead of per-user; remove `presence.event.*` handler |
| `presence-service/main.go` | Modify | Publish diffs to `room.presence.{room}` instead of full snapshots to `presence.event.{room}` |
| `auth-service/permissions.go` | Modify | Rename `channel.*` → `room.*` subjects; add `room.msg.*` + `room.presence.*` sub permissions |

### Frontend (TypeScript/React)

| File | Action | Purpose |
|------|--------|---------|
| `web/src/types.ts` | Modify | Rename `ChannelInfo` → `RoomInfo` |
| `web/src/providers/MessageProvider.tsx` | Modify | Subscribe `room.msg.{room}` + `room.presence.{room}` per room; handle presence diffs |
| `web/src/App.tsx` | Modify | Rename `channel.*` → `room.*` subjects |
| `web/src/components/ChatRoom.tsx` | Modify | Rename `channel.*` → `room.*` subjects |
| `web/src/components/RoomSelector.tsx` | Modify | Rename `ChannelInfo` → `RoomInfo` prop types |
| `web/src/components/ChannelCreateModal.tsx` | Rename → `RoomCreateModal.tsx` | Rename component and update labels |

### Infrastructure

| File | Action | Purpose |
|------|--------|---------|
| `k8s/base/postgres/configmap.yaml` | Modify | Rename `channels`→`rooms`, `channel_members`→`room_members`, `channel_name`→`room_name` |
| `postgres/init.sql` | Modify | Same renames for local Docker Compose |
| `CLAUDE.md` | Modify | Update subject docs and architecture sections |

---

## Task 1: Rename DB tables (channels → rooms, channel_members → room_members)

**Files:**
- Modify: `k8s/base/postgres/configmap.yaml:179-196`
- Modify: `postgres/init.sql` (same block)

The DB tables are created by `init.sql` (both Docker Compose and K8s). Rename tables and columns to match the unified "room" concept.

**Step 1: Edit `k8s/base/postgres/configmap.yaml`**

Replace the `-- Private channels` block (lines 179-196) with:

```sql
-- Private rooms (rooms with access control)
CREATE TABLE IF NOT EXISTS rooms (
    name         TEXT PRIMARY KEY,
    display_name TEXT,
    creator      TEXT NOT NULL,
    type         TEXT NOT NULL DEFAULT 'private',  -- public | private | dm
    created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS room_members (
    room_name    TEXT NOT NULL REFERENCES rooms(name) ON DELETE CASCADE,
    username     TEXT NOT NULL,
    role         TEXT NOT NULL DEFAULT 'member',  -- owner | admin | member
    invited_by   TEXT,
    joined_at    TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (room_name, username)
);
CREATE INDEX IF NOT EXISTS idx_room_members_user ON room_members(username);
```

**Step 2: Edit `postgres/init.sql`**

Apply the exact same rename. Find the `-- Private channels` block and replace with the same SQL as above.

**Step 3: Verify both files have the same SQL**

Run: `diff <(grep -A 20 "Private rooms" k8s/base/postgres/configmap.yaml) <(grep -A 20 "Private rooms" postgres/init.sql)` — should produce minimal formatting diff only.

**Step 4: Also rename `channel_apps` → `room_apps` in both files**

The `channel_apps` table (lines ~109-116 in configmap.yaml) references `room` already but the table name says "channel". Rename:

```sql
-- Before
CREATE TABLE IF NOT EXISTS channel_apps (
    room            TEXT NOT NULL,
    app_id          TEXT NOT NULL REFERENCES apps(id),
    ...
-- After
CREATE TABLE IF NOT EXISTS room_apps (
    room            TEXT NOT NULL,
    app_id          TEXT NOT NULL REFERENCES apps(id),
    ...
```

**Step 5: Update `app-registry-service/main.go`**

Search for `channel_apps` and replace with `room_apps` in all SQL queries.

**Step 6: Commit**

```bash
git add k8s/base/postgres/configmap.yaml postgres/init.sql app-registry-service/main.go
git commit -m "refactor: rename channels/channel_members DB tables to rooms/room_members"
```

---

## Task 2: Rename NATS subjects and types in room-service

**Files:**
- Modify: `room-service/main.go`

Rename all `channel.*` NATS subscriptions to `room.*` management subjects, and update DB queries to use `rooms`/`room_members` tables.

**Step 1: Rename types**

Replace the channel-specific types with unified room types:

```go
// Before
type Channel struct {
    Name        string          `json:"name"`
    DisplayName string          `json:"displayName,omitempty"`
    Creator     string          `json:"creator"`
    IsPrivate   bool            `json:"isPrivate"`
    CreatedAt   string          `json:"createdAt,omitempty"`
    Members     []ChannelMember `json:"members,omitempty"`
    MemberCount int             `json:"memberCount,omitempty"`
}

type ChannelMember struct {
    Username string `json:"username"`
    Role     string `json:"role"`
}

// After
type RoomInfo struct {
    Name        string       `json:"name"`
    DisplayName string       `json:"displayName,omitempty"`
    Creator     string       `json:"creator"`
    Type        string       `json:"type"`
    CreatedAt   string       `json:"createdAt,omitempty"`
    Members     []RoomMember `json:"members,omitempty"`
    MemberCount int          `json:"memberCount,omitempty"`
}

type RoomMember struct {
    Username string `json:"username"`
    Role     string `json:"role"`
}
```

**Step 2: Rename request types**

No functional change, just naming consistency. The request structs can stay the same (`createRequest`, `listRequest`, etc.) as they're internal.

**Step 3: Rename DB queries**

Replace all SQL references in every handler:
- `channels` → `rooms`
- `channel_members` → `room_members`
- `channel_name` → `room_name`
- `is_private` → check `type = 'private'`
- `c.is_private` → `c.type`

In `checkChannelMembership` (rename to `checkRoomAccess`):
```go
// Before
err := db.QueryRowContext(ctx, "SELECT is_private FROM channels WHERE name = $1", room).Scan(&isPrivate)
...
db.QueryRowContext(ctx, "SELECT COUNT(*) FROM channel_members WHERE channel_name = $1 AND username = $2", room, userId)

// After
var roomType string
err := db.QueryRowContext(ctx, "SELECT type FROM rooms WHERE name = $1", room).Scan(&roomType)
...
isPrivate := roomType == "private"
...
db.QueryRowContext(ctx, "SELECT COUNT(*) FROM room_members WHERE room_name = $1 AND username = $2", room, userId)
```

In `channel.create` handler (rename to `room.create`):
```go
// Before
"INSERT INTO channels (name, display_name, creator) VALUES ($1, $2, $3)"
"INSERT INTO channel_members (channel_name, username, role) VALUES ($1, $2, 'owner')"

// After
"INSERT INTO rooms (name, display_name, creator, type) VALUES ($1, $2, $3, 'private')"
"INSERT INTO room_members (room_name, username, role) VALUES ($1, $2, 'owner')"
```

Apply the same pattern to all other handlers (`list`, `info`, `invite`, `kick`, `leave`).

**Step 4: Rename NATS subjects**

Replace all subscription subjects:
```go
// Before                           // After
"channel.create"                → "room.create"
"channel.list"                  → "room.list"
"channel.info.*"                → "room.info.*"
"channel.invite.*"              → "room.invite.*"
"channel.kick.*"                → "room.kick.*"
"channel.leave.*"               → "room.leave.*"
```

Also update all `strings.TrimPrefix` calls:
```go
// Before
channelName := strings.TrimPrefix(msg.Subject, "channel.info.")
// After
roomName := strings.TrimPrefix(msg.Subject, "room.info.")
```

**Step 5: Rename `privateChannels` map to `privateRooms`**

```go
// Before
var privateChannelsMu sync.RWMutex
privateChannels := make(map[string]bool)
rows, err := db.Query("SELECT name FROM channels WHERE is_private = true")

// After
var privateRoomsMu sync.RWMutex
privateRooms := make(map[string]bool)
rows, err := db.Query("SELECT name FROM rooms WHERE type = 'private'")
```

Update all references throughout the file.

**Step 6: Rename metrics**

```go
// Before
channelReqCounter, _ := meter.Int64Counter("channel_requests_total", ...)
channelReqDuration, _ := meter.Float64Histogram("channel_request_duration_seconds", ...)

// After
roomReqCounter, _ := meter.Int64Counter("room_requests_total", ...)
roomReqDuration, _ := meter.Float64Histogram("room_request_duration_seconds", ...)
```

**Step 7: Update span names and log messages**

Replace all `"channel."` prefixed span names with `"room."`:
- `"channel.create"` → `"room.create"`
- `"channel.info"` → `"room.info"`
- etc.

Replace log messages: `"Channel created"` → `"Room created"`, etc.

Replace span attribute names: `attribute.String("channel.name", ...)` → `attribute.String("room.name", ...)`

**Step 8: Build and verify**

Run: `cd room-service && go build -o /dev/null .`
Expected: success (exit 0)

**Step 9: Commit**

```bash
git add room-service/main.go
git commit -m "refactor: rename channel.* to room.* NATS subjects and DB queries in room-service"
```

---

## Task 3: Add per-room multicast to fanout-service

**Files:**
- Modify: `fanout-service/main.go`

The `chat.>` handler currently does per-user delivery. Change it to publish a single message to `room.msg.{room}` and let NATS multicast to all subscribers. Keep per-user delivery for threads, admin messages, and app events (these are lower volume or need per-user routing).

**Step 1: Change `chat.>` handler**

```go
// Before (per-user fanout):
_, err = nc.QueueSubscribe("chat.>", "fanout-workers", func(msg *nats.Msg) {
    if strings.HasPrefix(msg.Subject, "chat.history") {
        return
    }
    ctx, span := otelhelper.StartConsumerSpan(context.Background(), msg, "fanout chat message")
    defer span.End()
    start := time.Now()
    remainder := strings.TrimPrefix(msg.Subject, "chat.")
    room := remainder
    if idx := strings.Index(remainder, "."); idx != -1 {
        room = remainder[:idx]
    }
    members := getMembers(ctx, room)
    // ...per-user publish loop
})

// After (per-room multicast):
_, err = nc.QueueSubscribe("chat.>", "fanout-workers", func(msg *nats.Msg) {
    if strings.HasPrefix(msg.Subject, "chat.history") || strings.HasPrefix(msg.Subject, "chat.dms") {
        return
    }
    ctx, span := otelhelper.StartConsumerSpan(context.Background(), msg, "fanout chat message")
    defer span.End()
    start := time.Now()
    remainder := strings.TrimPrefix(msg.Subject, "chat.")
    room := remainder
    if idx := strings.Index(remainder, "."); idx != -1 {
        room = remainder[:idx]
    }

    // Determine if this is a thread message: chat.{room}.thread.{threadId}
    isThread := strings.Contains(remainder, ".thread.")

    if isThread {
        // Thread messages: per-user delivery (thread-only messages go to subscribers of that thread)
        members := getMembers(ctx, room)
        span.SetAttributes(
            attribute.String("chat.room", room),
            attribute.Int("fanout.member_count", len(members)),
            attribute.Bool("fanout.thread", true),
        )
        if len(members) > 0 {
            enqueueFanout(ctx, members, msg.Subject, msg.Data)
        }
        duration := time.Since(start).Seconds()
        fanoutCounter.Add(ctx, int64(len(members)), metric.WithAttributes(attribute.String("room", room)))
        fanoutDuration.Record(ctx, duration, metric.WithAttributes(attribute.String("room", room)))
    } else {
        // Main room messages: publish to room.msg.{room} — NATS multicast to all subscribers
        roomMsgSubject := "room.msg." + room
        otelhelper.TracedPublish(ctx, nc, roomMsgSubject, msg.Data)
        span.SetAttributes(
            attribute.String("chat.room", room),
            attribute.String("fanout.target", roomMsgSubject),
        )
        duration := time.Since(start).Seconds()
        fanoutCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("room", room)))
        fanoutDuration.Record(ctx, duration, metric.WithAttributes(attribute.String("room", room)))
    }
})
```

**Step 2: Remove `presence.event.*` handler**

Delete the entire `nc.QueueSubscribe("presence.event.*", ...)` block (lines 436-456). Presence will now use direct `room.presence.{room}` subjects that clients subscribe to — no fanout needed.

**Step 3: Keep `admin.*` handler as per-user** (unchanged)

Admin messages are low-volume and only go to admin users. Per-user delivery is fine.

**Step 4: Keep `app.>` handler as per-user** (unchanged)

App messages use per-user delivery because they're already scoped to room members. No change needed.

**Step 5: Build and verify**

Run: `cd fanout-service && go build -o /dev/null .`
Expected: success (exit 0)

**Step 6: Commit**

```bash
git add fanout-service/main.go
git commit -m "feat: fanout publishes to room.msg.{room} for NATS multicast, keep per-user for threads/admin/apps"
```

---

## Task 4: Presence diffs instead of full snapshots

**Files:**
- Modify: `presence-service/main.go`

Currently presence-service publishes full `{type, userId, room, members: [...all]}` snapshots to `presence.event.{room}` which fanout-service delivers per-user. Change to publish diffs directly to `room.presence.{room}` (NATS multicast — no fanout needed).

**Step 1: Define new diff event type**

```go
type PresenceDiffEvent struct {
    Action string `json:"action"` // "online", "offline", "status"
    UserId string `json:"userId"`
    Status string `json:"status,omitempty"` // for "status" action
}
```

**Step 2: Replace `publishPresenceSnapshot` with `publishPresenceDiff`**

Find all places where presence snapshots are published (search for `"presence.event."` in the file). Replace each with a diff publish:

```go
// Before (publishing full snapshot to presence.event.{room}):
members := /* build full member list with liveness */
data, _ := json.Marshal(map[string]interface{}{
    "type": "presence", "userId": userId, "room": room, "members": members,
})
nc.Publish("presence.event."+room, data)

// After (publishing diff to room.presence.{room}):
diff := PresenceDiffEvent{Action: "online", UserId: userId, Status: "online"}
data, _ := json.Marshal(diff)
nc.Publish("room.presence."+room, data)
```

Do this for all presence event publishers:
- **Heartbeat handler** (user comes online): `Action: "online"`, `Status: "online"`
- **Disconnect handler** (user goes offline): `Action: "offline"`, `UserId: userId`
- **Status update handler** (user changes status): `Action: "status"`, `UserId: userId, Status: newStatus`
- **KV watcher** (connection expired): `Action: "offline"`, `UserId: userId`

**Step 3: Keep `presence.room.*` request/reply for initial load**

The request/reply handler for `presence.room.*` still returns a full snapshot when a client first joins a room. This is needed for initial state. No change required.

**Step 4: Build and verify**

Run: `cd presence-service && go build -o /dev/null .`
Expected: success (exit 0)

**Step 5: Commit**

```bash
git add presence-service/main.go
git commit -m "feat: presence publishes diffs to room.presence.{room} instead of full snapshots"
```

---

## Task 5: Update auth-service permissions

**Files:**
- Modify: `auth-service/permissions.go`

Rename `channel.*` subjects to `room.*` and add `room.msg.*` + `room.presence.*` subscribe permissions.

**Step 1: Rename subjects in admin permissions**

```go
// Before (in admin block):
"channel.create",
"channel.list",
"channel.info.*",
"channel.invite.*",
"channel.kick.*",
"channel.leave.*",

// After:
"room.create",
"room.list",
"room.info.*",
"room.invite.*",
"room.kick.*",
"room.leave.*",
```

**Step 2: Add `room.msg.*` and `room.presence.*` to Sub.Allow**

Clients need to subscribe to per-room subjects for chat messages and presence diffs:

```go
// Before:
perms.Sub.Allow = jwt.StringList{
    deliverSubject,
    "_INBOX.>",
}

// After:
perms.Sub.Allow = jwt.StringList{
    deliverSubject,
    "room.msg.*",
    "room.presence.*",
    "_INBOX.>",
}
```

Apply to all three role blocks (admin, user, no-role).

**Step 3: Rename in user permissions** (same as admin minus `admin.>`)

**Step 4: Rename in no-role permissions**

Only `room.list` and `room.info.*` (read-only users can't create/invite/kick/leave).

**Step 5: Build and verify**

Run: `cd auth-service && go build -o /dev/null .`
Expected: success (exit 0)

**Step 6: Commit**

```bash
git add auth-service/permissions.go
git commit -m "refactor: rename channel.* to room.* in auth permissions, add room.msg/presence sub"
```

---

## Task 6: Rename frontend types and ChannelCreateModal

**Files:**
- Modify: `web/src/types.ts`
- Rename: `web/src/components/ChannelCreateModal.tsx` → `web/src/components/RoomCreateModal.tsx`

**Step 1: Rename `ChannelInfo` to `RoomInfo` in types.ts**

```typescript
// Before
export interface ChannelInfo {
  name: string;
  displayName?: string;
  creator: string;
  isPrivate: boolean;
  members?: Array<{ username: string; role: string }>;
  memberCount?: number;
}

// After
export interface RoomInfo {
  name: string;
  displayName?: string;
  creator: string;
  type: string;  // "public" | "private" | "dm"
  members?: Array<{ username: string; role: string }>;
  memberCount?: number;
}
```

**Step 2: Rename ChannelCreateModal**

Create `web/src/components/RoomCreateModal.tsx` with same content but:
- Rename component: `ChannelCreateModal` → `RoomCreateModal`
- Update title text: `"Create Private Channel"` → `"Create Private Room"`
- Update hint text: `"Channel name is required"` → `"Room name is required"`, etc.

Delete `web/src/components/ChannelCreateModal.tsx`.

**Step 3: Commit**

```bash
git add web/src/types.ts web/src/components/RoomCreateModal.tsx
git rm web/src/components/ChannelCreateModal.tsx
git commit -m "refactor: rename ChannelInfo to RoomInfo, ChannelCreateModal to RoomCreateModal"
```

---

## Task 7: Update MessageProvider for per-room subscriptions

**Files:**
- Modify: `web/src/providers/MessageProvider.tsx`

This is the biggest frontend change. The provider needs to:
1. Subscribe to `room.msg.{room}` when joining a room (for chat messages)
2. Subscribe to `room.presence.{room}` when joining a room (for presence diffs)
3. Apply presence diffs incrementally instead of replacing full snapshots
4. Keep `deliver.{userId}.>` for threads, translations, admin, apps, DMs

**Step 1: Add per-room subscription tracking**

```typescript
// Add refs to track per-room subscriptions
const roomSubsRef = useRef<Map<string, { msgSub: Subscription; presSub: Subscription }>>(new Map());
```

**Step 2: Modify `joinRoom` to subscribe to per-room subjects**

```typescript
const joinRoom = useCallback((room: string) => {
  if (!nc || !connected || !userInfo) return;

  const memberKey = roomToMemberKey(room);
  if (joinedRoomsRef.current.has(memberKey)) return;
  joinedRoomsRef.current.add(memberKey);

  // Publish join event (unchanged)
  const joinSubject = `room.join.${memberKey}`;
  const payload = JSON.stringify({ userId: userInfo.username });
  const { headers: joinHdr } = tracedHeaders();
  nc.publish(joinSubject, sc.encode(payload), { headers: joinHdr });

  // Subscribe to room.msg.{memberKey} for chat messages
  const msgSub = nc.subscribe(`room.msg.${memberKey}`);
  // Subscribe to room.presence.{memberKey} for presence diffs
  const presSub = nc.subscribe(`room.presence.${memberKey}`);

  roomSubsRef.current.set(memberKey, { msgSub, presSub });

  // Process room messages
  (async () => {
    try {
      for await (const msg of msgSub) {
        try {
          const data = JSON.parse(sc.decode(msg.data)) as ChatMessage;
          const roomKey = room;

          // Handle edit/delete/react actions (same logic as deliver handler)
          if (data.action === 'edit') { /* ... same edit logic ... */ continue; }
          if (data.action === 'delete') { /* ... same delete logic ... */ continue; }
          if (data.action === 'react' && data.emoji && data.targetUser) { /* ... same react logic ... */ continue; }

          setMessagesByRoom((prev) => {
            const existing = prev[roomKey] || [];
            return { ...prev, [roomKey]: [...existing.slice(-(MAX_MESSAGES_PER_ROOM - 1)), data] };
          });

          if (roomKey !== activeRoomRef.current && data.user !== '__system__') {
            setUnreadCounts((prev) => ({ ...prev, [roomKey]: (prev[roomKey] || 0) + 1 }));
            if (data.mentions?.includes(userInfo.username)) {
              setMentionCounts((prev) => ({ ...prev, [roomKey]: (prev[roomKey] || 0) + 1 }));
            }
          }
        } catch { /* ignore malformed */ }
      }
    } catch (err) {
      console.log(`[Messages] room.msg.${memberKey} subscription ended:`, err);
    }
  })();

  // Process presence diffs
  (async () => {
    try {
      for await (const msg of presSub) {
        try {
          const diff = JSON.parse(sc.decode(msg.data)) as {
            action: string; userId: string; status?: string;
          };
          const presenceRoomKey = memberKey === '__admin__chat' ? '__admin__' : room;

          setOnlineUsers((prev) => {
            const current = prev[presenceRoomKey] || [];
            switch (diff.action) {
              case 'online':
              case 'status': {
                const existing = current.findIndex(m => m.userId === diff.userId);
                const member = { userId: diff.userId, status: diff.status || 'online' };
                if (existing >= 0) {
                  const updated = [...current];
                  updated[existing] = member;
                  return { ...prev, [presenceRoomKey]: updated };
                }
                return { ...prev, [presenceRoomKey]: [...current, member] };
              }
              case 'offline': {
                return { ...prev, [presenceRoomKey]: current.filter(m => m.userId !== diff.userId) };
              }
              default:
                return prev;
            }
          });
        } catch { /* ignore */ }
      }
    } catch (err) {
      console.log(`[Presence] room.presence.${memberKey} subscription ended:`, err);
    }
  })();

  // Request initial presence (unchanged)
  const { headers: presQHdr } = tracedHeaders();
  nc.request(`presence.room.${memberKey}`, sc.encode(''), { timeout: 5000, headers: presQHdr })
    .then((reply) => {
      try {
        const members = JSON.parse(sc.decode(reply.data)) as PresenceMember[];
        setOnlineUsers((prev) => ({ ...prev, [room]: members }));
      } catch { /* ... */ }
    })
    .catch(() => { /* ... */ });
}, [nc, connected, userInfo, sc]);
```

**Step 3: Modify `leaveRoom` to unsubscribe from per-room subjects**

```typescript
const leaveRoom = useCallback((room: string) => {
  if (!nc || !connected || !userInfo) return;

  const memberKey = roomToMemberKey(room);
  if (!joinedRoomsRef.current.has(memberKey)) return;
  joinedRoomsRef.current.delete(memberKey);

  // Unsubscribe from per-room subjects
  const subs = roomSubsRef.current.get(memberKey);
  if (subs) {
    subs.msgSub.unsubscribe();
    subs.presSub.unsubscribe();
    roomSubsRef.current.delete(memberKey);
  }

  // Publish leave event (unchanged)
  const leaveSubject = `room.leave.${memberKey}`;
  const payload = JSON.stringify({ userId: userInfo.username });
  const { headers: leaveHdr } = tracedHeaders();
  nc.publish(leaveSubject, sc.encode(payload), { headers: leaveHdr });
}, [nc, connected, userInfo, sc]);
```

**Step 4: Simplify the `deliver.{userId}.>` handler**

Remove the `chat`/`admin` subject handling from the deliver subscription — those now come via `room.msg.*`. The deliver subscription only handles:
- `presence` → **remove** (now via `room.presence.*`)
- `translate` → keep
- `app` → keep
- `chat.{room}.thread.{threadId}` → keep (thread messages still per-user)
- `admin.*` → keep (admin messages still per-user)

**Step 5: Clean up on unmount / reconnect**

In the cleanup function of the `useEffect` that sets up the deliver subscription, also unsubscribe all per-room subs:

```typescript
return () => {
  clearInterval(heartbeatInterval);
  sub.unsubscribe();
  subRef.current = null;
  // Clean up per-room subscriptions
  for (const [, subs] of roomSubsRef.current) {
    subs.msgSub.unsubscribe();
    subs.presSub.unsubscribe();
  }
  roomSubsRef.current.clear();
};
```

**Step 6: Build and verify**

Run: `cd web && npx tsc --noEmit`
Expected: success (exit 0)

**Step 7: Commit**

```bash
git add web/src/providers/MessageProvider.tsx
git commit -m "feat: subscribe to room.msg.{room} and room.presence.{room} per room, apply presence diffs"
```

---

## Task 8: Update App.tsx — rename channel.* to room.* subjects

**Files:**
- Modify: `web/src/App.tsx`

**Step 1: Rename imports**

```typescript
// Before
import type { ChannelInfo } from './types';
// After
import type { RoomInfo } from './types';
```

**Step 2: Rename state**

```typescript
// Before
const [privateChannels, setPrivateChannels] = useState<ChannelInfo[]>([]);
// After
const [privateRooms, setPrivateRooms] = useState<RoomInfo[]>([]);
```

**Step 3: Rename NATS subjects in fetch**

```typescript
// Before
nc.request('channel.list', sc.encode(JSON.stringify({ user: userInfo.username })), { timeout: 5000 })
  .then((reply) => {
    const channels = JSON.parse(sc.decode(reply.data)) as ChannelInfo[];
    setPrivateChannels(channels);
    channels.forEach((ch) => joinRoom(ch.name));
  })

// After
nc.request('room.list', sc.encode(JSON.stringify({ user: userInfo.username })), { timeout: 5000 })
  .then((reply) => {
    const rooms = JSON.parse(sc.decode(reply.data)) as RoomInfo[];
    setPrivateRooms(rooms);
    rooms.forEach((r) => joinRoom(r.name));
  })
```

**Step 4: Rename `handleCreateChannel` to `handleCreateRoom`**

```typescript
// Before
nc.request('channel.create', sc.encode(JSON.stringify({ name, displayName, user: userInfo.username })), ...)
// After
nc.request('room.create', sc.encode(JSON.stringify({ name, displayName, user: userInfo.username })), ...)
```

**Step 5: Rename auto-discovery**

```typescript
// Before
nc.request(`channel.info.${room}`, sc.encode(''), { timeout: 3000 })
  .then((reply) => {
    const ch = JSON.parse(sc.decode(reply.data)) as ChannelInfo;
    if (ch.isPrivate && !(ch as any).error) {
      setPrivateChannels(...)

// After
nc.request(`room.info.${room}`, sc.encode(''), { timeout: 3000 })
  .then((reply) => {
    const r = JSON.parse(sc.decode(reply.data)) as RoomInfo;
    if (r.type === 'private' && !(r as any).error) {
      setPrivateRooms(...)
```

**Step 6: Update prop names passed to children**

```tsx
// Before
<RoomSelector privateChannels={privateChannels} onCreateChannel={handleCreateChannel} />
<ChatRoom isPrivateChannel={privateChannels.some((c) => c.name === activeRoom)} onChannelRemoved={handleChannelRemoved} />

// After
<RoomSelector privateRooms={privateRooms} onCreateRoom={handleCreateRoom} />
<ChatRoom isPrivateRoom={privateRooms.some((r) => r.name === activeRoom)} onRoomRemoved={handleRoomRemoved} />
```

**Step 7: Commit**

```bash
git add web/src/App.tsx
git commit -m "refactor: rename channel.* to room.* NATS subjects in App.tsx"
```

---

## Task 9: Update ChatRoom.tsx — rename channel.* to room.* subjects

**Files:**
- Modify: `web/src/components/ChatRoom.tsx`

**Step 1: Rename props**

```typescript
// Before
interface Props {
  room: string;
  isPrivateChannel?: boolean;
  onChannelRemoved?: (channelName: string) => void;
}

// After
interface Props {
  room: string;
  isPrivateRoom?: boolean;
  onRoomRemoved?: (roomName: string) => void;
}
```

**Step 2: Rename imports**

```typescript
// Before
import type { ChatMessage, HistoryResponse, ChannelInfo, UserSearchResult } from '../types';
// After
import type { ChatMessage, HistoryResponse, RoomInfo, UserSearchResult } from '../types';
```

**Step 3: Rename state**

```typescript
// Before
const [channelInfo, setChannelInfo] = useState<ChannelInfo | null>(null);
// After
const [roomInfo, setRoomInfo] = useState<RoomInfo | null>(null);
```

**Step 4: Rename NATS subjects**

Replace all `channel.info.`, `channel.invite.`, `channel.kick.`, `channel.leave.` with `room.info.`, `room.invite.`, `room.kick.`, `room.leave.`:

```typescript
// Before
nc.request(`channel.info.${room}`, ...)
nc.request(`channel.invite.${room}`, ...)
nc.request(`channel.kick.${room}`, ...)
nc.request(`channel.leave.${room}`, ...)

// After
nc.request(`room.info.${room}`, ...)
nc.request(`room.invite.${room}`, ...)
nc.request(`room.kick.${room}`, ...)
nc.request(`room.leave.${room}`, ...)
```

**Step 5: Update `isPrivate` checks to `type === 'private'`**

```typescript
// Before
if (info.isPrivate && info.members && ...)
// After
if (info.type === 'private' && info.members && ...)
```

**Step 6: Commit**

```bash
git add web/src/components/ChatRoom.tsx
git commit -m "refactor: rename channel.* to room.* in ChatRoom.tsx"
```

---

## Task 10: Update RoomSelector.tsx

**Files:**
- Modify: `web/src/components/RoomSelector.tsx`

**Step 1: Rename imports and props**

```typescript
// Before
import { ChannelCreateModal } from './ChannelCreateModal';
import type { UserSearchResult, ChannelInfo } from '../types';

interface Props {
  ...
  privateChannels: ChannelInfo[];
  onCreateChannel: (name: string, displayName: string) => void;
}

// After
import { RoomCreateModal } from './RoomCreateModal';
import type { UserSearchResult, RoomInfo } from '../types';

interface Props {
  ...
  privateRooms: RoomInfo[];
  onCreateRoom: (name: string, displayName: string) => void;
}
```

**Step 2: Rename in component**

Update all references from `privateChannels` → `privateRooms`, `onCreateChannel` → `onCreateRoom`, `showCreateChannel` → `showCreateRoom`, `setShowCreateChannel` → `setShowCreateRoom`.

**Step 3: Commit**

```bash
git add web/src/components/RoomSelector.tsx
git commit -m "refactor: rename channel refs to room refs in RoomSelector.tsx"
```

---

## Task 11: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Update architecture diagram and service descriptions**

- Replace all `channel.*` subject references with `room.*`
- Update Room Service section to describe unified room concept
- Add `room.msg.*` and `room.presence.*` subjects to architecture
- Update fanout-service description (publishes to `room.msg.{room}` for NATS multicast)
- Update presence-service description (publishes diffs to `room.presence.{room}`)
- Update auth-service permissions section
- Replace `channels`/`channel_members` with `rooms`/`room_members` in DB schema references
- Add "Unified rooms" key design decision

**Step 2: Update key design decisions section**

Add new entry:
> **Unified room model** — Rooms, private channels, and DMs all use the same "Room" entity. A `type` field (public/private/dm) controls access behavior. Public rooms allow anyone to join. Private rooms require DB-backed membership (owner/admin/member roles). DMs use canonical sorted-username keys. All share the same KV membership, fanout, persistence, and history infrastructure.

Add entry:
> **Per-room NATS multicast for scalability** — Chat messages are published to `room.msg.{room}` instead of per-user `deliver.{userId}.chat.{room}`. Browsers subscribe to `room.msg.{room}` per joined room. NATS natively multicasts to all subscribers, eliminating the O(members) publish amplification in fanout-service. Threads, DMs, translations, and app events still use per-user `deliver.{userId}.>` delivery. Presence uses the same pattern: diffs published to `room.presence.{room}` with NATS multicast.

**Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for unified rooms and per-room multicast"
```

---

## Task 12: Integration test

**Step 1: Rebuild and restart all services**

```bash
docker compose down
docker compose up -d --build
```

Wait for all services to start (check logs for "ready" messages).

**Step 2: Reset database** (tables renamed)

Since we renamed DB tables, the existing database won't have the new table names. The quickest approach for local dev:

```bash
docker compose down -v   # remove volumes (destroys data)
docker compose up -d --build
```

**Step 3: Manual test flow**

Open browser to `http://localhost:3000`.

1. **Public rooms:** Log in as alice. Verify general/random/help rooms work — messages send and receive.
2. **Create private room:** Click "+" next to "Private Channels" (now "Private Rooms"). Create a room named "test-private". Verify it appears in sidebar with lock icon.
3. **Invite user:** Open another browser/incognito as bob. From alice's session, invite bob to "test-private". Verify bob's sidebar auto-discovers the room.
4. **Send messages:** Alice sends a message in "test-private". Bob sees it. Bob sends a reply. Alice sees it.
5. **Kick user:** Alice kicks bob. Verify bob sees "no longer a member" and cannot send messages.
6. **Leave room:** Create another room, invite bob, then alice leaves. Verify ownership transfers to bob.
7. **Presence:** Verify online indicators appear for both users in the room header.
8. **DMs:** Alice starts a DM with bob. Messages flow both ways.
9. **Threads:** Reply to a message to open thread panel. Verify thread messages work.

**Step 4: Verify per-room multicast**

Open browser console. After joining "general", look for subscription to `room.msg.general` in NATS connection debug output. Messages should arrive via this subscription, not via `deliver.alice.chat.general`.

**Step 5: Commit any fixes discovered during testing**

If issues are found, fix them and commit with descriptive messages.

---

## Verification Checklist

- [ ] `cd room-service && go build -o /dev/null .` — compiles
- [ ] `cd fanout-service && go build -o /dev/null .` — compiles
- [ ] `cd presence-service && go build -o /dev/null .` — compiles
- [ ] `cd auth-service && go build -o /dev/null .` — compiles
- [ ] `cd web && npx tsc --noEmit` — type checks
- [ ] `docker compose up -d --build` — all services start
- [ ] Public room messages work (general/random/help)
- [ ] Private room CRUD works (create/invite/kick/leave)
- [ ] Presence indicators show online/offline
- [ ] DMs work
- [ ] Thread replies work
- [ ] No `channel.*` subjects remain in codebase (verify with `grep -r "channel\." --include="*.go" --include="*.ts" --include="*.tsx"`)
