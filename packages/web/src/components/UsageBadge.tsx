/**
 * Live daily-stamina indicator (architecture.md §4.8). Self-contained: polls the
 * companion's `/usage` on an interval and renders the percent consumed plus a hover
 * detail. Non-critical — a failed poll is swallowed so the badge never disrupts a
 * page. Dropped into each page header for the active companion.
 */

import type { UsageDto } from '@cobble/shared';
import { useEffect, useRef, useState } from 'react';
import { getUsage } from '../api/client.js';

const POLL_INTERVAL_MS = 30_000;

interface UsageBadgeProps {
  readonly companionId: string;
}

export function UsageBadge({ companionId }: UsageBadgeProps): JSX.Element | null {
  const [usage, setUsage] = useState<UsageDto | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const tick = async (): Promise<void> => {
      try {
        const next = await getUsage(companionId);
        if (mountedRef.current) setUsage(next);
      } catch {
        // The badge is informational; ignore transient failures.
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      mountedRef.current = false;
      window.clearInterval(timer);
    };
  }, [companionId]);

  if (!usage) return null;

  const { balanceTokens } = usage;
  // Tone warns as the wallet runs low; empty = feed it (the only way it refills).
  const tone =
    balanceTokens <= 0 ? 'usage-badge--full' : balanceTokens < 100_000 ? 'usage-badge--high' : '';
  const remaining = formatTokens(balanceTokens);
  const detail = `${balanceTokens.toLocaleString()} stamina tokens left · feed to refill`;

  return (
    <span className={`usage-badge ${tone}`.trim()} title={detail} aria-label={`Stamina: ${detail}`}>
      Stamina: {balanceTokens <= 0 ? 'empty — feed me' : `${remaining} left`}
    </span>
  );
}

/** Compact token count: 1_200_000 → "1.2M", 8_000 → "8k". */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return `${n}`;
}
