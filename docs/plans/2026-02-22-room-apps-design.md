# Room Apps Architecture Design

## Overview

Room Apps are collaborative micro-frontend applications that run inside chat rooms as tabs. Each app is a Web Component loaded dynamically from a registry, sandboxed in Shadow DOM with CSP-enforced network restrictions. Apps communicate exclusively with their backend App Services through an injected bridge SDK that proxies messages over the host's existing NATS WebSocket connection.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Sandboxing | Shadow DOM + CSP (`connect-src` restriction) | Lightweight, same-origin, trust-but-verify model for known developers |
| Bridge API | Injected SDK object (`AppBridge`) | Clean typed Promise-based API, easy to version, enforces scoping |
| Registry storage | PostgreSQL | Consistent with existing services (sticker-service, persist-worker) |
| Subject structure | `app.{appId}.{room}.{action}` | Room embedded in subject for server-side routing without payload parsing |
| Fanout strategy | Extend existing fanout-service | Reuses LRU membership cache and worker pool, no new service needed |
| Routing strategy | Direct proxy via host's single NATS connection | Zero new NATS subscriptions; piggybacks on `deliver.{username}.>` |
| Sample app | Poll app | Demonstrates request/reply and pub/sub, familiar UX, moderate complexity |

## System Architecture

```
Guest App (Web Component in Shadow DOM)
  |  bridge.request('vote', {optionId: 2})
  |  bridge.subscribe('results', callback)
  v
Host Bridge SDK (injected object)
  |  Scopes subject: app.poll.general.vote
  |  Attaches context: {user: 'alice', room: 'general'}
  |  Uses host's existing nc.publish / nc.request
  v
NATS (existing WebSocket connection, single deliver.{username}.> sub)
  |  Request/reply: app.poll.general.vote -> reply via _INBOX
  |  Pub/sub: deliver.alice.app.poll.general.results <- fanout
  v
App Service (Go, NATS client, queue group)
  |  Subscribes app.poll.> (queue group poll-workers)
  |  Reads/writes PostgreSQL
  |  Publishes updates for fanout delivery
  v
Fanout Service (existing, extended to subscribe app.>)
```

### Key Invariants

1. **Network isolation** -- Guest Apps never touch the network. The bridge is the only gateway.
2. **Subject scoping** -- An app can only address `app.{its-own-appId}.{current-room}.*`. No cross-app or cross-room access.
3. **User context injection** -- The bridge injects the authenticated username. Apps cannot impersonate another user.
4. **Room-level access control** -- If an app is installed in the room and you're a member, the bridge allows communication. Fine-grained per-user permissions are the app service's responsibility.

## App Registry Service

### PostgreSQL Schema

```sql
CREATE TABLE apps (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    description     TEXT,
    icon_url        TEXT,
    component_url   TEXT NOT NULL,
    subject_prefix  TEXT NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE channel_apps (
    room            TEXT NOT NULL,
    app_id          TEXT NOT NULL REFERENCES apps(id),
    installed_by    TEXT NOT NULL,
    installed_at    TIMESTAMPTZ DEFAULT NOW(),
    config          JSONB DEFAULT '{}',
    PRIMARY KEY (room, app_id)
);
```

### NATS Subjects

| Subject | Type | Purpose |
|---------|------|---------|
| `apps.list` | request/reply | All registered apps |
| `apps.room.{room}` | request/reply | Apps installed in a room |
| `apps.install.{room}` | request/reply | Install app `{appId, config?}` |
| `apps.uninstall.{room}` | request/reply | Remove app `{appId}` |

### Access Control

Any user with `admin` or `user` role can install/uninstall apps. Read-only users can view and interact with installed apps but cannot install/uninstall.

## Host Bridge SDK

### Interface

```typescript
interface AppBridge {
  /** Request/reply to app service. Subject auto-prefixed with app.{appId}.{room}. */
  request(action: string, data?: unknown): Promise<unknown>;

  /** Subscribe to real-time events. Returns unsubscribe function. */
  subscribe(event: string, callback: (data: unknown) => void): () => void;

  /** Current user info (read-only, frozen) */
  readonly user: { username: string };

  /** Current room (read-only, frozen) */
  readonly room: string;

  /** App ID (read-only, frozen) */
  readonly appId: string;
}
```

### Internal Mechanics

- `bridge.request('vote', data)` -> host calls `nc.request('app.poll.general.vote', encode({...data, user: 'alice'}))` -> returns parsed reply
- `bridge.subscribe('results', cb)` -> host registers callback keyed by `app.poll.general.results`. MessageProvider routes matching `deliver.{username}.app.poll.general.results` messages to the callback.
- Unsubscribe deregisters the callback. All callbacks auto-cleaned on app unmount.

### Security Enforcement

- `appId` and `room` are frozen at construction -- Guest App cannot change them
- Action names validated: no `.`, `>`, or `*` characters (prevents wildcard injection)
- User field in payload always overwritten by bridge: `{...data, user: this.username}`
- Bridge only created for apps installed in the current room

### File Location

`web/src/lib/AppBridge.ts`

## Message Routing

### Fanout Extension

Fanout-service currently subscribes to `chat.>` and `admin.*`. Extended to also subscribe to `app.>`.

When it receives `app.poll.general.vote`:
- Subject parts: `['app', 'poll', 'general', 'vote']`
- Room is at position 2: `general`
- Looks up room members via LRU cache (same as chat messages)
- Delivers to `deliver.{userId}.app.poll.general.vote` for each member

Request/reply messages (using `_INBOX`) go directly back to the requester -- no fanout needed. Only pub/sub broadcasts (e.g., `app.poll.general.updated`) go through fanout.

### MessageProvider Routing

The existing `deliver.{username}.>` subscription already receives app messages. Subject parsing:

```
deliver.alice.app.poll.general.results
parts[2] = 'app'          <- new subjectType
parts[3] = 'poll'         <- appId
parts[4] = 'general'      <- room
parts[5+] = 'results'     <- event (joined with '.')
```

MessageProvider maintains a `Map<string, Set<callback>>` for app subscriptions, keyed by `{appId}.{room}.{event}`. Bridge `subscribe`/unsubscribe populates/depopulates this map.

## Tab UI & Web Component Loading

### Tab Bar Layout

```
+-------------------------------------------+
| # general                                 |
| subject: chat.general                     |
| * 3 online  [alice] [bob] [charlie]       |
+-------------------------------------------+
| [Chat] [Poll] [Whiteboard]                |  <- tab bar
+-------------------------------------------+
|                                           |
|  (active tab content)                     |
|                                           |
+-------------------------------------------+
```

- "Chat" is always the first tab and the default
- App tabs rendered from `apps.room.{room}` response
- Only one tab active at a time
- Tab switching unmounts the previous app and cleans up its bridge
- DM rooms skip registry fetch and never show the tab bar

### Web Component Loading Sequence

1. User clicks app tab
2. Host checks if `<room-app-poll>` custom element is already defined
3. If not, dynamically imports JS from `component_url`
4. Creates element, mounts into tab content area
5. Constructs `AppBridge` with `{nc, sc, appId, room, username}`
6. Calls `element.setBridge(bridge)` -- app begins operation

### Web Component Contract

```typescript
interface RoomAppElement extends HTMLElement {
  setBridge(bridge: AppBridge): void;
}
```

### CSP Enforcement

Host page CSP restricts network access:
```
connect-src 'self' ws://localhost:9222;
```
Guest Apps (same origin, Shadow DOM) inherit this CSP. App JS loaded via `script-src` allowlist or nonce.

## Auth & Permissions

### Browser Permissions (auth-service)

All three role blocks gain:
- Pub allow: `app.*.*.>` (app communication)
- Pub allow: `apps.list`, `apps.room.*` (registry read)

Admin and user roles additionally gain:
- Pub allow: `apps.install.*`, `apps.uninstall.*` (registry write)

### Permission Model (Two-Tier)

1. **Room-level** (enforced by bridge): App installed in room + user is room member = bridge allows communication. No tab rendered otherwise.
2. **Per-user** (enforced by app service): App service receives `user` field in every message and decides authorization (e.g., only poll creator can close).

### App Service Authentication

App services connect as `auth_users` in `nats-server.conf` (same as all other backend services). They subscribe to `app.{appId}.>` via queue group.

## Poll App (Sample Implementation)

### Poll Service (`poll-service/`)

Single-file Go service, PostgreSQL-backed.

**Schema:**

```sql
CREATE TABLE polls (
    id          TEXT PRIMARY KEY,
    room        TEXT NOT NULL,
    question    TEXT NOT NULL,
    options     JSONB NOT NULL,
    created_by  TEXT NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    closed      BOOLEAN DEFAULT FALSE
);

CREATE TABLE poll_votes (
    poll_id     TEXT NOT NULL REFERENCES polls(id),
    user_id     TEXT NOT NULL,
    option_idx  INT NOT NULL,
    voted_at    TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (poll_id, user_id)
);
```

**NATS Subjects:**

| Subject | Type | Purpose |
|---------|------|---------|
| `app.poll.{room}.create` | request/reply | Create poll `{question, options[]}` -> `{pollId}` |
| `app.poll.{room}.list` | request/reply | Active polls -> `{polls[]}` |
| `app.poll.{room}.vote` | request/reply | Cast vote `{pollId, optionIdx}` -> `{ok}` |
| `app.poll.{room}.results` | request/reply | Poll results `{pollId}` -> `{poll, votes}` |
| `app.poll.{room}.close` | request/reply | Close poll (creator only) `{pollId}` -> `{ok}` |
| `app.poll.{room}.updated` | pub/sub (fanout) | Real-time vote count broadcast |

### Poll App Frontend (`poll-app/`)

Standalone web component (`<room-app-poll>`) as a single JS file served by a static file server (like sticker-images pattern). Features:
- List active polls with vote counts (bar chart)
- Create Poll form (question + options)
- Click to vote, real-time result updates via `bridge.subscribe('updated', cb)`

## New & Modified Files

### New Services

| Service | Files | Purpose |
|---------|-------|---------|
| `app-registry-service/` | `main.go`, `Dockerfile`, `go.mod` | App metadata + per-room installation |
| `poll-service/` | `main.go`, `Dockerfile`, `go.mod` | Poll CRUD + real-time votes |
| `poll-app/` | `poll-app.js`, `Dockerfile` (nginx) | Web component static hosting |

### Modified Files

| File | Change |
|------|--------|
| `auth-service/permissions.go` | Add `app.*.*.>`, `apps.*`, `apps.room.*`, `apps.install.*`, `apps.uninstall.*` |
| `fanout-service/main.go` | Subscribe `app.>`, parse room from subject position 2 |
| `web/src/lib/AppBridge.ts` | New -- bridge SDK class |
| `web/src/providers/MessageProvider.tsx` | Route `deliver.{user}.app.*` to registered callbacks |
| `web/src/components/ChatRoom.tsx` | Tab bar, app loading, bridge lifecycle |
| `nats/nats-server.conf` | Add app-registry-service, poll-service to `auth_users` |
| `docker-compose.yml` | Add 3 new containers |
| `CLAUDE.md` | Document room app architecture |

## Explicitly Out of Scope

- App store / marketplace UI (install/uninstall via NATS request for now)
- Per-user app permissions (app services handle this)
- App versioning (single `component_url`, no version management)
- iframe sandbox (Shadow DOM + CSP only)
- App-to-app communication (each app is isolated)
- Nested rooms or DM apps (room apps are for channels only)
