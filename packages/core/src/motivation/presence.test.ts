/**
 * Presence classification — the spectrum from a heartbeat + activity recency.
 * Pure function, exhaustive boundary table with an injected clock.
 */

import { describe, expect, it } from 'vitest';
import {
  classifyPresence,
  DEFAULT_PRESENCE_THRESHOLDS,
  PRESENCE_POSTURE,
  type PresenceSignal,
  presencePosture,
} from './presence.js';

const NOW = new Date('2026-06-05T12:00:00.000Z');

function at(msAgo: number): Date {
  return new Date(NOW.getTime() - msAgo);
}

function signal(partial: Partial<PresenceSignal>): PresenceSignal {
  return {
    lastActivityAt: at(60 * 60_000), // an hour ago by default
    lastHeartbeatAt: at(60 * 60_000),
    tabVisible: true,
    ...partial,
  };
}

describe('classifyPresence', () => {
  it('is active when the user acted within the active window', () => {
    expect(classifyPresence(signal({ lastActivityAt: at(5_000) }), NOW)).toBe('active');
  });

  it('is attentive when the tab is visible and the heartbeat is fresh but no recent activity', () => {
    const s = signal({ lastActivityAt: at(5 * 60_000), lastHeartbeatAt: at(20_000) });
    expect(classifyPresence(s, NOW)).toBe('attentive');
  });

  it('is away_short when the tab is hidden but the heartbeat is recent', () => {
    const s = signal({
      lastActivityAt: at(5 * 60_000),
      lastHeartbeatAt: at(20_000),
      tabVisible: false,
    });
    expect(classifyPresence(s, NOW)).toBe('away_short');
  });

  it('is away_short when visible but the heartbeat has gone stale past the attentive window', () => {
    const s = signal({
      lastActivityAt: at(30 * 60_000),
      lastHeartbeatAt: at(30 * 60_000),
      tabVisible: true,
    });
    expect(classifyPresence(s, NOW)).toBe('away_short');
  });

  it('is absent_long when the heartbeat is older than the away window', () => {
    const s = signal({
      lastActivityAt: at(5 * 60 * 60_000),
      lastHeartbeatAt: at(5 * 60 * 60_000),
    });
    expect(classifyPresence(s, NOW)).toBe('absent_long');
  });

  it('treats activity recency as authoritative even when the tab reads hidden', () => {
    // Just sent a message; a stale "hidden" heartbeat must not override active.
    const s = signal({ lastActivityAt: at(1_000), tabVisible: false });
    expect(classifyPresence(s, NOW)).toBe('active');
  });

  it('honors the exact active boundary (inclusive)', () => {
    const s = signal({ lastActivityAt: at(DEFAULT_PRESENCE_THRESHOLDS.activeWithinMs) });
    expect(classifyPresence(s, NOW)).toBe('active');
  });
});

describe('presencePosture', () => {
  it('treats a missing signal as absent_long', () => {
    expect(presencePosture(null, NOW).state).toBe('absent_long');
  });

  it('suppresses initiation only while active', () => {
    expect(PRESENCE_POSTURE.active.mayInitiate).toBe(false);
    expect(PRESENCE_POSTURE.attentive.mayInitiate).toBe(true);
    expect(PRESENCE_POSTURE.away_short.mayInitiate).toBe(true);
    expect(PRESENCE_POSTURE.absent_long.mayInitiate).toBe(true);
  });

  it('resolves the posture for a classified signal', () => {
    const s = signal({ lastActivityAt: at(5 * 60_000), lastHeartbeatAt: at(20_000) });
    const { state, posture } = presencePosture(s, NOW);
    expect(state).toBe('attentive');
    expect(posture.mayInitiate).toBe(true);
  });
});
