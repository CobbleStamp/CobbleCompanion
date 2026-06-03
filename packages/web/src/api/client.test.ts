import type { ChatStreamEvent } from '@cobble/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCompanion, fetchMessages, sendMessage, setAccessTokenGetter } from './client.js';

/**
 * Guards the request helper's content-type behavior: a POST with a body must send
 * `content-type: application/json`, while a bodyless request (e.g. a GET) must
 * omit it. Both must carry the bearer token.
 */
describe('api client request headers', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setAccessTokenGetter(async () => 'tok');
    fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ messages: [], companion: { id: 'k1' } }),
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

  it('omits content-type on a bodyless GET (fetchMessages)', async () => {
    await fetchMessages('k1');
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

/**
 * Pins the SSE frame parser in `sendMessage`. The server writes
 * `data: <json>\n\n` per event (packages/api/src/sse.ts), so the parser splits
 * on the `\n\n` frame boundary and carries any partial trailing frame across
 * reads. These tests fake `fetch` with a `ReadableStream`-backed body and assert
 * the decoded event sequence and the boundary/malformed-frame contract.
 */
describe('sendMessage SSE parser', () => {
  beforeEach(() => {
    setAccessTokenGetter(async () => 'tok');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setAccessTokenGetter(async () => null);
  });

  /** Builds a fake fetch whose response body streams the given UTF-8 chunks. */
  function stubFetchStreaming(chunks: readonly string[]): void {
    const encoder = new TextEncoder();
    let index = 0;
    const reader = {
      read: async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
        if (index >= chunks.length) return { done: true, value: undefined };
        const chunk = chunks[index]!;
        index += 1;
        return { done: false, value: encoder.encode(chunk) };
      },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        body: { getReader: () => reader },
      })),
    );
  }

  async function collect(): Promise<ChatStreamEvent[]> {
    const events: ChatStreamEvent[] = [];
    for await (const event of sendMessage('companion-1', 'hi')) {
      events.push(event);
    }
    return events;
  }

  it('parses multiple events delivered in a single chunk', async () => {
    stubFetchStreaming([
      'data: {"type":"token","value":"He"}\n\n' + 'data: {"type":"token","value":"llo"}\n\n',
    ]);

    const events = await collect();

    expect(events).toEqual([
      { type: 'token', value: 'He' },
      { type: 'token', value: 'llo' },
    ]);
  });

  it('carries a frame split across two reads (buffer carry)', async () => {
    // The first read ends mid-frame; the parser must hold the partial line in
    // its buffer and only emit once the `\n\n` boundary arrives in read two.
    stubFetchStreaming(['data: {"type":"to', 'ken","value":"split"}\n\n']);

    const events = await collect();

    expect(events).toEqual([{ type: 'token', value: 'split' }]);
  });

  it('parses a newline-terminated final done frame', async () => {
    stubFetchStreaming([
      'data: {"type":"token","value":"done"}\n\n' +
        'data: {"type":"done","message":{"id":"m9","companionId":"companion-1","role":"assistant","content":"done","createdAt":"2026-01-03T00:00:03.000Z"}}\n\n',
    ]);

    const events = await collect();

    expect(events).toEqual([
      { type: 'token', value: 'done' },
      {
        type: 'done',
        message: {
          id: 'm9',
          companionId: 'companion-1',
          role: 'assistant',
          content: 'done',
          createdAt: '2026-01-03T00:00:03.000Z',
        },
      },
    ]);
  });

  it('drops a trailing frame that is not newline-terminated (contract pin)', async () => {
    // Per the server contract every frame ends with `\n\n`; a trailing fragment
    // without that boundary is held in the buffer and never emitted, rather than
    // being parsed as a partial event.
    stubFetchStreaming([
      'data: {"type":"token","value":"kept"}\n\n' + 'data: {"type":"token","value":"dropped"}',
    ]);

    const events = await collect();

    expect(events).toEqual([{ type: 'token', value: 'kept' }]);
  });

  it('throws out of the generator on a malformed data frame (contract pin)', async () => {
    // A malformed JSON payload makes JSON.parse throw; the parser does not skip
    // it. The thrown error propagates to the caller, which surfaces it in the UI.
    stubFetchStreaming(['data: {not json}\n\n']);

    await expect(collect()).rejects.toThrow();
  });
});
