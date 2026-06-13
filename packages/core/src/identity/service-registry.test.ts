import { serviceRegistry, type Database } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleServiceRegistry } from './service-registry.js';

describe('DrizzleServiceRegistry', () => {
  let db: Database;
  let registry: DrizzleServiceRegistry;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const created = await createTestDatabase();
    db = created.db;
    close = created.close;
    registry = new DrizzleServiceRegistry(db);
  });

  afterEach(async () => {
    await close();
  });

  it('authenticates a correct (client_id, plaintext secret) pair', async () => {
    await db.insert(serviceRegistry).values({ clientId: 'sprout', secret: 's3cret' });
    expect(await registry.authenticate('sprout', 's3cret')).toBe(true);
  });

  it('rejects a wrong secret and an unknown client', async () => {
    await db.insert(serviceRegistry).values({ clientId: 'sprout', secret: 's3cret' });
    expect(await registry.authenticate('sprout', 'nope')).toBe(false);
    expect(await registry.authenticate('stranger', 's3cret')).toBe(false);
  });

  it('rejects an equal-length but different secret (constant-time compare path)', async () => {
    await db.insert(serviceRegistry).values({ clientId: 'sprout', secret: 's3cret' });
    // Same length as the stored secret, so the compare reaches timingSafeEqual itself
    // rather than short-circuiting on a length mismatch.
    expect(await registry.authenticate('sprout', 'X3cret')).toBe(false);
  });

  it('accepts any of a client’s several active secrets (overlap rotation)', async () => {
    await db.insert(serviceRegistry).values([
      { clientId: 'sprout', secret: 'old', label: 'initial' },
      { clientId: 'sprout', secret: 'new', label: 'rotated' },
    ]);
    expect(await registry.authenticate('sprout', 'old')).toBe(true);
    expect(await registry.authenticate('sprout', 'new')).toBe(true);
  });

  it('stops accepting a revoked secret but keeps the row for audit', async () => {
    await db
      .insert(serviceRegistry)
      .values({ clientId: 'sprout', secret: 'old', label: 'initial' });
    await db
      .update(serviceRegistry)
      .set({ revokedAt: new Date() })
      .where(eq(serviceRegistry.secret, 'old'));
    expect(await registry.authenticate('sprout', 'old')).toBe(false);
    const [row] = await db.select().from(serviceRegistry).where(eq(serviceRegistry.secret, 'old'));
    expect(row?.revokedAt).not.toBeNull();
  });

  it('fails closed for an unknown secret_type', async () => {
    await db
      .insert(serviceRegistry)
      .values({ clientId: 'sprout', secret: 'x', secretType: 'future-scheme' });
    expect(await registry.authenticate('sprout', 'x')).toBe(false);
  });
});
