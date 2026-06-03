/** Tests for the OpenRouter embedding gateway (stubbed fetch — we own the fake). */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmbeddingGatewayError } from './gateway.js';
import { OpenRouterEmbeddingGateway } from './openrouter.js';

describe('OpenRouterEmbeddingGateway', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends an OpenAI-compatible request and returns vectors in input order', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            // Deliberately out of order: index must drive ordering.
            data: [
              { index: 1, embedding: [0, 1] },
              { index: 0, embedding: [1, 0] },
            ],
            usage: { prompt_tokens: 7, total_tokens: 7 },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const gateway = new OpenRouterEmbeddingGateway({ apiKey: 'test-key' });
    const { vectors, usage } = await gateway.embed({
      input: ['first', 'second'],
      model: 'perplexity/pplx-embed-v1-0.6b',
      dimensions: 2,
    });

    expect(vectors).toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(usage).toEqual({ promptTokens: 7, completionTokens: 0, totalTokens: 7 });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/v1/embeddings');
    expect(init.headers).toMatchObject({ authorization: 'Bearer test-key' });
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'perplexity/pplx-embed-v1-0.6b',
      input: ['first', 'second'],
      dimensions: 2,
    });
  });

  it('short-circuits empty input without a network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const gateway = new OpenRouterEmbeddingGateway({ apiKey: 'test-key' });
    expect(await gateway.embed({ input: [], model: 'm', dimensions: 2 })).toEqual({
      vectors: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws a typed error on a non-OK response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('rate limited', { status: 429 })),
    );

    const gateway = new OpenRouterEmbeddingGateway({ apiKey: 'test-key' });
    await expect(gateway.embed({ input: ['x'], model: 'm', dimensions: 2 })).rejects.toBeInstanceOf(
      EmbeddingGatewayError,
    );
  });

  it('throws a typed error on a transport failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );

    const gateway = new OpenRouterEmbeddingGateway({ apiKey: 'test-key' });
    await expect(gateway.embed({ input: ['x'], model: 'm', dimensions: 2 })).rejects.toBeInstanceOf(
      EmbeddingGatewayError,
    );
  });

  it('rejects a count mismatch between inputs and returned embeddings', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }), {
            status: 200,
          }),
      ),
    );

    const gateway = new OpenRouterEmbeddingGateway({ apiKey: 'test-key' });
    await expect(gateway.embed({ input: ['a', 'b'], model: 'm', dimensions: 2 })).rejects.toThrow(
      /returned 1 embeddings for 2 inputs/,
    );
  });

  it('rejects a dimension mismatch (schema/provider coupling fails fast)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0, 0] }] }), {
            status: 200,
          }),
      ),
    );

    const gateway = new OpenRouterEmbeddingGateway({ apiKey: 'test-key' });
    await expect(gateway.embed({ input: ['a'], model: 'm', dimensions: 2 })).rejects.toThrow(
      /3-dim embedding; expected 2/,
    );
  });
});
