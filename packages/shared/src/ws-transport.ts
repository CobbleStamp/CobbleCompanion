/**
 * The canonical `/ws` client transport (docs/companion-endpoints.md), shared by every
 * Node consumer that speaks the backend's realtime envelope: the Discord adapter and the
 * API test client. It owns ONE connection — requests multiplex over the socket correlated
 * by a per-request id; a {@link WsResultMessage} resolves the call, a {@link
 * WsErrorMessage} rejects it, and a streaming method's chunks ({@link WsStreamMessage})
 * feed an async generator until its terminal result ends it. Unsolicited {@link
 * WsEventMessage}s (no id) fan out to the live-event subscribers; `embodiment.ready` /
 * `embodiment.superseded` drive the connection lifecycle.
 *
 * It is socket-agnostic: callers inject a {@link WsSocketFactory} (a real `ws` socket in
 * the adapter, Node's global `WebSocket` in tests), so the envelope/lifecycle logic is
 * exercised without a real network (fakes over mocks). It is also auth-agnostic — {@link
 * connect} takes the fully-formed `/ws` URL plus the handshake headers; how those are
 * produced is the caller's concern. The module speaks only `@cobble/shared` types and
 * pulls in no Node or browser API, so it is safe to ship to every package.
 *
 * (The web client keeps its own browser-singleton transport: it layers reconnect,
 * companion-switching, and a process-wide socket on top of this same envelope.)
 */

import type { WsServerMessage } from './contracts.js';

/** Standard WebSocket `readyState` for an open socket (`ws` mirrors the browser). */
const SOCKET_OPEN = 1;

/**
 * The companion was claimed by a newer embodiment (another surface summoned it —
 * "newer wins", docs/architecture.md §6). A consumer must NOT auto-reconnect, or the two
 * ends would fight over the room; instead it goes dormant until the next summon.
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
 * The minimal socket surface this transport needs — satisfied by the `ws` `WebSocket`
 * and by Node's global `WebSocket` (each via a small factory), and by a fake in tests.
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

/** The minimal logger the transport reports dropped frames / misbehaving listeners to. */
export interface WsTransportLogger {
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export interface WsTransportOptions {
  /**
   * Socket factory — REQUIRED by design, no default. This module is environment-agnostic
   * (it pulls in no Node or browser API), so it cannot reach for a concrete socket: the
   * caller injects their environment's one (the real `ws` socket, Node's global
   * `WebSocket`, or a test fake). The Node default lives in
   * `packages/discord/src/connection.ts`; keep this field required so the shared module
   * never has to import Node `ws`.
   */
  readonly factory: WsSocketFactory;
  /** Structured logger for dropped frames and misbehaving event listeners. */
  readonly logger: WsTransportLogger;
}

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
 * socket are yielded by one `iterate()` generator in order; `end()` completes it
 * (carrying the terminal result as the generator's return value), `fail()` makes it
 * throw.
 */
export class StreamQueue {
  private readonly buffer: unknown[] = [];
  private waiter: ((result: IteratorResult<unknown>) => void) | null = null;
  private failure: Error | null = null;
  private finished = false;
  private terminal: unknown;

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

  end(result?: unknown): void {
    if (this.finished || this.failure) return;
    this.finished = true;
    this.terminal = result;
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

  async *iterate(): AsyncGenerator<unknown, unknown> {
    for (;;) {
      if (this.buffer.length > 0) {
        yield this.buffer.shift();
        continue;
      }
      if (this.failure) throw this.failure;
      if (this.finished) return this.terminal;
      const result = await new Promise<IteratorResult<unknown>>((resolve) => {
        this.waiter = resolve;
      });
      if (this.failure) throw this.failure;
      if (result.done) return this.terminal;
      yield result.value;
    }
  }
}

type LifecycleState = 'idle' | 'opening' | 'open' | 'closed';

/** A live-event listener: receives every server-pushed `{ event, data }` frame. */
export type EventListener = (event: string, data: unknown) => void;

/**
 * How a socket ended, handed to {@link WsTransport.onClose} subscribers:
 * - `superseded`: the close followed an `embodiment.superseded` (the room was claimed
 *   elsewhere); the supersession path already drives teardown, so subscribers ignore it.
 * - `deliberate`: the caller invoked {@link WsTransport.close} (our own teardown), as
 *   opposed to an unexpected drop (server bounce, idle timeout, 1006) to reconcile.
 */
export interface CloseInfo {
  readonly code: number;
  readonly superseded: boolean;
  readonly deliberate: boolean;
}

/** A connection-close listener: fired once when the socket ends, for any reason. */
export type CloseListener = (info: CloseInfo) => void;

export class WsTransport {
  private socket: WsSocket | null = null;
  private state: LifecycleState = 'idle';
  private seq = 0;
  private superseded = false;
  private closedByCaller = false;
  private readonly pending = new Map<string, Pending>();
  private readonly streams = new Map<string, StreamQueue>();
  private readonly eventListeners = new Set<EventListener>();
  private readonly closeListeners = new Set<CloseListener>();
  private pendingOpen: { resolve: () => void; reject: (error: Error) => void } | null = null;
  private readonly factory: WsSocketFactory;
  private readonly logger: WsTransportLogger;

  constructor(opts: WsTransportOptions) {
    this.factory = opts.factory;
    this.logger = opts.logger;
  }

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
    socket.on('close', (code) => this.handleClose(code));
    await new Promise<void>((resolve, reject) => {
      this.pendingOpen = { resolve, reject };
    });
  }

  /** Subscribe to server-pushed live events. Returns an unsubscribe. */
  onEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /**
   * Subscribe to the socket closing (any reason). Returns an unsubscribe. Unlike a
   * pending call or stream, an event-channel consumer has no in-flight request to fail
   * on close, so it must be told here or it hangs.
   */
  onClose(listener: CloseListener): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
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

  /**
   * A streaming call: yield each chunk, ending on the terminal result (throwing on
   * error). The terminal `result` payload is the generator's RETURN value — invisible
   * to a plain `for await`, but capturable with `yield*` — so a caller that needs the
   * method's outcome beyond the chunks (e.g. `mission.advance`'s skip flag) can read it.
   */
  async *callStream(method: string, params?: unknown): AsyncGenerator<unknown, unknown> {
    const id = this.nextId();
    const queue = new StreamQueue();
    this.streams.set(id, queue);
    this.send({ id, method, params });
    try {
      return yield* queue.iterate();
    } finally {
      this.streams.delete(id);
    }
  }

  /** Close the connection deliberately; in-flight work is failed via the close path. */
  close(code?: number): void {
    // Mark this as caller-initiated so onClose subscribers can tell our own teardown
    // apart from an unexpected drop (and not double-reconcile a close we asked for).
    this.closedByCaller = true;
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
      // entry is failed by handleClose, so dropping the write here is safe.
      return;
    }
    socket.send(JSON.stringify(message));
  }

  private onMessage(raw: string): void {
    let message: WsServerMessage;
    try {
      message = JSON.parse(raw) as WsServerMessage;
    } catch (error) {
      // A malformed frame has no id to correlate, so the call/stream maps can't be
      // touched; drop it — but never silently (no unlogged catch). Log the byte length
      // rather than the raw payload to avoid spilling unparsed wire data into logs.
      this.logger.warn('ws: dropped unparseable server frame', {
        error,
        bytes: raw.length,
      });
      return;
    }
    if ('stream' in message) {
      this.streams.get(message.id)?.push(message.stream);
      return;
    }
    if ('result' in message) {
      this.streams.get(message.id)?.end(message.result);
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
    // Isolate each listener: one that throws must not abort the rest or propagate back
    // into the socket message pump (which would tear the connection down). Log and move on.
    for (const listener of this.eventListeners) {
      try {
        listener(message.event, message.data);
      } catch (error) {
        this.logger.error('ws: event listener threw', {
          error,
          event: message.event,
        });
      }
    }
  }

  /** The socket dropped: fail every in-flight call/stream so nothing hangs. */
  private handleClose(code: number): void {
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
    // Wake the event-channel consumers. They are parked waiting on a server push, not on
    // a pending call, so the failures above never reach them; without this notice they
    // wait forever on a dead socket.
    const info: CloseInfo = {
      code,
      superseded: this.superseded,
      deliberate: this.closedByCaller,
    };
    for (const listener of this.closeListeners) {
      try {
        listener(info);
      } catch (error) {
        this.logger.error('ws: close listener threw', { error, code });
      }
    }
  }
}
