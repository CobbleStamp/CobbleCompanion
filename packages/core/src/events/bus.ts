import type { MessageDto } from '@cobble/shared';

/**
 * The standing companion event channel's server-side substrate (`architecture.md`
 * §6, `implementation.md` §2.4). An in-process per-companion publish/subscribe of
 * appended transcript rows: the publish-on-append MemoryStore decorator
 * ({@link PublishingMemoryStore}) emits each persisted row here, and the
 * `GET /companions/:id/events` route drains a subscription to a connected surface.
 *
 * Durability is NOT here — it lives in the `messages` table; the bus only fans a
 * row out to whoever is currently listening. A surface that was disconnected
 * recovers missed rows from the transcript snapshot on (re)connect, so the bus
 * carries no replay buffer (`architecture.md` §9).
 */
export interface CompanionEventBus {
  /**
   * Fan a freshly appended row out to every live subscriber for that companion.
   * Best-effort and synchronous: it never throws to the caller (a slow or broken
   * subscriber must not break persistence) and is a no-op when nobody listens.
   */
  publish(companionId: string, message: MessageDto): void;
  /** Open a subscription to a companion's appended rows, in publish order. */
  subscribe(companionId: string): CompanionSubscription;
}

/**
 * A live subscription: an async iterable of appended rows plus a {@link close} to
 * release it. The route iterates `events` and calls `close()` from its
 * connection-close handler (idempotent).
 */
export interface CompanionSubscription {
  readonly events: AsyncIterableIterator<MessageDto>;
  close(): void;
}

/**
 * The single-process implementation: a `Map<companionId, Set<subscriber>>`. Each
 * subscriber is a small queue + waiter that bridges the synchronous {@link publish}
 * into an async iterator. Correct for one API instance (the Phase 0–1 deployment);
 * the {@link CompanionEventBus} interface is the seam to swap in Postgres
 * `LISTEN/NOTIFY` (or Redis) when running multiple replicas (`architecture.md` §9).
 */
export class InProcessCompanionEventBus implements CompanionEventBus {
  private readonly subscribers = new Map<string, Set<Subscriber>>();

  publish(companionId: string, message: MessageDto): void {
    const set = this.subscribers.get(companionId);
    if (!set) return;
    for (const subscriber of set) {
      subscriber.push(message);
    }
  }

  subscribe(companionId: string): CompanionSubscription {
    let set = this.subscribers.get(companionId);
    if (!set) {
      set = new Set<Subscriber>();
      this.subscribers.set(companionId, set);
    }
    const known = set;
    const subscriber = new Subscriber(() => {
      known.delete(subscriber);
      // Drop the companion's empty bucket so the Map doesn't grow unbounded with
      // companions that have come and gone.
      if (known.size === 0) {
        this.subscribers.delete(companionId);
      }
    });
    known.add(subscriber);
    return { events: subscriber, close: () => subscriber.close() };
  }
}

/**
 * One subscriber's queue. A row arriving while the consumer is parked at `next()`
 * resolves the waiter directly; otherwise it buffers until the consumer asks. The
 * buffer is unbounded — appended rows are infrequent and consumers (one SSE
 * socket) drain promptly, and a stalled consumer is bounded in practice by the
 * connection being closed.
 */
class Subscriber implements AsyncIterableIterator<MessageDto> {
  private readonly queue: MessageDto[] = [];
  private waiting: ((result: IteratorResult<MessageDto>) => void) | null = null;
  private closed = false;

  constructor(private readonly onClose: () => void) {}

  push(message: MessageDto): void {
    if (this.closed) return;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: message, done: false });
      return;
    }
    this.queue.push(message);
  }

  next(): Promise<IteratorResult<MessageDto>> {
    const buffered = this.queue.shift();
    if (buffered !== undefined) {
      return Promise.resolve({ value: buffered, done: false });
    }
    if (this.closed) {
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }

  /** Iterator protocol: closing the consumer (e.g. `break`/`return`) releases it. */
  return(): Promise<IteratorResult<MessageDto>> {
    this.close();
    return Promise.resolve({ value: undefined, done: true });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: undefined, done: true });
    }
    this.onClose();
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<MessageDto> {
    return this;
  }
}
