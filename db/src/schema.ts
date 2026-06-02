import type { MessageRole } from '@cobble/shared';
import { bigserial, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Phase 0 data model (implementation.md §1). Multi-tenant: every row is reachable
 * only through its owning user/companion (architecture.md invariant #5). Later
 * phases add semantic/episodic/procedural tables via new migrations.
 *
 * Auth is handled by Google Sign-In; users are JIT-provisioned by the email
 * claim on a verified Google ID token, so there is no local credential/token table.
 */

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: text('email').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** The companion "home" — the canonical identity a surface loads from (invariant #4). */
export const companions = pgTable(
  'companions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    form: text('form').notNull(),
    temperament: text('temperament').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('companions_owner_idx').on(table.ownerId)],
);

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companionId: uuid('companion_id')
      .notNull()
      .references(() => companions.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('conversations_companion_idx').on(table.companionId)],
);

/** Transcript — the episodic-memory substrate (implementation.md §1). */
export const messages = pgTable(
  'messages',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    // Monotonic per-row ordinal — the authoritative chronological order, since
    // many turns can share a created_at timestamp at sub-millisecond resolution.
    seq: bigserial('seq', { mode: 'number' }).notNull(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: text('role').$type<MessageRole>().notNull(),
    content: text('content').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('messages_conversation_idx').on(table.conversationId, table.seq)],
);

export const schema = {
  users,
  companions,
  conversations,
  messages,
};
