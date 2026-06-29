import {
  IngestionQueueFullError,
  ingestionPayloadBytes,
  type IngestionPayload,
} from '@cobble/core';
import {
  createFileSourceSchema,
  createLinkSourceSchema,
  createNoteSourceSchema,
  requestFileUploadSchema,
  uploadKindForFilename,
  type IngestionJobDto,
  type SourceDto,
  type UploadSlotDto,
} from '@cobble/shared';
import { z } from 'zod';
import type { AppDeps } from '../../app.js';
import {
  contentTypeForKind,
  FILE_TOO_LARGE,
  UNSUPPORTED_FILE_TYPE,
} from '../../sources/file-format.js';
import { finishEnqueue, stageAndEnqueueFileSource } from '../../sources/stage-file-source.js';
import type { WsMethods } from '../dispatch.js';
import { toJobDto, toSectionDto, toSourceDto } from './dto.js';
import {
  BadParamsError,
  companionOf,
  NotFoundError,
  parseParams,
  QueueFullError,
} from './helpers.js';

const sourceIdParams = z.object({ sourceId: z.string().uuid() });

/**
 * Source intake + browse. File uploads are a two-step presigned flow
 * (staging-object-storage.md): `sources.requestFileUpload` issues a direct-upload
 * slot, the client PUTs the bytes to it, then `sources.file` validates the staged
 * object (head + ranged magic-byte peek) and enqueues — that use case is the
 * `stageAndEnqueueFileSource` domain service. note/link stage their small payload
 * server-side and enqueue; the rest read.
 */
export function sourceMethods(deps: AppDeps): WsMethods {
  const { semantic, staging, ingest, embodiment, memory, config } = deps;

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
    return finishEnqueue({ semantic, ingest }, companionId, input, uploadId);
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
      // The validate-stage-enqueue use case is a transport-free domain service; the
      // handler maps its typed failure to the matching WS error and resolves the embodied
      // companion at the same point the service reaches the enqueue (companion-independent
      // validation runs first — preserving the former order on a non-embodied caller).
      const result = await stageAndEnqueueFileSource(
        { semantic, staging, ingest, memory, config, logger: ctx.logger },
        { ownerId: ctx.userId, uploadId, filename, ...(title !== undefined ? { title } : {}) },
        () => companionOf(embodiment, ctx),
      );
      if (!result.ok) {
        const { kind, message } = result.failure;
        throw kind === 'not_found'
          ? new NotFoundError(message)
          : kind === 'queue_full'
            ? new QueueFullError(message)
            : new BadParamsError(message);
      }
      return { source: result.source, job: result.job, messages: result.messages };
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
