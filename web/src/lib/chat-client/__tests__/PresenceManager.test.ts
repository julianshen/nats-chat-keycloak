import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PresenceManager } from '../PresenceManager';
import { ConnectionManager, sc } from '../ConnectionManager';
import { RoomManager } from '../RoomManager';

// Mock tracing to avoid OTel dependency in tests
vi.mock('../../../utils/tracing', () => ({
  tracedHeaders: () => ({
    headers: { set: vi.fn(), get: vi.fn(), keys: vi.fn(() => []) },
    traceId: 'test-trace',
  }),
  startActionSpan: () => ({ ctx: {}, end: vi.fn() }),
  tracedHeadersWithContext: () => ({
    headers: { set: vi.fn(), get: vi.fn(), keys: vi.fn(() => []) },
    traceId: 'test-trace',
  }),
}));

function createMockCm(connected: boolean, nc: any = null): ConnectionManager {
  const cm = Object.create(ConnectionManager.prototype);
  Object.defineProperty(cm, 'nc', { get: () => nc, configurable: true });
  Object.defineProperty(cm, 'isConnected', { get: () => connected, configurable: true });
  return cm;
}

function createMockNc(requestResolveWith?: any) {
  return {
    publish: vi.fn(),
    request: vi.fn().mockImplementation(() =>
      requestResolveWith !== undefined
        ? Promise.resolve(requestResolveWith)
        : new Promise(() => {}), // never resolves by default
    ),
  };
}

// Subclass to expose protected emit for testing
class TestableRoomManager extends RoomManager {
  testEmit<K extends 'joined' | 'left' | 'rawNotification' | 'rawPresence'>(
    event: K, ...args: any[]
  ) {
    (this.emit as any)(event, ...args);
  }
  roomToMemberKey(room: string): string { return room; }
}

function createMockRm(cm: ConnectionManager, _username: string): TestableRoomManager {
  return new TestableRoomManager(cm, _username);
}

/** Helper: encode presence diff as Uint8Array */
function encodePresence(diff: object): Uint8Array {
  return sc.encode(JSON.stringify(diff));
}

describe('PresenceManager', () => {
  let mockNc: ReturnType<typeof createMockNc>;
  let cm: ConnectionManager;
  let rm: TestableRoomManager;
  let pm: PresenceManager;

  beforeEach(() => {
    vi.useFakeTimers();
    mockNc = createMockNc();
    cm = createMockCm(true, mockNc);
    rm = createMockRm(cm, 'alice');
    pm = new PresenceManager(cm, rm, 'alice');
  });

  afterEach(() => {
    pm.destroy();
    vi.useRealTimers();
  });

  describe('initial state', () => {
    it('starts with no online users', () => {
      expect(pm.getOnlineUsers('general')).toEqual([]);
    });

    it('getOnlineUsers returns empty array for unknown room', () => {
      expect(pm.getOnlineUsers('nonexistent')).toEqual([]);
    });

    it('currentStatus defaults to online', () => {
      expect(pm.currentStatus).toBe('online');
    });
  });

  describe('setStatus', () => {
    it('updates currentStatus', () => {
      pm.setStatus('away');
      expect(pm.currentStatus).toBe('away');
    });

    it('publishes to presence.update when connected', () => {
      pm.setStatus('busy');
      expect(mockNc.publish).toHaveBeenCalledWith(
        'presence.update',
        expect.anything(),
        expect.anything(),
      );
    });

    it('updates currentStatus even when not connected', () => {
      const disconnectedCm = createMockCm(false, null);
      const localPm = new PresenceManager(disconnectedCm, rm, 'alice');
      localPm.setStatus('away');
      expect(localPm.currentStatus).toBe('away');
      localPm.destroy();
    });

    it('does not publish when not connected', () => {
      const offlineNc = createMockNc();
      const disconnectedCm = createMockCm(false, offlineNc);
      const localPm = new PresenceManager(disconnectedCm, rm, 'alice');
      localPm.setStatus('away');
      expect(offlineNc.publish).not.toHaveBeenCalled();
      localPm.destroy();
    });
  });

  describe('rawPresence handling', () => {
    it('adds a user on "online" action', () => {
      rm.testEmit('rawPresence', 'general', encodePresence({ action: 'online', userId: 'bob', status: 'online' }));
      expect(pm.getOnlineUsers('general')).toEqual([{ userId: 'bob', status: 'online' }]);
    });

    it('updates existing user on "status" action', () => {
      rm.testEmit('rawPresence', 'general', encodePresence({ action: 'online', userId: 'bob', status: 'online' }));
      rm.testEmit('rawPresence', 'general', encodePresence({ action: 'status', userId: 'bob', status: 'away' }));
      expect(pm.getOnlineUsers('general')).toEqual([{ userId: 'bob', status: 'away' }]);
    });

    it('removes a user on "offline" action', () => {
      rm.testEmit('rawPresence', 'general', encodePresence({ action: 'online', userId: 'bob', status: 'online' }));
      rm.testEmit('rawPresence', 'general', encodePresence({ action: 'offline', userId: 'bob' }));
      expect(pm.getOnlineUsers('general')).toEqual([]);
    });

    it('emits presenceChanged when presence diff arrives', () => {
      const listener = vi.fn();
      pm.on('presenceChanged', listener);
      rm.testEmit('rawPresence', 'general', encodePresence({ action: 'online', userId: 'bob', status: 'online' }));
      expect(listener).toHaveBeenCalledWith('general', [{ userId: 'bob', status: 'online' }]);
    });

    it('ignores malformed presence data', () => {
      expect(() => {
        rm.testEmit('rawPresence', 'general', sc.encode('not-json'));
      }).not.toThrow();
      expect(pm.getOnlineUsers('general')).toEqual([]);
    });

    it('ignores unknown actions', () => {
      rm.testEmit('rawPresence', 'general', encodePresence({ action: 'unknown', userId: 'bob' }));
      expect(pm.getOnlineUsers('general')).toEqual([]);
    });

    it('tracks presence per room independently', () => {
      rm.testEmit('rawPresence', 'general', encodePresence({ action: 'online', userId: 'bob', status: 'online' }));
      rm.testEmit('rawPresence', 'random', encodePresence({ action: 'online', userId: 'charlie', status: 'online' }));
      expect(pm.getOnlineUsers('general')).toEqual([{ userId: 'bob', status: 'online' }]);
      expect(pm.getOnlineUsers('random')).toEqual([{ userId: 'charlie', status: 'online' }]);
    });
  });

  describe('joined: fetchInitialPresence', () => {
    it('requests initial presence when a room is joined', () => {
      rm.testEmit('joined', 'general');
      expect(mockNc.request).toHaveBeenCalledWith(
        'presence.room.general',
        expect.anything(),
        expect.objectContaining({ timeout: 5000 }),
      );
    });

    it('populates onlineUsers from initial presence response', async () => {
      const members = [{ userId: 'bob', status: 'online' }];
      const responseNc = createMockNc({ data: sc.encode(JSON.stringify(members)) });
      const localCm = createMockCm(true, responseNc);
      const localRm = createMockRm(localCm, 'alice');
      const localPm = new PresenceManager(localCm, localRm, 'alice');

      localRm.testEmit('joined', 'general');
      // Flush microtasks
      await Promise.resolve();

      expect(localPm.getOnlineUsers('general')).toEqual(members);
      localPm.destroy();
    });
  });

  describe('startHeartbeat / stopHeartbeat', () => {
    it('publishes to presence.heartbeat on start', () => {
      pm.startHeartbeat();
      expect(mockNc.publish).toHaveBeenCalledWith(
        'presence.heartbeat',
        expect.anything(),
        expect.anything(),
      );
    });

    it('publishes again after 10 seconds', () => {
      pm.startHeartbeat();
      const callsBefore = mockNc.publish.mock.calls.length;
      vi.advanceTimersByTime(10_000);
      expect(mockNc.publish.mock.calls.length).toBeGreaterThan(callsBefore);
    });

    it('stops publishing after stopHeartbeat', () => {
      pm.startHeartbeat();
      pm.stopHeartbeat();
      const callsAfterStop = mockNc.publish.mock.calls.length;
      vi.advanceTimersByTime(30_000);
      expect(mockNc.publish.mock.calls.length).toBe(callsAfterStop);
    });

    it('startHeartbeat is idempotent (does not stack intervals)', () => {
      pm.startHeartbeat();
      pm.startHeartbeat();
      pm.startHeartbeat();
      const initialCalls = mockNc.publish.mock.calls.length;
      vi.advanceTimersByTime(10_000);
      // Only one interval should fire — exactly one extra publish
      expect(mockNc.publish.mock.calls.length).toBe(initialCalls + 1);
    });

    it('stopHeartbeat is safe to call when not started', () => {
      expect(() => pm.stopHeartbeat()).not.toThrow();
    });
  });

  describe('publishDisconnect', () => {
    it('publishes to presence.disconnect', () => {
      pm.publishDisconnect();
      expect(mockNc.publish).toHaveBeenCalledWith(
        'presence.disconnect',
        expect.anything(),
        expect.anything(),
      );
    });

    it('does nothing when nc is null', () => {
      const disconnectedCm = createMockCm(false, null);
      const localPm = new PresenceManager(disconnectedCm, rm, 'alice');
      expect(() => localPm.publishDisconnect()).not.toThrow();
      localPm.destroy();
    });
  });

  describe('destroy', () => {
    it('stops heartbeat on destroy', () => {
      pm.startHeartbeat();
      pm.destroy();
      const callsAfterDestroy = mockNc.publish.mock.calls.length;
      vi.advanceTimersByTime(30_000);
      expect(mockNc.publish.mock.calls.length).toBe(callsAfterDestroy);
    });

    it('removes all listeners on destroy', () => {
      const listener = vi.fn();
      pm.on('presenceChanged', listener);
      pm.destroy();
      // After destroy, rawPresence events should not trigger presenceChanged
      rm.testEmit('rawPresence', 'general', encodePresence({ action: 'online', userId: 'bob', status: 'online' }));
      expect(listener).not.toHaveBeenCalled();
    });

    it('clears online users on destroy', () => {
      rm.testEmit('rawPresence', 'general', encodePresence({ action: 'online', userId: 'bob', status: 'online' }));
      pm.destroy();
      expect(pm.getOnlineUsers('general')).toEqual([]);
    });

    it('unsubscribes from RoomManager events on destroy', () => {
      pm.destroy();
      const listener = vi.fn();
      pm.on('presenceChanged', listener);
      rm.testEmit('rawPresence', 'general', encodePresence({ action: 'online', userId: 'bob', status: 'online' }));
      // After destroy, the rawPresence listener on rm is removed, so presenceChanged won't fire
      expect(listener).not.toHaveBeenCalled();
    });
  });
});
