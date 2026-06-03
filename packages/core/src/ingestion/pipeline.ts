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
import { buildEmbeddingInput } from './embedder.js';
import { enrichSection } from './enricher.js';
import { parseLinkHtml, parseNote, parsePdf, type ParsedDocument } from './parser.js';
import { readTextWithLimit, safeLinkFetch } from './safe-fetch.js';
import { segmentParagraphs, type SectionBoundary } from './segmenter.js';
import { assertPublicHttpUrl } from './url-guard.js';

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
  /** Injectable fetch for link sources (tests pass a fake; default is SSRF-guarded). */
  readonly fetchFn?: typeof fetch;
  /** Byte ceiling for fetched link bodies (default 25 MiB). */
  readonly maxLinkBytes?: number;
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

/** Default byte ceiling for link bodies (mirrors the upload cap's default). */
const DEFAULT_MAX_LINK_BYTES = 25 * 1024 * 1024;

/** Content types the link parser can actually read. */
const HTML_CONTENT_TYPE = /text\/html|application\/xhtml\+xml/i;

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
      const sections = await this.segmentIntoSections(params, document);
      await semantic.updateJob(jobId, { status: 'enriching', sectionsTotal: sections.length });

      const headers = await this.enrichSections(params, sections);

      await semantic.updateJob(jobId, { status: 'embedding' });
      await this.embedSections(sections, headers);

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
        // SSRF guard, two layers: string-level URL checks here, and the
        // default fetch resolves DNS through the guarded lookup so a public
        // hostname cannot rebind to a private address. Redirects are refused
        // so a public URL cannot bounce the fetch elsewhere.
        const url = assertPublicHttpUrl(payload.url);
        const fetchFn = this.options.fetchFn ?? safeLinkFetch;
        const response = await fetchFn(url, { redirect: 'error' });
        if (!response.ok) {
          throw new Error(`link fetch responded ${response.status}`);
        }
        const contentType = response.headers.get('content-type') ?? '';
        if (!HTML_CONTENT_TYPE.test(contentType)) {
          throw new Error('the link did not return a readable web page');
        }
        const maxBytes = this.options.maxLinkBytes ?? DEFAULT_MAX_LINK_BYTES;
        return parseLinkHtml(await readTextWithLimit(response, maxBytes), payload.url);
      }
    }
  }

  /** Pass 1: LLM boundary marking, then slice VERBATIM paragraph ranges into rows. */
  private async segmentIntoSections(
    params: IngestionRunParams,
    document: ParsedDocument,
  ): Promise<readonly SectionRecord[]> {
    const boundaries = await segmentParagraphs(
      this.options.llm,
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
  ): Promise<ReadonlyMap<string, string>> {
    const { semantic, logger } = this.options;
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
  ): Promise<void> {
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
        await this.options.semantic.setSectionEmbedding(batch[i]!.id, vectors[i]!);
      }
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
