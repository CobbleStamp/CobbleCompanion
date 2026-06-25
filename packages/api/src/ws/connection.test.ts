/**
 * Per-connection in-flight cap (S3): frames multiplex over one socket, so the
 * connection bounds how many dispatch concurrently. Past the cap `beginRequest`
 * returns false (the caller sheds the frame); `endRequest` frees a slot.
 */

import type { Logger } from '@cobble/core';
import type { WebSocket } from '@fastify/websocket';
import { describe, expect, it, vi } from 'vitest';
import { SLOW_CONSUMER_CLOSE, WsConnection } from './connection.js';

const silentLogger: Logger = { error: () => {}, warn: () => {}, info: () => {} };
const noopSocket = { send: () => {}, close: () => {} } as unknown as WebSocket;

const OPEN = 1;
const HIGH_WATER = 8 * 1024 * 1024;

/** A socket whose `bufferedAmount` is controllable, recording sends + closes. */
function controllableSocket(): {
  socket: WebSocket;
  sent: string[];
  closes: { code: number | undefined; reason: string | undefined }[];
  bufferedAmount: number;
} {
  const state = {
    sent: [] as string[],
    closes: [] as { code: number | undefined; reason: string | undefined }[],
    bufferedAmount: 0,
  };
  const socket = {
    OPEN,
    get readyState() {
      // Once closed, the socket reports CLOSING (2), mirroring `ws`.
      return state.closes.length > 0 ? 2 : OPEN;
    },
    get bufferedAmount() {
      return state.bufferedAmount;
    },
    send: (data: string) => state.sent.push(data),
    close: (code?: number, reason?: string) => state.closes.push({ code, reason }),
  } as unknown as WebSocket;
  return {
    socket,
    get sent() {
      return state.sent;
    },
    get closes() {
      return state.closes;
    },
    set bufferedAmount(value: number) {
      state.bufferedAmount = value;
    },
    get bufferedAmount() {
      return state.bufferedAmount;
    },
  };
}

describe('WsConnection in-flight cap', () => {
  it('admits up to maxInFlight requests, then sheds', () => {
    const connection = new WsConnection(
      noopSocket,
      'user-1',
      'conn-1',
      silentLogger,
      2,
      HIGH_WATER,
    );

    expect(connection.beginRequest()).toBe(true);
    expect(connection.beginRequest()).toBe(true);
    // At the cap — the third frame is shed.
    expect(connection.beginRequest()).toBe(false);
  });

  it('frees a slot on endRequest so a later frame is admitted', () => {
    const connection = new WsConnection(
      noopSocket,
      'user-1',
      'conn-1',
      silentLogger,
      1,
      HIGH_WATER,
    );

    expect(connection.beginRequest()).toBe(true);
    expect(connection.beginRequest()).toBe(false);
    connection.endRequest();
    expect(connection.beginRequest()).toBe(true);
  });
});

describe('WsConnection outbound backpressure', () => {
  it('delivers normally while the buffer is below the ceiling', () => {
    const harness = controllableSocket();
    const connection = new WsConnection(harness.socket, 'user-1', 'conn-1', silentLogger, 32, 1000);

    harness.bufferedAmount = 999;
    connection.pushEvent('companion', { n: 1 });

    expect(harness.sent).toHaveLength(1);
    expect(harness.closes).toHaveLength(0);
  });

  it('closes the connection (and drops the frame) once the buffer outgrows the ceiling', () => {
    const harness = controllableSocket();
    const warn = vi.fn();
    const logger: Logger = { error: () => {}, warn, info: () => {} };
    const connection = new WsConnection(harness.socket, 'user-1', 'conn-1', logger, 32, 1000);

    // A non-draining consumer: the buffer is already past the ceiling.
    harness.bufferedAmount = 1001;
    connection.pushEvent('companion', { n: 1 });

    // The frame is NOT enqueued (enqueuing would grow the backlog we're shedding)...
    expect(harness.sent).toHaveLength(0);
    // ...and the connection is closed with the slow-consumer code.
    expect(harness.closes).toEqual([{ code: SLOW_CONSUMER_CLOSE, reason: 'slow consumer' }]);
    expect(warn).toHaveBeenCalledTimes(1);
    // The warning is attributable to this connection (connectionId rides every line).
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ connectionId: 'conn-1', userId: 'user-1' }),
    );
  });

  it('logs + closes exactly once even if more sends race in', () => {
    const harness = controllableSocket();
    const warn = vi.fn();
    const logger: Logger = { error: () => {}, warn, info: () => {} };
    const connection = new WsConnection(harness.socket, 'user-1', 'conn-1', logger, 32, 1000);

    harness.bufferedAmount = 5000;
    connection.pushEvent('companion', { n: 1 });
    connection.pushEvent('companion', { n: 2 });
    connection.result('req-1', { ok: true });

    expect(harness.closes).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(harness.sent).toHaveLength(0);
  });
});
