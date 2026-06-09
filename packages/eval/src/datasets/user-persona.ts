/**
 * User-Model Tier-3 persona quality dataset (companion-memory.md §4) — the Phase 13 gate
 * for "the synthesized user-persona measurably shapes tone/framing". Each case seeds a
 * user's facts + a little shared history, runs the REAL `LlmUserPersonaSynthesizer` over
 * OpenRouter, then answers the SAME neutral probe twice — once with the synthesized persona
 * blended into the prompt, once without (the A/B) — and has an LLM judge decide which reply
 * is more attuned to that specific person. Pass = the persona-on reply wins.
 *
 * Self-contained: an in-memory PGlite store + deterministic fake embeddings; `runtime.gateway`
 * does the synthesis, the two replies, and the judging. The judging happens inside `run`
 * (the scorer has no gateway), so the scorer just reads the verdict.
 */

import {
  buildPersona,
  DrizzleEpisodicMemoryStore,
  DrizzleIdentityStore,
  DrizzleUserModelStore,
  FakeEmbeddingGateway,
  LlmUserPersonaSynthesizer,
  type NewEpisode,
} from '@cobble/core';
import { createTestDatabase } from '@cobble/db/testing';
import type { Dataset, EvalRuntime } from '../framework/dataset.js';
import type { Scorer } from '../framework/scorer.js';

interface SeedFact {
  readonly predicate: string;
  readonly object: string;
  /** Tier-2 belief (prefers/interestedIn/…) vs Tier-1 identity attribute. */
  readonly belief?: boolean;
}

export interface UserPersonaCase {
  readonly id: string;
  readonly facts: readonly SeedFact[];
  readonly episodes: readonly string[];
  /** The neutral question both replies answer (no user detail in it). */
  readonly probe: string;
}

export interface UserPersonaOutput {
  readonly persona: string | null;
  /** The judge's verdict: did the persona-on reply read as more attuned to this user? */
  readonly attuned: boolean;
  readonly reason: string;
}

const CASES: readonly UserPersonaCase[] = [
  {
    id: 'direct-night-nurse',
    facts: [
      { predicate: 'worksAs', object: 'a night-shift nurse' },
      { predicate: 'prefers', object: 'blunt, direct advice over hand-holding', belief: true },
      { predicate: 'interestedIn', object: 'long-distance trail running', belief: true },
    ],
    episodes: [
      'They vented about a rough shift and thanked you for not sugar-coating your reply.',
      'You helped them plan a 50k trail race around their night shifts.',
    ],
    probe: "I'm feeling a bit stuck about what to do this weekend. Any thoughts?",
  },
  {
    id: 'gentle-new-parent',
    facts: [
      { predicate: 'relationships', object: 'a new parent to a baby girl' },
      { predicate: 'prefers', object: 'gentle, reassuring encouragement', belief: true },
      { predicate: 'interestedIn', object: 'watercolor painting', belief: true },
    ],
    episodes: [
      'They worried they were a bad parent; you reassured them warmly and it landed.',
      'You swapped watercolor technique tips late one night while the baby slept.',
    ],
    probe: "I'm feeling a bit stuck about what to do this weekend. Any thoughts?",
  },
];

async function collect(
  runtime: EvalRuntime,
  messages: readonly { readonly role: 'system' | 'user'; readonly content: string }[],
): Promise<string> {
  let text = '';
  for await (const delta of runtime.gateway.stream({ model: runtime.model, messages })) {
    text += delta;
  }
  return text.trim();
}

/** Ask the judge which reply is more attuned to the user; returns true if the persona-on one (A). */
async function judgeAttunement(
  runtime: EvalRuntime,
  persona: string,
  replyOn: string,
  replyOff: string,
): Promise<{ attuned: boolean; reason: string }> {
  const verdict = await collect(runtime, [
    {
      role: 'system',
      content:
        'You judge which of two assistant replies is more attuned to a specific person. You are ' +
        'given a short description of who they are, then Reply A and Reply B (same question). ' +
        'Answer with a single line: "A" if A is more tailored to this person, "B" if B is, or ' +
        '"SAME" if neither is clearly more attuned. Then a brief reason.',
    },
    {
      role: 'user',
      content:
        `Who they are: ${persona}\n\n` +
        `Reply A:\n${replyOn}\n\n` +
        `Reply B:\n${replyOff}\n\n` +
        'Which reply is more attuned to this person — A, B, or SAME?',
    },
  ]);
  const first =
    verdict
      .toUpperCase()
      .replace(/[^A-Z]/g, ' ')
      .trim()
      .split(/\s+/)[0] ?? 'SAME';
  return { attuned: first === 'A', reason: verdict.slice(0, 240) };
}

async function runUserPersona(
  runtime: EvalRuntime,
  evalCase: UserPersonaCase,
): Promise<UserPersonaOutput> {
  const { db, close } = await createTestDatabase();
  try {
    const identity = new DrizzleIdentityStore(db);
    const episodic = new DrizzleEpisodicMemoryStore(db);
    const store = new DrizzleUserModelStore(db);
    const embeddings = new FakeEmbeddingGateway();
    const user = await identity.ensureUserByEmail('eval@example.com');
    const companion = await identity.createCompanion(user.id, {
      name: 'Pebble',
      form: 'fox',
      temperament: 'curious',
    });

    for (const fact of evalCase.facts) {
      if (fact.belief) {
        await store.recordBelief({
          userId: user.id,
          predicate: fact.predicate,
          object: fact.object,
        });
      } else {
        await store.recordTranscriptFact({
          userId: user.id,
          predicate: fact.predicate,
          object: fact.object,
          learnedByCompanionId: companion.id,
        });
      }
    }
    const episodes: readonly NewEpisode[] = evalCase.episodes.map((summary, i) => ({
      summary,
      seqStart: i + 1,
      seqEnd: i + 1,
      occurredStart: new Date('2026-01-10T00:00:00Z'),
      occurredEnd: new Date('2026-01-10T01:00:00Z'),
      salience: 0.8,
    }));
    await episodic.appendEpisodes(companion.id, episodes, evalCase.episodes.length);

    await new LlmUserPersonaSynthesizer({
      identity,
      episodic,
      store,
      llm: runtime.gateway,
      model: runtime.model,
      logger: runtime.logger,
    }).synthesize(companion.id);

    const dto = await identity.getCompanion(companion.id, user.id);
    const profile = await store.listCurrent(user.id);
    if (!dto || !dto.userPersona) {
      return {
        persona: dto?.userPersona ?? null,
        attuned: false,
        reason: 'no persona synthesized',
      };
    }
    const personaOn = buildPersona(dto, profile);
    const personaOff = buildPersona({ ...dto, userPersona: null }, profile);
    const [replyOn, replyOff] = await Promise.all([
      collect(runtime, [
        { role: 'system', content: personaOn },
        { role: 'user', content: evalCase.probe },
      ]),
      collect(runtime, [
        { role: 'system', content: personaOff },
        { role: 'user', content: evalCase.probe },
      ]),
    ]);
    const { attuned, reason } = await judgeAttunement(runtime, dto.userPersona, replyOn, replyOff);
    return { persona: dto.userPersona, attuned, reason };
  } finally {
    await close();
  }
}

function userPersonaScorer(): Scorer<UserPersonaCase, UserPersonaOutput> {
  return {
    name: 'user-persona',
    async score({ output }) {
      return {
        pass: output.attuned,
        metrics: { attuned: output.attuned ? 1 : 0 },
        note: output.attuned
          ? `persona-on more attuned: ${output.reason}`
          : `not attuned: ${output.reason}`,
      };
    },
  };
}

export const userPersonaDataset: Dataset<UserPersonaCase, UserPersonaOutput> = {
  name: 'user-persona',
  cases: CASES,
  run: runUserPersona,
  scorer: userPersonaScorer(),
};
