import { describe, it, expect, vi } from 'vitest';
import { ChatClient } from '../ChatClient';

vi.mock('../../../utils/tracing', () => ({
  tracedHeaders: () => ({ headers: { set: vi.fn(), get: vi.fn(), keys: vi.fn(() => []) }, traceId: 'test-trace' }),
  startActionSpan: () => ({ ctx: {}, end: vi.fn() }),
  tracedHeadersWithContext: () => ({ headers: { set: vi.fn(), get: vi.fn(), keys: vi.fn(() => []) }, traceId: 'test-trace' }),
}));

describe('ChatClient.searchUsers', () => {
  it('sends raw query text to users.search', async () => {
    const request = vi.fn(async () => ({ data: new TextEncoder().encode('[]') }));

    const client = Object.create(ChatClient.prototype) as ChatClient;
    (client as any).connection = { nc: { request } };

    await client.searchUsers('alice');

    expect(request).toHaveBeenCalledTimes(1);
    const [subject, payload, opts] = request.mock.calls[0] as any[];

    expect(subject).toBe('users.search');
    expect(new TextDecoder().decode(payload)).toBe('alice');
    expect(opts).toEqual({ timeout: 5000 });
  });
});
