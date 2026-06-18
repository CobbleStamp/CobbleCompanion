import { asReactableMessage } from '@cobble/core';
import { addReactionSchema } from '@cobble/shared';
import { z } from 'zod';
import type { AppDeps } from '../../app.js';
import type { WsMethods } from '../dispatch.js';
import { BadParamsError, companionOf, NotFoundError, parseParams } from './helpers.js';

const addParams = addReactionSchema.extend({ messageId: z.string().uuid() });
const removeParams = z.object({ messageId: z.string().uuid(), emoji: z.string().min(1) });

/** User emoji reactions (mirrors reaction.routes). Persist + publish the live event;
 *  an added reaction enqueues the reaction_learn job (D-A.1). */
export function reactionMethods(deps: AppDeps): WsMethods {
  const { memory, reactions, reactionLearn, eventBus, embodiment } = deps;
  return {
    'reactions.add': async (ctx, params) => {
      const { messageId, emoji } = parseParams(addParams, params, 'a single emoji is required');
      const companionId = await companionOf(embodiment, ctx);
      const message = await memory.getMessageById(companionId, messageId);
      if (!message) {
        throw new NotFoundError('message not found');
      }
      // Only the companion's own message-kind turns are reactable.
      if (!asReactableMessage(message)) {
        throw new BadParamsError('message is not reactable');
      }
      const { inserted } = await reactions.add(companionId, messageId, 'user', emoji);
      if (inserted) {
        eventBus.publish(companionId, {
          type: 'reaction_added',
          messageId,
          reactor: 'user',
          emoji,
        });
        reactionLearn.request(companionId, messageId, emoji);
      }
      return { ok: true };
    },

    'reactions.remove': async (ctx, params) => {
      const { messageId, emoji } = parseParams(
        removeParams,
        params,
        'a message id and emoji are required',
      );
      const companionId = await companionOf(embodiment, ctx);
      const removed = await reactions.remove(companionId, messageId, 'user', emoji);
      if (removed) {
        eventBus.publish(companionId, {
          type: 'reaction_removed',
          messageId,
          reactor: 'user',
          emoji,
        });
      }
      return { ok: true };
    },
  };
}
