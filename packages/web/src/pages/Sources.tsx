/**
 * Sources page — feed the companion's knowledge base (Phase 1): upload a PDF,
 * paste a note, or add a link; watch "Cobble has read N of M sources" while
 * background ingestion runs (polled), and drill into what was read.
 */

import type { IngestionJobDto, SourceDto } from '@cobble/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createLinkSource,
  createNoteSource,
  listIngestionJobs,
  listSources,
  uploadPdfSource,
} from '../api/client.js';

interface SourcesProps {
  readonly companionName: string;
  readonly companionId: string;
  readonly onBack: () => void;
}

const POLL_INTERVAL_MS = 1_500;

/** Job states that still change — keep polling while any source is in one. */
function isActive(job: IngestionJobDto): boolean {
  return job.status !== 'done' && job.status !== 'failed';
}

export function Sources({ companionName, companionId, onBack }: SourcesProps): JSX.Element {
  const [sources, setSources] = useState<SourceDto[]>([]);
  const [jobs, setJobs] = useState<IngestionJobDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [nextSources, nextJobs] = await Promise.all([
        listSources(companionId),
        listIngestionJobs(companionId),
      ]);
      setSources(nextSources);
      setJobs(nextJobs);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load sources');
    }
  }, [companionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll while any job is still reading; stop as soon as everything settles.
  useEffect(() => {
    if (!jobs.some(isActive)) return;
    pollRef.current = window.setTimeout(() => void refresh(), POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current !== null) window.clearTimeout(pollRef.current);
    };
  }, [jobs, refresh]);

  const jobBySource = new Map(jobs.map((job) => [job.sourceId, job]));
  const readCount = jobs.filter((job) => job.status === 'done').length;

  return (
    <main className="chat">
      <header>
        <h1>{companionName} · Sources</h1>
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
              {job && (
                <p className="who">
                  {job.status === 'done' && `read · ${job.sectionsTotal} sections`}
                  {job.status === 'failed' && `failed: ${job.error ?? 'unknown error'}`}
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
        <h2>Upload a PDF</h2>
        <input
          type="file"
          accept="application/pdf"
          aria-label="PDF file"
          disabled={busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) {
              void submit(() => uploadPdfSource(companionId, file));
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
