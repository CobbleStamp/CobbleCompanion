/**
 * Pass 1 of ingestion — semantic segmentation (architecture.md ingestion flow).
 * A cheap LLM reads the numbered paragraphs and emits ONLY section boundaries +
 * topic titles (~1% output ratio: input tokens are cheap, output is the cost
 * lever). The verbatim section text is later sliced from the paragraphs by the
 * pipeline — the model never rewrites source text. Invalid model output falls
 * back to fixed-size grouping so ingestion always completes.
 */

import type { LlmGateway } from '../llm/gateway.js';
import type { Logger } from '../logging.js';
import { render, segmenterTemplate } from '../prompts/index.js';
import type { Paragraph } from './parser.js';
import { MAX_INGESTION_PROMPT_CHARS, stripSentinels } from './untrusted.js';

/** A section boundary from Pass 1: which whole paragraphs form one cohesive unit. */
export interface SectionBoundary {
  readonly topicTitle: string;
  /** 1-based inclusive paragraph ordinals — whole paragraphs, never split. */
  readonly paraStart: number;
  readonly paraEnd: number;
}

/** Paragraphs per LLM segmentation call — bounded so one book = a few cheap reads. */
const BATCH_SIZE = 150;
/**
 * Character budget per segmentation prompt. A blank-line-free document is one
 * giant paragraph that would otherwise blow past any model context; we cap the
 * numbered-paragraph text sent to the model while keeping verbatim paragraphs
 * intact for storage (the model only marks ordinals, never rewrites text).
 */
const MAX_BATCH_PROMPT_CHARS = MAX_INGESTION_PROMPT_CHARS;
/** Fallback grouping size when the model's boundaries are unusable. */
const FALLBACK_SECTION_SIZE = 6;

/**
 * Segment the paragraphs into cohesive sections via batched LLM boundary
 * marking, validating coverage and falling back to fixed grouping per batch.
 */
export async function segmentParagraphs(
  gateway: LlmGateway,
  model: string,
  paragraphs: readonly Paragraph[],
  logger: Logger,
): Promise<readonly SectionBoundary[]> {
  const boundaries: SectionBoundary[] = [];
  for (const batch of batchParagraphs(paragraphs)) {
    boundaries.push(...(await segmentBatch(gateway, model, batch, logger)));
  }
  return boundaries;
}

/**
 * Split paragraphs into prompt batches bounded by BOTH paragraph count and the
 * rendered character budget, so a blank-line-free document (one huge paragraph)
 * cannot produce an unbounded prompt. A single paragraph always forms at least
 * its own batch (its text is truncated for the prompt later, never for storage).
 */
function batchParagraphs(paragraphs: readonly Paragraph[]): readonly (readonly Paragraph[])[] {
  const batches: Paragraph[][] = [];
  let current: Paragraph[] = [];
  let currentChars = 0;
  for (const paragraph of paragraphs) {
    const cost = renderParagraph(paragraph).length + 2; // +2 for the '\n\n' join
    if (
      current.length > 0 &&
      (current.length >= BATCH_SIZE || currentChars + cost > MAX_BATCH_PROMPT_CHARS)
    ) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(paragraph);
    currentChars += cost;
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

/** Render one paragraph for the prompt: ordinal-numbered, sentinels stripped. */
function renderParagraph(paragraph: Paragraph): string {
  return `[${paragraph.ord}] ${stripSentinels(paragraph.text)}`;
}

/**
 * Render a batch's numbered paragraphs for the prompt, truncating to the
 * character budget. A single oversized paragraph (e.g. a document with no blank
 * lines) is sliced for the prompt only — its verbatim text is still stored in
 * full by the pipeline, which slices by ordinal, not from this string.
 */
function renderBatch(
  batch: readonly Paragraph[],
  logger: Logger,
  first: number,
  last: number,
): string {
  const numbered = batch.map(renderParagraph).join('\n\n');
  if (numbered.length <= MAX_BATCH_PROMPT_CHARS) {
    return numbered;
  }
  logger.info('truncating oversized segmentation prompt to the character budget', {
    operation: 'ingestion.segmentBatch',
    paraStart: first,
    paraEnd: last,
    promptChars: numbered.length,
    maxChars: MAX_BATCH_PROMPT_CHARS,
  });
  return `${numbered.slice(0, MAX_BATCH_PROMPT_CHARS)}…`;
}

async function segmentBatch(
  gateway: LlmGateway,
  model: string,
  batch: readonly Paragraph[],
  logger: Logger,
): Promise<readonly SectionBoundary[]> {
  const first = batch[0]!.ord;
  const last = batch[batch.length - 1]!.ord;
  const numbered = renderBatch(batch, logger, first, last);

  const prompt = render(segmenterTemplate, { numbered });
  let raw = '';
  for await (const delta of gateway.stream({
    model,
    messages: prompt.messages,
    promptRef: prompt.ref,
  })) {
    raw += delta;
  }

  const parsed = parseBoundaries(raw, first, last);
  if (parsed) {
    return parsed;
  }
  logger.error('segmentation output invalid; using fixed-size fallback', {
    operation: 'ingestion.segmentBatch',
    paraStart: first,
    paraEnd: last,
  });
  return fallbackBoundaries(first, last);
}

/**
 * Parse and validate the model's boundary JSON: ascending, contiguous, exactly
 * covering [first, last]. Returns null when unusable (caller falls back).
 */
export function parseBoundaries(
  raw: string,
  first: number,
  last: number,
): readonly SectionBoundary[] | null {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  let parsed: { sections?: ReadonlyArray<{ topic?: string; start?: number; end?: number }> };
  try {
    parsed = JSON.parse(jsonMatch[0]) as typeof parsed;
  } catch {
    return null;
  }
  const sections = parsed.sections;
  if (!sections || sections.length === 0) return null;

  const boundaries: SectionBoundary[] = [];
  let expectedStart = first;
  for (const section of sections) {
    const { topic, start, end } = section;
    if (
      typeof topic !== 'string' ||
      topic.trim().length === 0 ||
      typeof start !== 'number' ||
      typeof end !== 'number' ||
      start !== expectedStart ||
      end < start ||
      end > last
    ) {
      return null;
    }
    boundaries.push({ topicTitle: topic.trim(), paraStart: start, paraEnd: end });
    expectedStart = end + 1;
  }
  return expectedStart === last + 1 ? boundaries : null;
}

/** Group [first, last] into fixed-size sections with generic titles. */
function fallbackBoundaries(first: number, last: number): readonly SectionBoundary[] {
  const boundaries: SectionBoundary[] = [];
  for (let start = first; start <= last; start += FALLBACK_SECTION_SIZE) {
    const end = Math.min(start + FALLBACK_SECTION_SIZE - 1, last);
    boundaries.push({
      topicTitle: `Passage (paragraphs ${start}–${end})`,
      paraStart: start,
      paraEnd: end,
    });
  }
  return boundaries;
}
