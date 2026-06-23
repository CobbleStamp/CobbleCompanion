/** The ingest_source effectful tool: register source+job → stage link → enqueue read. */

import { describe, expect, it } from 'vitest';
import type { TurnCtx } from '../harness/hooks.js';
import type { Logger } from '../logging.js';
import {
  createIngestSourceTool,
  type IngestEnqueuePort,
  type SourceRegistrationPort,
  type UploadStagingPort,
} from './ingest-source.js';
import type { IngestRequest } from '../jobs/job-processor.js';

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

/** Records staged uploads, handing back a stable id. */
function fakeStaging(): UploadStagingPort & {
  staged: { ownerId: string; kind: string; bytes: Uint8Array }[];
} {
  const staged: { ownerId: string; kind: string; bytes: Uint8Array }[] = [];
  return {
    staged,
    async stage(params) {
      staged.push(params);
      return { id: `up-${staged.length}` };
    },
  };
}

/** Records ingest requests; `full` forces the backpressure path. */
function fakeIngest(full = false): IngestEnqueuePort & { requests: IngestRequest[] } {
  const requests: IngestRequest[] = [];
  return {
    requests,
    isFull: async () => full,
    request(params) {
      requests.push(params);
    },
  };
}

describe('createIngestSourceTool', () => {
  it('is an effectful tool (gated by propose→approve)', () => {
    expect(
      createIngestSourceTool({
        semantic: fakeStore(),
        ingest: fakeIngest(),
        staging: fakeStaging(),
      }).effectful,
    ).toBe(true);
  });

  it('creates a link source + job, stages the link, and enqueues the read', async () => {
    const semantic = fakeStore();
    const ingest = fakeIngest();
    const staging = fakeStaging();
    const tool = createIngestSourceTool({ semantic, ingest, staging });
    const result = await tool.run({ url: 'https://x.dev/post', title: 'A Post' }, ctx);

    expect(semantic.sources).toEqual([
      { companionId: 'c1', title: 'A Post', origin: 'https://x.dev/post' },
    ]);
    expect(staging.staged).toEqual([
      { ownerId: 'u1', kind: 'link', bytes: new TextEncoder().encode('https://x.dev/post') },
    ]);
    expect(ingest.requests).toEqual([
      { companionId: 'c1', sourceId: 'src-1', jobId: 'job-1', uploadId: 'up-1' },
    ]);
    expect(result.content).toContain('Started reading https://x.dev/post');
  });

  it('does not enqueue when the ingest queue is full', async () => {
    const ingest = fakeIngest(true);
    const staging = fakeStaging();
    const tool = createIngestSourceTool({ semantic: fakeStore(), ingest, staging });
    const result = await tool.run({ url: 'https://x.dev/post' }, ctx);
    expect(ingest.requests).toEqual([]);
    expect(staging.staged).toEqual([]);
    expect(result.content).toMatch(/busy reading/);
  });

  it('returns a store failure as text via the "Error remembering" branch', async () => {
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
      ingest: fakeIngest(),
      staging: fakeStaging(),
      logger: silentLogger,
    });
    const result = await tool.run({ url: 'https://x.dev/post' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Error remembering https://x.dev/post');
    expect(result.content).toContain('db write failed');
  });

  it('rejects a missing url as an error result', async () => {
    const tool = createIngestSourceTool({
      semantic: fakeStore(),
      ingest: fakeIngest(),
      staging: fakeStaging(),
    });
    expect((await tool.run({}, ctx)).content).toMatch(/valid "url"/);
  });
});
