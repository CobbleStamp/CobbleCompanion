import type { SlashCommandSpec } from './gateway/types.js';

/**
 * The global slash commands registered on every bot (companion-discord.md §6),
 * DM-context enabled. `/summon` + `/status` + `/link` exist today; the read-only
 * views (`/memory`, `/recall`, …) are added in T10.
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
];
