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
import { isCoreFactType } from './ontology.js';

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

const ENRICH_PROMPT = `You index a section of a source document for retrieval.
Given the source title, section topic, and the section's verbatim text, respond
with ONLY JSON, no prose:
{"context":"<ONE line, <=30 words, naming the source, the topic, and the key entities the text refers to (resolve pronouns)>",
 "facts":[{"type":"entity|attribute|relation|event|definition","subject":"...","predicate":"...","object":"...","confidence":0.0}]}
Emit at most 8 facts; only facts the text directly supports. Keep output minimal.`;

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
  let raw = '';
  for await (const delta of gateway.stream({
    model,
    messages: [
      { role: 'system', content: ENRICH_PROMPT },
      {
        role: 'user',
        content: `Source: ${input.sourceTitle}\nTopic: ${input.topicTitle}\n\n${input.originalText}`,
      },
    ],
  })) {
    raw += delta;
  }

  const fallbackHeader = `[${input.sourceTitle} — ${input.topicTitle}]`;
  const parsed = parseEnrichment(raw);
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

/** Parse the model's enrichment JSON; null when structurally unusable. */
export function parseEnrichment(raw: string): Enrichment | null {
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
  } catch {
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
    facts.push({
      factType: fact.type,
      subject: fact.subject.trim(),
      ...(fact.predicate ? { predicate: fact.predicate.trim() } : {}),
      object: fact.object.trim(),
      ...(typeof fact.confidence === 'number' ? { confidence: fact.confidence } : {}),
    });
  }
  return { contextHeader: parsed.context.trim(), facts };
}
