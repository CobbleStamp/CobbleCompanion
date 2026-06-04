/**
 * Tests for the consolidation runner: coalesces per companion, drains serially,
 * caps the queue, and isolates one bad run from the rest. The target is a
 * controllable fake so timing (in-flight coalescing) is deterministic.
 */

import { describe, expect, it, vi } from 'vitest';
import { ConsolidationRunner, type ConsolidationTarget } from './consolidation-runner.js';

const logger = { error: vi.fn(), info: vi.fn() };

/** Let queued microtasks (drain loop advancing to the next run) settle. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** A target whose runs block until released, so we can hold one in flight. */
class GatedTarget implements ConsolidationTarget {
  readonly calls: string[] = [];
  private gates: Array<() => void> = [];
  /** Once open, current AND future runs resolve immediately (drains to completion). */
  private open = false;

  async consolidate(companionId: string): Promise<void> {
    this.calls.push(companionId);
    if (this.open) {
      return;
    }
    await new Promise<void>((resolve) => this.gates.push(resolve));
  }

  /** Release the oldest still-blocked run. */
  releaseOne(): void {
    const gate = this.gates.shift();
    gate?.();
  }

  /** Open the gate for all runs (current + future) so the queue drains fully. */
  releaseAll(): void {
    this.open = true;
    while (this.gates.length > 0) {
      this.releaseOne();
    }
  }
}

describe('ConsolidationRunner', () => {
  it('coalesces a companion already in flight (no duplicate run)', async () => {
    const target = new GatedTarget();
    const runner = new ConsolidationRunner(target, logger);

    runner.request('c1'); // starts draining, c1 now in flight (blocked)
    runner.request('c1'); // coalesced — c1 is active
    runner.request('c1');
    expect(target.calls).toEqual(['c1']);

    target.releaseAll();
    await runner.whenIdle();
    expect(target.calls).toEqual(['c1']); // only ever ran once
    expect(runner.pending()).toBe(0);

    // After it drains, the same companion can be requested again.
    runner.request('c1');
    target.releaseAll();
    await runner.whenIdle();
    expect(target.calls).toEqual(['c1', 'c1']);
  });

  it('drains distinct companions serially in request order', async () => {
    const target = new GatedTarget();
    const runner = new ConsolidationRunner(target, logger);

    runner.request('a');
    runner.request('b');
    runner.request('c');
    // Only the first is in flight; the rest wait their turn.
    expect(target.calls).toEqual(['a']);
    expect(runner.pending()).toBe(3);

    target.releaseOne();
    await tick();
    expect(target.calls).toEqual(['a', 'b']);

    target.releaseAll();
    await runner.whenIdle();
    expect(target.calls).toEqual(['a', 'b', 'c']);
  });

  it('drops requests over the queue cap (the sweep retries them later)', async () => {
    const target = new GatedTarget();
    const runner = new ConsolidationRunner(target, logger, 2);

    runner.request('a'); // in flight
    runner.request('b'); // queued
    runner.request('c'); // over cap (2) → dropped
    expect(runner.pending()).toBe(2);

    target.releaseAll();
    await runner.whenIdle();
    expect(target.calls).toEqual(['a', 'b']);
  });

  it('keeps draining after a run throws', async () => {
    const target: ConsolidationTarget = {
      consolidate: vi.fn(async (id: string) => {
        if (id === 'boom') throw new Error('kaboom');
      }),
    };
    const runner = new ConsolidationRunner(target, logger);

    runner.request('boom');
    runner.request('ok');
    await runner.whenIdle();

    expect(target.consolidate).toHaveBeenCalledWith('boom');
    expect(target.consolidate).toHaveBeenCalledWith('ok');
    expect(runner.pending()).toBe(0);
  });

  it('close() drains the in-flight queue before resolving', async () => {
    const target = new GatedTarget();
    const runner = new ConsolidationRunner(target, logger);

    runner.request('a'); // in flight (blocked)
    runner.request('b'); // queued

    let closed = false;
    const closing = runner.close().then(() => {
      closed = true;
    });
    await tick();
    expect(closed).toBe(false); // still draining 'a'

    target.releaseAll();
    await closing;
    expect(closed).toBe(true);
    expect(target.calls).toEqual(['a', 'b']); // both drained, none dropped
    expect(runner.pending()).toBe(0);
  });

  it('drops requests once closing, so shutdown can settle (sweep recovers them)', async () => {
    const target = new GatedTarget();
    target.releaseAll(); // runs resolve immediately
    const runner = new ConsolidationRunner(target, logger);

    await runner.close(); // nothing queued → resolves at once, now stopping
    runner.request('a'); // no-op while stopping
    await runner.whenIdle();

    expect(target.calls).toEqual([]); // never ran
    expect(runner.pending()).toBe(0);
  });
});
