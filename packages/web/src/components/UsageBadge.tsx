/**
 * Live daily-token-budget indicator (architecture.md token budget). Self-
 * contained: polls `/usage` on an interval and renders the percent consumed
 * plus a hover detail. Non-critical — a failed poll is swallowed so the badge
 * never disrupts a page. Dropped into each page header.
 */

import type { UsageDto } from '@cobble/shared';
import { useEffect, useRef, useState } from 'react';
import { getUsage } from '../api/client.js';

const POLL_INTERVAL_MS = 30_000;

export function UsageBadge(): JSX.Element | null {
  const [usage, setUsage] = useState<UsageDto | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const tick = async (): Promise<void> => {
      try {
        const next = await getUsage();
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
  }, []);

  if (!usage) return null;

  const resetHours = Math.max(
    1,
    Math.ceil((new Date(usage.resetsAt).getTime() - Date.now()) / 3_600_000),
  );
  const tone =
    usage.percentUsed >= 100
      ? 'usage-badge--full'
      : usage.percentUsed >= 80
        ? 'usage-badge--high'
        : '';
  const detail = `${usage.usedTokens.toLocaleString()} / ${usage.capTokens.toLocaleString()} tokens · resets in ~${resetHours}h`;

  return (
    <span
      className={`usage-badge ${tone}`.trim()}
      title={detail}
      aria-label={`Daily usage: ${detail}`}
    >
      Energy: {usage.percentUsed}% used
    </span>
  );
}
