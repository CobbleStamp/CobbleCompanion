/**
 * The Discord adapter's WebSocket transport to the companion backend's `/ws`
 * (`docs/companion-endpoints.md`). It is the Node-side analogue of the web client's
 * transport (`packages/web/src/api/ws.ts`), but deliberately simpler: each per-user
 * bridge owns exactly one connection (one companion, one room), so there is no
 * singleton, no reconnect-on-tab logic, and no companion-switching — a bridge that
 * needs a different companion opens a fresh transport.
 *
 * It is **auth-agnostic**: `connect` takes the fully-formed `/ws` URL plus the
 * handshake `headers`. *How* those are produced (a minted user access token vs.
 * service-token headers) is the caller's concern (`docs/plans/discord-surface.md`
 * §11 / the auth decision) — this module only speaks the wire envelope.
 *
 * Requests multiplex over the one socket, correlated by a per-request id; a
 * {@link WsResultMessage} resolves the call, a {@link WsErrorMessage} rejects it, and
 * a streaming method's chunks ({@link WsStreamMessage}) feed an async generator until
 * its terminal result ends it. Unsolicited {@link WsEventMessage}s (no id) fan out to
 * the live-event subscribers; `embodiment.ready` / `embodiment.superseded` drive the
 * connection lifecycle.
 */

import { WebSocket as NodeWebSocket } from 'ws';
import type { WsServerMessage } from '@cobble/shared';

/** Standard WebSocket `readyState` for an open socket (`ws` mirrors the browser). */
const SOCKET_OPEN = 1;

/**
 * The companion was claimed by a newer embodiment (another surface summoned it —
 * "newer wins", `docs/architecture.md` §6). The bridge must NOT auto-reconnect, or the
 * two ends would fight over the room; instead it goes Dormant and waits for the next
 * `/summon` (`docs/companion-discord.md` §4).
 */
export class SupersededError extends Error {
  constructor() {
    super('companion was claimed by another surface');
    this.name = 'SupersededError';
  }
}

/** The connection dropped (closed) while calls/streams were in flight. */
export class ConnectionClosedError extends Error {
  constructor(code?: number) {
    super(code === undefined ? 'websocket closed' : `websocket closed (${code})`);
    this.name = 'ConnectionClosedError';
  }
}

/**
 * A server error frame for a call/stream — carries the optional machine `code` (e.g.
 * `over_cap`, `not_embodied`) alongside the message, so callers can branch on it (the
 * chat handler turns `over_cap` into a feed nudge).
 */
export class WsCallError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'WsCallError';
  }
}

/**
 * The minimal socket surface this transport needs — satisfied by the `ws`
 * `WebSocket` (via {@link defaultSocketFactory}) and by a fake in tests, so the
 * envelope/lifecycle logic is exercised without a real network (fakes over mocks).
 */
export interface WsSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number): void;
  on(event: 'open', listener: () => void): void;
  on(event: 'message', listener: (data: string) => void): void;
  on(event: 'close', listener: (code: number) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
}

export type WsSocketFactory = (url: string, headers: Record<string, string>) => WsSocket;

/** The production factory: a real `ws` socket, normalising inbound frames to string. */
export const defaultSocketFactory: WsSocketFactory = (url, headers) => {
  const socket = new NodeWebSocket(url, { headers });
  return {
    get readyState(): number {
      return socket.readyState;
    },
    send: (data) => socket.send(data),
    close: (code) => socket.close(code),
    on(event, listener): void {
      if (event === 'message') {
        socket.on('message', (data) =>
          (listener as (data: string) => void)(
            typeof data === 'string' ? data : data.toString('utf8'),
          ),
        );
      } else if (event === 'close') {
        socket.on('close', (code) => (listener as (code: number) => void)(code));
      } else if (event === 'error') {
        socket.on('error', (error) => (listener as (error: Error) => void)(error));
      } else {
        socket.on('open', listener as () => void);
      }
    },
  };
};

export interface ConnectOptions {
  /** The full `wss://host/ws?...` URL (companion query param already encoded). */
  readonly url: string;
  /** Handshake headers (auth). Empty is allowed for a token-in-query connection. */
  readonly headers: Record<string, string>;
  /**
   * True when the URL names a companion to embody: the connection is usable only
   * once the server grants the lease (`embodiment.ready`), so a companion-scoped call
   * can never race the claim and be rejected `not_embodied`. False = transport-only
   * (usable the instant the upgrade completes).
   */
  readonly embodying: boolean;
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

/**
 * A single-consumer async queue backing a streaming response: chunks pushed by the
 * socket are yielded by one `iterate()` generator in order; `end()` completes it,
 * `fail()` makes it throw. Mirrors the web transport's queue.
 */
class StreamQueue {
  private readonly buffer: unknown[] = [];
  private waiter: ((result: IteratorResult<unknown>) => void) | null = null;
  private failure: Error | null = null;
  private finished = false;

  push(chunk: unknown): void {
    if (this.finished || this.failure) return;
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      waiter({ value: chunk, done: false });
    } else {
      this.buffer.push(chunk);
    }
  }

  end(): void {
    if (this.finished || this.failure) return;
    this.finished = true;
    this.wake();
  }

  fail(error: Error): void {
    if (this.finished || this.failure) return;
    this.failure = error;
    this.wake();
  }

  private wake(): void {
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      waiter({ value: undefined, done: true });
    }
  }

  async *iterate(): AsyncGenerator<unknown> {
    for (;;) {
      if (this.buffer.length > 0) {
        yield this.buffer.shift();
        continue;
      }
      if (this.failure) throw this.failure;
      if (this.finished) return;
      const result = await new Promise<IteratorResult<unknown>>((resolve) => {
        this.waiter = resolve;
      });
      if (this.failure) throw this.failure;
      if (result.done) return;
      yield result.value;
    }
  }
}

type LifecycleState = 'idle' | 'opening' | 'open' | 'closed';

/** A live-event listener: receives every server-pushed `{ event, data }` frame. */
export type EventListener = (event: string, data: unknown) => void;

export class WsTransport {
  private socket: WsSocket | null = null;
  private state: LifecycleState = 'idle';
  private seq = 0;
  private superseded = false;
  private readonly pending = new Map<string, Pending>();
  private readonly streams = new Map<string, StreamQueue>();
  private readonly eventListeners = new Set<EventListener>();
  private pendingOpen: { resolve: () => void; reject: (error: Error) => void } | null = null;

  constructor(private readonly factory: WsSocketFactory = defaultSocketFactory) {}

  /**
   * Open the connection, resolving once it is usable: for a transport-only socket the
   * instant the upgrade completes; for an embodying socket once `embodiment.ready`
   * arrives. Rejects with {@link SupersededError} if the room is lost before the lease
   * is granted, or {@link ConnectionClosedError} if it closes during the handshake.
   */
  async connect(opts: ConnectOptions): Promise<void> {
    if (this.state !== 'idle') {
      throw new Error('transport already used; create a fresh WsTransport per connection');
    }
    this.state = 'opening';
    const socket = this.factory(opts.url, opts.headers);
    this.socket = socket;
    socket.on('message', (data) => this.onMessage(data));
    socket.on('open', () => {
      if (!opts.embodying) this.settleOpen();
    });
    socket.on('error', (error) => {
      if (this.state === 'opening') this.settleOpen(error);
    });
    socket.on('close', (code) => this.onClose(code));
    await new Promise<void>((resolve, reject) => {
      this.pendingOpen = { resolve, reject };
    });
  }

  /** Subscribe to server-pushed live events. Returns an unsubscribe. */
  onEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** A non-streaming call: send the request, resolve with its result (or reject). */
  async call<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId();
    const result = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.send({ id, method, params });
    return (await result) as T;
  }

  /** A streaming call: yield each chunk, ending on the terminal result (throwing on error). */
  async *callStream(method: string, params?: unknown): AsyncGenerator<unknown> {
    const id = this.nextId();
    const queue = new StreamQueue();
    this.streams.set(id, queue);
    this.send({ id, method, params });
    try {
      yield* queue.iterate();
    } finally {
      this.streams.delete(id);
    }
  }

  /** Close the connection deliberately; in-flight work is failed via the close path. */
  close(code?: number): void {
    const socket = this.socket;
    if (socket) {
      try {
        socket.close(code);
      } catch {
        // already closing; the close handler still runs
      }
    }
  }

  get isSuperseded(): boolean {
    return this.superseded;
  }

  private nextId(): string {
    this.seq += 1;
    return `r${this.seq}`;
  }

  private settleOpen(error?: Error): void {
    const pending = this.pendingOpen;
    if (!pending) return;
    this.pendingOpen = null;
    if (error) {
      pending.reject(error);
    } else {
      this.state = 'open';
      pending.resolve();
    }
  }

  private send(message: { id: string; method: string; params?: unknown }): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== SOCKET_OPEN) {
      // The socket closed between the caller's await and this send; the pending/stream
      // entry is failed by onClose, so dropping the write here is safe.
      return;
    }
    socket.send(JSON.stringify(message));
  }

  private onMessage(raw: string): void {
    let message: WsServerMessage;
    try {
      message = JSON.parse(raw) as WsServerMessage;
    } catch {
      return; // a malformed frame has no id to correlate; drop it
    }
    if ('stream' in message) {
      this.streams.get(message.id)?.push(message.stream);
      return;
    }
    if ('result' in message) {
      this.streams.get(message.id)?.end();
      this.pending.get(message.id)?.resolve(message.result);
      this.pending.delete(message.id);
      return;
    }
    if ('error' in message) {
      const error = new WsCallError(message.error.message, message.error.code);
      const stream = this.streams.get(message.id);
      if (stream) stream.fail(error);
      this.pending.get(message.id)?.reject(error);
      this.pending.delete(message.id);
      return;
    }
    if (message.event === 'embodiment.ready') {
      this.settleOpen();
      return;
    }
    if (message.event === 'embodiment.superseded') {
      this.superseded = true;
      // Lost the room before the lease was granted: fail an in-progress open so the
      // caller sees SupersededError rather than hanging on a grant that won't come.
      this.settleOpen(new SupersededError());
    }
    for (const listener of this.eventListeners) {
      listener(message.event, message.data);
    }
  }

  /** The socket dropped: fail every in-flight call/stream so nothing hangs. */
  private onClose(code: number): void {
    if (this.state === 'closed') return;
    const wasOpening = this.state === 'opening';
    this.state = 'closed';
    const error = this.superseded ? new SupersededError() : new ConnectionClosedError(code);
    if (wasOpening) this.settleOpen(error);
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
    for (const stream of this.streams.values()) {
      stream.fail(error);
    }
    this.streams.clear();
  }
}
