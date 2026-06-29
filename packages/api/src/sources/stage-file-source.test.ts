/**
 * `stageAndEnqueueFileSource` domain-service unit tests (the use case behind WS
 * `sources.file`). Exercised with fakes, no transport: the ordered validation gates,
 * the success-path side-effects (source + job via `finishEnqueue`, ingest requested,
 * best-effort transcript turns), each typed failure kind, and two contracts that are
 * easy to regress — the deferred companion resolution (the thunk must not run until the
 * companion-independent gates pass) and the best-effort transcript swallow (a failed
 * `appendMessage` is logged, never failing the upload that is already enqueued).
 */

import { IngestionQueueFullError, type UploadStagingStore } from '@cobble/core';
import type { MessageDto } from '@cobble/shared';
import { describe, expect, it, vi } from 'vitest';
import { FILE_TOO_LARGE, UNSUPPORTED_FILE_TYPE } from './file-format.js';
import {
  stageAndEnqueueFileSource,
  type StageFileSourceDeps,
  type StageFileSourceInput,
} from './stage-file-source.js';

const silentLogger = { error: () => undefined, warn: () => undefined, info: () => undefined };

const OWNER = 'o1';
const COMPANION = 'c1';
const PREFIX = 'staging';

/** A staging key of the canonical `<prefix>/<ownerId>/<uuid>__<kind>` layout. */
function uploadKey(kind: string, ownerId: string = OWNER): string {
  return `${PREFIX}/${ownerId}/11111111-1111-1111-1111-111111111111__${kind}`;
}

/** First bytes that pass the magic-byte gate for a given kind. */
function magicBytesFor(kind: string): Uint8Array {
  switch (kind) {
    case 'pdf':
      return new TextEncoder().encode('%PDF-1.7\n');
    case 'docx':
    case 'pptx':
      return new TextEncoder().encode('PK');
    default:
      // txt/md: any non-binary text passes.
      return new TextEncoder().encode('hello world');
  }
}

function messageDto(content: string): MessageDto {
  return {
    id: 'row',
    companionId: COMPANION,
    role: 'user',
    content,
    kind: 'message',
    sourceId: 's1',
    createdAt: new Date(0).toISOString(),
  };
}

/**
 * Build deps with spies. By default the staged object exists, is under the cap, and its
 * first bytes match `kind` — i.e. every gate passes. Override `headByteSize`/`peekBytes`
 * to drive a specific failure, or `appendMessageImpl` to make the transcript write throw.
 */
function buildDeps(opts: {
  kind: string;
  headByteSize?: number | null;
  peekBytes?: Uint8Array | null;
  ingestionMaxBytes?: number;
  isFull?: boolean;
  appendMessageImpl?: StageFileSourceDeps['memory']['appendMessage'];
}): {
  deps: StageFileSourceDeps;
  spies: {
    createSource: ReturnType<typeof vi.fn>;
    createJob: ReturnType<typeof vi.fn>;
    request: ReturnType<typeof vi.fn>;
    appendMessage: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
} {
  const headByteSize = opts.headByteSize === undefined ? 1234 : opts.headByteSize;
  const peekBytes = opts.peekBytes === undefined ? magicBytesFor(opts.kind) : opts.peekBytes;

  const createSource = vi.fn(async (companionId: string, input: Record<string, unknown>) => ({
    id: 's1',
    companionId,
    kind: input.kind,
    title: input.title,
    origin: (input.origin as string | undefined) ?? null,
    byteSize: (input.byteSize as number | undefined) ?? null,
    createdAt: new Date(0).toISOString(),
  }));
  const createJob = vi.fn(async (companionId: string, sourceId: string) => ({
    id: 'j1',
    companionId,
    sourceId,
    status: 'queued' as const,
    sectionsTotal: 0,
    sectionsDone: 0,
    error: null,
  }));
  const request = vi.fn(() => undefined);
  const appendMessage =
    opts.appendMessageImpl !== undefined
      ? vi.fn(opts.appendMessageImpl)
      : vi.fn(async (_companionId: string, _role: string, content: string) => messageDto(content));
  const error = vi.fn(() => undefined);

  const staging: Pick<UploadStagingStore, 'head' | 'peek'> = {
    head: async () => (headByteSize === null ? null : { byteSize: headByteSize }),
    peek: async () => peekBytes,
  };

  const deps: StageFileSourceDeps = {
    semantic: { createSource, createJob } as unknown as StageFileSourceDeps['semantic'],
    staging,
    ingest: {
      isFull: async () => opts.isFull ?? false,
      request,
    } as unknown as StageFileSourceDeps['ingest'],
    memory: { appendMessage } as unknown as StageFileSourceDeps['memory'],
    config: {
      ingestionMaxBytes: opts.ingestionMaxBytes ?? 10_000_000,
      uploadStaging: { prefix: PREFIX } as StageFileSourceDeps['config']['uploadStaging'],
    },
    logger: { ...silentLogger, error },
  };
  return { deps, spies: { createSource, createJob, request, appendMessage, error } };
}

function inputFor(kind: string, filename: string, over: Partial<StageFileSourceInput> = {}) {
  return { ownerId: OWNER, uploadId: uploadKey(kind), filename, ...over };
}

describe('stageAndEnqueueFileSource', () => {
  it('creates the source + job, requests the ingest, appends transcript turns, and returns ok', async () => {
    const { deps, spies } = buildDeps({ kind: 'pdf' });
    const resolveCompanionId = vi.fn(async () => COMPANION);

    const result = await stageAndEnqueueFileSource(
      deps,
      inputFor('pdf', 'report.pdf'),
      resolveCompanionId,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source.id).toBe('s1');
    expect(result.job.id).toBe('j1');
    expect(result.messages).toHaveLength(2);
    // The side-effects fired: source + job created, ingest requested, transcript written.
    expect(spies.createSource).toHaveBeenCalledOnce();
    expect(spies.createJob).toHaveBeenCalledWith(COMPANION, 's1');
    expect(spies.request).toHaveBeenCalledOnce();
    expect(spies.appendMessage).toHaveBeenCalledTimes(2);
    // The companion was resolved (and awaited) on the happy path.
    expect(resolveCompanionId).toHaveBeenCalledOnce();
  });

  it('rejects an upload key that does not parse / belongs to another owner (not_found)', async () => {
    const { deps, spies } = buildDeps({ kind: 'pdf' });
    const resolveCompanionId = vi.fn(async () => COMPANION);

    // A key minted for a different owner never authorizes to OWNER.
    const result = await stageAndEnqueueFileSource(
      deps,
      { ownerId: OWNER, uploadId: uploadKey('pdf', 'someone-else'), filename: 'report.pdf' },
      resolveCompanionId,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('not_found');
    expect(result.failure.message).toBe('upload not found');
    expect(resolveCompanionId).not.toHaveBeenCalled();
    expect(spies.createSource).not.toHaveBeenCalled();
  });

  it('rejects an unsupported file type (bad_params) without resolving the companion', async () => {
    const { deps, spies } = buildDeps({ kind: 'pdf' });
    const resolveCompanionId = vi.fn(async () => COMPANION);

    // `.exe` has no upload kind, so `uploadKindForFilename` returns null.
    const result = await stageAndEnqueueFileSource(
      deps,
      inputFor('pdf', 'malware.exe'),
      resolveCompanionId,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('bad_params');
    expect(result.failure.message).toBe(UNSUPPORTED_FILE_TYPE);
    // CRITICAL: a companion-independent gate failed, so the thunk must not run.
    expect(resolveCompanionId).not.toHaveBeenCalled();
    expect(spies.createSource).not.toHaveBeenCalled();
  });

  it('rejects when the filename kind disagrees with the key kind (bad_params)', async () => {
    const { deps } = buildDeps({ kind: 'pdf' });
    const resolveCompanionId = vi.fn(async () => COMPANION);

    // Key was minted for a pdf but the filename claims .txt — kind mismatch.
    const result = await stageAndEnqueueFileSource(
      deps,
      inputFor('pdf', 'notes.txt'),
      resolveCompanionId,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('bad_params');
    expect(result.failure.message).toBe(UNSUPPORTED_FILE_TYPE);
    expect(resolveCompanionId).not.toHaveBeenCalled();
  });

  it('rejects when the ingestion queue is full (queue_full)', async () => {
    const { deps, spies } = buildDeps({ kind: 'pdf', isFull: true });
    const resolveCompanionId = vi.fn(async () => COMPANION);

    const result = await stageAndEnqueueFileSource(
      deps,
      inputFor('pdf', 'report.pdf'),
      resolveCompanionId,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('queue_full');
    expect(result.failure.message).toBe(new IngestionQueueFullError().message);
    expect(resolveCompanionId).not.toHaveBeenCalled();
    expect(spies.createSource).not.toHaveBeenCalled();
  });

  it('rejects an oversize upload (bad_params) without resolving the companion', async () => {
    const { deps } = buildDeps({ kind: 'pdf', headByteSize: 50, ingestionMaxBytes: 10 });
    const resolveCompanionId = vi.fn(async () => COMPANION);

    const result = await stageAndEnqueueFileSource(
      deps,
      inputFor('pdf', 'big.pdf'),
      resolveCompanionId,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('bad_params');
    expect(result.failure.message).toBe(FILE_TOO_LARGE);
    // CRITICAL: still a companion-independent gate — the thunk must not run.
    expect(resolveCompanionId).not.toHaveBeenCalled();
  });

  it('rejects when the magic bytes do not match the declared kind (bad_params)', async () => {
    // A pdf key, but the peeked bytes are not a `%PDF-` header.
    const { deps } = buildDeps({
      kind: 'pdf',
      peekBytes: new TextEncoder().encode('this is not a pdf'),
    });
    const resolveCompanionId = vi.fn(async () => COMPANION);

    const result = await stageAndEnqueueFileSource(
      deps,
      inputFor('pdf', 'report.pdf'),
      resolveCompanionId,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('bad_params');
    expect(result.failure.message).toBe('the uploaded file is not a valid PDF');
    expect(resolveCompanionId).not.toHaveBeenCalled();
  });

  it('still returns ok and logs when the transcript append fails (best-effort swallow)', async () => {
    const { deps, spies } = buildDeps({
      kind: 'pdf',
      appendMessageImpl: async () => {
        throw new Error('transcript db down');
      },
    });
    const resolveCompanionId = vi.fn(async () => COMPANION);

    const result = await stageAndEnqueueFileSource(
      deps,
      inputFor('pdf', 'report.pdf'),
      resolveCompanionId,
    );

    // The read is already enqueued; a transcript hiccup must not fail the upload.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.messages).toEqual([]);
    expect(spies.createSource).toHaveBeenCalledOnce();
    expect(spies.request).toHaveBeenCalledOnce();
    // The failure was logged at the documented operation tag.
    expect(spies.error).toHaveBeenCalledOnce();
    expect(spies.error.mock.calls[0]?.[1]).toMatchObject({
      operation: 'sources.file.appendTranscript',
    });
  });
});
