/** Deterministic, whole-trace sampling at the configured rate. */

import { describe, expect, it } from 'vitest';
import { shouldSample } from './sampling.js';

describe('shouldSample', () => {
  it('keeps nothing at rate 0 and everything at rate 1', () => {
    expect(shouldSample('any-id', 0)).toBe(false);
    expect(shouldSample('any-id', 1)).toBe(true);
  });

  it('is deterministic for a given id + rate', () => {
    expect(shouldSample('trace-123', 0.5)).toBe(shouldSample('trace-123', 0.5));
  });

  it('samples roughly the configured fraction across many ids', () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `trace-${i}`);
    const kept = ids.filter((id) => shouldSample(id, 0.25)).length;
    // Wide band — this asserts the bucket is spread, not a precise rate.
    expect(kept).toBeGreaterThan(2000 * 0.15);
    expect(kept).toBeLessThan(2000 * 0.35);
  });
});
