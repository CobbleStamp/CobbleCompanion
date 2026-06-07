/**
 * The Growth view (Phase 5, development-plan.md §3) — the companion's growth made
 * visible as a MIRROR: four axis readings (knowledge, bond, initiative, character),
 * the "what {name} has shown it can do" capability checklist, the "Who {name} has
 * become" character card, and the feeding kitchen (the user's food pantry). Readings
 * reflect the companion's current standing and may move either way — no levels, no
 * badges. Growth is read-only here (decoupled from feeding); the kitchen is the one
 * mutating affordance.
 */

import type {
  AxisReadingDto,
  CharacterDriveDto,
  FoodDef,
  FoodInventoryDto,
  GrowthDto,
} from '@cobble/shared';
import { FOODS } from '@cobble/shared';
import { useEffect, useState } from 'react';
import { feedCompanion, fetchGrowth, getFood } from '../api/client.js';
import { UsageBadge } from '../components/UsageBadge.js';

interface GrowthPageProps {
  readonly companionName: string;
  readonly companionId: string;
  readonly onBack: () => void;
}

export function Growth({ companionName, companionId, onBack }: GrowthPageProps): JSX.Element {
  const [growth, setGrowth] = useState<GrowthDto | null>(null);
  const [food, setFood] = useState<FoodInventoryDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feeding, setFeeding] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const [g, pantry] = await Promise.all([fetchGrowth(companionId), getFood()]);
        setGrowth(g);
        setFood(pantry);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load growth');
      }
    })();
  }, [companionId]);

  async function give(def: FoodDef): Promise<void> {
    setError(null);
    setFeeding(true);
    try {
      // Feeding refills the companion's wallets and spends from the user's pantry;
      // growth is decoupled, so only the pantry changes here.
      const result = await feedCompanion(companionId, def.type);
      setFood(result.food);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not feed');
    } finally {
      setFeeding(false);
    }
  }

  return (
    <main className="chat">
      <header>
        <h1>{companionName} · Growth</h1>
        <UsageBadge companionId={companionId} />
        <button type="button" onClick={onBack}>
          Back
        </button>
      </header>

      {error && <p className="error">{error}</p>}
      {!growth && !error && <p>Loading…</p>}

      {growth && (
        <div className="growth">
          <section className="card">
            <h2>Growth</h2>
            <AxisBar label="Knowledge" axis={growth.knowledge} />
            <AxisBar label="Bond" axis={growth.bond} />
            <AxisBar label="Initiative" axis={growth.initiative} />
            <AxisBar
              label="Character"
              axis={{ band: growth.character.band, fill: growth.character.fill, detail: '' }}
            />
          </section>

          <section className="card">
            <h2>What {companionName} has shown it can do</h2>
            <ul className="capability-list">
              {growth.capabilities.map((capability) => (
                <li key={capability.key} className={capability.observed ? 'observed' : 'unseen'}>
                  <span aria-hidden="true">{capability.observed ? '✓' : '◦'}</span>{' '}
                  {capability.label}
                  {capability.observed ? '' : ' — not yet'}
                </li>
              ))}
            </ul>
          </section>

          <section className="card">
            <h2>Who {companionName} has become</h2>
            <p className="muted">{growth.character.band}</p>
            {growth.character.drives.map((drive) => (
              <DriveBar key={drive.key} drive={drive} />
            ))}
            {growth.character.evolvedPersona ? (
              <p className="evolved-persona">“{growth.character.evolvedPersona}”</p>
            ) : (
              <p className="muted">Still getting to know each other.</p>
            )}
          </section>

          <section className="card">
            <h2>Kitchen</h2>
            <p className="muted">
              Feed {companionName} from your pantry to refill its vitality. Each food is spent when
              given.
            </p>
            <div className="food-buttons">
              {FOODS.map((def) => {
                const count = food ? food[def.type] : 0;
                return (
                  <button
                    key={def.type}
                    type="button"
                    disabled={feeding || count <= 0}
                    onClick={() => void give(def)}
                  >
                    {def.emoji} {def.label} (×{count})
                  </button>
                );
              })}
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

/** A labelled axis reading: the band name, a gauge fill, and the substrate detail. */
function AxisBar({ label, axis }: { label: string; axis: AxisReadingDto }): JSX.Element {
  const pct = Math.round(Math.max(0, Math.min(1, axis.fill)) * 100);
  return (
    <div className="axis">
      <div className="axis-head">
        <span>{label}</span>
        <span className="muted">{axis.band}</span>
      </div>
      <div className="axis-track">
        <div className="axis-fill" style={{ width: `${pct}%` }} />
      </div>
      {axis.detail && <p className="muted axis-detail">{axis.detail}</p>}
    </div>
  );
}

/** One learned drive as a 0–1 weight bar on the character card. */
function DriveBar({ drive }: { drive: CharacterDriveDto }): JSX.Element {
  const pct = Math.round(Math.max(0, Math.min(1, drive.weight)) * 100);
  return (
    <div className="axis">
      <div className="axis-head">
        <span>{drive.label}</span>
      </div>
      <div className="axis-track">
        <div className="axis-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
