/**
 * Vitality meter (Phase 4) — the companion's two wallets made legible: stamina
 * (what you ask of it) and energy (what it does on its own), each shown as the
 * remaining token balance. Polls the budget endpoint. Refilling is the Kitchen's
 * job (the feeding economy, Phase 5) — there is no manual top-up here. Non-critical:
 * a failed poll is swallowed so it never disrupts the chat (mirrors UsageBadge).
 */

import type { StaminaEnergyDto, UsageDto } from '@cobble/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchBudget } from '../api/client.js';

const POLL_INTERVAL_MS = 30_000;

/** Compact token count for the meter chip: 1_200_000 → "1.2M", 8_000 → "8k". */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return `${n}`;
}

function poolDetail(label: string, pool: UsageDto): string {
  return `${label}: ${pool.balanceTokens.toLocaleString()} tokens left`;
}

export function BudgetMeter({ companionId }: { companionId: string }): JSX.Element | null {
  const [budget, setBudget] = useState<StaminaEnergyDto | null>(null);
  const mountedRef = useRef(true);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await fetchBudget(companionId);
      if (mountedRef.current) setBudget(next);
    } catch (error) {
      // Informational meter; a transient failure just leaves the prior reading
      // and the next poll reconciles — but log it (logging.md: no silent catch).
      console.error('BudgetMeter: failed to refresh budget', error);
    }
  }, [companionId]);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => {
      mountedRef.current = false;
      window.clearInterval(timer);
    };
  }, [refresh]);

  if (!budget) return null;

  return (
    <span className="budget-meter">
      <span className="budget-meter__pool" title={poolDetail('Stamina', budget.stamina)}>
        ⚡ {formatTokens(budget.stamina.balanceTokens)}
      </span>
      <span className="budget-meter__pool" title={poolDetail('Energy', budget.energy)}>
        ✦ {formatTokens(budget.energy.balanceTokens)}
      </span>
    </span>
  );
}
