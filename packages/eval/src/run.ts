/**
 * Live memory-vs-performance eval (companionmemory.md §5): runs the fixed eval
 * set under several memory configurations against real OpenRouter models and
 * prints the comparison. Phase 0 axis: the transcript recency window. Phase 1
 * axis: semantic retrieval over sources ingested through the REAL pipeline,
 * with the contextual-header A/B knob.
 */

import { EMBEDDING_DIMENSIONS } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import {
  createSemanticRetrieveContext,
  DrizzleIdentityStore,
  DrizzleSemanticMemoryStore,
  Harness,
  IngestionPipeline,
  OpenRouterEmbeddingGateway,
  OpenRouterGateway,
  TranscriptMemoryStore,
  type EmbeddingGateway,
  type Logger,
} from '@cobble/core';
import type { CompanionDto } from '@cobble/shared';
import evalSetJson from './fixtures/recall.json' with { type: 'json' };
import { renderCaseDetail, renderComparison, summarize } from './report.js';
import { scoreCase } from './score.js';
import type { CaseResult, ConfigReport, EvalCase, EvalSet, MemoryConfig } from './types.js';

const DEFAULT_WINDOWS = [2, 12, 200];
const SEMANTIC_TOP_K = 5;
const SEMANTIC_RECENT_LIMIT = 12;

/** Eval output is the product here; write directly to stdout. */
function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

const silentLogger: Logger = { error: () => {}, info: () => {} };

interface EvalDeps {
  readonly identity: DrizzleIdentityStore;
  readonly memory: TranscriptMemoryStore;
  readonly semantic: DrizzleSemanticMemoryStore;
  readonly gateway: OpenRouterGateway;
  readonly embeddings: EmbeddingGateway;
  readonly model: string;
  readonly ingestionModel: string;
  readonly embeddingModel: string;
}

async function main(): Promise<void> {
  const apiKey = process.env.OPENROUTER_API_KEY ?? '';
  if (apiKey.length === 0) {
    throw new Error(
      'OPENROUTER_API_KEY is required — this is a LIVE eval against OpenRouter (companionmemory.md).',
    );
  }
  const model = process.env.LLM_MODEL ?? 'anthropic/claude-3.5-sonnet';
  const ingestionModel = process.env.INGESTION_MODEL ?? 'google/gemini-2.5-flash';
  const embeddingModel = process.env.EMBEDDING_MODEL ?? 'perplexity/pplx-embed-v1-0.6b';

  const configs: MemoryConfig[] = parseWindows(process.env.EVAL_WINDOWS).map(
    (recentLimit): MemoryConfig => ({ label: `window-${recentLimit}`, recentLimit }),
  );
  // Phase 1 semantic configs (the contextual-header A/B). Skip with EVAL_SEMANTIC=false.
  if (process.env.EVAL_SEMANTIC !== 'false') {
    configs.push(
      {
        label: 'semantic-header',
        recentLimit: SEMANTIC_RECENT_LIMIT,
        semantic: { topK: SEMANTIC_TOP_K, useContextHeader: true },
      },
      {
        label: 'semantic-noheader',
        recentLimit: SEMANTIC_RECENT_LIMIT,
        semantic: { topK: SEMANTIC_TOP_K, useContextHeader: false },
      },
    );
  }

  const evalSet = evalSetJson as EvalSet;
  const gateway = new OpenRouterGateway({ apiKey });
  const embeddings = new OpenRouterEmbeddingGateway({ apiKey });

  const { db, close } = await createTestDatabase();
  try {
    const deps: EvalDeps = {
      identity: new DrizzleIdentityStore(db),
      memory: new TranscriptMemoryStore(db),
      semantic: new DrizzleSemanticMemoryStore(db),
      gateway,
      embeddings,
      model,
      ingestionModel,
      embeddingModel,
    };
    const user = await deps.identity.ensureUserByEmail('eval@cobble.local');

    out(`Memory-vs-performance eval · model=${model} · ${evalSet.cases.length} cases`);
    out(
      'Config axes: transcript recency window (P0) and semantic retrieval over ingested\n' +
        'sources with the contextual-header A/B (P1, companionmemory.md §5).\n' +
        'Note: window-* configs cannot reach source-grounded cases (sources are only\n' +
        'ingested for semantic-* configs) — that unreachability IS the comparison.\n',
    );

    const reports: ConfigReport[] = [];
    for (const config of configs) {
      out(`Running ${config.label} (recentLimit=${config.recentLimit})…`);
      const results: CaseResult[] = [];
      for (const evalCase of evalSet.cases) {
        // A companion holds one lifelong transcript, so isolate each case behind
        // its own fresh companion rather than a separate conversation.
        const companion = await deps.identity.createCompanion(user.id, evalSet.companion);
        await seedTranscript(deps.memory, companion.id, evalCase.seedTranscript);
        if (config.semantic && evalCase.sources) {
          await ingestSources(deps, config, companion.id, evalCase);
        }
        const harness = makeHarness(deps, config);
        const answer = await answerQuestion(harness, companion, evalCase.question);
        results.push(await scoreCase(gateway, model, evalCase, answer));
      }
      reports.push(summarize(config.label, config.recentLimit, results));
    }

    out('\n=== Memory vs performance ===');
    out(renderComparison(reports));
    for (const report of reports) {
      out(renderCaseDetail(report));
    }
  } finally {
    await close();
  }
}

/** Build the harness for one config: recency-only (P0) or + semantic recall (P1). */
function makeHarness(deps: EvalDeps, config: MemoryConfig): Harness {
  return new Harness({
    gateway: deps.gateway,
    memory: deps.memory,
    model: deps.model,
    recentLimit: config.recentLimit,
    logger: silentLogger,
    ...(config.semantic
      ? {
          retrieveContext: createSemanticRetrieveContext({
            memory: deps.memory,
            semantic: deps.semantic,
            embeddings: deps.embeddings,
            embeddingModel: deps.embeddingModel,
            embeddingDimensions: EMBEDDING_DIMENSIONS,
            topK: config.semantic.topK,
            recentLimit: config.recentLimit,
            logger: silentLogger,
          }),
        }
      : {}),
  });
}

/** Feed the case's sources through the REAL ingestion pipeline (live models). */
async function ingestSources(
  deps: EvalDeps,
  config: MemoryConfig,
  companionId: string,
  evalCase: EvalCase,
): Promise<void> {
  const pipeline = new IngestionPipeline({
    semantic: deps.semantic,
    llm: deps.gateway,
    embeddings: deps.embeddings,
    ingestionModel: deps.ingestionModel,
    embeddingModel: deps.embeddingModel,
    embeddingDimensions: EMBEDDING_DIMENSIONS,
    useContextHeader: config.semantic?.useContextHeader ?? true,
    logger: silentLogger,
  });
  for (const source of evalCase.sources ?? []) {
    const record = await deps.semantic.createSource(companionId, {
      kind: 'note',
      title: source.title,
      rawText: '',
    });
    const job = await deps.semantic.createJob(companionId, record.id);
    await pipeline.run({
      companionId,
      sourceId: record.id,
      jobId: job.id,
      sourceTitle: source.title,
      payload: { kind: 'note', text: source.text },
    });
    // Check the specific job just run, not list ordering.
    const finished = (await deps.semantic.listJobs(companionId)).find((j) => j.id === job.id);
    if (finished?.status !== 'done') {
      throw new Error(`ingestion failed for case ${evalCase.id}: ${finished?.error ?? 'unknown'}`);
    }
  }
}

async function seedTranscript(
  memory: TranscriptMemoryStore,
  companionId: string,
  seedTranscript: EvalSet['cases'][number]['seedTranscript'],
): Promise<void> {
  for (const turn of seedTranscript) {
    await memory.appendMessage(companionId, turn.role, turn.content);
  }
}

async function answerQuestion(
  harness: Harness,
  companion: CompanionDto,
  question: string,
): Promise<string> {
  let answer = '';
  for await (const event of harness.runTurn({
    companion,
    userContent: question,
  })) {
    if (event.type === 'token') {
      answer += event.value;
    } else if (event.type === 'error') {
      throw new Error(`harness error: ${event.message}`);
    }
  }
  return answer;
}

function parseWindows(raw: string | undefined): number[] {
  if (!raw) return DEFAULT_WINDOWS;
  const parsed = raw
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);
  return parsed.length > 0 ? parsed : DEFAULT_WINDOWS;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
