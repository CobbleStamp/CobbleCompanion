import { companions, type Database, EMBEDDING_DIMENSIONS, userFacts } from '@cobble/db';
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

    it('replaces the prior value for the same predicate (current-state, no history row)', async () => {
      const first = await recordName('Sam');
      await recordName('Samuel');
      // Only the new value is current.
      const current = await store.listCurrent(userId);
      expect(current).toHaveLength(1);
      expect(current[0]?.object).toBe('Samuel');
      // Current-state overlay: the old row is gone (the timeline lives in episodic memory).
      const old = await db.select().from(userFacts).where(eq(userFacts.id, first.id));
      expect(old).toHaveLength(0);
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

    function recordLanguage(object: string): Promise<{ id: string }> {
      return store.recordTranscriptFact({
        userId,
        predicate: 'languages',
        object,
        learnedByCompanionId: companionId,
      });
    }

    it('accretes distinct values for a multi-valued predicate (no data loss)', async () => {
      await recordLanguage('French');
      await recordLanguage('German');
      // Both languages stay current — a new value does not supersede a different one.
      const current = await store.listCurrent(userId);
      expect(current.map((f) => f.object).sort()).toEqual(['French', 'German']);
      expect(current.every((f) => f.predicate === 'languages')).toBe(true);
    });

    it('collapses an identical restatement of a multi-valued predicate (idempotent)', async () => {
      const first = await recordLanguage('French');
      const second = await recordLanguage('French');
      // The exact repeat replaces the prior — one current "French", the old row gone.
      const current = await store.listCurrent(userId);
      expect(current).toHaveLength(1);
      expect(current[0]?.id).toBe(second.id);
      const old = await db.select().from(userFacts).where(eq(userFacts.id, first.id));
      expect(old).toHaveLength(0);
    });

    it('does not let a multi-valued value supersede a singular predicate', async () => {
      // Sanity: accretion is scoped to the predicate, never bleeds into singletons.
      await recordName('Sam');
      await recordLanguage('French');
      await recordLanguage('German');
      const current = await store.listCurrent(userId);
      const names = current.filter((f) => f.predicate === 'name');
      expect(names).toHaveLength(1);
      expect(names[0]?.object).toBe('Sam');
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

    it('settles concurrent first-load seeds to one current name (no duplicate)', async () => {
      // seedName runs on every authed request, outside the harness per-user
      // serialization, so a fresh user's parallel first-load requests can race. The
      // partial unique index + ON CONFLICT DO NOTHING must collapse them to one row.
      const results = await Promise.all([
        store.seedName(userId, 'Samuel Smith'),
        store.seedName(userId, 'Samuel Smith'),
        store.seedName(userId, 'Samuel Smith'),
      ]);
      // Exactly one call inserts the seed; the losers are no-ops (null), never an error.
      expect(results.filter((fact) => fact !== null)).toHaveLength(1);
      const current = await store.listCurrent(userId);
      expect(current).toHaveLength(1);
      expect(current[0]?.object).toBe('Samuel Smith');
    });

    it('rejects a second current name row at the database (partial unique index)', async () => {
      // The invariant is DB-enforced, not just guarded in app code: a raw insert that
      // would create a second current `name` for the user must fail outright.
      await store.seedName(userId, 'Samuel Smith');
      await expect(
        db.insert(userFacts).values({
          userId,
          source: 'auth_seed',
          factType: 'attribute',
          subject: 'user',
          predicate: 'name',
          object: 'Imposter',
          confidence: 0.5,
        }),
      ).rejects.toThrow();
    });
  });

  describe('editFact', () => {
    it('replaces the value in place with an authoritative user_edit', async () => {
      const seeded = await store.seedName(userId, 'Samuel Smith');
      const edited = await store.editFact(userId, seeded!.id, 'Sam');
      // Current-state overlay: the same row is updated in place (no new id, no chain).
      expect(edited).toMatchObject({
        id: seeded!.id,
        object: 'Sam',
        source: 'user_edit',
        predicate: 'name',
      });
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

    it('refuses a Tier-2 belief (read-only until Phase 13) and leaves it intact', async () => {
      const belief = await store.recordBelief({ userId, predicate: 'prefers', object: 'oat milk' });
      expect(await store.editFact(userId, belief.id, 'soy milk')).toBeNull();
      const beliefs = await store.listCurrentBeliefs(userId);
      expect(beliefs).toHaveLength(1);
      expect(beliefs[0]).toMatchObject({ id: belief.id, object: 'oat milk' });
    });
  });

  describe('forgetFact', () => {
    it('hard-deletes the fact so it does not resurface', async () => {
      const fact = await recordName('Sam');
      expect(await store.forgetFact(userId, fact.id)).toBe(true);
      expect(await store.listCurrent(userId)).toHaveLength(0);
      // Current-state overlay: the row is deleted outright (no history chain to keep).
      const rows = await db.select().from(userFacts).where(eq(userFacts.id, fact.id));
      expect(rows).toHaveLength(0);
    });

    it('returns false for a fact the user does not own', async () => {
      const other = await identity.ensureUserByEmail('other@example.com');
      const fact = await recordName('Sam');
      expect(await store.forgetFact(other.id, fact.id)).toBe(false);
      expect(await store.listCurrent(userId)).toHaveLength(1);
    });

    it('refuses a Tier-2 belief (read-only until Phase 13) and leaves it intact', async () => {
      const belief = await store.recordBelief({ userId, predicate: 'prefers', object: 'oat milk' });
      expect(await store.forgetFact(userId, belief.id)).toBe(false);
      expect(await store.listCurrentBeliefs(userId)).toHaveLength(1);
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

  describe('Tier-2 beliefs (Phase 12)', () => {
    /** A unit vector with a single 1 at `hot`, so cosine distance is 0 to itself. */
    function basisVector(hot: number): number[] {
      const v: number[] = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
      v[hot] = 1;
      return v;
    }

    it('records a belief and lists it, excluding Tier-1 facts', async () => {
      await recordName('Sam'); // a Tier-1 identity fact — must not appear among beliefs
      const belief = await store.recordBelief({
        userId,
        predicate: 'interestedIn',
        object: 'Rust',
        learnedByCompanionId: companionId,
        confidence: 0.6,
        embedding: basisVector(0),
      });

      expect(belief).toMatchObject({ predicate: 'interestedIn', object: 'Rust', salience: 0.5 });
      const beliefs = await store.listCurrentBeliefs(userId);
      expect(beliefs).toHaveLength(1);
      expect(beliefs[0]?.object).toBe('Rust');
      // Tier-1 still lives in the plain current set, not the belief set.
      expect(await store.listCurrent(userId)).toHaveLength(2);
    });

    it('reinforces an identical restatement instead of duplicating it', async () => {
      const first = await store.recordBelief({ userId, predicate: 'prefers', object: 'oat milk' });
      const again = await store.recordBelief({ userId, predicate: 'prefers', object: 'oat milk' });

      expect(again.id).toBe(first.id);
      expect(again.salience).toBeCloseTo(0.6); // 0.5 + one reinforce step
      expect(await store.listCurrentBeliefs(userId)).toHaveLength(1);
    });

    it('back-fills a missing embedding when an FTS-only belief is reinforced', async () => {
      // A belief first stored without an embedding (embeddings unconfigured, or an embed
      // hiccup — harness/reflector store FTS-only) is invisible to the vector arm. Under the
      // vector relevance floor that arm is the primary recall path, so the belief is quietly
      // demoted forever unless reinforcement back-fills the embedding it now has in hand.
      const first = await store.recordBelief({ userId, predicate: 'prefers', object: 'oat milk' });
      const [before] = await db.select().from(userFacts).where(eq(userFacts.id, first.id));
      expect(before?.embedding).toBeNull(); // stored FTS-only
      // Not yet vector-recallable.
      expect(await store.findSimilarBeliefs(userId, basisVector(0), 5)).toHaveLength(0);

      // A later identical restatement now carries an embedding.
      const again = await store.recordBelief({
        userId,
        predicate: 'prefers',
        object: 'oat milk',
        embedding: basisVector(0),
      });
      expect(again.id).toBe(first.id); // reinforced, not duplicated

      // The embedding is back-filled onto the existing row, so it joins the vector arm.
      const [after] = await db.select().from(userFacts).where(eq(userFacts.id, first.id));
      expect(after?.embedding).not.toBeNull();
      const similar = await store.findSimilarBeliefs(userId, basisVector(0), 5);
      expect(similar.map((b) => b.id)).toEqual([first.id]);
    });

    it('does not overwrite an existing embedding on reinforcement', async () => {
      // Back-fill fills a gap; it must never clobber a good embedding with a later one.
      const first = await store.recordBelief({
        userId,
        predicate: 'prefers',
        object: 'oat milk',
        embedding: basisVector(0),
      });
      await store.recordBelief({
        userId,
        predicate: 'prefers',
        object: 'oat milk',
        embedding: basisVector(1), // a different vector on the restatement
      });
      const [row] = await db.select().from(userFacts).where(eq(userFacts.id, first.id));
      expect(row?.embedding?.[0]).toBe(1); // original basisVector(0) preserved
      expect(row?.embedding?.[1]).toBe(0);
    });

    it('recalls beliefs by vector nearest-neighbour and by full-text', async () => {
      const rust = await store.recordBelief({
        userId,
        predicate: 'interestedIn',
        object: 'Rust programming',
        embedding: basisVector(0),
      });
      await store.recordBelief({
        userId,
        predicate: 'prefers',
        object: 'oat milk lattes',
        embedding: basisVector(1),
      });

      const byVector = await store.searchBeliefs(userId, {
        queryEmbedding: basisVector(0),
        queryText: 'nonsense-token',
        topK: 1,
      });
      expect(byVector[0]?.belief.id).toBe(rust.id);

      const byText = await store.searchBeliefs(userId, {
        queryEmbedding: [],
        queryText: 'Rust',
        topK: 5,
      });
      expect(byText.map((h) => h.belief.object)).toEqual(['Rust programming']);
    });

    it('applies a vector relevance floor — a far belief is dropped, not pulled in to fill top-K', async () => {
      const near = await store.recordBelief({
        userId,
        predicate: 'interestedIn',
        object: 'Rust programming',
        embedding: basisVector(0), // distance 0 to the query
      });
      await store.recordBelief({
        userId,
        predicate: 'prefers',
        object: 'oat milk lattes',
        embedding: basisVector(1), // orthogonal → distance 1.0, beyond the floor
      });

      // Floored: only the on-topic belief survives, even though topK would fit both.
      const floored = await store.searchBeliefs(userId, {
        queryEmbedding: basisVector(0),
        queryText: 'nonsense-token', // no FTS arm — isolate the vector floor
        topK: 5,
        maxVectorDistance: 0.8,
      });
      expect(floored.map((h) => h.belief.id)).toEqual([near.id]);

      // Without a floor (omitted), the legacy behaviour stands — both come back.
      const unfloored = await store.searchBeliefs(userId, {
        queryEmbedding: basisVector(0),
        queryText: 'nonsense-token',
        topK: 5,
      });
      expect(unfloored).toHaveLength(2);
    });

    it('lets salience tilt recall — a reinforced belief outranks a more-relevant weaker one', async () => {
      // `near` is the vector-nearest to the query (distance 0); `far` is one rank behind.
      // With equal salience, relevance wins (see the NN test). Here `far` is reinforced to
      // max and `near` cut to the floor, so the salience prior lifts `far` above it.
      const near = await store.recordBelief({
        userId,
        predicate: 'interestedIn',
        object: 'alpha topic',
        embedding: basisVector(0),
      });
      const far = await store.recordBelief({
        userId,
        predicate: 'interestedIn',
        object: 'beta topic',
        embedding: basisVector(1),
      });
      await store.adjustBeliefSalience(userId, near.id, -0.4); // → 0.1 (low, but above the stale floor)
      await store.adjustBeliefSalience(userId, far.id, 1); // → 1 (clamped ceil)

      const hits = await store.searchBeliefs(userId, {
        queryEmbedding: basisVector(0), // nearest is `near`
        queryText: 'nonsense-token', // no FTS arm — vector relevance only
        topK: 2,
      });
      expect(hits.map((h) => h.belief.id)).toEqual([far.id, near.id]);
    });

    it('drops a belief whose salience has decayed below the stale floor (Phase 13)', async () => {
      const fresh = await store.recordBelief({
        userId,
        predicate: 'interestedIn',
        object: 'alpha topic',
        embedding: basisVector(0),
      });
      const stale = await store.recordBelief({
        userId,
        predicate: 'interestedIn',
        object: 'beta topic',
        embedding: basisVector(1),
      });
      // Reinforce `fresh` to full strength, then read ~110 days out (≈3.7 half-lives at 30d):
      // a 1.0 belief decays to ~0.079 (above the 0.05 floor → survives), while `stale` at the
      // default 0.5 decays to ~0.039 (below the floor → dropped).
      await store.adjustBeliefSalience(userId, fresh.id, 1); // → 1.0
      const future = new Date(Date.now() + 110 * 86_400_000);

      // Both objects share the term "topic", so the FTS arm surfaces both as candidates;
      // the stale-drop then removes the decayed one (plainto_tsquery ANDs terms, so query
      // the shared word, not the full phrase).
      const hits = await store.searchBeliefs(userId, {
        queryEmbedding: [],
        queryText: 'topic',
        topK: 5,
        now: future,
      });
      expect(hits.map((h) => h.belief.id)).toEqual([fresh.id]);
      expect(hits.map((h) => h.belief.id)).not.toContain(stale.id);
    });

    it('replaces a same-matter newer state in place (no history row)', async () => {
      const loves = await store.recordBelief({
        userId,
        predicate: 'prefers',
        object: 'loves coffee',
        embedding: basisVector(0),
      });
      const quit = await store.replaceBelief(userId, loves.id, {
        userId,
        predicate: 'prefers',
        object: 'quit coffee',
        embedding: basisVector(0),
      });

      // Current-state overlay: the same row is overwritten (same id), not chained.
      expect(quit?.id).toBe(loves.id);
      expect(quit?.object).toBe('quit coffee');
      const current = await store.listCurrentBeliefs(userId);
      expect(current.map((b) => b.object)).toEqual(['quit coffee']);
      // No retained history — only the one current row for this matter exists.
      const rows = await db.select().from(userFacts).where(eq(userFacts.id, loves.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.object).toBe('quit coffee');
    });

    it('adjusts salience (clamped) and refuses a non-owned belief', async () => {
      const belief = await store.recordBelief({
        userId,
        predicate: 'interestedIn',
        object: 'jazz',
      });
      const up = await store.adjustBeliefSalience(userId, belief.id, 0.3);
      expect(up?.salience).toBeCloseTo(0.8);
      const clamped = await store.adjustBeliefSalience(userId, belief.id, 5);
      expect(clamped?.salience).toBe(1);

      const other = await identity.ensureUserByEmail('intruder@example.com');
      expect(await store.adjustBeliefSalience(other.id, belief.id, 0.1)).toBeNull();
    });

    it('returns the nearest current beliefs for reconciliation context', async () => {
      const a = await store.recordBelief({
        userId,
        predicate: 'interestedIn',
        object: 'Rust',
        embedding: basisVector(0),
      });
      await store.recordBelief({
        userId,
        predicate: 'interestedIn',
        object: 'gardening',
        embedding: basisVector(7),
      });

      const similar = await store.findSimilarBeliefs(userId, basisVector(0), 1);
      expect(similar).toHaveLength(1);
      expect(similar[0]?.id).toBe(a.id);
    });
  });
});
