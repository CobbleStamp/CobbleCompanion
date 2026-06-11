/**
 * UUID path-param validation at the HTTP boundary. Every dynamic segment in this
 * API's routes is a resource UUID (companionId, proposalId, sourceId). A
 * syntactically invalid id can never name a real row, and feeding it to a
 * parameterized Postgres query throws `22P02 invalid input syntax for uuid`,
 * which surfaces as a 500. Rejecting malformed ids up front keeps that a clean
 * 404 — fail fast at the boundary (common/coding-style.md). Queries stay
 * parameterized either way; this is about the right status code, not injection.
 */

import type { FastifyInstance } from 'fastify';

/** Canonical 8-4-4-4-12 hex UUID (any version), case-insensitive. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/**
 * Route param names that carry a resource UUID. The guard validates ONLY these,
 * so a future non-UUID path param (e.g. a slug) needs no change here and is
 * never wrongly rejected.
 */
const UUID_PARAM_NAMES = ['companionId', 'messageId', 'proposalId', 'sourceId', 'factId'] as const;

/**
 * Register a global preHandler that 404s any request whose resource-id path
 * param isn't a well-formed UUID, before it can reach a DB query. Uniform across
 * every route (current and future) without per-handler boilerplate. Returns 404
 * (not 400): a malformed id is indistinguishable from a nonexistent one for a
 * lookup, and 404 matches the not-found response these handlers already emit for
 * an unknown id.
 */
export function registerUuidParamGuard(app: FastifyInstance): void {
  app.addHook('preHandler', async (request, reply) => {
    const params = request.params as Record<string, unknown> | undefined;
    if (!params) return;
    for (const name of UUID_PARAM_NAMES) {
      const value = params[name];
      if (value === undefined) continue;
      if (typeof value !== 'string' || !isUuid(value)) {
        const resource = name.replace(/Id$/, '');
        return reply.code(404).send({ error: `${resource} not found` });
      }
    }
  });
}
