import type { ReactionStore } from '@cobble/core';
import type { MessageDto, ReactionDto } from '@cobble/shared';
import type { AppDeps } from '../../app.js';
import type { WsMethods } from '../dispatch.js';
import { companionOf } from './helpers.js';

/** Attach each message's emoji reactions (joined) to its DTO — the snapshot hydrate
 *  (companion-reactions.md §8); one batched query for the whole page. */
async function hydrateReactions(
  reactions: ReactionStore,
  companionId: string,
  messages: readonly MessageDto[],
): Promise<readonly MessageDto[]> {
  if (messages.length === 0) {
    return messages;
  }
  const rows = await reactions.listForMessages(
    companionId,
    messages.map((message) => message.id),
  );
  if (rows.length === 0) {
    return messages;
  }
  const byMessage = new Map<string, ReactionDto[]>();
  for (const row of rows) {
    const list = byMessage.get(row.messageId) ?? [];
    list.push({ messageId: row.messageId, reactor: row.reactor, emoji: row.emoji });
    byMessage.set(row.messageId, list);
  }
  return messages.map((message) => {
    const messageReactions = byMessage.get(message.id);
    return messageReactions ? { ...message, reactions: messageReactions } : message;
  });
}

/** Transcript read (mirrors GET messages). The streaming `messages.send` lives in
 *  streaming.ts. Opening the transcript is a "return" — nudge motivation (P4). */
export function messageMethods(deps: AppDeps): WsMethods {
  const { memory, reactions, embodiment, motivation } = deps;
  return {
    'messages.list': async (ctx) => {
      const companionId = await companionOf(embodiment, ctx);
      const messages = await memory.getRecentMessages(companionId, 200);
      const withReactions = await hydrateReactions(reactions, companionId, messages);
      motivation.request(companionId);
      return { messages: withReactions };
    },
  };
}
