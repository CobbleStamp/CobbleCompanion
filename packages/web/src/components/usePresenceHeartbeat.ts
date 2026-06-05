/**
 * Presence heartbeat (Phase 4). While the chat is open this pings the backend so
 * the motivation engine knows the user is here and whether the tab is in front —
 * the dominant signal shaping proactive behaviour (companion-motivation.md §4).
 * It beats on mount, on an interval, and whenever focus/visibility changes (so a
 * tab going to the background is reflected promptly). Fire-and-forget: presence is
 * volatile and self-heals on the next beat, so a failed ping is intentionally
 * ignored rather than surfaced.
 */

import { useEffect } from 'react';
import { sendHeartbeat } from '../api/client.js';

const HEARTBEAT_INTERVAL_MS = 20_000;

export function usePresenceHeartbeat(companionId: string): void {
  useEffect(() => {
    const beat = (): void => {
      const tabVisible = document.visibilityState === 'visible';
      // Best-effort telemetry; the next beat corrects any missed ping.
      void sendHeartbeat(companionId, tabVisible).catch(() => undefined);
    };
    beat();
    const timer = window.setInterval(beat, HEARTBEAT_INTERVAL_MS);
    document.addEventListener('visibilitychange', beat);
    window.addEventListener('focus', beat);
    window.addEventListener('blur', beat);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', beat);
      window.removeEventListener('focus', beat);
      window.removeEventListener('blur', beat);
    };
  }, [companionId]);
}
