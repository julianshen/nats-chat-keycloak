import { beforeAll, describe, expect, it } from 'vitest';

let shouldRetryConnect: (client: any) => boolean;

beforeAll(async () => {
  (globalThis as any).window = { __env__: {} };
  ({ shouldRetryConnect } = await import('../useNatsChat'));
});

describe('shouldRetryConnect', () => {
  it('retries when disconnected and there is no active connection object', () => {
    const client = { isConnected: false, connection: { nc: null } } as any;
    expect(shouldRetryConnect(client)).toBe(true);
  });

  it('does not retry while an nc object still exists', () => {
    const client = { isConnected: false, connection: { nc: {} } } as any;
    expect(shouldRetryConnect(client)).toBe(false);
  });

  it('does not retry when already connected', () => {
    const client = { isConnected: true, connection: { nc: {} } } as any;
    expect(shouldRetryConnect(client)).toBe(false);
  });
});
