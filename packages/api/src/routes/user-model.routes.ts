/**
 * User-Model routes (Phase 11, companion-memory.md §4) — the legible, correctable
 * view of what the companion knows about its USER. Per-user (scoped by
 * `request.userId`, not a companion): the facts are the user's, shared across their
 * companions. This is the one place the otherwise read-only memory browser becomes
 * writable — read the profile, edit a fact, or forget it.
 */

import { isTier2Predicate, type UserFactsDto, userFactEditSchema } from '@cobble/shared';
import { beliefPhrase } from '@cobble/core';
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

  // The current user-model: Tier-1 core profile + Tier-2 learned beliefs, both
  // editable/forgettable (Phase 13). One scan, partitioned by tier for the UI.
  app.get('/user/facts', { preHandler: requireAuth }, async (request, reply) => {
    const current = await userModel.listCurrent(request.userId!);
    const facts = current.filter((fact) => !isBelief(fact.predicate));
    const beliefs = current.filter((fact) => isBelief(fact.predicate));
    const body: UserFactsDto = { facts, beliefs };
    return reply.send(body);
  });

  // Correct a fact/belief — replaces it in place with an authoritative `user_edit` value.
  // For a Tier-2 belief the new value is re-embedded (best-effort) so it stays
  // vector-recallable; a failed embed leaves the old vector (FTS still answers).
  app.patch('/user/facts/:factId', { preHandler: requireAuth }, async (request, reply) => {
    const { factId } = request.params as FactParams;
    const parsed = userFactEditSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid request body' });
    }
    const current = await userModel.listCurrent(request.userId!);
    const target = current.find((fact) => fact.id === factId);
    if (!target) {
      return reply.code(404).send({ error: 'fact not found' });
    }
    const embedding = isBelief(target.predicate)
      ? await embedBelief(deps, target.predicate, parsed.data.object)
      : undefined;
    const updated = await userModel.editFact(
      request.userId!,
      factId,
      parsed.data.object,
      embedding,
    );
    if (!updated) {
      return reply.code(404).send({ error: 'fact not found' });
    }
    return reply.send(updated);
  });

  // Forget a fact/belief — a true delete of the row (the sensitive purge uses the same path).
  app.delete('/user/facts/:factId', { preHandler: requireAuth }, async (request, reply) => {
    const { factId } = request.params as FactParams;
    const deleted = await userModel.deleteFact(request.userId!, factId);
    if (!deleted) {
      return reply.code(404).send({ error: 'fact not found' });
    }
    return reply.code(204).send();
  });
}

/**
 * Re-embed an edited belief under the SAME natural-language rendering the retrieve arm
 * recalls against (`beliefPhrase`), so the corrected value stays vector-recallable.
 * Best-effort: an embed failure returns undefined and the belief keeps its prior vector.
 */
async function embedBelief(
  deps: AppDeps,
  predicate: string | null,
  object: string,
): Promise<readonly number[] | undefined> {
  try {
    const { vectors } = await deps.embeddings.embed({
      input: [beliefPhrase(predicate, object)],
      model: deps.config.embeddingModel,
      dimensions: deps.config.embeddingDimensions,
    });
    return vectors[0];
  } catch (error) {
    deps.logger.error('failed to re-embed an edited belief; keeping the prior vector', {
      operation: 'userModel.routes.editBelief.embed',
      error,
    });
    return undefined;
  }
}
