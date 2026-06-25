import { beliefPhrase, type Logger } from '@cobble/core';
import { isTier2Predicate, userFactEditSchema, type UserFactsDto } from '@cobble/shared';
import { z } from 'zod';
import type { AppDeps } from '../../app.js';
import type { WsMethods } from '../dispatch.js';
import { NotFoundError, parseParams } from './helpers.js';

const editParams = userFactEditSchema.extend({ factId: z.string().uuid() });
const deleteParams = z.object({ factId: z.string().uuid() });

/** A Tier-2 belief (vs a Tier-1 attribute); a null predicate is never a belief. */
function isBelief(predicate: string | null): boolean {
  return predicate !== null && isTier2Predicate(predicate);
}

/**
 * User-Model methods (mirrors user-model.routes) — per-user (the facts are the
 * user's, shared across their companions). The one writable corner of the memory
 * browser: read / correct / forget.
 */
export function userModelMethods(deps: AppDeps): WsMethods {
  const { userModel } = deps;
  return {
    'userFacts.list': async (ctx) => {
      const current = await userModel.listCurrent(ctx.userId);
      const body: UserFactsDto = {
        facts: current.filter((fact) => !isBelief(fact.predicate)),
        beliefs: current.filter((fact) => isBelief(fact.predicate)),
      };
      return body;
    },
    'userFacts.update': async (ctx, params) => {
      const { factId, object } = parseParams(editParams, params, 'invalid request body');
      const current = await userModel.listCurrent(ctx.userId);
      const target = current.find((fact) => fact.id === factId);
      if (!target) {
        throw new NotFoundError('fact not found');
      }
      const embedding = isBelief(target.predicate)
        ? await embedBelief(deps, target.predicate, object, ctx.logger)
        : undefined;
      const updated = await userModel.editFact(ctx.userId, factId, object, embedding);
      if (!updated) {
        throw new NotFoundError('fact not found');
      }
      return updated;
    },
    'userFacts.delete': async (ctx, params) => {
      const { factId } = parseParams(deleteParams, params, 'a fact id is required');
      const deleted = await userModel.deleteFact(ctx.userId, factId);
      if (!deleted) {
        throw new NotFoundError('fact not found');
      }
      return { ok: true };
    },
  };
}

/** Re-embed an edited belief under the same phrase the retrieve arm recalls against;
 *  best-effort (an embed failure keeps the prior vector). */
async function embedBelief(
  deps: AppDeps,
  predicate: string | null,
  object: string,
  logger: Logger,
): Promise<readonly number[] | undefined> {
  try {
    const { vectors } = await deps.embeddings.embed({
      input: [beliefPhrase(predicate, object)],
      model: deps.config.embeddingModel,
      dimensions: deps.config.embeddingDimensions,
    });
    return vectors[0];
  } catch (error) {
    logger.error('failed to re-embed an edited belief; keeping the prior vector', {
      operation: 'userFacts.update.embed',
      error,
    });
    return undefined;
  }
}
