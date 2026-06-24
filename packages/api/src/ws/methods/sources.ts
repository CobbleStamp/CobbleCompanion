import {
  IngestionQueueFullError,
  ingestionPayloadBytes,
  parseUploadKey,
  type IngestionPayload,
  type JobRecord,
  type SectionRecord,
  type SourceRecord,
} from '@cobble/core';
import {
  createFileSourceSchema,
  createLinkSourceSchema,
  createNoteSourceSchema,
  fileSourceAcknowledgement,
  requestFileUploadSchema,
  uploadKindForFilename,
  type IngestionJobDto,
  type MessageDto,
  type SectionDto,
  type SourceDto,
  type UploadSlotDto,
} from '@cobble/shared';
import { z } from 'zod';
import type { AppDeps } from '../../app.js';
import {
  contentTypeForKind,
  MAGIC_PEEK_BYTES,
  magicByteError,
  titleFromFilename,
} from '../../sources/file-format.js';
import type { WsMethods } from '../dispatch.js';
import {
  BadParamsError,
  companionOf,
  NotFoundError,
  parseParams,
  QueueFullError,
} from './helpers.js';

const sourceIdParams = z.object({ sourceId: z.string().uuid() });

const UNSUPPORTED_FILE_TYPE = 'unsupported file type — upload a PDF, .txt, .md, .docx, or .pptx';

const FILE_TOO_LARGE = 'the uploaded file is too large';

/**
 * Source intake + browse. File uploads are a two-step presigned flow
 * (staging-object-storage.md): `sources.requestFileUpload` issues a direct-upload
 * slot, the client PUTs the bytes to it, then `sources.file` validates the staged
 * object (head + ranged magic-byte peek) and enqueues. note/link stage their small
 * payload server-side and enqueue; the rest read.
 */
export function sourceMethods(deps: AppDeps): WsMethods {
  const { semantic, staging, ingest, embodiment, memory, config } = deps;

  /** Create the source + job and enqueue the `ingest` job for already-staged bytes. */
  async function finishEnqueue(
    companionId: string,
    input: { kind: SourceDto['kind']; title: string; origin?: string; byteSize?: number },
    uploadId: string,
  ): Promise<{ source: SourceDto; job: IngestionJobDto }> {
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

  /** Stage a small in-hand payload (note/link) server-side, then enqueue it. */
  async function enqueueSource(
    companionId: string,
    ownerId: string,
    input: { kind: SourceDto['kind']; title: string; origin?: string; byteSize?: number },
    payload: IngestionPayload,
  ): Promise<{ source: SourceDto; job: IngestionJobDto }> {
    if (await ingest.isFull()) {
      // Re-tag the core queue-full error as a `code`-carrying WS error so its
      // client-safe "busy reading" message survives the dispatcher's allowlist
      // (which forwards messages only from tagged errors — dispatch.ts).
      throw new QueueFullError(new IngestionQueueFullError().message);
    }
    const { kind, bytes } = ingestionPayloadBytes(payload);
    const { id: uploadId } = await staging.stage({ ownerId, kind, bytes });
    return finishEnqueue(companionId, input, uploadId);
  }

  return {
    'sources.requestFileUpload': async (ctx, params): Promise<UploadSlotDto> => {
      const { filename, byteSize } = parseParams(
        requestFileUploadSchema,
        params,
        'a filename and byteSize are required',
      );
      const kind = uploadKindForFilename(filename);
      if (!kind) {
        throw new BadParamsError(UNSUPPORTED_FILE_TYPE);
      }
      // Reject oversized uploads before issuing the slot — the declared size is then
      // pinned into the slot (S3 signs it into the presigned PUT), so the body cannot
      // exceed the cap. The post-upload head check in `sources.file` stays as a
      // backstop for backends that don't enforce size at write time.
      if (byteSize > config.ingestionMaxBytes) {
        throw new BadParamsError(FILE_TOO_LARGE);
      }
      const slot = await staging.createUploadSlot({
        ownerId: ctx.userId,
        kind,
        contentType: contentTypeForKind(kind),
        maxBytes: config.ingestionMaxBytes,
        byteSize,
      });
      return {
        uploadId: slot.uploadId,
        url: slot.url,
        method: slot.method,
        ...(slot.headers ? { headers: slot.headers } : {}),
        expiresAt: slot.expiresAt,
      };
    },

    'sources.file': async (ctx, params) => {
      const { uploadId, filename, title } = parseParams(
        createFileSourceSchema,
        params,
        'an uploadId and filename are required',
      );
      // The key is the authorization + the kind: a forged/foreign key never parses
      // to this owner, and the kind is read back from it, never trusted from input.
      const parsed = parseUploadKey(config.uploadStaging.prefix, uploadId);
      if (!parsed || parsed.ownerId !== ctx.userId) {
        throw new NotFoundError('upload not found');
      }
      const fileKind = uploadKindForFilename(filename);
      if (!fileKind || fileKind !== parsed.kind) {
        throw new BadParamsError(UNSUPPORTED_FILE_TYPE);
      }
      if (await ingest.isFull()) {
        throw new QueueFullError(new IngestionQueueFullError().message);
      }
      // Validate the staged object without downloading it: existence + size cap,
      // then a ranged peek for the magic-byte gate (staging-object-storage.md §3.1).
      const head = await staging.head(uploadId);
      if (!head || head.byteSize === 0) {
        throw new BadParamsError('the upload was not found or is empty — please re-upload');
      }
      if (head.byteSize > config.ingestionMaxBytes) {
        throw new BadParamsError(FILE_TOO_LARGE);
      }
      const peeked = await staging.peek(uploadId, MAGIC_PEEK_BYTES);
      const magic = peeked
        ? magicByteError(parsed.kind, peeked)
        : 'the upload was not found — please re-upload';
      if (magic) {
        throw new BadParamsError(magic);
      }
      const companionId = await companionOf(embodiment, ctx);
      const { source, job } = await finishEnqueue(
        companionId,
        {
          kind: parsed.kind,
          title: title ?? titleFromFilename(filename, fileKind),
          origin: filename,
          byteSize: head.byteSize,
        },
        uploadId,
      );
      // Record the attachment chip + acknowledgement as real transcript turns so
      // they survive a reload. Best-effort: the read is already enqueued, so a
      // transcript hiccup must not fail the upload — it is logged (failures are data).
      let messages: MessageDto[] = [];
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
        ctx.logger.error('failed to append upload turns to transcript', {
          operation: 'sources.file.appendTranscript',
          companionId,
          sourceId: source.id,
          error,
        });
      }
      return { source, job, messages };
    },

    'sources.note': async (ctx, params) => {
      const { title, text } = parseParams(
        createNoteSourceSchema,
        params,
        'a note title and text are required',
      );
      const companionId = await companionOf(embodiment, ctx);
      return enqueueSource(
        companionId,
        ctx.userId,
        { kind: 'note', title, byteSize: text.length },
        { kind: 'note', text },
      );
    },

    'sources.link': async (ctx, params) => {
      const { url, title } = parseParams(createLinkSourceSchema, params, 'a valid URL is required');
      const companionId = await companionOf(embodiment, ctx);
      return enqueueSource(
        companionId,
        ctx.userId,
        { kind: 'link', title: title ?? url, origin: url },
        { kind: 'link', url },
      );
    },

    'sources.list': async (ctx) => {
      const companionId = await companionOf(embodiment, ctx);
      const sources = await semantic.listSources(companionId);
      return { sources: sources.map(toSourceDto) };
    },

    'sources.get': async (ctx, params) => {
      const { sourceId } = parseParams(sourceIdParams, params, 'a source id is required');
      const companionId = await companionOf(embodiment, ctx);
      const source = (await semantic.listSources(companionId)).find((s) => s.id === sourceId);
      if (!source) {
        throw new NotFoundError('source not found');
      }
      const sections = await semantic.listSectionsBySource(companionId, sourceId);
      return { source: toSourceDto(source), sections: sections.map(toSectionDto) };
    },

    'sources.delete': async (ctx, params) => {
      const { sourceId } = parseParams(sourceIdParams, params, 'a source id is required');
      const companionId = await companionOf(embodiment, ctx);
      const deleted = await semantic.deleteSource(companionId, sourceId);
      if (!deleted) {
        throw new NotFoundError('source not found');
      }
      return { ok: true };
    },

    'ingestion.list': async (ctx) => {
      const companionId = await companionOf(embodiment, ctx);
      const jobs = await semantic.listJobs(companionId);
      return { jobs: jobs.map(toJobDto) };
    },
  };
}

function toSourceDto(source: SourceRecord): SourceDto {
  return {
    id: source.id,
    kind: source.kind,
    title: source.title,
    origin: source.origin,
    byteSize: source.byteSize,
    createdAt: source.createdAt,
  };
}

function toJobDto(job: JobRecord): IngestionJobDto {
  return {
    id: job.id,
    sourceId: job.sourceId,
    status: job.status,
    sectionsTotal: job.sectionsTotal,
    sectionsDone: job.sectionsDone,
    error: job.error,
  };
}

function toSectionDto(section: SectionRecord): SectionDto {
  return {
    id: section.id,
    sourceId: section.sourceId,
    chapterTitle: section.chapterTitle,
    topicTitle: section.topicTitle,
    originalText: section.originalText,
    contextHeader: section.contextHeader,
    paraStart: section.paraStart,
    paraEnd: section.paraEnd,
    pageStart: section.pageStart,
    pageEnd: section.pageEnd,
    ord: section.ord,
  };
}
