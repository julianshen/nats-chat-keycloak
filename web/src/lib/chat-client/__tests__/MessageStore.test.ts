import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageStore } from '../MessageStore';
import { ConnectionManager } from '../ConnectionManager';
import { RoomManager } from '../RoomManager';
import type { ChatMessage } from '../../../types';

// Mock tracing
vi.mock('../../../utils/tracing', () => ({
  tracedHeaders: () => ({ headers: { set: vi.fn(), get: vi.fn(), keys: vi.fn(() => []) }, traceId: 'test-trace' }),
  startActionSpan: () => ({ ctx: {}, end: vi.fn() }),
  tracedHeadersWithContext: () => ({ headers: { set: vi.fn(), get: vi.fn(), keys: vi.fn(() => []) }, traceId: 'test-trace' }),
}));

// Mock AppBridge
vi.mock('../../AppBridge', () => ({
  routeAppMessage: vi.fn(),
}));

function createMockCm(connected: boolean, nc: any = null): ConnectionManager {
  const cm = Object.create(ConnectionManager.prototype);
  Object.defineProperty(cm, 'nc', { get: () => nc });
  Object.defineProperty(cm, 'isConnected', { get: () => connected });
  return cm;
}

function createMockRm(): RoomManager {
  const rm = Object.create(RoomManager.prototype);
  rm.roomToMemberKey = (room: string) => room === '__admin__' ? '__admin__chat' : room;
  // Provide on/off from TypedEmitter behavior
  const listeners = new Map<string, Set<Function>>();
  rm.on = (event: string, fn: Function) => {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event)!.add(fn);
    return () => listeners.get(event)?.delete(fn);
  };
  rm.off = (event: string, fn: Function) => listeners.get(event)?.delete(fn);
  return rm;
}

function makeMsg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    user: 'alice',
    text: 'hello',
    timestamp: Date.now(),
    room: 'general',
    ...overrides,
  };
}

describe('MessageStore', () => {
  let cm: ConnectionManager;
  let rm: RoomManager;
  let store: MessageStore;

  beforeEach(() => {
    cm = createMockCm(false);
    rm = createMockRm();
    store = new MessageStore(cm, rm, 'alice');
  });

  describe('getMessages', () => {
    it('returns empty array for unknown room', () => {
      expect(store.getMessages('unknown')).toEqual([]);
    });
  });

  describe('message dedup', () => {
    it('deduplicates messages with same timestamp and user', () => {
      const msg1 = makeMsg({ timestamp: 1000, user: 'bob', text: 'first' });
      const msg2 = makeMsg({ timestamp: 1000, user: 'bob', text: 'duplicate' });

      const messageFn = vi.fn();
      store.on('message', messageFn);

      // Use processRoomChatMessage via the internal method (access through any)
      (store as any).processRoomChatMessage(msg1, 'general');
      (store as any).processRoomChatMessage(msg2, 'general');

      expect(store.getMessages('general')).toHaveLength(1);
      expect(store.getMessages('general')[0].text).toBe('first');
      expect(messageFn).toHaveBeenCalledTimes(1);
    });

    it('allows messages with different timestamps', () => {
      const msg1 = makeMsg({ timestamp: 1000, user: 'bob' });
      const msg2 = makeMsg({ timestamp: 2000, user: 'bob' });

      (store as any).processRoomChatMessage(msg1, 'general');
      (store as any).processRoomChatMessage(msg2, 'general');

      expect(store.getMessages('general')).toHaveLength(2);
    });
  });

  describe('applyUpdate for edit', () => {
    it('applies edit mutation to existing messages', () => {
      const msg = makeMsg({ timestamp: 1000, user: 'bob', text: 'original' });
      (store as any).processRoomChatMessage(msg, 'general');

      const editMsg = makeMsg({
        timestamp: 1000,
        user: 'bob',
        text: 'edited',
        action: 'edit',
      });
      const updatedFn = vi.fn();
      store.on('updated', updatedFn);

      (store as any).processRoomChatMessage(editMsg, 'general');

      const messages = store.getMessages('general');
      expect(messages[0].text).toBe('edited');
      expect(messages[0].editedAt).toBe(1000);
      expect(updatedFn).toHaveBeenCalledWith('general', '1000-bob', expect.objectContaining({ text: 'edited' }));

      // Check updates map
      const updates = store.getUpdates();
      expect(updates.get('1000-bob')).toEqual(expect.objectContaining({ text: 'edited', editedAt: 1000 }));
    });
  });

  describe('applyUpdate for delete', () => {
    it('applies delete mutation to existing messages', () => {
      const msg = makeMsg({ timestamp: 1000, user: 'bob', text: 'will be deleted' });
      (store as any).processRoomChatMessage(msg, 'general');

      const deleteMsg = makeMsg({
        timestamp: 1000,
        user: 'bob',
        text: '',
        action: 'delete',
      });
      (store as any).processRoomChatMessage(deleteMsg, 'general');

      const messages = store.getMessages('general');
      expect(messages[0].isDeleted).toBe(true);
      expect(messages[0].text).toBe('');

      const updates = store.getUpdates();
      expect(updates.get('1000-bob')).toEqual(expect.objectContaining({ isDeleted: true }));
    });
  });

  describe('applyUpdate for react', () => {
    it('toggles reaction on a message', () => {
      const msg = makeMsg({ timestamp: 1000, user: 'bob', text: 'react to me' });
      (store as any).processRoomChatMessage(msg, 'general');

      const reactMsg: ChatMessage = {
        user: 'alice',
        text: '',
        timestamp: 1000,
        room: 'general',
        action: 'react',
        emoji: '👍',
        targetUser: 'bob',
      };
      (store as any).processRoomChatMessage(reactMsg, 'general');

      const messages = store.getMessages('general');
      expect(messages[0].reactions).toEqual({ '👍': ['alice'] });

      // Toggle off
      (store as any).processRoomChatMessage(reactMsg, 'general');
      const messagesAfter = store.getMessages('general');
      expect(messagesAfter[0].reactions).toEqual({});
    });
  });

  describe('unread tracking', () => {
    it('increments unread for inactive room', () => {
      store.setActiveRoom('other-room');
      const msg = makeMsg({ timestamp: 1000, user: 'bob', room: 'general' });

      const unreadFn = vi.fn();
      store.on('unreadChanged', unreadFn);

      (store as any).processRoomChatMessage(msg, 'general');

      expect(store.getUnread('general').count).toBe(1);
      expect(unreadFn).toHaveBeenCalledWith('general', 1, 0);
    });

    it('skips unread increment for active room', () => {
      store.setActiveRoom('general');
      const msg = makeMsg({ timestamp: 1000, user: 'bob', room: 'general' });

      const unreadFn = vi.fn();
      store.on('unreadChanged', unreadFn);

      (store as any).processRoomChatMessage(msg, 'general');

      expect(store.getUnread('general').count).toBe(0);
      expect(unreadFn).not.toHaveBeenCalled();
    });

    it('skips unread for __system__ user', () => {
      store.setActiveRoom('other');
      const msg = makeMsg({ timestamp: 1000, user: '__system__', room: 'general' });

      (store as any).processRoomChatMessage(msg, 'general');

      expect(store.getUnread('general').count).toBe(0);
    });

    it('tracks mention counts', () => {
      store.setActiveRoom('other');
      const msg = makeMsg({ timestamp: 1000, user: 'bob', room: 'general', mentions: ['alice'] });

      (store as any).processRoomChatMessage(msg, 'general');

      expect(store.getUnread('general').mentions).toBe(1);
    });
  });

  describe('clearUnread', () => {
    it('resets unread and mention counts', () => {
      store.setActiveRoom('other');
      const msg1 = makeMsg({ timestamp: 1000, user: 'bob', room: 'general', mentions: ['alice'] });
      const msg2 = makeMsg({ timestamp: 2000, user: 'bob', room: 'general' });

      (store as any).processRoomChatMessage(msg1, 'general');
      (store as any).processRoomChatMessage(msg2, 'general');

      expect(store.getUnread('general').count).toBe(2);
      expect(store.getUnread('general').mentions).toBe(1);

      const unreadFn = vi.fn();
      store.on('unreadChanged', unreadFn);

      store.clearUnread('general');

      expect(store.getUnread('general').count).toBe(0);
      expect(store.getUnread('general').mentions).toBe(0);
      expect(unreadFn).toHaveBeenCalledWith('general', 0, 0);
    });

    it('is a no-op when no unread', () => {
      const unreadFn = vi.fn();
      store.on('unreadChanged', unreadFn);

      store.clearUnread('general');

      expect(unreadFn).not.toHaveBeenCalled();
    });
  });

  describe('thread messages', () => {
    it('returns empty for unknown thread', () => {
      expect(store.getThreadMessages('unknown-thread')).toEqual([]);
    });
  });

  describe('reply counts', () => {
    it('starts empty', () => {
      expect(store.getReplyCounts().size).toBe(0);
    });
  });

  describe('destroy', () => {
    it('clears all internal state', () => {
      store.setActiveRoom('general');
      (store as any).processRoomChatMessage(makeMsg({ timestamp: 1000, user: 'bob' }), 'general');

      store.destroy();

      expect(store.getMessages('general')).toEqual([]);
      expect(store.getUnread('general').count).toBe(0);
      expect(store.getReplyCounts().size).toBe(0);
      expect(store.getUpdates().size).toBe(0);
    });
  });
});
