import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCompanion,
  createConversation,
  setAccessTokenGetter,
} from './client.js';

/**
 * Guards the content-type bug: a bodyless POST must NOT send
 * `content-type: application/json`, or Fastify rejects it with 400
 * FST_ERR_CTP_EMPTY_JSON_BODY before the route runs (createConversation).
 * A POST with a body must still send it.
 */
describe('api client request headers', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setAccessTokenGetter(async () => 'tok');
    fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ conversation: { id: 'c1' }, companion: { id: 'k1' } }),
    }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setAccessTokenGetter(async () => null);
  });

  function headersFor(call: number): Record<string, string> {
    return (fetchMock.mock.calls[call]?.[1]?.headers ?? {}) as Record<string, string>;
  }

  it('omits content-type on a bodyless POST (createConversation)', async () => {
    await createConversation('k1');
    const headers = headersFor(0);
    expect(headers['content-type']).toBeUndefined();
    expect(headers.authorization).toBe('Bearer tok');
  });

  it('sends content-type on a POST with a body (createCompanion)', async () => {
    await createCompanion({ name: 'Cobble', form: 'fox', temperament: 'curious' });
    const headers = headersFor(0);
    expect(headers['content-type']).toBe('application/json');
    expect(headers.authorization).toBe('Bearer tok');
  });
});
