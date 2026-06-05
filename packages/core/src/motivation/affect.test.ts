/**
 * Affect perception — one cheap structured read turns the user's latest message
 * into a valence + a short mood note. Parsing is tolerant (clamps, neutral on
 * junk); sensing meters its tokens to the user's stamina.
 */

import { describe, expect, it, vi } from 'vitest';
import { FakeLlmGateway } from '../llm/fake.js';
import type { Logger } from '../logging.js';
import type { TokenQuotaStore } from '../quota/store.js';
import { NEUTRAL_AFFECT, parseAffect, senseAffect } from './affect.js';

const silent: Logger = { error: () => {}, warn: () => {}, info: () => {} };

describe('parseAffect', () => {
  it('reads the two-line valence + note reply', () => {
    expect(parseAffect('0.8\npleased, grateful')).toEqual({
      valence: 0.8,
      note: 'pleased, grateful',
    });
    expect(parseAffect('-0.6\nfrustrated')).toEqual({ valence: -0.6, note: 'frustrated' });
  });

  it('clamps valence to [-1, 1]', () => {
    expect(parseAffect('2\nelated').valence).toBe(1);
    expect(parseAffect('-9\nfurious').valence).toBe(-1);
  });

  it('falls back to neutral on an unparseable reply', () => {
    expect(parseAffect('who knows')).toEqual({ valence: 0, note: 'who knows' });
    expect(parseAffect('')).toEqual(NEUTRAL_AFFECT);
  });

  it('recovers a note from a single combined line', () => {
    expect(parseAffect('0.5 — content')).toEqual({ valence: 0.5, note: 'content' });
  });
});

describe('senseAffect', () => {
  it('returns the parsed reading from the model', async () => {
    const reading = await senseAffect(
      { llm: new FakeLlmGateway(['0.9\ndelighted']), model: 'fake', logger: silent },
      { recentContext: '', userText: 'this is wonderful, thank you!' },
    );
    expect(reading).toEqual({ valence: 0.9, note: 'delighted' });
  });

  it('meters its tokens to the stamina pool when given a quota + owner', async () => {
    const recordUsage = vi.fn(async (_ownerId: string, _total: number) => {});
    const quota = { recordUsage } as unknown as TokenQuotaStore;
    await senseAffect(
      { llm: new FakeLlmGateway(['0.2\ncalm']), model: 'fake', logger: silent, quota },
      { ownerId: 'owner', recentContext: 'hi', userText: 'all good' },
    );
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage.mock.calls[0]![0]).toBe('owner');
    expect(recordUsage.mock.calls[0]![1]).toBeGreaterThan(0);
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
