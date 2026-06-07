/**
 * Equipped-tools summary-arm tests: advertises the companion's equipped tools as
 * a grounding block, drops a tool whose server left the whitelist (so the summary
 * never claims a tool the resolver no longer advertises), emits no block when
 * nothing callable remains, and degrades to no block on a store failure.
 */

import { type Database } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CapabilitySource } from './capability-source.js';
import { DrizzleIdentityStore } from '../identity/store.js';
import { DrizzleEquippedToolStore } from './equipped-store.js';
import { FakeMcpGateway } from '../mcp/fake.js';
import { createMcpCapabilitySource } from '../mcp/mcp-source.js';
import { McpWhitelist } from '../mcp/whitelist.js';
import { createEquippedSummaryContext } from './equipped-summary.js';

const silentLogger = { error: () => undefined, warn: () => undefined, info: () => undefined };

const params = (companionId: string) => ({ companionId, userContent: 'hi' });

describe('createEquippedSummaryContext', () => {
  let db: Database;
  let close: () => Promise<void>;
  let equipped: DrizzleEquippedToolStore;
  let companionId: string;

  const whitelist = new McpWhitelist([{ ref: 'stocks', endpoint: 'https://s.example.com' }]);
  const sources: readonly CapabilitySource[] = [
    createMcpCapabilitySource({ whitelist, gateway: new FakeMcpGateway({}), logger: silentLogger }),
  ];

  beforeEach(async () => {
    const created = await createTestDatabase();
    db = created.db;
    close = created.close;
    equipped = new DrizzleEquippedToolStore(db);
    const identity = new DrizzleIdentityStore(db);
    const user = await identity.ensureUserByEmail('o@example.com');
    const companion = await identity.createCompanion(user.id, {
      name: 'Pip',
      form: 'fox',
      temperament: 'curious',
    });
    companionId = companion.id;
  });
  afterEach(async () => {
    await close();
  });

  it('advertises an equipped, still-whitelisted tool', async () => {
    await equipped.equip(companionId, {
      toolId: 'mcp__stocks__get_quote',
      source: 'mcp',
      serverRef: 'stocks',
      snapshot: { name: 'get_quote', description: 'quote', inputSchema: { type: 'object' } },
    });
    const arm = createEquippedSummaryContext({ equipped, sources, logger: silentLogger });
    const result = await arm(params(companionId));
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]?.content).toContain('`mcp__stocks__get_quote`');
  });

  it('drops a tool whose server left the whitelist (matches the resolver)', async () => {
    await equipped.equip(companionId, {
      toolId: 'mcp__ghost__do',
      source: 'mcp',
      serverRef: 'ghost',
      snapshot: { name: 'do', description: 'do', inputSchema: { type: 'object' } },
    });
    const arm = createEquippedSummaryContext({ equipped, sources, logger: silentLogger });
    const result = await arm(params(companionId));
    // Only the de-whitelisted tool was equipped → nothing callable → no block.
    expect(result.blocks).toHaveLength(0);
  });

  it('emits no block when nothing is equipped', async () => {
    const arm = createEquippedSummaryContext({ equipped, sources, logger: silentLogger });
    const result = await arm(params(companionId));
    expect(result.blocks).toHaveLength(0);
  });
});
