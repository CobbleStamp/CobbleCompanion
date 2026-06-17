/**
 * Per-connection in-flight cap (S3): frames multiplex over one socket, so the
 * connection bounds how many dispatch concurrently. Past the cap `beginRequest`
 * returns false (the caller sheds the frame); `endRequest` frees a slot.
 */

import type { Logger } from '@cobble/core';
import type { WebSocket } from '@fastify/websocket';
import { describe, expect, it } from 'vitest';
import { WsConnection } from './connection.js';

const silentLogger: Logger = { error: () => {}, warn: () => {}, info: () => {} };
const noopSocket = { send: () => {}, close: () => {} } as unknown as WebSocket;

describe('WsConnection in-flight cap', () => {
  it('admits up to maxInFlight requests, then sheds', () => {
    const connection = new WsConnection(noopSocket, 'user-1', silentLogger, 2);

    expect(connection.beginRequest()).toBe(true);
    expect(connection.beginRequest()).toBe(true);
    // At the cap — the third frame is shed.
    expect(connection.beginRequest()).toBe(false);
  });

  it('frees a slot on endRequest so a later frame is admitted', () => {
    const connection = new WsConnection(noopSocket, 'user-1', silentLogger, 1);

    expect(connection.beginRequest()).toBe(true);
    expect(connection.beginRequest()).toBe(false);
    connection.endRequest();
    expect(connection.beginRequest()).toBe(true);
  });
});
