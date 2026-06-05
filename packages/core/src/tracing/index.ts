/**
 * Public surface of the tracing seam (runbook-tracing.md): the TraceSink
 * interface + no-op default, the redaction modes, and deterministic sampling.
 * Core exposes only these; the Langfuse adapter lives in the api package.
 */

export {
  guardedTraceSink,
  noopTraceSink,
  type SpanEnd,
  type SpanHandle,
  type SpanKind,
  type SpanStart,
  type TraceAttributes,
  type TraceContent,
  type TraceHandle,
  type TraceSink,
  type TraceStart,
} from './trace-sink.js';
export { type RedactionMode, scrubContent } from './redaction.js';
export { shouldSample } from './sampling.js';
