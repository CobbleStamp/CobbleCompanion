import type {
  Citation,
  EpisodeDto,
  MissionDto,
  MissionJournalEntryDto,
  FeedResultDto,
  GrowthDto,
  LeadDto,
  MemorySnapshotDto,
  ProactiveActivityDto,
  SemanticSearchResultDto,
} from '@cobble/shared';
import { describe, expect, it } from 'vitest';
import {
  clampToDiscordLimit,
  DISCORD_MESSAGE_LIMIT,
  renderActivity,
  renderBudget,
  renderEpisodes,
  renderFed,
  renderGrowth,
  renderMemory,
  renderMission,
  renderMissionStopped,
  renderPantry,
  renderReading,
  renderRecall,
} from './command-render.js';

const citation: Citation = {
  sourceId: 's1',
  sourceTitle: 'Peru Book',
  chapterTitle: 'Ch 4',
  topicTitle: 'Cuzco',
  paraStart: 12,
  paraEnd: 18,
  pageStart: null,
  pageEnd: null,
};

describe('renderMemory', () => {
  const snapshot = {
    identity: { name: 'Cobble' },
    episodic: { status: 'available', messageCount: 42, episodeCount: 3 },
    semantic: { status: 'available', sourceCount: 5, sectionCount: 120, factCount: 8, jobs: [] },
    procedural: { status: 'available', procedureCount: 2 },
  } as unknown as MemorySnapshotDto;

  it('shows the three sections with counts', () => {
    const out = renderMemory(snapshot);
    expect(out).toContain("Cobble's memory");
    expect(out).toContain('42 messages · 3 episodes');
    expect(out).toContain('5 sources · 120 sections · 8 facts');
    expect(out).toContain('2 workflows');
    expect(out).not.toContain('ingestion job');
  });

  it('notes in-progress ingestion jobs', () => {
    const withJobs = {
      ...snapshot,
      semantic: { ...snapshot.semantic, jobs: [{ id: 'j1' }] },
    } as unknown as MemorySnapshotDto;
    expect(renderMemory(withJobs)).toContain('1 ingestion job(s) in progress');
  });
});

describe('renderRecall', () => {
  it('renders a locatable citation and a snippet', () => {
    const results: SemanticSearchResultDto[] = [
      { citation, originalText: 'The Inca capital sat in a high Andean valley.', score: 0.91 },
    ];
    const out = renderRecall('inca', results);
    expect(out).toContain('Recall — "inca"');
    expect(out).toContain('Peru Book — Ch 4 · Cuzco (para 12–18)');
    expect(out).toContain('The Inca capital');
  });

  it('reports an empty result set', () => {
    expect(renderRecall('nothing', [])).toContain('Nothing in my reading matches that yet.');
  });
});

describe('renderActivity', () => {
  it('shows the tally and per-outcome drive + reward', () => {
    const activity = {
      outcomes: [
        {
          id: 'o1',
          seq: 2,
          drive: 'curiosity',
          driveSnapshot: null,
          note: 'Read about ferns.',
          belief: null,
          sources: [],
          reward: 0.3,
          resolved: true,
          createdAt: '2026-06-01T00:00:00Z',
        },
        {
          id: 'o2',
          seq: 1,
          drive: 'bond',
          driveSnapshot: null,
          note: null,
          belief: null,
          sources: [],
          reward: null,
          resolved: false,
          createdAt: '2026-05-30T00:00:00Z',
        },
      ],
      stats: { total: 2, positive: 1 },
      nextCursor: null,
    } as unknown as ProactiveActivityDto;
    const out = renderActivity(activity);
    expect(out).toContain('1/2 landed well');
    expect(out).toContain('[Curiosity] Read about ferns. 👍');
    expect(out).toContain('[Bond] (no note)');
  });

  it('handles an empty log', () => {
    const empty = { outcomes: [], stats: { total: 0, positive: 0 }, nextCursor: null };
    expect(renderActivity(empty)).toContain('haven’t struck out on my own yet');
  });
});

describe('renderEpisodes', () => {
  it('shows date-prefixed summaries', () => {
    const episodes: EpisodeDto[] = [
      {
        id: 'e1',
        summary: 'We planned the trip.',
        occurredStart: '2026-06-01T10:00:00Z',
        occurredEnd: '2026-06-01T11:00:00Z',
        salience: 0.5,
      },
    ];
    expect(renderEpisodes(episodes)).toContain('• 2026-06-01 — We planned the trip.');
  });

  it('handles no episodes', () => {
    expect(renderEpisodes([])).toContain('haven’t built up any episodes');
  });
});

describe('renderGrowth', () => {
  it('renders the four axes, leanings, and shown capabilities', () => {
    const growth = {
      knowledge: { band: 'Growing', fill: 0.4, detail: '5 sources · 8 facts' },
      bond: { band: 'Warm', fill: 0.6, detail: '42 messages' },
      initiative: { band: 'Stirring', fill: 0.2, detail: '3 acts' },
      character: {
        band: 'Forming',
        fill: 0.3,
        drives: [
          { key: 'curiosity', label: 'Curiosity', weight: 0.8 },
          { key: 'bond', label: 'Bond', weight: 0.6 },
          { key: 'upkeep', label: 'Upkeep', weight: 0.1 },
        ],
        evolvedPersona: null,
      },
      capabilities: [
        { key: 'web_research', label: 'Web research', observed: true },
        { key: 'first_routine', label: 'First routine', observed: false },
      ],
    } as unknown as GrowthDto;
    const out = renderGrowth(growth);
    expect(out).toContain('**Knowledge**');
    expect(out).toContain('Growing · 5 sources · 8 facts');
    expect(out).toContain('leaning: Curiosity, Bond, Upkeep');
    expect(out).toContain('**Shown**: Web research');
    expect(out).toContain('▰'); // a gauge bar was drawn
  });
});

describe('renderBudget', () => {
  it('compacts the wallet balances', () => {
    const out = renderBudget({
      stamina: { balanceTokens: 340_000 },
      energy: { balanceTokens: 1_200_000 },
    });
    expect(out).toContain('Stamina (our conversations): 340k tokens');
    expect(out).toContain('Energy (my own time): 1.2M tokens');
  });
});

describe('renderPantry / renderFed', () => {
  it('lists pantry counts', () => {
    const out = renderPantry({ ration: 2, spark: 0, treat: 5 });
    expect(out).toContain('🍞 Rations: 2');
    expect(out).toContain('⚡ Sparks: 0');
    expect(out).toContain('🍪 Treats: 5');
  });

  it('confirms a feed with the new wallets and pantry', () => {
    const result: FeedResultDto = {
      budget: { stamina: { balanceTokens: 540_000 }, energy: { balanceTokens: 200_000 } },
      food: { ration: 1, spark: 0, treat: 5 },
    };
    const out = renderFed('ration', result);
    expect(out).toContain('hit the spot');
    expect(out).toContain('Stamina: 540k · Energy: 200k tokens');
    expect(out).toContain('🍞 1 · ⚡ 0 · 🍪 5');
  });
});

describe('renderReading', () => {
  it('renders leads with status icons and a why', () => {
    const leads: LeadDto[] = [
      {
        id: 'l1',
        url: 'https://example.com/ferns',
        why: 'mentioned while reading',
        status: 'new',
        createdAt: '2026-06-01T00:00:00Z',
      },
    ];
    const out = renderReading(leads);
    expect(out).toContain('🆕 https://example.com/ferns — mentioned while reading');
  });

  it('handles an empty list', () => {
    expect(renderReading([])).toContain('reading list is empty');
  });

  it('caps the list and notes the remainder', () => {
    const leads: LeadDto[] = Array.from({ length: 15 }, (_, i) => ({
      id: `l${i}`,
      url: `https://example.com/${i}`,
      why: null,
      status: 'new' as const,
      createdAt: '2026-06-01T00:00:00Z',
    }));
    expect(renderReading(leads)).toContain('…and 3 more.');
  });
});

describe('clampToDiscordLimit', () => {
  it('leaves a short message unchanged', () => {
    expect(clampToDiscordLimit('hello')).toBe('hello');
  });

  it('truncates an over-long message under the limit', () => {
    const long = 'x'.repeat(DISCORD_MESSAGE_LIMIT + 500);
    const out = clampToDiscordLimit(long);
    expect(out.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('renderMission', () => {
  const mission: MissionDto = {
    id: 'm1',
    goal: 'monitor LITE and warn on a drop below $810',
    plan: 'poll the quote each wake; scan news for the driver; report move + outlook',
    validationCriteria: 'LITE closes below $810 and the drop is reported',
    status: 'active',
    jobIds: ['job-1'],
    createdAt: '2026-06-28T09:00:00.000Z',
    updatedAt: '2026-07-01T14:02:00.000Z',
  };
  const entry: MissionJournalEntryDto = {
    id: 'e1',
    missionId: 'm1',
    event: 'LITE is 809.40 — −3.2% on the session',
    findings: 'Broke through 810 on the Fed minutes; volume 2.1× average.',
    prediction: null,
    decision: null,
    turnAt: '2026-07-01T14:02:00.000Z',
  };

  it('renders goal, plan, criteria, and the journal timeline for an active mission', () => {
    const out = renderMission(mission, [entry]);
    expect(out).toContain('Mission — active since 2026-06-28');
    expect(out).toContain('**Goal:** monitor LITE and warn on a drop below $810');
    expect(out).toContain('**Plan:** poll the quote each wake');
    expect(out).toContain('**Done when:** LITE closes below $810');
    expect(out).toContain('2026-07-01 14:02');
    expect(out).toContain('LITE is 809.40');
    expect(out).toContain('> Broke through 810 on the Fed minutes');
    expect(out).toContain('`/mission action:stop`');
  });

  it('says the watch is armed when an active mission has no turns yet', () => {
    const out = renderMission(mission, []);
    expect(out).toContain('no turns yet');
  });

  it('heads a non-active mission with its status and drops the stop hint', () => {
    const stopped = { ...mission, status: 'stopped' as const };
    const out = renderMission(stopped, [entry]);
    expect(out).toContain('Mission — stopped 2026-07-01');
    expect(out).toContain('(most recent)');
    expect(out).not.toContain('action:stop');
  });

  it('marks an entry with no conclusion and truncates long fields', () => {
    const bare: MissionJournalEntryDto = { ...entry, findings: null };
    const long = { ...mission, plan: 'p'.repeat(2_000) };
    const out = renderMission(long, [bare]);
    expect(out).toContain('(no conclusion recorded)');
    expect(out.length).toBeLessThan(1_200);
  });
});

describe('renderMissionStopped', () => {
  it('confirms the stop with the goal and the cancelled job count', () => {
    const out = renderMissionStopped({
      id: 'm1',
      goal: 'monitor LITE and warn on a drop below $810',
      plan: 'p',
      validationCriteria: 'c',
      status: 'stopped',
      jobIds: ['job-1'],
      createdAt: '2026-06-28T09:00:00.000Z',
      updatedAt: '2026-07-02T10:00:00.000Z',
    });
    expect(out).toContain('Mission stopped');
    expect(out).toContain('monitor LITE');
    expect(out).toContain('1 wake job');
  });
});
