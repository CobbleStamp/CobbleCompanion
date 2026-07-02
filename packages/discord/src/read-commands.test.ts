import { describe, expect, it, vi } from 'vitest';
import type { CompanionConnection } from './bridge.js';
import type { SlashCommandContext } from './gateway/manager.js';
import type { Logger } from './gateway/types.js';
import { handleReadOnlyCommand } from './read-commands.js';
import { WsCallError } from './ws-client.js';

const silent: Logger = { error: () => {}, warn: () => {}, info: () => {} };

/** A connection that records each WS call and returns scripted results (or throws). */
class RecordingConnection implements CompanionConnection {
  readonly calls: Array<{ method: string; params: unknown }> = [];
  constructor(
    private readonly results: Record<string, unknown> = {},
    private readonly errors: Record<string, Error> = {},
  ) {}
  async connect(): Promise<void> {}
  onSuperseded(): void {}
  onClosed(): void {}
  async *chat(): AsyncIterable<never> {}
  async *callStream(): AsyncGenerator<never, undefined> {}
  async *greeting(): AsyncIterable<never> {}
  async *events(): AsyncIterable<never> {}
  close(): void {}
  async call<T>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params });
    const error = this.errors[method];
    if (error) throw error;
    return this.results[method] as T;
  }
}

function cmdCtx(
  name: string,
  options: Record<string, string> = {},
): { ctx: SlashCommandContext; replies: string[] } {
  const replies: string[] = [];
  const reply = async (content: string): Promise<void> => {
    replies.push(content);
  };
  return {
    replies,
    ctx: {
      userId: 'u1',
      command: { name, userId: 'owner-1', channelId: 'dm-1', options, reply },
      reply,
    },
  };
}

const MEMORY = {
  memory: {
    identity: { name: 'Cobble' },
    episodic: { status: 'available', messageCount: 1, episodeCount: 0 },
    semantic: { status: 'available', sourceCount: 0, sectionCount: 0, factCount: 0, jobs: [] },
    procedural: { status: 'available', procedureCount: 0 },
  },
};

describe('handleReadOnlyCommand — dispatch', () => {
  it('/memory calls memory.snapshot and renders the snapshot', async () => {
    const conn = new RecordingConnection({ 'memory.snapshot': MEMORY });
    const { ctx, replies } = cmdCtx('memory');

    await handleReadOnlyCommand(ctx, conn, silent);

    expect(conn.calls).toEqual([{ method: 'memory.snapshot', params: undefined }]);
    expect(replies[0]).toContain("Cobble's memory");
  });

  it('/recall calls memory.search with the query and topK', async () => {
    const conn = new RecordingConnection({ 'memory.search': { results: [] } });
    const { ctx, replies } = cmdCtx('recall', { query: 'ferns' });

    await handleReadOnlyCommand(ctx, conn, silent);

    expect(conn.calls[0]).toEqual({ method: 'memory.search', params: { query: 'ferns', topK: 5 } });
    expect(replies[0]).toContain('Recall — "ferns"');
  });

  it('/recall with an empty query asks for one without calling', async () => {
    const conn = new RecordingConnection();
    const { ctx, replies } = cmdCtx('recall', { query: '   ' });

    await handleReadOnlyCommand(ctx, conn, silent);

    expect(conn.calls).toHaveLength(0);
    expect(replies[0]).toContain('Give me something to search for');
  });

  it('/activity calls activity.list', async () => {
    const conn = new RecordingConnection({
      'activity.list': { outcomes: [], stats: { total: 0, positive: 0 }, nextCursor: null },
    });
    const { ctx } = cmdCtx('activity');

    await handleReadOnlyCommand(ctx, conn, silent);

    expect(conn.calls[0]?.method).toBe('activity.list');
  });

  it('/episodes with no query lists episodes', async () => {
    const conn = new RecordingConnection({ 'episodes.list': { episodes: [] } });
    const { ctx } = cmdCtx('episodes');

    await handleReadOnlyCommand(ctx, conn, silent);

    expect(conn.calls[0]?.method).toBe('episodes.list');
  });

  it('/episodes with a query searches episodes', async () => {
    const conn = new RecordingConnection({ 'episodes.search': { results: [] } });
    const { ctx } = cmdCtx('episodes', { query: 'trip' });

    await handleReadOnlyCommand(ctx, conn, silent);

    expect(conn.calls[0]).toEqual({
      method: 'episodes.search',
      params: { query: 'trip', topK: 5 },
    });
  });

  it('/growth, /budget, /reading call their methods', async () => {
    const conn = new RecordingConnection({
      'growth.get': {
        knowledge: { band: 'New', fill: 0, detail: '' },
        bond: { band: 'New', fill: 0, detail: '' },
        initiative: { band: 'New', fill: 0, detail: '' },
        character: { band: 'Forming', fill: 0, drives: [], evolvedPersona: null },
        capabilities: [],
      },
      'budget.get': { stamina: { balanceTokens: 0 }, energy: { balanceTokens: 0 } },
      'leads.list': { leads: [] },
    });

    await handleReadOnlyCommand(cmdCtx('growth').ctx, conn, silent);
    await handleReadOnlyCommand(cmdCtx('budget').ctx, conn, silent);
    await handleReadOnlyCommand(cmdCtx('reading').ctx, conn, silent);

    expect(conn.calls.map((c) => c.method)).toEqual(['growth.get', 'budget.get', 'leads.list']);
  });
});

describe('handleReadOnlyCommand — /feed', () => {
  it('with no food shows the pantry', async () => {
    const conn = new RecordingConnection({
      'food.get': { food: { ration: 2, spark: 1, treat: 0 } },
    });
    const { ctx, replies } = cmdCtx('feed');

    await handleReadOnlyCommand(ctx, conn, silent);

    expect(conn.calls[0]?.method).toBe('food.get');
    expect(replies[0]).toContain('Pantry');
  });

  it('with a valid food applies it', async () => {
    const conn = new RecordingConnection({
      feed: {
        budget: { stamina: { balanceTokens: 200_000 }, energy: { balanceTokens: 0 } },
        food: { ration: 1, spark: 1, treat: 0 },
      },
    });
    const { ctx, replies } = cmdCtx('feed', { food: 'ration' });

    await handleReadOnlyCommand(ctx, conn, silent);

    expect(conn.calls[0]).toEqual({ method: 'feed', params: { food: 'ration' } });
    expect(replies[0]).toContain('hit the spot');
  });

  it('rejects an unknown food without calling', async () => {
    const conn = new RecordingConnection();
    const { ctx, replies } = cmdCtx('feed', { food: 'pizza' });

    await handleReadOnlyCommand(ctx, conn, silent);

    expect(conn.calls).toHaveLength(0);
    expect(replies[0]).toContain('ration');
  });

  it('explains an empty pantry when feed conflicts', async () => {
    const conn = new RecordingConnection({}, { feed: new WsCallError('no spark', 'conflict') });
    const { ctx, replies } = cmdCtx('feed', { food: 'spark' });

    await handleReadOnlyCommand(ctx, conn, silent);

    expect(replies[0]).toContain('don’t have a spark');
  });
});

describe('handleReadOnlyCommand — errors', () => {
  it('turns an over_cap rejection into a feed nudge', async () => {
    const conn = new RecordingConnection(
      {},
      { 'memory.search': new WsCallError('empty', 'over_cap') },
    );
    const { ctx, replies } = cmdCtx('recall', { query: 'anything' });

    await handleReadOnlyCommand(ctx, conn, silent);

    expect(replies[0]).toContain('/feed');
  });

  it('logs and reports generically on an unexpected failure', async () => {
    const logger: Logger = { error: vi.fn(), warn: () => {}, info: () => {} };
    const conn = new RecordingConnection({}, { 'growth.get': new Error('boom') });
    const { ctx, replies } = cmdCtx('growth');

    await handleReadOnlyCommand(ctx, conn, logger);

    expect(logger.error).toHaveBeenCalledOnce();
    expect(replies[0]).toContain('went wrong');
  });

  it('replies for an unknown command name', async () => {
    const conn = new RecordingConnection();
    const { ctx, replies } = cmdCtx('mystery');

    await handleReadOnlyCommand(ctx, conn, silent);

    expect(conn.calls).toHaveLength(0);
    expect(replies[0]).toContain('don’t know that one');
  });
});

describe('handleReadOnlyCommand — /mission', () => {
  const active = {
    id: 'm-active',
    goal: 'monitor LITE',
    plan: 'poll and report',
    validationCriteria: 'told to stop',
    status: 'active',
    jobIds: ['job-1'],
    createdAt: '2026-06-28T09:00:00.000Z',
    updatedAt: '2026-07-01T14:02:00.000Z',
  };
  const stoppedNewer = { ...active, id: 'm-old', status: 'stopped' };

  it('/mission shows the active mission with its recent journal', async () => {
    const conn = new RecordingConnection({
      'mission.list': { missions: [stoppedNewer, active] },
      'mission.journal': { entries: [] },
    });
    const { ctx, replies } = cmdCtx('mission');

    await handleReadOnlyCommand(ctx, conn, silent);

    // The ACTIVE mission is shown even when a non-active one is newer in the list.
    expect(conn.calls[1]).toEqual({
      method: 'mission.journal',
      params: { missionId: 'm-active', limit: 3 },
    });
    expect(replies[0]).toContain('Mission — active');
    expect(replies[0]).toContain('monitor LITE');
  });

  it('/mission falls back to the most recent mission when none is active', async () => {
    const conn = new RecordingConnection({
      'mission.list': { missions: [stoppedNewer] },
      'mission.journal': { entries: [] },
    });
    const { ctx, replies } = cmdCtx('mission');

    await handleReadOnlyCommand(ctx, conn, silent);

    expect(conn.calls[1]?.params).toEqual({ missionId: 'm-old', limit: 3 });
    expect(replies[0]).toContain('most recent');
  });

  it('/mission with no missions says so without touching the journal', async () => {
    const conn = new RecordingConnection({ 'mission.list': { missions: [] } });
    const { ctx, replies } = cmdCtx('mission');

    await handleReadOnlyCommand(ctx, conn, silent);

    expect(conn.calls).toHaveLength(1);
    expect(replies[0]).toContain('No missions yet');
  });

  it('/mission action:stop stops the active mission and confirms', async () => {
    const conn = new RecordingConnection({
      'mission.list': { missions: [active] },
      'mission.stop': { mission: { ...active, status: 'stopped' } },
    });
    const { ctx, replies } = cmdCtx('mission', { action: 'stop' });

    await handleReadOnlyCommand(ctx, conn, silent);

    expect(conn.calls[1]).toEqual({ method: 'mission.stop', params: { missionId: 'm-active' } });
    expect(replies[0]).toContain('Mission stopped');
  });

  it('/mission action:stop with no active mission refuses without calling stop', async () => {
    const conn = new RecordingConnection({ 'mission.list': { missions: [stoppedNewer] } });
    const { ctx, replies } = cmdCtx('mission', { action: 'stop' });

    await handleReadOnlyCommand(ctx, conn, silent);

    expect(conn.calls).toHaveLength(1);
    expect(replies[0]).toContain('no active mission');
  });

  it('/mission with an unknown action explains the two forms', async () => {
    const conn = new RecordingConnection({ 'mission.list': { missions: [active] } });
    const { ctx, replies } = cmdCtx('mission', { action: 'pause' });

    await handleReadOnlyCommand(ctx, conn, silent);

    expect(replies[0]).toContain('`/mission action:stop`');
  });
});
