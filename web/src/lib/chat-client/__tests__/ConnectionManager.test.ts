import { describe, it, expect, vi } from 'vitest';
import { ConnectionManager } from '../ConnectionManager';

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

  it('disconnect on already-disconnected is no-op', async () => {
    const cm = new ConnectionManager({ wsUrl: 'ws://localhost:9222', name: 'test' });
    await cm.disconnect(); // should not throw
    expect(cm.isConnected).toBe(false);
  });

  it('prevents concurrent connect calls', async () => {
    const cm = new ConnectionManager({ wsUrl: 'ws://invalid:1', name: 'test' });
    const errorFn = vi.fn();
    cm.on('error', errorFn);
    // Fire two connects simultaneously
    const p1 = cm.connect('token1');
    const p2 = cm.connect('token2'); // should be no-op (connecting flag)
    await Promise.all([p1, p2]);
    // Only one error (from the first connect)
    expect(errorFn).toHaveBeenCalledTimes(1);
  });
});
