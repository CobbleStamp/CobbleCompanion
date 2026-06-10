import type { CompanionSubscription, Logger } from '@cobble/core';
import type { ChatStreamEvent, CompanionStreamEvent } from '@cobble/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Heartbeat cadence for the standing event channel: a `: ping` comment keeps
 * intermediaries (proxies, load balancers) from reaping an idle connection and
 * lets a dead socket surface as a write failure. Comments (lines starting `:`)
 * are ignored by the EventSource/SSE parser, so they never reach the client as
 * data. In-code (not env) — see `implementation.md` §3.
 */
const SSE_HEARTBEAT_INTERVAL_MS = 25_000;

/**
 * Hijack the reply and open a raw SSE stream: carry over headers Fastify plugins
 * already computed (e.g. CORS, so credentialed cross-origin streaming works),
 * then set the streaming headers and flush them. Shared by the finite per-turn
 * stream ({@link streamSse}) and the standing channel ({@link streamChannel}).
 */
function openSseStream(reply: FastifyReply): void {
  reply.hijack();
  for (const [key, value] of Object.entries(reply.getHeaders())) {
    if (value !== undefined) {
      reply.raw.setHeader(key, value);
    }
  }
  reply.raw.setHeader('content-type', 'text/event-stream');
  reply.raw.setHeader('cache-control', 'no-cache');
  reply.raw.setHeader('connection', 'keep-alive');
  reply.raw.writeHead(200);
}

/**
 * Stream chat events to the client as Server-Sent Events (architecture.md §4.6).
 * We hijack the reply and write to the raw socket, carrying over any headers
 * already computed by Fastify plugins (e.g. CORS) so credentialed cross-origin
 * streaming works.
 *
 * A client may abort mid-stream (navigate away, close the tab). Writing to the
 * closed socket then throws; that's an expected disconnect, not an error — we
 * log it at info level and stop the loop cleanly. The final `end()` is likewise
 * guarded so a teardown on an already-closed socket can't mask the real outcome.
 */
export async function streamSse(
  reply: FastifyReply,
  events: AsyncIterable<ChatStreamEvent>,
  logger?: Logger,
): Promise<void> {
  openSseStream(reply);
  try {
    for await (const event of events) {
      // Bail before writing if the client has already gone away.
      if (reply.raw.writableEnded || reply.raw.destroyed) {
        logger?.info('sse client disconnected; stopping stream', {
          operation: 'sse.stream',
        });
        break;
      }
      try {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch (error) {
        // Write after client abort — expected, not error-severity. Log and stop.
        logger?.info('sse write failed; client likely disconnected', {
          operation: 'sse.stream',
          error,
        });
        break;
      }
    }
  } finally {
    if (!reply.raw.writableEnded) {
      try {
        reply.raw.end();
      } catch (error) {
        logger?.info('sse end failed on closed socket', {
          operation: 'sse.stream',
          error,
        });
      }
    }
  }
}

/**
 * Stream a companion's appended transcript rows over the **standing** event
 * channel (architecture.md §6, `GET /companions/:id/events`). Unlike
 * {@link streamSse} this never ends on its own: it drains an open-ended
 * {@link CompanionSubscription} until the client disconnects.
 *
 * Lifecycle the finite stream doesn't need: a heartbeat keeps the idle
 * connection alive, and a `close` handler on the request **unsubscribes from the
 * bus, clears the heartbeat, and ends the socket** — closing the subscription
 * resolves the parked iterator so the `for await` exits cleanly. `cleanup` is
 * idempotent (the `close` event and the loop's `finally` can both reach it).
 */
export async function streamChannel(
  reply: FastifyReply,
  request: FastifyRequest,
  subscription: CompanionSubscription,
  logger?: Logger,
): Promise<void> {
  openSseStream(reply);

  const heartbeat = setInterval(() => {
    if (reply.raw.writableEnded || reply.raw.destroyed) return;
    try {
      reply.raw.write(': ping\n\n');
    } catch {
      // A failed heartbeat just means the socket is gone; the close handler /
      // next write will tear down. Nothing to log on a keep-alive comment.
    }
  }, SSE_HEARTBEAT_INTERVAL_MS);

  let cleanedUp = false;
  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    clearInterval(heartbeat);
    subscription.close();
    if (!reply.raw.writableEnded) {
      try {
        reply.raw.end();
      } catch (error) {
        logger?.info('event-channel end failed on closed socket', {
          operation: 'sse.channel',
          error,
        });
      }
    }
  };
  // The client going away is what ends a standing stream — release the bus
  // subscription and stop the heartbeat the moment the connection closes.
  request.raw.on('close', cleanup);

  try {
    for await (const message of subscription.events) {
      if (reply.raw.writableEnded || reply.raw.destroyed) break;
      try {
        const event: CompanionStreamEvent = { type: 'message', message };
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch (error) {
        logger?.info('event-channel write failed; client likely disconnected', {
          operation: 'sse.channel',
          error,
        });
        break;
      }
    }
  } finally {
    cleanup();
  }
}
