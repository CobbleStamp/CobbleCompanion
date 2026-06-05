/** Motivation runner — coalescing, serial drain, throw-isolation, and close(). */

import { describe, expect, it } from 'vitest';
import type { Logger } from '../logging.js';
import { MotivationRunner, type MotivationTarget } from './engine-runner.js';

const silent: Logger = { error: () => {}, warn: () => {}, info: () => {} };

/** Logger that captures `error` calls so the queue-full drop can be asserted. */
interface CapturingLogger extends Logger {
  readonly errors: string[];
}
function capturingLogger(): CapturingLogger {
  const errors: string[] = [];
  return {
    errors,
    error: (message: string): void => {
      errors.push(message);
    },
    warn: () => {},
    info: () => {},
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('MotivationRunner', () => {
  it('drains every queued companion and resolves whenIdle', async () => {
    const ticked: string[] = [];
    const target: MotivationTarget = {
      async tick(id) {
        ticked.push(id);
      },
    };
    const runner = new MotivationRunner(target, silent);
    runner.request('a');
    runner.request('b');
    await runner.whenIdle();
    expect([...ticked].sort()).toEqual(['a', 'b']);
  });

  it('coalesces a companion already in flight', async () => {
    const ticked: string[] = [];
    const gate = deferred();
    const target: MotivationTarget = {
      async tick(id) {
        ticked.push(id);
        await gate.promise;
      },
    };
    const runner = new MotivationRunner(target, silent);
    runner.request('a'); // starts draining; tick('a') is in flight awaiting the gate
    runner.request('a'); // coalesced — same companion already active
    expect(runner.pending()).toBe(1);
    gate.resolve();
    await runner.whenIdle();
    expect(ticked).toEqual(['a']); // ticked exactly once
  });

  it('keeps draining after a tick throws', async () => {
    const ticked: string[] = [];
    const target: MotivationTarget = {
      async tick(id) {
        ticked.push(id);
        if (id === 'bad') throw new Error('boom');
      },
    };
    const runner = new MotivationRunner(target, silent);
    runner.request('bad');
    runner.request('good');
    await runner.whenIdle();
    expect([...ticked].sort()).toEqual(['bad', 'good']);
  });

  it('drops the excess request when the queue is full (sweep will retry)', async () => {
    const logger = capturingLogger();
    const ticked: string[] = [];
    const gate = deferred();
    const target: MotivationTarget = {
      async tick(id) {
        ticked.push(id);
        await gate.promise; // hold the slot in flight so the cap stays reached
      },
    };
    // Backstop of one distinct companion queued + in flight.
    const runner = new MotivationRunner(target, logger, 1);

    runner.request('a'); // fills the single slot (now in flight, awaiting the gate)
    expect(runner.pending()).toBe(1);
    runner.request('b'); // over the cap → dropped with a log, does not crash
    expect(runner.pending()).toBe(1);

    expect(logger.errors).toContain('motivation queue full; dropping request (sweep will retry)');

    gate.resolve();
    await runner.whenIdle();
    expect(ticked).toEqual(['a']); // only the admitted companion ticked
  });

  it('close() stops accepting new requests', async () => {
    const ticked: string[] = [];
    const target: MotivationTarget = {
      async tick(id) {
        ticked.push(id);
      },
    };
    const runner = new MotivationRunner(target, silent);
    await runner.close();
    runner.request('a');
    await runner.whenIdle();
    expect(ticked).toEqual([]);
  });
});
