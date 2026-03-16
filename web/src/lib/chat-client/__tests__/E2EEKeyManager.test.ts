import { describe, it, expect, vi, beforeEach } from 'vitest';
import { E2EEKeyManager } from '../E2EEKeyManager';
import { ConnectionManager } from '../ConnectionManager';

// Minimal ConnectionManager mock — no real NATS connection needed
function makeConnectionManager(): ConnectionManager {
  const cm = new ConnectionManager({ wsUrl: 'ws://localhost:9222', name: 'test' });
  return cm;
}

describe('E2EEKeyManager', () => {
  let cm: ConnectionManager;
  let manager: E2EEKeyManager;

  beforeEach(() => {
    cm = makeConnectionManager();
    manager = new E2EEKeyManager(cm, 'alice');
  });

  it('isReady starts false', () => {
    expect(manager.isReady).toBe(false);
  });

  it('isRoomEncrypted returns false for unknown room', () => {
    expect(manager.isRoomEncrypted('some-room')).toBe(false);
    expect(manager.isRoomEncrypted('nonexistent')).toBe(false);
  });

  it('getRoomMeta returns null for unknown room', () => {
    expect(manager.getRoomMeta('some-room')).toBeNull();
    expect(manager.getRoomMeta('nonexistent')).toBeNull();
  });

  it('emits initError when not connected', async () => {
    const errorFn = vi.fn();
    manager.on('initError', errorFn);
    await manager.init();
    expect(errorFn).toHaveBeenCalledWith('E2EE unavailable: not connected');
    expect(manager.isReady).toBe(false);
  });

  it('destroy clears state and removes listeners', () => {
    const readyFn = vi.fn();
    manager.on('ready', readyFn);
    manager.destroy();
    expect(manager.isReady).toBe(false);
    expect(manager.getRoomMeta('any-room')).toBeNull();
    expect(manager.isRoomEncrypted('any-room')).toBe(false);
  });
});
