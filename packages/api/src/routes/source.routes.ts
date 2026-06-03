/**
 * Source routes — feeding the companion's knowledge base (Phase 1). Uploads
 * create the source row + ingestion job and enqueue the off-request-path
 * runner, returning 202 immediately; reading happens in the background and
 * progress is polled via the ingestion route. All routes are owner-scoped.
 */

import {
  createLinkSourceSchema,
  createNoteSourceSchema,
  type IngestionJobDto,
  type SectionDto,
  type SourceDto,
} from '@cobble/shared';
import type { IngestionPayload, JobRecord, SectionRecord, SourceRecord } from '@cobble/core';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import type { RequireAuth } from '../auth-guard.js';

interface CompanionParams {
  readonly companionId: string;
}

interface SourceParams extends CompanionParams {
  readonly sourceId: string;
}

export function registerSourceRoutes(
  app: FastifyInstance,
  deps: AppDeps,
  requireAuth: RequireAuth,
): void {
  const { identity, semantic, ingestion } = deps;

  /** Create the source + job and hand the payload to the background runner. */
  async function enqueue(
    companionId: string,
    input: { kind: SourceDto['kind']; title: string; origin?: string; byteSize?: number },
    payload: IngestionPayload,
  ): Promise<{ source: SourceDto; job: IngestionJobDto }> {
    const source = await semantic.createSource(companionId, {
      kind: input.kind,
      title: input.title,
      ...(input.origin !== undefined ? { origin: input.origin } : {}),
      // The canonical text is extracted off the request path by the pipeline.
      rawText: '',
      ...(input.byteSize !== undefined ? { byteSize: input.byteSize } : {}),
    });
    const job = await semantic.createJob(companionId, source.id);
    ingestion.enqueue({
      companionId,
      sourceId: source.id,
      jobId: job.id,
      sourceTitle: source.title,
      payload,
    });
    return { source: toSourceDto(source), job: toJobDto(job) };
  }

  // Upload a PDF (multipart). Returns 202: reading happens in the background.
  app.post(
    '/companions/:companionId/sources/pdf',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { companionId } = request.params as CompanionParams;
      const companion = await identity.getCompanion(companionId, request.userId!);
      if (!companion) {
        return reply.code(404).send({ error: 'companion not found' });
      }
      const file = await request.file();
      if (!file) {
        return reply.code(400).send({ error: 'a PDF file is required' });
      }
      const bytes = await file.toBuffer();
      if (bytes.length === 0) {
        return reply.code(400).send({ error: 'the uploaded file is empty' });
      }
      // Reject obviously-wrong uploads early: a PDF starts with "%PDF-".
      if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
        return reply.code(400).send({ error: 'the uploaded file is not a PDF' });
      }
      const title = file.filename?.replace(/\.pdf$/i, '') || 'Untitled PDF';
      const result = await enqueue(
        companion.id,
        { kind: 'pdf', title, origin: file.filename, byteSize: bytes.length },
        { kind: 'pdf', bytes: new Uint8Array(bytes) },
      );
      return reply.code(202).send(result);
    },
  );

  // Add a plain-text note.
  app.post(
    '/companions/:companionId/sources/note',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { companionId } = request.params as CompanionParams;
      const parsed = createNoteSourceSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'a note title and text are required' });
      }
      const companion = await identity.getCompanion(companionId, request.userId!);
      if (!companion) {
        return reply.code(404).send({ error: 'companion not found' });
      }
      const result = await enqueue(
        companion.id,
        { kind: 'note', title: parsed.data.title, byteSize: parsed.data.text.length },
        { kind: 'note', text: parsed.data.text },
      );
      return reply.code(202).send(result);
    },
  );

  // Add a web link; the article is fetched and read in the background.
  app.post(
    '/companions/:companionId/sources/link',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { companionId } = request.params as CompanionParams;
      const parsed = createLinkSourceSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'a valid URL is required' });
      }
      const companion = await identity.getCompanion(companionId, request.userId!);
      if (!companion) {
        return reply.code(404).send({ error: 'companion not found' });
      }
      const result = await enqueue(
        companion.id,
        { kind: 'link', title: parsed.data.title ?? parsed.data.url, origin: parsed.data.url },
        { kind: 'link', url: parsed.data.url },
      );
      return reply.code(202).send(result);
    },
  );

  // List the companion's sources.
  app.get(
    '/companions/:companionId/sources',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { companionId } = request.params as CompanionParams;
      const companion = await identity.getCompanion(companionId, request.userId!);
      if (!companion) {
        return reply.code(404).send({ error: 'companion not found' });
      }
      const sources = await semantic.listSources(companion.id);
      return reply.send({ sources: sources.map(toSourceDto) });
    },
  );

  // Source drill-in: metadata + its sections (verbatim text + provenance).
  app.get(
    '/companions/:companionId/sources/:sourceId',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { companionId, sourceId } = request.params as SourceParams;
      const companion = await identity.getCompanion(companionId, request.userId!);
      if (!companion) {
        return reply.code(404).send({ error: 'companion not found' });
      }
      const source = (await semantic.listSources(companion.id)).find((s) => s.id === sourceId);
      if (!source) {
        return reply.code(404).send({ error: 'source not found' });
      }
      const sections = await semantic.listSectionsBySource(companion.id, sourceId);
      return reply.send({ source: toSourceDto(source), sections: sections.map(toSectionDto) });
    },
  );

  // Ingestion progress for all sources ("Cobble has read N of M").
  app.get(
    '/companions/:companionId/ingestion',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { companionId } = request.params as CompanionParams;
      const companion = await identity.getCompanion(companionId, request.userId!);
      if (!companion) {
        return reply.code(404).send({ error: 'companion not found' });
      }
      const jobs = await semantic.listJobs(companion.id);
      return reply.send({ jobs: jobs.map(toJobDto) });
    },
  );
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
