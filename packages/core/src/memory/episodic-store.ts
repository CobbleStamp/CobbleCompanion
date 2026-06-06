/**
 * Episodic memory store — Phase 2's continuity substrate (architecture.md
 * invariant #2: memory behind an interface). Owns `episodes`: consolidated,
 * time-anchored summaries DERIVED from the transcript by the background
 * reflection pass (see consolidation), with the same hybrid retrieval as the
 * semantic store — vector cosine + lexical FTS fused by reciprocal-rank fusion —
 * so the harness can recall the right past episode by topic ("in Lima you loved
 * that ceviche"). `searchEpisodes` also accepts an optional wall-clock time
 * window, but no caller passes one yet, so production recall is topic-only; RRF
 * likewise ignores `salience` (it ranks by fused vector/FTS rank alone).
 *
 * The transcript stays canonical (invariant #6): episodes are rebuildable from
 * it. `consolidatedThroughSeq` (a column on the companion "home") is the cursor
 * the reflection pass resumes from, advanced atomically with each batch of
 * episodes so consolidation is incremental and restart-safe.
 */

import { companions, episodes, messages, type Database } from '@cobble/db';
import { and, count, desc, eq, gt, sql } from 'drizzle-orm';
import { stripNul } from '../text/sanitize.js';
import { reciprocalRankFusion } from './rrf.js';

/** A consolidated episode to persist. `embedding` is optional — an episode with
 * none is still recalled lexically (FTS over its summary), mirroring how a
 * section degrades when the embedding provider is down. */
export interface NewEpisode {
  readonly summary: string;
  /** The transcript range this episode consolidated (idempotency + incrementality). */
  readonly seqStart: number;
  readonly seqEnd: number;
  /** Wall-clock span the episode covers (date display + the store's unwired time filter). */
  readonly occurredStart: Date;
  readonly occurredEnd: Date;
  /** 0–1 weight: how much this episode matters. Stored/displayed; not used at recall. */
  readonly salience?: number;
  readonly embedding?: readonly number[];
}

export interface EpisodeRecord {
  readonly id: string;
  readonly companionId: string;
  readonly summary: string;
  readonly seqStart: number;
  readonly seqEnd: number;
  readonly occurredStart: string;
  readonly occurredEnd: string;
  readonly salience: number | null;
  readonly createdAt: string;
}

/** A retrieval hit: the episode summary + time anchor + fused score. */
export interface EpisodeSearchHit {
  readonly episodeId: string;
  readonly summary: string;
  readonly seqStart: number;
  readonly seqEnd: number;
  readonly occurredStart: string;
  readonly occurredEnd: string;
  readonly salience: number | null;
  readonly score: number;
}

export interface EpisodeSearchParams {
  readonly queryEmbedding: readonly number[];
  readonly queryText: string;
  readonly topK: number;
  /** Optional wall-clock window: episodes overlapping [after, before). */
  readonly filters?: {
    readonly after?: Date;
    readonly before?: Date;
  };
}

/** Boundary for all Phase 2 episodic memory (episodes + the consolidation cursor). */
export interface EpisodicMemoryStore {
  /**
   * Persist a batch of episodes and advance the consolidation cursor to
   * `throughSeq`, atomically. An empty batch just advances the cursor (a span of
   * pure filler is consolidated to "nothing worth keeping" and never revisited).
   */
  appendEpisodes(
    companionId: string,
    newEpisodes: readonly NewEpisode[],
    throughSeq: number,
  ): Promise<readonly EpisodeRecord[]>;
  /** Hybrid (vector + FTS) recall with an optional time window, fused by RRF. */
  searchEpisodes(
    companionId: string,
    params: EpisodeSearchParams,
  ): Promise<readonly EpisodeSearchHit[]>;
  /** The episode timeline for the memory browser — most recent first. */
  listEpisodes(companionId: string, opts?: { limit?: number }): Promise<readonly EpisodeRecord[]>;
  countEpisodes(companionId: string): Promise<number>;
  /**
   * Average salience across the companion's episodes (0 when it has none) — a
   * cheap measure of shared-history depth for the Phase 5 bond axis.
   */
  averageSalience(companionId: string): Promise<number>;
  /** The highest transcript `seq` already rolled into episodes (the cursor). */
  consolidatedThroughSeq(companionId: string): Promise<number>;
  /**
   * Companion ids whose un-consolidated transcript tail is at least
   * `minPendingTurns` long — i.e. `max(messages.seq) - consolidatedThroughSeq >=
   * minPendingTurns`. The system sweep's worklist (startup catch-up + periodic):
   * unscoped by design, like the deferred-ingestion sweep.
   */
  companionsNeedingConsolidation(minPendingTurns: number): Promise<readonly string[]>;
}

/** Select projection: a hit minus its fused score (occurred_* as Date pre-format). */
const hitColumns = {
  episodeId: episodes.id,
  summary: episodes.summary,
  seqStart: episodes.seqStart,
  seqEnd: episodes.seqEnd,
  occurredStart: episodes.occurredStart,
  occurredEnd: episodes.occurredEnd,
  salience: episodes.salience,
};

type EpisodeHitRow = {
  readonly episodeId: string;
  readonly summary: string;
  readonly seqStart: number;
  readonly seqEnd: number;
  readonly occurredStart: Date;
  readonly occurredEnd: Date;
  readonly salience: number | null;
};

export class DrizzleEpisodicMemoryStore implements EpisodicMemoryStore {
  constructor(private readonly db: Database) {}

  async appendEpisodes(
    companionId: string,
    newEpisodes: readonly NewEpisode[],
    throughSeq: number,
  ): Promise<readonly EpisodeRecord[]> {
    // Insert + cursor advance in one transaction: a crash never leaves episodes
    // written without the cursor moved (which would duplicate them on re-run) or
    // the cursor moved without the episodes (which would lose the span).
    return this.db.transaction(async (tx) => {
      let inserted: readonly EpisodeRecord[] = [];
      if (newEpisodes.length > 0) {
        const rows = await tx
          .insert(episodes)
          .values(
            newEpisodes.map((episode) => ({
              companionId,
              summary: stripNul(episode.summary),
              seqStart: episode.seqStart,
              seqEnd: episode.seqEnd,
              occurredStart: episode.occurredStart,
              occurredEnd: episode.occurredEnd,
              salience: episode.salience ?? null,
              embedding: episode.embedding ? [...episode.embedding] : null,
            })),
          )
          .returning();
        inserted = rows.map(toEpisodeRecord);
      }
      await tx
        .update(companions)
        .set({ consolidatedThroughSeq: throughSeq })
        .where(eq(companions.id, companionId));
      return inserted;
    });
  }

  async searchEpisodes(
    companionId: string,
    params: EpisodeSearchParams,
  ): Promise<readonly EpisodeSearchHit[]> {
    const filterClauses = this.buildFilters(companionId, params);

    // An empty query embedding (the provider is down and the caller degraded)
    // skips the vector arm — lexical FTS still answers.
    const vectorRows: EpisodeHitRow[] =
      params.queryEmbedding.length === 0
        ? []
        : await this.db
            .select(hitColumns)
            .from(episodes)
            .where(and(...filterClauses, sql`${episodes.embedding} IS NOT NULL`))
            .orderBy(
              sql`${episodes.embedding} <=> ${JSON.stringify([...params.queryEmbedding])}::vector`,
            )
            .limit(params.topK);

    const lexicalRows: EpisodeHitRow[] = await this.db
      .select(hitColumns)
      .from(episodes)
      .where(
        and(
          ...filterClauses,
          sql`${episodes.fts} @@ plainto_tsquery('english', ${params.queryText})`,
        ),
      )
      .orderBy(sql`ts_rank(${episodes.fts}, plainto_tsquery('english', ${params.queryText})) DESC`)
      .limit(params.topK);

    return reciprocalRankFusion([vectorRows, lexicalRows], (row) => row.episodeId, params.topK).map(
      ({ item, score }) => ({ ...toHit(item), score }),
    );
  }

  async listEpisodes(
    companionId: string,
    opts?: { limit?: number },
  ): Promise<readonly EpisodeRecord[]> {
    const query = this.db
      .select()
      .from(episodes)
      .where(eq(episodes.companionId, companionId))
      .orderBy(desc(episodes.occurredEnd));
    const rows = opts?.limit != null ? await query.limit(opts.limit) : await query;
    return rows.map(toEpisodeRecord);
  }

  async countEpisodes(companionId: string): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(episodes)
      .where(eq(episodes.companionId, companionId));
    return row?.value ?? 0;
  }

  async averageSalience(companionId: string): Promise<number> {
    // COALESCE so a companion with no episodes (or all-null salience) reads 0
    // rather than null — the relationship curve treats "no history" as no depth.
    const [row] = await this.db
      .select({ value: sql<number>`coalesce(avg(${episodes.salience}), 0)` })
      .from(episodes)
      .where(eq(episodes.companionId, companionId));
    return Number(row?.value ?? 0);
  }

  async consolidatedThroughSeq(companionId: string): Promise<number> {
    const [row] = await this.db
      .select({ seq: companions.consolidatedThroughSeq })
      .from(companions)
      .where(eq(companions.id, companionId))
      .limit(1);
    return row?.seq ?? 0;
  }

  async companionsNeedingConsolidation(minPendingTurns: number): Promise<readonly string[]> {
    // COUNT this companion's turns past its cursor — NOT max(seq) − cursor, since
    // `seq` is a GLOBAL bigserial (a companion's max seq reflects total system
    // traffic, not its own turn count). INNER JOIN on seq > cursor, so companions
    // with no pending turns drop out and the count is the true pending tail.
    const rows = await this.db
      .select({ id: companions.id })
      .from(companions)
      .innerJoin(
        messages,
        and(
          eq(messages.companionId, companions.id),
          gt(messages.seq, companions.consolidatedThroughSeq),
        ),
      )
      .groupBy(companions.id)
      .having(sql`count(${messages.id}) >= ${minPendingTurns}`);
    return rows.map((row) => row.id);
  }

  /** Tenancy scope plus the optional wall-clock window, shared by both arms. */
  private buildFilters(companionId: string, params: EpisodeSearchParams) {
    const clauses = [eq(episodes.companionId, companionId)];
    if (params.filters?.after) {
      clauses.push(sql`${episodes.occurredEnd} >= ${params.filters.after.toISOString()}`);
    }
    if (params.filters?.before) {
      clauses.push(sql`${episodes.occurredStart} < ${params.filters.before.toISOString()}`);
    }
    return clauses;
  }
}

function toEpisodeRecord(row: typeof episodes.$inferSelect): EpisodeRecord {
  return {
    id: row.id,
    companionId: row.companionId,
    summary: row.summary,
    seqStart: row.seqStart,
    seqEnd: row.seqEnd,
    occurredStart: row.occurredStart.toISOString(),
    occurredEnd: row.occurredEnd.toISOString(),
    salience: row.salience,
    createdAt: row.createdAt.toISOString(),
  };
}

function toHit(row: EpisodeHitRow): Omit<EpisodeSearchHit, 'score'> {
  return {
    episodeId: row.episodeId,
    summary: row.summary,
    seqStart: row.seqStart,
    seqEnd: row.seqEnd,
    occurredStart: row.occurredStart.toISOString(),
    occurredEnd: row.occurredEnd.toISOString(),
    salience: row.salience,
  };
}
