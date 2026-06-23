/**
 * The `ingest_source` tool (effectful): commit a web page to the companion's
 * long-term semantic memory. This is the propose→approve action of Phase 3 —
 * reading a page (web_fetch) is free, but *remembering* one mutates what the
 * companion is and spends ingestion tokens, so the gate holds it for approval.
 * Run only ever fires post-approval; it mirrors the source-upload enqueue path
 * (create source + job → stage the link → enqueue an `ingest` job).
 */

import type { SourceKind } from '@cobble/shared';
import type { ToolResult } from '../harness/hooks.js';
import { consoleLogger, type Logger } from '../logging.js';
import { ingestionPayloadBytes } from '../ingestion/ingest-job.js';
import type { IngestWorkRequester } from '../jobs/job-processor.js';
import { readHttpUrlArg, readStringArg, type Tool, toolErrorMessage } from './tool.js';

/** The slice of the semantic store this tool needs to register a new source. */
export interface SourceRegistrationPort {
  createSource(
    companionId: string,
    input: { kind: 'link'; title: string; origin: string; rawText: string },
  ): Promise<{ id: string }>;
  createJob(companionId: string, sourceId: string): Promise<{ id: string }>;
}

/** The slice of the staging store this tool needs to make the link bytes durable. */
export interface UploadStagingPort {
  stage(params: { ownerId: string; kind: SourceKind; bytes: Uint8Array }): Promise<{ id: string }>;
}

/** The slice of the ingest requester this tool needs (enqueue + backpressure). */
export type IngestEnqueuePort = Pick<IngestWorkRequester, 'request' | 'isFull'>;

export interface IngestSourceOptions {
  readonly semantic: SourceRegistrationPort;
  readonly ingest: IngestEnqueuePort;
  readonly staging: UploadStagingPort;
  readonly logger?: Logger;
}

export function createIngestSourceTool(options: IngestSourceOptions): Tool {
  const logger = options.logger ?? consoleLogger;
  return {
    name: 'ingest_source',
    description:
      "Read a web page into the companion's long-term memory so it is remembered and " +
      'recallable later. This commits the source — propose it for the user to approve.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The absolute http(s) URL to remember.' },
        title: { type: 'string', description: 'A short human title for the source (optional).' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    effectful: true,
    proposalSummary(args): string {
      const url = readHttpUrlArg(args, 'url');
      return url ? `Read ${url} into long-term memory` : 'Read a page into long-term memory';
    },
    async run(rawArgs, ctx): Promise<ToolResult> {
      const url = readHttpUrlArg(rawArgs, 'url');
      if (url === null) {
        return {
          name: 'ingest_source',
          content: 'Error: ingest_source needs a valid "url".',
          isError: true,
        };
      }
      const title = readStringArg(rawArgs, 'title') ?? undefined;
      if (await options.ingest.isFull()) {
        return {
          name: 'ingest_source',
          content: 'Cobble is busy reading other sources right now — try again shortly.',
          isError: true,
        };
      }
      try {
        const source = await options.semantic.createSource(ctx.companionId, {
          kind: 'link',
          title: title ?? url,
          origin: url,
          rawText: '',
        });
        const job = await options.semantic.createJob(ctx.companionId, source.id);
        // Stage the link durably (uniform with file uploads), then enqueue the
        // `ingest` job that reads it on any node (deliver-scalability.md §6 D-A).
        const { kind, bytes } = ingestionPayloadBytes({ kind: 'link', url });
        const { id: uploadId } = await options.staging.stage({ ownerId: ctx.ownerId, kind, bytes });
        options.ingest.request({
          companionId: ctx.companionId,
          sourceId: source.id,
          jobId: job.id,
          uploadId,
        });
        return {
          name: 'ingest_source',
          content: `Started reading ${url} into memory; it will be recallable once done.`,
        };
      } catch (error) {
        logger.error('ingest_source failed', {
          operation: 'tool.ingest_source',
          companionId: ctx.companionId,
          url,
          error,
        });
        return {
          name: 'ingest_source',
          content: `Error remembering ${url}: ${toolErrorMessage(error)}`,
          isError: true,
        };
      }
    },
  };
}
