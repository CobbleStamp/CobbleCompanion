/**
 * Content redaction for traces (runbook-tracing.md). Because traces can ship to
 * a third party (Langfuse Cloud), conversational content (user text, retrieved
 * memory, replies, tool args) must be controllable. Pure + unit-tested so "what
 * leaves the box" is provable.
 *
 *   - 'strict' (default): drop ALL content — keep only structure/metadata
 *     (span names, timings, model, tokens, ids). Zero conversational content
 *     leaves the process.
 *   - 'metadata_only': same as strict today (kept distinct so a future
 *     hash-content mode can slot between without a config change).
 *   - 'off': send content, but run a defensive PII pass over string fields.
 */

import type { TraceContent } from './trace-sink.js';

export type RedactionMode = 'strict' | 'metadata_only' | 'off';

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const PHONE = /\+?\d[\d ()-]{7,}\d/g;
const LONG_DIGITS = /\b\d{6,}\b/g;
const REDACTED = '[redacted]';

/**
 * Apply a redaction mode to a span's content. Returns `undefined` when nothing
 * may be sent (strict/metadata_only) — adapters then send attributes only.
 */
export function scrubContent(
  content: TraceContent | undefined,
  mode: RedactionMode,
): TraceContent | undefined {
  if (content === undefined) {
    return undefined;
  }
  if (mode === 'strict' || mode === 'metadata_only') {
    return undefined;
  }
  return scrubValue(content) as TraceContent;
}

/** Recursively replace PII-shaped substrings in any string within a value. */
function scrubValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(EMAIL, REDACTED).replace(PHONE, REDACTED).replace(LONG_DIGITS, REDACTED);
  }
  if (Array.isArray(value)) {
    return value.map(scrubValue);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, inner]) => [
        key,
        scrubValue(inner),
      ]),
    );
  }
  return value;
}
