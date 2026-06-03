/** Token-usage helpers + the metering gateway wrapper. */

import { describe, expect, it } from 'vitest';
import { FakeLlmGateway } from './llm/fake.js';
import {
  addUsage,
  createUsageAccumulator,
  estimateTokens,
  estimateUsage,
  meteredLlmGateway,
} from './usage.js';

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
});
