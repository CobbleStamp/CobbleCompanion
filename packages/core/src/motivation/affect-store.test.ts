/**
 * Affect store — the durable rolling read of the user's mood. Empty → null;
 * upsert then get round-trips; a second upsert overwrites (last-write-wins).
 */

import { type Database } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleIdentityStore } from '../identity/store.js';
import { DrizzleCompanionAffectStore } from './affect-store.js';

describe('DrizzleCompanionAffectStore', () => {
  let db: Database;
  let close: () => Promise<void>;
  let companionId: string;
  let store: DrizzleCompanionAffectStore;

  beforeEach(async () => {
    const created = await createTestDatabase();
    db = created.db;
    close = created.close;
    const identity = new DrizzleIdentityStore(db);
    const user = await identity.ensureUserByEmail('owner@example.com');
    const companion = await identity.createCompanion(user.id, {
      name: 'Pip',
      form: 'fox',
      temperament: 'curious',
    });
    companionId = companion.id;
    store = new DrizzleCompanionAffectStore(db);
  });
  afterEach(async () => {
    await close();
  });

  it('returns null before any read is stored', async () => {
    expect(await store.get(companionId)).toBeNull();
  });

  it('round-trips a stored reading', async () => {
    await store.upsert(companionId, { valence: 0.7, note: 'pleased' });
    expect(await store.get(companionId)).toEqual({ valence: 0.7, note: 'pleased' });
  });

  it('overwrites on a second upsert (last-write-wins)', async () => {
    await store.upsert(companionId, { valence: 0.7, note: 'pleased' });
    await store.upsert(companionId, { valence: -0.4, note: 'cooler' });
    expect(await store.get(companionId)).toEqual({ valence: -0.4, note: 'cooler' });
  });

  it('preserves an empty note', async () => {
    await store.upsert(companionId, { valence: 0, note: '' });
    expect(await store.get(companionId)).toEqual({ valence: 0, note: '' });
  });
});
