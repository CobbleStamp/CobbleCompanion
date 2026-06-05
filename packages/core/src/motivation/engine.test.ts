/**
 * Motivation engine tick (v1, proposal-only) — idle is free, initiation works the
 * lead inventory into autonomous proposals and spends energy, and the gate
 * (dial / energy / presence) suppresses initiation. Backed by the real store.
 */

import { companions, type Database } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Logger } from '../logging.js';
import { DrizzleIdentityStore } from '../identity/store.js';
import { DrizzleCompanionEnergyStore } from '../quota/energy-store.js';
import { DrizzleLeadStore } from '../tools/lead-store.js';
import { DrizzleProposalStore } from '../tools/proposal-store.js';
import { ToolRegistry } from '../tools/registry.js';
import { MotivationEngine } from './engine.js';
import { InMemoryPresenceStore } from './presence-store.js';

const silent: Logger = { error: () => {}, warn: () => {}, info: () => {} };
const ENERGY_CAP = 10_000;
const ENERGY_PER_PROPOSAL = 100;

describe('MotivationEngine.tick', () => {
  let db: Database;
  let close: () => Promise<void>;
  let companionId: string;
  let leads: DrizzleLeadStore;
  let proposals: DrizzleProposalStore;
  let energy: DrizzleCompanionEnergyStore;
  let presence: InMemoryPresenceStore;
  let engine: MotivationEngine;

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
    energy = new DrizzleCompanionEnergyStore(db, { defaultCapTokens: ENERGY_CAP });
    presence = new InMemoryPresenceStore();
    engine = new MotivationEngine(
      {
        identity,
        presence,
        energy,
        leads,
        proposals,
        tools: new ToolRegistry([]),
        logger: silent,
      },
      { energyPerProposal: ENERGY_PER_PROPOSAL },
    );
  });
  afterEach(async () => {
    await close();
  });

  async function seedLeads(n: number): Promise<void> {
    for (let i = 0; i < n; i += 1) {
      await leads.record(companionId, `https://lead-${i}.dev`);
    }
  }

  it('stays idle (free) when there are no leads', async () => {
    // No presence signal → absent_long (may initiate), but curiosity is 0.
    const result = await engine.tick(companionId);
    expect(result.initiated).toBe(false);
    expect(result.move).toBeNull();
    expect((await energy.getEnergy(companionId)).usedTokens).toBe(0);
  });

  it('initiates autonomously when leads are pending, spending energy', async () => {
    await seedLeads(4);
    const result = await engine.tick(companionId);

    expect(result.initiated).toBe(true);
    expect(result.move?.kind).toBe('explore');
    // Default focus length 3 → three proposals.
    expect(result.proposalsCreated).toBe(3);
    const pending = await proposals.listPending(companionId);
    expect(pending).toHaveLength(3);
    expect(pending.every((p) => p.origin === 'autonomous')).toBe(true);
    // One lead left new; three advanced to read.
    expect(await leads.listByStatus(companionId, ['new'])).toHaveLength(1);
    // Energy spent for the burst.
    expect((await energy.getEnergy(companionId)).usedTokens).toBe(3 * ENERGY_PER_PROPOSAL);
  });

  it('stays idle when the dial is off', async () => {
    await seedLeads(4);
    await db
      .update(companions)
      .set({ proactivityDial: 'off' })
      .where(eq(companions.id, companionId));

    const result = await engine.tick(companionId);
    expect(result.initiated).toBe(false);
    expect(await proposals.listPending(companionId)).toHaveLength(0);
    expect((await energy.getEnergy(companionId)).usedTokens).toBe(0);
  });

  it('stops initiating when energy is exhausted (chat would still run on stamina)', async () => {
    await seedLeads(4);
    await energy.recordSpend(companionId, ENERGY_CAP); // exhaust the pool
    expect(await energy.isExhausted(companionId)).toBe(true);

    const result = await engine.tick(companionId);
    expect(result.initiated).toBe(false);
    expect(await proposals.listPending(companionId)).toHaveLength(0);
    // No further spend beyond the exhausting debit.
    expect((await energy.getEnergy(companionId)).usedTokens).toBe(ENERGY_CAP);
  });

  it('does not self-initiate while the user is actively engaged', async () => {
    await seedLeads(4);
    presence.recordActivity(companionId); // user just acted → active

    const result = await engine.tick(companionId);
    expect(result.initiated).toBe(false);
    expect(await proposals.listPending(companionId)).toHaveLength(0);
  });
});
