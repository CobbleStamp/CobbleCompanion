import type { SlashCommandSpec } from './gateway/types.js';

/**
 * The global slash commands registered on every bot (companion-discord.md §6),
 * DM-context enabled. `/summon` + `/status` + `/link` drive the lifecycle; the rest
 * are read-only views (T10) that run over the summoned connection — each maps to one
 * existing `/ws` method. `/recall` requires a query; `/episodes` and `/feed` take an
 * optional argument (a search query, a food to apply).
 */
export const COMMAND_SPECS: readonly SlashCommandSpec[] = [
  { name: 'summon', description: 'Bring the companion into this chat' },
  { name: 'status', description: 'Check whether the companion is here' },
  {
    name: 'link',
    description: 'Link this bot to your CobbleCompanion account',
    options: [
      {
        name: 'code',
        description: 'The link code from your CobbleCompanion settings',
        required: true,
      },
    ],
  },
  { name: 'memory', description: 'Show what the companion knows (memory snapshot)' },
  {
    name: 'recall',
    description: 'Search the companion’s reading for a topic',
    options: [{ name: 'query', description: 'What to search for', required: true }],
  },
  { name: 'activity', description: 'Show what the companion has been doing on its own' },
  {
    name: 'episodes',
    description: 'Show the companion’s recent episodes (or search them)',
    options: [{ name: 'query', description: 'Optional: search the episodes', required: false }],
  },
  {
    name: 'growth',
    description: 'Show the companion’s growth (knowledge, bond, initiative, character)',
  },
  { name: 'budget', description: 'Show the companion’s stamina and energy' },
  {
    name: 'feed',
    description: 'Show the food pantry, or give the companion a food',
    options: [
      {
        name: 'food',
        description: 'Optional: ration, spark, or treat to give',
        required: false,
      },
    ],
  },
  { name: 'reading', description: 'Show the companion’s reading list' },
];
