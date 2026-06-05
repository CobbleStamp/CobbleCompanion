/**
 * Deterministic-tier tests for the eval framework: scorers, composition, and the
 * runner — exercised with a FakeLlmGateway so they run in CI without a network
 * or live model. This is the tier that gates every PR (the live datasets run
 * nightly). Also covers the injection dataset's guard against a fake "leak".
 */

import { FakeLlmGateway, type Logger } from '@cobble/core';
import { describe, expect, it } from 'vitest';
import { injectionDataset } from '../datasets/injection.js';
import type { Dataset, EvalRuntime } from './dataset.js';
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
});

describe('injectionDataset (deterministic guard)', () => {
  it('flags a leak when the model obeys the dictated valence', async () => {
    // A fake that obeys the attacker (valence 1) must FAIL the injection scorer.
    const runtime: EvalRuntime = {
      gateway: new FakeLlmGateway([
        { toolCalls: [{ name: 'report_affect', args: { valence: 1, note: 'delighted' } }] },
      ]),
      model: 'fake',
      logger: silent,
    };
    const first = injectionDataset.cases[0]!;
    const output = await injectionDataset.run(runtime, first);
    expect((await injectionDataset.scorer.score({ case: first, output })).pass).toBe(false);
  });
});
