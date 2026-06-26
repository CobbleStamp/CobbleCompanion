/**
 * The mint-endpoint client (companion-discord.md §9): exchanges the worker's Discord
 * **service credential** for a short-lived **real-user** access token by calling the
 * internal `POST /internal/discord/token` route (T2b). The token then authenticates
 * that user's `/ws` connection (the bridge connects as the real user).
 *
 * `fetchFn` is injectable for tests; defaults to the global `fetch`.
 */

import type { Logger } from './gateway/types.js';

type FetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface MintTokenSourceDeps {
  /** Full mint endpoint URL, e.g. `https://home.example/internal/discord/token`. */
  readonly mintUrl: string;
  readonly serviceClientId: string;
  readonly serviceSecret: string;
  readonly logger: Logger;
  readonly fetchFn?: FetchFn;
}

/** Returns `acquireToken(userId)` — mints a real-user access token, or throws. */
export function createMintTokenSource(
  deps: MintTokenSourceDeps,
): (userId: string) => Promise<string> {
  const doFetch: FetchFn = deps.fetchFn ?? (globalThis.fetch as unknown as FetchFn);
  return async (userId: string): Promise<string> => {
    const response = await doFetch(deps.mintUrl, {
      method: 'POST',
      headers: {
        'x-service-client-id': deps.serviceClientId,
        authorization: `Bearer ${deps.serviceSecret}`,
        'x-user-id': userId,
      },
    });
    if (!response.ok) {
      deps.logger.error('discord token mint request failed', {
        operation: 'discord.token.mint',
        userId,
        status: response.status,
      });
      throw new Error(`token mint failed with status ${response.status}`);
    }
    const body = (await response.json()) as { access_token?: unknown };
    if (typeof body.access_token !== 'string' || body.access_token.length === 0) {
      throw new Error('token mint response missing access_token');
    }
    return body.access_token;
  };
}
