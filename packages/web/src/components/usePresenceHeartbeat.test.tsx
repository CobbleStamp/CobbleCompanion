/**
 * Presence heartbeat hook — beats on mount, on an interval, and on every
 * focus/visibility change, reporting the live tab visibility. Fire-and-forget:
 * a failed ping is swallowed, and all timers/listeners are torn down on unmount.
 */

import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendHeartbeat } from '../api/client.js';
import { usePresenceHeartbeat } from './usePresenceHeartbeat.js';

vi.mock('../api/client.js', () => ({
  sendHeartbeat: vi.fn(),
}));

const INTERVAL_MS = 20_000;

/** Override the jsdom visibility getter so we can drive the hidden/visible read. */
function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
}

describe('usePresenceHeartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(sendHeartbeat).mockReset().mockResolvedValue(undefined);
    setVisibility('visible');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('beats once on mount with the current tab visibility', () => {
    renderHook(() => usePresenceHeartbeat('c1'));
    expect(sendHeartbeat).toHaveBeenCalledTimes(1);
    expect(sendHeartbeat).toHaveBeenCalledWith('c1', true);
  });

  it('beats again on each interval tick', () => {
    renderHook(() => usePresenceHeartbeat('c1'));
    expect(sendHeartbeat).toHaveBeenCalledTimes(1); // mount
    vi.advanceTimersByTime(INTERVAL_MS);
    expect(sendHeartbeat).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(INTERVAL_MS);
    expect(sendHeartbeat).toHaveBeenCalledTimes(3);
  });

  it('beats on focus, blur, and visibilitychange', () => {
    renderHook(() => usePresenceHeartbeat('c1'));
    vi.mocked(sendHeartbeat).mockClear();

    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('blur'));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(sendHeartbeat).toHaveBeenCalledTimes(3);
  });

  it('reports the tab as hidden when the page is backgrounded', () => {
    renderHook(() => usePresenceHeartbeat('c1'));
    vi.mocked(sendHeartbeat).mockClear();

    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(sendHeartbeat).toHaveBeenLastCalledWith('c1', false);
  });

  it('stops beating and removes listeners after unmount', () => {
    const { unmount } = renderHook(() => usePresenceHeartbeat('c1'));
    vi.mocked(sendHeartbeat).mockClear();

    unmount();
    vi.advanceTimersByTime(INTERVAL_MS * 3);
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(sendHeartbeat).not.toHaveBeenCalled();
  });

  it('swallows a failed heartbeat without throwing', async () => {
    vi.mocked(sendHeartbeat).mockRejectedValue(new Error('network down'));
    expect(() => renderHook(() => usePresenceHeartbeat('c1'))).not.toThrow();
    // The rejection is caught inside the hook; flushing it must not surface.
    await vi.advanceTimersByTimeAsync(0);
  });

  it('re-subscribes when the companion id changes', () => {
    const { rerender } = renderHook(({ id }) => usePresenceHeartbeat(id), {
      initialProps: { id: 'c1' },
    });
    expect(sendHeartbeat).toHaveBeenLastCalledWith('c1', true);
    rerender({ id: 'c2' });
    expect(sendHeartbeat).toHaveBeenLastCalledWith('c2', true);
  });

  it('tears down the old interval when the companion id changes (no leak)', () => {
    // Re-subscribing must also stop the PREVIOUS id's interval. Without the effect
    // cleanup, the old 'c1' timer would keep beating alongside 'c2'.
    const { rerender } = renderHook(({ id }) => usePresenceHeartbeat(id), {
      initialProps: { id: 'c1' },
    });
    rerender({ id: 'c2' });
    vi.mocked(sendHeartbeat).mockClear();

    vi.advanceTimersByTime(INTERVAL_MS);
    // Only the live id beats; the torn-down 'c1' interval never fires again.
    expect(sendHeartbeat).toHaveBeenCalledTimes(1);
    expect(sendHeartbeat).toHaveBeenCalledWith('c2', true);
    expect(sendHeartbeat).not.toHaveBeenCalledWith('c1', expect.anything());
  });
});
