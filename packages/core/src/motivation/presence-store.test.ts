/**
 * In-memory presence store — heartbeat vs activity semantics, and that a
 * heartbeat does not clobber the last-activity timestamp (so an idle tab stays
 * attentive, not active).
 */

import { describe, expect, it } from 'vitest';
import { classifyPresence } from './presence.js';
import { InMemoryPresenceStore, type PresenceFence } from './presence-store.js';

// The in-memory store ignores the fence (no claim concept); any value works.
const FENCE: PresenceFence = { connectionId: 'o1', claimSeq: 1 };

describe('InMemoryPresenceStore', () => {
  it('returns null for an unseen companion', async () => {
    const store = new InMemoryPresenceStore();
    expect(await store.get('c1')).toBeNull();
  });

  it('records a heartbeat with the reported visibility', async () => {
    const clock = new Date('2026-06-05T12:00:00.000Z');
    const store = new InMemoryPresenceStore(() => clock);
    store.recordHeartbeat('c1', { tabVisible: false, fence: FENCE });
    const s = await store.get('c1');
    expect(s?.tabVisible).toBe(false);
    expect(s?.lastHeartbeatAt).toEqual(clock);
    // No prior activity → seeded to the heartbeat instant.
    expect(s?.lastActivityAt).toEqual(clock);
  });

  it('a later heartbeat refreshes liveness but preserves last activity', async () => {
    let clock = new Date('2026-06-05T12:00:00.000Z');
    const store = new InMemoryPresenceStore(() => clock);
    store.recordActivity('c1', FENCE); // active now
    const activeAt = clock;

    clock = new Date('2026-06-05T12:05:00.000Z'); // 5 min later, idle heartbeat
    store.recordHeartbeat('c1', { tabVisible: true, fence: FENCE });

    const s = await store.get('c1');
    expect(s?.lastActivityAt).toEqual(activeAt); // activity NOT bumped
    expect(s?.lastHeartbeatAt).toEqual(clock);
    // Result: present-but-idle → attentive, not active.
    expect(classifyPresence(s!, clock)).toBe('attentive');
  });

  it('records activity as both fresh activity and a heartbeat', async () => {
    const clock = new Date('2026-06-05T12:00:00.000Z');
    const store = new InMemoryPresenceStore(() => clock);
    store.recordActivity('c1', FENCE);
    const s = await store.get('c1');
    expect(s?.lastActivityAt).toEqual(clock);
    expect(classifyPresence(s!, clock)).toBe('active');
  });
});
