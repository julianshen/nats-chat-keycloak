import { describe, it, expect, vi } from 'vitest';
import { ChatClient } from '../ChatClient';

vi.mock('../../../utils/tracing', () => ({
  tracedHeaders: () => ({ headers: { set: vi.fn(), get: vi.fn(), keys: vi.fn(() => []) }, traceId: 'test-trace' }),
  startActionSpan: () => ({ ctx: {}, end: vi.fn() }),
  tracedHeadersWithContext: () => ({ headers: { set: vi.fn(), get: vi.fn(), keys: vi.fn(() => []) }, traceId: 'test-trace' }),
}));

describe('ChatClient room moderation payloads', () => {
  it('uses target field for room invite', async () => {
    const request = vi.fn(async () => ({ data: new TextEncoder().encode('{}') }));
    const client = Object.create(ChatClient.prototype) as ChatClient;
    (client as any).connection = { nc: { request } };
    (client as any).config = { username: 'alice' };

    await client.inviteUser('room-a', 'bob');

    const [, payload] = request.mock.calls[0] as any[];
    expect(JSON.parse(new TextDecoder().decode(payload))).toEqual({ user: 'alice', target: 'bob' });
  });

  it('uses target field for room kick', async () => {
    const request = vi.fn(async () => ({ data: new TextEncoder().encode('{}') }));
    const client = Object.create(ChatClient.prototype) as ChatClient;
    (client as any).connection = { nc: { request } };
    (client as any).config = { username: 'alice' };

    await client.kickUser('room-a', 'bob');

    const [, payload] = request.mock.calls[0] as any[];
    expect(JSON.parse(new TextDecoder().decode(payload))).toEqual({ user: 'alice', target: 'bob' });
  });
});
