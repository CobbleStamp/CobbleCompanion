/**
 * The filesystem-backend upload sink (staging-object-storage.md §5). File uploads
 * are a presigned, direct-to-backend flow: the client requests a slot
 * (`sources.requestFileUpload`), PUTs the bytes to the slot URL, then enqueues
 * (`sources.file`). For the S3 backend the PUT goes straight to S3 and this route
 * is NOT mounted; for the filesystem backend the slot URL points here, so this
 * route is the local equivalent of a presigned PUT — owner-scoped, size-capped.
 */

import { FilesystemUploadStagingStore, parseUploadKey } from '@cobble/core';
import { UPLOAD_FORMATS } from '@cobble/shared';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import type { RequireAuth } from '../auth-guard.js';

interface UploadIdParams {
  readonly uploadId: string;
}

/**
 * Mount the filesystem upload route when (and only when) staging is filesystem-
 * backed. The route writes the PUT body at the slot's key after confirming the key
 * parses and belongs to the caller; the S3 backend has no such route (the browser
 * PUTs to S3 directly via the presigned URL).
 */
export function registerSourceRoutes(
  app: FastifyInstance,
  deps: AppDeps,
  requireAuth: RequireAuth,
): void {
  const { staging, config, logger } = deps;
  if (!(staging instanceof FilesystemUploadStagingStore)) {
    return;
  }
  const store = staging;
  const prefix = config.uploadStaging.prefix;
  const maxBytes = config.ingestionMaxBytes;

  // The PUT carries raw bytes, not JSON. Accept the upload content types (plus a
  // generic fallback) as a buffer, capped at the ingestion size limit.
  const uploadContentTypes = [
    ...new Set(UPLOAD_FORMATS.flatMap((format) => format.mimeTypes)),
    'application/octet-stream',
  ];
  app.addContentTypeParser(
    uploadContentTypes,
    { parseAs: 'buffer', bodyLimit: maxBytes + 1024 },
    (_request, body, done) => done(null, body),
  );

  app.put<{ Params: UploadIdParams }>(
    '/uploads/local/:uploadId',
    { preHandler: requireAuth },
    async (request, reply) => {
      const uploadId = decodeURIComponent(request.params.uploadId);
      const parsed = parseUploadKey(prefix, uploadId);
      // A key that does not parse or names another owner is indistinguishable from
      // "not found" to the caller — never leak which.
      if (!parsed || parsed.ownerId !== request.userId) {
        return reply.code(404).send({ error: 'upload slot not found' });
      }
      const body = request.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return reply.code(400).send({ error: 'a non-empty body is required' });
      }
      if (body.length > maxBytes) {
        return reply.code(413).send({ error: 'the uploaded file is too large' });
      }
      try {
        await store.writeAt(uploadId, new Uint8Array(body));
      } catch (error) {
        logger.error('failed to write staged upload', {
          operation: 'uploads.local.put',
          ownerId: request.userId,
          error,
        });
        return reply.code(500).send({ error: 'could not store the upload' });
      }
      return reply.code(204).send();
    },
  );
}
