/** Token-usage helpers + the metering gateway wrapper. */

import { describe, expect, it } from 'vitest';
import { FakeLlmGateway } from './llm/fake.js';
import type { LlmGateway, StreamResult } from './llm/gateway.js';
import {
  addUsage,
  createUsageAccumulator,
  estimateTokens,
  estimateUsage,
  meteredLlmGateway,
  ZERO_USAGE,
} from './usage.js';

/** A gateway whose stream records when its body unwinds — proves the wrapper
 * forwards termination (so the connection is cancelled) on an early abort. */
class CancelTrackingGateway implements LlmGateway {
  cancelled = false;
  async *stream(): AsyncGenerator<string, StreamResult, void> {
    try {
      yield 'aaaa';
      yield 'bbbb';
      return { usage: ZERO_USAGE, toolCalls: [] };
    } finally {
      this.cancelled = true;
    }
  }
}

/** A gateway that drops mid-stream — a provider/infra fault (a thrown error). */
class FaultingGateway implements LlmGateway {
  async *stream(): AsyncGenerator<string, StreamResult, void> {
    yield 'partial';
    throw new Error('network drop');
  }
}

describe('estimateTokens', () => {
  it('rounds up at ~4 chars/token', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
});

describe('estimateUsage', () => {
  it('splits prompt vs completion and totals them', () => {
    expect(estimateUsage('abcdefgh', 'abcd')).toEqual({
      promptTokens: 2,
      completionTokens: 1,
      totalTokens: 3,
    });
  });
});

describe('addUsage', () => {
  it('sums component-wise', () => {
    expect(
      addUsage(
        { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
        { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      ),
    ).toEqual({ promptTokens: 11, completionTokens: 22, totalTokens: 33 });
  });
});

describe('meteredLlmGateway', () => {
  it('deposits the stream usage into the accumulator even when the consumer uses for-await', async () => {
    const acc = createUsageAccumulator();
    const metered = meteredLlmGateway(new FakeLlmGateway(['Hel', 'lo']), acc.sink);

    // Drain with for-await — which discards the generator's return value.
    let text = '';
    for await (const delta of metered.stream({
      messages: [{ role: 'user', content: 'hi there' }],
      model: 'm',
    })) {
      text += delta;
    }

    expect(text).toBe('Hello');
    // prompt "hi there" (8 → 2) + completion "Hello" (5 → 2).
    expect(acc.total()).toEqual({ promptTokens: 2, completionTokens: 2, totalTokens: 4 });
  });

  it('accumulates across multiple streamed calls', async () => {
    const acc = createUsageAccumulator();
    const metered = meteredLlmGateway(new FakeLlmGateway(['x']), acc.sink);
    for (let i = 0; i < 3; i++) {
      // eslint-disable-next-line no-empty
      for await (const _ of metered.stream({
        messages: [{ role: 'user', content: 'q' }],
        model: 'm',
      })) {
      }
    }
    // Three calls, each prompt "q" (1 → 1) + completion "x" (1 → 1) = total 2.
    expect(acc.total().totalTokens).toBe(6);
  });

  it('meters an estimate of consumed tokens when the consumer aborts mid-stream', async () => {
    const acc = createUsageAccumulator();
    const inner = new CancelTrackingGateway();
    const metered = meteredLlmGateway(inner, acc.sink);

    // Consume the first chunk, then disconnect before the usage frame — the
    // for-await `break` calls `.return()` on the metered generator.
    for await (const _delta of metered.stream({
      messages: [{ role: 'user', content: 'hi there' }],
      model: 'm',
    })) {
      break;
    }

    // The inner stream was terminated (its connection cancelled)…
    expect(inner.cancelled).toBe(true);
    // …and the tokens already streamed are billed, not silently lost: prompt
    // "hi there" (8 → 2) + the consumed "aaaa" (4 → 1).
    expect(acc.total()).toEqual({ promptTokens: 2, completionTokens: 1, totalTokens: 3 });
  });

  it('leaves a provider/infra fault unmetered and rethrows it', async () => {
    const acc = createUsageAccumulator();
    const metered = meteredLlmGateway(new FaultingGateway(), acc.sink);

    await expect(
      (async () => {
        // eslint-disable-next-line no-empty
        for await (const _delta of metered.stream({
          messages: [{ role: 'user', content: 'q' }],
          model: 'm',
        })) {
        }
      })(),
    ).rejects.toThrow('network drop');

    // Our own failure — the user is not billed for the broken turn.
    expect(acc.total()).toEqual(ZERO_USAGE);
  });
});
