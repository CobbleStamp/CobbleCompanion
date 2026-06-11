/**
 * Reaction store (companion-reactions.md §8) — CRUD for `message_reactions`, the
 * mutable emoji annotations that live OUTSIDE the append-only transcript. Both
 * directions share this store: a `user` reaction is an addressed reward signal
 * (its `reward`/`rewardNote` filled later by the inline value-created read, §4,
 * §7); a `companion` reaction is a planned expressive act (no reward). Writes are
 * companion-scoped — the route checks ownership, and every query is also keyed by
 * `companionId` as defence in depth.
 */

import { messageReactions, type Database } from '@cobble/db';
import type { Reactor } from '@cobble/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';

/** A persisted reaction row. `reward`/`rewardNote` are null until (and unless) the
 *  inline read resolves — and always null for a companion reaction. */
export interface ReactionRecord {
  readonly id: string;
  readonly messageId: string;
  readonly companionId: string;
  readonly reactor: Reactor;
  readonly emoji: string;
  readonly reward: number | null;
  readonly rewardNote: string | null;
  readonly createdAt: Date;
}

export interface ReactionStore {
  /**
   * Add a reaction. Idempotent on `(messageId, reactor, emoji)`: a re-tap returns
   * the existing row rather than creating a duplicate. Returns the row either way.
   */
  add(
    companionId: string,
    messageId: string,
    reactor: Reactor,
    emoji: string,
  ): Promise<ReactionRecord>;
  /** Remove a reaction. Returns `true` iff a row was actually deleted (so an
   *  un-react of something already gone is a harmless `false`, not an error). */
  remove(companionId: string, messageId: string, reactor: Reactor, emoji: string): Promise<boolean>;
  /**
   * Fill in the inline read's `reward` + `note` on a USER reaction (§4). Reward is
   * only ever recorded for user reactions, so the reactor is fixed here. A no-op if
   * the reaction was meanwhile removed.
   */
  setReward(
    companionId: string,
    messageId: string,
    emoji: string,
    reward: number,
    note: string,
  ): Promise<void>;
  /** All reactions on the given messages (render hydration for the transcript
   *  snapshot), oldest-first. Empty input → empty result, no query. */
  listForMessages(
    companionId: string,
    messageIds: readonly string[],
  ): Promise<readonly ReactionRecord[]>;
}

type ReactionRow = typeof messageReactions.$inferSelect;

function toRecord(row: ReactionRow): ReactionRecord {
  return {
    id: row.id,
    messageId: row.messageId,
    companionId: row.companionId,
    reactor: row.reactor,
    emoji: row.emoji,
    reward: row.reward,
    rewardNote: row.rewardNote,
    createdAt: row.createdAt,
  };
}

export class DrizzleReactionStore implements ReactionStore {
  constructor(private readonly db: Database) {}

  async add(
    companionId: string,
    messageId: string,
    reactor: Reactor,
    emoji: string,
  ): Promise<ReactionRecord> {
    // `onConflictDoNothing` makes a re-tap idempotent: the unique index on
    // (message, reactor, emoji) catches the duplicate and `returning` comes back
    // empty, so we read the pre-existing row instead of erroring.
    const [inserted] = await this.db
      .insert(messageReactions)
      .values({ companionId, messageId, reactor, emoji })
      .onConflictDoNothing({
        target: [messageReactions.messageId, messageReactions.reactor, messageReactions.emoji],
      })
      .returning();
    if (inserted) {
      return toRecord(inserted);
    }
    const [existing] = await this.db
      .select()
      .from(messageReactions)
      .where(
        and(
          eq(messageReactions.companionId, companionId),
          eq(messageReactions.messageId, messageId),
          eq(messageReactions.reactor, reactor),
          eq(messageReactions.emoji, emoji),
        ),
      )
      .limit(1);
    if (!existing) {
      throw new Error('failed to add reaction');
    }
    return toRecord(existing);
  }

  async remove(
    companionId: string,
    messageId: string,
    reactor: Reactor,
    emoji: string,
  ): Promise<boolean> {
    const deleted = await this.db
      .delete(messageReactions)
      .where(
        and(
          eq(messageReactions.companionId, companionId),
          eq(messageReactions.messageId, messageId),
          eq(messageReactions.reactor, reactor),
          eq(messageReactions.emoji, emoji),
        ),
      )
      .returning({ id: messageReactions.id });
    return deleted.length > 0;
  }

  async setReward(
    companionId: string,
    messageId: string,
    emoji: string,
    reward: number,
    note: string,
  ): Promise<void> {
    await this.db
      .update(messageReactions)
      .set({ reward, rewardNote: note })
      .where(
        and(
          eq(messageReactions.companionId, companionId),
          eq(messageReactions.messageId, messageId),
          eq(messageReactions.reactor, 'user'),
          eq(messageReactions.emoji, emoji),
        ),
      );
  }

  async listForMessages(
    companionId: string,
    messageIds: readonly string[],
  ): Promise<readonly ReactionRecord[]> {
    if (messageIds.length === 0) {
      return [];
    }
    const rows = await this.db
      .select()
      .from(messageReactions)
      .where(
        and(
          eq(messageReactions.companionId, companionId),
          inArray(messageReactions.messageId, [...messageIds]),
        ),
      )
      .orderBy(asc(messageReactions.createdAt));
    return rows.map(toRecord);
  }
}
