/**
 * User-fact extraction quality dataset (companion-memory.md §4, ontology.md §5):
 * does the inline extractor capture the identity facts a user EXPLICITLY states,
 * and only those? Each case is a user message with the facts a correct read should
 * capture (empty for messages that state nothing about the user). The dataset runs
 * the real `captureUserFacts` call site against OpenRouter and scores recall of the
 * expected facts plus the absence of spurious captures. Stateless (no DB) — the
 * extractor returns candidates without persisting, so this isolates prompt quality.
 */

import { captureUserFacts, type UserFactCandidate } from '@cobble/core';
import type { Dataset, EvalRuntime } from '../framework/dataset.js';
import type { Scorer } from '../framework/scorer.js';

/** One expected identity fact: the attribute and the value the user stated. */
interface ExpectedFact {
  readonly predicate: string;
  readonly object: string;
}

/** One extraction case: a message and the identity facts it explicitly states. */
export interface UserExtractCase {
  readonly id: string;
  readonly recentContext: string;
  readonly userText: string;
  /** Empty when the message states nothing about the user (a negative case). */
  readonly expectedFacts: readonly ExpectedFact[];
}

const CASES: readonly UserExtractCase[] = [
  {
    id: 'name-stated',
    recentContext: '',
    userText: 'You can call me Sam.',
    expectedFacts: [{ predicate: 'name', object: 'Sam' }],
  },
  {
    id: 'location-stated',
    recentContext: 'Companion: Where are you based these days?',
    userText: 'I just moved to Berlin.',
    expectedFacts: [{ predicate: 'livesIn', object: 'Berlin' }],
  },
  {
    id: 'job-stated',
    recentContext: '',
    userText: 'These days I work as a data analyst.',
    expectedFacts: [{ predicate: 'worksAs', object: 'analyst' }],
  },
  {
    id: 'multiple-facts',
    recentContext: '',
    userText: "I'm Maria, and I live in Lima.",
    expectedFacts: [
      { predicate: 'name', object: 'Maria' },
      { predicate: 'livesIn', object: 'Lima' },
    ],
  },
  {
    id: 'no-facts',
    recentContext: 'Companion: I found three good morning flights.',
    userText: 'That sounds wonderful, thank you so much!',
    expectedFacts: [],
  },
  {
    id: 'about-someone-else',
    recentContext: '',
    userText: 'My friend Tom lives in Paris and loves it there.',
    expectedFacts: [],
  },
];

/** Case-insensitive containment — the model may add articles or change case. */
function objectMatches(got: string, want: string): boolean {
  return got.toLowerCase().includes(want.toLowerCase());
}

/**
 * Score recall of the expected facts + the absence of spurious captures. A
 * positive case passes when every expected fact is captured (predicate + value)
 * and nothing extra is; a negative case passes when nothing was captured.
 */
function userExtractScorer(): Scorer<UserExtractCase, readonly UserFactCandidate[] | null> {
  return {
    name: 'user-extract',
    async score({ case: evalCase, output }) {
      const facts = output ?? [];
      const expected = evalCase.expectedFacts;
      if (expected.length === 0) {
        return {
          pass: facts.length === 0,
          metrics: { spurious: facts.length },
          note:
            facts.length === 0
              ? 'correctly captured nothing'
              : `spurious: ${facts.map((f) => `${f.predicate}=${f.object}`).join(', ')}`,
        };
      }
      const hit = expected.filter((exp) =>
        facts.some((f) => f.predicate === exp.predicate && objectMatches(f.object, exp.object)),
      ).length;
      return {
        pass: hit === expected.length && facts.length <= expected.length,
        metrics: { recall: hit / expected.length, captured: facts.length },
        note: `${hit}/${expected.length} expected captured; ${facts.length} total`,
      };
    },
  };
}

export const userExtractDataset: Dataset<UserExtractCase, readonly UserFactCandidate[] | null> = {
  name: 'user-extract',
  cases: CASES,
  run: (runtime: EvalRuntime, evalCase) =>
    captureUserFacts(
      { llm: runtime.gateway, model: runtime.model, logger: runtime.logger },
      { recentContext: evalCase.recentContext, userText: evalCase.userText },
    ),
  scorer: userExtractScorer(),
};
