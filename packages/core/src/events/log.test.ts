/** The durable companion event log: append, cursor reads, latest seq. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase } from '@cobble/db/testing';
import type { CompanionStreamEvent } from '@cobble/shared';
import { DrizzleIdentityStore } from '../identity/store.js';
import { DrizzleCompanionEventLog } from './log.js';

const reaction = (emoji: string): CompanionStreamEvent => ({
  type: 'reaction_added',
  messageId: 'm1',
  reactor: 'companion',
  emoji,
});

describe('DrizzleCompanionEventLog', () => {
  let log: DrizzleCompanionEventLog;
  let close: () => Promise<void>;
  let companionId: string;
  let otherId: string;

  beforeEach(async () => {
    const created = await createTestDatabase();
    close = created.close;
    log = new DrizzleCompanionEventLog(created.db);
    const identity = new DrizzleIdentityStore(created.db);
    const user = await identity.ensureUserByEmail('owner@example.com');
    companionId = (
      await identity.createCompanion(user.id, { name: 'A', form: 'fox', temperament: 'curious' })
    ).id;
    otherId = (
      await identity.createCompanion(user.id, { name: 'B', form: 'dog', temperament: 'calm' })
    ).id;
  });

  afterEach(async () => {
    await close();
  });

  it('appends and reads back in seq order from a cursor', async () => {
    await log.append(companionId, reaction('a'));
    await log.append(companionId, reaction('b'));

    const all = await log.readSince(companionId, 0, 10);
    expect(all.map((e) => (e.event as { emoji: string }).emoji)).toEqual(['a', 'b']);
    expect(all[0]!.seq).toBeLessThan(all[1]!.seq);

    // Reading past the first cursor returns only the later event.
    const tail = await log.readSince(companionId, all[0]!.seq, 10);
    expect(tail.map((e) => (e.event as { emoji: string }).emoji)).toEqual(['b']);
  });

  it('tracks the latest seq and scopes by companion', async () => {
    expect(await log.latestSeq(companionId)).toBe(0);
    await log.append(companionId, reaction('a'));
    await log.append(otherId, reaction('x'));
    const latest = await log.latestSeq(companionId);
    expect(latest).toBeGreaterThan(0);
    // The other companion's event is not visible here.
    expect(
      (await log.readSince(companionId, 0, 10)).map((e) => (e.event as { emoji: string }).emoji),
    ).toEqual(['a']);
  });
});
