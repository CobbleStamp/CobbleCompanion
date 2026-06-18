/**
 * WS dispatcher error allowlisting (S2): a thrown handler error must only reach the
 * client verbatim when it is a {@link WsClientError}. An error from the DB driver /
 * gateway / harness — even one carrying a string `code` (a `pg` SQLSTATE, a Node
 * system errno) — is reported generically so its message can't leak internal detail,
 * mirroring the HTTP 5xx handler in app.ts. The full error is always logged.
 */

import type { Logger } from '@cobble/core';
import type { WsServerMessage } from '@cobble/shared';
import type { WebSocket } from '@fastify/websocket';
import { describe, expect, it } from 'vitest';
import { WsConnection } from './connection.js';
import { dispatchMessage, type WsMethods, WsClientError } from './dispatch.js';

/** A socket that records every JSON frame the connection writes (fakes-over-mocks:
 *  the socket is the third-party `@fastify/websocket` type we don't own). */
function fakeSocket(sent: WsServerMessage[]): WebSocket {
  return {
    send: (data: string) => sent.push(JSON.parse(data) as WsServerMessage),
    close: () => {},
  } as unknown as WebSocket;
}

/** A logger that records error calls so a test can assert the full error was logged. */
function recordingLogger(errors: { message: string; meta: unknown }[]): Logger {
  return {
    error: (message: string, meta?: unknown) => errors.push({ message, meta }),
    warn: () => {},
    info: () => {},
  };
}

/** Drive one request through the dispatcher and return the single reply frame. */
async function dispatch(
  methods: WsMethods,
  request: unknown,
  logger: Logger,
): Promise<WsServerMessage> {
  const sent: WsServerMessage[] = [];
  const connection = new WsConnection(fakeSocket(sent), 'user-1', logger, 32);
  await dispatchMessage(methods, connection, JSON.stringify(request), logger);
  const [reply] = sent;
  if (reply === undefined) {
    throw new Error('dispatcher sent no reply');
  }
  expect(sent).toHaveLength(1);
  return reply;
}

describe('ws dispatch error allowlisting', () => {
  it('reports an untagged handler error generically (no leak)', async () => {
    const errors: { message: string; meta: unknown }[] = [];
    const methods: WsMethods = {
      boom: async () => {
        throw new Error('connection terminated: relation "users" does not exist');
      },
    };

    const reply = await dispatch(methods, { id: 'r1', method: 'boom' }, recordingLogger(errors));

    expect(reply).toEqual({ id: 'r1', error: { message: 'internal error' } });
    // The real error is still logged for debugging.
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe('ws method failed');
  });

  it('passes through the message of a WsClientError', async () => {
    class NotEmbodiedError extends WsClientError {
      readonly code = 'not_embodied';
    }
    const methods: WsMethods = {
      act: async () => {
        throw new NotEmbodiedError('this connection does not embody a companion');
      },
    };

    const reply = await dispatch(methods, { id: 'r2', method: 'act' }, recordingLogger([]));

    expect(reply).toEqual({
      id: 'r2',
      error: {
        message: 'this connection does not embody a companion',
        code: 'not_embodied',
      },
    });
  });

  it('reports a DB-driver error generically even though it carries a string code', async () => {
    // A node-postgres DatabaseError is an Error with `.code` set to the SQLSTATE
    // (here 22P02, "invalid text representation" — what a malformed uuid throws).
    // The old "has a string code" heuristic leaked its message verbatim; the
    // WsClientError gate must report it generically.
    const errors: { message: string; meta: unknown }[] = [];
    const methods: WsMethods = {
      reject: async () => {
        const dbError = Object.assign(
          new Error('invalid input syntax for type uuid: "not-a-uuid"'),
          { code: '22P02' },
        );
        throw dbError;
      },
    };

    const reply = await dispatch(methods, { id: 'r3', method: 'reject' }, recordingLogger(errors));

    expect(reply).toEqual({ id: 'r3', error: { message: 'internal error' } });
    // The real error — SQLSTATE and all — is still logged for debugging.
    expect(errors).toHaveLength(1);
  });
});
