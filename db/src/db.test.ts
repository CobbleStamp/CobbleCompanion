import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPgDatabase, type Database } from './client.js';
import { companions, users } from './schema.js';
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
