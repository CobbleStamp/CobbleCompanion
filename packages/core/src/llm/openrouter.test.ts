import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TokenUsage } from '../usage.js';
import { LlmGatewayError } from './gateway.js';
import { OpenRouterGateway } from './openrouter.js';

function sseStream(lines: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(`${line}\n`));
      }
      controller.close();
    },
  });
}

async function collect(iterable: AsyncIterable<string>): Promise<string> {
  let out = '';
  for await (const chunk of iterable) out += chunk;
  return out;
}

/** Drive the stream to completion, capturing both the text and the returned usage. */
async function collectWithUsage(
  stream: AsyncGenerator<string, TokenUsage, void>,
): Promise<{ text: string; usage: TokenUsage }> {
  let text = '';
  for (;;) {
    const { value, done } = await stream.next();
    if (done) return { text, usage: value };
    text += value;
  }
}

describe('OpenRouterGateway', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('relays content deltas and stops at [DONE]', async () => {
    const body = sseStream([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}',
      ': openrouter keepalive',
      'data: {"choices":[{"delta":{"content":"lo"}}]}',
      'data: [DONE]',
      'data: {"choices":[{"delta":{"content":"IGNORED"}}]}',
    ]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 200 })),
    );

    const gateway = new OpenRouterGateway({ apiKey: 'test-key' });
    const text = await collect(
      gateway.stream({ messages: [{ role: 'user', content: 'hi' }], model: 'm' }),
    );
    expect(text).toBe('Hello');
  });

  it('captures the usage frame that precedes [DONE]', async () => {
    const body = sseStream([
      'data: {"choices":[{"delta":{"content":"Hi"}}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":3,"total_tokens":14}}',
      'data: [DONE]',
    ]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 200 })),
    );

    const gateway = new OpenRouterGateway({ apiKey: 'test-key' });
    const { text, usage } = await collectWithUsage(
      gateway.stream({ messages: [{ role: 'user', content: 'hi' }], model: 'm' }),
    );
    expect(text).toBe('Hi');
    expect(usage).toEqual({ promptTokens: 11, completionTokens: 3, totalTokens: 14 });
  });

  it('estimates usage (~4 chars/token) when the provider omits a usage frame', async () => {
    const body = sseStream(['data: {"choices":[{"delta":{"content":"abcd"}}]}', 'data: [DONE]']);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 200 })),
    );

    const gateway = new OpenRouterGateway({ apiKey: 'test-key' });
    const { usage } = await collectWithUsage(
      gateway.stream({ messages: [{ role: 'user', content: 'abcdefgh' }], model: 'm' }),
    );
    // prompt "abcdefgh" (8 → 2) + completion "abcd" (4 → 1).
    expect(usage).toEqual({ promptTokens: 2, completionTokens: 1, totalTokens: 3 });
  });

  it('sends usage:{include:true} so OpenRouter appends the usage frame', async () => {
    const fetchMock = vi.fn(async () => new Response(sseStream(['data: [DONE]']), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const gateway = new OpenRouterGateway({ apiKey: 'test-key' });
    await collect(gateway.stream({ messages: [{ role: 'user', content: 'hi' }], model: 'm' }));
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).usage).toEqual({ include: true });
  });

  it('throws a typed error on a non-OK response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('rate limited', { status: 429 })),
    );

    const gateway = new OpenRouterGateway({ apiKey: 'test-key' });
    await expect(collect(gateway.stream({ messages: [], model: 'm' }))).rejects.toBeInstanceOf(
      LlmGatewayError,
    );
  });

  it('wraps a transport failure in a typed error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );

    const gateway = new OpenRouterGateway({ apiKey: 'test-key' });
    await expect(collect(gateway.stream({ messages: [], model: 'm' }))).rejects.toBeInstanceOf(
      LlmGatewayError,
    );
  });
});
