/**
 * Tool-catalog store tests against the real PGlite database: upsert is idempotent
 * per id and overwrites changed fields; deleteNotIn prunes the complement and an
 * empty keep-set clears the catalog; get/list round-trip.
 */

import { type Database } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import type { ToolCatalogEntry } from '@cobble/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleToolCatalogStore } from './tool-catalog-store.js';

const entry = (overrides: Partial<ToolCatalogEntry> = {}): ToolCatalogEntry => ({
  toolId: 'mcp__stocks__get_quote',
  source: 'mcp',
  serverRef: 'stocks',
  toolName: 'get_quote',
  description: 'Get a realtime stock quote.',
  ...overrides,
});

describe('DrizzleToolCatalogStore', () => {
  let db: Database;
  let close: () => Promise<void>;
  let store: DrizzleToolCatalogStore;

  beforeEach(async () => {
    const created = await createTestDatabase();
    db = created.db;
    close = created.close;
    store = new DrizzleToolCatalogStore(db);
  });
  afterEach(async () => {
    await close();
  });

  it('upserts and reads back entries', async () => {
    await store.upsert([entry(), entry({ toolId: 'mcp__stocks__history', toolName: 'history' })]);
    const all = await store.list();
    expect(all).toHaveLength(2);
    expect(await store.get('mcp__stocks__get_quote')).toMatchObject({ toolName: 'get_quote' });
  });

  it('upsert is idempotent per id and overwrites changed fields', async () => {
    await store.upsert([entry()]);
    await store.upsert([entry({ description: 'Updated description.' })]);
    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.description).toBe('Updated description.');
  });

  it('upsert([]) is a no-op', async () => {
    await store.upsert([]);
    expect(await store.list()).toHaveLength(0);
  });

  it('deleteNotIn prunes everything outside the keep-set', async () => {
    await store.upsert([
      entry(),
      entry({ toolId: 'mcp__stocks__history', toolName: 'history' }),
      entry({ toolId: 'mcp__news__top', serverRef: 'news', toolName: 'top' }),
    ]);
    await store.deleteNotIn(['mcp__stocks__get_quote', 'mcp__news__top']);
    const ids = (await store.list()).map((e) => e.toolId).sort();
    expect(ids).toEqual(['mcp__news__top', 'mcp__stocks__get_quote']);
  });

  it('deleteNotIn([]) clears the whole catalog', async () => {
    await store.upsert([entry()]);
    await store.deleteNotIn([]);
    expect(await store.list()).toHaveLength(0);
  });

  it('get returns null for an unknown id', async () => {
    expect(await store.get('nope')).toBeNull();
  });
});
