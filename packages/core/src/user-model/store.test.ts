import { companions, type Database, userFacts } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import { and, eq, isNull } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleIdentityStore } from '../identity/store.js';
import { DrizzleUserModelStore } from './store.js';

describe('DrizzleUserModelStore', () => {
  let db: Database;
  let close: () => Promise<void>;
  let identity: DrizzleIdentityStore;
  let store: DrizzleUserModelStore;
  let userId: string;
  let companionId: string;

  beforeEach(async () => {
    const created = await createTestDatabase();
    db = created.db;
    close = created.close;
    identity = new DrizzleIdentityStore(db);
    store = new DrizzleUserModelStore(db);
    const user = await identity.ensureUserByEmail('sam@example.com');
    userId = user.id;
    const companion = await identity.createCompanion(userId, {
      name: 'Pebble',
      form: 'fox',
      temperament: 'curious',
    });
    companionId = companion.id;
  });

  afterEach(async () => {
    await close();
  });

  function recordName(object: string): Promise<{ id: string }> {
    return store.recordTranscriptFact({
      userId,
      predicate: 'name',
      object,
      learnedByCompanionId: companionId,
      confidence: 0.9,
    });
  }

  describe('recordTranscriptFact', () => {
    it('records a current fact with its companion provenance (seq stays null)', async () => {
      const fact = await recordName('Sam');
      const current = await store.listCurrent(userId);
      expect(current).toHaveLength(1);
      expect(current[0]).toMatchObject({ predicate: 'name', object: 'Sam', source: 'transcript' });
      // Provenance is server-side (not on the DTO) — assert via the row. The inline
      // capture records the companion link; the exact turn seq is reserved (Phase 12).
      const [row] = await db.select().from(userFacts).where(eq(userFacts.id, fact.id));
      expect(row?.learnedByCompanionId).toBe(companionId);
      expect(row?.learnedFromSeq).toBeNull();
    });

    it('supersedes the prior value for the same predicate, keeping history', async () => {
      const first = await recordName('Sam');
      const second = await recordName('Samuel');
      // Only the new value is current.
      const current = await store.listCurrent(userId);
      expect(current).toHaveLength(1);
      expect(current[0]?.object).toBe('Samuel');
      // The old row is kept and points at its replacement (not deleted).
      const [old] = await db.select().from(userFacts).where(eq(userFacts.id, first.id));
      expect(old?.supersededAt).not.toBeNull();
      expect(old?.supersededBy).toBe(second.id);
    });

    it('keeps distinct predicates as separate current facts', async () => {
      await recordName('Sam');
      await store.recordTranscriptFact({
        userId,
        predicate: 'livesIn',
        object: 'Berlin',
        learnedByCompanionId: companionId,
      });
      const current = await store.listCurrent(userId);
      expect(current.map((f) => f.predicate).sort()).toEqual(['livesIn', 'name']);
    });
  });

  describe('seedName', () => {
    it('seeds an auth_seed name with modest confidence when absent', async () => {
      const seeded = await store.seedName(userId, 'Samuel Smith');
      expect(seeded).toMatchObject({
        predicate: 'name',
        object: 'Samuel Smith',
        source: 'auth_seed',
      });
      expect(seeded?.confidence).toBe(0.5);
    });

    it('is idempotent — a second seed is a no-op', async () => {
      await store.seedName(userId, 'Samuel Smith');
      const again = await store.seedName(userId, 'Someone Else');
      expect(again).toBeNull();
      const current = await store.listCurrent(userId);
      expect(current).toHaveLength(1);
      expect(current[0]?.object).toBe('Samuel Smith');
    });

    it('does not seed over a stated name (no resurrection)', async () => {
      await recordName('Sam');
      const seeded = await store.seedName(userId, 'Samuel Smith');
      expect(seeded).toBeNull();
      const current = await store.listCurrent(userId);
      expect(current).toHaveLength(1);
      expect(current[0]?.object).toBe('Sam');
    });

    it('does not re-seed even after the prior name was superseded away', async () => {
      // Seed, then state a name (supersedes the seed); a later sign-in must not
      // resurrect a fresh auth_seed name over the stated one.
      await store.seedName(userId, 'Samuel Smith');
      await recordName('Sam');
      const reSeed = await store.seedName(userId, 'Samuel Smith');
      expect(reSeed).toBeNull();
      const current = await store.listCurrent(userId);
      expect(current).toHaveLength(1);
      expect(current[0]?.object).toBe('Sam');
    });

    it('ignores a blank seed', async () => {
      expect(await store.seedName(userId, '   ')).toBeNull();
      expect(await store.listCurrent(userId)).toHaveLength(0);
    });
  });

  describe('editFact', () => {
    it('supersedes the target and inserts an authoritative user_edit replacement', async () => {
      const seeded = await store.seedName(userId, 'Samuel Smith');
      const edited = await store.editFact(userId, seeded!.id, 'Sam');
      expect(edited).toMatchObject({ object: 'Sam', source: 'user_edit', predicate: 'name' });
      expect(edited?.confidence).toBe(1);
      const current = await store.listCurrent(userId);
      expect(current).toHaveLength(1);
      expect(current[0]?.object).toBe('Sam');
    });

    it('returns null for a fact the user does not own', async () => {
      const other = await identity.ensureUserByEmail('other@example.com');
      const fact = await recordName('Sam');
      const edited = await store.editFact(other.id, fact.id, 'Hacked');
      expect(edited).toBeNull();
      const current = await store.listCurrent(userId);
      expect(current[0]?.object).toBe('Sam');
    });

    it('returns null for an unknown fact', async () => {
      expect(await store.editFact(userId, '00000000-0000-0000-0000-000000000000', 'X')).toBeNull();
    });
  });

  describe('forgetFact', () => {
    it('removes the fact from the current set and it does not resurface', async () => {
      const fact = await recordName('Sam');
      expect(await store.forgetFact(userId, fact.id)).toBe(true);
      expect(await store.listCurrent(userId)).toHaveLength(0);
      // Forgotten = superseded with no replacement (kept in history).
      const [row] = await db.select().from(userFacts).where(eq(userFacts.id, fact.id));
      expect(row?.supersededAt).not.toBeNull();
      expect(row?.supersededBy).toBeNull();
    });

    it('returns false for a fact the user does not own', async () => {
      const other = await identity.ensureUserByEmail('other@example.com');
      const fact = await recordName('Sam');
      expect(await store.forgetFact(other.id, fact.id)).toBe(false);
      expect(await store.listCurrent(userId)).toHaveLength(1);
    });
  });

  it('keeps the fact when the teaching companion is deleted (link nulls)', async () => {
    const fact = await recordName('Sam');
    await db.delete(companions).where(eq(companions.id, companionId));
    // The fact is the user's — it survives, with its companion link nulled.
    const current = await store.listCurrent(userId);
    expect(current).toHaveLength(1);
    const [row] = await db
      .select()
      .from(userFacts)
      .where(and(eq(userFacts.id, fact.id), isNull(userFacts.learnedByCompanionId)));
    expect(row?.object).toBe('Sam');
  });
});
