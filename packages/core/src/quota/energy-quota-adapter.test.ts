/**
 * Energy-as-quota adapter — proves the TokenQuotaStore surface faithfully drives
 * the underlying CompanionEnergyStore (so the metered ingestion pipeline +
 * announcer bill ENERGY when handed this adapter). Uses the real PGlite-backed
 * energy store, mirroring energy-store.test.ts.
 */

import { type Database } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleIdentityStore } from '../identity/store.js';
import { DrizzleCompanionEnergyStore } from './energy-store.js';
import { EnergyQuotaAdapter } from './energy-quota-adapter.js';

const DEFAULT_CAP = 1000;

describe('EnergyQuotaAdapter', () => {
  let db: Database;
  let close: () => Promise<void>;
  let companionId: string;
  let adapter: EnergyQuotaAdapter;
  let energy: DrizzleCompanionEnergyStore;

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
    energy = new DrizzleCompanionEnergyStore(db, { defaultCapTokens: DEFAULT_CAP });
    adapter = new EnergyQuotaAdapter(energy);
  });
  afterEach(async () => {
    await close();
  });

  it('reports the energy standing through the quota surface', async () => {
    const snapshot = await adapter.getUsage(companionId);
    expect(snapshot.usedTokens).toBe(0);
    expect(snapshot.capTokens).toBe(DEFAULT_CAP);
    expect(snapshot.resetsAt).toBe((await energy.getEnergy(companionId)).resetsAt);
  });

  it('records spend against energy and flips over-cap at the ceiling', async () => {
    expect(await adapter.isOverCap(companionId)).toBe(false);
    await adapter.recordUsage(companionId, DEFAULT_CAP);
    expect(await adapter.isOverCap(companionId)).toBe(true);
    expect((await energy.getEnergy(companionId)).usedTokens).toBe(DEFAULT_CAP);
  });

  it('top-up raises the effective energy cap', async () => {
    await adapter.recordUsage(companionId, DEFAULT_CAP);
    expect(await adapter.isOverCap(companionId)).toBe(true);
    await adapter.topUp(companionId, 500);
    expect(await adapter.isOverCap(companionId)).toBe(false);
    expect((await energy.getEnergy(companionId)).capTokens).toBe(DEFAULT_CAP + 500);
  });
});
