/** The approval-queue store: create/list/get + exactly-once resolution + tenancy. */

import { createTestDatabase } from '@cobble/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleIdentityStore } from '../identity/store.js';
import { DrizzleProposalStore } from './proposal-store.js';

describe('DrizzleProposalStore', () => {
  let close: () => Promise<void>;
  let store: DrizzleProposalStore;
  let companionId: string;
  let otherCompanionId: string;

  beforeEach(async () => {
    const created = await createTestDatabase();
    close = created.close;
    store = new DrizzleProposalStore(created.db);
    const identity = new DrizzleIdentityStore(created.db);
    const user = await identity.ensureUserByEmail('owner@example.com');
    const a = await identity.createCompanion(user.id, {
      name: 'A',
      form: 'fox',
      temperament: 'curious',
    });
    const b = await identity.createCompanion(user.id, {
      name: 'B',
      form: 'owl',
      temperament: 'calm',
    });
    companionId = a.id;
    otherCompanionId = b.id;
  });

  afterEach(async () => {
    await close();
  });

  it('creates a pending proposal and lists it', async () => {
    const created = await store.create(companionId, {
      toolName: 'ingest_source',
      toolArgs: { url: 'https://x.dev' },
      toolCallId: 'call_1',
      summary: 'Remember https://x.dev',
    });
    expect(created.status).toBe('pending');
    expect(created.toolArgs).toEqual({ url: 'https://x.dev' });

    const pending = await store.listPending(companionId);
    expect(pending.map((p) => p.id)).toEqual([created.id]);
  });

  it('resolves a pending proposal exactly once (a second confirm is a no-op)', async () => {
    const created = await store.create(companionId, {
      toolName: 'ingest_source',
      toolArgs: { url: 'https://x.dev' },
      summary: 'Remember it',
    });

    const first = await store.markResolved(companionId, created.id, 'approved');
    expect(first?.status).toBe('approved');
    expect(first?.resolvedAt).toBeInstanceOf(Date);

    // The losing race / double-confirm sees no pending row → null (no re-execute).
    const second = await store.markResolved(companionId, created.id, 'approved');
    expect(second).toBeNull();

    expect(await store.listPending(companionId)).toHaveLength(0);
  });

  it('resolves exactly once under a concurrent race (two confirms at once)', async () => {
    const created = await store.create(companionId, {
      toolName: 'ingest_source',
      toolArgs: { url: 'https://x.dev' },
      summary: 'Remember it',
    });

    // Two confirms fired together — the atomic claim (UPDATE … WHERE status =
    // 'pending') must let exactly one win, so the action can never double-execute.
    const [a, b] = await Promise.all([
      store.markResolved(companionId, created.id, 'approved'),
      store.markResolved(companionId, created.id, 'approved'),
    ]);

    const winners = [a, b].filter((row) => row !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.status).toBe('approved');
    expect(winners[0]?.resolvedAt).toBeInstanceOf(Date);
    expect(await store.listPending(companionId)).toHaveLength(0);
  });

  it('scopes get/resolve to the owning companion (tenancy)', async () => {
    const created = await store.create(companionId, {
      toolName: 'ingest_source',
      toolArgs: {},
      summary: 's',
    });
    expect(await store.get(otherCompanionId, created.id)).toBeNull();
    expect(await store.markResolved(otherCompanionId, created.id, 'rejected')).toBeNull();
    // Still pending for its real owner.
    expect((await store.get(companionId, created.id))?.status).toBe('pending');
  });
});
