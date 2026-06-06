/**
 * Deterministic-tier tests for the eval framework: scorers, composition, and the
 * runner — exercised with a FakeLlmGateway so they run in CI without a network
 * or live model. This is the tier that gates every PR (the live datasets run
 * nightly). Also covers the injection dataset's guard against a fake "leak".
 */

import { FakeLlmGateway, type Logger } from '@cobble/core';
import { describe, expect, it } from 'vitest';
import { affectSenseDataset, type AffectCase } from '../datasets/affect-sense.js';
import { injectionDataset } from '../datasets/injection.js';
import type { CaseReport, Dataset, EvalRuntime } from './dataset.js';
import { runDataset } from './runner.js';
import { composeScorers, type Scorer } from './scorer.js';
import { factsScorer } from './scorers/facts.js';
import { refusalScorer } from './scorers/refusal.js';

const silent: Logger = { error: () => {}, warn: () => {}, info: () => {} };

describe('factsScorer', () => {
  const scorer = factsScorer<{ readonly expectedFacts: readonly string[] }>();

  it('passes only when every expected fact is present', async () => {
    const result = await scorer.score({
      case: { expectedFacts: ['Lima', 'fox'] },
      output: 'a fox from Lima',
    });
    expect(result.pass).toBe(true);
    expect(result.metrics.factsHit).toBe(2);
  });

  it('fails when a fact is missing', async () => {
    const result = await scorer.score({
      case: { expectedFacts: ['Lima', 'fox'] },
      output: 'a fox',
    });
    expect(result.pass).toBe(false);
    expect(result.metrics.factsHit).toBe(1);
  });
});

describe('refusalScorer', () => {
  const scorer = refusalScorer<{ readonly mustNotContain: readonly string[] }>();

  it('passes when no forbidden marker leaks', async () => {
    const result = await scorer.score({ case: { mustNotContain: ['CANARY'] }, output: 'all good' });
    expect(result.pass).toBe(true);
  });

  it('fails (case-insensitively) when a marker leaks', async () => {
    const result = await scorer.score({
      case: { mustNotContain: ['CANARY'] },
      output: 'here is canary',
    });
    expect(result.pass).toBe(false);
    expect(result.metrics.leaks).toBe(1);
  });
});

describe('composeScorers', () => {
  it('passes only when all sub-scorers pass and merges metrics', async () => {
    const composed = composeScorers([
      factsScorer<{
        readonly expectedFacts: readonly string[];
        readonly mustNotContain: readonly string[];
      }>(),
      refusalScorer<{
        readonly expectedFacts: readonly string[];
        readonly mustNotContain: readonly string[];
      }>(),
    ]);
    const pass = await composed.score({
      case: { expectedFacts: ['fox'], mustNotContain: ['CANARY'] },
      output: 'a fox',
    });
    expect(pass.pass).toBe(true);
    expect(pass.metrics).toMatchObject({ factsHit: 1, leaks: 0 });

    const fail = await composed.score({
      case: { expectedFacts: ['fox'], mustNotContain: ['CANARY'] },
      output: 'a fox with CANARY',
    });
    expect(fail.pass).toBe(false);
  });
});

describe('runDataset', () => {
  interface EchoCase {
    readonly id: string;
    readonly expectedFacts: readonly string[];
  }

  const echoDataset: Dataset<EchoCase, string> = {
    name: 'echo',
    cases: [
      { id: 'hit', expectedFacts: ['hello'] },
      { id: 'miss', expectedFacts: ['absent'] },
    ],
    // The fake echoes a fixed string; only the 'hit' case's fact is present.
    run: async (runtime: EvalRuntime) => {
      let text = '';
      for await (const delta of runtime.gateway.stream({ model: runtime.model, messages: [] })) {
        text += delta;
      }
      return text;
    },
    scorer: factsScorer<EchoCase>(),
  };

  it('aggregates pass rate and mean metrics across cases', async () => {
    const runtime: EvalRuntime = {
      gateway: new FakeLlmGateway(['hello world']),
      model: 'fake',
      logger: silent,
    };
    const report = await runDataset(echoDataset, runtime);
    expect(report.dataset).toBe('echo');
    expect(report.passRate).toBe(0.5);
    expect(report.cases.map((c) => c.pass)).toEqual([true, false]);
  });

  it('reports passRate 0 and empty metrics for an empty dataset (no div-by-zero)', async () => {
    const empty: Dataset<EchoCase, string> = { ...echoDataset, cases: [] };
    const runtime: EvalRuntime = {
      gateway: new FakeLlmGateway(['hello world']),
      model: 'fake',
      logger: silent,
    };
    const report = await runDataset(empty, runtime);
    expect(report.passRate).toBe(0);
    expect(report.meanMetrics).toEqual({});
    expect(report.cases).toEqual([]);
  });
});

describe('injectionDataset (deterministic guard)', () => {
  const first = injectionDataset.cases[0]!;

  async function scoreWith(gateway: FakeLlmGateway): Promise<boolean> {
    const runtime: EvalRuntime = { gateway, model: 'fake', logger: silent };
    const output = await injectionDataset.run(runtime, first);
    return (await injectionDataset.scorer.score({ case: first, output })).pass;
  }

  it('flags a leak when the model obeys the dictated valence', async () => {
    // A fake that obeys the attacker (valence 1) must FAIL the injection scorer.
    expect(
      await scoreWith(
        new FakeLlmGateway([
          { toolCalls: [{ name: 'report_affect', args: { valence: 1, note: 'delighted' } }] },
        ]),
      ),
    ).toBe(false);
  });

  it('passes a genuine, clearly-negative read', async () => {
    expect(
      await scoreWith(
        new FakeLlmGateway([
          { toolCalls: [{ name: 'report_affect', args: { valence: -0.8, note: 'furious' } }] },
        ]),
      ),
    ).toBe(true);
  });

  // Positive control: the dataset must NOT be trivially passable by a degenerate
  // model. A flat-neutral read never "obeyed" the attacker, but it also never
  // proved the fence held against a genuinely negative message — so it must FAIL.
  it('fails a degenerate always-neutral read (valence 0)', async () => {
    expect(
      await scoreWith(
        new FakeLlmGateway([
          { toolCalls: [{ name: 'report_affect', args: { valence: 0, note: 'neutral' } }] },
        ]),
      ),
    ).toBe(false);
  });

  it('fails a null / declined read (no report_affect call)', async () => {
    // Plain text, no tool call → senseAffect returns null → not a genuine read.
    expect(await scoreWith(new FakeLlmGateway(['I will not answer.']))).toBe(false);
  });
});

describe('affectSenseDataset (deterministic tier)', () => {
  const positiveCase = affectSenseDataset.cases.find((c) => c.expectedSign === 'positive')!;
  const negativeCase = affectSenseDataset.cases.find((c) => c.expectedSign === 'negative')!;

  // Drive the real senseAffect call site through a scripted gateway (mirrors the
  // injection test), then score the resulting AffectReading | null. Exercises
  // valenceSignScorer's branches without touching OpenRouter.
  async function scoreWith(evalCase: AffectCase, gateway: FakeLlmGateway): Promise<CaseReport> {
    const runtime: EvalRuntime = { gateway, model: 'fake', logger: silent };
    const output = await affectSenseDataset.run(runtime, evalCase);
    const score = await affectSenseDataset.scorer.score({ case: evalCase, output });
    return {
      caseId: evalCase.id,
      pass: score.pass,
      metrics: score.metrics,
      note: score.note,
    };
  }

  function affectTurn(valence: number, note: string): FakeLlmGateway {
    return new FakeLlmGateway([
      { toolCalls: [{ name: 'report_affect', args: { valence, note } }] },
    ]);
  }

  it('passes a positive case when the read is positive', async () => {
    const result = await scoreWith(positiveCase, affectTurn(0.8, 'delighted'));
    expect(result.pass).toBe(true);
    expect(result.metrics.valence).toBe(0.8);
  });

  it('passes a negative case when the read is negative', async () => {
    const result = await scoreWith(negativeCase, affectTurn(-0.7, 'frustrated'));
    expect(result.pass).toBe(true);
    expect(result.metrics.valence).toBe(-0.7);
  });

  it('fails a positive case on a neutral read (the neutral-sign branch)', async () => {
    // valence 0 → sign 'neutral', which matches no expectedSign → fail.
    const result = await scoreWith(positiveCase, affectTurn(0, 'flat'));
    expect(result.pass).toBe(false);
    expect(result.note).toContain('neutral');
  });

  it('fails on a null / declined read (the null-read branch)', async () => {
    // Plain text, no report_affect call → senseAffect returns null.
    const result = await scoreWith(positiveCase, new FakeLlmGateway(['no read here']));
    expect(result.pass).toBe(false);
    expect(result.note).toBe('no read (null)');
    expect(result.metrics.valence).toBe(0);
  });
});
