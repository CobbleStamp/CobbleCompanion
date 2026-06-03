/**
 * Runner tests: enqueue returns immediately, jobs drain sequentially in order,
 * and a throwing run is logged without stalling the queue.
 */

import { describe, expect, it } from 'vitest';
import type { Logger } from '../logging.js';
import type { IngestionRunParams } from './pipeline.js';
import { IngestionQueueFullError, IngestionRunner, type IngestionTarget } from './runner.js';

function params(jobId: string): IngestionRunParams {
  return {
    companionId: 'companion-1',
    sourceId: `source-${jobId}`,
    jobId,
    sourceTitle: 'Peru notes',
    payload: { kind: 'note', text: 'text' },
  };
}

describe('IngestionRunner', () => {
  it('returns from enqueue immediately and drains jobs in order', async () => {
    const started: string[] = [];
    const finished: string[] = [];
    const target: IngestionTarget = {
      async run(runParams) {
        started.push(runParams.jobId);
        // Yield so overlapping drains would interleave if sequencing broke.
        await new Promise((resolve) => setTimeout(resolve, 5));
        finished.push(runParams.jobId);
      },
    };
    const runner = new IngestionRunner(target, { error: () => undefined, info: () => undefined });

    runner.enqueue(params('a'));
    runner.enqueue(params('b'));
    // Off the request path: nothing has run synchronously yet.
    expect(finished).toEqual([]);

    await runner.whenIdle();
    expect(started).toEqual(['a', 'b']);
    expect(finished).toEqual(['a', 'b']);
  });

  it('logs an unexpected throw and continues with the next job', async () => {
    const logged: string[] = [];
    const completed: string[] = [];
    const logger: Logger = {
      error: (message) => logged.push(message),
      info: () => undefined,
    };
    const target: IngestionTarget = {
      async run(runParams) {
        if (runParams.jobId === 'boom') {
          throw new Error('unexpected');
        }
        completed.push(runParams.jobId);
      },
    };
    const runner = new IngestionRunner(target, logger);

    runner.enqueue(params('boom'));
    runner.enqueue(params('after'));
    await runner.whenIdle();

    expect(logged).toHaveLength(1);
    expect(completed).toEqual(['after']);
  });

  it('accepts new work enqueued after a drain completes', async () => {
    const completed: string[] = [];
    const target: IngestionTarget = {
      async run(runParams) {
        completed.push(runParams.jobId);
      },
    };
    const runner = new IngestionRunner(target, { error: () => undefined, info: () => undefined });

    runner.enqueue(params('first'));
    await runner.whenIdle();
    runner.enqueue(params('second'));
    await runner.whenIdle();

    expect(completed).toEqual(['first', 'second']);
  });

  it('throws IngestionQueueFullError once queued + in-flight reaches the cap', async () => {
    let release: (() => void) | undefined;
    const blocker = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    const target: IngestionTarget = {
      // Only the first run blocks (so the queue fills); later runs resolve.
      run: () => (calls++ === 0 ? blocker : Promise.resolve()),
    };
    const runner = new IngestionRunner(
      target,
      { error: () => undefined, info: () => undefined },
      2, // cap: one in-flight + one queued
    );

    runner.enqueue(params('in-flight')); // drains immediately, occupies the in-flight slot
    runner.enqueue(params('queued')); // fills the one queue slot
    expect(runner.pending()).toBe(2);
    expect(runner.isFull()).toBe(true);
    expect(() => runner.enqueue(params('overflow'))).toThrow(IngestionQueueFullError);

    release?.();
    await runner.whenIdle();
    // Capacity frees up after draining.
    expect(runner.isFull()).toBe(false);
    runner.enqueue(params('later'));
    await runner.whenIdle();
  });
});
