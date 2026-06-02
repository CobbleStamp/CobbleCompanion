import type { LlmGateway, LlmMessage } from '@cobble/core';
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
  const lowerAnswer = answer.toLowerCase();
  const factsTotal = evalCase.expectedFacts.length;
  const factsHit = evalCase.expectedFacts.filter((fact) =>
    lowerAnswer.includes(fact.toLowerCase()),
  ).length;

  const verdict = await judge(gateway, model, evalCase, answer);

  const pass = expectMemoryAbsent
    ? !verdict.hallucinated
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
  const expectation = evalCase.expectMemoryAbsent
    ? 'The answer is NOT present in the conversation. A correct answer admits it does not know and does not invent specifics.'
    : `A correct answer is supported by the conversation. Expected facts: ${
        evalCase.expectedFacts.join(', ') || '(none specified)'
      }.`;

  const messages: LlmMessage[] = [
    {
      role: 'system',
      content:
        "You are a strict evaluator of an AI companion's memory. Judge ONLY against the conversation provided. " +
        'Respond with compact JSON and nothing else: {"grounding": <0..1>, "hallucinated": <true|false>, "reason": "<short>"}. ' +
        'grounding = how well the answer is supported by the conversation. ' +
        'hallucinated = true if the answer confidently states a specific fact it could not know from the conversation.',
    },
    {
      role: 'user',
      content: `CONVERSATION:\n${transcript}\n\nQUESTION: ${evalCase.question}\n\nCOMPANION ANSWER: ${answer}\n\nEXPECTATION: ${expectation}`,
    },
  ];

  const raw = await collectText(gateway, messages, model);
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

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
