/**
 * The Growth view (Phase 5, development-plan.md §3) — the companion's growth made
 * visible as a MIRROR: four axis readings (knowledge, bond, initiative, character),
 * the "what {name} has shown it can do" capability checklist, the "Who {name} has
 * become" character card, and the feeding kitchen (treats + foods). Readings reflect
 * the companion's current standing and may move either way — no levels, no badges.
 * Growth is read-only here; the kitchen is the one mutating affordance.
 */

import type { AxisReadingDto, CharacterDriveDto, FoodDef, GrowthDto } from '@cobble/shared';
import { FOODS } from '@cobble/shared';
import { useEffect, useState } from 'react';
import { feedCompanion, fetchGrowth } from '../api/client.js';
import { UsageBadge } from '../components/UsageBadge.js';

interface GrowthPageProps {
  readonly companionName: string;
  readonly companionId: string;
  readonly onBack: () => void;
}

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
        <h1>{companionName} · Growth</h1>
        <UsageBadge />
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
            <AxisBar label="Character" axis={characterAxis(growth)} />
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
              🍪 {growth.treats} treats · feed {companionName} to refill its vitality (spends
              treats).
            </p>
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

/** The character axis as an AxisReadingDto (band + a fill derived from the drive spread). */
function characterAxis(growth: GrowthDto): AxisReadingDto {
  const drives = growth.character.drives;
  const spread =
    drives.length === 0
      ? 0
      : drives.reduce((sum, d) => sum + Math.abs(d.weight - 0.5), 0) / drives.length / 0.5;
  return { band: growth.character.band, fill: spread, detail: '' };
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
