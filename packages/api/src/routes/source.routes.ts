/**
 * Source routes — feeding the companion's knowledge base (Phase 1). Uploads
 * create the source row + ingestion job and enqueue the off-request-path
 * runner, returning 202 immediately; reading happens in the background and
 * progress is polled via the ingestion route. All routes are owner-scoped.
 */

import {
  createLinkSourceSchema,
  createNoteSourceSchema,
  fileSourceAcknowledgement,
  uploadKindForFilename,
  type IngestionJobDto,
  type MessageDto,
  type SectionDto,
  type SourceDto,
  type UploadSourceKind,
} from '@cobble/shared';
import {
  IngestionQueueFullError,
  looksBinary,
  type IngestionPayload,
  type JobRecord,
  type SectionRecord,
  type SourceRecord,
} from '@cobble/core';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import type { RequireAuth } from '../auth-guard.js';

/** An Error the central handler renders as a 429 (statusCode < 500 → message passes through). */
function tooManyRequests(message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode: 429 });
}

/**
 * Confirm the bytes match the kind the extension claimed, so a renamed file
 * (e.g. an executable called `.docx`) is rejected at the door rather than
 * handed to a parser. Returns a user-safe message on mismatch, else null.
 * - PDF: starts with `%PDF-`.
 * - docx/pptx: OOXML is a zip, so it starts with the `PK` local-file signature
 *   (the extension is the only discriminator between the zip-family formats —
 *   the parser confirms the inner structure).
 * - txt/md: no signature; reject only if it looks binary (NUL byte without a
 *   recognized Unicode BOM — shared with the link channel via `looksBinary`).
 */
function magicByteError(kind: UploadSourceKind, bytes: Buffer): string | null {
  const startsWith = (signature: string): boolean =>
    bytes.subarray(0, signature.length).toString('latin1') === signature;
  switch (kind) {
    case 'pdf':
      return startsWith('%PDF-') ? null : 'the uploaded file is not a valid PDF';
    case 'docx':
    case 'pptx':
      return startsWith('PK') ? null : `the uploaded file is not a valid ${kind} document`;
    case 'txt':
    case 'md':
      return looksBinary(bytes) ? 'the uploaded file does not look like text' : null;
  }
}

/** Strip the matched extension to form a display title; fall back if empty. */
function titleFromFilename(filename: string, kind: UploadSourceKind): string {
  const base = filename.replace(/\.[^./\\]+$/, '').trim();
  return base.length > 0 ? base : `Untitled ${kind.toUpperCase()}`;
}

interface CompanionParams {
  readonly companionId: string;
}

interface SourceParams extends CompanionParams {
  readonly sourceId: string;
}

/**
 * Mounts the owner-scoped HTTP surface for feeding a companion's knowledge
 * base — accepting file/note/link sources and exposing source listing, drill-in,
 * and ingestion progress. Accountable for request validation, ownership checks,
 * and handing accepted uploads to the background runner; the reading itself is
 * not its concern.
 */
export function registerSourceRoutes(
  app: FastifyInstance,
  deps: AppDeps,
  requireAuth: RequireAuth,
): void {
  const { identity, memory, semantic, ingestion, logger } = deps;
  // Intake routes share the auth preHandler; over-cap uploads are accepted and
  // deferred by the pipeline rather than rejected up front (architecture.md §4.8).
  const ingestPreHandlers = [requireAuth];

  /** Create the source + job and hand the payload to the background runner. */
  async function enqueue(
    companionId: string,
    ownerId: string,
    input: { kind: SourceDto['kind']; title: string; origin?: string; byteSize?: number },
    payload: IngestionPayload,
  ): Promise<{ source: SourceDto; job: IngestionJobDto }> {
    // Backstop against unbounded queue growth. Reject before any DB write on
    // the common path; the runner's own cap is the hard invariant for the rare
    // race where concurrent requests pass this check before enqueuing.
    if (ingestion.isFull()) {
      throw tooManyRequests(new IngestionQueueFullError().message);
    }
    const source = await semantic.createSource(companionId, {
      kind: input.kind,
      title: input.title,
      ...(input.origin !== undefined ? { origin: input.origin } : {}),
      // The canonical text is extracted off the request path by the pipeline.
      rawText: '',
      ...(input.byteSize !== undefined ? { byteSize: input.byteSize } : {}),
    });
    const job = await semantic.createJob(companionId, source.id);
    try {
      ingestion.enqueue({
        companionId,
        ownerId,
        sourceId: source.id,
        jobId: job.id,
        sourceTitle: source.title,
        payload,
      });
    } catch (error) {
      if (error instanceof IngestionQueueFullError) {
        // Don't leave a stuck job behind: record the decline as data.
        await semantic.updateJob(job.id, { status: 'failed', error: error.message });
        throw tooManyRequests(error.message);
      }
      throw error;
    }
    return { source: toSourceDto(source), job: toJobDto(job) };
  }

  // Upload a document file (PDF/txt/md/docx/pptx; multipart). Returns 202:
  // reading happens in the background. Format is detected from the filename and
  // confirmed against magic bytes (architecture.md §4.8) — never trusted from
  // the client-declared content type alone.
  app.post(
    '/companions/:companionId/sources/file',
    { preHandler: ingestPreHandlers },
    async (request, reply) => {
      const { companionId } = request.params as CompanionParams;
      const companion = await identity.getCompanion(companionId, request.userId!);
      if (!companion) {
        return reply.code(404).send({ error: 'companion not found' });
      }
      const file = await request.file();
      if (!file) {
        return reply.code(400).send({ error: 'a file is required' });
      }
      const filename = file.filename ?? '';
      const kind = uploadKindForFilename(filename);
      if (!kind) {
        return reply
          .code(400)
          .send({ error: 'unsupported file type — upload a PDF, .txt, .md, .docx, or .pptx' });
      }
      const bytes = await file.toBuffer();
      if (bytes.length === 0) {
        return reply.code(400).send({ error: 'the uploaded file is empty' });
      }
      const magicError = magicByteError(kind, bytes);
      if (magicError) {
        return reply.code(400).send({ error: magicError });
      }
      const result = await enqueue(
        companion.id,
        request.userId!,
        {
          kind,
          title: titleFromFilename(filename, kind),
          origin: filename,
          byteSize: bytes.length,
        },
        { kind, bytes: new Uint8Array(bytes) },
      );
      // Record the attachment + acknowledgement as real transcript turns so they
      // survive a reload (architecture.md §4.7). Best-effort: the file is already
      // being read, so a transcript-write hiccup must not fail the upload — it is
      // logged and the upload still returns 202 (failures are data).
      let messages: MessageDto[] = [];
      try {
        const attachment = await memory.appendMessage(
          companion.id,
          'user',
          filename,
          result.source.id,
        );
        const acknowledgement = await memory.appendMessage(
          companion.id,
          'assistant',
          fileSourceAcknowledgement(filename),
          result.source.id,
        );
        messages = [attachment, acknowledgement];
      } catch (error) {
        logger.error('failed to append upload turns to transcript', {
          operation: 'sources.file.appendTranscript',
          companionId: companion.id,
          sourceId: result.source.id,
          error,
        });
      }
      return reply.code(202).send({ ...result, messages });
    },
  );

  // Add a plain-text note.
  app.post(
    '/companions/:companionId/sources/note',
    { preHandler: ingestPreHandlers },
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
        request.userId!,
        { kind: 'note', title: parsed.data.title, byteSize: parsed.data.text.length },
        { kind: 'note', text: parsed.data.text },
      );
      return reply.code(202).send(result);
    },
  );

  // Add a web link; the article is fetched and read in the background.
  app.post(
    '/companions/:companionId/sources/link',
    { preHandler: ingestPreHandlers },
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
        request.userId!,
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

  // Delete a source (and its job + sections). Lets a user prune the queue — e.g.
  // a job parked at the daily cap they no longer want to wait on.
  app.delete(
    '/companions/:companionId/sources/:sourceId',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { companionId, sourceId } = request.params as SourceParams;
      const companion = await identity.getCompanion(companionId, request.userId!);
      if (!companion) {
        return reply.code(404).send({ error: 'companion not found' });
      }
      const deleted = await semantic.deleteSource(companion.id, sourceId);
      if (!deleted) {
        return reply.code(404).send({ error: 'source not found' });
      }
      return reply.code(204).send();
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
