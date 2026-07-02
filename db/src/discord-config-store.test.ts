import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Database } from './client.js';
import { DrizzleDiscordConfigStore } from './discord-config-store.js';
import { companions, users } from './schema.js';
import { createTestDatabase } from './testing.js';

describe('DrizzleDiscordConfigStore (PGlite)', () => {
  let db: Database;
  let close: () => Promise<void>;
  let store: DrizzleDiscordConfigStore;

  beforeEach(async () => {
    ({ db, close } = await createTestDatabase());
    store = new DrizzleDiscordConfigStore(db);
  });

  afterEach(async () => {
    await close();
  });

  async function seedUserAndCompanion(email: string): Promise<{
    userId: string;
    companionId: string;
  }> {
    const [user] = await db.insert(users).values({ email }).returning();
    const [companion] = await db
      .insert(companions)
      .values({ ownerId: user!.id, name: 'Pebble', form: 'fox', temperament: 'curious' })
      .returning();
    return { userId: user!.id, companionId: companion!.id };
  }

  it('returns null for a user with no config', async () => {
    const { userId } = await seedUserAndCompanion('none@example.com');
    expect(await store.findByUserId(userId)).toBeNull();
  });

  it('upserts a config and reads it back unlinked', async () => {
    const { userId, companionId } = await seedUserAndCompanion('a@example.com');
    const issued = new Date('2026-06-26T12:00:00Z');
    const record = await store.upsert({
      userId,
      encryptedBotToken: 'v1.a.b.c',
      boundCompanionId: companionId,
      linkCode: 'ABCD1234',
      linkCodeIssuedAt: issued,
    });

    expect(record.userId).toBe(userId);
    expect(record.boundCompanionId).toBe(companionId);
    expect(record.ownerDiscordUserId).toBeNull();
    expect(record.linkCode).toBe('ABCD1234');
    expect(record.linkCodeIssuedAt?.toISOString()).toBe(issued.toISOString());

    const found = await store.findByUserId(userId);
    expect(found?.encryptedBotToken).toBe('v1.a.b.c');
  });

  it('re-saving replaces the token and resets the owner lock + link code', async () => {
    const { userId, companionId } = await seedUserAndCompanion('b@example.com');
    await store.upsert({
      userId,
      encryptedBotToken: 'v1.old',
      boundCompanionId: companionId,
      linkCode: 'OLD',
      linkCodeIssuedAt: new Date('2026-06-26T12:00:00Z'),
    });
    await store.bindOwner(userId, 'discord-user-123', 'OLD');
    expect((await store.findByUserId(userId))?.ownerDiscordUserId).toBe('discord-user-123');

    await store.upsert({
      userId,
      encryptedBotToken: 'v1.new',
      boundCompanionId: companionId,
      linkCode: 'NEW',
      linkCodeIssuedAt: new Date('2026-06-26T13:00:00Z'),
    });
    const after = await store.findByUserId(userId);
    expect(after?.encryptedBotToken).toBe('v1.new');
    // Re-saving the token re-links: owner cleared, fresh code.
    expect(after?.ownerDiscordUserId).toBeNull();
    expect(after?.linkCode).toBe('NEW');
  });

  it('bindOwner sets the owner and clears the consumed code', async () => {
    const { userId, companionId } = await seedUserAndCompanion('c@example.com');
    await store.upsert({
      userId,
      encryptedBotToken: 'v1.a.b.c',
      boundCompanionId: companionId,
      linkCode: 'CODE',
      linkCodeIssuedAt: new Date('2026-06-26T12:00:00Z'),
    });

    const consumed = await store.bindOwner(userId, 'discord-user-999', 'CODE');
    expect(consumed).toBe(true);

    const record = await store.findByUserId(userId);
    expect(record?.ownerDiscordUserId).toBe('discord-user-999');
    expect(record?.linkCode).toBeNull();
    expect(record?.linkCodeIssuedAt).toBeNull();
  });

  it('bindOwner is single-use: a second bind with the consumed code is rejected', async () => {
    const { userId, companionId } = await seedUserAndCompanion('c2@example.com');
    await store.upsert({
      userId,
      encryptedBotToken: 'v1.a.b.c',
      boundCompanionId: companionId,
      linkCode: 'CODE',
      linkCodeIssuedAt: new Date('2026-06-26T12:00:00Z'),
    });

    const first = await store.bindOwner(userId, 'discord-first', 'CODE');
    const second = await store.bindOwner(userId, 'discord-second', 'CODE');

    expect(first).toBe(true);
    expect(second).toBe(false);
    // The first binder stays the owner — a racing second call can't overwrite it.
    expect((await store.findByUserId(userId))?.ownerDiscordUserId).toBe('discord-first');
  });

  it('bindOwner rejects a stale/wrong code without binding', async () => {
    const { userId, companionId } = await seedUserAndCompanion('c3@example.com');
    await store.upsert({
      userId,
      encryptedBotToken: 'v1.a.b.c',
      boundCompanionId: companionId,
      linkCode: 'CODE',
      linkCodeIssuedAt: new Date('2026-06-26T12:00:00Z'),
    });

    const consumed = await store.bindOwner(userId, 'discord-user-999', 'WRONG');

    expect(consumed).toBe(false);
    const record = await store.findByUserId(userId);
    expect(record?.ownerDiscordUserId).toBeNull();
    expect(record?.linkCode).toBe('CODE');
  });

  it('lists all configured bots', async () => {
    const a = await seedUserAndCompanion('list-a@example.com');
    const b = await seedUserAndCompanion('list-b@example.com');
    await store.upsert({
      userId: a.userId,
      encryptedBotToken: 'v1.a',
      boundCompanionId: a.companionId,
      linkCode: 'A',
      linkCodeIssuedAt: new Date('2026-06-26T12:00:00Z'),
    });
    await store.upsert({
      userId: b.userId,
      encryptedBotToken: 'v1.b',
      boundCompanionId: b.companionId,
      linkCode: 'B',
      linkCodeIssuedAt: new Date('2026-06-26T12:00:00Z'),
    });

    const all = await store.list();
    expect(all.map((c) => c.userId).sort()).toEqual([a.userId, b.userId].sort());
  });

  it('defaults the mission-wake pair to null and configures it independently', async () => {
    const { userId, companionId } = await seedUserAndCompanion('wake@example.com');
    await store.upsert({
      userId,
      encryptedBotToken: 'v1.a.b.c',
      boundCompanionId: companionId,
      linkCode: 'CODE',
      linkCodeIssuedAt: new Date('2026-06-26T12:00:00Z'),
    });
    // Fresh config: no mission wake yet.
    const fresh = await store.findByUserId(userId);
    expect(fresh?.triggerBotId).toBeNull();
    expect(fresh?.missionChannelId).toBeNull();

    // Link the owner, then configure the wake — the wake update must not disturb the lock.
    await store.bindOwner(userId, 'discord-owner', 'CODE');
    const configured = await store.configureMissionWake(userId, 'trigger-bot-1', 'mission-chan-1');
    expect(configured?.triggerBotId).toBe('trigger-bot-1');
    expect(configured?.missionChannelId).toBe('mission-chan-1');
    expect(configured?.ownerDiscordUserId).toBe('discord-owner');

    // A token re-save preserves the mission wake (upsert does not touch those columns).
    await store.upsert({
      userId,
      encryptedBotToken: 'v1.new',
      boundCompanionId: companionId,
      linkCode: 'NEW',
      linkCodeIssuedAt: new Date('2026-06-26T13:00:00Z'),
    });
    const afterResave = await store.findByUserId(userId);
    expect(afterResave?.triggerBotId).toBe('trigger-bot-1');
    expect(afterResave?.missionChannelId).toBe('mission-chan-1');
  });

  it('configureMissionWake returns null for a user with no config', async () => {
    const { userId } = await seedUserAndCompanion('nowake@example.com');
    expect(await store.configureMissionWake(userId, 'b', 'c')).toBeNull();
  });

  it('deletes a config', async () => {
    const { userId, companionId } = await seedUserAndCompanion('d@example.com');
    await store.upsert({
      userId,
      encryptedBotToken: 'v1.a.b.c',
      boundCompanionId: companionId,
      linkCode: 'CODE',
      linkCodeIssuedAt: new Date('2026-06-26T12:00:00Z'),
    });

    await store.delete(userId);
    expect(await store.findByUserId(userId)).toBeNull();
  });
});
