/**
 * The growth badge (Phase 5) — the companion's current stage emoji + level, shown
 * in the chat header as the visible "visual axis" (PoC). Clicking it opens the
 * Growth view. Non-critical: a failed fetch renders nothing rather than disrupting
 * chat.
 */

import type { GrowthDto } from '@cobble/shared';
import { useEffect, useState } from 'react';
import { fetchGrowth } from '../api/client.js';

interface GrowthBadgeProps {
  readonly companionId: string;
  readonly onOpen: () => void;
}

export function GrowthBadge({ companionId, onOpen }: GrowthBadgeProps): JSX.Element | null {
  const [growth, setGrowth] = useState<GrowthDto | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const dto = await fetchGrowth(companionId);
        if (!cancelled) {
          setGrowth(dto);
        }
      } catch {
        // Non-critical chrome — stay silent if growth can't be read.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [companionId]);

  if (!growth) {
    return null;
  }
  return (
    <button type="button" className="growth-badge" onClick={onOpen} title="View growth">
      <span aria-hidden="true">{growth.emoji}</span> Stage {growth.overallStage}
    </button>
  );
}
