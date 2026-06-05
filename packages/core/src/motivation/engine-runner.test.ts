/** Motivation runner — coalescing, serial drain, throw-isolation, and close(). */

import { describe, expect, it } from 'vitest';
import type { Logger } from '../logging.js';
import { MotivationRunner, type MotivationTarget } from './engine-runner.js';

const silent: Logger = { error: () => {}, warn: () => {}, info: () => {} };

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
