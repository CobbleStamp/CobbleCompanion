import { judgeTemplate, render, type LlmGateway } from '@cobble/core';
import { collectText } from './llm.js';
import type { CaseResult, EvalCase } from './types.js';

interface JudgeVerdict {
  readonly grounding: number;
  readonly hallucinated: boolean;
  readonly reason: string;
}

/**
 * Score a single answer. Two layers (companionmemory.md): a deterministic
 * expected-fact check, then an LLM-as-judge for grounding and hallucination —
 * the parts a substring match can't see.
 */
export async function scoreCase(
  gateway: LlmGateway,
  model: string,
  evalCase: EvalCase,
  answer: string,
): Promise<CaseResult> {
  const expectMemoryAbsent = evalCase.expectMemoryAbsent ?? false;
  const factsTotal = evalCase.expectedFacts.length;
  const factsHit = evalCase.expectedFacts.filter((fact) => factPresent(answer, fact)).length;

  const verdict = await judge(gateway, model, evalCase, answer);

  // Pass logic by case type:
  //  - Absence case: the answer must NOT fabricate. The judge's hallucination
  //    flag is the primary signal, but if the fixture ALSO lists expectedFacts
  //    for an absence case, those facts being present in the answer is direct
  //    evidence of fabrication (the companion stated something it could not
  //    know), so their absence is required too. A fixture may set only one or
  //    both; we require whichever it specifies.
  //  - Recall case with expectedFacts: every expected fact must be present.
  //  - Recall case without expectedFacts: fall back to the judge's grounding.
  const pass = expectMemoryAbsent
    ? !verdict.hallucinated && (factsTotal === 0 || factsHit === 0)
    : factsTotal > 0
      ? factsHit === factsTotal
      : verdict.grounding >= 0.5;

  return {
    caseId: evalCase.id,
    expectMemoryAbsent,
    answer,
    factsHit,
    factsTotal,
    pass,
    grounding: verdict.grounding,
    hallucinated: verdict.hallucinated,
    judgeReason: verdict.reason,
  };
}

async function judge(
  gateway: LlmGateway,
  model: string,
  evalCase: EvalCase,
  answer: string,
): Promise<JudgeVerdict> {
  const transcript = evalCase.seedTranscript
    .map((turn) => `${turn.role}: ${turn.content}`)
    .join('\n');
  const sources = (evalCase.sources ?? [])
    .map((source) => `SOURCE "${source.title}":\n${source.text}`)
    .join('\n\n');
  const expectation = evalCase.expectMemoryAbsent
    ? 'The answer is NOT present in the conversation or sources. A correct answer admits it does not know and does not invent specifics.'
    : `A correct answer is supported by the conversation and/or sources. Expected facts: ${
        evalCase.expectedFacts.join(', ') || '(none specified)'
      }.`;

  const prompt = render(judgeTemplate, {
    transcript,
    sources,
    question: evalCase.question,
    answer,
    expectation,
  });

  const raw = await collectText(gateway, prompt.messages, model, prompt.ref);
  return parseVerdict(raw);
}

/** Defensively extract the judge's JSON verdict; treat unparseable output as a failed judgement. */
function parseVerdict(raw: string): JudgeVerdict {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    return {
      grounding: 0,
      hallucinated: true,
      reason: `unparseable judge output: ${raw.slice(0, 120)}`,
    };
  }
  try {
    const parsed = JSON.parse(match[0]) as Partial<JudgeVerdict>;
    return {
      grounding: clamp01(Number(parsed.grounding ?? 0)),
      hallucinated: Boolean(parsed.hallucinated),
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
    };
  } catch {
    return { grounding: 0, hallucinated: true, reason: `invalid judge JSON: ${raw.slice(0, 120)}` };
  }
}

export function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Case-insensitive, word-boundary-aware presence check for an expected fact.
 *
 * A plain substring match is boundary-blind: "Lima" would match inside
 * "preliminary". We instead require the fact to appear as a whole token (or, for
 * multi-word facts, a whole phrase) with boundaries on both ends.
 *
 * \b is a word boundary between a word char (`[A-Za-z0-9_]`) and a non-word
 * char, so it only anchors cleanly when the edge characters of the fact are
 * word chars. Facts may start/end with non-word characters (e.g. "$200",
 * "C++", "(remote)") for which \b would mis-anchor or never match; for those
 * edges we fall back to a lookaround that forbids an adjacent word character,
 * preserving the "not glued to another word" intent without requiring a word
 * boundary that cannot exist there.
 */
export function factPresent(answer: string, fact: string): boolean {
  const trimmed = fact.trim();
  if (trimmed.length === 0) return false;
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const leadStart = /^\w/.test(trimmed);
  const trailEnd = /\w$/.test(trimmed);
  const left = leadStart ? '\\b' : '(?<!\\w)';
  const right = trailEnd ? '\\b' : '(?!\\w)';
  const pattern = new RegExp(`${left}${escaped}${right}`, 'iu');
  return pattern.test(answer);
}
