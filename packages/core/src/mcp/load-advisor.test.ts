/**
 * Tool-load advisor tests: from a recalled routine's steps it names the catalog
 * tools worth picking up — in the catalog, not already equipped — de-duplicated,
 * skipping steps that aren't catalog ids (core tools / free text); degrades to
 * "none" if a lookup throws.
 */

import { type Database } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleIdentityStore } from '../identity/store.js';
import { DrizzleEquippedToolStore } from './equipped-store.js';
import { createToolLoadAdvisor, type ToolLoadAdvisorOptions } from './load-advisor.js';
import { DrizzleToolCatalogStore, type ToolCatalogStore } from './tool-catalog-store.js';

const silentLogger = { error: () => undefined, warn: () => undefined, info: () => undefined };

describe('createToolLoadAdvisor', () => {
  let db: Database;
  let close: () => Promise<void>;
  let catalog: DrizzleToolCatalogStore;
  let equipped: DrizzleEquippedToolStore;
  let companionId: string;

  beforeEach(async () => {
    const created = await createTestDatabase();
    db = created.db;
    close = created.close;
    catalog = new DrizzleToolCatalogStore(db);
    equipped = new DrizzleEquippedToolStore(db);
    const identity = new DrizzleIdentityStore(db);
    const user = await identity.ensureUserByEmail('o@example.com');
    const companion = await identity.createCompanion(user.id, {
      name: 'Pip',
      form: 'fox',
      temperament: 'curious',
    });
    companionId = companion.id;
    await catalog.upsert([
      {
        toolId: 'mcp__booking__reserve',
        source: 'mcp',
        serverRef: 'booking',
        toolName: 'reserve',
        description: '',
      },
      {
        toolId: 'mcp__stocks__get_quote',
        source: 'mcp',
        serverRef: 'stocks',
        toolName: 'get_quote',
        description: '',
      },
    ]);
  });
  afterEach(async () => {
    await close();
  });

  const advisor = (over: Partial<ToolLoadAdvisorOptions> = {}) =>
    createToolLoadAdvisor({ catalog, equipped, logger: silentLogger, ...over });

  it('suggests a catalog tool that is not equipped', async () => {
    const out = await advisor().suggestProactiveLoads(companionId, ['mcp__booking__reserve']);
    expect(out).toEqual(['mcp__booking__reserve']);
  });

  it('skips a tool already equipped', async () => {
    await equipped.equip(companionId, {
      toolId: 'mcp__booking__reserve',
      source: 'mcp',
      serverRef: 'booking',
      snapshot: { name: 'reserve', description: '', inputSchema: { type: 'object' } },
    });
    const out = await advisor().suggestProactiveLoads(companionId, [
      'mcp__booking__reserve',
      'mcp__stocks__get_quote',
    ]);
    expect(out).toEqual(['mcp__stocks__get_quote']);
  });

  it('skips steps that are not catalog ids (core tools / free text)', async () => {
    const out = await advisor().suggestProactiveLoads(companionId, [
      'web_fetch',
      'mcp__booking__reserve',
      'some freeform note',
    ]);
    expect(out).toEqual(['mcp__booking__reserve']);
  });

  it('de-duplicates and preserves first-seen order', async () => {
    const out = await advisor().suggestProactiveLoads(companionId, [
      'mcp__stocks__get_quote',
      'mcp__booking__reserve',
      'mcp__stocks__get_quote',
    ]);
    expect(out).toEqual(['mcp__stocks__get_quote', 'mcp__booking__reserve']);
  });

  it('returns none for empty steps', async () => {
    expect(await advisor().suggestProactiveLoads(companionId, [])).toEqual([]);
  });

  it('degrades to none when a lookup throws', async () => {
    const broken: ToolCatalogStore = {
      async upsert() {},
      async deleteNotIn() {},
      async list() {
        return [];
      },
      async get() {
        throw new Error('catalog down');
      },
    };
    const out = await advisor({ catalog: broken }).suggestProactiveLoads(companionId, [
      'mcp__booking__reserve',
    ]);
    expect(out).toEqual([]);
  });
});
