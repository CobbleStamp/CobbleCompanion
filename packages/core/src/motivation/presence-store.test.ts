/**
 * In-memory presence store — heartbeat vs activity semantics, and that a
 * heartbeat does not clobber the last-activity timestamp (so an idle tab stays
 * attentive, not active).
 */

import { describe, expect, it } from 'vitest';
import { classifyPresence } from './presence.js';
import { InMemoryPresenceStore } from './presence-store.js';

describe('InMemoryPresenceStore', () => {
  it('returns null for an unseen companion', () => {
    const store = new InMemoryPresenceStore();
    expect(store.get('c1')).toBeNull();
  });

  it('records a heartbeat with the reported visibility', () => {
    let clock = new Date('2026-06-05T12:00:00.000Z');
    const store = new InMemoryPresenceStore(() => clock);
    store.recordHeartbeat('c1', { tabVisible: false });
    const s = store.get('c1');
    expect(s?.tabVisible).toBe(false);
    expect(s?.lastHeartbeatAt).toEqual(clock);
    // No prior activity → seeded to the heartbeat instant.
    expect(s?.lastActivityAt).toEqual(clock);
    void clock;
  });

  it('a later heartbeat refreshes liveness but preserves last activity', () => {
    let clock = new Date('2026-06-05T12:00:00.000Z');
    const store = new InMemoryPresenceStore(() => clock);
    store.recordActivity('c1'); // active now
    const activeAt = clock;

    clock = new Date('2026-06-05T12:05:00.000Z'); // 5 min later, idle heartbeat
    store.recordHeartbeat('c1', { tabVisible: true });

    const s = store.get('c1');
    expect(s?.lastActivityAt).toEqual(activeAt); // activity NOT bumped
    expect(s?.lastHeartbeatAt).toEqual(clock);
    // Result: present-but-idle → attentive, not active.
    expect(classifyPresence(s!, clock)).toBe('attentive');
  });

  it('records activity as both fresh activity and a heartbeat', () => {
    let clock = new Date('2026-06-05T12:00:00.000Z');
    const store = new InMemoryPresenceStore(() => clock);
    store.recordActivity('c1');
    const s = store.get('c1');
    expect(s?.lastActivityAt).toEqual(clock);
    expect(classifyPresence(s!, clock)).toBe('active');
  });
});
