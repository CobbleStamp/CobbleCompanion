/** The lead inventory store: idempotent capture, status listing/order, lifecycle. */

import { createTestDatabase } from '@cobble/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleIdentityStore } from '../identity/store.js';
import { DrizzleLeadStore } from './lead-store.js';

describe('DrizzleLeadStore', () => {
  let close: () => Promise<void>;
  let store: DrizzleLeadStore;
  let companionId: string;

  beforeEach(async () => {
    const created = await createTestDatabase();
    close = created.close;
    store = new DrizzleLeadStore(created.db);
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

  it('captures leads and is idempotent on (companion, url)', async () => {
    await store.record(companionId, 'https://a.dev', 'found while reading X');
    await store.record(companionId, 'https://a.dev', 'found again'); // dedup
    await store.record(companionId, 'https://b.dev');

    const list = await store.listByStatus(companionId, ['new']);
    expect(list.map((l) => l.url)).toEqual(['https://a.dev', 'https://b.dev']);
    expect(list[0]!.why).toBe('found while reading X'); // first capture kept
  });

  it('advances a lead through its lifecycle and filters by status', async () => {
    await store.record(companionId, 'https://a.dev');
    const [lead] = await store.listByStatus(companionId, ['new']);
    await store.markStatus(companionId, lead!.id, 'read');

    expect(await store.listByStatus(companionId, ['new'])).toHaveLength(0);
    expect((await store.listByStatus(companionId, ['read'])).map((l) => l.url)).toEqual([
      'https://a.dev',
    ]);
  });

  it('reaches the terminal states (ingested / discarded) and leaves the reading list', async () => {
    await store.record(companionId, 'https://ingest.dev');
    await store.record(companionId, 'https://discard.dev');
    const all = await store.listByStatus(companionId, ['new']);
    const ingest = all.find((l) => l.url === 'https://ingest.dev')!;
    const discard = all.find((l) => l.url === 'https://discard.dev')!;

    // Approve → ingested; reject → discarded (the two ways a lead leaves the list).
    await store.markStatus(companionId, ingest.id, 'ingested');
    await store.markStatus(companionId, discard.id, 'discarded');

    // Both are gone from the reading-list view (which lists only new + read).
    expect(await store.listByStatus(companionId, ['new', 'read'])).toHaveLength(0);
    expect((await store.listByStatus(companionId, ['ingested'])).map((l) => l.url)).toEqual([
      'https://ingest.dev',
    ]);
    expect((await store.listByStatus(companionId, ['discarded'])).map((l) => l.url)).toEqual([
      'https://discard.dev',
    ]);
  });
});
