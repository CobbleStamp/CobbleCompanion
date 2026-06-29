/**
 * The Postgres-dialect SQL fragments shared by every hybrid (vector + full-text)
 * memory search — semantic sections, episodes, and user-model beliefs all rank
 * the same two ways. Centralised here so the pgvector cosine operator, the
 * `::vector` cast, and the text-search configuration are defined once: a dialect
 * or index change (e.g. switching the FTS language, or the distance operator) is
 * a single edit instead of a hunt across every `*-store.ts`.
 */

import { type AnyColumn, type SQL, sql } from 'drizzle-orm';

/**
 * The Postgres text-search configuration for every FTS arm. Injected as a raw
 * SQL literal (not a bind parameter) so `plainto_tsquery('english', $1)` keeps
 * its regconfig-typed first argument — it is a compile-time constant, never user
 * input, so there is no injection surface.
 */
const TEXT_SEARCH_CONFIG = sql.raw("'english'");

/**
 * Cosine-distance fragment for the vector arm: `<column> <=> <query>::vector`.
 * Smaller = nearer. Use in `orderBy` (and, with {@link withinDistance}, as a
 * relevance floor). The embedding is serialised to the pgvector text form.
 */
export function cosineDistance(column: AnyColumn, embedding: readonly number[]): SQL {
  return sql`${column} <=> ${JSON.stringify([...embedding])}::vector`;
}

/** WHERE predicate: a cosine distance is within (≤) the relevance floor. */
export function withinDistance(distance: SQL, maxDistance: number): SQL {
  return sql`${distance} <= ${maxDistance}`;
}

/** WHERE predicate for the lexical arm: the FTS column matches the query. */
export function ftsMatches(column: AnyColumn, queryText: string): SQL {
  return sql`${column} @@ plainto_tsquery(${TEXT_SEARCH_CONFIG}, ${queryText})`;
}

/** `orderBy` fragment for the lexical arm: FTS rank, highest first. */
export function ftsRankDesc(column: AnyColumn, queryText: string): SQL {
  return sql`ts_rank(${column}, plainto_tsquery(${TEXT_SEARCH_CONFIG}, ${queryText})) DESC`;
}
