import type { CompanionStreamEvent } from '@cobble/shared';

/**
 * A sink for companion events (`architecture.md` §6). Each publish point — the
 * publish-on-append MemoryStore decorator ({@link PublishingMemoryStore}) for a
 * persisted row, the reaction methods for `reaction_added`/`reaction_removed`
 * (companion-reactions.md §8) — emits here. In production the sink is the durable
 * append-log ({@link DurableCompanionEventBus}), which each node's WS embodiment
 * connection reads by cursor to deliver cross-node (deliver-scalability.md §6 D4).
 *
 * Durability lives in `companion_events` + the `messages`/`message_reactions`
 * tables; a surface that was disconnected recovers from the transcript snapshot on
 * (re)connect, so there is no replay buffer (`architecture.md` §9).
 */
export interface CompanionEventBus {
  /**
   * Record a companion event. Best-effort and synchronous: it never throws to the
   * caller (a sink hiccup must not break the persistence path that called it).
   */
  publish(companionId: string, event: CompanionStreamEvent): void;
}
