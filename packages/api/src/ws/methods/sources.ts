import {
  IngestionQueueFullError,
  ingestionPayloadBytes,
  type IngestionPayload,
  type JobRecord,
  type SectionRecord,
  type SourceRecord,
} from '@cobble/core';
import {
  createLinkSourceSchema,
  createNoteSourceSchema,
  type IngestionJobDto,
  type SectionDto,
  type SourceDto,
} from '@cobble/shared';
import { z } from 'zod';
import type { AppDeps } from '../../app.js';
import type { WsMethods } from '../dispatch.js';
import { companionOf, NotFoundError, parseParams } from './helpers.js';

const sourceIdParams = z.object({ sourceId: z.string().min(1) });

/**
 * Source intake + browse (mirrors source.routes, minus the multipart file upload —
 * that stays an HTTP endpoint, the two-part split of D-A). note/link stage their
 * payload and enqueue an `ingest` job; the rest read.
 */
export function sourceMethods(deps: AppDeps): WsMethods {
  const { semantic, staging, ingest, embodiment } = deps;

  /** Create the source + job, stage the payload, enqueue the `ingest` job. */
  async function enqueueSource(
    companionId: string,
    ownerId: string,
    input: { kind: SourceDto['kind']; title: string; origin?: string; byteSize?: number },
    payload: IngestionPayload,
  ): Promise<{ source: SourceDto; job: IngestionJobDto }> {
    if (await ingest.isFull()) {
      throw new IngestionQueueFullError();
    }
    const source = await semantic.createSource(companionId, {
      kind: input.kind,
      title: input.title,
      ...(input.origin !== undefined ? { origin: input.origin } : {}),
      rawText: '',
      ...(input.byteSize !== undefined ? { byteSize: input.byteSize } : {}),
    });
    const job = await semantic.createJob(companionId, source.id);
    const { kind, bytes } = ingestionPayloadBytes(payload);
    const { id: uploadId } = await staging.stage({ ownerId, kind, bytes });
    ingest.request({ companionId, sourceId: source.id, jobId: job.id, uploadId });
    return { source: toSourceDto(source), job: toJobDto(job) };
  }

  return {
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
