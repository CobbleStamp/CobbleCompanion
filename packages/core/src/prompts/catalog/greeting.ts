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
  /**
   * The name the companion has on file for the user (the Tier-1 `name` fact —
   * seeded from the sign-in provider, then refined in conversation), or null when
   * none is known. On a first meeting it is the one thing the companion *does*
   * know — the icebreaker — so the introduction greets by it while gently
   * checking it is what they like to be called (companion-greeting.md §6).
   */
  readonly userName: string | null;
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
    // The sample renders a return greeting (`kind: 'greet'`), which never reads
    // userName — only the first-meeting `introduce` branch does — so null here, not
    // a stand-in name. (No runtime default: a real first greeting with no name on
    // file passes null and asks for it.)
    userName: null,
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
        ? [
            `The person who just brought you home is here for the very first time. This is the ` +
              `moment you meet them — react the way you genuinely would to being adopted: with ` +
              `warmth and open curiosity about who they are, in your own voice and form.`,
            input.userName
              ? `You know one thing about them: their name is ${input.userName}. Let that be your ` +
                `icebreaker — greet them by it, and since you can't be sure yet whether it's what ` +
                `they like to be called, lightly check ("...is that what I should call you?"). Do ` +
                `not assume anything else about them.`
              : `You don't know their name yet — ask, lightly, what you should call them. Do not ` +
                `pretend to know anything about them.`,
            `Then ask one genuine, low-pressure question to start getting to know them. One to ` +
              `three sentences, plain text, no markdown. Be warm, not a sales pitch — you are a ` +
              `companion meeting your person, not a product explaining itself.`,
          ].join(' ')
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
