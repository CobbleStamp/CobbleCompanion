/**
 * Semantic memory store — Phase 1's knowledge organism substrate
 * (architecture.md invariant #2: memory behind an interface). Owns the three
 * layers: sources (verbatim originals), sections (verbatim retrieval units with
 * vector + FTS indexes), and the typed fact overlay (docs/ontology.md), plus
 * the ingestion-job status surface. Retrieval is hybrid: vector cosine search
 * and lexical FTS fused by reciprocal-rank fusion, with optional metadata
 * filters; every hit carries provenance back to its source.
 */

import { companions, facts, ingestionJobs, sections, sources, type Database } from '@cobble/db';
import type { IngestionStatus, SourceKind } from '@cobble/shared';
import { and, count, desc, eq, notInArray, sql } from 'drizzle-orm';
import type { ParsedDocument } from '../ingestion/parser.js';
import { stripNul } from '../text/sanitize.js';

export interface CreateSourceInput {
  readonly kind: SourceKind;
  readonly title: string;
  readonly origin?: string;
  readonly rawText: string;
  readonly byteSize?: number;
}

export interface SourceRecord {
  readonly id: string;
  readonly companionId: string;
  readonly kind: SourceKind;
  readonly title: string;
  readonly origin: string | null;
  readonly byteSize: number | null;
  readonly createdAt: string;
}

export interface NewSection {
  readonly chapterTitle?: string;
  readonly topicTitle: string;
  readonly originalText: string;
  readonly paraStart: number;
  readonly paraEnd: number;
  readonly pageStart?: number;
  readonly pageEnd?: number;
  readonly ord: number;
}

export interface SectionRecord {
  readonly id: string;
  readonly sourceId: string;
  readonly chapterTitle: string | null;
  readonly topicTitle: string;
  readonly originalText: string;
  readonly contextHeader: string | null;
  readonly paraStart: number;
  readonly paraEnd: number;
  readonly pageStart: number | null;
  readonly pageEnd: number | null;
  readonly ord: number;
}

export interface NewFact {
  readonly sectionId: string;
  readonly factType: string;
  readonly subject: string;
  readonly predicate?: string;
  readonly object: string;
  readonly confidence?: number;
}

export interface JobRecord {
  readonly id: string;
  readonly companionId: string;
  readonly sourceId: string;
  readonly status: IngestionStatus;
  readonly sectionsTotal: number;
  readonly sectionsDone: number;
  readonly error: string | null;
}

export interface JobPatch {
  readonly status?: IngestionStatus;
  readonly sectionsTotal?: number;
  readonly sectionsDone?: number;
  readonly error?: string;
  /** Parsed paragraphs to hold while `deferred`; `null` clears them on resume/finish. */
  readonly parsedDoc?: ParsedDocument | null;
}

/** A deferred job with everything the sweeper needs to resume it after reset. */
export interface DeferredJob {
  readonly jobId: string;
  readonly companionId: string;
  readonly ownerId: string;
  readonly sourceId: string;
  readonly sourceTitle: string;
  readonly parsedDoc: ParsedDocument;
}

/** A retrieval hit: the verbatim section plus full provenance and a fused score. */
export interface SemanticSearchHit {
  readonly sectionId: string;
  readonly sourceId: string;
  readonly sourceTitle: string;
  readonly chapterTitle: string | null;
  readonly topicTitle: string;
  readonly originalText: string;
  readonly paraStart: number;
  readonly paraEnd: number;
  readonly pageStart: number | null;
  readonly pageEnd: number | null;
  readonly score: number;
}

export interface SemanticSearchParams {
  readonly queryEmbedding: readonly number[];
  readonly queryText: string;
  readonly topK: number;
  /**
   * Metadata filters (the second retrieval path). `entity` matches sections
   * whose fact overlay mentions the entity as subject or object — the overlay
   * compensating where raw-text embeddings are weak (unresolved references).
   */
  readonly filters?: {
    readonly sourceId?: string;
    readonly entity?: string;
  };
}

export interface SemanticCounts {
  readonly sources: number;
  readonly sections: number;
  readonly facts: number;
}

/** Boundary for all Phase 1 semantic memory (sources/sections/facts/jobs). */
export interface SemanticMemoryStore {
  createSource(companionId: string, input: CreateSourceInput): Promise<SourceRecord>;
  /**
   * Fill in the canonical text after off-request-path extraction (PDF/link).
   * PRECONDITION (also for the section/job mutators below): the id must come
   * from a row created within the caller's own companion scope — these
   * pipeline-internal writes are keyed by id alone and are never reachable
   * from user input (tenancy invariant #5 is enforced at creation and on
   * every read path).
   */
  setSourceText(sourceId: string, rawText: string): Promise<void>;
  getSourceText(companionId: string, sourceId: string): Promise<string | null>;
  listSources(companionId: string): Promise<readonly SourceRecord[]>;
  insertSections(
    companionId: string,
    sourceId: string,
    newSections: readonly NewSection[],
  ): Promise<readonly SectionRecord[]>;
  listSectionsBySource(companionId: string, sourceId: string): Promise<readonly SectionRecord[]>;
  setSectionContextHeader(sectionId: string, contextHeader: string): Promise<void>;
  setSectionEmbedding(sectionId: string, embedding: readonly number[]): Promise<void>;
  insertFacts(companionId: string, newFacts: readonly NewFact[]): Promise<void>;
  search(companionId: string, params: SemanticSearchParams): Promise<readonly SemanticSearchHit[]>;
  counts(companionId: string): Promise<SemanticCounts>;
  createJob(companionId: string, sourceId: string): Promise<JobRecord>;
  updateJob(jobId: string, patch: JobPatch): Promise<void>;
  listJobs(companionId: string): Promise<readonly JobRecord[]>;
  /** Jobs waiting on a cap reset (status `deferred`), with owner + parsed doc. */
  listDeferredJobs(): Promise<readonly DeferredJob[]>;
  /**
   * Atomically claim a deferred job for resumption: flip `deferred` → `queued`
   * only if it is still `deferred`. Returns true if this caller won the claim.
   * Lets two overlapping sweeps never resume (and re-bill) the same job twice.
   */
  claimDeferredJob(jobId: string): Promise<boolean>;
  /**
   * Recover from a restart: fail every non-terminal, non-`deferred` job (its
   * in-memory parse state is gone). Deferred jobs are resumable and left alone.
   * Returns how many were failed.
   */
  failInterruptedJobs(): Promise<number>;
  /** Owner-scoped source delete (cascades to its sections + job). Returns true if removed. */
  deleteSource(companionId: string, sourceId: string): Promise<boolean>;
}

/** An internal ranked hit from one retrieval arm, pre-fusion. */
interface RankedSection {
  readonly hit: Omit<SemanticSearchHit, 'score'>;
}

/**
 * Fuse the vector and lexical result lists with reciprocal-rank fusion
 * (score = Σ 1/(K + rank)) — scale-free, so cosine distances and ts_rank
 * scores never need calibrating against each other. Pure computation,
 * separated from the SQL orchestration for direct unit testing.
 */
export function combineHits(
  vectorRanked: readonly RankedSection[],
  lexicalRanked: readonly RankedSection[],
  topK: number,
): readonly SemanticSearchHit[] {
  const RRF_K = 60;
  const fused = new Map<string, { hit: Omit<SemanticSearchHit, 'score'>; score: number }>();
  for (const list of [vectorRanked, lexicalRanked]) {
    list.forEach(({ hit }, rank) => {
      const existing = fused.get(hit.sectionId);
      const increment = 1 / (RRF_K + rank + 1);
      if (existing) {
        fused.set(hit.sectionId, { hit: existing.hit, score: existing.score + increment });
      } else {
        fused.set(hit.sectionId, { hit, score: increment });
      }
    });
  }
  return [...fused.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(({ hit, score }) => ({ ...hit, score }));
}

export class DrizzleSemanticMemoryStore implements SemanticMemoryStore {
  constructor(private readonly db: Database) {}

  async createSource(companionId: string, input: CreateSourceInput): Promise<SourceRecord> {
    const [row] = await this.db
      .insert(sources)
      .values({
        companionId,
        kind: input.kind,
        title: stripNul(input.title),
        origin: input.origin == null ? null : stripNul(input.origin),
        rawText: stripNul(input.rawText),
        byteSize: input.byteSize ?? null,
      })
      .returning();
    if (!row) {
      throw new Error('failed to create source');
    }
    return toSourceRecord(row);
  }

  async setSourceText(sourceId: string, rawText: string): Promise<void> {
    await this.db
      .update(sources)
      .set({ rawText: stripNul(rawText) })
      .where(eq(sources.id, sourceId));
  }

  async getSourceText(companionId: string, sourceId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ rawText: sources.rawText })
      .from(sources)
      .where(and(eq(sources.id, sourceId), eq(sources.companionId, companionId)))
      .limit(1);
    return row?.rawText ?? null;
  }

  async listSources(companionId: string): Promise<readonly SourceRecord[]> {
    const rows = await this.db
      .select()
      .from(sources)
      .where(eq(sources.companionId, companionId))
      .orderBy(desc(sources.createdAt));
    return rows.map(toSourceRecord);
  }

  async insertSections(
    companionId: string,
    sourceId: string,
    newSections: readonly NewSection[],
  ): Promise<readonly SectionRecord[]> {
    if (newSections.length === 0) return [];
    // Replace, not append: a single run produces a source's whole section set
    // (one call from the pipeline), so clearing the source's prior sections
    // first makes re-running the same source idempotent — a re-run replaces
    // rather than duplicating, regardless of what triggered it (sweep race,
    // future at-least-once worker). The delete + insert are one transaction so
    // a source is never momentarily section-less. Orphaned facts cascade away
    // with their sections (facts.sectionId → sections, ON DELETE CASCADE). If
    // the source was deleted mid-run, the FK insert below throws and the whole
    // transaction rolls back — the caller (pipeline.run) marks the job failed.
    return this.db.transaction(async (tx) => {
      await tx
        .delete(sections)
        .where(and(eq(sections.companionId, companionId), eq(sections.sourceId, sourceId)));
      const rows = await tx
        .insert(sections)
        .values(
          newSections.map((section) => ({
            companionId,
            sourceId,
            chapterTitle: section.chapterTitle == null ? null : stripNul(section.chapterTitle),
            topicTitle: stripNul(section.topicTitle),
            originalText: stripNul(section.originalText),
            paraStart: section.paraStart,
            paraEnd: section.paraEnd,
            pageStart: section.pageStart ?? null,
            pageEnd: section.pageEnd ?? null,
            ord: section.ord,
          })),
        )
        .returning();
      return rows.map(toSectionRecord);
    });
  }

  async listSectionsBySource(
    companionId: string,
    sourceId: string,
  ): Promise<readonly SectionRecord[]> {
    const rows = await this.db
      .select()
      .from(sections)
      .where(and(eq(sections.sourceId, sourceId), eq(sections.companionId, companionId)))
      .orderBy(sections.ord);
    return rows.map(toSectionRecord);
  }

  async setSectionContextHeader(sectionId: string, contextHeader: string): Promise<void> {
    await this.db
      .update(sections)
      .set({ contextHeader: stripNul(contextHeader) })
      .where(eq(sections.id, sectionId));
  }

  async setSectionEmbedding(sectionId: string, embedding: readonly number[]): Promise<void> {
    await this.db
      .update(sections)
      .set({ embedding: [...embedding] })
      .where(eq(sections.id, sectionId));
  }

  async insertFacts(companionId: string, newFacts: readonly NewFact[]): Promise<void> {
    if (newFacts.length === 0) return;
    await this.db.insert(facts).values(
      newFacts.map((fact) => ({
        companionId,
        sectionId: fact.sectionId,
        factType: fact.factType,
        subject: stripNul(fact.subject),
        predicate: fact.predicate == null ? null : stripNul(fact.predicate),
        object: stripNul(fact.object),
        confidence: fact.confidence ?? null,
      })),
    );
  }

  async search(
    companionId: string,
    params: SemanticSearchParams,
  ): Promise<readonly SemanticSearchHit[]> {
    const filterClauses = this.buildFilters(companionId, params);

    // An empty query embedding (e.g. the embedding provider is down and the
    // caller degraded) skips the vector arm — lexical search still answers.
    const vectorRows =
      params.queryEmbedding.length === 0
        ? []
        : await this.db
            .select(hitColumns)
            .from(sections)
            .innerJoin(sources, eq(sections.sourceId, sources.id))
            .where(and(...filterClauses, sql`${sections.embedding} IS NOT NULL`))
            .orderBy(
              sql`${sections.embedding} <=> ${JSON.stringify([...params.queryEmbedding])}::vector`,
            )
            .limit(params.topK);

    const lexicalRows = await this.db
      .select(hitColumns)
      .from(sections)
      .innerJoin(sources, eq(sections.sourceId, sources.id))
      .where(
        and(
          ...filterClauses,
          sql`${sections.fts} @@ plainto_tsquery('english', ${params.queryText})`,
        ),
      )
      .orderBy(sql`ts_rank(${sections.fts}, plainto_tsquery('english', ${params.queryText})) DESC`)
      .limit(params.topK);

    return combineHits(
      vectorRows.map((row) => ({ hit: row })),
      lexicalRows.map((row) => ({ hit: row })),
      params.topK,
    );
  }

  async counts(companionId: string): Promise<SemanticCounts> {
    const [sourceCount] = await this.db
      .select({ value: count() })
      .from(sources)
      .where(eq(sources.companionId, companionId));
    const [sectionCount] = await this.db
      .select({ value: count() })
      .from(sections)
      .where(eq(sections.companionId, companionId));
    const [factCount] = await this.db
      .select({ value: count() })
      .from(facts)
      .where(eq(facts.companionId, companionId));
    return {
      sources: sourceCount?.value ?? 0,
      sections: sectionCount?.value ?? 0,
      facts: factCount?.value ?? 0,
    };
  }

  async createJob(companionId: string, sourceId: string): Promise<JobRecord> {
    const [row] = await this.db.insert(ingestionJobs).values({ companionId, sourceId }).returning();
    if (!row) {
      throw new Error('failed to create ingestion job');
    }
    return toJobRecord(row);
  }

  async updateJob(jobId: string, patch: JobPatch): Promise<void> {
    await this.db
      .update(ingestionJobs)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(ingestionJobs.id, jobId));
  }

  async listJobs(companionId: string): Promise<readonly JobRecord[]> {
    const rows = await this.db
      .select()
      .from(ingestionJobs)
      .where(eq(ingestionJobs.companionId, companionId))
      .orderBy(desc(ingestionJobs.createdAt));
    return rows.map(toJobRecord);
  }

  async listDeferredJobs(): Promise<readonly DeferredJob[]> {
    const rows = await this.db
      .select({
        jobId: ingestionJobs.id,
        companionId: ingestionJobs.companionId,
        sourceId: ingestionJobs.sourceId,
        parsedDoc: ingestionJobs.parsedDoc,
        sourceTitle: sources.title,
        ownerId: companions.ownerId,
      })
      .from(ingestionJobs)
      .innerJoin(sources, eq(sources.id, ingestionJobs.sourceId))
      .innerJoin(companions, eq(companions.id, ingestionJobs.companionId))
      .where(eq(ingestionJobs.status, 'deferred'))
      .orderBy(ingestionJobs.createdAt);
    return rows
      .filter((row): row is typeof row & { parsedDoc: ParsedDocument } => row.parsedDoc != null)
      .map((row) => ({
        jobId: row.jobId,
        companionId: row.companionId,
        ownerId: row.ownerId,
        sourceId: row.sourceId,
        sourceTitle: row.sourceTitle,
        parsedDoc: row.parsedDoc,
      }));
  }

  async claimDeferredJob(jobId: string): Promise<boolean> {
    const claimed = await this.db
      .update(ingestionJobs)
      .set({ status: 'queued', updatedAt: new Date() })
      .where(and(eq(ingestionJobs.id, jobId), eq(ingestionJobs.status, 'deferred')))
      .returning({ id: ingestionJobs.id });
    return claimed.length > 0;
  }

  async failInterruptedJobs(): Promise<number> {
    const stranded = await this.db
      .select({ id: ingestionJobs.id })
      .from(ingestionJobs)
      .where(notInArray(ingestionJobs.status, ['done', 'failed', 'deferred']));
    if (stranded.length === 0) {
      return 0;
    }
    await this.db
      .update(ingestionJobs)
      .set({
        status: 'failed',
        error: 'Reading was interrupted. Please re-upload this source.',
        parsedDoc: null,
        updatedAt: new Date(),
      })
      .where(notInArray(ingestionJobs.status, ['done', 'failed', 'deferred']));
    return stranded.length;
  }

  async deleteSource(companionId: string, sourceId: string): Promise<boolean> {
    const deleted = await this.db
      .delete(sources)
      .where(and(eq(sources.id, sourceId), eq(sources.companionId, companionId)))
      .returning({ id: sources.id });
    return deleted.length > 0;
  }

  /** Tenancy scope plus the optional metadata filters, shared by both arms. */
  private buildFilters(companionId: string, params: SemanticSearchParams) {
    const clauses = [eq(sections.companionId, companionId)];
    if (params.filters?.sourceId) {
      clauses.push(eq(sections.sourceId, params.filters.sourceId));
    }
    if (params.filters?.entity) {
      // Escape LIKE wildcards so the entity is matched literally.
      const escaped = params.filters.entity.replace(/[\\%_]/g, '\\$&');
      const pattern = `%${escaped}%`;
      clauses.push(
        sql`EXISTS (SELECT 1 FROM ${facts} WHERE ${facts.sectionId} = ${sections.id} AND (${facts.subject} ILIKE ${pattern} OR ${facts.object} ILIKE ${pattern}))`,
      );
    }
    return clauses;
  }
}

/** Shared select projection: a hit minus its fused score, provenance included. */
const hitColumns = {
  sectionId: sections.id,
  sourceId: sections.sourceId,
  sourceTitle: sources.title,
  chapterTitle: sections.chapterTitle,
  topicTitle: sections.topicTitle,
  originalText: sections.originalText,
  paraStart: sections.paraStart,
  paraEnd: sections.paraEnd,
  pageStart: sections.pageStart,
  pageEnd: sections.pageEnd,
};

function toSourceRecord(row: typeof sources.$inferSelect): SourceRecord {
  return {
    id: row.id,
    companionId: row.companionId,
    kind: row.kind,
    title: row.title,
    origin: row.origin,
    byteSize: row.byteSize,
    createdAt: row.createdAt.toISOString(),
  };
}

function toSectionRecord(row: typeof sections.$inferSelect): SectionRecord {
  return {
    id: row.id,
    sourceId: row.sourceId,
    chapterTitle: row.chapterTitle,
    topicTitle: row.topicTitle,
    originalText: row.originalText,
    contextHeader: row.contextHeader,
    paraStart: row.paraStart,
    paraEnd: row.paraEnd,
    pageStart: row.pageStart,
    pageEnd: row.pageEnd,
    ord: row.ord,
  };
}

function toJobRecord(row: typeof ingestionJobs.$inferSelect): JobRecord {
  return {
    id: row.id,
    companionId: row.companionId,
    sourceId: row.sourceId,
    status: row.status,
    sectionsTotal: row.sectionsTotal,
    sectionsDone: row.sectionsDone,
    error: row.error,
  };
}
