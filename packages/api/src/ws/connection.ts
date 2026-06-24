import { type Logger, withContext } from '@cobble/core';
import type { WsServerMessage } from '@cobble/shared';
import type { WebSocket } from '@fastify/websocket';

/** WS close code for a connection whose companion was claimed by a newer one
 *  (deliver-scalability.md §5.2). Sent by both the heartbeat (a dead/idle holder
 *  loses the renew) and a turn that self-fences mid-loop. */
export const SUPERSEDED_CLOSE = 4002;

/** WS close code for a connection whose outbound buffer outgrew `maxBufferedBytes`
 *  — a slow/stuck/dead consumer the server stops feeding to protect node memory.
 *  1013 ("try again later") signals the client to reconnect; it then resumes live
 *  delivery from its cursor with no events lost (deliver-scalability.md §5.2). */
export const SLOW_CONSUMER_CLOSE = 1013;

/** The companion this connection embodies + the ULID it holds the claim with (D2). */
export interface EmbodimentBinding {
  readonly companionId: string;
  readonly connectionId: string;
  readonly claimSeq: number;
}

/**
 * One authenticated WebSocket connection (deliver-scalability.md §5.2, Phase D).
 * Wraps the raw socket to send correlated responses and unsolicited events as JSON
 * envelopes, and carries the connection's `userId` (resolved once at the handshake,
 * fixed for the connection's life). Sends are best-effort: a write to a
 * just-closed socket is logged, never thrown (a dropped client is normal).
 */
export class WsConnection {
  /** Set once the handshake-named companion is claimed (Phase D D2); undefined for
   *  a transport-only connection. */
  private boundEmbodiment: EmbodimentBinding | undefined;
  /** Tail of the per-connection serial chain — D2′ turn serialization. */
  private serialTail: Promise<unknown> = Promise.resolve();
  /** Requests currently dispatching on this connection (frames multiplex, so this
   *  can exceed 1); bounded by `maxInFlight` to shed load (S3). */
  private inFlight = 0;
  /** Set once we've closed this connection for backpressure, so we log + close
   *  exactly once even if more sends race in before the socket flips to CLOSING. */
  private shedForBackpressure = false;
  /** This connection's logger, pre-bound with `connectionId` + `userId` so every line
   *  emitted on its behalf (here, in dispatch, embody, and method handlers) is
   *  attributable to one connection — telling a superseded connection apart from its
   *  successor in the logs (deliver-scalability.md §5.2). */
  private readonly boundLogger: Logger;

  constructor(
    private readonly socket: WebSocket,
    readonly userId: string,
    /** Per-connection ULID: the log-correlation id AND the token the embodiment claim
     *  is fenced on (monotonic, so a later connection always force-claims over an
     *  earlier one — the "newer wins" handoff rule). */
    readonly connectionId: string,
    logger: Logger,
    /** Max concurrent in-flight requests before frames are shed (`AppConfig.wsMaxInFlight`). */
    private readonly maxInFlight: number,
    /** Max queued unsent bytes toward this client before it's closed as a slow
     *  consumer (`AppConfig.wsMaxBufferedBytes`). */
    private readonly maxBufferedBytes: number,
  ) {
    this.boundLogger = withContext(logger, { connectionId, userId });
  }

  /** This connection's `connectionId`/`userId`-bound logger — use it for any log
   *  emitted while serving this connection so the line carries its `connectionId`. */
  get logger(): Logger {
    return this.boundLogger;
  }

  get embodiment(): EmbodimentBinding | undefined {
    return this.boundEmbodiment;
  }

  bindEmbodiment(binding: EmbodimentBinding): void {
    this.boundEmbodiment = binding;
  }

  /**
   * Run `task` after all previously-enqueued serial tasks on this connection
   * settle (D2′): turn-producing messages must not run two agent loops at once.
   * Since all of a companion's turns arrive on this one connection, an in-process
   * chain is enough — no DB lock. Failures don't break the chain.
   */
  runSerial<T>(task: () => Promise<T>): Promise<T> {
    const result = this.serialTail.then(task, task);
    // Keep the chain alive regardless of this task's outcome.
    this.serialTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Reserve an in-flight slot for one inbound request (S3 load-shedding). Returns
   * false when the connection is already at `maxInFlight` — the caller must shed the
   * frame (reply `rate_limited`) and NOT dispatch it. Every `true` must be paired
   * with exactly one {@link endRequest} when the dispatch settles.
   */
  beginRequest(): boolean {
    if (this.inFlight >= this.maxInFlight) {
      return false;
    }
    this.inFlight += 1;
    return true;
  }

  /** Release the in-flight slot reserved by a prior {@link beginRequest} that returned true. */
  endRequest(): void {
    if (this.inFlight > 0) {
      this.inFlight -= 1;
    }
  }

  private send(message: WsServerMessage): void {
    // A closed/closing socket is normal — the client dropped, or we just superseded
    // this connection and the method's terminal result is racing the close. A send is
    // then a silent no-op, not a failure worth logging.
    if (this.socket.readyState !== this.socket.OPEN) {
      return;
    }
    // Backpressure (deliver-scalability.md §5.2): a WS write never blocks, so bytes a
    // slow/stuck/dead client hasn't acked queue in the process heap (`bufferedAmount`).
    // Past the ceiling, stop feeding this one connection and close it — a healthy
    // client reconnects and resumes from its cursor (no events lost); a non-draining
    // one is dropped before it can OOM the node. Drop this frame too: enqueuing it
    // would only grow the backlog we're shedding.
    if (this.socket.bufferedAmount > this.maxBufferedBytes) {
      if (!this.shedForBackpressure) {
        this.shedForBackpressure = true;
        this.boundLogger.warn('ws consumer too slow; closing to shed outbound backlog', {
          operation: 'ws.send',
          bufferedAmount: this.socket.bufferedAmount,
          maxBufferedBytes: this.maxBufferedBytes,
        });
        this.close(SLOW_CONSUMER_CLOSE, 'slow consumer');
      }
      return;
    }
    try {
      this.socket.send(JSON.stringify(message));
    } catch (error) {
      this.boundLogger.error('ws send failed', { operation: 'ws.send', error });
    }
  }

  /** Reply to request `id` with a result. */
  result(id: string, result: unknown): void {
    this.send({ id, result });
  }

  /** Reply to request `id` with a client-safe error. */
  fail(id: string, message: string, code?: string): void {
    this.send({ id, error: { message, ...(code !== undefined ? { code } : {}) } });
  }

  /** Push an unsolicited event (no request id) — the live channel. */
  pushEvent(event: string, data: unknown): void {
    this.send({ event, data });
  }

  /** Emit one chunk of a streaming method's response, correlated to request `id`.
   *  The terminal `result(id, …)` ends the stream. */
  stream(id: string, chunk: unknown): void {
    this.send({ id, stream: chunk });
  }

  close(code?: number, reason?: string): void {
    try {
      this.socket.close(code, reason);
    } catch {
      // Already closed — nothing to do.
    }
  }
}
