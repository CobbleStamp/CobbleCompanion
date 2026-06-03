/**
 * Ingestion pipeline orchestrator (architecture.md ingestion flow): parse →
 * segment (Pass 1) → enrich (Pass 2) → embed, updating the ingestion job's
 * durable status at every stage. Pure sequencing — parsing, segmentation,
 * enrichment, and embedding-input construction are delegated to their modules.
 * A failure marks the job `failed` with a user-safe reason; detail goes to logs
 * (failures are data, architecture.md §4.7).
 */

import type { EmbeddingGateway } from '../embedding/gateway.js';
import type { LlmGateway } from '../llm/gateway.js';
import type { Logger } from '../logging.js';
import type { NewSection, SectionRecord, SemanticMemoryStore } from '../memory/semantic-store.js';
import type { TokenQuotaStore } from '../quota/store.js';
import { createUsageAccumulator, meteredLlmGateway, type UsageAccumulator } from '../usage.js';
import { buildEmbeddingInput } from './embedder.js';
import { enrichSection } from './enricher.js';
import type { ParsedDocument } from './parser.js';
import { segmentParagraphs, type SectionBoundary } from './segmenter.js';
import { createSourceParser, type SourceParser } from './source-parser.js';

/**
 * The raw input a queued ingestion run works on (held by the runner). Uploaded
 * files all arrive as bytes and differ only in how they're parsed; typed notes
 * and links carry their text/URL directly.
 */
export type IngestionPayload =
  | { readonly kind: 'pdf'; readonly bytes: Uint8Array }
  | { readonly kind: 'txt'; readonly bytes: Uint8Array }
  | { readonly kind: 'md'; readonly bytes: Uint8Array }
  | { readonly kind: 'docx'; readonly bytes: Uint8Array }
  | { readonly kind: 'pptx'; readonly bytes: Uint8Array }
  | { readonly kind: 'note'; readonly text: string }
  | { readonly kind: 'link'; readonly url: string };

export interface IngestionPipelineOptions {
  readonly semantic: SemanticMemoryStore;
  readonly llm: LlmGateway;
  readonly embeddings: EmbeddingGateway;
  /** Cheap model for the two reading passes (input-heavy, output-bounded). */
  readonly ingestionModel: string;
  readonly embeddingModel: string;
  readonly embeddingDimensions: number;
  /** A/B knob: prefix the Pass-2 context header onto the embedding input. */
  readonly useContextHeader: boolean;
  readonly logger: Logger;
  /** How payloads become parsed documents; defaults to the standard source parser. */
  readonly sourceParser?: SourceParser;
  /** Debits the run's tokens against the owner's daily cap; omitted = no metering. */
  readonly quota?: TokenQuotaStore;
}

export interface IngestionRunParams {
  readonly companionId: string;
  readonly sourceId: string;
  readonly jobId: string;
  readonly sourceTitle: string;
  /** The companion's owner — the account the run's tokens are debited to. */
  readonly ownerId?: string;
  /** Raw input for a fresh run; parsed off the request path. */
  readonly payload?: IngestionPayload;
  /**
   * A pre-parsed document for resuming a previously `deferred` job: parsing
   * already happened, so the run skips straight to the (token-spending) AI
   * passes. Exactly one of `payload` / `resumeDocument` is set.
   */
  readonly resumeDocument?: ParsedDocument;
}

/** Sections embedded per gateway call. */
const EMBED_BATCH_SIZE = 32;

export class IngestionPipeline {
  private readonly sourceParser: SourceParser;

  constructor(private readonly options: IngestionPipelineOptions) {
    this.sourceParser = options.sourceParser ?? createSourceParser();
  }

  /** Run one source through all stages; never throws — failures land on the job. */
  async run(params: IngestionRunParams): Promise<void> {
    const { semantic, logger } = this.options;
    const { companionId, sourceId, jobId } = params;
    // One tally for the whole run: the two LLM passes (via a metered gateway)
    // and the embedding pass all deposit here, debited once at the end.
    const usage = createUsageAccumulator();
    try {
      // Parsing is free (no tokens). A fresh run parses and stores the canonical
      // text; a resume reuses the parse held on the deferred job.
      let document: ParsedDocument;
      if (params.resumeDocument) {
        document = params.resumeDocument;
      } else {
        await semantic.updateJob(jobId, { status: 'parsing' });
        if (!params.payload) {
          throw new Error('ingestion run has neither a payload nor a resume document');
        }
        document = await this.sourceParser.parse(params.payload);
        await semantic.setSourceText(sourceId, document.rawText);
      }

      // Quota gate: the AI passes (segment/enrich/embed) are the token cost, so
      // gate them. Over cap → hold the parse and defer until the daily reset (the
      // sweeper resumes it). Mid-run overage is allowed; rollover debt handles it.
      if (await this.isOverCap(params.ownerId)) {
        await semantic.updateJob(jobId, { status: 'deferred', parsedDoc: document });
        return;
      }

      await semantic.updateJob(jobId, { status: 'segmenting', parsedDoc: null });
      const sections = await this.segmentIntoSections(params, document, usage);
      await semantic.updateJob(jobId, { status: 'enriching', sectionsTotal: sections.length });

      const headers = await this.enrichSections(params, sections, usage);

      await semantic.updateJob(jobId, { status: 'embedding' });
      await this.embedSections(sections, headers, usage);

      await semantic.updateJob(jobId, { status: 'done' });
      await this.debit(params.ownerId, usage);
    } catch (error) {
      logger.error('ingestion run failed', {
        operation: 'ingestion.pipeline.run',
        companionId,
        sourceId,
        jobId,
        error,
      });
      await semantic.updateJob(jobId, {
        status: 'failed',
        error: 'Cobble could not finish reading this source. Please try again.',
        parsedDoc: null,
      });
    }
  }

  /** Whether the owner is over their daily cap (false when unmetered, e.g. tests). */
  private async isOverCap(ownerId: string | undefined): Promise<boolean> {
    if (!this.options.quota || !ownerId) {
      return false;
    }
    return this.options.quota.isOverCap(ownerId);
  }

  /** Pass 1: LLM boundary marking, then slice VERBATIM paragraph ranges into rows. */
  private async segmentIntoSections(
    params: IngestionRunParams,
    document: ParsedDocument,
    usage: UsageAccumulator,
  ): Promise<readonly SectionRecord[]> {
    const boundaries = await segmentParagraphs(
      meteredLlmGateway(this.options.llm, usage.sink),
      this.options.ingestionModel,
      document.paragraphs,
      this.options.logger,
    );
    return this.options.semantic.insertSections(
      params.companionId,
      params.sourceId,
      boundaries.map((boundary, ord) => toNewSection(document, boundary, ord)),
    );
  }

  /** Pass 2: per-section context header + ontology-validated facts; returns headers. */
  private async enrichSections(
    params: IngestionRunParams,
    sections: readonly SectionRecord[],
    usage: UsageAccumulator,
  ): Promise<ReadonlyMap<string, string>> {
    const { semantic, logger } = this.options;
    const llm = meteredLlmGateway(this.options.llm, usage.sink);
    const headers = new Map<string, string>();
    let done = 0;
    for (const section of sections) {
      const enrichment = await enrichSection(
        llm,
        this.options.ingestionModel,
        {
          sourceTitle: params.sourceTitle,
          topicTitle: section.topicTitle,
          originalText: section.originalText,
        },
        logger,
      );
      await semantic.setSectionContextHeader(section.id, enrichment.contextHeader);
      headers.set(section.id, enrichment.contextHeader);
      if (enrichment.facts.length > 0) {
        await semantic.insertFacts(
          params.companionId,
          enrichment.facts.map((fact) => ({ ...fact, sectionId: section.id })),
        );
      }
      done += 1;
      await semantic.updateJob(params.jobId, { sectionsDone: done });
    }
    return headers;
  }

  /** Embed each section (batched); input may be header-prefixed, stored text never is. */
  private async embedSections(
    sections: readonly SectionRecord[],
    headers: ReadonlyMap<string, string>,
    usage: UsageAccumulator,
  ): Promise<void> {
    for (let offset = 0; offset < sections.length; offset += EMBED_BATCH_SIZE) {
      const batch = sections.slice(offset, offset + EMBED_BATCH_SIZE);
      const { vectors, usage: embedUsage } = await this.options.embeddings.embed({
        input: batch.map((section) =>
          buildEmbeddingInput(
            {
              originalText: section.originalText,
              contextHeader: headers.get(section.id) ?? null,
            },
            this.options.useContextHeader,
          ),
        ),
        model: this.options.embeddingModel,
        dimensions: this.options.embeddingDimensions,
      });
      usage.sink.add(embedUsage);
      for (let i = 0; i < batch.length; i++) {
        await this.options.semantic.setSectionEmbedding(batch[i]!.id, vectors[i]!);
      }
    }
  }

  /**
   * Debit the run's tokens against the owner's daily cap. Best-effort: a
   * metering failure is logged but never fails an otherwise-successful run
   * (logging.md); runs with no owner/quota (e.g. tests) skip metering.
   */
  private async debit(ownerId: string | undefined, usage: UsageAccumulator): Promise<void> {
    const total = usage.total().totalTokens;
    if (!this.options.quota || !ownerId || total <= 0) {
      return;
    }
    try {
      await this.options.quota.recordUsage(ownerId, total);
    } catch (error) {
      this.options.logger.error('failed to record ingestion token usage', {
        operation: 'ingestion.pipeline.debit',
        ownerId,
        error,
      });
    }
  }
}

/** Map one Pass-1 boundary to a section row: whole paragraphs, joined verbatim. */
function toNewSection(
  document: ParsedDocument,
  boundary: SectionBoundary,
  ord: number,
): NewSection {
  const slice = document.paragraphs.slice(boundary.paraStart - 1, boundary.paraEnd);
  return {
    topicTitle: boundary.topicTitle,
    // Verbatim: whole paragraphs joined, never rewritten by the model.
    originalText: slice.map((p) => p.text).join('\n\n'),
    paraStart: boundary.paraStart,
    paraEnd: boundary.paraEnd,
    ...(slice[0]?.page !== undefined ? { pageStart: slice[0].page } : {}),
    ...(slice[slice.length - 1]?.page !== undefined
      ? { pageEnd: slice[slice.length - 1]!.page }
      : {}),
    ord,
  };
}
