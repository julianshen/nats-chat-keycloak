import { describe, it, expect, vi } from 'vitest';
import { TypedEmitter } from '../EventEmitter';

type TestEvents = {
  message: (text: string) => void;
  count: (n: number) => void;
};

// Helper to expose protected emit
class TestEmitter extends TypedEmitter<TestEvents> {
  fire<K extends keyof TestEvents>(e: K, ...args: Parameters<TestEvents[K]>) {
    this.emit(e, ...args);
  }
}

describe('TypedEmitter', () => {
  it('emits events to listeners', () => {
    const emitter = new TestEmitter();
    const fn = vi.fn();
    emitter.on('message', fn);
    emitter.fire('message', 'hello');
    expect(fn).toHaveBeenCalledWith('hello');
  });

  it('supports multiple listeners', () => {
    const emitter = new TestEmitter();
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    emitter.on('message', fn1);
    emitter.on('message', fn2);
    emitter.fire('message', 'hello');
    expect(fn1).toHaveBeenCalledWith('hello');
    expect(fn2).toHaveBeenCalledWith('hello');
  });

  it('on() returns unsubscribe function', () => {
    const emitter = new TestEmitter();
    const fn = vi.fn();
    const unsub = emitter.on('message', fn);
    unsub();
    emitter.fire('message', 'hello');
    expect(fn).not.toHaveBeenCalled();
  });

  it('off() removes specific listener', () => {
    const emitter = new TestEmitter();
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    emitter.on('message', fn1);
    emitter.on('message', fn2);
    emitter.off('message', fn1);
    emitter.fire('message', 'hello');
    expect(fn1).not.toHaveBeenCalled();
    expect(fn2).toHaveBeenCalledWith('hello');
  });

  it('removeAllListeners clears everything', () => {
    const emitter = new TestEmitter();
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

  it('handles emit with no listeners gracefully', () => {
    const emitter = new TestEmitter();
    expect(() => emitter.fire('message', 'hello')).not.toThrow();
  });
});
