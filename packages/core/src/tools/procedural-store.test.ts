/** The procedural memory store: record a workflow, list newest-first, count. */

import { createTestDatabase } from '@cobble/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleIdentityStore } from '../identity/store.js';
import { DrizzleProceduralStore } from './procedural-store.js';

describe('DrizzleProceduralStore', () => {
  let close: () => Promise<void>;
  let store: DrizzleProceduralStore;
  let companionId: string;

  beforeEach(async () => {
    const created = await createTestDatabase();
    close = created.close;
    store = new DrizzleProceduralStore(created.db);
    const identity = new DrizzleIdentityStore(created.db);
    const user = await identity.ensureUserByEmail('owner@example.com');
    const companion = await identity.createCompanion(user.id, {
      name: 'A',
      form: 'fox',
      temperament: 'curious',
    });
    companionId = companion.id;
  });

  afterEach(async () => {
    await close();
  });

  it('records workflows and lists them newest-first with their steps', async () => {
    await store.record(companionId, 'Remember a.dev', ['ingest_source']);
    await store.record(companionId, 'Research peru food', ['web_fetch', 'ingest_source']);

    const rows = await store.list(companionId, 10);
    expect(rows.map((r) => r.title)).toEqual(['Research peru food', 'Remember a.dev']);
    expect(rows[0]!.steps).toEqual(['web_fetch', 'ingest_source']);
    expect(await store.count(companionId)).toBe(2);
  });
});
