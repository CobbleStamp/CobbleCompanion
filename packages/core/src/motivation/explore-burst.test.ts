/**
 * Explore burst — proposes the next `new` leads, stamps the given origin, and
 * advances each lead to `read`. Backed by the real PGlite store.
 */

import { type Database } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleIdentityStore } from '../identity/store.js';
import { DrizzleLeadStore } from '../tools/lead-store.js';
import { DrizzleProposalStore } from '../tools/proposal-store.js';
import { ToolRegistry } from '../tools/registry.js';
import { runExploreBurst } from './explore-burst.js';

describe('runExploreBurst', () => {
  let db: Database;
  let close: () => Promise<void>;
  let companionId: string;
  let leads: DrizzleLeadStore;
  let proposals: DrizzleProposalStore;
  const tools = new ToolRegistry([]); // no ingest tool → fallback summary

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
    leads = new DrizzleLeadStore(db);
    proposals = new DrizzleProposalStore(db);
  });
  afterEach(async () => {
    await close();
  });

  it('proposes up to the limit, stamps the origin, and advances leads to read', async () => {
    await leads.record(companionId, 'https://a.dev');
    await leads.record(companionId, 'https://b.dev');
    await leads.record(companionId, 'https://c.dev');

    const created = await runExploreBurst(
      { leads, proposals, tools },
      { companionId, origin: 'autonomous', limit: 2 },
    );

    expect(created).toHaveLength(2);
    expect(created.every((p) => p.origin === 'autonomous')).toBe(true);
    expect(created.every((p) => p.toolName === 'ingest_source')).toBe(true);
    // Two advanced to read; one still new.
    expect(await leads.listByStatus(companionId, ['new'])).toHaveLength(1);
    expect(await leads.listByStatus(companionId, ['read'])).toHaveLength(2);
    // Held pending — nothing executed.
    expect(await proposals.listPending(companionId)).toHaveLength(2);
  });

  it('returns nothing when there are no new leads', async () => {
    const created = await runExploreBurst(
      { leads, proposals, tools },
      { companionId, origin: 'explore' },
    );
    expect(created).toHaveLength(0);
  });

  it('does nothing for a non-positive limit', async () => {
    await leads.record(companionId, 'https://a.dev');
    const created = await runExploreBurst(
      { leads, proposals, tools },
      { companionId, origin: 'autonomous', limit: 0 },
    );
    expect(created).toHaveLength(0);
    expect(await leads.listByStatus(companionId, ['new'])).toHaveLength(1);
  });
});
