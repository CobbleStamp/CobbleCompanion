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
import type { Paragraph } from './parser.js';

/** A section boundary from Pass 1: which whole paragraphs form one cohesive unit. */
export interface SectionBoundary {
  readonly topicTitle: string;
  /** 1-based inclusive paragraph ordinals — whole paragraphs, never split. */
  readonly paraStart: number;
  readonly paraEnd: number;
}

/** Paragraphs per LLM segmentation call — bounded so one book = a few cheap reads. */
const BATCH_SIZE = 150;
/** Fallback grouping size when the model's boundaries are unusable. */
const FALLBACK_SECTION_SIZE = 6;

const SEGMENT_PROMPT = `You segment a document into semantically cohesive sections.
Below are numbered paragraphs. Group consecutive paragraphs into sections of one
cohesive topic each (typically 3-12 paragraphs). Sections must cover every
paragraph in order, without gaps or overlaps, and must never split a paragraph.
Respond with ONLY JSON, no prose:
{"sections":[{"topic":"<concise topic title>","start":<first paragraph number>,"end":<last paragraph number>}]}`;

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
  for (let offset = 0; offset < paragraphs.length; offset += BATCH_SIZE) {
    const batch = paragraphs.slice(offset, offset + BATCH_SIZE);
    boundaries.push(...(await segmentBatch(gateway, model, batch, logger)));
  }
  return boundaries;
}

async function segmentBatch(
  gateway: LlmGateway,
  model: string,
  batch: readonly Paragraph[],
  logger: Logger,
): Promise<readonly SectionBoundary[]> {
  const first = batch[0]!.ord;
  const last = batch[batch.length - 1]!.ord;
  const numbered = batch.map((p) => `[${p.ord}] ${p.text}`).join('\n\n');

  let raw = '';
  for await (const delta of gateway.stream({
    model,
    messages: [
      { role: 'system', content: SEGMENT_PROMPT },
      { role: 'user', content: numbered },
    ],
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
