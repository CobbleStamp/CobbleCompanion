import type {
  CompanionDto,
  EpisodeDto,
  EpisodeSearchResultDto,
  LeadDto,
  MemorySnapshotDto,
  MessageDto,
  ProcedureDto,
  SemanticSearchResultDto,
} from '@cobble/shared';
import { useEffect, useState } from 'react';
import {
  fetchMessages,
  getCompanionMemory,
  listEpisodes,
  listLeads,
  listProcedures,
  searchEpisodes,
  searchMemory,
} from '../api/client.js';
import { UsageBadge } from '../components/UsageBadge.js';

interface MemoryBrowserProps {
  readonly companion: CompanionDto;
  readonly onBack: () => void;
}

/**
 * Read-only memory browser (companion-memory.md). Shows what the companion holds,
 * grouped by memory kind: the episodic transcript, the semantic store's
 * source/section/fact counts (Phase 1), and procedural as "coming soon" so the
 * full knowledge-base shape is visible.
 */
export function MemoryBrowser({ companion, onBack }: MemoryBrowserProps): JSX.Element {
  const [snapshot, setSnapshot] = useState<MemorySnapshotDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [transcript, setTranscript] = useState<MessageDto[]>([]);

  useEffect(() => {
    void (async () => {
      try {
        setSnapshot(await getCompanionMemory(companion.id));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load memory');
      }
    })();
  }, [companion.id]);

  async function toggleTranscript(): Promise<void> {
    if (open) {
      setOpen(false);
      setTranscript([]);
      return;
    }
    try {
      const messages = await fetchMessages(companion.id);
      setOpen(true);
      setTranscript(messages);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load transcript');
    }
  }

  return (
    <main className="chat">
      <header>
        <h1>{companion.name} · Memory</h1>
        <UsageBadge />
        <button type="button" onClick={onBack}>
          Back to chat
        </button>
      </header>

      {error && <p className="error">{error}</p>}
      {!snapshot && !error && <p>Loading memory…</p>}

      {snapshot && (
        <div className="memory-sections">
          <section className="memory-section">
            <h2>Identity</h2>
            <p>
              <strong>{snapshot.identity.name}</strong> — a {snapshot.identity.form}.
            </p>
            <p>Temperament at creation: {snapshot.identity.temperament}</p>
            {snapshot.identity.evolvedPersona && (
              <p className="evolved">
                <strong>Who they've grown into:</strong> {snapshot.identity.evolvedPersona}
              </p>
            )}
            <p className="who">Since {formatDate(snapshot.identity.createdAt)}</p>
          </section>

          <section className="memory-section">
            <h2>Episodic — conversation</h2>
            <p className="who">
              {snapshot.episodic.messageCount} message
              {snapshot.episodic.messageCount === 1 ? '' : 's'} in one continuous conversation
            </p>
            {snapshot.episodic.messageCount > 0 && (
              <ul className="memory-list">
                <li>
                  <button
                    type="button"
                    className="memory-row"
                    onClick={() => void toggleTranscript()}
                  >
                    {open ? 'Hide transcript' : 'View transcript'}
                  </button>
                  {open && (
                    <ul className="transcript">
                      {transcript.map((message) => (
                        <li key={message.id} className={`line ${message.role}`}>
                          <span className="who">
                            {message.role === 'user' ? 'You' : snapshot.identity.name}
                          </span>
                          <span className="content">{message.content}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              </ul>
            )}
          </section>

          <section className="memory-section">
            <h2>Episodic — memories</h2>
            <p className="who">
              {snapshot.episodic.episodeCount} consolidated memor
              {snapshot.episodic.episodeCount === 1 ? 'y' : 'ies'} of your shared history
            </p>
            {snapshot.episodic.episodeCount > 0 && <EpisodesSection companionId={companion.id} />}
          </section>

          <section className="memory-section">
            <h2>Semantic — knowledge from sources</h2>
            <p className="who">
              {snapshot.semantic.sourceCount} source
              {snapshot.semantic.sourceCount === 1 ? '' : 's'} · {snapshot.semantic.sectionCount}{' '}
              section
              {snapshot.semantic.sectionCount === 1 ? '' : 's'} · {snapshot.semantic.factCount} fact
              {snapshot.semantic.factCount === 1 ? '' : 's'}
            </p>
            {snapshot.semantic.sectionCount > 0 && <SemanticSearch companionId={companion.id} />}
          </section>
          <section className="memory-section">
            <h2>Procedural — learned skills & workflows</h2>
            <p className="who">
              {snapshot.procedural.procedureCount} learned workflow
              {snapshot.procedural.procedureCount === 1 ? '' : 's'}
            </p>
            <ProceduralList companionId={companion.id} />
          </section>
          <ReadingListSection companionId={companion.id} />
        </div>
      )}
    </main>
  );
}

interface EpisodesSectionProps {
  readonly companionId: string;
}

/** The episode timeline (consolidated memories) plus a topic-recall window. */
function EpisodesSection({ companionId }: EpisodesSectionProps): JSX.Element {
  const [episodes, setEpisodes] = useState<EpisodeDto[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [results, setResults] = useState<EpisodeSearchResultDto[] | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setEpisodes(await listEpisodes(companionId));
        setLoadError(null);
      } catch (err) {
        console.error('failed to load episode timeline', { companionId, error: err });
        setEpisodes([]);
        setLoadError(err instanceof Error ? err.message : 'Failed to load memories');
      }
    })();
  }, [companionId]);

  async function onSearch(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (query.trim().length === 0 || busy) return;
    setBusy(true);
    try {
      setResults(await searchEpisodes(companionId, query.trim()));
      setSearchError(null);
    } catch (err) {
      setResults(null);
      setSearchError(err instanceof Error ? err.message : 'Search failed');
    } finally {
      setBusy(false);
    }
  }

  // The recalled set when a search is active, else the full timeline.
  const shown = results ? results.map((result) => result.episode) : (episodes ?? []);

  return (
    <div>
      <form onSubmit={(e) => void onSearch(e)}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Recall a memory…"
          aria-label="Search episodic memory"
        />
        <button type="submit" disabled={busy}>
          Recall
        </button>
      </form>
      {searchError && <p className="error">{searchError}</p>}
      {results && results.length === 0 && <p className="who">No memory of that yet.</p>}
      {!results && loadError && <p className="error">{loadError}</p>}
      {!results && episodes === null && <p className="who">Loading memories…</p>}
      {!results && episodes?.length === 0 && !loadError && <p className="who">No memories yet.</p>}
      <ul className="memory-list">
        {shown.map((episode) => (
          <li key={episode.id}>
            <p className="who">{formatWhen(episode.occurredStart, episode.occurredEnd)}</p>
            <blockquote>{episode.summary}</blockquote>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface SemanticSearchProps {
  readonly companionId: string;
}

/** Recall window: search what the companion has read, with verbatim provenance. */
function SemanticSearch({ companionId }: SemanticSearchProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SemanticSearchResultDto[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSearch(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (query.trim().length === 0 || busy) return;
    setBusy(true);
    try {
      setResults(await searchMemory(companionId, query.trim()));
      setSearchError(null);
    } catch (err) {
      setResults(null);
      setSearchError(err instanceof Error ? err.message : 'Search failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <form onSubmit={(e) => void onSearch(e)}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search what it has read…"
          aria-label="Search semantic memory"
        />
        <button type="submit" disabled={busy}>
          Search
        </button>
      </form>
      {searchError && <p className="error">{searchError}</p>}
      {results && results.length === 0 && <p className="who">Nothing found for that.</p>}
      {results && results.length > 0 && (
        <ul className="memory-list">
          {results.map((result) => (
            <li key={`${result.citation.sourceId}-${result.citation.paraStart}`}>
              <p className="who">
                {result.citation.sourceTitle} · {result.citation.topicTitle} · para{' '}
                {result.citation.paraStart}–{result.citation.paraEnd}
              </p>
              <blockquote>{result.originalText}</blockquote>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Lists the companion's learned workflows (procedural memory, P3). */
function ProceduralList({ companionId }: { readonly companionId: string }): JSX.Element | null {
  const [procedures, setProcedures] = useState<readonly ProcedureDto[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    let mounted = true;
    void listProcedures(companionId)
      .then((rows) => {
        if (mounted) setProcedures(rows);
      })
      .catch((err: unknown) => {
        console.error('failed to load procedural memory', { companionId, error: err });
        if (mounted) setLoadError(err instanceof Error ? err.message : 'Failed to load workflows');
      });
    return () => {
      mounted = false;
    };
  }, [companionId]);
  if (loadError) return <p className="error">{loadError}</p>;
  if (procedures.length === 0) return null;
  return (
    <ul className="memory-list">
      {procedures.map((procedure) => (
        <li key={procedure.id}>
          <span className="content">{procedure.title}</span>
          <span className="who">{procedure.steps.join(' → ')}</span>
        </li>
      ))}
    </ul>
  );
}

/** The reading list — leads the companion discovered but hasn't acted on (P3). */
function ReadingListSection({ companionId }: { readonly companionId: string }): JSX.Element {
  const [leads, setLeads] = useState<readonly LeadDto[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    let mounted = true;
    void listLeads(companionId)
      .then((rows) => {
        if (mounted) setLeads(rows);
      })
      .catch((err: unknown) => {
        console.error('failed to load reading list', { companionId, error: err });
        if (mounted)
          setLoadError(err instanceof Error ? err.message : 'Failed to load reading list');
      });
    return () => {
      mounted = false;
    };
  }, [companionId]);
  return (
    <section className="memory-section">
      <h2>Reading list — discovered, not yet read</h2>
      {loadError ? (
        <p className="error">{loadError}</p>
      ) : leads.length === 0 ? (
        <p className="who">Nothing waiting — Cobble collects links here as it reads.</p>
      ) : (
        <ul className="memory-list">
          {leads.map((lead) => (
            <li key={lead.id}>
              <span className="content">{lead.url}</span>
              {lead.why && <span className="who">{lead.why}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

/** A memory's wall-clock span as a friendly date (or date range). */
function formatWhen(occurredStart: string, occurredEnd: string): string {
  const start = new Date(occurredStart).toLocaleDateString();
  const end = new Date(occurredEnd).toLocaleDateString();
  return start === end ? start : `${start} – ${end}`;
}
