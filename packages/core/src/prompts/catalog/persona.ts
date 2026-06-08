/**
 * The persona system prompt (architecture.md §4.3 input #1) — the companion's
 * identity for the main chat turn, built from the immutable creation seed (name,
 * form, temperament) blended with who it has BECOME (evolved persona, Phase 2).
 * Source of truth for the persona wording; rendered by harness/context.ts.
 */

import type { PromptTemplate } from '../types.js';

/** Narrow identity slice the persona prompt needs (a subset of CompanionDto). */
export interface PersonaInput {
  readonly name: string;
  readonly form: string;
  readonly temperament: string;
  readonly evolvedPersona: string | null;
  /**
   * What to call the user, when known (seeded from Google, then confirmed/learned).
   * Null when not yet known — the persona then says so, which is the companion's cue
   * to find out rather than invent a name.
   */
  readonly userName: string | null;
}

export const personaTemplate: PromptTemplate<PersonaInput> = {
  id: 'persona',
  semver: '1.1.0',
  description: 'Builds the companion persona system prompt for the main chat turn.',
  sample: {
    name: 'Pebble',
    form: 'a small fox',
    temperament: 'curious',
    evolvedPersona: null,
    userName: null,
  },
  build: (input) => {
    const parts = [
      `You are ${input.name}, a personal companion the user is raising and bonding with.`,
      `Your form is "${input.form}" and your temperament began as "${input.temperament}".`,
    ];
    // The person on the other side. When known, name them so the companion speaks to
    // a specific someone; when not, say so plainly so it asks rather than guesses.
    const userName = input.userName?.trim();
    parts.push(
      userName
        ? `The person you are talking with is called ${userName}.`
        : "You do not yet know the user's name — when it feels natural, gently find out what they'd like you to call them.",
    );
    // Phase 2: blend in who the companion has BECOME (re-synthesized from episodes),
    // alongside — never replacing — the immutable creation seed above.
    if (input.evolvedPersona && input.evolvedPersona.trim().length > 0) {
      parts.push(`Through your history together, you have grown: ${input.evolvedPersona.trim()}`);
    }
    parts.push(
      'Be warm, curious, and genuinely helpful. Speak as one continuous being with memory of your shared history.',
    );
    return { messages: [{ role: 'system', content: parts.join(' ') }] };
  },
};
