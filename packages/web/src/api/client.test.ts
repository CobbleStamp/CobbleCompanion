import type { ChatStreamEvent, FoodInventoryDto, StaminaEnergyDto } from '@cobble/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  confirmProposal,
  createCompanion,
  fetchBudget,
  fetchMessages,
  getFood,
  sendHeartbeat,
  sendMessage,
  setAccessTokenGetter,
  setProactivityDial,
} from './client.js';

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

/**
 * The confirm endpoint streams SSE on success but returns a plain JSON error on a
 * non-2xx (e.g. 429 over-cap, 409 no-longer-pending). `send()` must surface the
 * server's `error` body verbatim — not a generic `request failed (NNN)` — so the
 * UI can show the user why the action was held (review H1).
 */
describe('confirmProposal error surfacing', () => {
  beforeEach(() => {
    setAccessTokenGetter(async () => 'tok');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setAccessTokenGetter(async () => null);
  });

  function stubErrorResponse(status: number, error: string): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status,
        json: async () => ({ error }),
      })),
    );
  }

  it('throws the server body on a 429 over-cap (not the status code)', async () => {
    stubErrorResponse(429, "You're over your daily token limit.");
    await expect(confirmProposal('companion-1', 'p1').next()).rejects.toThrow(
      "You're over your daily token limit.",
    );
  });

  it('throws the server body on a 409 no-longer-pending proposal', async () => {
    stubErrorResponse(409, 'proposal is no longer pending');
    await expect(confirmProposal('companion-1', 'p1').next()).rejects.toThrow(
      'proposal is no longer pending',
    );
  });
});

/**
 * The Phase 4 vitality methods: each drives the right verb/URL/payload through
 * `send` and unwraps the response shape the surface expects (the meter, the dial,
 * the fire-and-forget heartbeat). The generic send mechanics are pinned above.
 */
describe('phase 4 budget/dial/heartbeat methods', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  const BUDGET: StaminaEnergyDto = {
    stamina: { balanceTokens: 900_000 },
    energy: { balanceTokens: 800_000 },
  };

  const FOOD: FoodInventoryDto = { ration: 10, spark: 10, treat: 10 };

  beforeEach(() => {
    setAccessTokenGetter(async () => 'tok');
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setAccessTokenGetter(async () => null);
  });

  it('GETs the budget meter and returns the parsed DTO', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => BUDGET });
    const budget = await fetchBudget('c1');
    expect(budget).toEqual(BUDGET);
    expect(fetchMock.mock.calls[0]![0]).toContain('/companions/c1/budget');
  });

  it('GETs the user food pantry and unwraps the food field', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ food: FOOD }) });
    const food = await getFood();
    expect(food).toEqual(FOOD);
    expect(fetchMock.mock.calls[0]![0]).toContain('/food');
  });

  it('PATCHes the proactivity dial and unwraps the dial field', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ dial: 'active' }) });
    const dial = await setProactivityDial('c1', 'active');
    expect(dial).toBe('active');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain('/companions/c1/proactivity');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ dial: 'active' });
  });

  it('POSTs a heartbeat carrying the live tab visibility', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
    await sendHeartbeat('c1', false);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain('/companions/c1/heartbeat');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ tabVisible: false });
  });
});
