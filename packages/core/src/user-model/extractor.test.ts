/**
 * Inline user-fact capture — one cheap structured read turns the user's latest
 * message into explicit identity-fact candidates. The model reports via a
 * `report_user_facts` tool call; `coerceCandidates` is tolerant (drops non-Tier-1
 * attributes, blanks, malformed items) and capture meters its tokens to stamina.
 */

import { describe, expect, it } from 'vitest';
import { FakeLlmGateway } from '../llm/fake.js';
import type { LlmGateway, StreamResult, ToolCall } from '../llm/gateway.js';
import type { Logger } from '../logging.js';
import type { VitalityStore } from '../quota/vitality-store.js';
import { captureUserFacts, coerceCandidates } from './extractor.js';

const silent: Logger = { error: () => {}, warn: () => {}, info: () => {} };

/** Script the gateway to emit a single report_user_facts tool call. */
function reportFacts(args: Record<string, unknown>): readonly [{ toolCalls: ToolCall[] }] {
  return [{ toolCalls: [{ name: 'report_user_facts', args }] }];
}

describe('coerceCandidates', () => {
  it('keeps valid Tier-1 facts, mapping attribute/value to predicate/object', () => {
    expect(
      coerceCandidates({
        facts: [
          { attribute: 'name', value: 'Sam' },
          { attribute: 'livesIn', value: 'Berlin' },
        ],
      }),
    ).toEqual([
      { predicate: 'name', object: 'Sam' },
      { predicate: 'livesIn', object: 'Berlin' },
    ]);
  });

  it('drops attributes outside the Tier-1 set', () => {
    expect(
      coerceCandidates({
        facts: [
          { attribute: 'name', value: 'Sam' },
          { attribute: 'favouriteColour', value: 'blue' },
        ],
      }),
    ).toEqual([{ predicate: 'name', object: 'Sam' }]);
  });

  it('drops blank or malformed values and trims', () => {
    expect(
      coerceCandidates({
        facts: [
          { attribute: 'name', value: '  Sam  ' },
          { attribute: 'livesIn', value: '   ' },
          { attribute: 'worksAs', value: 42 },
          { value: 'no attribute' },
          'not an object',
        ],
      }),
    ).toEqual([{ predicate: 'name', object: 'Sam' }]);
  });

  it('keeps the last value when a predicate is repeated (singular)', () => {
    expect(
      coerceCandidates({
        facts: [
          { attribute: 'name', value: 'Sam' },
          { attribute: 'name', value: 'Samuel' },
        ],
      }),
    ).toEqual([{ predicate: 'name', object: 'Samuel' }]);
  });

  it('returns empty for a non-array or absent facts field', () => {
    expect(coerceCandidates({})).toEqual([]);
    expect(coerceCandidates({ facts: 'nope' })).toEqual([]);
  });
});

describe('captureUserFacts', () => {
  it('captures the facts from the model tool call', async () => {
    const facts = await captureUserFacts(
      {
        llm: new FakeLlmGateway(reportFacts({ facts: [{ attribute: 'name', value: 'Sam' }] })),
        model: 'cheap',
        logger: silent,
      },
      { recentContext: '', userText: 'call me Sam' },
    );
    expect(facts).toEqual([{ predicate: 'name', object: 'Sam' }]);
  });

  it('returns an empty list when the user stated no facts (a genuine read)', async () => {
    const facts = await captureUserFacts(
      {
        llm: new FakeLlmGateway(reportFacts({ facts: [] })),
        model: 'cheap',
        logger: silent,
      },
      { recentContext: '', userText: 'that sounds great!' },
    );
    expect(facts).toEqual([]);
  });

  it('returns null when the model does not call the tool (no read)', async () => {
    const facts = await captureUserFacts(
      { llm: new FakeLlmGateway([{ toolCalls: [] }]), model: 'cheap', logger: silent },
      { recentContext: '', userText: 'hello' },
    );
    expect(facts).toBeNull();
  });

  it('never throws and returns null on a gateway failure', async () => {
    const exploding: LlmGateway = {
      // eslint-disable-next-line require-yield
      async *stream(): AsyncGenerator<string, StreamResult, void> {
        throw new Error('boom');
      },
    };
    const facts = await captureUserFacts(
      { llm: exploding, model: 'cheap', logger: silent },
      { recentContext: '', userText: 'call me Sam' },
    );
    expect(facts).toBeNull();
  });

  it('bills the captured tokens to the stamina wallet, best-effort', async () => {
    const spent: Array<{ companionId: string; tokens: number }> = [];
    const quota: VitalityStore = {
      spend: async (companionId: string, tokens: number) => {
        spent.push({ companionId, tokens });
      },
    } as unknown as VitalityStore;
    await captureUserFacts(
      {
        llm: new FakeLlmGateway(reportFacts({ facts: [{ attribute: 'name', value: 'Sam' }] })),
        model: 'cheap',
        logger: silent,
        quota,
      },
      { companionId: 'comp-1', recentContext: '', userText: 'call me Sam' },
    );
    expect(spent).toHaveLength(1);
    expect(spent[0]?.companionId).toBe('comp-1');
    expect(spent[0]?.tokens).toBeGreaterThanOrEqual(0);
  });
});
