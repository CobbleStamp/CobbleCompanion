import type { Logger } from '@cobble/core';
import type { ChatStreamEvent } from '@cobble/shared';
import type { FastifyReply } from 'fastify';

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
  reply.hijack();
  // Carry over headers Fastify plugins already computed (e.g. CORS)…
  for (const [key, value] of Object.entries(reply.getHeaders())) {
    if (value !== undefined) {
      reply.raw.setHeader(key, value);
    }
  }
  // …then set the streaming headers.
  reply.raw.setHeader('content-type', 'text/event-stream');
  reply.raw.setHeader('cache-control', 'no-cache');
  reply.raw.setHeader('connection', 'keep-alive');
  reply.raw.writeHead(200);
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
