import { beforeAll, describe, expect, it } from 'vitest';

let shouldRejoinRoomsOnConnected: (joinedRooms: ReadonlySet<string>) => boolean;

beforeAll(async () => {
  (globalThis as any).window = { __env__: {} };
  ({ shouldRejoinRoomsOnConnected } = await import('../ChatClient'));
});

describe('shouldRejoinRoomsOnConnected', () => {
  it('returns true when there are joined rooms to restore', () => {
    expect(shouldRejoinRoomsOnConnected(new Set(['general']))).toBe(true);
  });

  it('returns false when there is nothing to rejoin', () => {
    expect(shouldRejoinRoomsOnConnected(new Set())).toBe(false);
  });
});
