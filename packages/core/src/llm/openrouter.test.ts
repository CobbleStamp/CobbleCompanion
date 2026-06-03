import { afterEach, describe, expect, it, vi } from 'vitest';
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
