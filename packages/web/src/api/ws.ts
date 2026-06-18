/**
 * The single realtime WebSocket transport (deliver-scalability.md §5.2, Phase D).
 *
 * One companion lives in one "room" at a time, so the client holds at most one
 * socket. A socket that names a companion (`?companion=`) *embodies* it: every
 * companion-scoped call rides that socket, and the server pushes the companion's
 * live events down it. Calls that don't need a companion (sign-in check, listing
 * companions) ride whatever socket is open, or a transport-only one.
 *
 * Requests multiplex over the one socket, correlated by a per-request id; the reply
 * (a {@link WsResultMessage}) resolves the call, a {@link WsErrorMessage} rejects it,
 * and a streaming method's chunks ({@link WsStreamMessage}) feed an async generator
 * until its terminal result ends it. Unsolicited {@link WsEventMessage}s (no id) fan
 * out to the live-event subscribers — the server-pushed event stream of the
 * embodiment connection.
 *
 * `client.ts` is the public, signature-stable API; this module is the transport it
 * sits on. File upload stays an HTTP endpoint (the two-part upload of D-A).
 */

import type { CompanionStreamEvent, WsEventMessage, WsServerMessage } from '@cobble/shared';

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? '';

type AccessTokenGetter = () => Promise<string | null>;
let getAccessToken: AccessTokenGetter = async () => null;

/** Wired by <App/> on sign-in; the transport reads it at every (re)connect so the
 *  handshake carries a fresh bearer. */
export function setAccessTokenGetter(getter: AccessTokenGetter): void {
  getAccessToken = getter;
}

/** Bearer header for the one remaining HTTP call (the multipart file upload); empty
 *  when auth is bypassed. Keeps the token's single source of truth in this module. */
export async function authHeaders(): Promise<Record<string, string>> {
  const token = await getAccessToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

/**
 * The connection was taken over by a newer embodiment — another tab or device
 * claimed this companion (deliver-scalability.md §5.2, "newer wins"). The owner must
 * NOT auto-reconnect, or the two ends would fight over the room forever; instead the
 * UI surfaces a "use here" affordance that calls {@link reclaim}.
 */
export class SupersededError extends Error {
  constructor() {
    super('Cobble is active in another window');
    this.name = 'SupersededError';
  }
}

/** Derive the ws(s):// origin from the configured API URL, or the page's own. */
function wsOrigin(): string {
  if (API_URL) {
    return API_URL.replace(/^http/, 'ws'); // http→ws, https→wss
  }
  const { protocol, host } = window.location;
  return `${protocol === 'https:' ? 'wss:' : 'ws:'}//${host}`;
}

function wsUrl(companionId: string | null, token: string): string {
  const params = new URLSearchParams({ access_token: token });
  if (companionId) {
    params.set('companion', companionId);
  }
  return `${wsOrigin()}/ws?${params.toString()}`;
}

/**
 * A single-consumer async queue: chunks pushed by the socket are yielded by one
 * `iterate()` generator, in order. Backs both a streaming method's response and a
 * live-event subscription. `end()` completes the generator; `fail()` makes it throw.
 */
class StreamQueue {
  private readonly buffer: unknown[] = [];
  private waiter: ((result: IteratorResult<unknown>) => void) | null = null;
  private failure: Error | null = null;
  private done = false;

  push(chunk: unknown): void {
    if (this.done || this.failure) return;
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      waiter({ value: chunk, done: false });
    } else {
      this.buffer.push(chunk);
    }
  }

  end(): void {
    if (this.done || this.failure) return;
    this.done = true;
    this.wake();
  }

  fail(error: Error): void {
    if (this.done || this.failure) return;
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
      if (this.done) return;
      const result = await new Promise<IteratorResult<unknown>>((resolve) => {
        this.waiter = resolve;
      });
      if (this.buffer.length === 0) {
        if (this.failure) throw this.failure;
        if (result.done) return;
      }
      if (!result.done) {
        yield result.value;
      }
    }
  }
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

type StateListener = (state: 'superseded') => void;

/**
 * The transport singleton. Lazily (re)connects to embody the requested companion,
 * reusing the live socket when it already embodies it (or when the call is
 * companion-agnostic). Holds in-flight RPCs, streaming queues, and live-event
 * subscribers, and routes each inbound frame to the right one by id (or, for an
 * event, to every subscriber).
 */
class WsClient {
  private socket: WebSocket | null = null;
  private embodied: string | null = null; // the companion the live socket embodies
  private opening: Promise<void> | null = null;
  private seq = 0;
  private superseded = false;
  private readonly pending = new Map<string, Pending>();
  private readonly streams = new Map<string, StreamQueue>();
  private readonly eventListeners = new Set<(event: WsEventMessage) => void>();
  private readonly closeListeners = new Set<() => void>();
  private readonly stateListeners = new Set<StateListener>();

  /** Subscribe to connection-state changes (currently only `superseded`). Returns an
   *  unsubscribe. The UI uses this to offer "use here" without polling. */
  onState(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /** Reclaim the room after being superseded: clear the yield so the next call
   *  reconnects and force-claims (a fresh, strictly-greater owner token wins). */
  reclaim(): void {
    this.superseded = false;
  }

  private nextId(): string {
    this.seq += 1;
    return `r${this.seq}`;
  }

  private emitState(state: 'superseded'): void {
    for (const listener of this.stateListeners) {
      listener(state);
    }
  }

  /** A non-streaming call: send the request, resolve with its result (or reject). */
  async call<T>(method: string, params: unknown, companionId: string | null): Promise<T> {
    await this.ensure(companionId);
    const id = this.nextId();
    const result = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.send({ id, method, params });
    return (await result) as T;
  }

  /** A streaming call: yield each chunk the server emits, ending on the terminal
   *  result (or throwing on its error). */
  async *callStream(
    method: string,
    params: unknown,
    companionId: string | null,
  ): AsyncGenerator<unknown> {
    await this.ensure(companionId);
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

  /**
   * Subscribe to the companion's live event stream over the WebSocket: yields
   * each pushed `companion` event for `companionId` until `signal` aborts or the
   * socket drops. An abort/drop ends the generator quietly — the caller owns
   * reconnect — and a takeover (superseded) ends it too, with {@link onState}
   * carrying the takeover to the UI.
   */
  async *events(companionId: string, signal: AbortSignal): AsyncGenerator<CompanionStreamEvent> {
    const queue = new StreamQueue();
    const onEvent = (event: WsEventMessage): void => {
      if (event.event === 'companion') {
        queue.push(event.data);
      }
    };
    const onClose = (): void => queue.end();
    const onAbort = (): void => queue.end();
    this.eventListeners.add(onEvent);
    this.closeListeners.add(onClose);
    signal.addEventListener('abort', onAbort);
    try {
      if (signal.aborted) return;
      await this.ensure(companionId);
      for await (const data of queue.iterate()) {
        if (signal.aborted) return;
        yield data as CompanionStreamEvent;
      }
    } catch (error) {
      if (signal.aborted || error instanceof SupersededError) return;
      throw error;
    } finally {
      this.eventListeners.delete(onEvent);
      this.closeListeners.delete(onClose);
      signal.removeEventListener('abort', onAbort);
    }
  }

  private send(message: { id: string; method: string; params: unknown }): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      // ensure() ran first, so this is a rare close-between-ensure-and-send; the
      // pending/stream entry is failed by onClose, so just drop the write.
      return;
    }
    socket.send(JSON.stringify(message));
  }

  /** Ensure a live socket embodying `want` (null = any open socket is fine). */
  private async ensure(want: string | null): Promise<void> {
    if (this.superseded) throw new SupersededError();
    for (;;) {
      const socket = this.socket;
      if (socket && socket.readyState === WebSocket.OPEN) {
        if (want === null || want === this.embodied) return;
        this.teardown(socket); // a different companion → reconnect below
      }
      if (this.opening) {
        await this.opening.catch(() => undefined);
        continue; // re-evaluate against the now-settled socket
      }
      this.opening = this.open(want ?? this.embodied);
      try {
        await this.opening;
      } finally {
        this.opening = null;
      }
      // loop re-checks: the fresh socket embodies `want` (or `want` is null)
    }
  }

  /** Open a fresh socket embodying `companionId`, resolving once it is OPEN. */
  private async open(companionId: string | null): Promise<void> {
    const token = await getAccessToken();
    if (!token) throw new Error('not authenticated');
    const socket = new WebSocket(wsUrl(companionId, token));
    this.socket = socket;
    this.embodied = companionId;
    socket.onmessage = (event: MessageEvent): void => {
      this.onMessage(typeof event.data === 'string' ? event.data : String(event.data));
    };
    await new Promise<void>((resolve, reject) => {
      socket.onopen = (): void => resolve();
      socket.onerror = (): void => reject(new Error('websocket connection failed'));
      socket.onclose = (event: CloseEvent): void =>
        reject(new Error(`websocket closed before open (${event.code})`));
    });
    // Steady state: errors are logged, a close cleans up in-flight work.
    socket.onerror = null;
    socket.onclose = (): void => this.onClose(socket);
  }

  /** Drop a socket without firing the close cleanup (a deliberate reconnect). */
  private teardown(socket: WebSocket): void {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try {
      socket.close();
    } catch {
      // already closing; nothing to do
    }
    if (this.socket === socket) {
      this.socket = null;
      this.embodied = null;
    }
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
      const stream = this.streams.get(message.id);
      if (stream) stream.end();
      this.pending.get(message.id)?.resolve(message.result);
      this.pending.delete(message.id);
      return;
    }
    if ('error' in message) {
      const error = new Error(message.error.message);
      const stream = this.streams.get(message.id);
      if (stream) stream.fail(error);
      this.pending.get(message.id)?.reject(error);
      this.pending.delete(message.id);
      return;
    }
    if (message.event === 'embodiment.superseded') {
      this.superseded = true;
      this.emitState('superseded');
      return;
    }
    for (const listener of this.eventListeners) {
      listener(message);
    }
  }

  /** The live socket dropped: fail every in-flight call/stream so nothing hangs, and
   *  let the event subscribers' generators end so the UI can reconnect. */
  private onClose(socket: WebSocket): void {
    if (socket !== this.socket) return; // a superseded/torn-down socket; ignore
    this.socket = null;
    this.embodied = null;
    const error = this.superseded ? new SupersededError() : new Error('websocket closed');
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
    for (const stream of this.streams.values()) {
      stream.fail(error);
    }
    this.streams.clear();
    for (const listener of this.closeListeners) {
      listener();
    }
  }
}

/** The process-wide transport. One companion, one room, one socket. */
export const wsClient = new WsClient();
