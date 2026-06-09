import type { UserFactDto } from '@cobble/shared';
import { useEffect, useState } from 'react';
import { forgetUserFact, getUserFacts, updateUserFact } from '../api/client.js';

/** Human labels for the identity predicates the companion captures (Phase 11). */
const LABELS: Readonly<Record<string, string>> = {
  name: 'Name',
  pronouns: 'Pronouns',
  gender: 'Gender',
  bornOn: 'Born on',
  age: 'Age',
  livesIn: 'Lives in',
  worksAs: 'Works as',
  languages: 'Speaks',
  relationships: 'Relationships',
};

/** Human labels for the Tier-2 belief predicates (Phase 12). */
const BELIEF_LABELS: Readonly<Record<string, string>> = {
  prefers: 'Prefers',
  dislikes: 'Dislikes',
  interestedIn: 'Interested in',
  believes: 'Believes',
};

function labelFor(predicate: string | null): string {
  if (!predicate) return 'Fact';
  return LABELS[predicate] ?? predicate;
}

function beliefLabelFor(predicate: string | null): string {
  if (!predicate) return 'Believes';
  return BELIEF_LABELS[predicate] ?? predicate;
}

interface UserModelPanelProps {
  /** The Tier-3 synthesized "how the companion understands you" (Phase 13), read-only. */
  readonly userPersona?: string | null;
}

/**
 * The user-model panel (companion-memory.md §4): the legible, correctable view of
 * what the companion knows about its USER. Per-user (not per-companion) — and the one
 * place the otherwise read-only memory browser becomes writable: edit or delete any fact
 * or belief. The Tier-3 user persona (per-companion) is shown read-only (Phase 13).
 */
export function UserModelPanel({ userPersona }: UserModelPanelProps = {}): JSX.Element {
  const [facts, setFacts] = useState<readonly UserFactDto[] | null>(null);
  const [beliefs, setBeliefs] = useState<readonly UserFactDto[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const model = await getUserFacts();
        setFacts(model.facts);
        setBeliefs(model.beliefs);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load your profile');
      }
    })();
  }, []);

  // Edit/forget operate on whichever list holds the id (Tier-1 facts or Tier-2 beliefs).
  async function onEdit(factId: string, object: string): Promise<void> {
    try {
      const updated = await updateUserFact(factId, object);
      const apply = (list: readonly UserFactDto[]) =>
        list.map((fact) => (fact.id === factId ? updated : fact));
      setFacts((prev) => (prev ? apply(prev) : prev));
      setBeliefs((prev) => apply(prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    }
  }

  async function onForget(factId: string): Promise<void> {
    try {
      await forgetUserFact(factId);
      const drop = (list: readonly UserFactDto[]) => list.filter((fact) => fact.id !== factId);
      setFacts((prev) => (prev ? drop(prev) : prev));
      setBeliefs((prev) => drop(prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to forget');
    }
  }

  return (
    <section className="memory-section">
      <h2>About you</h2>
      <p className="who">
        What Cobble has learned about you — it learns as you talk, and you can edit or forget
        anything.
      </p>
      {userPersona && userPersona.trim().length > 0 && (
        <p className="evolved">
          <strong>How Cobble understands you:</strong> {userPersona}
        </p>
      )}
      {error && <p className="error">{error}</p>}
      {facts === null && !error && <p className="who">Loading…</p>}
      {facts && facts.length === 0 && (
        <p className="who">Nothing yet — Cobble will learn about you as you chat.</p>
      )}
      {facts && facts.length > 0 && (
        <ul className="memory-list">
          {facts.map((fact) => (
            <UserFactRow
              key={fact.id}
              fact={fact}
              label={labelFor(fact.predicate)}
              onEdit={onEdit}
              onForget={onForget}
            />
          ))}
        </ul>
      )}

      {beliefs.length > 0 && (
        <div className="beliefs">
          <h3>What you seem to like &amp; care about</h3>
          <p className="who">
            Cobble picks these up as you talk — preferences, interests, opinions. Edit or forget
            any.
          </p>
          <ul className="memory-list">
            {beliefs.map((belief) => (
              <UserFactRow
                key={belief.id}
                fact={belief}
                label={beliefLabelFor(belief.predicate)}
                onEdit={onEdit}
                onForget={onForget}
              />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

interface UserFactRowProps {
  readonly fact: UserFactDto;
  readonly label: string;
  readonly onEdit: (factId: string, object: string) => Promise<void>;
  readonly onForget: (factId: string) => Promise<void>;
}

/** One fact/belief: its label + value, with inline edit and a forget control. */
function UserFactRow({ fact, label, onEdit, onForget }: UserFactRowProps): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(fact.object);
  const [busy, setBusy] = useState(false);

  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (draft.trim().length === 0 || busy) return;
    setBusy(true);
    await onEdit(fact.id, draft.trim());
    setBusy(false);
    setEditing(false);
  }

  return (
    <li>
      <span className="who">{label}</span>
      {fact.sensitive && (
        <span className="sensitive-badge" title="A sensitive detail — you can forget it any time.">
          sensitive
        </span>
      )}
      {editing ? (
        <form onSubmit={(e) => void save(e)}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label={`Edit ${label}`}
          />
          <button type="submit" disabled={busy}>
            Save
          </button>
          <button
            type="button"
            onClick={() => {
              setDraft(fact.object);
              setEditing(false);
            }}
          >
            Cancel
          </button>
        </form>
      ) : (
        <>
          <span className="content">{fact.object}</span>
          <button type="button" onClick={() => setEditing(true)}>
            Edit
          </button>
          <button type="button" onClick={() => void onForget(fact.id)}>
            Forget
          </button>
        </>
      )}
    </li>
  );
}
