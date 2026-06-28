/**
 * The API → Discord-adapter reconcile trigger (companion-discord.md §2.1). After a
 * `discord.config.*` write the API calls this so the adapter (re)starts/stops that one
 * bot's gateway connection at once — replacing the adapter's old `discord_config` poll.
 *
 * It is **fire-and-forget with bounded retry**: a save must not fail because the adapter
 * is momentarily down (the adapter's startup reconcile is the recovery floor). A final
 * failure is logged at `error` so a lost trigger is visible (logging.md). It is disabled
 * (a no-op) when no URL is configured — the surface degrades to restart-time recovery.
 *
 * The endpoint is internal-only and carries no auth (companion-discord.md §2.1), so the
 * call needs no credential — just the URL.
 */

import type { Logger } from '@cobble/core';

type FetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number }>;

export interface ReconcileNotifierDeps {
  /** The adapter's reconcile endpoint URL (`DISCORD_RECONCILE_URL`); empty → disabled. */
  readonly url: string;
  readonly logger: Logger;
  /** Total attempts (default 3). */
  readonly attempts?: number;
  /** Injectable for tests; defaults to the global `fetch`. */
  readonly fetchFn?: FetchFn;
}

/**
 * Build `reconcile(userId)`. Resolves once the trigger has been delivered (or given up
 * after `attempts`); it never rejects, so callers fire-and-forget with `void`.
 */
export function createReconcileNotifier(
  deps: ReconcileNotifierDeps,
): (userId: string) => Promise<void> {
  const enabled = deps.url.length > 0;
  const attempts = deps.attempts ?? 3;
  const doFetch: FetchFn = deps.fetchFn ?? (globalThis.fetch as unknown as FetchFn);

  return async (userId: string): Promise<void> => {
    if (!enabled) return;
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await doFetch(deps.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ userId }),
        });
        if (response.ok) return;
        lastError = new Error(`reconcile responded ${response.status}`);
      } catch (error) {
        lastError = error;
      }
    }
    deps.logger.error('discord reconcile trigger failed after retries', {
      operation: 'discord.reconcile.notify',
      userId,
      attempts,
      error: lastError,
    });
  };
}
