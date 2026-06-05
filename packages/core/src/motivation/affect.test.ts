/**
 * Affect perception — one cheap structured read turns the user's latest message
 * into a valence + a short mood note. The model reports via a `report_affect`
 * tool call (named fields, provider-parsed); `coerceReading` is tolerant (clamps,
 * neutral on junk) and sensing meters its tokens to the user's stamina.
 */

import { describe, expect, it, vi } from 'vitest';
import { FakeLlmGateway } from '../llm/fake.js';
import type { ToolCall } from '../llm/gateway.js';
import type { Logger } from '../logging.js';
import type { TokenQuotaStore } from '../quota/stamina-store.js';
import { coerceReading, NEUTRAL_AFFECT, senseAffect } from './affect.js';

const silent: Logger = { error: () => {}, warn: () => {}, info: () => {} };

/** Script the gateway to emit a single report_affect tool call. */
function reportAffect(args: Record<string, unknown>): readonly [{ toolCalls: ToolCall[] }] {
  return [{ toolCalls: [{ name: 'report_affect', args }] }];
}

describe('coerceReading', () => {
  it('reads valence + note from the parsed tool args', () => {
    expect(coerceReading({ valence: 0.8, note: 'pleased, grateful' })).toEqual({
      valence: 0.8,
      note: 'pleased, grateful',
    });
    expect(coerceReading({ valence: -0.6, note: 'frustrated' })).toEqual({
      valence: -0.6,
      note: 'frustrated',
    });
  });

  it('clamps valence to [-1, 1]', () => {
    expect(coerceReading({ valence: 2, note: 'elated' }).valence).toBe(1);
    expect(coerceReading({ valence: -9, note: 'furious' }).valence).toBe(-1);
  });

  it('keeps a genuine neutral 0 distinct from a missing valence', () => {
    expect(coerceReading({ valence: 0, note: 'calm' })).toEqual({ valence: 0, note: 'calm' });
    expect(coerceReading({ note: 'calm' })).toEqual({ valence: 0, note: 'calm' });
  });

  it('falls back to neutral on malformed fields', () => {
    expect(coerceReading({ valence: 'high', note: 42 })).toEqual(NEUTRAL_AFFECT);
    expect(coerceReading({ valence: Number.NaN, note: '  ' })).toEqual(NEUTRAL_AFFECT);
    expect(coerceReading({})).toEqual(NEUTRAL_AFFECT);
  });
});

describe('senseAffect', () => {
  it('returns the reading from the model tool call', async () => {
    const reading = await senseAffect(
      {
        llm: new FakeLlmGateway(reportAffect({ valence: 0.9, note: 'delighted' })),
        model: 'fake',
        logger: silent,
      },
      { recentContext: '', userText: 'this is wonderful, thank you!' },
    );
    expect(reading).toEqual({ valence: 0.9, note: 'delighted' });
  });

  it('advertises the report_affect tool to the gateway', async () => {
    const llm = new FakeLlmGateway(reportAffect({ valence: 0.2, note: 'calm' }));
    await senseAffect(
      { llm, model: 'fake', logger: silent },
      { recentContext: '', userText: 'all good' },
    );
    expect(llm.lastParams?.tools?.[0]?.name).toBe('report_affect');
  });

  it('is neutral when the model declines to call the tool', async () => {
    const reading = await senseAffect(
      { llm: new FakeLlmGateway(['just some prose, no tool call']), model: 'fake', logger: silent },
      { recentContext: '', userText: 'whatever' },
    );
    expect(reading).toEqual(NEUTRAL_AFFECT);
  });

  it('meters its tokens to the stamina pool when given a quota + owner', async () => {
    const recordUsage = vi.fn(async (_ownerId: string, _total: number) => {});
    const quota = { recordUsage } as unknown as TokenQuotaStore;
    await senseAffect(
      {
        llm: new FakeLlmGateway(reportAffect({ valence: 0.2, note: 'calm' })),
        model: 'fake',
        logger: silent,
        quota,
      },
      { ownerId: 'owner', recentContext: 'hi', userText: 'all good' },
    );
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage.mock.calls[0]![0]).toBe('owner');
    expect(recordUsage.mock.calls[0]![1]).toBeGreaterThan(0);
  });

  it('keeps a valid reading even when billing throws (billing must not void it)', async () => {
    const quota = {
      recordUsage: vi.fn(async () => {
        throw new Error('quota store down');
      }),
    } as unknown as TokenQuotaStore;
    const reading = await senseAffect(
      {
        llm: new FakeLlmGateway(reportAffect({ valence: 0.9, note: 'delighted' })),
        model: 'fake',
        logger: silent,
        quota,
      },
      { ownerId: 'owner', recentContext: '', userText: 'this is wonderful' },
    );
    // The model already judged the mood; a quota hiccup must not drop it to neutral.
    expect(reading).toEqual({ valence: 0.9, note: 'delighted' });
  });

  it('is neutral and never throws when the gateway fails', async () => {
    const llm = {
      // eslint-disable-next-line require-yield
      async *stream() {
        throw new Error('provider down');
      },
    } as unknown as FakeLlmGateway;
    const reading = await senseAffect(
      { llm, model: 'fake', logger: silent },
      {
        recentContext: '',
        userText: 'anything',
      },
    );
    expect(reading).toEqual(NEUTRAL_AFFECT);
  });
});
