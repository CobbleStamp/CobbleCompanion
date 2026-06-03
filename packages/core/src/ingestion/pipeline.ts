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
import type { NewSection, SemanticMemoryStore } from '../memory/semantic-store.js';
import { buildEmbeddingInput } from './embedder.js';
import { enrichSection } from './enricher.js';
import { parseLinkHtml, parseNote, parsePdf, type ParsedDocument } from './parser.js';
import { segmentParagraphs } from './segmenter.js';

/** The raw input a queued ingestion run works on (held by the runner). */
export type IngestionPayload =
  | { readonly kind: 'pdf'; readonly bytes: Uint8Array }
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
  /** Injectable fetch for link sources (tests pass a fake). */
  readonly fetchFn?: typeof fetch;
}

export interface IngestionRunParams {
  readonly companionId: string;
  readonly sourceId: string;
  readonly jobId: string;
  readonly sourceTitle: string;
  readonly payload: IngestionPayload;
}

/** Sections embedded per gateway call. */
const EMBED_BATCH_SIZE = 32;

export class IngestionPipeline {
  constructor(private readonly options: IngestionPipelineOptions) {}

  /** Run one source through all stages; never throws — failures land on the job. */
  async run(params: IngestionRunParams): Promise<void> {
    const { semantic, logger } = this.options;
    const { companionId, sourceId, jobId } = params;
    try {
      await semantic.updateJob(jobId, { status: 'parsing' });
      const document = await this.parse(params.payload);
      await semantic.setSourceText(sourceId, document.rawText);

      await semantic.updateJob(jobId, { status: 'segmenting' });
      const boundaries = await segmentParagraphs(
        this.options.llm,
        this.options.ingestionModel,
        document.paragraphs,
        logger,
      );
      const sections = await semantic.insertSections(
        companionId,
        sourceId,
        boundaries.map((boundary, ord): NewSection => {
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
        }),
      );
      await semantic.updateJob(jobId, { status: 'enriching', sectionsTotal: sections.length });

      const headers = new Map<string, string>();
      let done = 0;
      for (const section of sections) {
        const enrichment = await enrichSection(
          this.options.llm,
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
            companionId,
            enrichment.facts.map((fact) => ({ ...fact, sectionId: section.id })),
          );
        }
        done += 1;
        await semantic.updateJob(jobId, { sectionsDone: done });
      }

      await semantic.updateJob(jobId, { status: 'embedding' });
      for (let offset = 0; offset < sections.length; offset += EMBED_BATCH_SIZE) {
        const batch = sections.slice(offset, offset + EMBED_BATCH_SIZE);
        const vectors = await this.options.embeddings.embed({
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
        for (let i = 0; i < batch.length; i++) {
          await semantic.setSectionEmbedding(batch[i]!.id, vectors[i]!);
        }
      }

      await semantic.updateJob(jobId, { status: 'done' });
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
      });
    }
  }

  private async parse(payload: IngestionPayload): Promise<ParsedDocument> {
    switch (payload.kind) {
      case 'note':
        return parseNote(payload.text);
      case 'pdf':
        return parsePdf(payload.bytes);
      case 'link': {
        const fetchFn = this.options.fetchFn ?? fetch;
        const response = await fetchFn(payload.url);
        if (!response.ok) {
          throw new Error(`link fetch responded ${response.status}`);
        }
        return parseLinkHtml(await response.text(), payload.url);
      }
    }
  }
}
