/**
 * The `ingest_source` tool (effectful): commit a web page to the companion's
 * long-term semantic memory. This is the propose→approve action of Phase 3 —
 * reading a page (web_fetch) is free, but *remembering* one mutates what the
 * companion is and spends ingestion tokens, so the gate holds it for approval.
 * Run only ever fires post-approval; it mirrors the source-upload enqueue path
 * (create source + job → hand to the background runner).
 */

import type { ToolResult } from '../harness/hooks.js';
import { consoleLogger, type Logger } from '../logging.js';
import type { IngestionRunParams } from '../ingestion/pipeline.js';
import { IngestionQueueFullError } from '../ingestion/runner.js';
import { readHttpUrlArg, readStringArg, type Tool, toolErrorMessage } from './tool.js';

/** The slice of the semantic store this tool needs to register a new source. */
export interface SourceRegistrationPort {
  createSource(
    companionId: string,
    input: { kind: 'link'; title: string; origin: string; rawText: string },
  ): Promise<{ id: string }>;
  createJob(companionId: string, sourceId: string): Promise<{ id: string }>;
}

/** The slice of the ingestion runner this tool needs to start a background read. */
export interface IngestionEnqueuePort {
  enqueue(params: IngestionRunParams): void;
  isFull(): boolean;
}

export interface IngestSourceOptions {
  readonly semantic: SourceRegistrationPort;
  readonly ingestion: IngestionEnqueuePort;
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
      if (options.ingestion.isFull()) {
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
        options.ingestion.enqueue({
          companionId: ctx.companionId,
          ownerId: ctx.ownerId,
          sourceId: source.id,
          jobId: job.id,
          sourceTitle: title ?? url,
          payload: { kind: 'link', url },
        });
        return {
          name: 'ingest_source',
          content: `Started reading ${url} into memory; it will be recallable once done.`,
        };
      } catch (error) {
        const busy = error instanceof IngestionQueueFullError;
        logger.error('ingest_source failed', {
          operation: 'tool.ingest_source',
          companionId: ctx.companionId,
          url,
          error,
        });
        return {
          name: 'ingest_source',
          content: busy
            ? 'Cobble is busy reading other sources right now — try again shortly.'
            : `Error remembering ${url}: ${toolErrorMessage(error)}`,
          isError: true,
        };
      }
    },
  };
}
