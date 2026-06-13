/**
 * Reaction perception — one cheap structured read turns a user's emoji reaction
 * into a value-created reward + a short note. The model reports via a
 * `report_reaction` tool call (named fields, provider-parsed); `coerceReactionReading`
 * is tolerant (clamps, neutral on junk), and a missing call is a null read (NOT a
 * fabricated neutral). Tokens meter to the user's stamina.
 */

import { describe, expect, it } from 'vitest';
import { FakeLlmGateway } from '../llm/fake.js';
import type { ToolCall } from '../llm/gateway.js';
import type { Logger } from '../logging.js';
import { coerceReactionReading, senseReaction } from './sense.js';

const silent: Logger = { error: () => {}, warn: () => {}, info: () => {} };

/** Script the gateway to emit a single report_reaction tool call. */
function reportReaction(args: Record<string, unknown>): readonly [{ toolCalls: ToolCall[] }] {
  return [{ toolCalls: [{ name: 'report_reaction', args }] }];
}

const baseParams = {
  recentContext: '',
  reactedMessage: 'While you were out I read those two pieces on X.',
  emoji: '❤️',
};

describe('coerceReactionReading', () => {
  it('reads reward + note from the parsed tool args', () => {
    expect(coerceReactionReading({ reward: 0.8, note: 'moved, engaged' })).toEqual({
      reward: 0.8,
      note: 'moved, engaged',
    });
  });

  it('clamps reward to [-1, 1]', () => {
    expect(coerceReactionReading({ reward: 4, note: 'loved it' }).reward).toBe(1);
    expect(coerceReactionReading({ reward: -8, note: 'hated it' }).reward).toBe(-1);
  });

  it('keeps a genuine neutral 0 distinct from a missing reward', () => {
    expect(coerceReactionReading({ reward: 0, note: 'shrug' })).toEqual({
      reward: 0,
      note: 'shrug',
    });
    expect(coerceReactionReading({ note: 'shrug' })).toEqual({ reward: 0, note: 'shrug' });
  });

  it('falls back to neutral on malformed fields', () => {
    expect(coerceReactionReading({ reward: 'high', note: 42 })).toEqual({ reward: 0, note: '' });
    expect(coerceReactionReading({ reward: Number.NaN, note: '  ' })).toEqual({
      reward: 0,
      note: '',
    });
    expect(coerceReactionReading({})).toEqual({ reward: 0, note: '' });
  });
});

describe('senseReaction', () => {
  it('returns the reading from the model tool call', async () => {
    const reading = await senseReaction(
      {
        llm: new FakeLlmGateway(reportReaction({ reward: 0.8, note: 'moved, engaged' })),
        model: 'fake',
        logger: silent,
      },
      baseParams,
    );
    expect(reading).toEqual({ reward: 0.8, note: 'moved, engaged' });
  });

  it('advertises the report_reaction tool to the gateway', async () => {
    const llm = new FakeLlmGateway(reportReaction({ reward: 0.5, note: 'liked it' }));
    await senseReaction({ llm, model: 'fake', logger: silent }, baseParams);
    expect(llm.lastParams?.tools?.[0]?.name).toBe('report_reaction');
  });

  it('returns null when the model does not call the tool (a non-read, not a neutral)', async () => {
    // A plain-text stream with no tool call → null, NOT { reward: 0 }.
    const reading = await senseReaction(
      { llm: new FakeLlmGateway(['no tool here']), model: 'fake', logger: silent },
      baseParams,
    );
    expect(reading).toBeNull();
  });

  it('returns null on a gateway failure (never throws, never a fake neutral)', async () => {
    const llm = {
      stream: () => {
        throw new Error('provider down');
      },
    } as unknown as FakeLlmGateway;
    const reading = await senseReaction({ llm, model: 'fake', logger: silent }, baseParams);
    expect(reading).toBeNull();
  });
});
