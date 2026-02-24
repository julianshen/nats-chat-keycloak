# Private Channels Feature Design

## Overview

Private channels are invite-only rooms with role-based membership management (owner, admin, member). Unlike public rooms (general, random, help) where any authenticated user can join via `room.join.*`, private channels require explicit invitation by an owner or admin. Channel metadata and membership are stored in PostgreSQL, while real-time room presence still uses the NATS KV-backed room membership system.

The feature is fully integrated into room-service, which handles both the NATS KV room membership (sharded per-key) and the PostgreSQL-backed channel management in a single process.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Storage | PostgreSQL for channel metadata + roles; NATS KV for room presence | Channels need durable role-based membership (owner/admin/member); presence needs low-latency KV with TTL |
| Authorization model | Owner/admin can invite/kick; any member can leave | Follows Slack-style channel semantics, familiar UX |
| Integration with room system | Private channels ARE rooms | Reuses all existing infrastructure: fanout, persistence, history, presence, read receipts — zero changes to downstream services |
| Channel name format | Lowercase alphanumeric + hyphens, single segment | Must be valid NATS subject token (no dots), valid as KV key prefix |
| Ownership transfer | Auto-transfer to next admin/oldest member on owner leave | Prevents orphaned channels; mirrors Slack behavior |
| Channel deletion | Automatic when last member leaves | No admin intervention needed; cascading FK delete cleans up `channel_members` |
| Merged into room-service | Single process for room + channel | Eliminates NATS round-trips for authorization, prevents race conditions on kick |
| Sidebar display | Separate "Private Channels" section with lock icon | Clear visual distinction from public rooms and DMs |
| Auto-discovery | Detect unknown rooms from incoming messages | Invited users see the channel appear automatically without page refresh |
| System messages | Published to `chat.{room}` as `__system__` user | Events (created, invited, kicked, left) appear inline in chat history |

## System Architecture

```
Browser (React)
  │
  │  ┌──────────────── Sidebar ────────────────┐
  │  │ # general                                │
  │  │ # random                                 │
  │  │ # help                                   │
  │  │ ─── Private Channels ──────────── [+] ── │
  │  │ 🔒 project-alpha                         │
  │  │ 🔒 engineering                           │
  │  │ ─── Direct Messages ──────────── [+] ── │
  │  │ @ bob                                    │
  │  └──────────────────────────────────────────┘
  │
  │  channel.create ──────────► room-service ──► DB INSERT + addToRoom()
  │  channel.list ────────────► room-service ──► DB SELECT (user's channels)
  │  channel.info.* ──────────► room-service ──► DB SELECT (metadata + members)
  │  channel.invite.* ────────► room-service ──► DB INSERT + addToRoom()
  │  channel.kick.* ──────────► room-service ──► DB DELETE + removeFromRoom()
  │  channel.leave.* ─────────► room-service ──► DB DELETE + removeFromRoom()
  │
  │  room.join.* ─────────────► room-service ──► checkChannelMembership() + addToRoom()
  │                                                 ↓ (local DB query, no NATS RTT)
  │
  ▼ (all downstream unchanged)
  fanout-service ◄── room.changed.* ──── room-service
  presence-service ◄── room.changed.* ── room-service
  persist-worker ◄── chat.{room} ─────── browser publishes
  history-service ◄── chat.history.* ─── browser requests
```

### Key Invariant

**A private channel IS a room.** The channel name (e.g., `project-alpha`) is used directly as a room name. Messages publish to `chat.project-alpha`, history queries go to `chat.history.project-alpha`, presence works via `room.changed.project-alpha`. No special routing or subject mapping.

## Data Model

### PostgreSQL Schema

```sql
CREATE TABLE channels (
    name         TEXT PRIMARY KEY,          -- same as room name
    display_name TEXT,                       -- human-friendly name
    creator      TEXT NOT NULL,              -- user who created the channel
    is_private   BOOLEAN DEFAULT TRUE,       -- always true (future: public channels)
    created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE channel_members (
    channel_name TEXT NOT NULL REFERENCES channels(name) ON DELETE CASCADE,
    username     TEXT NOT NULL,
    role         TEXT NOT NULL DEFAULT 'member',  -- 'owner' | 'admin' | 'member'
    invited_by   TEXT,                            -- who invited this user (NULL for creator)
    joined_at    TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (channel_name, username)
);
CREATE INDEX idx_channel_members_user ON channel_members(username);
```

### Role Hierarchy

| Role | Invite | Kick | Leave | View Members | Create |
|------|--------|------|-------|--------------|--------|
| owner | Yes | Yes (except owner) | Yes (transfers ownership) | Yes | N/A (becomes owner) |
| admin | Yes | Yes (except owner) | Yes | Yes | No |
| member | No | No | Yes | Yes | No |

### NATS KV (unchanged)

Private channels use the same ROOMS KV bucket as public rooms:

```
Key: project-alpha.alice → {}
Key: project-alpha.bob → {}
```

The KV is the source of truth for "who is currently in the room" (used by fanout-service for message delivery). PostgreSQL is the source of truth for "who is allowed in the room" (used for authorization on join).

### In-Memory State (room-service)

```go
// Loaded at startup from: SELECT name FROM channels WHERE is_private = true
privateChannels map[string]bool  // {"project-alpha": true, "engineering": true}
```

Updated locally on `channel.create` (set `true`) and `channel.leave` when channel is deleted (delete key).

## NATS Subject API

### channel.create

Creates a new private channel. The creator becomes the owner.

```
Subject:  channel.create (request/reply)
QG:       room-workers
Request:  {"name": "project-alpha", "displayName": "Project Alpha", "user": "alice"}
Response: {"name": "project-alpha", "displayName": "Project Alpha",
           "creator": "alice", "isPrivate": true}
Error:    {"error": "channel already exists"} | {"error": "name and user are required"}
```

**Side effects:**
1. DB: `INSERT INTO channels` + `INSERT INTO channel_members (role='owner')`
2. In-memory: `privateChannels["project-alpha"] = true`
3. KV + cache: `addToRoom("project-alpha", "alice")`
4. System message: `"alice created the channel"` → `chat.project-alpha`

### channel.list

Returns all private channels the user is a member of, with member counts.

```
Subject:  channel.list (request/reply)
QG:       room-workers
Request:  {"user": "alice"}
Response: [{"name": "project-alpha", "displayName": "Project Alpha",
            "creator": "alice", "isPrivate": true, "memberCount": 3}, ...]
```

### channel.info.*

Returns channel metadata with full member list. Used by the UI to render the member panel.

```
Subject:  channel.info.{channelName} (request/reply)
QG:       room-workers
Request:  (empty or ignored)
Response: {"name": "project-alpha", "displayName": "Project Alpha",
           "creator": "alice", "isPrivate": true, "memberCount": 3,
           "members": [
             {"username": "alice", "role": "owner"},
             {"username": "bob", "role": "member"},
             {"username": "charlie", "role": "admin"}
           ]}
Error:    {"error": "not found"}
```

### channel.invite.*

Owner or admin invites a user. The invited user is added to both the DB and the NATS KV room.

```
Subject:  channel.invite.{channelName} (request/reply)
QG:       room-workers
Request:  {"target": "bob", "user": "alice"}
Response: {"ok": true}
Error:    {"error": "unauthorized"}
```

**Side effects:**
1. DB: `INSERT INTO channel_members (role='member', invited_by='alice')`
2. KV + cache: `addToRoom("project-alpha", "bob")`
3. System message: `"bob was invited by alice"` → `chat.project-alpha`

The invited user sees the channel appear via auto-discovery (incoming messages trigger `channel.info` lookup).

### channel.kick.*

Owner or admin removes a user. Cannot kick the owner.

```
Subject:  channel.kick.{channelName} (request/reply)
QG:       room-workers
Request:  {"target": "bob", "user": "alice"}
Response: {"ok": true}
Error:    {"error": "unauthorized"} | {"error": "cannot kick owner"}
```

**Side effects:**
1. DB: `DELETE FROM channel_members WHERE channel_name=$1 AND username=$2`
2. KV + cache: `removeFromRoom("project-alpha", "bob")`
3. System message: `"bob was removed by alice"` → `chat.project-alpha`

The kicked user sees a lock icon with "You are no longer a member of this channel" on next channel access.

### channel.leave.*

User voluntarily leaves. If the user is the owner, ownership transfers. If no members remain, the channel is deleted.

```
Subject:  channel.leave.{channelName} (request/reply)
QG:       room-workers
Request:  {"user": "alice"}
Response: {"ok": true} | {"ok": true, "deleted": true}
Error:    {"error": "internal error"}
```

**Ownership transfer logic:**
1. If user is owner, find next candidate: prefer admins by role, then oldest member by `joined_at`
2. If no other members exist → delete channel (`DELETE FROM channels`, cascade deletes members)
3. Otherwise → `UPDATE channel_members SET role='owner' WHERE ...` for the new owner

### Authorization on room.join.*

When any user publishes `room.join.*`, room-service checks authorization before adding them to the KV:

```go
func checkChannelMembership(ctx, room, userId) (isPrivate, authorized bool) {
    // 1. SELECT is_private FROM channels WHERE name = room
    //    - Not found → (false, true) — not a channel, allow
    //    - DB error  → (false, true) — fail-open
    //    - Not private → (false, true)
    // 2. SELECT COUNT(*) FROM channel_members WHERE channel_name = room AND username = userId
    //    - count > 0 → (true, true) — member, allow
    //    - count = 0 → (true, false) — not a member, reject
}
```

Fail-open on DB errors matches the principle that infrastructure failures should not lock out users from public rooms.

## Frontend Architecture

### TypeScript Types

```typescript
interface ChannelInfo {
  name: string;
  displayName?: string;
  creator: string;
  isPrivate: boolean;
  members?: Array<{ username: string; role: string }>;
  memberCount?: number;
}
```

### Component Responsibilities

| Component | Channel Responsibilities |
|-----------|------------------------|
| **App.tsx** | Stores `privateChannels` state; fetches `channel.list` on connect; auto-joins all channels; handles `channel.create`; auto-discovers channels from incoming messages |
| **RoomSelector** | Renders "Private Channels" section with lock icons; shows create modal; passes `onCreateChannel` callback |
| **ChannelCreateModal** | Modal form: channel name (auto-sanitized) + optional display name; validates against reserved names and `dm-` prefix |
| **ChatRoom** | Fetches `channel.info` for member panel; renders member list, invite search, kick buttons, leave button; detects removal (`removedFromChannel` state) |

### User Flows

#### Creating a Channel

```
1. User clicks [+] in "Private Channels" section
2. ChannelCreateModal opens
3. User enters name ("project-alpha") and optional display name ("Project Alpha")
4. Name sanitized: lowercase, alphanumeric + hyphens only
5. Validated: not empty, not reserved (general/random/help/__admin__), not dm- prefix
6. App.tsx sends: nc.request('channel.create', {name, displayName, user})
7. Server responds with Channel object
8. App.tsx: setPrivateChannels([...prev, ch]) + setActiveRoom(ch.name)
9. Channel appears in sidebar with lock icon
```

#### Being Invited

```
1. Admin sends channel.invite for the user
2. Server adds user to DB + KV room
3. Server publishes system message to chat.{channel} ("bob was invited by alice")
4. Fanout delivers the system message to the invited user's deliver.{user}.> subscription
5. MessageProvider increments unreadCounts for the unknown room
6. App.tsx auto-discovery: detects unknown room in unreadCounts
7. App.tsx sends channel.info.{room} → receives ChannelInfo
8. If isPrivate && no error → adds to privateChannels state + joinRoom()
9. Channel appears in sidebar without page refresh
```

#### Being Kicked

```
1. Admin sends channel.kick for the user
2. Server removes user from DB + KV room
3. Server publishes system message ("bob was removed by alice")
4. Fanout stops delivering new messages to kicked user (KV membership removed)
5. If kicked user is viewing the channel:
   a. ChatRoom fetches channel.info on next access
   b. Detects user is not in members list
   c. Sets removedFromChannel = true
   d. Renders: 🔒 "You are no longer a member of this channel"
   e. App.tsx removes channel from privateChannels, switches to "general"
```

#### Leaving a Channel

```
1. User clicks "Leave" button in channel header
2. ChatRoom sends: nc.request('channel.leave.{room}', {user})
3. Server:
   a. If owner → transfer ownership or delete channel
   b. DELETE FROM channel_members
   c. removeFromRoom()
4. System message published
5. User is redirected to "general"
```

### Channel Header UI

When viewing a private channel, the header shows:

```
┌─────────────────────────────────────────────────────────────┐
│ 🔒 Project Alpha                                            │
│ subject: chat.project-alpha                                  │
│ [3 members]  [Invite]  [Leave]                              │
├─────────────────────────────────────────────────────────────┤
│ ▼ Member Panel (toggle)                                      │
│   alice (owner)                                              │
│   charlie (admin)                        [Remove]            │
│   bob                                    [Remove]            │
│                                                              │
│ ▼ Invite Panel (toggle, owner/admin only)                    │
│   [Search users to invite...              ]                  │
│   david   (David Smith)                   ← click to invite  │
│   eve     (Eve Johnson)                                      │
└─────────────────────────────────────────────────────────────┘
```

- **Members button**: Toggles member list; shows role badges and Remove buttons (for owner/admin)
- **Invite button**: Only visible to owner/admin; opens user search with debounced Keycloak lookup; filters out existing members
- **Leave button**: Always visible; red danger style; triggers ownership transfer if owner
- **Remove button**: Only visible to owner/admin; not shown for the owner or the current user

### Invite User Search

The invite panel reuses the same NATS `users.search` subject (Keycloak Admin API backend) as the DM user search. The search is debounced at 300ms. Results are filtered to exclude users already in the channel (via `channelInfo.members`).

After a successful invite, the channel info is re-fetched to update the member list.

## System Messages

Channel events generate system messages published to `chat.{room}` with a special `__system__` username:

```json
{
  "user": "__system__",
  "text": "alice created the channel",
  "timestamp": 1708819200000,
  "room": "project-alpha",
  "action": "system"
}
```

These messages:
- Flow through the normal `chat.>` fanout pipeline → delivered to all room members
- Are persisted by persist-worker → appear in history
- Are excluded from unread badge counts (MessageProvider filters `action === 'system'`)
- Render with a distinct system message style in the message list

Events that generate system messages:

| Event | Message |
|-------|---------|
| Channel created | `"{user} created the channel"` |
| User invited | `"{target} was invited by {user}"` |
| User kicked | `"{target} was removed by {user}"` |
| User left | `"{user} left the channel"` |

## Interaction with Existing Systems

### Fanout Service (unchanged)

Fanout-service subscribes to `room.changed.*` and maintains an LRU cache of room members. When a private channel member is added/removed via `addToRoom()`/`removeFromRoom()`, the delta event updates fanout's cache identically to public room changes. Fanout does not know or care whether a room is private.

### Presence Service (unchanged)

Presence-service subscribes to `room.changed.*` and maintains a dual-index (forward + reverse). Private channel members appear in presence queries (`presence.room.*`) and receive presence events just like public room members.

### Persist Worker (unchanged)

Messages published to `chat.{channelName}` (including system messages) are consumed by the JetStream `CHAT_MESSAGES` stream and persisted to PostgreSQL by persist-worker. No awareness of channels needed.

### History Service (unchanged)

History queries via `chat.history.{channelName}` return messages from the private channel. The history service has no concept of authorization — the browser only queries rooms it has joined.

### Auth Service Permissions

Browser users get `chat.>` publish permissions (scoped by role). The private channel authorization happens at the room-service level (rejecting unauthorized `room.join.*`), not at the NATS permission level. This means a user could theoretically publish to `chat.{privateChannel}` without being a member — but fanout would not deliver it to anyone since they're not in the KV room. The system message would also not reach them.

### Read Receipts (unchanged)

Read receipt tracking works per-room. Private channels generate read receipts identically to public rooms. The read-receipt-service subscribes to `room.changed.*` for its own forward-index.

## Edge Cases

### Concurrent Operations

- **Double invite**: `INSERT ... ON CONFLICT DO NOTHING` makes invite idempotent. `addToRoom()` uses `kv.Create()` which returns `ErrKeyExists` — also idempotent.
- **Kick + leave race**: Both remove from DB and KV. Whichever runs first succeeds; the second is a no-op (both DB DELETE and KV Delete are idempotent).
- **Multiple room-service instances**: All handlers use `room-workers` queue group. DB transactions provide consistency. KV per-key writes have no conflicts.

### Channel Name Collisions

Channel names share the same namespace as public room names. The channel create handler checks for `duplicate key` on DB insert but does not check against public room names (general, random, help). The `ChannelCreateModal` client-side validation blocks reserved names. A user could create a channel named "announcements" and it would work as a private room with that name.

### Reconnection

On NATS reconnect, room-service re-hydrates its local membership from the KV (existing behavior). Private channels are loaded from DB only at startup — they do not need re-loading on reconnect since the `privateChannels` map persists in-memory across NATS reconnections.

### Browser Refresh

On page reload, the browser:
1. Fetches `channel.list` → gets all user's private channels
2. Calls `joinRoom()` for each → publishes `room.join.*`
3. Room-service authorizes via `checkChannelMembership()` → allows (user is in DB)
4. `addToRoom()` is idempotent (KV key likely already exists from before refresh)

## File Inventory

### Backend

| File | Purpose |
|------|---------|
| `room-service/main.go` | All room + channel logic (KV, DB, NATS handlers) |
| `room-service/go.mod` | Dependencies including `otelsql`, `lib/pq` |
| `postgres/init.sql` | Channel tables DDL (`channels`, `channel_members`) |

### Frontend

| File | Purpose |
|------|---------|
| `web/src/types.ts` | `ChannelInfo` type definition |
| `web/src/App.tsx` | Channel state management, `channel.list`/`channel.create`, auto-discovery |
| `web/src/components/RoomSelector.tsx` | Private channels sidebar section, create modal trigger |
| `web/src/components/ChannelCreateModal.tsx` | Channel creation modal with name validation |
| `web/src/components/ChatRoom.tsx` | Member panel, invite search, kick/leave actions, removal detection |
