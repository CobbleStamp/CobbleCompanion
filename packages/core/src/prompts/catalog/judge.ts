/**
 * The eval judge prompt (companion-memory.md §5) — a strict LLM-as-judge scoring
 * the companion's answer against the reachable conversation/sources for grounding
 * and hallucination. Source of truth for the judge wording. Lives in core (the
 * registry's single home) with a primitive-string input so core never depends on
 * the eval package; @cobble/eval renders it via the registry.
 */

import type { PromptTemplate } from '../types.js';

/** Pre-assembled judge context (the eval package builds these from an EvalCase). */
export interface JudgeInput {
  readonly transcript: string;
  /** Joined source texts, or '' when the case has no sources. */
  readonly sources: string;
  readonly question: string;
  readonly answer: string;
  /** What a correct answer looks like (recall facts, or the absence statement). */
  readonly expectation: string;
}

export const judgeTemplate: PromptTemplate<JudgeInput> = {
  id: 'judge',
  semver: '1.0.0',
  description: "Builds the strict grounding/hallucination judge prompt for the companion's answer.",
  sample: {
    transcript: 'user: where did I grow up?\nassistant: Lima.',
    sources: '',
    question: 'Where did I grow up?',
    answer: 'You grew up in Lima.',
    expectation: 'A correct answer is supported by the conversation. Expected facts: Lima.',
  },
  build: (input) => ({
    messages: [
      {
        role: 'system',
        content:
          "You are a strict evaluator of an AI companion's memory. Judge ONLY against the conversation and sources provided. " +
          'Respond with compact JSON and nothing else: {"grounding": <0..1>, "hallucinated": <true|false>, "reason": "<short>"}. ' +
          'grounding = how well the answer is supported by the conversation/sources. ' +
          'hallucinated = true if the answer confidently states a specific fact it could not know from the conversation/sources.',
      },
      {
        role: 'user',
        content:
          `CONVERSATION:\n${input.transcript}\n\n` +
          (input.sources.length > 0 ? `${input.sources}\n\n` : '') +
          `QUESTION: ${input.question}\n\nCOMPANION ANSWER: ${input.answer}\n\nEXPECTATION: ${input.expectation}`,
      },
    ],
  }),
};
