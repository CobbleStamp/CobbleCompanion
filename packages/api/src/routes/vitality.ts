/**
 * Shared vitality-meter assembly (architecture.md §4.8) — builds the
 * stamina/energy `StaminaEnergyDto` from the two pools. Used by both the
 * proactivity routes (the meter + the simple top-up) and the Phase 5 feed route,
 * so the meter shape is single-sourced.
 */

import type { StaminaEnergyDto, UsageDto } from '@cobble/shared';
import type { CompanionEnergyStore, TokenQuotaStore } from '@cobble/core';

/** Whole-percent of a pool consumed, clamped to 0–100. */
export function percentUsed(used: number, cap: number): number {
  if (cap <= 0) return 100;
  return Math.min(100, Math.max(0, Math.round((used / cap) * 100)));
}

async function staminaDto(quota: TokenQuotaStore, userId: string): Promise<UsageDto> {
  const s = await quota.getUsage(userId);
  return {
    usedTokens: s.usedTokens,
    capTokens: s.capTokens,
    percentUsed: percentUsed(s.usedTokens, s.capTokens),
    resetsAt: s.resetsAt,
  };
}

async function energyDto(energy: CompanionEnergyStore, companionId: string): Promise<UsageDto> {
  const e = await energy.getEnergy(companionId);
  return {
    usedTokens: e.usedTokens,
    capTokens: e.capTokens,
    percentUsed: percentUsed(e.usedTokens, e.capTokens),
    resetsAt: e.resetsAt,
  };
}

/** The vitality meter: stamina (per-user) + energy (per-companion). */
export async function buildBudget(
  quota: TokenQuotaStore,
  energy: CompanionEnergyStore,
  userId: string,
  companionId: string,
): Promise<StaminaEnergyDto> {
  return {
    stamina: await staminaDto(quota, userId),
    energy: await energyDto(energy, companionId),
  };
}
