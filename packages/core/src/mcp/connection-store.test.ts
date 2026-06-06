/** DrizzleMcpConnectionStore: idempotent upsert, per-companion listing, snapshot round-trip. */

import { createTestDatabase } from '@cobble/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleIdentityStore } from '../identity/store.js';
import { DrizzleMcpConnectionStore } from './connection-store.js';
import type { McpToolDef } from './gateway.js';

const getQuote: McpToolDef = {
  name: 'get_quote',
  description: 'Get a realtime stock quote.',
  inputSchema: { type: 'object', properties: { symbol: { type: 'string' } } },
};

describe('DrizzleMcpConnectionStore', () => {
  let close: () => Promise<void>;
  let store: DrizzleMcpConnectionStore;
  let companionId: string;

  beforeEach(async () => {
    const created = await createTestDatabase();
    close = created.close;
    store = new DrizzleMcpConnectionStore(created.db);
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

  it('persists a connection with its tools snapshot and reads it back', async () => {
    await store.upsert(companionId, {
      serverRef: 'stocks',
      toolsSnapshot: [getQuote],
      status: 'connected',
    });
    const got = await store.get(companionId, 'stocks');
    expect(got?.status).toBe('connected');
    expect(got?.toolsSnapshot).toEqual([getQuote]);
    // The snapshot survives the JSON round-trip — the registry rebuilds from it.
    expect(got?.toolsSnapshot[0]?.inputSchema).toEqual(getQuote.inputSchema);
  });

  it('is idempotent per (companion, server_ref): re-connecting replaces the row', async () => {
    await store.upsert(companionId, { serverRef: 'stocks', toolsSnapshot: [], status: 'error' });
    await store.upsert(companionId, {
      serverRef: 'stocks',
      toolsSnapshot: [getQuote],
      status: 'connected',
    });
    const list = await store.list(companionId);
    expect(list).toHaveLength(1); // replaced, not duplicated
    expect(list[0]?.status).toBe('connected');
    expect(list[0]?.toolsSnapshot).toEqual([getQuote]);
  });

  it('scopes connections by companion', async () => {
    await store.upsert(companionId, {
      serverRef: 'stocks',
      toolsSnapshot: [getQuote],
      status: 'connected',
    });
    expect(await store.list('00000000-0000-0000-0000-000000000000')).toHaveLength(0);
    expect(await store.get(companionId, 'unconnected')).toBeNull();
  });
});
