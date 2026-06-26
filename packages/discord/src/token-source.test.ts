import { describe, expect, it } from 'vitest';
import type { Logger } from './gateway/types.js';
import { createMintTokenSource } from './token-source.js';

const silent: Logger = { error: () => {}, warn: () => {}, info: () => {} };

interface FetchCall {
  url: string;
  init: { method: string; headers: Record<string, string> };
}

function fakeFetch(response: { ok: boolean; status: number; body: unknown }): {
  fn: NonNullable<Parameters<typeof createMintTokenSource>[0]['fetchFn']>;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  return {
    calls,
    fn: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: response.ok,
        status: response.status,
        json: async () => response.body,
      };
    },
  };
}

describe('createMintTokenSource', () => {
  it('mints a token and sends the service credential + target user headers', async () => {
    const fetch = fakeFetch({ ok: true, status: 200, body: { access_token: 'minted' } });
    const acquire = createMintTokenSource({
      mintUrl: 'https://home.example/internal/discord/token',
      serviceClientId: 'discord-adapter',
      serviceSecret: 'svc-secret',
      logger: silent,
      fetchFn: fetch.fn,
    });

    const token = await acquire('user-1');

    expect(token).toBe('minted');
    expect(fetch.calls[0]?.url).toBe('https://home.example/internal/discord/token');
    expect(fetch.calls[0]?.init.headers).toEqual({
      'x-service-client-id': 'discord-adapter',
      authorization: 'Bearer svc-secret',
      'x-user-id': 'user-1',
    });
  });

  it('throws on a non-ok response', async () => {
    const fetch = fakeFetch({ ok: false, status: 403, body: {} });
    const acquire = createMintTokenSource({
      mintUrl: 'https://home.example/internal/discord/token',
      serviceClientId: 'discord-adapter',
      serviceSecret: 'svc-secret',
      logger: silent,
      fetchFn: fetch.fn,
    });

    await expect(acquire('user-1')).rejects.toThrow('status 403');
  });

  it('throws when the response has no access_token', async () => {
    const fetch = fakeFetch({ ok: true, status: 200, body: { nope: true } });
    const acquire = createMintTokenSource({
      mintUrl: 'https://home.example/internal/discord/token',
      serviceClientId: 'discord-adapter',
      serviceSecret: 'svc-secret',
      logger: silent,
      fetchFn: fetch.fn,
    });

    await expect(acquire('user-1')).rejects.toThrow('access_token');
  });
});
