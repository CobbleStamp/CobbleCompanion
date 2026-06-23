/** Deferred-ingestion catch-up: request a resume only for fed (under-cap) companions. */

import { describe, expect, it } from 'vitest';
import type { Logger } from '../logging.js';
import type { IngestRequest } from '../jobs/job-processor.js';
import type { DeferredJob } from '../memory/semantic-store.js';
import type { ParsedDocument } from './parser.js';
import { sweepIngestion } from './ingest-sweep.js';

const silentLogger: Logger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
};

const parsedDoc: ParsedDocument = { rawText: 'x', paragraphs: [{ ord: 1, text: 'x' }] };

function deferred(jobId: string, companionId: string): DeferredJob {
  return { jobId, companionId, ownerId: 'u1', sourceId: `s-${jobId}`, sourceTitle: 't', parsedDoc };
}

describe('sweepIngestion', () => {
  it('requests a resume for fed companions and skips empty-wallet ones', async () => {
    const requests: IngestRequest[] = [];
    const empty = new Set(['c-empty']);
    const requested = await sweepIngestion({
      semantic: {
        listDeferredJobs: async () => [
          deferred('j1', 'c-fed'),
          deferred('j2', 'c-empty'),
          deferred('j3', 'c-fed2'),
        ],
      },
      quota: { isEmpty: async (companionId: string) => empty.has(companionId) } as never,
      ingest: {
        request: (params) => requests.push(params),
        isFull: async () => false,
        whenIdle: async () => undefined,
      },
      logger: silentLogger,
    });

    expect(requested).toBe(2);
    expect(requests.map((r) => r.companionId)).toEqual(['c-fed', 'c-fed2']);
    expect(requests[0]).toEqual({ companionId: 'c-fed', sourceId: 's-j1', jobId: 'j1' });
  });

  it('continues past a request that throws, logging it', async () => {
    let calls = 0;
    const requested = await sweepIngestion({
      semantic: {
        listDeferredJobs: async () => [deferred('j1', 'c1'), deferred('j2', 'c2')],
      },
      quota: { isEmpty: async () => false } as never,
      ingest: {
        request: () => {
          calls += 1;
          if (calls === 1) {
            throw new Error('boom');
          }
        },
        isFull: async () => false,
        whenIdle: async () => undefined,
      },
      logger: silentLogger,
    });
    // The first throws and is swallowed; the second still goes through.
    expect(requested).toBe(1);
  });
});
