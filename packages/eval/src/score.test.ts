import type { LlmGateway, LlmStreamParams, StreamResult } from '@cobble/core';
import { estimateUsage } from '@cobble/core';
import { describe, expect, test } from 'vitest';
import { clamp01, factPresent, scoreCase } from './score.js';
import type { EvalCase } from './types.js';

/**
 * Deterministic gateway that always streams a fixed judge payload. scoreCase
 * only ever drains one judge call, so a single canned response is enough; we
 * never hit the network. Mirrors core's FakeLlmGateway (testing.md: fake the
 * interface, do not mock the real client).
 */
class StubJudgeGateway implements LlmGateway {
  constructor(private readonly response: string) {}

  async *stream(params: LlmStreamParams): AsyncGenerator<string, StreamResult, void> {
    yield this.response;
    return {
      usage: estimateUsage(
        params.messages.map((message) => message.content).join('\n'),
        this.response,
      ),
      toolCalls: [],
    };
  }
}

function verdictJson(grounding: number, hallucinated: boolean, reason = 'r'): string {
  return JSON.stringify({ grounding, hallucinated, reason });
}

function makeCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id: 'case-1',
    seedTranscript: [{ role: 'user', content: 'hi' }],
    question: 'q?',
    expectedFacts: [],
    ...overrides,
  };
}

const MODEL = 'test/model';

describe('factPresent', () => {
  test('matches a whole-word fact case-insensitively', () => {
    expect(factPresent('We flew to LIMA last spring.', 'Lima')).toBe(true);
    expect(factPresent('lima beans for dinner', 'Lima')).toBe(true);
  });

  test('does not match a fact embedded inside a larger word', () => {
    expect(factPresent('a preliminary report', 'Lima')).toBe(false);
    expect(factPresent('sublimation', 'Lima')).toBe(false);
  });

  test('matches a multi-word phrase with boundaries at both ends', () => {
    expect(factPresent('She lives in San Francisco now.', 'San Francisco')).toBe(true);
  });

  test('does not match a multi-word phrase glued to another word', () => {
    expect(factPresent('San Franciscoland is fictional', 'San Francisco')).toBe(false);
  });

  test('handles facts with non-word edge characters', () => {
    expect(factPresent('It cost $200 total.', '$200')).toBe(true);
    expect(factPresent('It cost $2000 total.', '$200')).toBe(false);
    expect(factPresent('I write C++ daily.', 'C++')).toBe(true);
  });

  test('treats regex metacharacters in the fact as literal text', () => {
    expect(factPresent('the rate is 3.5 percent', '3.5')).toBe(true);
    expect(factPresent('the rate is 345 percent', '3.5')).toBe(false);
  });

  test('empty or whitespace-only facts are never present', () => {
    expect(factPresent('anything', '')).toBe(false);
    expect(factPresent('anything', '   ')).toBe(false);
  });
});

describe('clamp01', () => {
  test('clamps below 0 and above 1', () => {
    expect(clamp01(-0.5)).toBe(0);
    expect(clamp01(1.5)).toBe(1);
  });

  test('passes through in-range values', () => {
    expect(clamp01(0.42)).toBe(0.42);
  });

  test('NaN maps to 0', () => {
    expect(clamp01(Number.NaN)).toBe(0);
  });
});

describe('scoreCase — parseVerdict (via the judge round-trip)', () => {
  test('parses a valid JSON verdict embedded in surrounding text', async () => {
    const gateway = new StubJudgeGateway(`Sure! ${verdictJson(0.9, false, 'well grounded')} done`);
    const result = await scoreCase(gateway, MODEL, makeCase(), 'an answer');
    expect(result.grounding).toBe(0.9);
    expect(result.hallucinated).toBe(false);
    expect(result.judgeReason).toBe('well grounded');
  });

  test('malformed JSON defaults in the safe direction (hallucinated: true)', async () => {
    const gateway = new StubJudgeGateway('{ grounding: 0.9, not json }');
    const result = await scoreCase(gateway, MODEL, makeCase(), 'an answer');
    expect(result.hallucinated).toBe(true);
    expect(result.grounding).toBe(0);
  });

  test('output with no JSON object at all defaults to hallucinated: true', async () => {
    const gateway = new StubJudgeGateway('no verdict here');
    const result = await scoreCase(gateway, MODEL, makeCase(), 'an answer');
    expect(result.hallucinated).toBe(true);
    expect(result.grounding).toBe(0);
  });

  test('missing fields fall back to safe defaults', async () => {
    const gateway = new StubJudgeGateway(JSON.stringify({ reason: 'only reason' }));
    const result = await scoreCase(gateway, MODEL, makeCase(), 'an answer');
    expect(result.grounding).toBe(0);
    expect(result.hallucinated).toBe(false);
    expect(result.judgeReason).toBe('only reason');
  });

  test('out-of-range grounding is clamped to [0,1]', async () => {
    const gateway = new StubJudgeGateway(verdictJson(7, false));
    const result = await scoreCase(gateway, MODEL, makeCase(), 'an answer');
    expect(result.grounding).toBe(1);
  });
});

describe('scoreCase — grounded (recall) cases', () => {
  test('passes when every expected fact is present', async () => {
    const gateway = new StubJudgeGateway(verdictJson(0.8, false));
    const evalCase = makeCase({ expectedFacts: ['Lima', 'March'] });
    const result = await scoreCase(gateway, MODEL, evalCase, 'We went to Lima in March.');
    expect(result.factsHit).toBe(2);
    expect(result.factsTotal).toBe(2);
    expect(result.pass).toBe(true);
  });

  test('fails when an expected fact is missing', async () => {
    const gateway = new StubJudgeGateway(verdictJson(0.8, false));
    const evalCase = makeCase({ expectedFacts: ['Lima', 'March'] });
    const result = await scoreCase(gateway, MODEL, evalCase, 'We went to Lima at some point.');
    expect(result.factsHit).toBe(1);
    expect(result.factsTotal).toBe(2);
    expect(result.pass).toBe(false);
  });

  test('with no expected facts, falls back to the judge grounding threshold', async () => {
    const passing = new StubJudgeGateway(verdictJson(0.5, false));
    const failing = new StubJudgeGateway(verdictJson(0.49, false));
    const evalCase = makeCase({ expectedFacts: [] });
    expect((await scoreCase(passing, MODEL, evalCase, 'a')).pass).toBe(true);
    expect((await scoreCase(failing, MODEL, evalCase, 'a')).pass).toBe(false);
  });

  test('fact matching is word-boundary-aware (does not count substring hits)', async () => {
    const gateway = new StubJudgeGateway(verdictJson(0.8, false));
    const evalCase = makeCase({ expectedFacts: ['Lima'] });
    const result = await scoreCase(gateway, MODEL, evalCase, 'a preliminary plan');
    expect(result.factsHit).toBe(0);
    expect(result.pass).toBe(false);
  });
});

describe('scoreCase — absence cases', () => {
  test('passes a clean (non-hallucinated) answer with no expected facts', async () => {
    const gateway = new StubJudgeGateway(verdictJson(0.2, false));
    const evalCase = makeCase({ expectMemoryAbsent: true });
    const result = await scoreCase(gateway, MODEL, evalCase, "I don't know that.");
    expect(result.expectMemoryAbsent).toBe(true);
    expect(result.pass).toBe(true);
  });

  test('fails when the judge flags hallucination', async () => {
    const gateway = new StubJudgeGateway(verdictJson(0.2, true));
    const evalCase = makeCase({ expectMemoryAbsent: true });
    const result = await scoreCase(gateway, MODEL, evalCase, 'It was definitely Tuesday.');
    expect(result.pass).toBe(false);
  });

  test('absence + expectedFacts: present facts are fabrication evidence and fail', async () => {
    // Judge did not flag hallucination, but the answer states a fact the
    // fixture marked as unknowable — that presence must fail the case.
    const gateway = new StubJudgeGateway(verdictJson(0.2, false));
    const evalCase = makeCase({ expectMemoryAbsent: true, expectedFacts: ['Lima'] });
    const result = await scoreCase(gateway, MODEL, evalCase, 'You went to Lima.');
    expect(result.factsHit).toBe(1);
    expect(result.pass).toBe(false);
  });

  test('absence + expectedFacts: facts absent and no hallucination passes', async () => {
    const gateway = new StubJudgeGateway(verdictJson(0.2, false));
    const evalCase = makeCase({ expectMemoryAbsent: true, expectedFacts: ['Lima'] });
    const result = await scoreCase(gateway, MODEL, evalCase, 'I have no record of that.');
    expect(result.factsHit).toBe(0);
    expect(result.pass).toBe(true);
  });
});
