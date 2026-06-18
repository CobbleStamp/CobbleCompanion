/**
 * Source file upload (Phase 1; the one HTTP route that outlives the WS cutover —
 * deliver-scalability.md D-A's two-part upload). Bulk bytes belong in a multipart
 * body, not a JSON WS frame, so the upload stays HTTP: it stages the bytes durably
 * and enqueues the off-request-path `ingest` job, returning 202 immediately. Note
 * and link sources, listing, drill-in, and ingestion progress are WS methods
 * (`sources.*`, `ingestion.list`). Owner-scoped.
 */

import {
  fileSourceAcknowledgement,
  uploadKindForFilename,
  type IngestionJobDto,
  type MessageDto,
  type SourceDto,
  type UploadSourceKind,
} from '@cobble/shared';
import {
  IngestionQueueFullError,
  ingestionPayloadBytes,
  looksBinary,
  type IngestionPayload,
  type JobRecord,
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

/**
 * Mount the multipart file-upload route. Accountable for request validation,
 * ownership checks, and handing accepted uploads to the background `ingest` job;
 * the reading itself is not its concern.
 */
export function registerSourceRoutes(
  app: FastifyInstance,
  deps: AppDeps,
  requireAuth: RequireAuth,
): void {
  const { identity, memory, semantic, staging, ingest, logger } = deps;

  /**
   * Create the source + job, stage the payload bytes durably, and enqueue the
   * `ingest` job that reads them on any node (deliver-scalability.md §6 D-A).
   * Backpressure is fleet-wide (pending `ingest` job count), checked before any
   * write; the queue is the hard invariant for the rare race past this check.
   */
  async function enqueue(
    companionId: string,
    ownerId: string,
    input: { kind: SourceDto['kind']; title: string; origin?: string; byteSize?: number },
    payload: IngestionPayload,
  ): Promise<{ source: SourceDto; job: IngestionJobDto }> {
    if (await ingest.isFull()) {
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
    const { kind, bytes } = ingestionPayloadBytes(payload);
    const { id: uploadId } = await staging.stage({ ownerId, kind, bytes });
    ingest.request({ companionId, sourceId: source.id, jobId: job.id, uploadId });
    return { source: toSourceDto(source), job: toJobDto(job) };
  }

  // Upload a document file (PDF/txt/md/docx/pptx; multipart). Returns 202:
  // reading happens in the background. Format is detected from the filename and
  // confirmed against magic bytes (architecture.md §4.8) — never trusted from
  // the client-declared content type alone.
  app.post(
    '/companions/:companionId/sources/file',
    { preHandler: requireAuth },
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
        const attachment = await memory.appendMessage(companion.id, 'user', filename, {
          sourceId: result.source.id,
        });
        const acknowledgement = await memory.appendMessage(
          companion.id,
          'assistant',
          fileSourceAcknowledgement(filename),
          { sourceId: result.source.id },
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
