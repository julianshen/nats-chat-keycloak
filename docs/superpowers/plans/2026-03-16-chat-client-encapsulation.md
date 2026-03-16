# Chat Client Encapsulation Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract framework-agnostic ChatClient from React providers into `web/src/lib/chat-client/`, with thin React hooks as wrappers.

**Architecture:** Facade pattern — `ChatClient` creates and wires internal managers (`ConnectionManager`, `RoomManager`, `MessageStore`, `PresenceManager`, `E2EEKeyManager`, `ReadReceiptManager`, `TranslationService`). Each manager extends a lightweight typed `EventEmitter`. React hooks subscribe to manager events and update component state. Migration is incremental — each task produces a working app.

**Tech Stack:** TypeScript, nats.ws, Vitest (test framework), existing E2EEManager.ts + AppBridge.ts

**Spec:** `docs/superpowers/specs/2026-03-16-chat-client-encapsulation-design.md`

---

## Chunk 1: Foundation + ConnectionManager

### Task 1: EventEmitter + types foundation

**Files:**
- Create: `web/src/lib/chat-client/EventEmitter.ts`
- Create: `web/src/lib/chat-client/types.ts`
- Create: `web/src/lib/chat-client/index.ts`

- [ ] **Step 1: Create typed EventEmitter**

```typescript
// web/src/lib/chat-client/EventEmitter.ts
export class TypedEmitter<Events extends Record<string, (...args: any[]) => void>> {
  private listeners = new Map<keyof Events, Set<Function>>();

  on<K extends keyof Events>(event: K, listener: Events[K]): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener);
    return () => this.off(event, listener);
  }

  off<K extends keyof Events>(event: K, listener: Events[K]): void {
    this.listeners.get(event)?.delete(listener);
  }

  protected emit<K extends keyof Events>(event: K, ...args: Parameters<Events[K]>): void {
    this.listeners.get(event)?.forEach(fn => fn(...args));
  }

  removeAllListeners(): void {
    this.listeners.clear();
  }
}
```

- [ ] **Step 2: Create types**

```typescript
// web/src/lib/chat-client/types.ts
import type { ChatMessage } from '../../types';

export interface ChatClientConfig {
  token: string;
  wsUrl: string;
  username: string;
}

export interface SendOptions {
  threadId?: string;
  mentions?: string[];
  sticker?: { productId: string; stickerId: string };
}

export interface MessageUpdate {
  text?: string;
  editedAt?: number;
  isDeleted?: boolean;
  reactions?: Record<string, string[]>;
}

export interface E2EERoomMeta {
  enabled: boolean;
  epoch: number;
  enabledBy?: string;
}

export type DecryptResult =
  | { status: 'plaintext'; text: string }
  | { status: 'decrypted'; text: string }
  | { status: 'no_key'; text: string }
  | { status: 'failed'; text: string; error: string };

export type { ChatMessage };
```

- [ ] **Step 3: Create index**

```typescript
// web/src/lib/chat-client/index.ts
export { TypedEmitter } from './EventEmitter';
export * from './types';
```

- [ ] **Step 4: Install Vitest and verify**

Run: `cd web && npm install -D vitest && npx vitest run --passWithNoTests`
Expected: PASS (no tests yet)

- [ ] **Step 5: Write EventEmitter test**

Create `web/src/lib/chat-client/__tests__/EventEmitter.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { TypedEmitter } from '../EventEmitter';

type TestEvents = {
  message: (text: string) => void;
  count: (n: number) => void;
};

describe('TypedEmitter', () => {
  it('emits events to listeners', () => {
    const emitter = new (class extends TypedEmitter<TestEvents> {
      fire<K extends keyof TestEvents>(e: K, ...args: Parameters<TestEvents[K]>) { this.emit(e, ...args); }
    })();
    const fn = vi.fn();
    emitter.on('message', fn);
    emitter.fire('message', 'hello');
    expect(fn).toHaveBeenCalledWith('hello');
  });

  it('on() returns unsubscribe function', () => {
    const emitter = new (class extends TypedEmitter<TestEvents> {
      fire<K extends keyof TestEvents>(e: K, ...args: Parameters<TestEvents[K]>) { this.emit(e, ...args); }
    })();
    const fn = vi.fn();
    const unsub = emitter.on('message', fn);
    unsub();
    emitter.fire('message', 'hello');
    expect(fn).not.toHaveBeenCalled();
  });

  it('removeAllListeners clears everything', () => {
    const emitter = new (class extends TypedEmitter<TestEvents> {
      fire<K extends keyof TestEvents>(e: K, ...args: Parameters<TestEvents[K]>) { this.emit(e, ...args); }
    })();
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    emitter.on('message', fn1);
    emitter.on('count', fn2);
    emitter.removeAllListeners();
    emitter.fire('message', 'hello');
    emitter.fire('count', 42);
    expect(fn1).not.toHaveBeenCalled();
    expect(fn2).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: Run test**

Run: `cd web && npx vitest run src/lib/chat-client/__tests__/EventEmitter.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 7: Commit**

```bash
git add web/src/lib/chat-client/ web/package.json web/package-lock.json
git commit -m "feat: add EventEmitter foundation and types for chat-client"
```

### Task 2: ConnectionManager

**Files:**
- Create: `web/src/lib/chat-client/ConnectionManager.ts`
- Create: `web/src/lib/chat-client/__tests__/ConnectionManager.test.ts`
- Modify: `web/src/lib/chat-client/index.ts`

- [ ] **Step 1: Implement ConnectionManager**

```typescript
// web/src/lib/chat-client/ConnectionManager.ts
import { connect, type NatsConnection, StringCodec } from 'nats.ws';
import { TypedEmitter } from './EventEmitter';

export const sc = StringCodec();

type ConnectionEvents = {
  connected: () => void;
  disconnected: () => void;
  reconnected: () => void;
  error: (err: string) => void;
};

export class ConnectionManager extends TypedEmitter<ConnectionEvents> {
  private _nc: NatsConnection | null = null;
  private _connected = false;
  private connecting = false;
  private wsUrl: string;
  private name: string;

  constructor(config: { wsUrl: string; name: string }) {
    super();
    this.wsUrl = config.wsUrl;
    this.name = config.name;
  }

  get nc(): NatsConnection | null { return this._nc; }
  get isConnected(): boolean { return this._connected; }

  async connect(token: string): Promise<void> {
    if (this.connecting) return;
    this.connecting = true;

    // Drain old connection
    if (this._nc) {
      try { await this._nc.drain(); } catch { /* ignore */ }
      this._nc = null;
      this._connected = false;
    }

    try {
      const conn = await connect({
        servers: this.wsUrl,
        token,
        name: this.name,
        maxReconnectAttempts: -1,
        reconnectTimeWait: 2000,
      });

      this._nc = conn;
      this._connected = true;
      this.emit('connected');

      // Monitor status — stop if connection replaced
      (async () => {
        for await (const s of conn.status()) {
          if (this._nc !== conn) break;
          switch (s.type) {
            case 'disconnect':
              this._connected = false;
              this.emit('disconnected');
              break;
            case 'reconnect':
              this._connected = true;
              this.emit('reconnected');
              break;
            case 'error':
              this.emit('error', `Connection error: ${s.data}`);
              break;
          }
        }
      })();

      // Handle close
      conn.closed().then(() => {
        if (this._nc === conn) {
          this._connected = false;
          this._nc = null;
          this.emit('disconnected');
        }
      });
    } catch (err: any) {
      this.emit('error', `Failed to connect: ${err.message}`);
      this._connected = false;
    } finally {
      this.connecting = false;
    }
  }

  async disconnect(): Promise<void> {
    if (this._nc) {
      try { await this._nc.drain(); } catch { /* ignore */ }
      this._nc = null;
      this._connected = false;
    }
  }
}
```

- [ ] **Step 2: Write ConnectionManager test**

```typescript
// web/src/lib/chat-client/__tests__/ConnectionManager.test.ts
import { describe, it, expect, vi } from 'vitest';
import { ConnectionManager } from '../ConnectionManager';

// We can't test real NATS connections in unit tests, but we can test the class API
describe('ConnectionManager', () => {
  it('starts disconnected', () => {
    const cm = new ConnectionManager({ wsUrl: 'ws://localhost:9222', name: 'test' });
    expect(cm.isConnected).toBe(false);
    expect(cm.nc).toBeNull();
  });

  it('emits error on connection failure', async () => {
    const cm = new ConnectionManager({ wsUrl: 'ws://invalid:1', name: 'test' });
    const errorFn = vi.fn();
    cm.on('error', errorFn);
    await cm.connect('fake-token');
    expect(errorFn).toHaveBeenCalled();
    expect(cm.isConnected).toBe(false);
  });
});
```

- [ ] **Step 3: Run test**

Run: `cd web && npx vitest run src/lib/chat-client/__tests__/ConnectionManager.test.ts`
Expected: PASS

- [ ] **Step 4: Update index.ts**

```typescript
// web/src/lib/chat-client/index.ts
export { TypedEmitter } from './EventEmitter';
export { ConnectionManager, sc } from './ConnectionManager';
export * from './types';
```

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/chat-client/
git commit -m "feat: add ConnectionManager for NATS WebSocket lifecycle"
```

---

## Chunk 2: RoomManager + MessageStore

### Task 3: RoomManager

**Files:**
- Create: `web/src/lib/chat-client/RoomManager.ts`
- Modify: `web/src/lib/chat-client/index.ts`

- [ ] **Step 1: Implement RoomManager**

```typescript
// web/src/lib/chat-client/RoomManager.ts
import type { Subscription, MsgHdrs } from 'nats.ws';
import { TypedEmitter } from './EventEmitter';
import { ConnectionManager, sc } from './ConnectionManager';
import { tracedHeaders } from '../../utils/tracing';

type RoomEvents = {
  joined: (room: string) => void;
  left: (room: string) => void;
  rawNotification: (room: string, data: Uint8Array, headers: MsgHdrs | undefined) => void;
  rawPresence: (room: string, data: Uint8Array) => void;
};

export class RoomManager extends TypedEmitter<RoomEvents> {
  private cm: ConnectionManager;
  private username: string;
  private joined = new Set<string>();
  private roomSubs = new Map<string, Subscription[]>();

  constructor(cm: ConnectionManager, username: string) {
    super();
    this.cm = cm;
    this.username = username;
  }

  get joinedRooms(): ReadonlySet<string> { return this.joined; }

  roomToMemberKey(room: string): string {
    return room === '__admin__' ? '__admin__chat' : room;
  }

  async join(room: string): Promise<void> {
    if (this.joined.has(room) || !this.cm.nc) return;
    this.joined.add(room);

    const memberKey = this.roomToMemberKey(room);
    const nc = this.cm.nc;
    const subs: Subscription[] = [];

    // Subscribe to notifications
    const notifySub = nc.subscribe(`room.notify.${memberKey}`);
    subs.push(notifySub);
    (async () => {
      for await (const msg of notifySub) {
        this.emit('rawNotification', room, msg.data, msg.headers);
      }
    })();

    // Subscribe to presence
    const presenceSub = nc.subscribe(`room.presence.${memberKey}`);
    subs.push(presenceSub);
    (async () => {
      for await (const msg of presenceSub) {
        this.emit('rawPresence', room, msg.data);
      }
    })();

    this.roomSubs.set(room, subs);

    // Publish join event
    nc.publish(`room.join.${memberKey}`,
      sc.encode(JSON.stringify({ userId: this.username })),
      { headers: tracedHeaders() }
    );

    this.emit('joined', room);
  }

  async leave(room: string): Promise<void> {
    if (!this.joined.has(room)) return;
    this.joined.delete(room);

    // Unsubscribe
    const subs = this.roomSubs.get(room);
    if (subs) {
      subs.forEach(s => s.unsubscribe());
      this.roomSubs.delete(room);
    }

    // Publish leave event
    if (this.cm.nc) {
      const memberKey = this.roomToMemberKey(room);
      this.cm.nc.publish(`room.leave.${memberKey}`,
        sc.encode(JSON.stringify({ userId: this.username })),
        { headers: tracedHeaders() }
      );
    }

    this.emit('left', room);
  }

  async leaveAll(): Promise<void> {
    const rooms = [...this.joined];
    for (const room of rooms) {
      await this.leave(room);
    }
  }

  async rejoinAll(): Promise<void> {
    const rooms = [...this.joined];
    // Clear current state
    this.roomSubs.forEach(subs => subs.forEach(s => s.unsubscribe()));
    this.roomSubs.clear();
    this.joined.clear();
    // Rejoin all
    for (const room of rooms) {
      await this.join(room);
    }
  }

  destroy(): void {
    this.roomSubs.forEach(subs => subs.forEach(s => s.unsubscribe()));
    this.roomSubs.clear();
    this.joined.clear();
    this.removeAllListeners();
  }
}
```

- [ ] **Step 2: Write RoomManager test**

Create `web/src/lib/chat-client/__tests__/RoomManager.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { RoomManager } from '../RoomManager';

// Mock ConnectionManager with no real NATS
function mockCM(nc: any = null) {
  return { nc, isConnected: !!nc, on: vi.fn(() => vi.fn()), off: vi.fn(), removeAllListeners: vi.fn() } as any;
}

describe('RoomManager', () => {
  it('starts with no joined rooms', () => {
    const rm = new RoomManager(mockCM(), 'alice');
    expect(rm.joinedRooms.size).toBe(0);
  });

  it('roomToMemberKey maps __admin__ correctly', () => {
    const rm = new RoomManager(mockCM(), 'alice');
    expect(rm.roomToMemberKey('__admin__')).toBe('__admin__chat');
    expect(rm.roomToMemberKey('general')).toBe('general');
  });

  it('join without connection is no-op', async () => {
    const rm = new RoomManager(mockCM(null), 'alice');
    await rm.join('general');
    expect(rm.joinedRooms.size).toBe(0);
  });

  it('join with connection tracks room and emits event', async () => {
    const publishFn = vi.fn();
    const subscribeFn = vi.fn(() => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }), unsubscribe: vi.fn() }));
    const nc = { publish: publishFn, subscribe: subscribeFn };
    const rm = new RoomManager(mockCM(nc), 'alice');

    const joinedFn = vi.fn();
    rm.on('joined', joinedFn);
    await rm.join('general');

    expect(rm.joinedRooms.has('general')).toBe(true);
    expect(joinedFn).toHaveBeenCalledWith('general');
    expect(publishFn).toHaveBeenCalled(); // room.join publish
  });

  it('duplicate join is no-op', async () => {
    const subscribeFn = vi.fn(() => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }), unsubscribe: vi.fn() }));
    const nc = { publish: vi.fn(), subscribe: subscribeFn };
    const rm = new RoomManager(mockCM(nc), 'alice');
    await rm.join('general');
    await rm.join('general');
    expect(subscribeFn).toHaveBeenCalledTimes(2); // 2 subs for 1 join (notify + presence)
  });
});
```

- [ ] **Step 3: Run test**

Run: `cd web && npx vitest run src/lib/chat-client/__tests__/RoomManager.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add web/src/lib/chat-client/
git commit -m "feat: add RoomManager for room join/leave and subscription management"
```

### Task 4: MessageStore

**Files:**
- Create: `web/src/lib/chat-client/MessageStore.ts`
- Modify: `web/src/lib/chat-client/index.ts`

- [ ] **Step 1: Implement MessageStore**

This is the largest extraction. Create `web/src/lib/chat-client/MessageStore.ts` with:

- Internal state: `messagesByRoom`, `threadMessages`, `unreadCounts`, `mentionCounts`, `messageUpdates`, `replyCounts`
- `deliver.{user}.>` subscription setup and message routing
- `rawNotification` handler (notify-then-fetch via `msg.get`)
- Message dedup by `{timestamp, user}`
- Edit/delete/react mutation logic
- History fetch via `chat.history.*`
- Thread history fetch
- Active room tracking for unread skip
- App message routing to `routeAppMessage()`

The implementation should mirror the logic currently in `MessageProvider.tsx` lines 123-773 and 934-964, extracted as a class with event emissions instead of `setState` calls.

Key method signatures:

```typescript
export class MessageStore extends TypedEmitter<MessageStoreEvents> {
  constructor(cm: ConnectionManager, rm: RoomManager, username: string)

  // State access
  getMessages(room: string): ChatMessage[]
  getThreadMessages(threadId: string): ChatMessage[]
  getUnread(room: string): { count: number; mentions: number }
  getUpdates(): Record<string, MessageUpdate>
  getReplyCounts(): Record<string, number>

  // Actions
  setActiveRoom(room: string | null): void
  clearUnread(room: string): void
  fetchHistory(room: string): Promise<{ messages: ChatMessage[]; hasMore: boolean }>
  fetchThreadHistory(threadId: string): Promise<ChatMessage[]>

  // Internal — processes raw NATS data from deliver subscription + room notifications
  start(): void   // creates deliver.{user}.> subscription
  destroy(): void
}
```

The implementer should read `MessageProvider.tsx` fully and extract:
1. Lines 123-247: `applyMessageUpdate` function → `private applyUpdate()`
2. Lines 250-275: `processRoomChatMessage` → `private processMessage()`
3. Lines 278-299: `fetchMessageContent` via `msg.get` → `private fetchContent()`
4. Lines 305-395: history/thread fetch → `fetchHistory()`, `fetchThreadHistory()`
5. Lines 504-773: `deliver.{user}.>` subscription handler → `start()` method
6. Lines 560-658: room notification handler → wired via `RoomManager.on('rawNotification')`
7. Lines 934-964: markAsRead → `markAsRead()` (with 3s debounce)

Each mutation emits the appropriate event instead of calling React setState.

- [ ] **Step 2: Write MessageStore test**

Create `web/src/lib/chat-client/__tests__/MessageStore.test.ts` testing:
- `getMessages()` returns empty array for unknown room
- `processMessage()` deduplicates by timestamp+user
- `applyUpdate()` correctly handles edit, delete, react
- `getUnread()` increments for inactive rooms
- `clearUnread()` resets counts

- [ ] **Step 3: Run test**

Run: `cd web && npx vitest run src/lib/chat-client/__tests__/MessageStore.test.ts`
Expected: PASS

- [ ] **Step 4: Update index.ts to export all managers**

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/chat-client/
git commit -m "feat: add MessageStore for message processing, dedup, and mutations"
```

---

## Chunk 3: PresenceManager + E2EEKeyManager

### Task 5: PresenceManager

**Files:**
- Create: `web/src/lib/chat-client/PresenceManager.ts`

- [ ] **Step 1: Implement PresenceManager**

```typescript
// web/src/lib/chat-client/PresenceManager.ts
import { TypedEmitter } from './EventEmitter';
import { ConnectionManager, sc } from './ConnectionManager';
import { RoomManager } from './RoomManager';
import { tracedHeaders } from '../../utils/tracing';

type PresenceMember = { userId: string; status: string };

type PresenceEvents = {
  presenceChanged: (room: string, users: PresenceMember[]) => void;
};

export class PresenceManager extends TypedEmitter<PresenceEvents> {
  private cm: ConnectionManager;
  private rm: RoomManager;
  private username: string;
  private connId: string;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private onlineUsers = new Map<string, PresenceMember[]>();
  private _status = 'online';

  constructor(cm: ConnectionManager, rm: RoomManager, username: string) {
    super();
    this.cm = cm;
    this.rm = rm;
    this.username = username;
    this.connId = crypto.randomUUID?.() || Math.random().toString(36).slice(2);

    // Listen for raw presence data from RoomManager
    this.rm.on('rawPresence', (room, data) => this.handlePresenceDiff(room, data));

    // Fetch initial presence when room is joined
    this.rm.on('joined', (room) => this.fetchInitialPresence(room));
  }

  get currentStatus(): string { return this._status; }

  getOnlineUsers(room: string): PresenceMember[] {
    return this.onlineUsers.get(room) || [];
  }

  setStatus(status: string): void {
    this._status = status;
    if (this.cm.nc) {
      this.cm.nc.publish('presence.update',
        sc.encode(JSON.stringify({ userId: this.username, status })),
        { headers: tracedHeaders() }
      );
    }
  }

  startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.cm.nc) {
        this.cm.nc.publish('presence.heartbeat',
          sc.encode(JSON.stringify({ userId: this.username, connId: this.connId })),
          { headers: tracedHeaders() }
        );
      }
    }, 10000);
    // Immediate first heartbeat
    if (this.cm.nc) {
      this.cm.nc.publish('presence.heartbeat',
        sc.encode(JSON.stringify({ userId: this.username, connId: this.connId })),
        { headers: tracedHeaders() }
      );
    }
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  publishDisconnect(): void {
    if (this.cm.nc) {
      this.cm.nc.publish('presence.disconnect',
        sc.encode(JSON.stringify({ userId: this.username, connId: this.connId })),
        { headers: tracedHeaders() }
      );
    }
  }

  private handlePresenceDiff(room: string, data: Uint8Array): void {
    try {
      const diff = JSON.parse(sc.decode(data));
      const current = this.onlineUsers.get(room) || [];
      // Apply diff: add/update joined users, remove left users
      let updated = [...current];
      if (diff.joined) {
        for (const u of diff.joined) {
          const idx = updated.findIndex(m => m.userId === u.userId);
          if (idx >= 0) { updated[idx] = u; } else { updated.push(u); }
        }
      }
      if (diff.left) {
        const leftSet = new Set(diff.left.map((u: any) => u.userId));
        updated = updated.filter(m => !leftSet.has(m.userId));
      }
      this.onlineUsers.set(room, updated);
      this.emit('presenceChanged', room, updated);
    } catch { /* ignore malformed */ }
  }

  private async fetchInitialPresence(room: string): Promise<void> {
    if (!this.cm.nc) return;
    try {
      const memberKey = this.rm.roomToMemberKey(room);
      const reply = await this.cm.nc.request(`presence.room.${memberKey}`,
        sc.encode(JSON.stringify({ room })),
        { timeout: 5000 }
      );
      const users = JSON.parse(sc.decode(reply.data)) as PresenceMember[];
      this.onlineUsers.set(room, users);
      this.emit('presenceChanged', room, users);
    } catch { /* ignore timeout */ }
  }

  destroy(): void {
    this.stopHeartbeat();
    this.removeAllListeners();
  }
}
```

- [ ] **Step 2: Write test, run, commit**

Test basic construction, `startHeartbeat`/`stopHeartbeat` lifecycle, `setStatus`, `getOnlineUsers` returning empty array for unknown room.

```bash
git add web/src/lib/chat-client/
git commit -m "feat: add PresenceManager for heartbeat and online user tracking"
```

### Task 6: E2EEKeyManager

**Files:**
- Create: `web/src/lib/chat-client/E2EEKeyManager.ts`

- [ ] **Step 1: Implement E2EEKeyManager**

Extract from `E2EEProvider.tsx`. The implementer should read `E2EEProvider.tsx` fully and migrate:
1. Lines 84-120: identity key init + publish → `init()`
2. Lines 122-196: room meta fetching → `fetchRoomMeta()`
3. Lines 232-297: key request handling (as distributor) → internal subscription handler
4. Lines 306-386: key rotation on member leave → internal subscription handler
5. Lines 437-490: encrypt/decrypt → `encrypt()`, `decrypt()` (preserve `DecryptResult` union)
6. Lines 492-601: enable E2EE → `enableRoom()`

Key: `decrypt()` should accept a `ChatMessage` and return `DecryptResult`, matching current behavior including auto key-fetch-on-miss retry.

```typescript
export class E2EEKeyManager extends TypedEmitter<E2EEKeyEvents> {
  constructor(cm: ConnectionManager, username: string)
  init(): Promise<void>
  get isReady(): boolean
  isRoomEncrypted(room: string): boolean
  getRoomMeta(room: string): E2EERoomMeta | null
  fetchRoomMeta(room: string): Promise<E2EERoomMeta | null>
  enableRoom(room: string): Promise<void>
  encrypt(room: string, plaintext: string, user: string, timestamp: number): Promise<{ ciphertext: string; epoch: number }>
  decrypt(msg: ChatMessage): Promise<DecryptResult>
  destroy(): void
}
```

- [ ] **Step 2: Write test, run, commit**

Test `isReady` starts false, `isRoomEncrypted` returns false for unknown rooms, `getRoomMeta` returns null for unknown rooms.

```bash
git add web/src/lib/chat-client/
git commit -m "feat: add E2EEKeyManager for key distribution protocol"
```

---

## Chunk 4: Small managers + ChatClient facade

### Task 7: ReadReceiptManager + TranslationService

**Files:**
- Create: `web/src/lib/chat-client/ReadReceiptManager.ts`
- Create: `web/src/lib/chat-client/TranslationService.ts`

- [ ] **Step 1: Implement ReadReceiptManager**

```typescript
// web/src/lib/chat-client/ReadReceiptManager.ts
import { ConnectionManager, sc } from './ConnectionManager';
import { tracedHeaders } from '../../utils/tracing';

export class ReadReceiptManager {
  private cm: ConnectionManager;
  private username: string;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(cm: ConnectionManager, username: string) {
    this.cm = cm;
    this.username = username;
  }

  private roomToMemberKey(room: string): string {
    return room === '__admin__' ? '__admin__chat' : room;
  }

  markRead(room: string, timestamp: number): void {
    // 3-second debounce per room
    const existing = this.timers.get(room);
    if (existing) clearTimeout(existing);

    this.timers.set(room, setTimeout(() => {
      this.timers.delete(room);
      if (this.cm.nc) {
        const memberKey = this.roomToMemberKey(room);
        this.cm.nc.publish(`read.update.${memberKey}`,
          sc.encode(JSON.stringify({ room, userId: this.username, timestamp })),
          { headers: tracedHeaders() }
        );
      }
    }, 3000));
  }

  async fetchReceipts(room: string): Promise<Array<{ userId: string; lastRead: number }>> {
    if (!this.cm.nc) return [];
    try {
      const memberKey = this.roomToMemberKey(room);
      const reply = await this.cm.nc.request(`read.state.${memberKey}`,
        sc.encode(JSON.stringify({ room })),
        { timeout: 5000 }
      );
      return JSON.parse(sc.decode(reply.data));
    } catch { return []; }
  }

  destroy(): void {
    this.timers.forEach(t => clearTimeout(t));
    this.timers.clear();
  }
}
```

- [ ] **Step 2: Implement TranslationService**

```typescript
// web/src/lib/chat-client/TranslationService.ts
import { TypedEmitter } from './EventEmitter';
import { ConnectionManager, sc } from './ConnectionManager';
import { tracedHeaders } from '../../utils/tracing';

type TranslationEvents = {
  availabilityChanged: (available: boolean) => void;
  result: (msgKey: string, text: string, done: boolean) => void;
};

export class TranslationService extends TypedEmitter<TranslationEvents> {
  private cm: ConnectionManager;
  private _available = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(cm: ConnectionManager) {
    super();
    this.cm = cm;
  }

  get isAvailable(): boolean { return this._available; }

  async checkAvailability(): Promise<void> {
    if (!this.cm.nc) return;
    try {
      const reply = await this.cm.nc.request('translate.ping', sc.encode('ping'), { timeout: 3000 });
      const result = JSON.parse(sc.decode(reply.data));
      const was = this._available;
      this._available = result.status === 'ok';
      if (was !== this._available) this.emit('availabilityChanged', this._available);
    } catch {
      if (this._available) {
        this._available = false;
        this.emit('availabilityChanged', false);
      }
    }
  }

  startPolling(): void {
    this.checkAvailability();
    this.pollTimer = setInterval(() => {
      if (!this._available) this.checkAvailability();
    }, 60000);
  }

  request(text: string, targetLang: string, msgKey: string): void {
    if (!this.cm.nc || !this._available) return;
    this.cm.nc.publish('translate.request',
      sc.encode(JSON.stringify({ text, targetLang, msgKey })),
      { headers: tracedHeaders() }
    );
  }

  clearResult(_msgKey: string): void {
    // Results are managed by the consumer (React hook) — this is a no-op signal
  }

  markUnavailable(): void {
    this._available = false;
    this.emit('availabilityChanged', false);
  }

  destroy(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.removeAllListeners();
  }
}
```

- [ ] **Step 3: Write tests, run, commit**

```bash
git add web/src/lib/chat-client/
git commit -m "feat: add ReadReceiptManager and TranslationService"
```

### Task 8: ChatClient facade

**Files:**
- Create: `web/src/lib/chat-client/ChatClient.ts`
- Modify: `web/src/lib/chat-client/index.ts`

- [ ] **Step 1: Implement ChatClient**

```typescript
// web/src/lib/chat-client/ChatClient.ts
import { TypedEmitter } from './EventEmitter';
import { ConnectionManager, sc } from './ConnectionManager';
import { RoomManager } from './RoomManager';
import { MessageStore } from './MessageStore';
import { PresenceManager } from './PresenceManager';
import { E2EEKeyManager } from './E2EEKeyManager';
import { ReadReceiptManager } from './ReadReceiptManager';
import { TranslationService } from './TranslationService';
import { tracedHeaders } from '../../utils/tracing';
import type { ChatClientConfig, SendOptions } from './types';

type ClientEvents = {
  connected: () => void;
  disconnected: () => void;
  error: (err: string) => void;
};

export class ChatClient extends TypedEmitter<ClientEvents> {
  readonly connection: ConnectionManager;
  readonly rooms: RoomManager;
  readonly messages: MessageStore;
  readonly presence: PresenceManager;
  readonly e2ee: E2EEKeyManager;
  readonly readReceipts: ReadReceiptManager;
  readonly translation: TranslationService;

  private config: ChatClientConfig;
  private cleanupBeforeUnload: (() => void) | null = null;

  constructor(config: ChatClientConfig) {
    super();
    this.config = config;

    // Create managers
    this.connection = new ConnectionManager({ wsUrl: config.wsUrl, name: config.username });
    this.rooms = new RoomManager(this.connection, config.username);
    this.e2ee = new E2EEKeyManager(this.connection, config.username);
    this.messages = new MessageStore(this.connection, this.rooms, config.username);
    this.presence = new PresenceManager(this.connection, this.rooms, config.username);
    this.readReceipts = new ReadReceiptManager(this.connection, config.username);
    this.translation = new TranslationService(this.connection);

    // Wire events
    this.connection.on('connected', () => {
      this.e2ee.init();
      this.presence.startHeartbeat();
      this.translation.startPolling();
      this.messages.start();
      this.emit('connected');
    });

    this.connection.on('reconnected', () => {
      this.rooms.rejoinAll();
      this.presence.startHeartbeat();
      this.messages.start();
      this.emit('connected');
    });

    this.connection.on('disconnected', () => {
      this.presence.stopHeartbeat();
      this.emit('disconnected');
    });

    this.connection.on('error', (err) => this.emit('error', err));

    this.rooms.on('joined', (room) => {
      this.e2ee.fetchRoomMeta(room);
    });

    // beforeunload cleanup
    const handler = () => {
      this.rooms.leaveAll();
      this.presence.publishDisconnect();
      try { this.connection.nc?.flush(); } catch { /* ignore */ }
    };
    window.addEventListener('beforeunload', handler);
    this.cleanupBeforeUnload = () => window.removeEventListener('beforeunload', handler);
  }

  async connect(): Promise<void> {
    await this.connection.connect(this.config.token);
  }

  async disconnect(): Promise<void> {
    this.messages.destroy();
    this.presence.destroy();
    this.translation.destroy();
    this.readReceipts.destroy();
    this.rooms.destroy();
    this.e2ee.destroy();
    await this.connection.disconnect();
    if (this.cleanupBeforeUnload) {
      this.cleanupBeforeUnload();
      this.cleanupBeforeUnload = null;
    }
    this.removeAllListeners();
  }

  get isConnected(): boolean { return this.connection.isConnected; }
  get username(): string { return this.config.username; }

  // Convenience methods
  async joinRoom(room: string): Promise<void> { await this.rooms.join(room); }
  async leaveRoom(room: string): Promise<void> { await this.rooms.leave(room); }

  async sendMessage(room: string, text: string, opts?: SendOptions): Promise<void> {
    if (!this.connection.nc) throw new Error('Not connected');
    const payload: any = {
      user: this.config.username,
      text,
      timestamp: Date.now(),
      mentions: opts?.mentions,
    };
    if (opts?.sticker) payload.sticker = opts.sticker;
    if (opts?.threadId) payload.threadId = opts.threadId;

    if (this.e2ee.isRoomEncrypted(room)) {
      const { ciphertext, epoch } = await this.e2ee.encrypt(room, text, this.config.username, payload.timestamp);
      payload.text = ciphertext;
      payload.e2ee = { epoch, v: 1 };
    }

    const subject = opts?.threadId
      ? `deliver.${this.config.username}.send.${room}.thread.${opts.threadId}`
      : `deliver.${this.config.username}.send.${room}`;

    this.connection.nc.publish(subject,
      sc.encode(JSON.stringify(payload)),
      { headers: tracedHeaders() }
    );
  }

  async editMessage(room: string, timestamp: number, user: string, newText: string): Promise<void> {
    if (!this.connection.nc) return;
    const payload = { user: this.config.username, text: newText, timestamp, editTimestamp: timestamp, editUser: user, action: 'edit' };
    this.connection.nc.publish(`deliver.${this.config.username}.send.${room}`,
      sc.encode(JSON.stringify(payload)),
      { headers: tracedHeaders() }
    );
  }

  async deleteMessage(room: string, timestamp: number, user: string): Promise<void> {
    if (!this.connection.nc) return;
    const payload = { user: this.config.username, timestamp, deleteTimestamp: timestamp, deleteUser: user, action: 'delete' };
    this.connection.nc.publish(`deliver.${this.config.username}.send.${room}`,
      sc.encode(JSON.stringify(payload)),
      { headers: tracedHeaders() }
    );
  }

  async reactToMessage(room: string, timestamp: number, user: string, emoji: string): Promise<void> {
    if (!this.connection.nc) return;
    const payload = { user: this.config.username, timestamp, reactTimestamp: timestamp, reactUser: user, emoji, action: 'react' };
    this.connection.nc.publish(`deliver.${this.config.username}.send.${room}`,
      sc.encode(JSON.stringify(payload)),
      { headers: tracedHeaders() }
    );
  }
}
```

- [ ] **Step 2: Update index.ts with full exports**

```typescript
// web/src/lib/chat-client/index.ts
export { TypedEmitter } from './EventEmitter';
export { ConnectionManager, sc } from './ConnectionManager';
export { RoomManager } from './RoomManager';
export { MessageStore } from './MessageStore';
export { PresenceManager } from './PresenceManager';
export { E2EEKeyManager } from './E2EEKeyManager';
export { ReadReceiptManager } from './ReadReceiptManager';
export { TranslationService } from './TranslationService';
export { ChatClient } from './ChatClient';
export * from './types';
```

- [ ] **Step 3: Write ChatClient test**

Test: construction creates all managers, `isConnected` starts false, `username` getter works.

- [ ] **Step 4: Run all tests**

Run: `cd web && npx vitest run src/lib/chat-client/`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/chat-client/
git commit -m "feat: add ChatClient facade wiring all managers together"
```

---

## Chunk 5: React hooks + component migration

### Task 9: React hooks

**Files:**
- Create: `web/src/hooks/useNatsChat.ts`
- Create: `web/src/hooks/useMessages.ts`
- Create: `web/src/hooks/usePresence.ts`
- Create: `web/src/hooks/useE2EE.ts`
- Create: `web/src/hooks/useTranslation.ts`

- [ ] **Step 1: Create useNatsChat hook**

```typescript
// web/src/hooks/useNatsChat.ts
import { useEffect, useRef, useState, createContext, useContext } from 'react';
import { ChatClient, type ChatClientConfig } from '../lib/chat-client';

const ChatClientContext = createContext<ChatClient | null>(null);

export const useChatClient = () => useContext(ChatClientContext);

export const ChatClientProvider: React.FC<{
  config: ChatClientConfig | null;
  children: React.ReactNode;
}> = ({ config, children }) => {
  const [client, setClient] = useState<ChatClient | null>(null);
  const clientRef = useRef<ChatClient | null>(null);

  useEffect(() => {
    if (!config) return;

    const c = new ChatClient(config);
    clientRef.current = c;
    setClient(c);
    c.connect();

    return () => {
      if (clientRef.current === c) {
        c.disconnect();
        clientRef.current = null;
        setClient(null);
      }
    };
  }, [config?.token, config?.wsUrl, config?.username]);

  return (
    <ChatClientContext.Provider value={client}>
      {children}
    </ChatClientContext.Provider>
  );
};
```

- [ ] **Step 2: Create useMessages hook**

```typescript
// web/src/hooks/useMessages.ts
import { useState, useEffect } from 'react';
import type { ChatClient } from '../lib/chat-client';
import type { ChatMessage, MessageUpdate } from '../lib/chat-client/types';

export function useMessages(client: ChatClient | null, room: string) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [unread, setUnread] = useState(0);
  const [mentions, setMentions] = useState(0);
  const [updates, setUpdates] = useState<Record<string, MessageUpdate>>({});
  const [replyCounts, setReplyCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!client) return;
    setMessages(client.messages.getMessages(room));
    const u = client.messages.getUnread(room);
    setUnread(u.count);
    setMentions(u.mentions);
    setUpdates({ ...client.messages.getUpdates() });
    setReplyCounts({ ...client.messages.getReplyCounts() });

    const unsubs = [
      client.messages.on('message', (r, msg) => {
        if (r === room) setMessages(client.messages.getMessages(room));
      }),
      client.messages.on('updated', (r) => {
        if (r === room) setUpdates({ ...client.messages.getUpdates() });
      }),
      client.messages.on('unreadChanged', (r, count, ments) => {
        if (r === room) { setUnread(count); setMentions(ments); }
      }),
      client.messages.on('replyCountChanged', () => {
        setReplyCounts({ ...client.messages.getReplyCounts() });
      }),
      client.messages.on('historyLoaded', (r) => {
        if (r === room) setMessages(client.messages.getMessages(room));
      }),
    ];

    return () => unsubs.forEach(u => u());
  }, [client, room]);

  return { messages, unread, mentions, updates, replyCounts };
}
```

- [ ] **Step 3: Create usePresence, useE2EE, useTranslation hooks**

Follow the same pattern — subscribe to manager events, return state. Each hook:
1. Reads initial state from manager
2. Subscribes to events in useEffect
3. Returns unsubscribe cleanup
4. Returns current state

- [ ] **Step 4: Commit**

```bash
git add web/src/hooks/
git commit -m "feat: add React hooks wrapping ChatClient managers"
```

### Task 10: Migrate components + delete old providers

**Files:**
- Modify: `web/src/App.tsx` — replace nested providers with `ChatClientProvider`
- Modify: all components to use new hooks
- Delete: `web/src/providers/NatsProvider.tsx`
- Delete: `web/src/providers/MessageProvider.tsx`
- Delete: `web/src/providers/E2EEProvider.tsx`

- [ ] **Step 1: Update App.tsx**

Replace provider nesting:

```typescript
// Before:
<AuthProvider>
  <NatsProvider>
    <E2EEProvider>
      <MessageProvider>
        <ChatContent />
      </MessageProvider>
    </E2EEProvider>
  </NatsProvider>
</AuthProvider>

// After:
<AuthProvider>
  <ChatClientProvider config={authenticated ? { token, wsUrl: NATS_WS_URL, username: userInfo.username } : null}>
    <ChatContent />
  </ChatClientProvider>
</AuthProvider>
```

Move room joining logic from `App.tsx:78-129` into `ChatContent` using `useChatClient()`.

- [ ] **Step 2: Update components one by one**

For each component (`ChatRoom`, `MessageList`, `MessageInput`, `Header`, `RoomSelector`, `ThreadPanel`):
1. Replace `useMessages()` (from old provider) with `useMessages(client, room)` (new hook)
2. Replace `useNats()` with `useChatClient()`
3. Replace direct NATS publishes with `client.sendMessage()`, `client.editMessage()`, etc.

- [ ] **Step 3: Verify app works**

Run: `cd web && npm run dev`
Manually verify: login, join room, send message, receive message, presence, E2EE

- [ ] **Step 4: Delete old providers**

```bash
rm web/src/providers/NatsProvider.tsx
rm web/src/providers/MessageProvider.tsx
rm web/src/providers/E2EEProvider.tsx
```

- [ ] **Step 5: Run all tests**

Run: `cd web && npx vitest run`
Expected: All PASS

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "feat: migrate components to ChatClient hooks, delete old providers"
```
