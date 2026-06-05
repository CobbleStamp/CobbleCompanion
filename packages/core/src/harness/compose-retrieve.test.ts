/**
 * Tests for composeRetrieveContext: it runs each RetrieveContext arm for the
 * turn, concatenates their blocks in order, sums their usage, and structurally
 * isolates failures — a throwing arm is caught, logged at error severity, and
 * degraded to nothing so the turn (and the other arms) survive.
 */

import { describe, expect, it, vi } from 'vitest';
import { ZERO_USAGE } from '../usage.js';
import { composeRetrieveContext } from './compose-retrieve.js';
import type { RetrieveContext } from './hooks.js';

const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };

describe('composeRetrieveContext', () => {
  it('concatenates blocks in order and sums usage across arms', async () => {
    const armA: RetrieveContext = async () => ({
      blocks: [{ role: 'system', content: 'A' }],
      usage: { promptTokens: 1, completionTokens: 0, totalTokens: 1 },
    });
    const armB: RetrieveContext = async () => ({
      blocks: [
        { role: 'system', content: 'B' },
        { role: 'user', content: 'recent turn' },
      ],
      usage: { promptTokens: 2, completionTokens: 0, totalTokens: 2 },
    });

    const composed = composeRetrieveContext(logger, armA, armB);
    const result = await composed({ companionId: 'c1', userContent: 'q' });

    expect(result.blocks.map((b) => b.content)).toEqual(['A', 'B', 'recent turn']);
    expect(result.usage.totalTokens).toBe(3);
  });

  it('is a no-op shape with zero arms', async () => {
    const composed = composeRetrieveContext(logger);
    const result = await composed({ companionId: 'c1', userContent: 'q' });
    expect(result.blocks).toEqual([]);
    expect(result.usage).toEqual(ZERO_USAGE);
  });

  it('isolates a throwing arm: the others still contribute and the turn survives', async () => {
    const throwing: RetrieveContext = async () => {
      throw new Error('arm blew up');
    };
    const healthy: RetrieveContext = async () => ({
      blocks: [
        { role: 'system', content: 'grounding' },
        { role: 'user', content: 'recent turn' },
      ],
      usage: { promptTokens: 2, completionTokens: 0, totalTokens: 2 },
    });

    // Throwing arm first, healthy arm last (recency carrier) — the order the
    // harness uses. The throw must not abort the loop or the turn.
    const composed = composeRetrieveContext(logger, throwing, healthy);
    const result = await composed({ companionId: 'c1', userContent: 'q' });

    expect(result.blocks.map((b) => b.content)).toEqual(['grounding', 'recent turn']);
    expect(result.usage.totalTokens).toBe(2);
  });

  it('degrades to an empty zero-usage result when ALL arms throw (turn survives)', async () => {
    const throwingA: RetrieveContext = async () => {
      throw new Error('arm A blew up');
    };
    const throwingB: RetrieveContext = async () => {
      throw new Error('arm B blew up');
    };

    const composed = composeRetrieveContext(logger, throwingA, throwingB);
    // The whole compose must not reject — recall never breaks the conversation.
    const result = await composed({ companionId: 'c1', userContent: 'q' });

    expect(result.blocks).toEqual([]);
    expect(result.usage).toEqual(ZERO_USAGE);
  });

  it('a failed arm contributes ZERO usage: the sum equals exactly the healthy arm', async () => {
    const throwing: RetrieveContext = async () => {
      throw new Error('arm blew up');
    };
    const healthy: RetrieveContext = async () => ({
      blocks: [{ role: 'system', content: 'kept' }],
      usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
    });

    // Healthy arm first this time, so the throwing arm cannot mask its blocks.
    const composed = composeRetrieveContext(logger, healthy, throwing);
    const result = await composed({ companionId: 'c1', userContent: 'q' });

    // The throwing arm added nothing — the sum is exactly the healthy arm's N.
    expect(result.usage).toEqual({ promptTokens: 5, completionTokens: 2, totalTokens: 7 });
    expect(result.blocks.map((b) => b.content)).toEqual(['kept']);
  });

  it('logs each arm failure at error severity with the companionId', async () => {
    logger.error.mockClear();
    const throwingA: RetrieveContext = async () => {
      throw new Error('arm A blew up');
    };
    const throwingB: RetrieveContext = async () => {
      throw new Error('arm B blew up');
    };

    const composed = composeRetrieveContext(logger, throwingA, throwingB);
    await composed({ companionId: 'c1', userContent: 'q' });

    // One error log per failed arm, each carrying the turn's companionId.
    expect(logger.error).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('degrading'),
      expect.objectContaining({ companionId: 'c1' }),
    );
  });
});
