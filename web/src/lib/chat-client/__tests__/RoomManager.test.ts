import { describe, it, expect, vi } from 'vitest';
import { RoomManager } from '../RoomManager';
import { ConnectionManager } from '../ConnectionManager';

// Mock tracing to avoid OTel dependency in tests
vi.mock('../../../utils/tracing', () => ({
  tracedHeaders: () => ({ headers: { set: vi.fn(), get: vi.fn(), keys: vi.fn(() => []) }, traceId: 'test-trace' }),
  startActionSpan: () => ({ ctx: {}, end: vi.fn() }),
  tracedHeadersWithContext: () => ({ headers: { set: vi.fn(), get: vi.fn(), keys: vi.fn(() => []) }, traceId: 'test-trace' }),
}));

function createMockCm(connected: boolean, nc: any = null): ConnectionManager {
  const cm = Object.create(ConnectionManager.prototype);
  Object.defineProperty(cm, 'nc', { get: () => nc });
  Object.defineProperty(cm, 'isConnected', { get: () => connected });
  return cm;
}

function createMockNc() {
  const subs: any[] = [];
  return {
    publish: vi.fn(),
    subscribe: vi.fn(() => {
      const sub = {
        unsubscribe: vi.fn(),
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise(() => {}), // never resolves — simulates idle sub
        }),
      };
      subs.push(sub);
      return sub;
    }),
    _subs: subs,
  };
}

describe('RoomManager', () => {
  describe('roomToMemberKey', () => {
    it('maps __admin__ to __admin__chat', () => {
      const cm = createMockCm(false);
      const rm = new RoomManager(cm, 'alice');
      expect(rm.roomToMemberKey('__admin__')).toBe('__admin__chat');
    });

    it('passes through normal room names', () => {
      const cm = createMockCm(false);
      const rm = new RoomManager(cm, 'alice');
      expect(rm.roomToMemberKey('general')).toBe('general');
      expect(rm.roomToMemberKey('my-room')).toBe('my-room');
    });
  });

  describe('join', () => {
    it('is a no-op without connection', () => {
      const cm = createMockCm(false);
      const rm = new RoomManager(cm, 'alice');
      const joinedFn = vi.fn();
      rm.on('joined', joinedFn);
      rm.join('general');
      expect(joinedFn).not.toHaveBeenCalled();
      expect(rm.getJoinedRooms().size).toBe(0);
    });

    it('tracks room, publishes join, subscribes, and emits joined', () => {
      const mockNc = createMockNc();
      const cm = createMockCm(true, mockNc);
      const rm = new RoomManager(cm, 'alice');
      const joinedFn = vi.fn();
      rm.on('joined', joinedFn);

      rm.join('general');

      expect(joinedFn).toHaveBeenCalledWith('general');
      expect(rm.getJoinedRooms().has('general')).toBe(true);
      expect(mockNc.publish).toHaveBeenCalledWith(
        'room.join.general',
        expect.anything(),
        expect.anything(),
      );
      // Should subscribe to room.notify.general and room.presence.general
      expect(mockNc.subscribe).toHaveBeenCalledWith('room.notify.general');
      expect(mockNc.subscribe).toHaveBeenCalledWith('room.presence.general');
    });

    it('is a no-op for duplicate join', () => {
      const mockNc = createMockNc();
      const cm = createMockCm(true, mockNc);
      const rm = new RoomManager(cm, 'alice');
      const joinedFn = vi.fn();
      rm.on('joined', joinedFn);

      rm.join('general');
      rm.join('general');

      expect(joinedFn).toHaveBeenCalledTimes(1);
      expect(mockNc.publish).toHaveBeenCalledTimes(1);
    });

    it('uses __admin__chat member key for __admin__ room', () => {
      const mockNc = createMockNc();
      const cm = createMockCm(true, mockNc);
      const rm = new RoomManager(cm, 'alice');

      rm.join('__admin__');

      expect(mockNc.publish).toHaveBeenCalledWith(
        'room.join.__admin__chat',
        expect.anything(),
        expect.anything(),
      );
      expect(mockNc.subscribe).toHaveBeenCalledWith('room.notify.__admin__chat');
    });
  });

  describe('leave', () => {
    it('removes room, unsubscribes, and emits left', () => {
      const mockNc = createMockNc();
      const cm = createMockCm(true, mockNc);
      const rm = new RoomManager(cm, 'alice');
      const leftFn = vi.fn();
      rm.on('left', leftFn);

      rm.join('general');
      rm.leave('general');

      expect(leftFn).toHaveBeenCalledWith('general');
      expect(rm.getJoinedRooms().has('general')).toBe(false);
      // Should have published room.leave.general
      expect(mockNc.publish).toHaveBeenCalledWith(
        'room.leave.general',
        expect.anything(),
        expect.anything(),
      );
      // Subscriptions should be unsubscribed
      for (const sub of mockNc._subs) {
        expect(sub.unsubscribe).toHaveBeenCalled();
      }
    });

    it('is a no-op for room not joined', () => {
      const mockNc = createMockNc();
      const cm = createMockCm(true, mockNc);
      const rm = new RoomManager(cm, 'alice');
      const leftFn = vi.fn();
      rm.on('left', leftFn);

      rm.leave('general');

      expect(leftFn).not.toHaveBeenCalled();
    });
  });

  describe('leaveAll', () => {
    it('leaves all joined rooms', () => {
      const mockNc = createMockNc();
      const cm = createMockCm(true, mockNc);
      const rm = new RoomManager(cm, 'alice');

      rm.join('general');
      rm.join('random');
      rm.leaveAll();

      expect(rm.getJoinedRooms().size).toBe(0);
    });
  });

  describe('destroy', () => {
    it('cleans up all state', () => {
      const mockNc = createMockNc();
      const cm = createMockCm(true, mockNc);
      const rm = new RoomManager(cm, 'alice');

      rm.join('general');
      rm.destroy();

      expect(rm.getJoinedRooms().size).toBe(0);
    });
  });
});
