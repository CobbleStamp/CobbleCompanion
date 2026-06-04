/**
 * Focused tests for sweepConsolidation's error-isolation contract: the periodic
 * catch-up sweep hands every companion with a long-enough pending tail to the
 * runner, and one companion's failing request() must not abort the rest of the
 * worklist (best-effort, logged, never rejects). Worklist-threshold selection
 * itself is covered in consolidation-service.test.ts; this file owns isolation.
 */

import { createTestDatabase } from '@cobble/db/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DrizzleIdentityStore } from '../identity/store.js';
import { sweepConsolidation } from './consolidation-service.js';
import { DrizzleEpisodicMemoryStore } from './episodic-store.js';
import { TranscriptMemoryStore } from './store.js';

const logger = { error: vi.fn(), info: vi.fn() };

describe('sweepConsolidation error isolation', () => {
  let close: () => Promise<void>;
  let episodic: DrizzleEpisodicMemoryStore;
  let memory: TranscriptMemoryStore;
  let identity: DrizzleIdentityStore;

  beforeEach(async () => {
    logger.error.mockClear();
    logger.info.mockClear();
    const created = await createTestDatabase();
    close = created.close;
    episodic = new DrizzleEpisodicMemoryStore(created.db);
    memory = new TranscriptMemoryStore(created.db);
    identity = new DrizzleIdentityStore(created.db);
  });

  afterEach(async () => {
    await close();
  });

  /** Seed `count` un-consolidated turns onto a fresh companion; return its id. */
  async function seedCompanion(name: string, count: number): Promise<string> {
    const user = await identity.ensureUserByEmail('owner@example.com');
    const companion = await identity.createCompanion(user.id, {
      name,
      form: 'fox',
      temperament: 'curious',
    });
    for (let i = 0; i < count; i++) {
      await memory.appendMessage(companion.id, 'user', `m${i}`);
    }
    return companion.id;
  }

  it('keeps processing the worklist when one companion request throws', async () => {
    const first = await seedCompanion('First', 8);
    const second = await seedCompanion('Second', 8);
    const third = await seedCompanion('Third', 8);

    const requested: string[] = [];
    const runner = {
      request: (id: string): void => {
        if (id === second) {
          throw new Error('runner exploded for this companion');
        }
        requested.push(id);
      },
    };

    let count = 0;
    await expect(
      (async () => {
        count = await sweepConsolidation({ episodic, runner, logger, minTurns: 6 });
      })(),
    ).resolves.not.toThrow();

    // The failing companion was attempted but skipped; the others still ran.
    expect(requested).toContain(first);
    expect(requested).toContain(third);
    expect(requested).not.toContain(second);
    // The return count reflects only the successfully-requested companions.
    expect(count).toBe(2);
    // The per-companion failure was logged with its id, not swallowed.
    expect(logger.error).toHaveBeenCalledWith(
      'consolidation sweep failed to request a companion',
      expect.objectContaining({ companionId: second, error: expect.any(Error) }),
    );
  });

  it('requests every eligible companion when none of them fail', async () => {
    const first = await seedCompanion('First', 8);
    const second = await seedCompanion('Second', 8);

    const requested: string[] = [];
    const count = await sweepConsolidation({
      episodic,
      runner: { request: (id: string): void => void requested.push(id) },
      logger,
      minTurns: 6,
    });

    expect(count).toBe(2);
    expect(requested).toContain(first);
    expect(requested).toContain(second);
    expect(logger.error).not.toHaveBeenCalled();
  });
});
