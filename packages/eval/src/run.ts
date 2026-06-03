import { createTestDatabase } from '@cobble/db/testing';
import {
  DrizzleIdentityStore,
  Harness,
  type Logger,
  OpenRouterGateway,
  TranscriptMemoryStore,
} from '@cobble/core';
import type { CompanionDto } from '@cobble/shared';
import evalSetJson from './fixtures/recall.json' with { type: 'json' };
import { renderCaseDetail, renderComparison, summarize } from './report.js';
import { scoreCase } from './score.js';
import type { CaseResult, ConfigReport, EvalSet, MemoryConfig } from './types.js';

const DEFAULT_WINDOWS = [2, 12, 200];

/** Eval output is the product here; write directly to stdout. */
function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

const silentLogger: Logger = { error: () => {}, info: () => {} };

async function main(): Promise<void> {
  const apiKey = process.env.OPENROUTER_API_KEY ?? '';
  if (apiKey.length === 0) {
    throw new Error(
      'OPENROUTER_API_KEY is required — this is a LIVE eval against OpenRouter (companionmemory.md).',
    );
  }
  const model = process.env.LLM_MODEL ?? 'anthropic/claude-3.5-sonnet';
  const configs = parseWindows(process.env.EVAL_WINDOWS).map(
    (recentLimit): MemoryConfig => ({ label: `window-${recentLimit}`, recentLimit }),
  );

  const evalSet = evalSetJson as EvalSet;
  const gateway = new OpenRouterGateway({ apiKey });

  const { db, close } = await createTestDatabase();
  try {
    const identity = new DrizzleIdentityStore(db);
    const memory = new TranscriptMemoryStore(db);
    const user = await identity.ensureUserByEmail('eval@cobble.local');

    out(`Memory-vs-performance eval · model=${model} · ${evalSet.cases.length} cases`);
    out(
      'Phase 0 note: the only memory is the transcript recency window, so the config axis is\n' +
        'recentLimit. The same harness extends to semantic-retrieval configs at Phase 1.\n',
    );

    const reports: ConfigReport[] = [];
    for (const config of configs) {
      out(`Running ${config.label} (recentLimit=${config.recentLimit})…`);
      const results: CaseResult[] = [];
      for (const evalCase of evalSet.cases) {
        // A companion holds one lifelong transcript, so isolate each case behind
        // its own fresh companion rather than a separate conversation.
        const companion = await identity.createCompanion(user.id, evalSet.companion);
        await seedTranscript(memory, companion.id, evalCase.seedTranscript);
        const harness = new Harness({
          gateway,
          memory,
          model,
          recentLimit: config.recentLimit,
          logger: silentLogger,
        });
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
