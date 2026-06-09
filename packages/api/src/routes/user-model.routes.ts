/**
 * User-Model routes (Phase 11, companion-memory.md §4) — the legible, correctable
 * view of what the companion knows about its USER. Per-user (scoped by
 * `request.userId`, not a companion): the facts are the user's, shared across their
 * companions. This is the one place the otherwise read-only memory browser becomes
 * writable — read the profile, edit a fact, or forget it.
 */

import { isTier2Predicate, type UserFactsDto, userFactEditSchema } from '@cobble/shared';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import type { RequireAuth } from '../auth-guard.js';

interface FactParams {
  readonly factId: string;
}

/** A Tier-2 belief (vs a Tier-1 identity attribute); null predicate is never a belief. */
function isBelief(predicate: string | null): boolean {
  return predicate !== null && isTier2Predicate(predicate);
}

export function registerUserModelRoutes(
  app: FastifyInstance,
  deps: AppDeps,
  requireAuth: RequireAuth,
): void {
  const { userModel } = deps;

  // The current user-model: Tier-1 core profile (editable) + Tier-2 learned beliefs
  // (read-only until Phase 13). One scan, partitioned by tier.
  app.get('/user/facts', { preHandler: requireAuth }, async (request, reply) => {
    const current = await userModel.listCurrent(request.userId!);
    const facts = current.filter((fact) => !isBelief(fact.predicate));
    const beliefs = current.filter((fact) => isBelief(fact.predicate));
    const body: UserFactsDto = { facts, beliefs };
    return reply.send(body);
  });

  // Correct a fact — supersedes it with an authoritative `user_edit` value.
  app.patch('/user/facts/:factId', { preHandler: requireAuth }, async (request, reply) => {
    const { factId } = request.params as FactParams;
    const parsed = userFactEditSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid request body' });
    }
    const updated = await userModel.editFact(request.userId!, factId, parsed.data.object);
    if (!updated) {
      return reply.code(404).send({ error: 'fact not found' });
    }
    return reply.send(updated);
  });

  // Forget a fact — it leaves the current set and never resurfaces.
  app.delete('/user/facts/:factId', { preHandler: requireAuth }, async (request, reply) => {
    const { factId } = request.params as FactParams;
    const forgotten = await userModel.forgetFact(request.userId!, factId);
    if (!forgotten) {
      return reply.code(404).send({ error: 'fact not found' });
    }
    return reply.code(204).send();
  });
}
