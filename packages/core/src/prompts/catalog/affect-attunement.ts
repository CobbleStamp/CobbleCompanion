/**
 * The fast-loop attunement line (Phase 4.2, companion-motivation.md §7): the
 * companion's rolling read of the user's mood, fed forward so the next reply
 * adjusts tone, warmth, and detail. Source of truth for the attunement wording;
 * rendered by harness/context.ts only when there is a non-empty mood note.
 */

import type { PromptTemplate } from '../types.js';

/** The mood note to attune to (already trimmed, non-empty by the caller's check). */
export interface AffectAttunementInput {
  readonly note: string;
}

export const affectAttunementTemplate: PromptTemplate<AffectAttunementInput> = {
  id: 'affect-attunement',
  semver: '1.0.0',
  description: "Builds the attunement system line from the user's recent mood note.",
  sample: { note: 'relieved' },
  build: (input) => ({
    messages: [
      {
        role: 'system',
        content:
          `The user has recently seemed: ${input.note}. ` +
          'Attune your tone, warmth, and level of detail to this. ' +
          'Do not mention that you are tracking their mood.',
      },
    ],
  }),
};
