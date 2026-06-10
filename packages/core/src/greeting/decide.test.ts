/** Greeting gate (Phase 14) — the whole decision space, exhaustively. */

import { describe, expect, it } from 'vitest';
import { ACTIVE_GAP_MS, CONTINUATION_FLOOR_MS, GENTLE_GAP_MS, decideGreeting } from './decide.js';

describe('decideGreeting', () => {
  describe('first meeting (overrides the dial)', () => {
    for (const dial of ['off', 'gentle', 'active'] as const) {
      it(`introduces itself even at dial=${dial}`, () => {
        const move = decideGreeting({ firstMeeting: true, gapMs: 0, dial, hasOpenLoop: false });
        expect(move).toEqual({ kind: 'introduce' });
      });
    }
  });

  describe('off = reactive-only (after the first meeting)', () => {
    it('stays quiet however long the gap, with or without an open loop', () => {
      expect(
        decideGreeting({
          firstMeeting: false,
          gapMs: 10 * GENTLE_GAP_MS,
          dial: 'off',
          hasOpenLoop: true,
        }),
      ).toBeNull();
    });
  });

  describe('continuation floor (a brief tab-away)', () => {
    it('stays quiet below the floor even at active with an open loop', () => {
      expect(
        decideGreeting({
          firstMeeting: false,
          gapMs: CONTINUATION_FLOOR_MS - 1,
          dial: 'active',
          hasOpenLoop: true,
        }),
      ).toBeNull();
    });
  });

  describe('gentle — substance or a long gap', () => {
    it('greets when an open loop waits (past the floor)', () => {
      expect(
        decideGreeting({
          firstMeeting: false,
          gapMs: CONTINUATION_FLOOR_MS,
          dial: 'gentle',
          hasOpenLoop: true,
        }),
      ).toEqual({ kind: 'greet' });
    });

    it('greets on a day-plus gap with nothing unfinished', () => {
      expect(
        decideGreeting({
          firstMeeting: false,
          gapMs: GENTLE_GAP_MS,
          dial: 'gentle',
          hasOpenLoop: false,
        }),
      ).toEqual({ kind: 'greet' });
    });

    it('stays quiet on a mid-length gap with no open loop', () => {
      expect(
        decideGreeting({
          firstMeeting: false,
          gapMs: ACTIVE_GAP_MS, // 1h: past the floor, short of a day
          dial: 'gentle',
          hasOpenLoop: false,
        }),
      ).toBeNull();
    });
  });

  describe('active — a shorter gap or any substance', () => {
    it('greets on an hour-plus gap with nothing unfinished', () => {
      expect(
        decideGreeting({
          firstMeeting: false,
          gapMs: ACTIVE_GAP_MS,
          dial: 'active',
          hasOpenLoop: false,
        }),
      ).toEqual({ kind: 'greet' });
    });

    it('greets on an open loop past the floor, short of the hour', () => {
      expect(
        decideGreeting({
          firstMeeting: false,
          gapMs: CONTINUATION_FLOOR_MS,
          dial: 'active',
          hasOpenLoop: true,
        }),
      ).toEqual({ kind: 'greet' });
    });

    it('stays quiet between the floor and the hour with no open loop', () => {
      expect(
        decideGreeting({
          firstMeeting: false,
          gapMs: ACTIVE_GAP_MS - 1,
          dial: 'active',
          hasOpenLoop: false,
        }),
      ).toBeNull();
    });
  });
});
