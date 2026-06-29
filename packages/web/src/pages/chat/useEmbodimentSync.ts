/**
 * The durable chat view (architecture.md §6): owns the standing event channel, the
 * transcript snapshot, the reconnect/backoff loop, the pre-ready/in-flight event
 * buffer, and the room-takeover ("moved") state — everything that keeps the rendered
 * lines converged with the server without a manual refresh. Extracted from Chat.tsx so
 * the page component is left with only the turn-streaming and compose concerns; it reads
 * `lines`/`ready`/`moved` and writes optimistic turn lines back through `setLines`.
 */

import type { CompanionStreamEvent } from '@cobble/shared';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import {
  fetchMessages,
  onEmbodimentMoved,
  reclaimEmbodiment,
  subscribeCompanionEvents,
} from '../../api/client.js';
import { mergeSnapshot, messageToLine, reduceEvent, type ChatLine } from './chat-lines.js';

/** Reconnect backoff bounds for the standing event channel (implementation.md §3). */
const CHANNEL_INITIAL_BACKOFF_MS = 1000;
const CHANNEL_MAX_BACKOFF_MS = 15000;
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface EmbodimentSync {
  readonly lines: ChatLine[];
  /** Apply optimistic turn lines (the streaming turn owns its lines until persisted). */
  readonly setLines: Dispatch<SetStateAction<ChatLine[]>>;
  /** The snapshot has landed at least once — the surface is safe to act on. */
  readonly ready: boolean;
  /** Another tab/device took the room (D2 "newer wins") — render the takeover. */
  readonly moved: boolean;
  /** Take the room back: reclaim the embodiment and re-establish the view. */
  readonly onMoveHere: () => void;
  /** Belt-and-suspenders re-sync against the transcript snapshot (tab-return / repair). */
  readonly refreshTranscript: () => Promise<void>;
}

/**
 * @param companionId the embodied companion whose view this syncs.
 * @param locked whether a turn/upload is mid-flight — channel rows buffer until it clears
 *   (the per-turn stream owns its optimistic lines until then).
 * @param onError surface a snapshot-load failure on the shared chat error line.
 */
export function useEmbodimentSync(
  companionId: string,
  locked: boolean,
  onError: (message: string | null) => void,
): EmbodimentSync {
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [ready, setReady] = useState(false);
  // The companion's room was taken over by another tab/device (D2 "newer wins").
  // We stop reconnecting (no claim war) and offer "use here" to take it back;
  // bumping `claimNonce` re-runs the establishment effect, which force-claims.
  const [moved, setMoved] = useState(false);
  const [claimNonce, setClaimNonce] = useState(0);
  // Channel rows that arrived before the snapshot landed or while a turn is in
  // flight, held until it's safe to merge them (see the establishment effect).
  const bufferedRef = useRef<CompanionStreamEvent[]>([]);
  // Mirrors of `ready`/`locked` the long-lived channel consumer reads — its closure
  // can't see fresh React state.
  const readyRef = useRef(false);
  const lockedRef = useRef(false);

  // Keep the refs the async channel consumer reads in step with render.
  readyRef.current = ready;
  lockedRef.current = locked;

  // Re-sync against the transcript snapshot, reconciling rows we already have
  // (merged by id, so it never duplicates) and adopting the server's authoritative
  // reactions. The standing event channel (architecture.md §6) is the primary
  // delivery path; this is the belt-and-suspenders re-sync on tab-return — and the
  // repair after a failed reaction toggle — in case the connection silently died or
  // a reaction's live echo was lost.
  const refreshTranscript = useCallback(async (): Promise<void> => {
    try {
      const history = await fetchMessages(companionId);
      setLines((prev) => mergeSnapshot(prev, history));
    } catch (err) {
      console.error('transcript refresh failed', { companionId, error: err });
    }
  }, [companionId]);

  // Establish the durable view (architecture.md §6): open the standing event
  // channel AND load the transcript snapshot. Subscribe-FIRST (live rows buffer
  // until the snapshot lands), then snapshot, then merge by id — so a row that
  // persists after the snapshot still arrives over the live channel, and the two
  // never drop or duplicate. The channel reconnects with backoff while mounted and
  // re-syncs on reconnect; everything aborts on unmount. This is what makes opening
  // the chat, navigating away and back, or a second tab all converge on the
  // transcript without a manual refresh.
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    // A takeover by another tab/device: stop reconnecting (the transport has yielded
    // the claim) and surface the full-screen MovedAway takeover. "Move here"
    // (onMoveHere) bumps claimNonce, which re-runs this effect and force-claims back.
    const offMoved = onEmbodimentMoved(() => {
      setMoved(true);
      cancelled = true;
      controller.abort();
    });

    // Hold rows until the snapshot has landed and no turn is mid-flight (the
    // per-turn stream owns its optimistic lines until then); the buffer is flushed,
    // deduped by id, once it's safe (the effect below).
    const applyOrBuffer = (event: CompanionStreamEvent): void => {
      if (!readyRef.current || lockedRef.current) {
        bufferedRef.current.push(event);
      } else {
        // Drain anything buffered ahead of this event in one ordered pass. The refs
        // flip to unlocked during render but the flush effect runs post-paint, so an
        // event arriving in that window would otherwise apply ahead of still-buffered
        // events — reordering the order-sensitive reaction_added/removed toggles and
        // resurrecting a removed chip. Draining FIFO here keeps arrival order.
        const pending = bufferedRef.current;
        bufferedRef.current = [];
        setLines((prev) =>
          (pending.length > 0 ? [...pending, event] : [event]).reduce(reduceEvent, prev),
        );
      }
    };

    // The standing subscription, reconnecting until unmount.
    void (async () => {
      let backoff = CHANNEL_INITIAL_BACKOFF_MS;
      while (!cancelled) {
        try {
          for await (const event of subscribeCompanionEvents(companionId, controller.signal)) {
            if (cancelled) break;
            applyOrBuffer(event);
            backoff = CHANNEL_INITIAL_BACKOFF_MS; // a healthy frame resets backoff
          }
        } catch (err) {
          if (cancelled || controller.signal.aborted) break;
          console.error('event channel error; reconnecting', {
            companionId,
            error: err,
          });
        }
        if (cancelled) break;
        await delay(backoff);
        backoff = Math.min(backoff * 2, CHANNEL_MAX_BACKOFF_MS);
        if (cancelled) break;
        // Recover rows appended while we were disconnected (no server-side replay).
        try {
          const history = await fetchMessages(companionId);
          if (!cancelled) setLines((prev) => mergeSnapshot(prev, history));
        } catch (err) {
          console.error('re-snapshot after reconnect failed', {
            companionId,
            error: err,
          });
        }
      }
    })();

    // The initial snapshot, retried until it lands (a companion has one lifelong
    // conversation, so resuming is just loading its transcript).
    void (async () => {
      let backoff = CHANNEL_INITIAL_BACKOFF_MS;
      while (!cancelled) {
        try {
          const history = await fetchMessages(companionId);
          if (cancelled) return;
          setLines((prev) =>
            prev.length > 0 ? mergeSnapshot(prev, history) : history.map(messageToLine),
          );
          onError(null);
          setReady(true);
          return;
        } catch (err) {
          if (cancelled) return;
          onError(err instanceof Error ? err.message : 'Failed to load conversation');
          await delay(backoff);
          backoff = Math.min(backoff * 2, CHANNEL_MAX_BACKOFF_MS);
        }
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
      offMoved();
    };
    // Re-establish only on a companion switch or a deliberate reclaim; `onError` and the
    // state setters are stable, so they are intentionally not in the dependency list.
  }, [companionId, claimNonce]);

  // Take the room back after a move: reclaim the embodiment, then re-run the
  // establishment effect (re-subscribe + re-snapshot) by bumping claimNonce.
  const onMoveHere = useCallback((): void => {
    reclaimEmbodiment();
    setMoved(false);
    setReady(false);
    setClaimNonce((nonce) => nonce + 1);
  }, []);

  // Once the snapshot has landed and no turn is in flight, flush the rows the
  // channel buffered in the meantime (deduped by id against what's already shown).
  useEffect(() => {
    if (!ready || locked) return;
    if (bufferedRef.current.length === 0) return;
    const pending = bufferedRef.current;
    bufferedRef.current = [];
    setLines((prev) => pending.reduce(reduceEvent, prev));
  }, [ready, locked]);

  return { lines, setLines, ready, moved, onMoveHere, refreshTranscript };
}
