/**
 * SSRF-safe fetch for link ingestion. Wraps undici's fetch with an Agent
 * whose connection-layer DNS lookup validates every resolved address
 * (url-guard.ts `createGuardedLookup`) — so a public hostname whose DNS
 * record points at a private/metadata IP is rejected at connect time, with
 * no gap between validation and connection. Also provides a streamed body
 * reader with a hard byte ceiling so a hostile URL cannot OOM the process.
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
export const safeLinkFetch: typeof fetch = ((
  input: Parameters<typeof undiciFetch>[0],
  init?: Parameters<typeof undiciFetch>[1],
) =>
  undiciFetch(input, {
    ...init,
    dispatcher: guardedDispatcher,
  })) as unknown as typeof fetch;

/**
 * Read a response body as text, enforcing `maxBytes` both via the declared
 * Content-Length (cheap early reject) and while streaming (the header is
 * attacker-controlled and may lie). Throws a user-safe Error past the cap.
 */
export async function readTextWithLimit(response: Response, maxBytes: number): Promise<string> {
  const tooLarge = (): Error => new Error('the linked page is too large to read');
  const declaredLength = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw tooLarge();
  }
  if (response.body === null) {
    return '';
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let received = 0;
  let text = '';
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
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}
