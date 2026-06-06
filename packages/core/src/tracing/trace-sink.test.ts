/**
 * The tracing seam's safety net: {@link guardedTraceSink} wraps a sink so a
 * misbehaving adapter can NEVER break a turn — every throw degrades to a no-op
 * and is reported via `onError`. {@link noopTraceSink} is the off-by-default sink
 * whose every method is a silent no-op.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  guardedTraceSink,
  noopTraceSink,
  type SpanEnd,
  type SpanHandle,
  type SpanStart,
  type TraceHandle,
  type TraceSink,
  type TraceStart,
} from './trace-sink.js';

const start: TraceStart = { traceId: 't1', name: 'turn', companionId: 'c1' };
const spanStart: SpanStart = { kind: 'llm_call', name: 'm' };

/** A sink whose `startTrace` always throws. */
const startTraceThrows: TraceSink = {
  startTrace(): TraceHandle {
    throw new Error('startTrace boom');
  },
};

/** A sink whose trace's `startSpan` throws but whose `end` is fine. */
const startSpanThrows: TraceSink = {
  startTrace(): TraceHandle {
    return {
      startSpan(): SpanHandle {
        throw new Error('startSpan boom');
      },
      end: () => {},
    };
  },
};

/** A sink whose span's `end` throws. */
const spanEndThrows: TraceSink = {
  startTrace(): TraceHandle {
    return {
      startSpan(): SpanHandle {
        return {
          end(): void {
            throw new Error('span end boom');
          },
        };
      },
      end: () => {},
    };
  },
};

/** A sink whose trace's `end` throws (its spans are well-behaved). */
const traceEndThrows: TraceSink = {
  startTrace(): TraceHandle {
    return {
      startSpan: (): SpanHandle => ({ end: () => {} }),
      end(): void {
        throw new Error('trace end boom');
      },
    };
  },
};

describe('guardedTraceSink', () => {
  it('does not throw when the underlying startTrace throws, and reports via onError', () => {
    const onError = vi.fn();
    const guarded = guardedTraceSink(startTraceThrows, onError);

    let trace: TraceHandle | undefined;
    expect(() => {
      trace = guarded.startTrace(start);
    }).not.toThrow();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    // A safe no-op handle is still returned so callers can keep tracing.
    expect(trace).toBeDefined();
    expect(() => trace?.startSpan(spanStart)).not.toThrow();
    expect(() => trace?.end()).not.toThrow();
  });

  it('does not throw when the underlying startSpan throws, returning a safe span handle', () => {
    const onError = vi.fn();
    const guarded = guardedTraceSink(startSpanThrows, onError);
    const trace = guarded.startTrace(start);

    let span: SpanHandle | undefined;
    expect(() => {
      span = trace.startSpan(spanStart);
    }).not.toThrow();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(span).toBeDefined();
    expect(() => span?.end()).not.toThrow();
  });

  it('does not throw when a span end throws', () => {
    const onError = vi.fn();
    const guarded = guardedTraceSink(spanEndThrows, onError);
    const span = guarded.startTrace(start).startSpan(spanStart);

    const end: SpanEnd = { attributes: { totalTokens: 1 } };
    expect(() => span.end(end)).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it('does not throw when a trace end throws', () => {
    const onError = vi.fn();
    const guarded = guardedTraceSink(traceEndThrows, onError);
    const trace = guarded.startTrace(start);

    expect(() => trace.end({ error: 'turn failed' })).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it('passes through to a well-behaved sink without invoking onError', () => {
    const onError = vi.fn();
    const ended: string[] = [];
    const inner: TraceSink = {
      startTrace: (): TraceHandle => ({
        startSpan: (): SpanHandle => ({ end: () => ended.push('span') }),
        end: () => ended.push('trace'),
      }),
    };
    const guarded = guardedTraceSink(inner, onError);

    const trace = guarded.startTrace(start);
    trace.startSpan(spanStart).end();
    trace.end();

    expect(ended).toEqual(['span', 'trace']);
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('noopTraceSink', () => {
  it('is a no-op across every method and never throws', () => {
    expect(() => {
      const trace = noopTraceSink.startTrace(start);
      const span = trace.startSpan(spanStart);
      span.end({ attributes: { totalTokens: 0 }, content: { output: '' } });
      trace.end({ error: 'ignored' });
    }).not.toThrow();
  });
});
