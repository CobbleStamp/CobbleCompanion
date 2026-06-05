/**
 * Langfuse Cloud trace adapter (runbook-tracing.md) — the ONLY place that knows
 * the Langfuse wire format. It implements the core `TraceSink` seam, applies
 * deterministic sampling + content redaction (so the privacy controls are
 * enforced before anything leaves the process), buffers a turn's spans, and
 * POSTs them as one batch to Langfuse's public ingestion endpoint on trace end.
 *
 * Best-effort throughout: the POST is fire-and-forget and self-catching, so a
 * tracing failure can never affect a turn (the harness also guards the sink).
 * No Langfuse SDK dependency — a plain authenticated fetch keeps core+api lean.
 *
 * NOTE: the ingestion event shape below targets Langfuse's public `/api/public/
 * ingestion` batch API; validate against a live instance before enabling in
 * production (it is default-OFF, so this never runs unless explicitly turned on).
 */

import { randomUUID } from 'node:crypto';
import {
  type Logger,
  noopTraceSink,
  type RedactionMode,
  scrubContent,
  shouldSample,
  type SpanEnd,
  type SpanStart,
  type TraceContent,
  type TraceSink,
  type TraceStart,
} from '@cobble/core';
import type { AppConfig } from '../config.js';

/** Posts a finished batch of ingestion events. Injected so tests avoid network. */
export type IngestionPoster = (batch: readonly unknown[]) => void;

interface LangfuseOptions {
  readonly host: string;
  readonly publicKey: string;
  readonly secretKey: string;
  readonly sampleRate: number;
  readonly redact: RedactionMode;
  readonly logger: Logger;
  /** Defaults to a fetch-based fire-and-forget poster. */
  readonly poster?: IngestionPoster;
  /** Defaults to wall-clock ISO timestamps. */
  readonly now?: () => string;
}

interface BufferedSpan {
  readonly id: string;
  readonly start: SpanStart;
  readonly startTime: string;
  end?: SpanEnd;
  endTime?: string;
}

/**
 * Build the Langfuse sink from app config. Returns the no-op sink unless tracing
 * is enabled AND keys are present — so a misconfigured deploy traces nothing
 * rather than erroring.
 */
export function createTraceSink(config: AppConfig, logger: Logger): TraceSink {
  if (
    config.tracingProvider !== 'langfuse' ||
    config.langfusePublicKey.length === 0 ||
    config.langfuseSecretKey.length === 0
  ) {
    return noopTraceSink;
  }
  return createLangfuseTraceSink({
    host: config.langfuseHost,
    publicKey: config.langfusePublicKey,
    secretKey: config.langfuseSecretKey,
    sampleRate: config.tracingSampleRate,
    redact: config.tracingRedact,
    logger,
  });
}

/** The Langfuse sink itself (poster + clock injectable for tests). */
export function createLangfuseTraceSink(options: LangfuseOptions): TraceSink {
  const now = options.now ?? (() => new Date().toISOString());
  const post = options.poster ?? defaultPoster(options);

  return {
    startTrace(start: TraceStart) {
      // Whole-trace sampling: drop everything (no half-traces) unless sampled in.
      if (!shouldSample(start.traceId, options.sampleRate)) {
        return noopTrace;
      }
      const spans: BufferedSpan[] = [];
      return {
        startSpan(span: SpanStart) {
          const buffered: BufferedSpan = { id: randomUUID(), start: span, startTime: now() };
          spans.push(buffered);
          return {
            end(end?: SpanEnd) {
              if (end !== undefined) {
                buffered.end = end;
              }
              buffered.endTime = now();
            },
          };
        },
        end(end?: { readonly error?: string }) {
          const batch = buildBatch(start, spans, options.redact, now(), end?.error);
          post(batch);
        },
      };
    },
  };
}

const noopSpanHandle = { end: () => {} };
const noopTrace = { startSpan: () => noopSpanHandle, end: () => {} };

/**
 * Build the ingestion batch: one trace-create event + one observation per span,
 * with content redacted per mode (strict ⇒ no input/output, only metadata).
 * Pure — the unit-testable core of the adapter.
 */
export function buildBatch(
  start: TraceStart,
  spans: readonly BufferedSpan[],
  redact: RedactionMode,
  endTime: string,
  traceError?: string,
): readonly unknown[] {
  const trace = {
    id: randomUUID(),
    type: 'trace-create',
    timestamp: endTime,
    body: {
      id: start.traceId,
      name: start.name,
      ...(start.ownerId ? { userId: start.ownerId } : {}),
      metadata: { companionId: start.companionId, ...start.attributes },
      ...(traceError ? { level: 'ERROR', statusMessage: traceError } : {}),
    },
  };
  const observations = spans.map((span) => {
    const input = pickContent(scrubContent(span.start.content, redact), ['messages', 'args']);
    const output = pickContent(scrubContent(span.end?.content, redact), ['output', 'result']);
    return {
      id: randomUUID(),
      type: 'observation-create',
      timestamp: span.endTime ?? span.startTime,
      body: {
        id: span.id,
        traceId: start.traceId,
        type: span.start.kind === 'llm_call' ? 'GENERATION' : 'SPAN',
        name: span.start.name,
        startTime: span.startTime,
        ...(span.endTime ? { endTime: span.endTime } : {}),
        metadata: { kind: span.start.kind, ...span.start.attributes, ...span.end?.attributes },
        ...(input !== undefined ? { input } : {}),
        ...(output !== undefined ? { output } : {}),
        ...(span.end?.error ? { level: 'ERROR', statusMessage: span.end.error } : {}),
      },
    };
  });
  return [trace, ...observations];
}

/** Take the first present key from redacted content (undefined when redacted out). */
function pickContent(content: TraceContent | undefined, keys: readonly string[]): unknown {
  if (content === undefined) return undefined;
  for (const key of keys) {
    if (key in content) return content[key];
  }
  return undefined;
}

/** The default fire-and-forget poster: authenticated fetch, self-catching. */
function defaultPoster(options: LangfuseOptions): IngestionPoster {
  const auth = Buffer.from(`${options.publicKey}:${options.secretKey}`).toString('base64');
  const url = `${options.host.replace(/\/$/, '')}/api/public/ingestion`;
  return (batch) => {
    void fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Basic ${auth}` },
      body: JSON.stringify({ batch }),
    }).catch((error: unknown) => {
      options.logger.error('failed to ship trace to Langfuse', {
        operation: 'tracing.langfuse.post',
        error,
      });
    });
  };
}
