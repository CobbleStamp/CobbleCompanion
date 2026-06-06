/**
 * The Growth view (Phase 5, development-plan.md §3) — makes the companion's growth
 * visible and felt: the two smooth axes (knowledge, relationship), the abilities
 * unlock checklist, the "Who <name> has become" personality card, the overall
 * stage, and the feeding kitchen (treats + foods). Growth is read-only here; the
 * kitchen is the one mutating affordance.
 */

import type { Drive, FoodDef, GrowthAxisDto, GrowthDto } from '@cobble/shared';
import { FOODS } from '@cobble/shared';
import { useEffect, useState } from 'react';
import { feedCompanion, fetchGrowth } from '../api/client.js';
import { UsageBadge } from '../components/UsageBadge.js';

interface GrowthPageProps {
  readonly companionName: string;
  readonly companionId: string;
  readonly onBack: () => void;
}

/** The six learned drives, in the order shown on the personality card. */
const DRIVE_LABELS: ReadonlyArray<{ readonly key: Drive; readonly label: string }> = [
  { key: 'curiosity', label: 'Curiosity' },
  { key: 'bond', label: 'Bond' },
  { key: 'understanding', label: 'Understanding' },
  { key: 'approval', label: 'Approval' },
  { key: 'helpfulness', label: 'Helpfulness' },
  { key: 'upkeep', label: 'Upkeep' },
];

export function Growth({ companionName, companionId, onBack }: GrowthPageProps): JSX.Element {
  const [growth, setGrowth] = useState<GrowthDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feeding, setFeeding] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        setGrowth(await fetchGrowth(companionId));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load growth');
      }
    })();
  }, [companionId]);

  async function give(food: FoodDef): Promise<void> {
    setError(null);
    setFeeding(true);
    try {
      const result = await feedCompanion(companionId, food.type);
      setGrowth(result.growth);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not feed');
    } finally {
      setFeeding(false);
    }
  }

  return (
    <main className="chat">
      <header>
        <h1>
          {growth ? `${growth.emoji} ` : ''}
          {companionName} · Growth
        </h1>
        <UsageBadge />
        <button type="button" onClick={onBack}>
          Back
        </button>
      </header>

      {error && <p className="error">{error}</p>}
      {!growth && !error && <p>Loading…</p>}

      {growth && (
        <div className="growth">
          <section className="card growth-stage">
            <span className="growth-emoji" aria-hidden="true">
              {growth.emoji}
            </span>
            <div>
              <h2>Stage {growth.overallStage}</h2>
              <p className="muted">🍪 {growth.treats} treats</p>
            </div>
          </section>

          <section className="card">
            <h2>Growth</h2>
            <AxisBar label="Knowledge" axis={growth.knowledge} />
            <AxisBar label="Relationship" axis={growth.relationship} />
          </section>

          <section className="card">
            <h2>Abilities</h2>
            <ul className="ability-list">
              {growth.abilities.map((ability) => (
                <li key={ability.key} className={ability.unlocked ? 'unlocked' : 'locked'}>
                  <span aria-hidden="true">{ability.unlocked ? '☑' : '☐'}</span> {ability.label}
                </li>
              ))}
            </ul>
          </section>

          <section className="card">
            <h2>Who {companionName} has become</h2>
            <p className="muted">
              Personality formed: {Math.round(growth.personality.spread * 100)}%
            </p>
            {DRIVE_LABELS.map(({ key, label }) => (
              <AxisBar
                key={key}
                label={label}
                axis={{ level: 0, progress: growth.personality.weights[key], detail: '' }}
              />
            ))}
            {growth.personality.evolvedPersona ? (
              <p className="evolved-persona">“{growth.personality.evolvedPersona}”</p>
            ) : (
              <p className="muted">Still getting to know each other.</p>
            )}
          </section>

          <section className="card">
            <h2>Kitchen</h2>
            <p className="muted">Feed {companionName} to refill its vitality (spends treats).</p>
            <div className="food-buttons">
              {FOODS.map((food) => (
                <button
                  key={food.type}
                  type="button"
                  disabled={feeding || growth.treats < food.treatCost}
                  onClick={() => void give(food)}
                >
                  {food.emoji} {food.label} ({food.treatCost}🍪)
                </button>
              ))}
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

/** A labelled progress bar (a growth axis, or a drive weight as a 0–1 fill). */
function AxisBar({ label, axis }: { label: string; axis: GrowthAxisDto }): JSX.Element {
  const pct = Math.round(Math.max(0, Math.min(1, axis.progress)) * 100);
  return (
    <div className="axis">
      <div className="axis-head">
        <span>{label}</span>
        {axis.level > 0 || axis.detail ? <span className="muted">Lv {axis.level}</span> : null}
      </div>
      <div className="axis-track">
        <div className="axis-fill" style={{ width: `${pct}%` }} />
      </div>
      {axis.detail && <p className="muted axis-detail">{axis.detail}</p>}
    </div>
  );
}
