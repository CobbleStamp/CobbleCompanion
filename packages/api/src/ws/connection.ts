import type { Logger } from '@cobble/core';
import type { WsServerMessage } from '@cobble/shared';
import type { WebSocket } from '@fastify/websocket';

/**
 * One authenticated WebSocket connection (deliver-scalability.md §5.2, Phase D).
 * Wraps the raw socket to send correlated responses and unsolicited events as JSON
 * envelopes, and carries the connection's `userId` (resolved once at the handshake,
 * fixed for the connection's life). Sends are best-effort: a write to a
 * just-closed socket is logged, never thrown (a dropped client is normal).
 */
export class WsConnection {
  constructor(
    private readonly socket: WebSocket,
    readonly userId: string,
    private readonly logger: Logger,
  ) {}

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
