/**
 * Pre-flight token-cap guard shared by the spend routes (chat, search). The cap
 * is the cost guardrail (architecture.md token budget); because ingestion is
 * serial and chat is turn-based, a simple "are you already over?" check at the
 * boundary is sufficient — there is no concurrency to outrun.
 */

import type { TokenQuotaStore, UsageSnapshot } from '@cobble/core';

/** A user-safe 429 message naming roughly when the daily allowance resets. */
export function overCapMessage(resetsAt: string): string {
  const hours = Math.max(1, Math.ceil((new Date(resetsAt).getTime() - Date.now()) / 3_600_000));
  return `You've reached today's usage allowance for Cobble. It resets in about ${hours} hour${
    hours === 1 ? '' : 's'
  }.`;
}

/**
 * Resolve the user's standing; returns a 429 message when they are at/over the
 * cap, else null. Callers reply 429 with the message before doing any spend.
 */
export async function overCapGuard(quota: TokenQuotaStore, userId: string): Promise<string | null> {
  const usage: UsageSnapshot = await quota.getUsage(userId);
  return usage.usedTokens >= usage.capTokens ? overCapMessage(usage.resetsAt) : null;
}
