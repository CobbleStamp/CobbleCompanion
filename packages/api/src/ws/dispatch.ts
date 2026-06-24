import type { Logger } from '@cobble/core';
import type { WsRequestMessage } from '@cobble/shared';
import type { EmbodimentBinding, WsConnection } from './connection.js';

/** What a method handler sees: the connection's identity, the companion it embodies
 *  (if any), the live connection, and `emit` for streaming chunks correlated to
 *  this request's id (the terminal result/error ends the stream). */
export interface WsCallContext {
  readonly userId: string;
  readonly embodiment: EmbodimentBinding | undefined;
  readonly connection: WsConnection;
  readonly emit: (chunk: unknown) => void;
  /** This connection's `connectionId`/`userId`-bound logger. Method handlers must use
   *  it (not the process-wide `deps.logger`) for any log so the line is attributable to
   *  one connection — e.g. telling a superseded connection apart from its successor. */
  readonly logger: Logger;
}

/**
 * Base class for intentionally client-safe failures. The dispatcher forwards a
 * thrown error's `message` (and `code`) to the client only when it is a
 * `WsClientError` — anything else (a `pg` `DatabaseError` carrying a SQLSTATE
 * `code`, a Node system error carrying `ECONNREFUSED`/host:port, a harness/gateway
 * fault) is reported generically so it can't leak internal detail. Subclasses set a
 * stable, client-facing `code`.
 */
export abstract class WsClientError extends Error {
  abstract readonly code: string;
}

/** A WS method: returns the result value (sent back correlated by request id), or
 *  throws — a thrown {@link WsClientError}'s message becomes the client-safe error
 *  reply; any other error is reported generically. */
export type WsMethodHandler = (ctx: WsCallContext, params: unknown) => Promise<unknown>;

/** The method table the dispatcher routes by `method` name. */
export type WsMethods = Readonly<Record<string, WsMethodHandler>>;

function isRequest(value: unknown): value is WsRequestMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string' &&
    typeof (value as { method?: unknown }).method === 'string'
  );
}

/**
 * Handle one inbound frame: parse the request envelope, route to its method, and
 * reply with a result or a client-safe error correlated by `id`. Never throws —
 * callers fire this without awaiting, so many requests multiplex over the one
 * socket concurrently (each replies when its own handler settles).
 */
export async function dispatchMessage(
  methods: WsMethods,
  connection: WsConnection,
  raw: string,
  logger: Logger,
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // No id to correlate a malformed frame to; report against the empty id.
    connection.fail('', 'malformed message: expected a JSON request envelope', 'bad_request');
    return;
  }
  if (!isRequest(parsed)) {
    const id =
      typeof (parsed as { id?: unknown })?.id === 'string' ? (parsed as WsRequestMessage).id : '';
    connection.fail(id, 'invalid request envelope: { id, method } required', 'bad_request');
    return;
  }
  const handler = methods[parsed.method];
  if (!handler) {
    connection.fail(parsed.id, `unknown method: ${parsed.method}`, 'unknown_method');
    return;
  }
  try {
    const requestId = parsed.id;
    const result = await handler(
      {
        userId: connection.userId,
        embodiment: connection.embodiment,
        connection,
        emit: (chunk: unknown) => connection.stream(requestId, chunk),
        logger,
      },
      parsed.params,
    );
    connection.result(parsed.id, result ?? null);
  } catch (error) {
    // Allowlist client-facing messages by type, not by a "has a string `code`"
    // heuristic: a `WsClientError` is a tagged, intentionally client-safe failure
    // (e.g. NotEmbodiedError) — pass its message and code through. Anything else
    // (a `pg` DatabaseError whose `code` is a SQLSTATE, a Node system error, a
    // gateway/harness fault) could leak internal detail, so report it generically
    // (mirrors the HTTP 5xx handler in app.ts).
    const clientError = error instanceof WsClientError ? error : undefined;
    if (clientError) {
      // An expected, client-handled rejection — e.g. a `not_embodied` reply to an
      // in-flight request on a connection a room handoff just superseded. This is
      // normal, so log it at info WITHOUT a stack (an `error`-level stack here reads
      // as a fault and floods the logs during a routine "moved to another room").
      logger.info('ws method rejected', {
        operation: 'ws.dispatch',
        method: parsed.method,
        requestId: parsed.id,
        code: clientError.code,
        reason: clientError.message,
      });
    } else {
      logger.error('ws method failed', {
        operation: 'ws.dispatch',
        method: parsed.method,
        requestId: parsed.id,
        error,
      });
    }
    const message = clientError?.message ?? 'internal error';
    connection.fail(parsed.id, message, clientError?.code);
  }
}
