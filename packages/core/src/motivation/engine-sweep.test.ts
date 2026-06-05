/** Motivation sweep — requests a tick per companion with new leads; isolates failures. */

import { describe, expect, it } from 'vitest';
import type { Logger } from '../logging.js';
import type { LeadStore } from '../tools/lead-store.js';
import { MotivationRunner, type MotivationTarget } from './engine-runner.js';
import { sweepMotivation } from './engine-sweep.js';

const silent: Logger = { error: () => {}, warn: () => {}, info: () => {} };

/** Logger that captures `error` calls so the per-companion failure can be asserted. */
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

  it('isolates a per-companion request failure and still requests the rest', async () => {
    const logger = capturingLogger();
    const requestedIds: string[] = [];
    // A runner whose request() throws for one companion but works for the others.
    const flakyRunner = {
      request(companionId: string): void {
        if (companionId === 'b') {
          throw new Error('request blew up for b');
        }
        requestedIds.push(companionId);
      },
    } as unknown as MotivationRunner;

    const requested = await sweepMotivation({
      leads: leadsWith(['a', 'b', 'c']),
      runner: flakyRunner,
      logger,
    });

    // 'b' threw and was skipped; 'a' and 'c' were still requested (loop continued).
    expect(requested).toBe(2);
    expect(requestedIds.sort()).toEqual(['a', 'c']);
    expect(logger.errors).toContain('motivation sweep failed to request a companion');
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
