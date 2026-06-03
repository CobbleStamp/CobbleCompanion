/** Capped body reading for link ingestion: header and streamed-byte ceilings. */

import { describe, expect, it } from 'vitest';
import { readTextWithLimit } from './safe-fetch.js';

describe('readTextWithLimit', () => {
  it('returns the full text when the body is under the cap', async () => {
    const response = new Response('hello world');
    await expect(readTextWithLimit(response, 1024)).resolves.toBe('hello world');
  });

  it('rejects early when the declared Content-Length exceeds the cap', async () => {
    const response = new Response('tiny', {
      headers: { 'content-length': String(10 * 1024 * 1024) },
    });
    await expect(readTextWithLimit(response, 1024)).rejects.toThrow(/too large/);
  });

  it('rejects while streaming when the actual body exceeds the cap (header may lie)', async () => {
    const big = 'x'.repeat(64 * 1024);
    const response = new Response(big);
    response.headers.delete('content-length');
    await expect(readTextWithLimit(response, 1024)).rejects.toThrow(/too large/);
  });

  it('returns empty text for a null body', async () => {
    const response = new Response(null, { status: 200 });
    await expect(readTextWithLimit(response, 1024)).resolves.toBe('');
  });

  it('decodes multi-byte characters split across the byte stream', async () => {
    const bytes = new TextEncoder().encode('café ☕');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Split inside the multi-byte sequences.
        controller.enqueue(bytes.slice(0, 4));
        controller.enqueue(bytes.slice(4));
        controller.close();
      },
    });
    const response = new Response(stream);
    await expect(readTextWithLimit(response, 1024)).resolves.toBe('café ☕');
  });
});
