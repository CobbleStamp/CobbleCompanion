/**
 * Enricher tests: enrichment-JSON parsing, ontology validation (unknown core
 * types dropped, docs/ontology.md), and graceful degradation to a
 * metadata-derived header.
 */

import { describe, expect, it } from 'vitest';
import { FakeLlmGateway } from '../llm/fake.js';
import type { Logger } from '../logging.js';
import { enrichSection, parseEnrichment } from './enricher.js';

const silentLogger: Logger = { error: () => undefined, info: () => undefined };

const sectionInput = {
  sourceTitle: 'Peru: A History',
  topicTitle: 'The conquest',
  originalText: 'He then moved the capital there in 1535.',
};

describe('parseEnrichment', () => {
  it('parses a context header and well-formed facts', () => {
    const raw = `{"context":"[Peru: A History — the conquest; Pizarro moves the capital to Lima]",
      "facts":[{"type":"event","subject":"Pizarro","predicate":"founded","object":"Lima","confidence":0.9}]}`;
    const enrichment = parseEnrichment(raw);
    expect(enrichment?.contextHeader).toContain('Pizarro');
    expect(enrichment?.facts).toEqual([
      {
        factType: 'event',
        subject: 'Pizarro',
        predicate: 'founded',
        object: 'Lima',
        confidence: 0.9,
      },
    ]);
  });

  it('skips structurally invalid facts but keeps the rest', () => {
    const raw = `{"context":"ok","facts":[
      {"type":"event","subject":"","object":"Lima"},
      {"type":"entity","subject":"Lima","object":"city"}]}`;
    expect(parseEnrichment(raw)?.facts).toEqual([
      { factType: 'entity', subject: 'Lima', object: 'city' },
    ]);
  });

  it('returns null without a context string or JSON object', () => {
    expect(parseEnrichment('{"facts":[]}')).toBeNull();
    expect(parseEnrichment('no json here')).toBeNull();
  });
});

describe('enrichSection', () => {
  it('returns validated facts and the model context header', async () => {
    const gateway = new FakeLlmGateway([
      '{"context":"[Peru: A History — Pizarro founds Lima]","facts":[{"type":"event","subject":"Pizarro","object":"Lima"}]}',
    ]);

    const enrichment = await enrichSection(gateway, 'cheap-model', sectionInput, silentLogger);
    expect(enrichment.contextHeader).toBe('[Peru: A History — Pizarro founds Lima]');
    expect(enrichment.facts).toHaveLength(1);
    // The prompt carries the verbatim text and metadata for reference resolution.
    expect(gateway.lastParams?.messages[1]?.content).toContain('He then moved the capital');
  });

  it('drops facts whose core type is outside the closed ontology set', async () => {
    const gateway = new FakeLlmGateway([
      '{"context":"ok","facts":[{"type":"vibe","subject":"Lima","object":"nice"},{"type":"entity","subject":"Lima","object":"capital city"}]}',
    ]);

    const enrichment = await enrichSection(gateway, 'cheap-model', sectionInput, silentLogger);
    expect(enrichment.facts.map((f) => f.factType)).toEqual(['entity']);
  });

  it('degrades to a metadata header with no facts on unusable output', async () => {
    const gateway = new FakeLlmGateway(['I refuse to answer in JSON.']);

    const enrichment = await enrichSection(gateway, 'cheap-model', sectionInput, silentLogger);
    expect(enrichment.contextHeader).toBe('[Peru: A History — The conquest]');
    expect(enrichment.facts).toEqual([]);
  });
});
