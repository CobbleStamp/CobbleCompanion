/**
 * SSRF-safe outbound fetch. Wraps undici's fetch with an Agent whose
 * connection-layer DNS lookup validates every resolved address (url-guard.ts
 * `createGuardedLookup`) — so a public hostname whose DNS record points at a
 * private/metadata IP is rejected at connect time, with no gap between
 * validation and connection. Shared by link ingestion (`link-resolver.ts`)
 * and the MCP transport (`api/mcp/sdk-client.ts`) — both reach untrusted or
 * operator-supplied URLs server-side and need the same rebinding defense.
 * Also provides a streamed body reader with a hard byte ceiling so a hostile
 * URL cannot OOM the process.
 */

import { Agent, fetch as undiciFetch } from 'undici';
import { createGuardedLookup } from './url-guard.js';

const guardedDispatcher = new Agent({
  connect: { lookup: createGuardedLookup() },
});

/**
 * Drop-in `fetch` whose connections resolve through the SSRF-guarded
 * lookup. Typed as the global `fetch` (undici *is* Node's fetch; its own
 * types differ only nominally) so callers and tests can substitute either.
 */
export const ssrfSafeFetch: typeof fetch = ((
  input: Parameters<typeof undiciFetch>[0],
  init?: Parameters<typeof undiciFetch>[1],
) =>
  undiciFetch(input, {
    ...init,
    dispatcher: guardedDispatcher,
  })) as unknown as typeof fetch;

/**
 * Read a response body as bytes, enforcing `maxBytes` both via the declared
 * Content-Length (cheap early reject) and while streaming (the header is
 * attacker-controlled and may lie). Throws a user-safe Error past the cap.
 * Bytes-first so binary content (PDF, OOXML) survives intact; text content
 * types are decoded by the caller / {@link readTextWithLimit}.
 */
export async function readBytesWithLimit(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const tooLarge = (): Error => new Error('the linked page is too large to read');
  const declaredLength = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw tooLarge();
  }
  if (response.body === null) {
    return new Uint8Array(0);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Read a response body as UTF-8 text, enforcing the same `maxBytes` ceiling. */
export async function readTextWithLimit(response: Response, maxBytes: number): Promise<string> {
  return new TextDecoder('utf-8').decode(await readBytesWithLimit(response, maxBytes));
}
