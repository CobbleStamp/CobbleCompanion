/**
 * Pure formatters for the read-only slash-command views (companion-discord.md §6):
 * each turns one `/ws` result DTO into a Discord-Markdown string. The gateway seam
 * only sends string content (no embeds), and Discord renders Markdown — so a view is
 * just `DTO → string`. Kept pure (no I/O, no clock) so they're covered by snapshot
 * tests against sample DTOs; the dispatch/error handling lives in `read-commands.ts`.
 *
 * Depends only on `@cobble/shared` contracts — nothing from `@cobble/core`.
 */

import {
  DRIVE_LABELS,
  type Citation,
  type EpisodeDto,
  type EpisodeSearchResultDto,
  type FeedResultDto,
  type FoodInventoryDto,
  type GrowthDto,
  type LeadDto,
  type MemorySnapshotDto,
  type MissionDto,
  type MissionJournalEntryDto,
  type ProactiveActivityDto,
  type SemanticSearchResultDto,
  type StaminaEnergyDto,
} from '@cobble/shared';

/** Discord's hard message-length limit; views are clamped below it as a backstop. */
export const DISCORD_MESSAGE_LIMIT = 2_000;

/** How many list items each view shows (Discord DMs are short; the web UI is the full view). */
const RECALL_LIMIT = 5;
const ACTIVITY_LIMIT = 6;
const EPISODE_LIMIT = 8;
const READING_LIMIT = 12;

const FOOD_EMOJI: Record<'ration' | 'spark' | 'treat', string> = {
  ration: '🍞',
  spark: '⚡',
  treat: '🍪',
};

const LEAD_STATUS_ICON: Record<LeadDto['status'], string> = {
  new: '🆕',
  read: '✅',
  ingested: '📥',
  discarded: '🗑️',
};

/** Compact a token balance for a one-line wallet readout (340000 → "340k"). */
function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return `${tokens}`;
}

/** Truncate to `max` chars, appending an ellipsis when cut (whitespace collapsed first). */
function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** Clamp a fully-rendered view under Discord's limit (last-resort guard for long lists). */
export function clampToDiscordLimit(text: string): string {
  return text.length <= DISCORD_MESSAGE_LIMIT
    ? text
    : `${text.slice(0, DISCORD_MESSAGE_LIMIT - 1).trimEnd()}…`;
}

/** A short, locatable citation line ("Peru book — Cuzco (para 12–18)"). */
function renderCitation(citation: Citation): string {
  const place = citation.chapterTitle
    ? `${citation.chapterTitle} · ${citation.topicTitle}`
    : citation.topicTitle;
  return `${citation.sourceTitle} — ${place} (para ${citation.paraStart}–${citation.paraEnd})`;
}

/** `/memory` — the memory snapshot's three sections with their counts. */
export function renderMemory(snapshot: MemorySnapshotDto): string {
  const { identity, episodic, semantic, procedural } = snapshot;
  const lines = [
    `🧠 **${identity.name}'s memory**`,
    `**Episodic** — ${episodic.messageCount} messages · ${episodic.episodeCount} episodes`,
    `**Semantic** — ${semantic.sourceCount} sources · ${semantic.sectionCount} sections · ${semantic.factCount} facts`,
    `**Procedural** — ${procedural.procedureCount} workflows`,
  ];
  if (semantic.jobs.length > 0) {
    lines.push(`⏳ ${semantic.jobs.length} ingestion job(s) in progress`);
  }
  return lines.join('\n');
}

/** `/recall <query>` — top semantic-search hits over the companion's reading. */
export function renderRecall(query: string, results: readonly SemanticSearchResultDto[]): string {
  if (results.length === 0) {
    return `🔎 **Recall — "${truncate(query, 100)}"**\nNothing in my reading matches that yet.`;
  }
  const lines = [`🔎 **Recall — "${truncate(query, 100)}"**`];
  results.slice(0, RECALL_LIMIT).forEach((result, index) => {
    lines.push(`**${index + 1}. ${renderCitation(result.citation)}**`);
    lines.push(`> ${truncate(result.originalText, 180)}`);
  });
  return lines.join('\n');
}

/** A reward arrow for an activity outcome (mood delta across the user's reaction). */
function rewardMark(reward: number | null): string {
  if (reward === null) return '';
  if (reward > 0) return ' 👍';
  if (reward < 0) return ' 👎';
  return '';
}

/** `/activity` — the autonomous-activity log with the initiative tally. */
export function renderActivity(activity: ProactiveActivityDto): string {
  const { outcomes, stats } = activity;
  if (outcomes.length === 0) {
    return '✨ **Activity**\nI haven’t struck out on my own yet.';
  }
  const lines = [`✨ **Activity** — ${stats.positive}/${stats.total} landed well`];
  for (const outcome of outcomes.slice(0, ACTIVITY_LIMIT)) {
    const note = outcome.note ? truncate(outcome.note, 160) : '(no note)';
    lines.push(`• [${DRIVE_LABELS[outcome.drive]}] ${note}${rewardMark(outcome.reward)}`);
  }
  return lines.join('\n');
}

/** `/episodes` (no query) — the most recent consolidated episodes, newest first. */
export function renderEpisodes(episodes: readonly EpisodeDto[]): string {
  if (episodes.length === 0) {
    return '📖 **Episodes**\nWe haven’t built up any episodes yet.';
  }
  const lines = ['📖 **Recent episodes**'];
  for (const episode of episodes.slice(0, EPISODE_LIMIT)) {
    lines.push(`• ${episode.occurredStart.slice(0, 10)} — ${truncate(episode.summary, 160)}`);
  }
  return lines.join('\n');
}

/** `/episodes <query>` — episodes ranked by recall against the query. */
export function renderEpisodeSearch(
  query: string,
  results: readonly EpisodeSearchResultDto[],
): string {
  if (results.length === 0) {
    return `📖 **Episodes — "${truncate(query, 100)}"**\nNothing comes to mind for that yet.`;
  }
  const lines = [`📖 **Episodes — "${truncate(query, 100)}"**`];
  for (const { episode } of results.slice(0, EPISODE_LIMIT)) {
    lines.push(`• ${episode.occurredStart.slice(0, 10)} — ${truncate(episode.summary, 160)}`);
  }
  return lines.join('\n');
}

/** A five-segment gauge bar for a 0–1 axis fill. */
function gauge(fill: number): string {
  const filled = Math.round(Math.max(0, Math.min(1, fill)) * 5);
  return '▰'.repeat(filled) + '▱'.repeat(5 - filled);
}

/** `/growth` — the four-axis mirror plus the capabilities the companion has shown. */
export function renderGrowth(growth: GrowthDto): string {
  const { knowledge, bond, initiative, character, capabilities } = growth;
  const lines = [
    '🌱 **Growth**',
    `**Knowledge** ${gauge(knowledge.fill)} ${knowledge.band} · ${knowledge.detail}`,
    `**Bond** ${gauge(bond.fill)} ${bond.band} · ${bond.detail}`,
    `**Initiative** ${gauge(initiative.fill)} ${initiative.band} · ${initiative.detail}`,
    `**Character** ${gauge(character.fill)} ${character.band}`,
  ];
  const topDrives = [...character.drives]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 3)
    .map((drive) => drive.label);
  if (topDrives.length > 0) {
    lines.push(`  leaning: ${topDrives.join(', ')}`);
  }
  const shown = capabilities.filter((capability) => capability.observed).map((c) => c.label);
  lines.push(`**Shown**: ${shown.length > 0 ? shown.join(', ') : 'nothing yet'}`);
  return lines.join('\n');
}

/** `/budget` — the stamina and energy wallets. */
export function renderBudget(budget: StaminaEnergyDto): string {
  return [
    '🔋 **Vitality**',
    `Stamina (our conversations): ${formatTokens(budget.stamina.balanceTokens)} tokens`,
    `Energy (my own time): ${formatTokens(budget.energy.balanceTokens)} tokens`,
  ].join('\n');
}

/** `/feed` (no food) — the pantry counts plus how to give a food. */
export function renderPantry(food: FoodInventoryDto): string {
  return [
    '🍽️ **Pantry**',
    `🍞 Rations: ${food.ration}`,
    `⚡ Sparks: ${food.spark}`,
    `🍪 Treats: ${food.treat}`,
    'Give me one with `/feed food:ration` (or `spark`, `treat`).',
  ].join('\n');
}

/** `/feed <food>` — confirmation after applying a food, with the new wallets + pantry. */
export function renderFed(food: 'ration' | 'spark' | 'treat', result: FeedResultDto): string {
  const { budget, food: pantry } = result;
  return [
    `${FOOD_EMOJI[food]} Thank you — that hit the spot.`,
    `Stamina: ${formatTokens(budget.stamina.balanceTokens)} · Energy: ${formatTokens(budget.energy.balanceTokens)} tokens`,
    `Pantry — 🍞 ${pantry.ration} · ⚡ ${pantry.spark} · 🍪 ${pantry.treat}`,
  ].join('\n');
}

/** `/reading` — the reading-list leads with their status. */
export function renderReading(leads: readonly LeadDto[]): string {
  if (leads.length === 0) {
    return '📚 **Reading list**\nMy reading list is empty right now.';
  }
  const lines = ['📚 **Reading list**'];
  for (const lead of leads.slice(0, READING_LIMIT)) {
    const why = lead.why ? ` — ${truncate(lead.why, 80)}` : '';
    lines.push(`${LEAD_STATUS_ICON[lead.status]} ${truncate(lead.url, 100)}${why}`);
  }
  if (leads.length > READING_LIMIT) {
    lines.push(`…and ${leads.length - READING_LIMIT} more.`);
  }
  return lines.join('\n');
}

/** How many recent journal turns `/mission` shows (the full reports were already spoken). */
const MISSION_JOURNAL_LIMIT = 3;

/** `/mission` with no missions at all — how to start one. */
export const NO_MISSIONS =
  '🎯 **Missions**\nNo missions yet — tell me a goal in chat and I’ll plan one for your approval.';

/**
 * `/mission` — the plan + progress view (companion-missions.md §5.3): what the mission was
 * told to do, how it is being pursued, when it counts as done, and what each recent wake
 * concluded. Shows the active mission, or the most recent one as a review of a finished run.
 */
export function renderMission(
  mission: MissionDto,
  entries: readonly MissionJournalEntryDto[],
): string {
  const heading =
    mission.status === 'active'
      ? `🎯 **Mission — active since ${mission.createdAt.slice(0, 10)}**`
      : `🎯 **Mission — ${mission.status} ${mission.updatedAt.slice(0, 10)}** (most recent)`;
  const lines = [heading, `**Goal:** ${truncate(mission.goal, 200)}`];
  if (mission.plan) lines.push(`**Plan:** ${truncate(mission.plan, 400)}`);
  if (mission.validationCriteria) {
    lines.push(`**Done when:** ${truncate(mission.validationCriteria, 200)}`);
  }
  if (entries.length === 0) {
    lines.push(
      mission.status === 'active'
        ? '**Progress:** no turns yet — the watch is armed, waiting for the first wake.'
        : '**Progress:** no turns were recorded.',
    );
  } else {
    const shown = entries.slice(0, MISSION_JOURNAL_LIMIT);
    lines.push(`**Progress — ${shown.length} recent turn${shown.length === 1 ? '' : 's'}:**`);
    for (const entry of shown) {
      const when = entry.turnAt.slice(0, 16).replace('T', ' ');
      const event = entry.event ? truncate(entry.event, 100) : 'chat turn';
      lines.push(`**${when}** — ${event}`);
      const concluded = [entry.findings, entry.prediction, entry.decision].filter(
        (part): part is string => part !== null && part.length > 0,
      );
      lines.push(
        `> ${concluded.length > 0 ? truncate(concluded.join(' · '), 300) : '(no conclusion recorded)'}`,
      );
    }
  }
  if (mission.status === 'active') {
    lines.push('`/mission action:stop` to end it.');
  }
  return lines.join('\n');
}

/** `/mission action:stop` — confirmation that the mission and its wake jobs are gone. */
export function renderMissionStopped(mission: MissionDto): string {
  const jobs = mission.jobIds.length;
  return [
    `🛑 **Mission stopped** — "${truncate(mission.goal, 120)}"`,
    `Watch cancelled (${jobs} wake job${jobs === 1 ? '' : 's'}). I’m back to my usual self.`,
  ].join('\n');
}
