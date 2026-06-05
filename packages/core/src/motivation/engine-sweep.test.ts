/** Motivation sweep — requests a tick per companion with new leads; isolates failures. */

import { describe, expect, it } from 'vitest';
import type { Logger } from '../logging.js';
import type { LeadStore } from '../tools/lead-store.js';
import { MotivationRunner, type MotivationTarget } from './engine-runner.js';
import { sweepMotivation } from './engine-sweep.js';

const silent: Logger = { error: () => {}, warn: () => {}, info: () => {} };

function leadsWith(ids: readonly string[]): LeadStore {
  return {
    async companionsWithNewLeads() {
      return ids;
    },
  } as unknown as LeadStore;
}

function recordingRunner(into: string[]): MotivationRunner {
  const target: MotivationTarget = {
    async tick(id) {
      into.push(id);
    },
  };
  return new MotivationRunner(target, silent);
}

describe('sweepMotivation', () => {
  it('requests a tick for each companion with unread leads', async () => {
    const ticked: string[] = [];
    const runner = recordingRunner(ticked);
    const requested = await sweepMotivation({
      leads: leadsWith(['a', 'b', 'c']),
      runner,
      logger: silent,
    });
    expect(requested).toBe(3);
    await runner.whenIdle();
    expect([...ticked].sort()).toEqual(['a', 'b', 'c']);
  });

  it('returns 0 when the worklist query fails (best-effort)', async () => {
    const leads = {
      async companionsWithNewLeads() {
        throw new Error('db down');
      },
    } as unknown as LeadStore;
    const requested = await sweepMotivation({ leads, runner: recordingRunner([]), logger: silent });
    expect(requested).toBe(0);
  });
});
