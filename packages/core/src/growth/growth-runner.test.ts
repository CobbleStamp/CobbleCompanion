/** Growth runner — coalesces requests, drains serially, survives a throw, stops on close. */

import { describe, expect, it } from 'vitest';
import { GrowthRunner, type GrowthRecomputeTarget } from './growth-runner.js';

const silentLogger = { error: () => {}, warn: () => {}, info: () => {} };

/** A target that records the companionIds it recomputed (and can be made to throw). */
function recordingTarget(throwFor?: string): {
  target: GrowthRecomputeTarget;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    target: {
      async recompute(companionId: string) {
        calls.push(companionId);
        if (companionId === throwFor) {
          throw new Error('boom');
        }
        return undefined;
      },
    },
  };
}

describe('GrowthRunner', () => {
  it('drains a requested recompute and reports idle', async () => {
    const { target, calls } = recordingTarget();
    const runner = new GrowthRunner(target, silentLogger);
    runner.request('c1');
    await runner.whenIdle();
    expect(calls).toEqual(['c1']);
    expect(runner.pending()).toBe(0);
  });

  it('coalesces duplicate in-flight requests for the same companion', async () => {
    const { target, calls } = recordingTarget();
    const runner = new GrowthRunner(target, silentLogger);
    runner.request('c1');
    runner.request('c1'); // coalesced — already queued/in flight
    await runner.whenIdle();
    expect(calls).toEqual(['c1']);
  });

  it('keeps draining after a recompute throws', async () => {
    const { target, calls } = recordingTarget('bad');
    const runner = new GrowthRunner(target, silentLogger);
    runner.request('bad');
    runner.request('good');
    await runner.whenIdle();
    expect(calls).toContain('good');
  });

  it('is a no-op after close (drops quietly)', async () => {
    const { target, calls } = recordingTarget();
    const runner = new GrowthRunner(target, silentLogger);
    await runner.close();
    runner.request('c1');
    await runner.whenIdle();
    expect(calls).toEqual([]);
  });

  it('drops requests over the queue-depth backstop', async () => {
    const { target } = recordingTarget();
    const runner = new GrowthRunner(target, silentLogger, 1);
    runner.request('c1');
    // Cap is 1 and c1 is active; a distinct companion is dropped (logged, retried later).
    runner.request('c2');
    expect(runner.pending()).toBe(1);
    await runner.whenIdle();
  });
});
