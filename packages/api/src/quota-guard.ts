/**
 * Pre-flight stamina guard shared by the spend routes (chat, search). Stamina is the
 * user-initiated half of a companion's vitality (architecture.md §4.8) — a wallet
 * that refills only by feeding. Because ingestion is serial and chat is turn-based, a
 * simple "is the wallet empty?" check at the boundary is sufficient — there is no
 * concurrency to outrun.
 */

import type { VitalityStore } from '@cobble/core';

/** A user-safe 429 message — the companion is out of stamina and needs feeding. */
export const OUT_OF_STAMINA_MESSAGE =
  "Cobble is out of stamina for now. Feed it a Ration (or a Treat) and it'll be ready to talk again.";

/**
 * Resolve the companion's stamina standing; returns a 429 message when the wallet is
 * empty, else null. Callers reply 429 with the message before any spend.
 */
export async function overCapGuard(
  quota: VitalityStore,
  companionId: string,
): Promise<string | null> {
  return (await quota.isEmpty(companionId)) ? OUT_OF_STAMINA_MESSAGE : null;
}
