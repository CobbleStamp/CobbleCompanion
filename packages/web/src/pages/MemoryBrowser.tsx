import type {
  CompanionDto,
  MemorySnapshotDto,
  MessageDto,
  SemanticSearchResultDto,
} from '@cobble/shared';
import { useEffect, useState } from 'react';
import { fetchMessages, getCompanionMemory, searchMemory } from '../api/client.js';

interface MemoryBrowserProps {
  readonly companion: CompanionDto;
  readonly onBack: () => void;
}

/**
 * Read-only memory browser (companionmemory.md). Shows what the companion holds,
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
    setOpen(true);
    setTranscript(await fetchMessages(companion.id));
  }

  return (
    <main className="chat">
      <header>
        <h1>{companion.name} · Memory</h1>
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
            <p>{snapshot.identity.temperament}</p>
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
          <PlannedSection
            title="Procedural — learned skills & workflows"
            phase={snapshot.procedural.plannedPhase}
          />
        </div>
      )}
    </main>
  );
}

interface SemanticSearchProps {
  readonly companionId: string;
}

/** Recall window: search what the companion has read, with verbatim provenance. */
function SemanticSearch({ companionId }: SemanticSearchProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SemanticSearchResultDto[] | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSearch(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (query.trim().length === 0 || busy) return;
    setBusy(true);
    try {
      setResults(await searchMemory(companionId, query.trim()));
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

interface PlannedSectionProps {
  readonly title: string;
  readonly phase: string;
}

/** A designed-but-unbuilt memory kind, shown so the full shape is visible. */
function PlannedSection({ title, phase }: PlannedSectionProps): JSX.Element {
  return (
    <section className="memory-section planned">
      <h2>{title}</h2>
      <p className="who">Coming soon · planned for {phase}</p>
    </section>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}
