/**
 * Autonomous burst report note (Phase 4.1, companion-motivation.md §5) — the
 * "here's what I read on my own" prompt. Source of truth for the report-note
 * wording: after the companion autonomously reads leads, it posts one
 * in-character note. Rendered by motivation/autonomous-burst.ts (billed to energy).
 */

import type { PromptTemplate } from '../types.js';

/** Identity (incl. optional evolved persona) and the titles just read. */
export interface AutonomousNoteInput {
  readonly name: string;
  readonly form: string;
  readonly temperament: string;
  readonly evolvedPersona: string | null;
  readonly titles: readonly string[];
}

export const autonomousNoteTemplate: PromptTemplate<AutonomousNoteInput> = {
  id: 'autonomous-note',
  semver: '1.0.0',
  description: 'Builds the in-character note reporting an autonomous reading burst.',
  sample: {
    name: 'Pebble',
    form: 'a small fox',
    temperament: 'curious',
    evolvedPersona: null,
    titles: ['An Article'],
  },
  build: (input) => {
    const persona = input.evolvedPersona ? ` ${input.evolvedPersona}` : '';
    return {
      messages: [
        {
          role: 'system',
          content:
            `You are ${input.name}, ${input.form}. Your temperament: ${input.temperament}.` +
            persona +
            ` You speak directly, in your own voice, to the person you accompany.`,
        },
        {
          role: 'user',
          content:
            `On your own initiative, while they were away, you read these from your reading list:\n` +
            input.titles.map((title) => `- ${title}`).join('\n') +
            `\nTell them, in one or two in-character sentences, what you just did and that you can ` +
            `now talk about it. Plain text only, no markdown.`,
        },
      ],
    };
  },
};
