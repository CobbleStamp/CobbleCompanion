import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPgDatabase, type Database } from './client.js';
import {
  companions,
  EMBEDDING_DIMENSIONS,
  facts,
  ingestionJobs,
  sections,
  sources,
  users,
} from './schema.js';
import { createTestDatabase } from './testing.js';

describe('createPgDatabase', () => {
  it('builds a pooled database handle without connecting', async () => {
    const { db, pool } = createPgDatabase('postgres://user:pass@localhost:5432/cobble');
    expect(db).toBeDefined();
    expect(pool).toBeDefined();
    await pool.end();
  });
});

describe('schema (PGlite)', () => {
  let db: Database;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ({ db, close } = await createTestDatabase());
  });

  afterEach(async () => {
    await close();
  });

  it('persists a user and reads it back', async () => {
    const [user] = await db.insert(users).values({ email: 'ada@example.com' }).returning();

    expect(user?.id).toBeTypeOf('string');
    expect(user?.createdAt).toBeInstanceOf(Date);

    const found = await db.select().from(users).where(eq(users.email, 'ada@example.com'));
    expect(found).toHaveLength(1);
  });

  it('scopes a companion to its owner', async () => {
    const [user] = await db.insert(users).values({ email: 'owner@example.com' }).returning();
    const ownerId = user!.id;

    const [companion] = await db
      .insert(companions)
      .values({ ownerId, name: 'Pebble', form: 'fox', temperament: 'curious' })
      .returning();

    expect(companion?.ownerId).toBe(ownerId);
  });

  it('enforces the unique email constraint', async () => {
    await db.insert(users).values({ email: 'dup@example.com' });
    await expect(db.insert(users).values({ email: 'dup@example.com' })).rejects.toThrow();
  });
});

describe('semantic memory schema (PGlite + pgvector)', () => {
  let db: Database;
  let close: () => Promise<void>;
  let companionId: string;

  /** A unit vector with a single 1 at `hot`, so cosine distance is 0 to itself. */
  function basisVector(hot: number): number[] {
    const v: number[] = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
    v[hot] = 1;
    return v;
  }

  async function seedSection(text: string, embedding: number[]): Promise<string> {
    const [source] = await db
      .insert(sources)
      .values({ companionId, kind: 'note', title: 'Peru book', rawText: text })
      .returning();
    const [section] = await db
      .insert(sections)
      .values({
        companionId,
        sourceId: source!.id,
        topicTitle: 'topic',
        originalText: text,
        paraStart: 1,
        paraEnd: 1,
        ord: 0,
        embedding,
      })
      .returning();
    return section!.id;
  }

  beforeEach(async () => {
    ({ db, close } = await createTestDatabase());
    const [user] = await db.insert(users).values({ email: 'semantic@example.com' }).returning();
    const [companion] = await db
      .insert(companions)
      .values({ ownerId: user!.id, name: 'Pebble', form: 'fox', temperament: 'curious' })
      .returning();
    companionId = companion!.id;
  });

  afterEach(async () => {
    await close();
  });

  it('orders sections by cosine distance to a query embedding', async () => {
    const cevicheId = await seedSection('ceviche history in Lima', basisVector(0));
    await seedSection('train schedules in Cusco', basisVector(1));

    const query = basisVector(0);
    const rows = await db
      .select({ id: sections.id })
      .from(sections)
      .where(eq(sections.companionId, companionId))
      .orderBy(sql`${sections.embedding} <=> ${JSON.stringify(query)}::vector`)
      .limit(1);

    expect(rows[0]?.id).toBe(cevicheId);
  });

  it('matches sections by full-text search over the original text', async () => {
    const cevicheId = await seedSection('ceviche history in Lima', basisVector(0));
    await seedSection('train schedules in Cusco', basisVector(1));

    const rows = await db
      .select({ id: sections.id })
      .from(sections)
      .where(
        sql`${sections.companionId} = ${companionId} AND ${sections.fts} @@ plainto_tsquery('english', ${'ceviche'})`,
      );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(cevicheId);
  });

  it('tracks ingestion job progress fields', async () => {
    const [source] = await db
      .insert(sources)
      .values({ companionId, kind: 'pdf', title: 'Peru history', rawText: 'text' })
      .returning();
    const [job] = await db
      .insert(ingestionJobs)
      .values({ companionId, sourceId: source!.id })
      .returning();

    expect(job?.status).toBe('queued');
    expect(job?.sectionsDone).toBe(0);

    const [updated] = await db
      .update(ingestionJobs)
      .set({ status: 'done', sectionsTotal: 5, sectionsDone: 5 })
      .where(eq(ingestionJobs.id, job!.id))
      .returning();
    expect(updated?.status).toBe('done');
    expect(updated?.sectionsTotal).toBe(5);
  });

  it('links facts to their section for provenance and cascades on source delete', async () => {
    const sectionId = await seedSection('Pizarro founded Lima in 1535', basisVector(2));
    await db.insert(facts).values({
      companionId,
      sectionId,
      factType: 'event',
      subject: 'Pizarro',
      predicate: 'founded',
      object: 'Lima',
      confidence: 0.95,
    });

    const stored = await db.select().from(facts).where(eq(facts.sectionId, sectionId));
    expect(stored).toHaveLength(1);
    expect(stored[0]?.factType).toBe('event');

    // Deleting the companion cascades through sources → sections → facts (tenancy invariant).
    await db.delete(companions).where(eq(companions.id, companionId));
    expect(await db.select().from(sources)).toHaveLength(0);
    expect(await db.select().from(sections)).toHaveLength(0);
    expect(await db.select().from(facts)).toHaveLength(0);
  });
});
