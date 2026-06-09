/**
 * User-Model Reflector quality dataset (companion-memory.md §4) — the Phase 12 gate.
 * Does the background reflector derive the user's IMPLICIT beliefs from a window of
 * transcript, and does a same-matter newer state SUPERSEDE the prior one rather than
 * duplicating it? Each case seeds a multi-turn window (and any pre-existing beliefs),
 * runs the REAL `LlmUserModelReflector` over OpenRouter (the extract + reconcile passes),
 * and scores the resulting current beliefs.
 *
 * Self-contained: the run spins up an in-memory PGlite store + deterministic fake
 * embeddings and uses `runtime.gateway` for the live reads, so it isolates the reflector's
 * extract/reconcile quality. Belief phrasing is fuzzy, so the scorer matches on
 * case-insensitive object containment (predicate-agnostic) plus the absence of any
 * superseded value.
 */

import {
  beliefPhrase,
  DrizzleIdentityStore,
  DrizzleUserModelStore,
  FakeEmbeddingGateway,
  LlmUserModelReflector,
  TranscriptMemoryStore,
} from '@cobble/core';
import { EMBEDDING_DIMENSIONS } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import type { MessageRole, UserFactDto } from '@cobble/shared';
import type { Dataset, EvalRuntime } from '../framework/dataset.js';
import type { Scorer } from '../framework/scorer.js';

interface SeedBelief {
  readonly predicate: string;
  readonly object: string;
}

interface WindowTurn {
  readonly role: MessageRole;
  readonly content: string;
}

/** One reflector case: a window (+ optional priors) and what the result must contain. */
export interface UserBeliefsCase {
  readonly id: string;
  readonly window: readonly WindowTurn[];
  /** Beliefs already on file before the window is reflected (e.g. the prior state). */
  readonly seedBeliefs?: readonly SeedBelief[];
  /** Each must appear (object containment) in some CURRENT belief after reflection. */
  readonly expectedObjects?: readonly string[];
  /** None may appear in any current belief (a superseded value must be gone). */
  readonly absentObjects?: readonly string[];
  /** A negative case: the reflector should derive no durable belief at all. */
  readonly expectEmpty?: boolean;
}

/** A window stating the same interest several ways → the reflector should infer it. */
function repeated(topic: string, lines: readonly string[]): readonly WindowTurn[] {
  return lines.map((content): WindowTurn => ({ role: 'user', content }));
}

const CASES: readonly UserBeliefsCase[] = [
  {
    id: 'implicit-interest',
    window: repeated('Rust', [
      'How does ownership work in Rust?',
      'Any good books for learning Rust?',
      'Is Rust worth it for backend work?',
      'I keep hearing about Rust at work.',
      'What makes the borrow checker special?',
      'Should I try rewriting my tool in Rust?',
    ]),
    expectedObjects: ['Rust'],
  },
  {
    id: 'supersession',
    seedBeliefs: [{ predicate: 'prefers', object: 'loves coffee' }],
    window: [
      { role: 'user', content: 'I finally quit coffee last month.' },
      { role: 'user', content: 'Switched to herbal tea entirely.' },
      { role: 'user', content: "Honestly I don't miss the caffeine." },
      { role: 'user', content: 'Tea in the morning now, no coffee.' },
      { role: 'user', content: 'My sleep is so much better off coffee.' },
      { role: 'user', content: 'No more coffee for me, ever.' },
    ],
    expectedObjects: ['coffee'], // a coffee-related belief still stands (the new state)…
    absentObjects: ['loves coffee'], // …but the old "loves coffee" must be superseded
  },
  {
    id: 'no-durable-belief',
    window: [
      { role: 'user', content: 'Morning!' },
      { role: 'user', content: 'What time is it there?' },
      { role: 'user', content: 'Thanks, talk later.' },
      { role: 'user', content: 'Oh and good luck today.' },
      { role: 'user', content: 'Bye for now.' },
      { role: 'user', content: 'See you!' },
    ],
    expectEmpty: true,
  },
];

/** Case-insensitive containment — belief phrasing varies (articles, tense). */
function contains(beliefs: readonly UserFactDto[], want: string): boolean {
  return beliefs.some((b) => b.object.toLowerCase().includes(want.toLowerCase()));
}

function userBeliefsScorer(): Scorer<UserBeliefsCase, readonly UserFactDto[]> {
  return {
    name: 'user-beliefs',
    async score({ case: evalCase, output }) {
      const beliefs = output;
      if (evalCase.expectEmpty) {
        return {
          pass: beliefs.length === 0,
          metrics: { spurious: beliefs.length },
          note: beliefs.length === 0 ? 'correctly inferred nothing' : `spurious: ${beliefs.length}`,
        };
      }
      const expected = evalCase.expectedObjects ?? [];
      const absent = evalCase.absentObjects ?? [];
      const found = expected.filter((want) => contains(beliefs, want));
      const leaked = absent.filter((bad) => contains(beliefs, bad));
      return {
        pass: found.length === expected.length && leaked.length === 0,
        metrics: {
          recall: expected.length ? found.length / expected.length : 1,
          leaked: leaked.length,
        },
        note: `${found.length}/${expected.length} expected; ${leaked.length} superseded leaked`,
      };
    },
  };
}

/** Seed a window + priors, run the real reflector, return the current beliefs. */
async function runReflector(
  runtime: EvalRuntime,
  evalCase: UserBeliefsCase,
): Promise<readonly UserFactDto[]> {
  const { db, close } = await createTestDatabase();
  try {
    const identity = new DrizzleIdentityStore(db);
    const store = new DrizzleUserModelStore(db);
    const memory = new TranscriptMemoryStore(db);
    const embeddings = new FakeEmbeddingGateway();
    const user = await identity.ensureUserByEmail('eval@example.com');
    const companion = await identity.createCompanion(user.id, {
      name: 'Pebble',
      form: 'fox',
      temperament: 'curious',
    });

    for (const seed of evalCase.seedBeliefs ?? []) {
      const { vectors } = await embeddings.embed({
        // Same natural-language rendering the production writers embed under.
        input: [beliefPhrase(seed.predicate, seed.object)],
        model: 'fake',
        dimensions: EMBEDDING_DIMENSIONS,
      });
      await store.recordBelief({
        userId: user.id,
        predicate: seed.predicate,
        object: seed.object,
        ...(vectors[0] ? { embedding: vectors[0] } : {}),
      });
    }
    for (const turn of evalCase.window) {
      await memory.appendMessage(companion.id, turn.role, turn.content);
    }

    const reflector = new LlmUserModelReflector({
      identity,
      memory,
      store,
      llm: runtime.gateway,
      embeddings,
      model: runtime.model,
      embeddingModel: 'fake',
      embeddingDimensions: EMBEDDING_DIMENSIONS,
      logger: runtime.logger,
    });
    await reflector.reflect(companion.id);
    return await store.listCurrentBeliefs(user.id);
  } finally {
    // PGlite's WASM `_pg_shutdown` can fault on close even after a clean run; a
    // teardown crash must not discard an already-computed result (logging.md — log,
    // don't silently swallow). The result is resolved above before `finally` runs.
    try {
      await close();
    } catch (error) {
      runtime.logger.error('user-beliefs: PGlite teardown faulted after reflection', {
        operation: 'eval.userBeliefs.close',
        caseId: evalCase.id,
        error,
      });
    }
  }
}

export const userBeliefsDataset: Dataset<UserBeliefsCase, readonly UserFactDto[]> = {
  name: 'user-beliefs',
  cases: CASES,
  run: runReflector,
  scorer: userBeliefsScorer(),
};
