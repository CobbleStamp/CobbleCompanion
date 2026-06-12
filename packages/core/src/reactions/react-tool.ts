/**
 * The companion's expressive `react` action (companion-reactions.md §5) — a
 * first-class emoji reaction the model emits MID-TURN, the way it would choose its
 * wording. Plumbed as a tool so it composes with the agent loop, but it is special:
 *
 * - **Free & ungated** (`effectful: false`) — it's expression, not an outward
 *   action, so it never goes through the propose→approve gate.
 * - **Silent** (`silent: true`) — it records no `tool_step` chrome row; the emoji
 *   itself, attached to the user's message, IS the artifact.
 * - **Creates no outcome** — expression awaits no reward (otherwise the companion
 *   could react to *bait* a reaction). It just persists a `reactor='companion'`
 *   reaction row and pushes the live event.
 *
 * It binds to the message that triggered this turn (`ctx.currentUserMessageId`) —
 * the "👀 on it" / "🎉 good news" case. Addressing an *older* message via a
 * request-scoped `ref` handle is a documented fast-follow; reacting on a proactive
 * turn (no triggering message) is a no-op. Not whitelisted: the model may pick any
 * emoji, guided by taste/legibility (§7).
 */

import { isSingleEmoji } from '@cobble/shared';
import type { CompanionEventBus } from '../events/bus.js';
import type { ToolResult } from '../harness/hooks.js';
import { consoleLogger, type Logger } from '../logging.js';
import { readStringArg, type Tool } from '../tools/tool.js';
import type { ReactionStore } from './store.js';

export interface ReactToolOptions {
  readonly reactions: ReactionStore;
  readonly eventBus: CompanionEventBus;
  readonly logger?: Logger;
}

export function createReactTool(options: ReactToolOptions): Tool {
  const logger = options.logger ?? consoleLogger;
  return {
    name: 'react',
    description:
      'React to the message the user just sent with a single emoji — a quick, wordless ' +
      'acknowledgement (e.g. 👀 when you are about to look into something, 🎉 for good news, ' +
      '🙏 for thanks). Use it when an emoji adds something a sentence would not; you can react ' +
      'AND still reply. Prefer common, legible emoji. Do not react on every turn.',
    parameters: {
      type: 'object',
      properties: {
        emoji: { type: 'string', description: 'A single emoji to react with.' },
      },
      required: ['emoji'],
      additionalProperties: false,
    },
    effectful: false,
    silent: true,
    async run(args, ctx): Promise<ToolResult> {
      // Trim so a model that pads the arg (" 👀 ") stores and matches the same glyph
      // the user route does (its schema trims) — keeps idempotency consistent. Same
      // single-well-formed-emoji check as the user route (well-formedness, not a
      // whitelist), so a free-text arg never lands in `message_reactions`.
      const emoji = readStringArg(args, 'emoji')?.trim();
      if (!emoji || !isSingleEmoji(emoji)) {
        return { name: 'react', content: 'a single emoji is required', isError: true };
      }
      if (!ctx.currentUserMessageId) {
        // A proactive turn has no triggering user message to react to.
        return { name: 'react', content: 'no message to react to right now', isError: true };
      }
      try {
        const { inserted } = await options.reactions.add(
          ctx.companionId,
          ctx.currentUserMessageId,
          'companion',
          emoji,
        );
        // Push the live event only on a real insert, so a repeated react is a no-op
        // rather than a duplicate broadcast (mirrors the user route).
        if (inserted) {
          options.eventBus.publish(ctx.companionId, {
            type: 'reaction_added',
            messageId: ctx.currentUserMessageId,
            reactor: 'companion',
            emoji,
          });
        }
        return { name: 'react', content: `Reacted ${emoji}` };
      } catch (error) {
        logger.error('failed to emit companion reaction', {
          operation: 'reactions.react',
          companionId: ctx.companionId,
          messageId: ctx.currentUserMessageId,
          error,
        });
        return { name: 'react', content: 'could not react right now', isError: true };
      }
    },
  };
}
