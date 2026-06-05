/**
 * One-tap approval card for a held effectful action (propose→approve, P3). Shows
 * what the companion wants to do and offers Confirm / Decline. Disables both
 * while a choice is in flight so a double-tap can't double-submit (the server's
 * exactly-once claim is the real guard; this is just UX).
 */

import type { ProposalDto } from '@cobble/shared';
import { useState } from 'react';

interface ProposalCardProps {
  readonly proposal: ProposalDto;
  readonly onConfirm: (proposalId: string) => Promise<unknown>;
  readonly onReject: (proposalId: string) => Promise<unknown>;
}

export function ProposalCard({ proposal, onConfirm, onReject }: ProposalCardProps): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (fn: (id: string) => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await fn(proposal.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      // Always re-enable, even on the success path. A resolved action usually
      // unmounts this card (the parent drops it from the queue), in which case
      // this is a harmless no-op; but if that follow-up refresh fails the card
      // lingers, and it must not linger with both buttons permanently dead.
      setBusy(false);
    }
  };

  return (
    <div className="proposal-card">
      <p className="proposal-summary">Cobble wants to: {proposal.summary}</p>
      <div className="proposal-actions">
        <button type="button" disabled={busy} onClick={() => void act(onConfirm)}>
          Approve
        </button>
        <button type="button" disabled={busy} onClick={() => void act(onReject)}>
          Decline
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
