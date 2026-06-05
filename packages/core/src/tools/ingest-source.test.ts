/** The ingest_source effectful tool: register source+job → enqueue background read. */

import { describe, expect, it } from 'vitest';
import type { TurnCtx } from '../harness/hooks.js';
import type { Logger } from '../logging.js';
import type { IngestionRunParams } from '../ingestion/pipeline.js';
import { IngestionQueueFullError } from '../ingestion/runner.js';
import {
  createIngestSourceTool,
  type IngestionEnqueuePort,
  type SourceRegistrationPort,
} from './ingest-source.js';

const ctx: TurnCtx = { companionId: 'c1', ownerId: 'u1' };
const silentLogger: Logger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
};

/** Records created sources/jobs so the test can assert what was registered. */
function fakeStore(): SourceRegistrationPort & {
  sources: { companionId: string; title: string; origin: string }[];
} {
  const sources: { companionId: string; title: string; origin: string }[] = [];
  return {
    sources,
    async createSource(companionId, input) {
      sources.push({ companionId, title: input.title, origin: input.origin });
      return { id: `src-${sources.length}` };
    },
    async createJob() {
      return { id: 'job-1' };
    },
  };
}

/** Records enqueued runs; `full` forces the queue-full path. */
function fakeRunner(full = false): IngestionEnqueuePort & { enqueued: IngestionRunParams[] } {
  const enqueued: IngestionRunParams[] = [];
  return {
    enqueued,
    isFull: () => full,
    enqueue(params) {
      enqueued.push(params);
    },
  };
}

describe('createIngestSourceTool', () => {
  it('is an effectful tool (gated by propose→approve)', () => {
    expect(
      createIngestSourceTool({ semantic: fakeStore(), ingestion: fakeRunner() }).effectful,
    ).toBe(true);
  });

  it('creates a link source + job and enqueues the read, scoped to the turn', async () => {
    const semantic = fakeStore();
    const ingestion = fakeRunner();
    const tool = createIngestSourceTool({ semantic, ingestion });
    const result = await tool.run({ url: 'https://x.dev/post', title: 'A Post' }, ctx);

    expect(semantic.sources).toEqual([
      { companionId: 'c1', title: 'A Post', origin: 'https://x.dev/post' },
    ]);
    expect(ingestion.enqueued).toEqual([
      {
        companionId: 'c1',
        ownerId: 'u1',
        sourceId: 'src-1',
        jobId: 'job-1',
        sourceTitle: 'A Post',
        payload: { kind: 'link', url: 'https://x.dev/post' },
      },
    ]);
    expect(result.content).toContain('Started reading https://x.dev/post');
  });

  it('does not enqueue when the queue is full', async () => {
    const ingestion = fakeRunner(true);
    const tool = createIngestSourceTool({ semantic: fakeStore(), ingestion });
    const result = await tool.run({ url: 'https://x.dev/post' }, ctx);
    expect(ingestion.enqueued).toEqual([]);
    expect(result.content).toMatch(/busy reading/);
  });

  it('returns a store failure as text rather than throwing', async () => {
    const semantic: SourceRegistrationPort = {
      async createSource() {
        throw new IngestionQueueFullError();
      },
      async createJob() {
        return { id: 'job' };
      },
    };
    const tool = createIngestSourceTool({
      semantic,
      ingestion: fakeRunner(),
      logger: silentLogger,
    });
    const result = await tool.run({ url: 'https://x.dev/post' }, ctx);
    expect(result.content).toMatch(/busy reading/);
  });

  it('returns a generic store failure via the "Error remembering" branch (not busy)', async () => {
    const semantic: SourceRegistrationPort = {
      async createSource() {
        throw new Error('db write failed');
      },
      async createJob() {
        return { id: 'job' };
      },
    };
    const tool = createIngestSourceTool({
      semantic,
      ingestion: fakeRunner(),
      logger: silentLogger,
    });
    const result = await tool.run({ url: 'https://x.dev/post' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Error remembering https://x.dev/post');
    expect(result.content).toContain('db write failed');
    expect(result.content).not.toMatch(/busy reading/);
  });

  it('rejects a missing url as an error result', async () => {
    const tool = createIngestSourceTool({ semantic: fakeStore(), ingestion: fakeRunner() });
    expect((await tool.run({}, ctx)).content).toMatch(/valid "url"/);
  });
});
