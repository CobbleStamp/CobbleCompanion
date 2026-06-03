import type { ChatStreamEvent } from '@cobble/shared';
import type { FastifyReply } from 'fastify';

/**
 * Stream chat events to the client as Server-Sent Events (architecture.md §4.6).
 * We hijack the reply and write to the raw socket, carrying over any headers
 * already computed by Fastify plugins (e.g. CORS) so credentialed cross-origin
 * streaming works.
 */
export async function streamSse(
  reply: FastifyReply,
  events: AsyncIterable<ChatStreamEvent>,
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
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  } finally {
    reply.raw.end();
  }
}
