/**
 * Energy-as-quota adapter (Phase 4.1) — exposes a `CompanionEnergyStore` through
 * the `TokenQuotaStore` interface so the metered collaborators that already bill
 * the user's stamina (the ingestion pipeline, the announcer — `usage.ts`) can be
 * pointed at the companion's ENERGY pool instead, with no change to their code.
 *
 * The two stores are structurally identical (used/cap/reset, record, exhausted,
 * and an atomic top-up grant); the only difference is *who* is billed — stamina
 * is per-user (user-initiated work), energy is per-companion (self-initiated work,
 * `architecture.md` §4.8). When the motivation engine runs an autonomous burst it
 * wraps the energy store in this adapter and passes the companion id as the
 * `ownerId`, so every token the burst spends is debited to energy and the same
 * exhaustion gate the metered pipeline already honours becomes the "out of
 * energy → stop" boundary. The `id` argument is forwarded verbatim, so callers
 * pass the companion id where the underlying interface expects an owner id.
 */

import type { CompanionEnergyStore } from './energy-store.js';
import type { TokenQuotaStore, UsageSnapshot } from './stamina-store.js';

/**
 * Wrap a `CompanionEnergyStore` as a `TokenQuotaStore`. The `id` passed to each
 * method is the **companion id** (callers invoke the metered collaborator with
 * `ownerId = companionId`), forwarded straight through to the energy store.
 */
export class EnergyQuotaAdapter implements TokenQuotaStore {
  constructor(private readonly energy: CompanionEnergyStore) {}

  getUsage(companionId: string): Promise<UsageSnapshot> {
    // EnergySnapshot and UsageSnapshot are the same shape (used/cap/reset).
    return this.energy.getEnergy(companionId);
  }

  recordUsage(companionId: string, totalTokens: number): Promise<void> {
    return this.energy.recordSpend(companionId, totalTokens);
  }

  isOverCap(companionId: string): Promise<boolean> {
    return this.energy.isExhausted(companionId);
  }

  topUp(companionId: string, amount: number): Promise<void> {
    return this.energy.topUp(companionId, amount);
  }
}
