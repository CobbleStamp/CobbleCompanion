/**
 * Proactivity dial (Phase 4 tunability) — the user's single control over how
 * readily the companion self-initiates: off / gentle / active. Optimistic: the
 * selection updates immediately and reverts if the save fails (the dial is a
 * preference, not a critical action).
 */

import type { ProactivityDial as Dial } from '@cobble/shared';
import { useState } from 'react';
import { setProactivityDial } from '../api/client.js';

const OPTIONS: readonly Dial[] = ['off', 'gentle', 'active'];

export function ProactivityDial({
  companionId,
  initial,
}: {
  companionId: string;
  initial: Dial;
}): JSX.Element {
  const [dial, setDial] = useState<Dial>(initial);
  const [saving, setSaving] = useState(false);

  const choose = async (next: Dial): Promise<void> => {
    if (next === dial || saving) return;
    const prev = dial;
    setSaving(true);
    setDial(next); // optimistic
    try {
      setDial(await setProactivityDial(companionId, next));
    } catch {
      setDial(prev); // revert on failure
    } finally {
      setSaving(false);
    }
  };

  return (
    <span className="proactivity-dial" role="group" aria-label="Proactivity level">
      {OPTIONS.map((opt) => (
        <button
          key={opt}
          type="button"
          className={`proactivity-dial__opt ${
            opt === dial ? 'proactivity-dial__opt--active' : ''
          }`.trim()}
          aria-pressed={opt === dial}
          disabled={saving}
          onClick={() => void choose(opt)}
        >
          {opt}
        </button>
      ))}
    </span>
  );
}
