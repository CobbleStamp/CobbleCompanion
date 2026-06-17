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
}

/** A WS method: returns the result value (sent back correlated by request id), or
 *  throws — a thrown Error's message becomes the client-safe error reply. */
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
      },
      parsed.params,
    );
    connection.result(parsed.id, result ?? null);
  } catch (error) {
    logger.error('ws method failed', {
      operation: 'ws.dispatch',
      method: parsed.method,
      userId: connection.userId,
      error,
    });
    // Allowlist client-facing messages: a `code`-carrying error is a tagged,
    // intentionally client-safe failure (e.g. NotEmbodiedError) — pass its message
    // through. An untagged error from the DB driver / gateway / harness could leak
    // internal detail, so report it generically (mirrors the HTTP 5xx handler in
    // app.ts). The full error is logged above regardless.
    const code =
      typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : undefined;
    const message = code !== undefined && error instanceof Error ? error.message : 'internal error';
    connection.fail(parsed.id, message, code);
  }
}
