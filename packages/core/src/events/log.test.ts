/** The durable companion event log: append, horizon-gated cursor reads, latest seq. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase } from '@cobble/db/testing';
import type { Database } from '@cobble/db';
import type { CompanionStreamEvent } from '@cobble/shared';
import { sql } from 'drizzle-orm';
import { DrizzleIdentityStore } from '../identity/store.js';
import { DrizzleCompanionEventLog } from './log.js';

const reaction = (emoji: string): CompanionStreamEvent => ({
  type: 'reaction_added',
  messageId: 'm1',
  reactor: 'companion',
  emoji,
});

const emojis = (events: readonly { event: CompanionStreamEvent }[]): string[] =>
  events.map((e) => (e.event as { emoji: string }).emoji);

// An xid8 value far above any real transaction id — stands in for "this row's
// inserting transaction is NOT yet past the visibility horizon" (i.e. in-flight).
// PGlite is single-connection, so a real concurrent in-flight txn can't be staged;
// forcing the stored xid is the deterministic equivalent for the reader's gate.
const UNSETTLED_LO = "'18000000000000000000'";
const UNSETTLED_HI = "'18000000000000000001'";
const SETTLED_LO = "'1'"; // below any live xmin

describe('DrizzleCompanionEventLog', () => {
  let db: Database;
  let log: DrizzleCompanionEventLog;
  let close: () => Promise<void>;
  let companionId: string;
  let otherId: string;

  /** Force a row's stored xid, simulating its inserting txn's settle state. */
  async function setXid(seq: number, xidLiteral: string): Promise<void> {
    await db.execute(
      sql`update companion_events set xid = ${sql.raw(xidLiteral)}::xid8 where seq = ${seq}`,
    );
  }

  beforeEach(async () => {
    const created = await createTestDatabase();
    db = created.db;
    close = created.close;
    log = new DrizzleCompanionEventLog(db);
    const identity = new DrizzleIdentityStore(db);
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
    expect(emojis(all)).toEqual(['a', 'b']);
    expect(all[0]!.seq).toBeLessThan(all[1]!.seq);

    // Reading past the first cursor returns only the later event.
    const tail = await log.readSince(companionId, all[0]!.seq, 10);
    expect(emojis(tail)).toEqual(['b']);
  });

  it('tracks the latest seq and scopes by companion', async () => {
    expect(await log.latestSeq(companionId)).toBe(0);
    await log.append(companionId, reaction('a'));
    await log.append(otherId, reaction('x'));
    const latest = await log.latestSeq(companionId);
    expect(latest).toBeGreaterThan(0);
    // The other companion's event is not visible here.
    expect(emojis(await log.readSince(companionId, 0, 10))).toEqual(['a']);
  });

  it('latestSettledSeq matches latestSeq when everything is committed', async () => {
    expect(await log.latestSettledSeq(companionId)).toBe(0);
    await log.append(companionId, reaction('a'));
    await log.append(companionId, reaction('b'));
    expect(await log.latestSettledSeq(companionId)).toBe(await log.latestSeq(companionId));
  });

  // The C1 guarantee: the reader must never advance its cursor past a lower seq that
  // is still in-flight (a bigserial seq is assigned at INSERT but visible at COMMIT,
  // and commits can reorder). Modelled by forcing the stored xid: while the oldest
  // row is unsettled, the whole suffix from it is held back; rows are released, in
  // order, only as they settle — so no event is ever skipped.
  it('never advances past an unsettled lower seq (seq-gap guard)', async () => {
    await log.append(companionId, reaction('a'));
    await log.append(companionId, reaction('b'));
    const settled = await log.readSince(companionId, 0, 10);
    const [a, b] = settled;
    expect(emojis(settled)).toEqual(['a', 'b']);

    // Both in-flight (xid >= horizon), monotonic with seq: nothing is deliverable,
    // and the cursor anchor stays at 0 — the higher seq is NOT leaked ahead of 'a'.
    await setXid(a!.seq, UNSETTLED_LO);
    await setXid(b!.seq, UNSETTLED_HI);
    expect(await log.readSince(companionId, 0, 10)).toEqual([]);
    expect(await log.latestSettledSeq(companionId)).toBe(0);

    // 'a' settles: it is delivered; 'b' (still in-flight) is held back — in order.
    await setXid(a!.seq, SETTLED_LO);
    expect(emojis(await log.readSince(companionId, 0, 10))).toEqual(['a']);
    expect(await log.latestSettledSeq(companionId)).toBe(a!.seq);

    // 'b' settles: now delivered, strictly after 'a'.
    await setXid(b!.seq, SETTLED_LO);
    expect(emojis(await log.readSince(companionId, a!.seq, 10))).toEqual(['b']);
  });
});
