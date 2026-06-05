/**
 * The tracing seam (architecture.md §3, runbook-tracing.md). Mirrors the
 * Logger/UsageSink pattern: an injectable sink with a no-op default, so online
 * tracing is OPT-IN and a sink failure can never break a turn. The harness opens
 * one trace per turn and nests spans (assemble_context, llm_call, tool_call); the
 * real adapter (api/tracing/langfuse-sink.ts) applies sampling + redaction and
 * ships to Langfuse. Core depends only on this interface — never on any SDK.
 *
 * All methods are synchronous and MUST NOT throw at the call site: an adapter
 * buffers/flushes off-thread and self-catches (logging.md best-effort philosophy).
 */

/** The span kinds the harness emits within a turn trace. */
export type SpanKind = 'assemble_context' | 'llm_call' | 'tool_call' | 'affect_read';

/** Opaque, redactable payloads (prompt messages, model output, tool args/results). */
export type TraceContent = Readonly<Record<string, unknown>>;

/** Non-content metadata kept even under strict redaction (model, tokens, ids). */
export type TraceAttributes = Readonly<Record<string, unknown>>;

/** Opening a turn trace: a generated id + the companion/owner it belongs to. */
export interface TraceStart {
  readonly traceId: string;
  readonly name: string;
  readonly companionId: string;
  readonly ownerId?: string;
  readonly attributes?: TraceAttributes;
}

/** Opening a span within a trace. */
export interface SpanStart {
  readonly kind: SpanKind;
  readonly name: string;
  readonly attributes?: TraceAttributes;
  readonly content?: TraceContent;
}

/** Closing a span: terminal attributes/content (e.g. usage, output) or an error. */
export interface SpanEnd {
  readonly attributes?: TraceAttributes;
  readonly content?: TraceContent;
  readonly error?: string;
}

/** A live span; `end` is called once. */
export interface SpanHandle {
  end(end?: SpanEnd): void;
}

/** A live trace; opens child spans and is ended once. */
export interface TraceHandle {
  startSpan(span: SpanStart): SpanHandle;
  end(end?: { readonly error?: string }): void;
}

/** Where turn traces are emitted. The default ({@link noopTraceSink}) discards. */
export interface TraceSink {
  startTrace(start: TraceStart): TraceHandle;
}

const noopSpan: SpanHandle = { end: () => {} };
const noopTrace: TraceHandle = { startSpan: () => noopSpan, end: () => {} };

/** The default sink: tracing off. A no-op trace whose spans are no-ops. */
export const noopTraceSink: TraceSink = { startTrace: () => noopTrace };

/**
 * Wrap a sink so a misbehaving adapter can NEVER break a turn: every method is
 * caught (reported via `onError`) and degrades to a no-op. The harness wraps its
 * sink with this, upholding the best-effort guarantee (logging.md) even if an
 * adapter throws synchronously instead of self-catching.
 */
export function guardedTraceSink(sink: TraceSink, onError: (error: unknown) => void): TraceSink {
  function guard<T>(fn: () => T, fallback: T): T {
    try {
      return fn();
    } catch (error) {
      onError(error);
      return fallback;
    }
  }
  return {
    startTrace(start) {
      const trace = guard(() => sink.startTrace(start), noopTrace);
      return {
        startSpan(span) {
          const handle = guard(() => trace.startSpan(span), noopSpan);
          return { end: (end) => guard(() => handle.end(end), undefined) };
        },
        end: (end) => guard(() => trace.end(end), undefined),
      };
    },
  };
}
