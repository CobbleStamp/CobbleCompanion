/**
 * The companion's `react` tool (companion-reactions.md §5) — a free, ungated,
 * silent emoji emit bound to the message that triggered the turn. It writes a
 * `reactor='companion'` reaction row and pushes the live event; it creates no
 * outcome and no chrome.
 */

import { type Database } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InProcessCompanionEventBus } from '../events/bus.js';
import type { TurnCtx } from '../harness/hooks.js';
import { DrizzleIdentityStore } from '../identity/store.js';
import type { Logger } from '../logging.js';
import { TranscriptMemoryStore } from '../memory/store.js';
import { createReactTool } from './react-tool.js';
import { DrizzleReactionStore } from './store.js';

const silent: Logger = { error: () => {}, warn: () => {}, info: () => {} };

describe('createReactTool', () => {
  let db: Database;
  let close: () => Promise<void>;
  let companionId: string;
  let messageId: string;
  let reactions: DrizzleReactionStore;
  let bus: InProcessCompanionEventBus;
  let tool: ReturnType<typeof createReactTool>;

  function ctx(overrides: Partial<TurnCtx> = {}): TurnCtx {
    return { companionId, ownerId: 'u1', currentUserMessageId: messageId, ...overrides };
  }

  beforeEach(async () => {
    const created = await createTestDatabase();
    db = created.db;
    close = created.close;
    const identity = new DrizzleIdentityStore(db);
    const memory = new TranscriptMemoryStore(db);
    const user = await identity.ensureUserByEmail('owner@example.com');
    const companion = await identity.createCompanion(user.id, {
      name: 'Pip',
      form: 'fox',
      temperament: 'curious',
    });
    companionId = companion.id;
    const msg = await memory.appendMessage(companionId, 'user', 'can you check this?');
    messageId = msg.id;
    reactions = new DrizzleReactionStore(db);
    bus = new InProcessCompanionEventBus();
    tool = createReactTool({ reactions, eventBus: bus, logger: silent });
  });
  afterEach(async () => {
    await close();
  });

  it('is a free, ungated, silent tool', () => {
    expect(tool.name).toBe('react');
    expect(tool.effectful).toBe(false);
    expect(tool.silent).toBe(true);
  });

  it('writes a companion reaction on the triggering message and pushes it live', async () => {
    const sub = bus.subscribe(companionId);
    const result = await tool.run({ emoji: '👀' }, ctx());
    expect(result.isError).toBeUndefined();

    const rows = await reactions.listForMessages(companionId, [messageId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reactor).toBe('companion');
    expect(rows[0]?.emoji).toBe('👀');
    expect(rows[0]?.reward).toBeNull(); // expression — no reward

    const event = await sub.events.next();
    expect(event.value).toEqual({
      type: 'reaction_added',
      messageId,
      reactor: 'companion',
      emoji: '👀',
    });
    sub.close();
  });

  it('errors and writes nothing on a proactive turn (no triggering message)', async () => {
    // A proactive turn builds a ctx with no currentUserMessageId at all.
    const result = await tool.run({ emoji: '👀' }, { companionId, ownerId: 'u1' });
    expect(result.isError).toBe(true);
    expect(await reactions.listForMessages(companionId, [messageId])).toHaveLength(0);
  });

  it('rejects a missing or oversized emoji', async () => {
    expect((await tool.run({}, ctx())).isError).toBe(true);
    expect((await tool.run({ emoji: 'x'.repeat(40) }, ctx())).isError).toBe(true);
    expect(await reactions.listForMessages(companionId, [messageId])).toHaveLength(0);
  });
});
