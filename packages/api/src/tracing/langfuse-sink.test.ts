/**
 * The Langfuse adapter: sampling gate (whole-trace), redaction applied before
 * anything would leave the process, and the ingestion batch shape — all via an
 * injected poster + clock, so no network or live model is touched.
 */

import type { Logger } from '@cobble/core';
import { describe, expect, it } from 'vitest';
import { testConfig } from '../test/helpers.js';
import { createLangfuseTraceSink, createTraceSink } from './langfuse-sink.js';

const silent: Logger = { error: () => {}, warn: () => {}, info: () => {} };

function capturing() {
  const batches: (readonly unknown[])[] = [];
  const sink = createLangfuseTraceSink({
    host: 'https://lf.test',
    publicKey: 'pk',
    secretKey: 'sk',
    sampleRate: 1,
    redact: 'strict',
    logger: silent,
    poster: (batch) => batches.push(batch),
    now: () => '2026-06-05T00:00:00.000Z',
  });
  return { sink, batches };
}

describe('createTraceSink (factory)', () => {
  it('returns the no-op sink when tracing is off', () => {
    const sink = createTraceSink(testConfig, silent);
    const trace = sink.startTrace({ traceId: 't', name: 'turn', companionId: 'c' });
    // No throw, no-op handles.
    expect(() => trace.startSpan({ kind: 'llm_call', name: 'm' }).end()).not.toThrow();
  });

  it('returns the no-op sink when langfuse is selected but keys are missing', () => {
    const sink = createTraceSink({ ...testConfig, tracingProvider: 'langfuse' }, silent);
    expect(() =>
      sink.startTrace({ traceId: 't', name: 'turn', companionId: 'c' }).end(),
    ).not.toThrow();
  });
});

describe('Langfuse sink', () => {
  it('drops the whole trace when not sampled', () => {
    const batches: (readonly unknown[])[] = [];
    const sink = createLangfuseTraceSink({
      host: 'https://lf.test',
      publicKey: 'pk',
      secretKey: 'sk',
      sampleRate: 0, // sample nothing
      redact: 'off',
      logger: silent,
      poster: (batch) => batches.push(batch),
    });
    const trace = sink.startTrace({ traceId: 't', name: 'turn', companionId: 'c' });
    trace.startSpan({ kind: 'llm_call', name: 'm' }).end();
    trace.end();
    expect(batches).toHaveLength(0);
  });

  it('posts a trace + observation batch when sampled', () => {
    const { sink, batches } = capturing();
    const trace = sink.startTrace({
      traceId: 't1',
      name: 'turn',
      companionId: 'c1',
      ownerId: 'u1',
    });
    trace
      .startSpan({ kind: 'llm_call', name: 'model-x', attributes: { promptId: 'persona' } })
      .end({ attributes: { totalTokens: 42 } });
    trace.end();

    expect(batches).toHaveLength(1);
    const batch = batches[0]!;
    const traceEvent = batch[0] as { type: string; body: { id: string; userId: string } };
    expect(traceEvent.type).toBe('trace-create');
    expect(traceEvent.body.id).toBe('t1');
    expect(traceEvent.body.userId).toBe('u1');
    const obs = batch[1] as {
      type: string;
      body: { type: string; metadata: Record<string, unknown> };
    };
    expect(obs.type).toBe('observation-create');
    expect(obs.body.type).toBe('GENERATION'); // llm_call → generation
    expect(obs.body.metadata).toMatchObject({ promptId: 'persona', totalTokens: 42 });
  });

  it('omits content under strict redaction but keeps it (scrubbed) under off', () => {
    // strict: capturing() uses redact: 'strict'
    const strict = capturing();
    const t1 = strict.sink.startTrace({ traceId: 's', name: 'turn', companionId: 'c' });
    t1.startSpan({ kind: 'llm_call', name: 'm', content: { messages: 'secret prompt' } }).end({
      content: { output: 'secret reply' },
    });
    t1.end();
    const strictObs = strict.batches[0]![1] as { body: Record<string, unknown> };
    expect(strictObs.body.input).toBeUndefined();
    expect(strictObs.body.output).toBeUndefined();

    // off: content flows through (with PII scrubbed elsewhere).
    const batches: (readonly unknown[])[] = [];
    const offSink = createLangfuseTraceSink({
      host: 'https://lf.test',
      publicKey: 'pk',
      secretKey: 'sk',
      sampleRate: 1,
      redact: 'off',
      logger: silent,
      poster: (batch) => batches.push(batch),
      now: () => '2026-06-05T00:00:00.000Z',
    });
    const t2 = offSink.startTrace({ traceId: 'o', name: 'turn', companionId: 'c' });
    t2.startSpan({ kind: 'llm_call', name: 'm', content: { messages: 'visible prompt' } }).end({
      content: { output: 'visible reply' },
    });
    t2.end();
    const offObs = batches[0]![1] as { body: Record<string, unknown> };
    expect(offObs.body.input).toBe('visible prompt');
    expect(offObs.body.output).toBe('visible reply');
  });
});
