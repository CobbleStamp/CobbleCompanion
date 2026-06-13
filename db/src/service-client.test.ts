import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from './client.js';
import { serviceRegistry } from './schema.js';
import {
  addCredential,
  listCredentials,
  revokeCredential,
  seedCredentials,
} from './service-client.js';
import { createTestDatabase } from './testing.js';

describe('service-client commands', () => {
  let db: Database;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ({ db, close } = await createTestDatabase());
  });

  afterEach(async () => {
    await close();
  });

  describe('addCredential', () => {
    it('stores a high-entropy plaintext secret and returns it once', async () => {
      const { id, secret } = await addCredential(db, 'sprout', 'initial');
      expect(id).toBeTypeOf('string');
      // 32 random bytes, base64url-encoded → 43 chars, no padding.
      expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);

      const [row] = await db.select().from(serviceRegistry).where(eq(serviceRegistry.id, id));
      expect(row?.clientId).toBe('sprout');
      expect(row?.secret).toBe(secret);
      expect(row?.secretType).toBe('plaintext');
      expect(row?.label).toBe('initial');
      expect(row?.revokedAt).toBeNull();
    });

    it('generates a distinct secret for each credential (overlap rotation)', async () => {
      const first = await addCredential(db, 'sprout');
      const second = await addCredential(db, 'sprout');
      expect(second.secret).not.toBe(first.secret);
      expect(second.id).not.toBe(first.id);
      expect(await listCredentials(db, 'sprout')).toHaveLength(2);
    });
  });

  describe('listCredentials', () => {
    it('returns metadata only — never the secret', async () => {
      const { secret } = await addCredential(db, 'sprout', 'initial');
      const [summary] = await listCredentials(db, 'sprout');
      expect(summary).toMatchObject({
        clientId: 'sprout',
        secretType: 'plaintext',
        label: 'initial',
      });
      // The secret must not be reachable through the summary projection.
      expect(JSON.stringify(summary)).not.toContain(secret);
      expect(summary).not.toHaveProperty('secret');
    });

    it('lists all clients when no client_id is given, and filters when one is', async () => {
      await addCredential(db, 'sprout');
      await addCredential(db, 'acme');
      expect(await listCredentials(db)).toHaveLength(2);
      const sproutOnly = await listCredentials(db, 'sprout');
      expect(sproutOnly).toHaveLength(1);
      expect(sproutOnly[0]?.clientId).toBe('sprout');
    });
  });

  describe('seedCredentials', () => {
    it('inserts each configured credential with the right fields', async () => {
      const { inserted, skipped } = await seedCredentials(db, [
        { clientId: 'sprout', secret: 'sprout-secret', label: 'seed' },
        { clientId: 'acme', secret: 'acme-secret' },
      ]);
      expect({ inserted, skipped }).toEqual({ inserted: 2, skipped: 0 });

      const [row] = await db
        .select()
        .from(serviceRegistry)
        .where(eq(serviceRegistry.clientId, 'sprout'));
      expect(row).toMatchObject({
        clientId: 'sprout',
        secret: 'sprout-secret',
        secretType: 'plaintext',
        label: 'seed',
      });
      expect(row?.revokedAt).toBeNull();
    });

    it('is idempotent — re-seeding the same pairs inserts nothing', async () => {
      const seeds = [{ clientId: 'sprout', secret: 'sprout-secret' }];
      const first = await seedCredentials(db, seeds);
      const second = await seedCredentials(db, seeds);
      expect(first).toEqual({ inserted: 1, skipped: 0 });
      expect(second).toEqual({ inserted: 0, skipped: 1 });
      expect(await listCredentials(db, 'sprout')).toHaveLength(1);
    });

    it('inserts a second secret for an existing client (overlap rotation)', async () => {
      await seedCredentials(db, [{ clientId: 'sprout', secret: 'old-secret' }]);
      const result = await seedCredentials(db, [
        { clientId: 'sprout', secret: 'old-secret' },
        { clientId: 'sprout', secret: 'new-secret' },
      ]);
      expect(result).toEqual({ inserted: 1, skipped: 1 });
      expect(await listCredentials(db, 'sprout')).toHaveLength(2);
    });

    it('honors an explicit secret_type', async () => {
      await seedCredentials(db, [{ clientId: 'sprout', secret: 'deadbeef', secretType: 'sha256' }]);
      const [row] = await db
        .select()
        .from(serviceRegistry)
        .where(eq(serviceRegistry.clientId, 'sprout'));
      expect(row?.secretType).toBe('sha256');
    });

    it('is a no-op for an empty seed list', async () => {
      expect(await seedCredentials(db, [])).toEqual({ inserted: 0, skipped: 0 });
      expect(await listCredentials(db)).toHaveLength(0);
    });
  });

  describe('revokeCredential', () => {
    it('soft-revokes an active credential and reports success', async () => {
      const { id } = await addCredential(db, 'sprout');
      expect(await revokeCredential(db, id)).toBe(true);

      const [row] = await db.select().from(serviceRegistry).where(eq(serviceRegistry.id, id));
      // The row is kept for audit; only revoked_at is stamped.
      expect(row?.revokedAt).not.toBeNull();
    });

    it('reports failure when the credential is already revoked', async () => {
      const { id } = await addCredential(db, 'sprout');
      expect(await revokeCredential(db, id)).toBe(true);
      expect(await revokeCredential(db, id)).toBe(false);
    });

    it('reports failure for an unknown credential id', async () => {
      expect(await revokeCredential(db, '00000000-0000-4000-8000-000000000000')).toBe(false);
    });
  });
});
