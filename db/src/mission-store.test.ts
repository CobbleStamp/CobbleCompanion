import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Database } from './client.js';
import { DrizzleMissionJournalStore, DrizzleMissionStore } from './mission-store.js';
import { companions, users } from './schema.js';
import { createTestDatabase } from './testing.js';

describe('DrizzleMissionStore (PGlite)', () => {
  let db: Database;
  let close: () => Promise<void>;
  let store: DrizzleMissionStore;

  beforeEach(async () => {
    ({ db, close } = await createTestDatabase());
    store = new DrizzleMissionStore(db);
  });

  afterEach(async () => {
    await close();
  });

  async function seedCompanion(email: string): Promise<string> {
    const [user] = await db.insert(users).values({ email }).returning();
    const [companion] = await db
      .insert(companions)
      .values({ ownerId: user!.id, name: 'Pebble', form: 'fox', temperament: 'curious' })
      .returning();
    return companion!.id;
  }

  const activation = {
    plan: 'poll LITE every 1s; wake on < 810',
    validationCriteria: 'user says stop',
    jobIds: ['job_1'],
    reportChannel: 'chan_1',
  };

  it('creates a draft mission with empty jobs and null plan', async () => {
    const companionId = await seedCompanion('a@example.com');
    const mission = await store.create(companionId, 'monitor LITE');

    expect(mission.goal).toBe('monitor LITE');
    expect(mission.status).toBe('draft');
    expect(mission.plan).toBeNull();
    expect(mission.validationCriteria).toBeNull();
    expect(mission.jobIds).toEqual([]);
    expect(mission.reportChannel).toBeNull();
  });

  it('activates a draft mission, applying the plan and going active', async () => {
    const companionId = await seedCompanion('b@example.com');
    const draft = await store.create(companionId, 'monitor LITE');

    const active = await store.activate(draft.id, activation);
    expect(active?.status).toBe('active');
    expect(active?.plan).toBe(activation.plan);
    expect(active?.validationCriteria).toBe(activation.validationCriteria);
    expect(active?.jobIds).toEqual(['job_1']);
    expect(active?.reportChannel).toBe('chan_1');
  });

  it('activate is guarded to the draft state: a second activate is a no-op (null)', async () => {
    const companionId = await seedCompanion('c@example.com');
    const draft = await store.create(companionId, 'monitor LITE');
    await store.activate(draft.id, activation);

    const again = await store.activate(draft.id, activation);
    expect(again).toBeNull();
  });

  it('findActive / hasActive return the single active mission', async () => {
    const companionId = await seedCompanion('d@example.com');
    expect(await store.hasActive(companionId)).toBe(false);
    expect(await store.findActive(companionId)).toBeNull();

    const draft = await store.create(companionId, 'monitor LITE');
    await store.activate(draft.id, activation);

    expect(await store.hasActive(companionId)).toBe(true);
    expect((await store.findActive(companionId))?.id).toBe(draft.id);
  });

  it('rejects a second active mission for the same companion (one-active index)', async () => {
    const companionId = await seedCompanion('e@example.com');
    const first = await store.create(companionId, 'mission one');
    await store.activate(first.id, activation);

    const second = await store.create(companionId, 'mission two');
    await expect(store.activate(second.id, activation)).rejects.toThrow();
  });

  it('allows another active mission once the prior one leaves active', async () => {
    const companionId = await seedCompanion('f@example.com');
    const first = await store.create(companionId, 'mission one');
    await store.activate(first.id, activation);
    await store.setStatus(first.id, 'stopped');

    const second = await store.create(companionId, 'mission two');
    const active = await store.activate(second.id, activation);
    expect(active?.status).toBe('active');
  });

  it('allows several draft missions to coexist; only one may be activated', async () => {
    const companionId = await seedCompanion('drafts@example.com');
    const one = await store.create(companionId, 'draft one');
    const two = await store.create(companionId, 'draft two');
    // Two drafts coexist — the one-active constraint applies only to `active`.
    expect((await store.listByCompanion(companionId)).length).toBe(2);

    await store.activate(one.id, activation);
    // The second draft cannot also activate while the first is active.
    await expect(store.activate(two.id, activation)).rejects.toThrow();
  });

  it('setStatus and setJobIds update in place', async () => {
    const companionId = await seedCompanion('g@example.com');
    const draft = await store.create(companionId, 'monitor LITE');
    await store.activate(draft.id, activation);

    const paused = await store.setStatus(draft.id, 'paused');
    expect(paused?.status).toBe('paused');

    const rearmed = await store.setJobIds(draft.id, ['job_2', 'job_3']);
    expect(rearmed?.jobIds).toEqual(['job_2', 'job_3']);
  });

  it('setStatus returns null for an unknown mission', async () => {
    expect(await store.setStatus('00000000-0000-0000-0000-000000000000', 'stopped')).toBeNull();
  });

  it('lists a companion missions newest first', async () => {
    const companionId = await seedCompanion('h@example.com');
    const one = await store.create(companionId, 'one');
    const two = await store.create(companionId, 'two');

    const list = await store.listByCompanion(companionId);
    expect(list.map((m) => m.id)).toEqual([two.id, one.id]);
  });
});

describe('DrizzleMissionJournalStore (PGlite)', () => {
  let db: Database;
  let close: () => Promise<void>;
  let missionStore: DrizzleMissionStore;
  let journal: DrizzleMissionJournalStore;

  beforeEach(async () => {
    ({ db, close } = await createTestDatabase());
    missionStore = new DrizzleMissionStore(db);
    journal = new DrizzleMissionJournalStore(db);
  });

  afterEach(async () => {
    await close();
  });

  async function seedMission(email: string): Promise<string> {
    const [user] = await db.insert(users).values({ email }).returning();
    const [companion] = await db
      .insert(companions)
      .values({ ownerId: user!.id, name: 'Pebble', form: 'fox', temperament: 'curious' })
      .returning();
    const mission = await missionStore.create(companion!.id, 'monitor LITE');
    return mission.id;
  }

  it('appends a journal row with defaulted-null content fields', async () => {
    const missionId = await seedMission('j1@example.com');
    const entry = await journal.append(missionId, { event: 'LITE is 808' });

    expect(entry.event).toBe('LITE is 808');
    expect(entry.findings).toBeNull();
    expect(entry.prediction).toBeNull();
    expect(entry.decision).toBeNull();
  });

  it('recent returns the newest rows first, capped at the limit', async () => {
    const missionId = await seedMission('j2@example.com');
    await journal.append(missionId, { findings: 'first' });
    await journal.append(missionId, { findings: 'second' });
    await journal.append(missionId, { findings: 'third' });

    const recent = await journal.recent(missionId, 2);
    expect(recent.map((r) => r.findings)).toEqual(['third', 'second']);
  });

  it('recent is scoped to the mission', async () => {
    const a = await seedMission('j3a@example.com');
    const b = await seedMission('j3b@example.com');
    await journal.append(a, { findings: 'a-only' });

    expect(await journal.recent(b, 10)).toEqual([]);
  });
});
