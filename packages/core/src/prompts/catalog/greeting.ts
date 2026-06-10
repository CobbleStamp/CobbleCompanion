/**
 * Arrival greeting (Phase 14, companion-greeting.md §5) — the prompt that voices
 * the companion's reaction when the user returns. Source of truth for the
 * greeting wording. Rendered by greeting/greeter.ts and billed to STAMINA (a
 * greeting is interaction, not solo work). The brief is assembled from
 * relationship depth × the arrival gap × the single most relevant open loop; the
 * model turns it into one short in-character greeting (never a templated string —
 * that uncanny "Welcome back!" repetition is the failure mode to avoid).
 */

import type { PromptTemplate } from '../types.js';

/** The brief a greeting is voiced from (companion-greeting.md §5). */
export interface GreetingInput {
  readonly name: string;
  readonly form: string;
  readonly temperament: string;
  readonly evolvedPersona: string | null;
  /** Tier-3 "who this person is to you" (Phase 13), appended to the voice when present. */
  readonly userPersona: string | null;
  /** `introduce` = first meeting; `greet` = an ordinary return. */
  readonly kind: 'introduce' | 'greet';
  /** A human phrase for how long they were gone (e.g. "a few hours"); null for a first meeting. */
  readonly gapPhrase: string | null;
  /** Up to ~two things already known about them — reference at most one, never list. */
  readonly knownThings: readonly string[];
  /** The single most relevant unfinished thread to pick up, or null. */
  readonly openLoop: string | null;
}

export const greetingTemplate: PromptTemplate<GreetingInput> = {
  id: 'greeting',
  semver: '1.0.0',
  description: 'Builds the in-character greeting voiced when the user arrives.',
  sample: {
    name: 'Pebble',
    form: 'a small fox',
    temperament: 'curious',
    evolvedPersona: null,
    userPersona: null,
    kind: 'greet',
    gapPhrase: 'a few hours',
    knownThings: ['they are learning Rust'],
    openLoop: 'you asked how their interview went and they never said',
  },
  build: (input) => {
    const persona =
      (input.evolvedPersona ? ` ${input.evolvedPersona}` : '') +
      (input.userPersona ? ` ${input.userPersona}` : '');
    const system =
      `You are ${input.name}, ${input.form}. Your temperament: ${input.temperament}.` +
      persona +
      ` You speak directly, in your own voice, to the person you accompany.`;

    const user =
      input.kind === 'introduce'
        ? `This is the very first time you are meeting the person you accompany — you do not know ` +
          `them yet. Introduce yourself warmly and briefly (who and what you are), say plainly that ` +
          `you grow and come to know them the more you talk, and ask one light opening question. ` +
          `Do not pretend to know anything about them. One to three sentences, plain text, no markdown.`
        : [
            `The person you accompany has just come back` +
              (input.gapPhrase ? ` after being away ${input.gapPhrase}` : '') +
              `. Greet them warmly and in character, scaled to how long they were gone.`,
            input.knownThings.length > 0
              ? `You already know a little about them: ${input.knownThings.join('; ')}. ` +
                `You may reference at most one of these naturally — never list them.`
              : '',
            input.openLoop
              ? `Pick this thread back up gently, leading with it, no pressure: ${input.openLoop}.`
              : '',
            `One to three sentences, plain text, no markdown. Do not be needy or over-familiar.`,
          ]
            .filter((line) => line.length > 0)
            .join(' ');

    return {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    };
  },
};
