/**
 * Sources page — feed the companion's knowledge base (Phase 1): upload a PDF,
 * paste a note, or add a link; watch "Cobble has read N of M sources" while
 * background ingestion runs (polled), and drill into what was read.
 */

import { UPLOAD_ACCEPT_ATTR, type IngestionJobDto, type SourceDto } from '@cobble/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createLinkSource,
  createNoteSource,
  deleteSource,
  listIngestionJobs,
  listSources,
  uploadFileSource,
} from '../api/client.js';
import { UsageBadge } from '../components/UsageBadge.js';

interface SourcesProps {
  readonly companionName: string;
  readonly companionId: string;
  readonly onBack: () => void;
}

const POLL_INTERVAL_MS = 1_500;

/**
 * Job states that still change on their own — keep polling while any source is
 * in one. `deferred` is excluded: it waits (possibly hours) for the daily token
 * allowance to reset, so fast polling would be wasteful.
 */
function isActive(job: IngestionJobDto): boolean {
  return job.status !== 'done' && job.status !== 'failed' && job.status !== 'deferred';
}

export function Sources({ companionName, companionId, onBack }: SourcesProps): JSX.Element {
  const [sources, setSources] = useState<SourceDto[]>([]);
  const [jobs, setJobs] = useState<IngestionJobDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);
  // Guards state updates from refreshes still in flight at unmount.
  const mountedRef = useRef(true);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [nextSources, nextJobs] = await Promise.all([
        listSources(companionId),
        listIngestionJobs(companionId),
      ]);
      if (!mountedRef.current) return;
      setSources(nextSources);
      setJobs(nextJobs);
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : 'Failed to load sources');
    }
  }, [companionId]);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

  // Poll while any job is still reading; stop as soon as everything settles.
  useEffect(() => {
    if (!jobs.some(isActive)) return;
    pollRef.current = window.setTimeout(() => void refresh(), POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current !== null) window.clearTimeout(pollRef.current);
    };
  }, [jobs, refresh]);

  const remove = useCallback(
    async (sourceId: string): Promise<void> => {
      try {
        await deleteSource(companionId, sourceId);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to delete source');
      }
    },
    [companionId, refresh],
  );

  const jobBySource = new Map(jobs.map((job) => [job.sourceId, job]));
  const readCount = jobs.filter((job) => job.status === 'done').length;

  return (
    <main className="chat">
      <header>
        <h1>{companionName} · Sources</h1>
        <UsageBadge />
        <button type="button" onClick={onBack}>
          Back to chat
        </button>
      </header>

      {error && <p className="error">{error}</p>}
      {jobs.length > 0 && (
        <p className="who">
          {companionName} has read {readCount} of {jobs.length} source
          {jobs.length === 1 ? '' : 's'}
        </p>
      )}

      <AddSourceForms companionId={companionId} onAdded={() => void refresh()} onError={setError} />

      <ul className="memory-list">
        {sources.map((source) => {
          const job = jobBySource.get(source.id);
          return (
            <li key={source.id} className="memory-section">
              <strong>{source.title}</strong> <span className="who">({source.kind})</span>
              <button
                type="button"
                className="link-button"
                onClick={() => void remove(source.id)}
                aria-label={`Delete ${source.title}`}
              >
                Delete
              </button>
              {job && (
                <p className="who">
                  {job.status === 'done' && `read · ${job.sectionsTotal} sections`}
                  {job.status === 'failed' && `failed: ${job.error ?? 'unknown error'}`}
                  {job.status === 'deferred' &&
                    'waiting for your daily allowance to reset, then Cobble finishes reading it'}
                  {isActive(job) &&
                    `${job.status}… ${job.sectionsDone}/${job.sectionsTotal || '?'} sections`}
                </p>
              )}
            </li>
          );
        })}
      </ul>
      {sources.length === 0 && !error && (
        <p className="who">No sources yet — hand {companionName} something to read.</p>
      )}
    </main>
  );
}

interface AddSourceFormsProps {
  readonly companionId: string;
  readonly onAdded: () => void;
  readonly onError: (message: string | null) => void;
}

/** The three intake forms: PDF upload, note, link. */
function AddSourceForms({ companionId, onAdded, onError }: AddSourceFormsProps): JSX.Element {
  const [noteTitle, setNoteTitle] = useState('');
  const [noteText, setNoteText] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(action: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    try {
      await action();
      onError(null);
      onAdded();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to add source');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="memory-sections">
      <section className="memory-section">
        <h2>Upload a file</h2>
        <p>PDF, plain text (.txt), Markdown (.md), Word (.docx), or PowerPoint (.pptx).</p>
        <input
          type="file"
          accept={UPLOAD_ACCEPT_ATTR}
          aria-label="Source file"
          disabled={busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) {
              void submit(() => uploadFileSource(companionId, file));
              event.target.value = '';
            }
          }}
        />
      </section>

      <section className="memory-section">
        <h2>Add a note</h2>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (noteTitle.trim() && noteText.trim()) {
              void submit(() =>
                createNoteSource(companionId, { title: noteTitle.trim(), text: noteText.trim() }),
              ).then(() => {
                setNoteTitle('');
                setNoteText('');
              });
            }
          }}
        >
          <input
            value={noteTitle}
            onChange={(e) => setNoteTitle(e.target.value)}
            placeholder="Note title"
            aria-label="Note title"
            disabled={busy}
          />
          <textarea
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            placeholder="Paste or write the note…"
            aria-label="Note text"
            disabled={busy}
          />
          <button type="submit" disabled={busy}>
            Add note
          </button>
        </form>
      </section>

      <section className="memory-section">
        <h2>Add a link</h2>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (linkUrl.trim()) {
              void submit(() => createLinkSource(companionId, { url: linkUrl.trim() })).then(() =>
                setLinkUrl(''),
              );
            }
          }}
        >
          <input
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            placeholder="https://…"
            aria-label="Link URL"
            disabled={busy}
          />
          <button type="submit" disabled={busy}>
            Add link
          </button>
        </form>
      </section>
    </div>
  );
}
