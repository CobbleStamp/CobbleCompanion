/**
 * The Activity view (Phase 4) — the companion's autonomous initiatives made
 * visible as a read-only log. Each card is one burst the motivation engine ran on
 * its own (no approval gate — autonomy is autonomy): the "what I read" report note
 * it posted, the drive it served (with the weight mix at the time), the belief that
 * drove it, and how the user reacted (the reward). Newest-first, paginated by seq.
 */

import type {
  Drive,
  DriveWeights,
  ProactiveActivityStats,
  ProactiveBeliefDto,
  ProactiveOutcomeDto,
  ProactiveReadSourceDto,
} from '@cobble/shared';
import { DRIVE_LABELS } from '@cobble/shared';
import { useEffect, useState } from 'react';
import { fetchActivity } from '../api/client.js';
import { UsageBadge } from '../components/UsageBadge.js';

interface ActivityPageProps {
  readonly companionName: string;
  readonly companionId: string;
  readonly onBack: () => void;
}

export function Activity({ companionName, companionId, onBack }: ActivityPageProps): JSX.Element {
  const [outcomes, setOutcomes] = useState<readonly ProactiveOutcomeDto[]>([]);
  const [stats, setStats] = useState<ProactiveActivityStats | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const page = await fetchActivity(companionId);
        setOutcomes(page.outcomes);
        setStats(page.stats);
        setCursor(page.nextCursor);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load activity');
      } finally {
        setLoading(false);
      }
    })();
  }, [companionId]);

  async function loadMore(): Promise<void> {
    if (cursor === null) return;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await fetchActivity(companionId, cursor);
      setOutcomes((prev) => [...prev, ...page.outcomes]);
      setCursor(page.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load more');
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <main className="chat">
      <header>
        <h1>{companionName} · Activity</h1>
        <UsageBadge companionId={companionId} />
        <button type="button" onClick={onBack}>
          Back
        </button>
      </header>

      {error && <p className="error">{error}</p>}
      {loading && !error && <p>Loading…</p>}

      {!loading && stats && (
        <p className="muted activity-summary">
          {stats.total === 0
            ? `${companionName} hasn't ventured out on its own yet.`
            : `${stats.total} self-directed ${stats.total === 1 ? 'move' : 'moves'} · ${stats.positive} welcomed`}
        </p>
      )}

      {!loading && outcomes.length > 0 && (
        <ul className="activity-list">
          {outcomes.map((outcome) => (
            <ActivityCard key={outcome.id} companionName={companionName} outcome={outcome} />
          ))}
        </ul>
      )}

      {cursor !== null && (
        <button
          type="button"
          className="activity-more"
          disabled={loadingMore}
          onClick={() => void loadMore()}
        >
          {loadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}
    </main>
  );
}

/** One autonomous initiative: drive + time, the report note, belief, and reaction. */
function ActivityCard({
  companionName,
  outcome,
}: {
  companionName: string;
  outcome: ProactiveOutcomeDto;
}): JSX.Element {
  return (
    <li className="activity-card">
      <div className="activity-head">
        <span className="activity-drive">{DRIVE_LABELS[outcome.drive]}</span>
        <time
          className="muted"
          dateTime={outcome.createdAt}
          title={absoluteTime(outcome.createdAt)}
        >
          {relativeTime(outcome.createdAt)}
        </time>
      </div>

      {outcome.note ? (
        <p className="activity-note">{outcome.note}</p>
      ) : (
        <p className="muted activity-note">
          {companionName} acted, but the report note is no longer available.
        </p>
      )}

      {outcome.belief && <BeliefLine belief={outcome.belief} />}

      <ReadSources sources={outcome.sources} />

      <RewardChip reward={outcome.reward} resolved={outcome.resolved} />

      {outcome.driveSnapshot && (
        <DriveSnapshot weights={outcome.driveSnapshot} served={outcome.drive} />
      )}
    </li>
  );
}

/** The Tier-2 belief that drove the burst, as "Driven by: subject predicate object". */
function BeliefLine({ belief }: { belief: ProactiveBeliefDto }): JSX.Element {
  const phrase = [belief.subject, belief.predicate, belief.object].filter(Boolean).join(' ');
  return (
    <p className="activity-belief muted">
      <span aria-hidden="true">↳ </span>Driven by: {phrase}
    </p>
  );
}

/**
 * The sources this act read, each with the findings it actually extracted. A source
 * with no findings (e.g. a JS-rendered page that yielded only boilerplate) says so
 * plainly, so the log never implies substance it didn't capture.
 */
function ReadSources({
  sources,
}: {
  sources: readonly ProactiveReadSourceDto[];
}): JSX.Element | null {
  if (sources.length === 0) {
    return null;
  }
  return (
    <div className="activity-sources">
      <p className="muted activity-sources-head">
        Read {sources.length} source{sources.length === 1 ? '' : 's'}:
      </p>
      <ul className="activity-source-list">
        {sources.map((source) => (
          <li key={source.sourceId} className="activity-source">
            <SourceTitle title={source.title} />
            {source.findings.length > 0 ? (
              <ul className="activity-findings">
                {source.findings.map((finding, i) => (
                  <li key={i}>{finding}</li>
                ))}
              </ul>
            ) : (
              <span className="muted activity-no-findings">no readable findings extracted</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Render a source's captured title as an external link when it's a URL, else text. */
function SourceTitle({ title }: { title: string }): JSX.Element {
  const isUrl = /^https?:\/\//.test(title);
  return isUrl ? (
    <a className="activity-source-link" href={title} target="_blank" rel="noreferrer noopener">
      {title}
    </a>
  ) : (
    <span className="activity-source-link">{title}</span>
  );
}

/** Threshold below which a mood delta reads as "neutral" rather than for/against. */
const REWARD_EPSILON = 0.05;

/** How the user reacted to the report note: awaiting, welcomed, neutral, or cool. */
function RewardChip({
  reward,
  resolved,
}: {
  reward: number | null;
  resolved: boolean;
}): JSX.Element {
  if (!resolved || reward === null) {
    return <span className="reward-chip reward-pending">Awaiting your reaction</span>;
  }
  const delta = reward >= 0 ? `+${reward.toFixed(2)}` : reward.toFixed(2);
  if (reward > REWARD_EPSILON) {
    return <span className="reward-chip reward-positive">✓ Welcomed ({delta})</span>;
  }
  if (reward < -REWARD_EPSILON) {
    return <span className="reward-chip reward-negative">Cool ({delta})</span>;
  }
  return <span className="reward-chip reward-neutral">Neutral ({delta})</span>;
}

/** The drive weight mix at initiation — compact bars, the served drive highlighted. */
function DriveSnapshot({ weights, served }: { weights: DriveWeights; served: Drive }): JSX.Element {
  return (
    <details className="activity-snapshot">
      <summary className="muted">Drive mix at the time</summary>
      <div className="snapshot-bars">
        {(Object.keys(DRIVE_LABELS) as Drive[]).map((drive) => {
          const pct = Math.round(Math.max(0, Math.min(1, weights[drive])) * 100);
          return (
            <div key={drive} className={drive === served ? 'snapshot-row served' : 'snapshot-row'}>
              <span className="snapshot-label">{DRIVE_LABELS[drive]}</span>
              <div className="snapshot-track">
                <div className="snapshot-fill" style={{ width: `${pct}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </details>
  );
}

/** Absolute timestamp for the hover title (locale-formatted). */
function absoluteTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

/** Coarse relative time ("2 days ago"); falls back to the date for older entries. */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(iso).toLocaleDateString();
}
