/**
 * Pass 2 of ingestion — enrichment (architecture.md ingestion flow). For each
 * section the LLM emits a compact, bounded output: one context-header line
 * (used to disambiguate the embedding — it injects the entities that unresolved
 * pronouns hide from the encoder) and a handful of typed facts for the
 * knowledge overlay. Facts are validated against the closed core ontology set
 * (docs/ontology.md); invalid ones are dropped and logged, never stored.
 */

import type { LlmGateway } from '../llm/gateway.js';
import type { Logger } from '../logging.js';
import { enricherTemplate, render } from '../prompts/index.js';
import { isCoreFactType } from './ontology.js';
import {
  MAX_INGESTION_PROMPT_CHARS,
  stripSentinels,
  UNTRUSTED_CLOSE,
  UNTRUSTED_OPEN,
} from './untrusted.js';

/** A typed fact extracted from one section, pre-persistence (no ids yet). */
export interface ExtractedFact {
  readonly factType: string;
  readonly subject: string;
  readonly predicate?: string;
  readonly object: string;
  readonly confidence?: number;
}

/** Pass-2 output for one section. */
export interface Enrichment {
  readonly contextHeader: string;
  readonly facts: readonly ExtractedFact[];
}

/**
 * Enrich one section: returns the context header and the validated facts.
 * A malformed response degrades to a metadata-derived header with no facts —
 * ingestion never hard-fails on one section.
 */
export async function enrichSection(
  gateway: LlmGateway,
  model: string,
  input: {
    readonly sourceTitle: string;
    readonly topicTitle: string;
    readonly originalText: string;
  },
  logger: Logger,
): Promise<Enrichment> {
  const userContent = buildEnrichUserContent(input, logger);
  const prompt = render(enricherTemplate, { userContent });
  let raw = '';
  for await (const delta of gateway.stream({
    model,
    messages: prompt.messages,
    promptRef: prompt.ref,
  })) {
    raw += delta;
  }

  const fallbackHeader = `[${input.sourceTitle} — ${input.topicTitle}]`;
  const parsed = parseEnrichment(raw, logger);
  if (!parsed) {
    logger.error('enrichment output invalid; using metadata header without facts', {
      operation: 'ingestion.enrichSection',
      sourceTitle: input.sourceTitle,
      topicTitle: input.topicTitle,
    });
    return { contextHeader: fallbackHeader, facts: [] };
  }

  const validFacts = parsed.facts.filter((fact) => {
    if (isCoreFactType(fact.factType)) return true;
    logger.info('dropping fact with unknown core type (docs/ontology.md)', {
      operation: 'ingestion.enrichSection',
      factType: fact.factType,
    });
    return false;
  });
  return { contextHeader: parsed.contextHeader || fallbackHeader, facts: validFacts };
}

/**
 * Build the fenced, untrusted user message for one section. Titles and verbatim
 * text are sentinel-stripped so they cannot close the fence, and the section
 * text is truncated to the prompt budget (a blank-line-free document yields one
 * huge section); only the PROMPT input is truncated — storage keeps the full
 * verbatim text.
 */
function buildEnrichUserContent(
  input: {
    readonly sourceTitle: string;
    readonly topicTitle: string;
    readonly originalText: string;
  },
  logger: Logger,
): string {
  const sourceTitle = stripSentinels(input.sourceTitle);
  const topicTitle = stripSentinels(input.topicTitle);
  const text = truncateSectionText(input.originalText, sourceTitle, topicTitle, logger);
  return (
    `${UNTRUSTED_OPEN}\n` +
    `Source: ${sourceTitle}\nTopic: ${topicTitle}\n\n${text}\n` +
    `${UNTRUSTED_CLOSE}`
  );
}

/** Truncate verbatim section text to the prompt budget, logging when it bites. */
function truncateSectionText(
  originalText: string,
  sourceTitle: string,
  topicTitle: string,
  logger: Logger,
): string {
  const stripped = stripSentinels(originalText);
  if (stripped.length <= MAX_INGESTION_PROMPT_CHARS) {
    return stripped;
  }
  logger.info('truncating oversized enrichment prompt to the character budget', {
    operation: 'ingestion.enrichSection',
    sourceTitle,
    topicTitle,
    promptChars: stripped.length,
    maxChars: MAX_INGESTION_PROMPT_CHARS,
  });
  return `${stripped.slice(0, MAX_INGESTION_PROMPT_CHARS)}…`;
}

/** Parse the model's enrichment JSON; null when structurally unusable. */
export function parseEnrichment(raw: string, logger: Logger): Enrichment | null {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  let parsed: {
    context?: string;
    facts?: ReadonlyArray<{
      type?: string;
      subject?: string;
      predicate?: string;
      object?: string;
      confidence?: number;
    }>;
  };
  try {
    parsed = JSON.parse(jsonMatch[0]) as typeof parsed;
  } catch (error) {
    logger.error('enrichment output JSON parse error; using metadata header without facts', {
      operation: 'ingestion.enrichSection',
      error: (error as Error).message,
    });
    return null;
  }
  if (typeof parsed.context !== 'string') return null;

  const facts: ExtractedFact[] = [];
  for (const fact of parsed.facts ?? []) {
    if (
      typeof fact.type !== 'string' ||
      typeof fact.subject !== 'string' ||
      typeof fact.object !== 'string' ||
      fact.subject.trim().length === 0 ||
      fact.object.trim().length === 0
    ) {
      continue;
    }
    const confidence = normalizeConfidence(fact.confidence);
    facts.push({
      factType: fact.type,
      subject: fact.subject.trim(),
      ...(fact.predicate ? { predicate: fact.predicate.trim() } : {}),
      object: fact.object.trim(),
      ...(confidence !== undefined ? { confidence } : {}),
    });
  }
  return { contextHeader: parsed.context.trim(), facts };
}

/**
 * Coerce a model-supplied confidence into [0,1]: a non-number or non-finite
 * value (NaN/Infinity) is treated as absent; a finite out-of-range value is
 * clamped. The model's numbers are untrusted, so we never store junk.
 */
function normalizeConfidence(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.min(1, Math.max(0, value));
}
