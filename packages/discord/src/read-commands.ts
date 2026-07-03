/**
 * The read-only slash-command views (companion-discord.md §6): the bridge's
 * `onReadOnlyCommand` hook. Each command runs one companion-scoped `/ws` method over
 * the summoned connection and renders the result as a single Discord reply. The bridge
 * only invokes this while embodied (the views need the live claim), so there's no
 * dormant case to handle here.
 *
 * It depends only on the {@link CompanionConnection} seam, the router context, and
 * `@cobble/shared` contracts — nothing from `@cobble/core`. The rendering is the pure
 * `command-render.ts`; this module owns the dispatch, the WS calls, and the errors.
 */

import type {
  EpisodeDto,
  MissionDto,
  MissionJournalEntryDto,
  EpisodeSearchResultDto,
  FeedResultDto,
  FoodInventoryDto,
  GrowthDto,
  LeadDto,
  MemorySnapshotDto,
  ProactiveActivityDto,
  SemanticSearchResultDto,
  StaminaEnergyDto,
} from '@cobble/shared';
import type { CompanionConnection } from './bridge.js';
import {
  clampToDiscordLimit,
  renderActivity,
  renderBudget,
  renderEpisodeSearch,
  renderEpisodes,
  renderFed,
  renderGrowth,
  renderMemory,
  renderMission,
  renderMissionStopped,
  NO_MISSIONS,
  renderPantry,
  renderReading,
  renderRecall,
} from './command-render.js';
import type { SlashCommandContext } from './gateway/manager.js';
import type { Logger } from './gateway/types.js';
import { WsCallError } from './ws-client.js';

const TIRED_NUDGE = 'I’m a little tired — `/feed` me and I’ll pick this back up.';
const GENERIC_ERROR = 'Something went wrong on my end — give me a moment and try again.';
const UNKNOWN_COMMAND = 'I don’t know that one yet.';

const FOODS = ['ration', 'spark', 'treat'] as const;
type Food = (typeof FOODS)[number];

const isFood = (value: string): value is Food => (FOODS as readonly string[]).includes(value);

/**
 * Run one read-only view over the (summoned) connection and post its rendered reply.
 * An `over_cap` rejection (only `/recall`, which spends on the search embedding) becomes
 * a feed nudge; any other failure is logged and reported generically (no detail leaked).
 */
export async function handleReadOnlyCommand(
  ctx: SlashCommandContext,
  connection: CompanionConnection,
  logger: Logger,
): Promise<void> {
  try {
    const reply = await runView(ctx, connection);
    await ctx.reply(clampToDiscordLimit(reply));
  } catch (error) {
    if (error instanceof WsCallError && error.code === 'over_cap') {
      await ctx.reply(TIRED_NUDGE);
      return;
    }
    logger.error('discord read-only command failed', {
      operation: 'discord.command',
      userId: ctx.userId,
      command: ctx.command.name,
      error,
    });
    await ctx.reply(GENERIC_ERROR);
  }
}

/** Dispatch on the command name to its `/ws` call + renderer. */
async function runView(ctx: SlashCommandContext, connection: CompanionConnection): Promise<string> {
  switch (ctx.command.name) {
    case 'memory': {
      const { memory } = await connection.call<{ memory: MemorySnapshotDto }>('memory.snapshot');
      return renderMemory(memory);
    }
    case 'recall': {
      const query = (ctx.command.options['query'] ?? '').trim();
      if (query.length === 0) return 'Give me something to search for: `/recall query:…`.';
      const { results } = await connection.call<{ results: SemanticSearchResultDto[] }>(
        'memory.search',
        { query, topK: 5 },
      );
      return renderRecall(query, results);
    }
    case 'activity': {
      const activity = await connection.call<ProactiveActivityDto>('activity.list', { limit: 6 });
      return renderActivity(activity);
    }
    case 'episodes': {
      const query = (ctx.command.options['query'] ?? '').trim();
      if (query.length === 0) {
        const { episodes } = await connection.call<{ episodes: EpisodeDto[] }>('episodes.list');
        return renderEpisodes(episodes);
      }
      const { results } = await connection.call<{ results: EpisodeSearchResultDto[] }>(
        'episodes.search',
        { query, topK: 5 },
      );
      return renderEpisodeSearch(query, results);
    }
    case 'growth': {
      const growth = await connection.call<GrowthDto>('growth.get');
      return renderGrowth(growth);
    }
    case 'budget': {
      const budget = await connection.call<StaminaEnergyDto>('budget.get');
      return renderBudget(budget);
    }
    case 'feed':
      return feedView(ctx, connection);
    case 'mission':
      return missionView(ctx, connection);
    case 'reading': {
      const { leads } = await connection.call<{ leads: LeadDto[] }>('leads.list');
      return renderReading(leads);
    }
    default:
      return UNKNOWN_COMMAND;
  }
}

/** How many journal turns the `/mission` view recalls. */
const MISSION_VIEW_JOURNAL_LIMIT = 3;

/**
 * `/mission` — inspect the active mission (goal, plan, criteria, recent journal), falling
 * back to the most recent one; `/mission action:stop` cancels the active mission's wake jobs
 * and ends it. Stop targets ONLY the `active` mission — never a draft or a finished one.
 */
async function missionView(
  ctx: SlashCommandContext,
  connection: CompanionConnection,
): Promise<string> {
  const action = (ctx.command.options['action'] ?? '').trim().toLowerCase();
  if (action.length > 0 && action !== 'stop') {
    return 'I know `/mission` (show the mission) and `/mission action:stop` (end it).';
  }
  const { missions } = await connection.call<{ missions: MissionDto[] }>('mission.list');
  const active = missions.find((mission) => mission.status === 'active') ?? null;
  if (action === 'stop') {
    if (!active) return 'There’s no active mission to stop.';
    const { mission } = await connection.call<{ mission: MissionDto }>('mission.stop', {
      missionId: active.id,
    });
    return renderMissionStopped(mission);
  }
  const shown = active ?? missions[0] ?? null; // the list is newest first
  if (!shown) return NO_MISSIONS;
  const { entries } = await connection.call<{ entries: MissionJournalEntryDto[] }>(
    'mission.journal',
    { missionId: shown.id, limit: MISSION_VIEW_JOURNAL_LIMIT },
  );
  return renderMission(shown, entries);
}

/** `/feed` — with no food, show the pantry; with a food, apply it and confirm. */
async function feedView(
  ctx: SlashCommandContext,
  connection: CompanionConnection,
): Promise<string> {
  const choice = (ctx.command.options['food'] ?? '').trim().toLowerCase();
  if (choice.length === 0) {
    const { food } = await connection.call<{ food: FoodInventoryDto }>('food.get');
    return renderPantry(food);
  }
  if (!isFood(choice)) {
    return 'I can eat a `ration`, a `spark`, or a `treat`.';
  }
  try {
    const result = await connection.call<FeedResultDto>('feed', { food: choice });
    return renderFed(choice, result);
  } catch (error) {
    // The one expected, user-actionable failure: the pantry has none of that food.
    if (error instanceof WsCallError && error.code === 'conflict') {
      return `I don’t have a ${choice} to eat right now.`;
    }
    throw error;
  }
}
