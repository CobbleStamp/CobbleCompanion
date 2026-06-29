import {
  IngestionQueueFullError,
  parseUploadKey,
  type IngestWorkRequester,
  type Logger,
  type MemoryStore,
  type SemanticMemoryStore,
  type UploadStagingStore,
} from '@cobble/core';
import {
  fileSourceAcknowledgement,
  uploadKindForFilename,
  type IngestionJobDto,
  type MessageDto,
  type SourceDto,
} from '@cobble/shared';
import type { AppConfig } from '../config.js';
import { toJobDto, toSourceDto } from '../ws/methods/dto.js';
import {
  FILE_TOO_LARGE,
  magicByteError,
  MAGIC_PEEK_BYTES,
  titleFromFilename,
  UNSUPPORTED_FILE_TYPE,
} from './file-format.js';

/**
 * The collaborators a file-source enqueue needs, narrowed to exactly the methods it
 * uses (Interface Segregation): the staging store it validates the uploaded object on,
 * the semantic store it creates the source + job in, the ingest requester it enqueues
 * through, the memory store for the best-effort transcript turns, and the config fields
 * that bound the upload. `AppDeps` structurally satisfies this (with `logger` set to the
 * per-connection logger), so the WS handler builds it from its own deps.
 */
export interface StageFileSourceDeps {
  readonly semantic: Pick<SemanticMemoryStore, 'createSource' | 'createJob'>;
  readonly staging: Pick<UploadStagingStore, 'head' | 'peek'>;
  readonly ingest: Pick<IngestWorkRequester, 'isFull' | 'request'>;
  readonly memory: Pick<MemoryStore, 'appendMessage'>;
  readonly config: Pick<AppConfig, 'ingestionMaxBytes' | 'uploadStaging'>;
  readonly logger: Logger;
}

export interface StageFileSourceInput {
  /** The user who owns the staged object — the upload-key authorization subject. */
  readonly ownerId: string;
  /** The presigned-upload key the client PUT its bytes to (carries owner + kind). */
  readonly uploadId: string;
  readonly filename: string;
  /** Optional explicit title; falls back to one derived from the filename. */
  readonly title?: string;
}

/**
 * A typed rejection mapped 1:1 onto the WS error the handler throws — `kind` picks the
 * error class, `message` is the client-safe text (preserved byte-for-byte from the
 * former inline handler). Keeping the transport error classes out of the domain.
 */
export interface StageFileSourceFailure {
  readonly kind: 'not_found' | 'bad_params' | 'queue_full';
  readonly message: string;
}

/**
 * The outcome of an enqueue attempt. **Total** — never throws for an expected validation
 * failure, so the handler has a single `if (!result.ok)` branch (the Result convention,
 * mirroring confirm-proposal.ts / discord-token-mint.ts).
 */
export type StageFileSourceResult =
  | {
      readonly ok: true;
      readonly source: SourceDto;
      readonly job: IngestionJobDto;
      readonly messages: readonly MessageDto[];
    }
  | { readonly ok: false; readonly failure: StageFileSourceFailure };

/**
 * Validate a staged file upload and enqueue it for ingestion (staging-object-storage.md
 * §3.1). The gates, in order, exactly as the former inline handler ran them:
 *  1. Authorize via the upload key — a forged/foreign key never parses to this owner.
 *  2. Confirm the filename's kind matches the kind baked into the key (never trust input).
 *  3. Reject when the ingestion queue is full.
 *  4. Validate the staged object without downloading it: existence + size cap, then a
 *     ranged magic-byte peek (the bytes must match the kind the extension claimed).
 *  5. Resolve the embodied companion (`resolveCompanionId`, supplied by the transport so
 *     this stays framework-free) only now — the checks above are companion-independent,
 *     so resolution happens at the same point the former handler did it.
 *  6. Create the source + job, request the ingest, and append the attachment chip +
 *     acknowledgement as transcript turns (best-effort: the read is already enqueued, so a
 *     transcript hiccup is logged, never failing the upload — failures are data, §4.7).
 */
export async function stageAndEnqueueFileSource(
  deps: StageFileSourceDeps,
  input: StageFileSourceInput,
  resolveCompanionId: () => Promise<string>,
): Promise<StageFileSourceResult> {
  const { semantic, staging, ingest, memory, config, logger } = deps;
  const { ownerId, uploadId, filename, title } = input;

  // The key is the authorization + the kind: a forged/foreign key never parses to this
  // owner, and the kind is read back from it, never trusted from input.
  const parsed = parseUploadKey(config.uploadStaging.prefix, uploadId);
  if (!parsed || parsed.ownerId !== ownerId) {
    return { ok: false, failure: { kind: 'not_found', message: 'upload not found' } };
  }
  const fileKind = uploadKindForFilename(filename);
  if (!fileKind || fileKind !== parsed.kind) {
    return { ok: false, failure: { kind: 'bad_params', message: UNSUPPORTED_FILE_TYPE } };
  }
  if (await ingest.isFull()) {
    return {
      ok: false,
      failure: { kind: 'queue_full', message: new IngestionQueueFullError().message },
    };
  }
  // Validate the staged object without downloading it: existence + size cap, then a
  // ranged peek for the magic-byte gate (staging-object-storage.md §3.1).
  const head = await staging.head(uploadId);
  if (!head || head.byteSize === 0) {
    return {
      ok: false,
      failure: {
        kind: 'bad_params',
        message: 'the upload was not found or is empty — please re-upload',
      },
    };
  }
  if (head.byteSize > config.ingestionMaxBytes) {
    return { ok: false, failure: { kind: 'bad_params', message: FILE_TOO_LARGE } };
  }
  const peeked = await staging.peek(uploadId, MAGIC_PEEK_BYTES);
  const magic = peeked
    ? magicByteError(parsed.kind, peeked)
    : 'the upload was not found — please re-upload';
  if (magic) {
    return { ok: false, failure: { kind: 'bad_params', message: magic } };
  }

  const companionId = await resolveCompanionId();
  const { source, job } = await finishEnqueue(
    { semantic, ingest },
    companionId,
    {
      kind: parsed.kind,
      title: title ?? titleFromFilename(filename, fileKind),
      origin: filename,
      byteSize: head.byteSize,
    },
    uploadId,
  );

  // Record the attachment chip + acknowledgement as real transcript turns so they
  // survive a reload. Best-effort: the read is already enqueued, so a transcript hiccup
  // must not fail the upload — it is logged (failures are data).
  let messages: readonly MessageDto[] = [];
  try {
    const attachment = await memory.appendMessage(companionId, 'user', filename, {
      sourceId: source.id,
    });
    const acknowledgement = await memory.appendMessage(
      companionId,
      'assistant',
      fileSourceAcknowledgement(filename),
      { sourceId: source.id },
    );
    messages = [attachment, acknowledgement];
  } catch (error) {
    logger.error('failed to append upload turns to transcript', {
      operation: 'sources.file.appendTranscript',
      companionId,
      sourceId: source.id,
      error,
    });
  }
  return { ok: true, source, job, messages };
}

/**
 * Create the source + job for already-staged bytes and request the `ingest` job, mapping
 * to DTOs. Shared by the file path above and the note/link enqueue in the WS handler —
 * the one place a staged upload becomes a tracked source.
 */
export async function finishEnqueue(
  deps: Pick<StageFileSourceDeps, 'semantic' | 'ingest'>,
  companionId: string,
  input: { kind: SourceDto['kind']; title: string; origin?: string; byteSize?: number },
  uploadId: string,
): Promise<{ source: SourceDto; job: IngestionJobDto }> {
  const { semantic, ingest } = deps;
  const source = await semantic.createSource(companionId, {
    kind: input.kind,
    title: input.title,
    ...(input.origin !== undefined ? { origin: input.origin } : {}),
    rawText: '',
    ...(input.byteSize !== undefined ? { byteSize: input.byteSize } : {}),
  });
  const job = await semantic.createJob(companionId, source.id);
  ingest.request({ companionId, sourceId: source.id, jobId: job.id, uploadId });
  return { source: toSourceDto(source), job: toJobDto(job) };
}
