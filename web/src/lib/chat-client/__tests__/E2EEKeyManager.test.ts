import { describe, it, expect, vi, beforeEach } from 'vitest';
import { E2EEKeyManager } from '../E2EEKeyManager';
import { ConnectionManager } from '../ConnectionManager';
import * as E2EEManagerModule from '../../E2EEManager';

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

  it('retries identity publish and becomes ready on transient failure', async () => {
    const getOrCreateIdentityKeySpy = vi.spyOn(E2EEManagerModule, 'getOrCreateIdentityKey')
      .mockResolvedValue({
        privateKey: {} as CryptoKey,
        publicKey: {} as CryptoKey,
        publicKeyJwk: { kty: 'EC' },
      });

    const request = vi.fn()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce({ data: new TextEncoder().encode('{}') });

    const connectedManager = {
      nc: { request },
      isConnected: true,
    } as unknown as ConnectionManager;

    const retryManager = new E2EEKeyManager(connectedManager, 'alice');
    const readyFn = vi.fn();
    const errorFn = vi.fn();
    retryManager.on('ready', readyFn);
    retryManager.on('initError', errorFn);
    (retryManager as any)._startSubscriptions = vi.fn();

    await retryManager.init();

    expect(request).toHaveBeenCalledTimes(3);
    expect(readyFn).toHaveBeenCalledTimes(1);
    expect(errorFn).not.toHaveBeenCalled();
    expect(retryManager.isReady).toBe(true);
    getOrCreateIdentityKeySpy.mockRestore();
  });

  it('emits initError after publish retries are exhausted', async () => {
    vi.useFakeTimers();

    const getOrCreateIdentityKeySpy = vi.spyOn(E2EEManagerModule, 'getOrCreateIdentityKey')
      .mockResolvedValue({
        privateKey: {} as CryptoKey,
        publicKey: {} as CryptoKey,
        publicKeyJwk: { kty: 'EC' },
      });

    const request = vi.fn().mockRejectedValue(new Error('timeout'));
    const connectedManager = {
      nc: { request },
      isConnected: true,
    } as unknown as ConnectionManager;

    const retryManager = new E2EEKeyManager(connectedManager, 'alice');
    const errorFn = vi.fn();
    retryManager.on('initError', errorFn);
    (retryManager as any)._startSubscriptions = vi.fn();

    const initPromise = retryManager.init();

    // Advance through all retry delays (1s + 2s + 4s + 8s + 16s)
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(20000);
    }
    await initPromise;

    expect(request).toHaveBeenCalledTimes(6);
    expect(errorFn).toHaveBeenCalledWith('E2EE unavailable: identity key publish failed');
    expect(retryManager.isReady).toBe(false);
    getOrCreateIdentityKeySpy.mockRestore();
    vi.useRealTimers();
  });
});
