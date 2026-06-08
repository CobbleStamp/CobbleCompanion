/**
 * Shared vitality-meter assembly (architecture.md §4.8) — builds the
 * stamina/energy `StaminaEnergyDto` from the two wallets. Used by both the
 * proactivity route's meter and the feed route, so the meter shape is single-sourced.
 * Each wallet reports just its remaining balance — no cap, no window (the wallet
 * refills only by feeding).
 */

import type { StaminaEnergyDto, UsageDto } from '@cobble/shared';
import type { VitalityStore } from '@cobble/core';

async function walletDto(store: VitalityStore, companionId: string): Promise<UsageDto> {
  return { balanceTokens: await store.getBalance(companionId) };
}

/** The vitality meter: stamina + energy, both per-companion wallets (architecture.md §4.8). */
export async function buildBudget(
  stamina: VitalityStore,
  energy: VitalityStore,
  companionId: string,
): Promise<StaminaEnergyDto> {
  return {
    stamina: await walletDto(stamina, companionId),
    energy: await walletDto(energy, companionId),
  };
}
