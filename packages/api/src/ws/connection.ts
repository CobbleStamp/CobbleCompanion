import type { Logger } from '@cobble/core';
import type { WsServerMessage } from '@cobble/shared';
import type { WebSocket } from '@fastify/websocket';

/** The companion this connection embodies + the ULID it holds the claim with (D2). */
export interface EmbodimentBinding {
  readonly companionId: string;
  readonly owner: string;
  readonly generation: number;
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

  constructor(
    private readonly socket: WebSocket,
    readonly userId: string,
    private readonly logger: Logger,
  ) {}

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

  private send(message: WsServerMessage): void {
    try {
      this.socket.send(JSON.stringify(message));
    } catch (error) {
      this.logger.error('ws send failed', { operation: 'ws.send', error });
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

  close(code?: number, reason?: string): void {
    try {
      this.socket.close(code, reason);
    } catch {
      // Already closed — nothing to do.
    }
  }
}
