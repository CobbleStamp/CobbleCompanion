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
 *   - 'off': send content, but run a defensive PII/secret pass over string
 *     fields (emails, phones, long digit runs, JWTs, Bearer tokens, `sk-`/`pk-`
 *     keys). Best-effort only — NOT anonymization; use only against a trusted /
 *     self-hosted Langfuse.
 *
 * Two kinds of payload flow through a sink, and they are governed differently:
 *   - `content` (prompt messages, model output, tool args/results) — redactable;
 *     gated by {@link scrubContent} per the modes above.
 *   - `attributes` (TraceAttributes) — typed as NON-content metadata (model,
 *     tokens, ids). Kept verbatim even under strict by design; callers must not
 *     put conversational content there. NOT scrubbed — the PII pass would
 *     corrupt legitimate numeric ids/token counts.
 *   - free-form error strings are the exception: they are neither, and provider/
 *     tool errors routinely echo their input (a 400 quoting the prompt, a tool
 *     error quoting its args), so {@link scrubError} runs them through the same
 *     content rules — dropped under strict/metadata_only, PII-scrubbed under off.
 */

import type { TraceContent } from './trace-sink.js';

export type RedactionMode = 'strict' | 'metadata_only' | 'off';

// High-impact secrets are scrubbed FIRST (before the digit pass, which would
// otherwise only partially mangle them and leave the rest readable): JWTs,
// `Bearer <token>` headers, and provider-style API keys (`sk-…`, `pk-…`).
const JWT = /\beyJ[\w-]+\.[\w-]+\.[\w-]+/g;
const BEARER = /\bBearer\s+[\w.+/=-]+/gi;
const API_KEY = /\b[ps]k-[A-Za-z0-9-_]{8,}/g;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const PHONE = /\+?\d[\d ()-]{7,}\d/g;
const LONG_DIGITS = /\b\d{6,}\b/g;
const REDACTED = '[redacted]';
/** Cap exported error strings so a pathological provider error can't bloat a batch. */
const MAX_ERROR_LENGTH = 500;

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

/**
 * Redact a free-form error string per mode. Unlike attributes (trusted, non-
 * content metadata), error strings can echo conversational content, so they
 * follow the same rules as content: dropped under strict/metadata_only (the
 * caller can still record that an error occurred, e.g. an ERROR level, without
 * the message), PII-scrubbed under off. Returns `undefined` when nothing may be
 * sent or when there is no error.
 */
export function scrubError(error: string | undefined, mode: RedactionMode): string | undefined {
  if (error === undefined) {
    return undefined;
  }
  if (mode === 'strict' || mode === 'metadata_only') {
    return undefined;
  }
  const scrubbed = scrubValue(error) as string;
  return scrubbed.length > MAX_ERROR_LENGTH ? `${scrubbed.slice(0, MAX_ERROR_LENGTH)}…` : scrubbed;
}

/** Recursively replace PII-shaped substrings in any string within a value. */
function scrubValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .replace(JWT, REDACTED)
      .replace(BEARER, REDACTED)
      .replace(API_KEY, REDACTED)
      .replace(EMAIL, REDACTED)
      .replace(PHONE, REDACTED)
      .replace(LONG_DIGITS, REDACTED);
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
