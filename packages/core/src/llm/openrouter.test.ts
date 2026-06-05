import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../logging.js';
import { LlmGatewayError, type StreamResult } from './gateway.js';
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

/** Drive the stream to completion, capturing both the text and the returned result. */
async function collectWithResult(
  stream: AsyncGenerator<string, StreamResult, void>,
): Promise<{ text: string; result: StreamResult }> {
  let text = '';
  for (;;) {
    const { value, done } = await stream.next();
    if (done) return { text, result: value };
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
    const { text, result } = await collectWithResult(
      gateway.stream({ messages: [{ role: 'user', content: 'hi' }], model: 'm' }),
    );
    expect(text).toBe('Hi');
    expect(result.usage).toEqual({ promptTokens: 11, completionTokens: 3, totalTokens: 14 });
  });

  it('estimates usage (~4 chars/token) when the provider omits a usage frame', async () => {
    const body = sseStream(['data: {"choices":[{"delta":{"content":"abcd"}}]}', 'data: [DONE]']);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 200 })),
    );

    const gateway = new OpenRouterGateway({ apiKey: 'test-key' });
    const { result } = await collectWithResult(
      gateway.stream({ messages: [{ role: 'user', content: 'abcdefgh' }], model: 'm' }),
    );
    // prompt "abcdefgh" (8 → 2) + completion "abcd" (4 → 1).
    expect(result.usage).toEqual({ promptTokens: 2, completionTokens: 1, totalTokens: 3 });
  });

  it('sends usage:{include:true} so OpenRouter appends the usage frame', async () => {
    const fetchMock = vi.fn(async () => new Response(sseStream(['data: [DONE]']), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const gateway = new OpenRouterGateway({ apiKey: 'test-key' });
    await collect(gateway.stream({ messages: [{ role: 'user', content: 'hi' }], model: 'm' }));
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).usage).toEqual({ include: true });
  });

  it('cancels the underlying body when the consumer breaks out early', async () => {
    const cancel = vi.fn(async () => undefined);
    const encoder = new TextEncoder();
    // A stream that would keep yielding; the consumer breaks after the first
    // chunk, so the generator's finally must cancel rather than just releaseLock.
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"a"}}]}\n'));
      },
      cancel,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 200 })),
    );

    const gateway = new OpenRouterGateway({ apiKey: 'test-key' });
    for await (const chunk of gateway.stream({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'm',
    })) {
      expect(chunk).toBe('a');
      break;
    }
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('does not cancel the body when the stream drains to [DONE]', async () => {
    const cancel = vi.fn(async () => undefined);
    const encoder = new TextEncoder();
    const lines = ['data: {"choices":[{"delta":{"content":"a"}}]}', 'data: [DONE]'];
    let i = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i < lines.length) {
          controller.enqueue(encoder.encode(`${lines[i++]}\n`));
        } else {
          controller.close();
        }
      },
      cancel,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 200 })),
    );

    const gateway = new OpenRouterGateway({ apiKey: 'test-key' });
    await collect(gateway.stream({ messages: [{ role: 'user', content: 'hi' }], model: 'm' }));
    expect(cancel).not.toHaveBeenCalled();
  });

  it('accumulates a tool call whose arguments are split across frames', async () => {
    const body = sseStream([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"web_fetch","arguments":"{\\"url\\":"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"https://x.dev\\"}"}}]}}]}',
      'data: [DONE]',
    ]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 200 })),
    );

    const gateway = new OpenRouterGateway({ apiKey: 'test-key' });
    const { text, result } = await collectWithResult(
      gateway.stream({ messages: [{ role: 'user', content: 'read it' }], model: 'm' }),
    );
    expect(text).toBe('');
    expect(result.toolCalls).toEqual([
      { id: 'call_1', name: 'web_fetch', args: { url: 'https://x.dev' } },
    ]);
  });

  it('accumulates two interleaved tool calls keyed by index', async () => {
    const body = sseStream([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"web_fetch","arguments":"{\\"url\\":\\"u\\"}"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"b","function":{"name":"memory_search","arguments":"{\\"q\\":"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"\\"peru\\"}"}}]}}]}',
      'data: [DONE]',
    ]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 200 })),
    );

    const gateway = new OpenRouterGateway({ apiKey: 'test-key' });
    const { result } = await collectWithResult(
      gateway.stream({ messages: [{ role: 'user', content: 'go' }], model: 'm' }),
    );
    expect(result.toolCalls).toEqual([
      { id: 'a', name: 'web_fetch', args: { url: 'u' } },
      { id: 'b', name: 'memory_search', args: { q: 'peru' } },
    ]);
  });

  it('relays text and a tool call together in one turn', async () => {
    const body = sseStream([
      'data: {"choices":[{"delta":{"content":"Let me check. "}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"memory_search","arguments":"{\\"q\\":\\"x\\"}"}}]}}]}',
      'data: [DONE]',
    ]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 200 })),
    );

    const gateway = new OpenRouterGateway({ apiKey: 'test-key' });
    const { text, result } = await collectWithResult(
      gateway.stream({ messages: [{ role: 'user', content: 'go' }], model: 'm' }),
    );
    expect(text).toBe('Let me check. ');
    expect(result.toolCalls).toEqual([{ id: 'c1', name: 'memory_search', args: { q: 'x' } }]);
  });

  it('drops a nameless tool call but logs the discarded model intent', async () => {
    // Arguments arrive across two frames; a function name never does. The call
    // is uncallable, so it is dropped — but with a log, not silently.
    const body = sseStream([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"orphan","function":{"arguments":"{\\"url\\":"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"x\\"}"}}]}}]}',
      'data: [DONE]',
    ]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 200 })),
    );
    const info = vi.fn();
    const logger: Logger = { error: vi.fn(), info };

    const gateway = new OpenRouterGateway({ apiKey: 'test-key', logger });
    const { result } = await collectWithResult(
      gateway.stream({ messages: [{ role: 'user', content: 'go' }], model: 'm' }),
    );
    expect(result.toolCalls).toEqual([]);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('never received a function name'),
      expect.objectContaining({ index: 0, id: 'orphan', argsLength: expect.any(Number) }),
    );
  });

  it('keeps the last function name when frames repeat it (overwrite, not concatenate)', async () => {
    // Locks the assumption that OpenRouter sends the name whole in one fragment:
    // if a provider ever split it, accumulateToolCalls would keep only the last
    // piece. This test documents last-write-wins so that change is caught.
    const body = sseStream([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c","function":{"name":"web_fetch","arguments":"{\\"url\\":"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"web_fetch","arguments":"\\"u\\"}"}}]}}]}',
      'data: [DONE]',
    ]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 200 })),
    );

    const gateway = new OpenRouterGateway({ apiKey: 'test-key' });
    const { result } = await collectWithResult(
      gateway.stream({ messages: [{ role: 'user', content: 'go' }], model: 'm' }),
    );
    expect(result.toolCalls).toEqual([{ id: 'c', name: 'web_fetch', args: { url: 'u' } }]);
  });

  it('degrades malformed tool-call arguments to an empty object (failures are data)', async () => {
    const body = sseStream([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c","function":{"name":"web_fetch","arguments":"{not json"}}]}}]}',
      'data: [DONE]',
    ]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 200 })),
    );

    const gateway = new OpenRouterGateway({ apiKey: 'test-key' });
    const { result } = await collectWithResult(
      gateway.stream({ messages: [{ role: 'user', content: 'go' }], model: 'm' }),
    );
    expect(result.toolCalls).toEqual([{ id: 'c', name: 'web_fetch', args: {} }]);
  });

  it('sends the advertised tools in the OpenAI function shape, and omits the field otherwise', async () => {
    const fetchMock = vi.fn(async () => new Response(sseStream(['data: [DONE]']), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const gateway = new OpenRouterGateway({ apiKey: 'test-key' });
    await collect(
      gateway.stream({
        messages: [{ role: 'user', content: 'hi' }],
        model: 'm',
        tools: [
          {
            name: 'web_fetch',
            description: 'Fetch a URL',
            parameters: { type: 'object', properties: { url: { type: 'string' } } },
          },
        ],
      }),
    );
    const [, initWith] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const withTools = JSON.parse(initWith.body as string);
    expect(withTools.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'web_fetch',
          description: 'Fetch a URL',
          parameters: { type: 'object', properties: { url: { type: 'string' } } },
        },
      },
    ]);

    await collect(gateway.stream({ messages: [{ role: 'user', content: 'hi' }], model: 'm' }));
    const [, initNo] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    const noTools = JSON.parse(initNo.body as string);
    expect(noTools.tools).toBeUndefined();
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
