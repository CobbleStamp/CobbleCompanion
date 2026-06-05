/**
 * Vitality meter (Phase 4) — the companion's two budget pools made legible:
 * stamina (what you ask of it) and energy (what it does on its own). Polls the
 * budget endpoint and offers a one-tap "feed" (manual top-up) per pool — the
 * simple control before the Phase 5 food economy. Non-critical: a failed poll or
 * feed is swallowed so it never disrupts the chat (mirrors UsageBadge).
 */

import type { StaminaEnergyDto, UsageDto } from '@cobble/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchBudget, topUpBudget } from '../api/client.js';

const POLL_INTERVAL_MS = 30_000;
/** One feed grants a chunk of budget (the simple top-up; economy is Phase 5). */
const TOPUP_AMOUNT = 100_000;

function poolDetail(label: string, pool: UsageDto): string {
  return `${label}: ${pool.usedTokens.toLocaleString()} / ${pool.capTokens.toLocaleString()} tokens (${pool.percentUsed}% used)`;
}

export function BudgetMeter({ companionId }: { companionId: string }): JSX.Element | null {
  const [budget, setBudget] = useState<StaminaEnergyDto | null>(null);
  // True while any feed request is in flight — disables both feed buttons so a
  // double-tap (or a tap on the other pool) can't fire concurrent top-ups.
  const [feeding, setFeeding] = useState(false);
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

  const feed = useCallback(
    async (pool: 'stamina' | 'energy'): Promise<void> => {
      // Ignore re-entrant taps while any feed is still in flight.
      if (feeding) return;
      setFeeding(true);
      try {
        const next = await topUpBudget(companionId, pool, TOPUP_AMOUNT);
        if (mountedRef.current) setBudget(next);
      } catch (error) {
        // Best-effort; the next poll reconciles — but log it (logging.md).
        console.error('BudgetMeter: failed to feed pool', { pool, error });
      } finally {
        if (mountedRef.current) setFeeding(false);
      }
    },
    [companionId, feeding],
  );

  if (!budget) return null;

  return (
    <span className="budget-meter">
      <span className="budget-meter__pool" title={poolDetail('Stamina', budget.stamina)}>
        ⚡ {budget.stamina.percentUsed}%
        <button
          type="button"
          className="budget-meter__feed"
          onClick={() => void feed('stamina')}
          disabled={feeding}
          aria-label="Feed stamina"
        >
          +
        </button>
      </span>
      <span className="budget-meter__pool" title={poolDetail('Energy', budget.energy)}>
        ✦ {budget.energy.percentUsed}%
        <button
          type="button"
          className="budget-meter__feed"
          onClick={() => void feed('energy')}
          disabled={feeding}
          aria-label="Feed energy"
        >
          +
        </button>
      </span>
    </span>
  );
}
