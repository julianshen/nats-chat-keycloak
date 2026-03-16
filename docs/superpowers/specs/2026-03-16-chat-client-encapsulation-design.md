# Chat Client Encapsulation Design

**Date:** 2026-03-16
**Status:** Approved
**Scope:** Extract framework-agnostic chat client from React providers; provide thin React hooks as wrapper

---

## Goal

Extract all NATS chat business logic from React providers (`MessageProvider.tsx`, `NatsProvider.tsx`, `E2EEProvider.tsx`) into a framework-agnostic `ChatClient` library at `web/src/lib/chat-client/`. The React app becomes a thin UI layer that subscribes to client events and renders state.

## Motivation

- `MessageProvider.tsx` is 1,015 lines mixing NATS protocol, message processing, and React state
- ~60% of provider code is pure business logic with no React dependency
- Impossible to unit-test message routing, dedup, or E2EE key distribution without React test infrastructure
- Cannot reuse chat logic in non-React contexts (mobile WebView, CLI, other frameworks)

## Out of Scope

- Changing the NATS subject structure or backend services
- Modifying `E2EEManager.ts` (crypto primitives already well-extracted)
- Modifying `AppBridge.ts` (already separate)
- Moving the library to a separate package (stays in `web/src/lib/chat-client/` for now)

---

## File Structure

### New Files (chat client core)

```
web/src/lib/chat-client/
├── index.ts              # Public API: re-exports ChatClient, types, managers
├── ChatClient.ts         # Facade: creates/wires managers, unified API
├── ConnectionManager.ts  # NATS WebSocket lifecycle, reconnect, status events
├── RoomManager.ts        # Join/leave, per-room subscriptions, membership tracking
├── MessageStore.ts       # Message processing, dedup, mutations (edit/delete/react)
├── PresenceManager.ts    # Heartbeat, status, online users per room
├── E2EEKeyManager.ts     # Key distribution protocol (fetch/wrap/rotate/enable)
├── ReadReceiptManager.ts # Debounced read position tracking
├── TranslationService.ts # Availability polling, translation requests
├── EventEmitter.ts       # Lightweight typed event emitter (no external deps)
└── types.ts              # ChatClientConfig, event types, internal types
```

### New Files (React hooks)

```
web/src/hooks/
├── useNatsChat.ts        # Creates/manages ChatClient instance
├── useMessages.ts        # Subscribes to MessageStore events → React state
├── usePresence.ts        # Subscribes to PresenceManager events → React state
├── useE2EE.ts            # Subscribes to E2EEKeyManager events → React state
└── useTranslation.ts     # Subscribes to TranslationService events → React state
```

### Modified Files

- `web/src/providers/AuthProvider.tsx` — stays (Keycloak is React-specific), but token parsing extracted to utility
- `web/src/App.tsx` — simplified: replaces 3 nested providers with `ChatClientProvider`
- `web/src/components/ChatRoom.tsx` — uses hooks instead of provider context
- `web/src/components/MessageList.tsx` — uses hooks instead of provider context
- `web/src/components/MessageInput.tsx` — uses hooks instead of provider context
- `web/src/components/Header.tsx` — uses hooks for presence/status
- `web/src/components/RoomSelector.tsx` — uses hooks for unread counts
- `web/src/components/ThreadPanel.tsx` — uses hooks for thread messages

### Deleted Files (after migration)

- `web/src/providers/NatsProvider.tsx` — replaced by ConnectionManager
- `web/src/providers/MessageProvider.tsx` — replaced by MessageStore + RoomManager + hooks
- `web/src/providers/E2EEProvider.tsx` — replaced by E2EEKeyManager + hook

### Unchanged Files

- `web/src/lib/E2EEManager.ts` — crypto primitives (already framework-agnostic)
- `web/src/lib/AppBridge.ts` — room app bridge (already separate)
- `web/src/utils/tracing.ts` — OTel trace header injection
- `web/src/types.ts` — shared data types (re-exported by chat-client)

---

## Manager Specifications

### EventEmitter (base class)

Lightweight typed event emitter with no external dependencies. All managers extend this.

```typescript
class TypedEmitter<Events extends Record<string, (...args: any[]) => void>> {
  on<K extends keyof Events>(event: K, listener: Events[K]): () => void  // returns unsubscribe fn
  off<K extends keyof Events>(event: K, listener: Events[K]): void
  emit<K extends keyof Events>(event: K, ...args: Parameters<Events[K]>): void
  removeAllListeners(): void
}
```

### ConnectionManager

Wraps NATS WebSocket connection lifecycle. Owns the connection guard pattern (currently in `NatsProvider.tsx:68,87`).

```typescript
class ConnectionManager extends TypedEmitter<{
  connected: () => void
  disconnected: () => void
  reconnected: () => void
  error: (err: string) => void
}> {
  constructor(config: { wsUrl: string; name: string })
  connect(token: string): Promise<void>
  disconnect(): Promise<void>
  get nc(): NatsConnection | null
  get isConnected(): boolean
}
```

**Key logic migrated from:** `NatsProvider.tsx:33-100`
- Connection with `maxReconnectAttempts: -1`, `reconnectTimeWait: 2000`
- Old connection drain before reconnect
- Connection guard: `ncRef === conn` check in status/close handlers
- Status iterator loop (disconnect/reconnect/error events)

### RoomManager

Tracks joined rooms, manages per-room subscriptions, publishes join/leave events.

```typescript
class RoomManager extends TypedEmitter<{
  joined: (room: string) => void
  left: (room: string) => void
  rawNotification: (room: string, data: Uint8Array, headers: MsgHdrs) => void
  rawPresence: (room: string, data: Uint8Array) => void
}> {
  constructor(cm: ConnectionManager, username: string)
  join(room: string): Promise<void>
  leave(room: string): Promise<void>
  leaveAll(): Promise<void>
  get joinedRooms(): ReadonlySet<string>
  rejoinAll(): Promise<void>
  roomToMemberKey(room: string): string  // maps __admin__ → __admin__chat, etc.
}
```

**Key logic migrated from:** `MessageProvider.tsx:796-863`
- `joinedRoomsRef` tracking → `Set<string>` internal state
- `roomSubsRef` subscription tracking → `Map<string, Subscription[]>` internal state
- Publish `room.join.{room}` / `room.leave.{room}` with traced headers
- Subscribe `room.notify.{memberKey}` + `room.presence.{memberKey}` per room
- Emit `rawNotification` and `rawPresence` events for `MessageStore` and `PresenceManager` to consume
- `roomToMemberKey` mapping (e.g., `__admin__` → `__admin__chat`)
- `rejoinAll()` called on reconnect (currently `MessageProvider.tsx:484-501`)
- `beforeunload` leave-all logic (currently `MessageProvider.tsx:866-883`)
- Initial presence fetch via `presence.room.{memberKey}` request/reply on join

### MessageStore

Message processing, deduplication, mutations. Core of `MessageProvider.tsx` logic.

```typescript
class MessageStore extends TypedEmitter<{
  message: (room: string, msg: ChatMessage) => void
  updated: (room: string, key: string, update: MessageUpdate) => void
  unreadChanged: (room: string, count: number, mentions: number) => void
  threadReply: (threadId: string, msg: ChatMessage) => void
  historyLoaded: (room: string, messages: ChatMessage[], hasMore: boolean) => void
  replyCountChanged: (threadId: string, count: number) => void
}> {
  constructor(cm: ConnectionManager, rm: RoomManager, e2ee: E2EEKeyManager, username: string)
  getMessages(room: string): ChatMessage[]
  getThreadMessages(threadId: string): ChatMessage[]
  getUnread(room: string): { count: number; mentions: number }
  getUpdates(): Record<string, MessageUpdate>
  getReplyCounts(): Record<string, number>
  setActiveRoom(room: string | null): void
  markAsRead(room: string): void
  fetchHistory(room: string): Promise<{ messages: ChatMessage[]; hasMore: boolean }>
  fetchThreadHistory(threadId: string): Promise<ChatMessage[]>
  clearUnread(room: string): void
}
```

**Key logic migrated from:** `MessageProvider.tsx`
- Main `deliver.{user}.>` subscription and message routing (lines 504-773)
- Routing by subject type:
  - `deliver.{user}.send.{room}` — regular chat messages
  - `deliver.{user}.admin.{room}` — admin channel messages (hardcoded room `__admin__`)
  - `deliver.{user}.notify.{room}` — DM notification delivery (separate from `room.notify.*`)
  - `deliver.{user}.translate.*` — translation responses
  - `deliver.{user}.app.{appId}.{room}.*` — app messages → routed to `routeAppMessage()` (AppBridge)
- Notify-then-fetch pattern: `room.notify.*` delivers lightweight IDs → full content fetched via `msg.get` request/reply (lines 278-299)
- Message deduplication by `{timestamp, user}` (lines 250-253)
- Edit/delete/react mutations via `messageUpdates` map (lines 123-247) — exposed via `getUpdates()`
- Reply count tracking (lines 392-396) — exposed via `getReplyCounts()`
- Unread/mention count tracking (lines 264-275)
- History fetch via `chat.history.*` (lines 305-340)
- Thread history fetch (lines 342-395)
- Active room tracking for unread skip (lines 264-268)
- 200-message-per-room limit (line 94)
- E2EE decryption integration (calls E2EEKeyManager.decrypt when message has e2ee field)

**Note:** `sendMessage`, `editMessage`, `deleteMessage`, `reactToMessage` are consolidated from component code into the `ChatClient` facade — these are not extracted from providers but centralized from scattered component logic.

**Note:** `openThread`/`closeThread`/`activeThread` state is UI-only and stays in the React component layer (not part of MessageStore).

### PresenceManager

Heartbeat, status publishing, online user tracking.

```typescript
class PresenceManager extends TypedEmitter<{
  presenceChanged: (room: string, users: Array<{ userId: string; status: string }>) => void
}> {
  constructor(cm: ConnectionManager, rm: RoomManager, username: string)
  setStatus(status: string): void
  getOnlineUsers(room: string): Array<{ userId: string; status: string }>
  startHeartbeat(): void
  stopHeartbeat(): void
  publishDisconnect(): void
  get currentStatus(): string
}
```

**Key logic migrated from:** `MessageProvider.tsx`
- Heartbeat every 10s on `presence.heartbeat` (lines 468-481)
- Status publish on `presence.update` (lines 921-928)
- Presence diff processing: consumes `RoomManager.on('rawPresence')` events
- Initial presence fetch via `presence.room.{memberKey}` request/reply (triggered by `RoomManager.on('joined')`)
- `connId` generation for heartbeat identity
- `presence.disconnect` on beforeunload (lines 871-875)

**Note:** `PresenceManager` receives `RoomManager` to listen for `rawPresence` events from per-room subscriptions. `RoomManager` owns the `room.presence.*` subscriptions; `PresenceManager` processes the data.

### E2EEKeyManager

Key distribution protocol. Uses existing `E2EEManager.ts` for crypto primitives.

```typescript
class E2EEKeyManager extends TypedEmitter<{
  ready: () => void
  roomEnabled: (room: string) => void
  keyRotated: (room: string, epoch: number) => void
  initError: (error: string) => void
}> {
  constructor(cm: ConnectionManager, username: string)
  init(): Promise<void>
  get isReady(): boolean
  isRoomEncrypted(room: string): boolean
  getRoomMeta(room: string): E2EERoomMeta | null
  enableRoom(room: string): Promise<void>
  fetchRoomMeta(room: string): Promise<E2EERoomMeta | null>
  encrypt(room: string, plaintext: string, user: string, timestamp: number): Promise<{ ciphertext: string; epoch: number }>
  decrypt(msg: ChatMessage): Promise<DecryptResult>  // returns { status, text } union
}
```

**Key logic migrated from:** `E2EEProvider.tsx`
- Identity key initialization + publish (lines 84-120)
- Room meta fetching from `e2ee.room.meta.{room}` (lines 122-196)
- Key wrapping/unwrapping via request/reply (lines 348-365)
- Key rotation on member leave (lines 306-386)
- Enable E2EE on room (lines 492-601)
- Key request handling as distributor (lines 232-297)
- Room meta fetching via `e2ee.room.meta.{room}` (lines 393-427) — exposed via `fetchRoomMeta()`
- Subscribe to `e2ee.roomkey.rotate.*` for rotation events
- `decrypt()` preserves `DecryptResult` union type (plaintext/decrypted/no_key/failed) with auto key-fetch-on-miss retry
- BroadcastChannel cross-tab sync already handled in `E2EEManager.ts` (unchanged)

### ReadReceiptManager

Debounced read position tracking.

```typescript
class ReadReceiptManager {
  constructor(cm: ConnectionManager, username: string)
  markRead(room: string, timestamp: number): void  // 3s debounce
  fetchReceipts(room: string): Promise<Array<{ userId: string; lastRead: number }>>
  destroy(): void
}
```

**Key logic migrated from:** `MessageProvider.tsx:934-990`
- 3-second debounce timer per room
- Publish `read.update.{memberKey}` with `{ room, userId, timestamp }`
- Fetch read receipts via `read.state.{memberKey}` request/reply (lines 979-990)

### TranslationService

Availability polling + translation requests.

```typescript
class TranslationService extends TypedEmitter<{
  availabilityChanged: (available: boolean) => void
  result: (msgKey: string, text: string, done: boolean) => void
}> {
  constructor(cm: ConnectionManager)
  get isAvailable(): boolean
  request(text: string, targetLang: string, msgKey: string): void
  clearResult(msgKey: string): void
  markUnavailable(): void  // triggers recovery polling
  destroy(): void
}
```

**Key logic migrated from:** `MessageProvider.tsx`
- Availability polling via `translate.ping`: pings once on connect, then polls every 60s only while unavailable (lines 885-919)
- Translation request via `translate.request` (lines 519-541)
- Streaming response chunks accumulated with `done` flag

---

## ChatClient Facade

```typescript
class ChatClient extends TypedEmitter<{
  connected: () => void
  disconnected: () => void
  error: (err: string) => void
}> {
  constructor(config: ChatClientConfig)

  // Lifecycle
  connect(): Promise<void>
  disconnect(): Promise<void>
  get isConnected(): boolean

  // Sub-managers (for granular access)
  readonly connection: ConnectionManager
  readonly rooms: RoomManager
  readonly messages: MessageStore
  readonly presence: PresenceManager
  readonly e2ee: E2EEKeyManager
  readonly readReceipts: ReadReceiptManager
  readonly translation: TranslationService

  // Convenience methods (delegate to managers)
  joinRoom(room: string): Promise<void>
  leaveRoom(room: string): Promise<void>
  sendMessage(room: string, text: string, opts?: SendOptions): Promise<void>
  editMessage(room: string, timestamp: number, user: string, newText: string): Promise<void>
  deleteMessage(room: string, timestamp: number, user: string): Promise<void>
  reactToMessage(room: string, timestamp: number, user: string, emoji: string): Promise<void>
}

interface ChatClientConfig {
  token: string
  wsUrl: string
  username: string
}

interface SendOptions {
  threadId?: string
  mentions?: string[]
  sticker?: { productId: string; stickerId: string }
}
```

### Internal Wiring (in constructor)

1. Create `ConnectionManager` with wsUrl
2. Create `RoomManager` with connection + username
3. Create `E2EEKeyManager` with connection + username
4. Create `MessageStore` with connection + rooms + e2ee + username
5. Create `PresenceManager` with connection + username
6. Create `ReadReceiptManager` with connection + username
7. Create `TranslationService` with connection

Event wiring:
- `connection.on('connected')` → `e2ee.init()`, `presence.startHeartbeat()`, `translation.startPolling()`
- `connection.on('reconnected')` → `rooms.rejoinAll()`, `presence.startHeartbeat()`
- `connection.on('disconnected')` → `presence.stopHeartbeat()`
- `rooms.on('joined')` → `messages` starts tracking room, `e2ee.fetchRoomMeta(room)`, `presence` fetches initial users
- `rooms.on('rawNotification')` → `messages` processes notify-then-fetch
- `rooms.on('rawPresence')` → `presence` processes diff
- `beforeunload` → `rooms.leaveAll()`, `presence.publishDisconnect()`, flush

**Subscription ownership:**
- `deliver.{user}.>` — owned by `MessageStore` (routes to internal handlers + AppBridge)
- `room.notify.{memberKey}` — owned by `RoomManager`, raw data forwarded to `MessageStore` via event
- `room.presence.{memberKey}` — owned by `RoomManager`, raw data forwarded to `PresenceManager` via event

### Convenience Methods

```typescript
// Delegates to managers
async joinRoom(room: string) { await this.rooms.join(room) }
async leaveRoom(room: string) { await this.rooms.leave(room) }

async sendMessage(room: string, text: string, opts?: SendOptions) {
  const payload: any = { user: this.username, text, timestamp: Date.now(), ...opts }
  if (this.e2ee.isRoomEncrypted(room)) {
    const { ciphertext, epoch } = await this.e2ee.encrypt(room, text, this.username, payload.timestamp)
    payload.text = ciphertext
    payload.e2ee = { epoch, v: 1 }
  }
  const subject = opts?.threadId
    ? `deliver.${this.username}.send.${room}.thread.${opts.threadId}`
    : `deliver.${this.username}.send.${room}`
  await this.connection.nc!.publish(subject, sc.encode(JSON.stringify(payload)), { headers: tracedHeaders() })
}
```

---

## React Hooks

### useNatsChat

```typescript
function useNatsChat(config: ChatClientConfig | null): ChatClient | null {
  // Creates ChatClient on config change
  // Calls client.connect() on mount, client.disconnect() on unmount
  // Returns null while connecting
}
```

### useMessages

```typescript
function useMessages(client: ChatClient | null, room: string): {
  messages: ChatMessage[]
  unread: number
  mentions: number
  updates: Record<string, MessageUpdate>
  replyCounts: Record<string, number>
} {
  // Subscribes to client.messages events for the room
  // Returns current state, updates on events
}
```

### usePresence

```typescript
function usePresence(client: ChatClient | null, room: string): Record<string, string> {
  // Subscribes to client.presence.on('presenceChanged')
  // Returns online users for the room
}
```

### useE2EE

```typescript
function useE2EE(client: ChatClient | null): {
  ready: boolean
  error: string | null
  isRoomEncrypted: (room: string) => boolean
  enableRoom: (room: string) => Promise<void>
} {
  // Subscribes to client.e2ee events
}
```

### useTranslation

```typescript
function useTranslation(client: ChatClient | null): {
  available: boolean
  results: Record<string, string>
  request: (text: string, lang: string, key: string) => void
}
```

---

## Provider Simplification

### Before (4 nested providers)

```typescript
<AuthProvider>
  <NatsProvider>
    <E2EEProvider>
      <MessageProvider>
        <ChatContent />
      </MessageProvider>
    </E2EEProvider>
  </NatsProvider>
</AuthProvider>
```

### After (1 provider + hooks)

```typescript
<AuthProvider>
  <ChatClientProvider token={token} wsUrl={wsUrl} username={username}>
    <ChatContent />
  </ChatClientProvider>
</AuthProvider>
```

`ChatClientProvider` creates the `ChatClient` instance and provides it via React context. Components use individual hooks to access specific functionality.

---

## Migration Strategy

Incremental migration — each step produces a working app:

1. **Create `EventEmitter.ts` and `types.ts`** — foundation, no functional change
2. **Extract `ConnectionManager`** — replace `NatsProvider` internals, keep provider shell
3. **Extract `MessageStore` + `RoomManager` together** — these are tightly coupled (room subscriptions feed message processing). Extract as a pair with `RoomManager` emitting raw events that `MessageStore` consumes. Keep `MessageProvider` as thin wrapper calling both.
4. **Extract `PresenceManager`** — consumes `RoomManager.on('rawPresence')`, move heartbeat/status logic
5. **Extract `E2EEKeyManager`** — move key distribution from `E2EEProvider`
6. **Extract `ReadReceiptManager` + `TranslationService`** — smaller extractions
7. **Create `ChatClient` facade** — wire managers together
8. **Create React hooks** — `useNatsChat`, `useMessages`, `usePresence`, `useE2EE`, `useTranslation`
9. **Migrate components** — update components to use hooks instead of provider context
10. **Delete old providers** — remove `NatsProvider`, `MessageProvider`, `E2EEProvider`

Each step should be committed independently. The app should work after every step.

---

## Testing Strategy

Each manager is independently unit-testable without React:

- **ConnectionManager**: mock `nats.ws` `connect()`, verify event emissions on status changes
- **RoomManager**: mock `ConnectionManager.nc`, verify join/leave publishes and subscription tracking
- **MessageStore**: mock connection, feed raw NATS messages, verify dedup, mutations, unread counts
- **PresenceManager**: mock connection, verify heartbeat interval, status publish
- **E2EEKeyManager**: mock connection + E2EEManager, verify key fetch/wrap/rotate protocol
- **ReadReceiptManager**: mock connection, verify 3s debounce behavior
- **TranslationService**: mock connection, verify polling and result accumulation

Testing framework: Vitest (already a Vite project, zero config needed).

---

## Constraints

- No external dependencies beyond `nats.ws` and existing OTel packages
- `EventEmitter` is custom (no Node.js `events` module — runs in browser)
- All managers receive `ConnectionManager` (not raw `NatsConnection`) to participate in lifecycle
- `ChatClient` is the only public entry point for consumers; managers are accessible but not independently constructable by external code
- Existing `E2EEManager.ts` crypto primitives unchanged
- Existing `AppBridge.ts` unchanged (receives `NatsConnection` from `ChatClient.connection.nc`)
