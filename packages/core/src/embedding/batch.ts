/**
 * Batched embedding — the shared "embed many texts in fixed-size round trips,
 * metering each batch, and pair every item with its vector" loop. Lives here so
 * the ingestion pipeline (section vectors) and episodic consolidation (summary
 * vectors) share one implementation and one batch-size constant instead of
 * re-deriving the slice/embed/account/zip dance each time. Each caller decides
 * what to do with the (item, vector) pairs — persist them, or fold them into
 * new records.
 */

import type { UsageSink } from '../usage.js';
import type { EmbeddingGateway } from './gateway.js';

/** Default texts per embedding round trip. */
export const EMBED_BATCH_SIZE = 32;

export interface EmbeddedItem<T> {
  readonly item: T;
  /** The item's vector, in order; undefined if the provider returned fewer. */
  readonly vector: readonly number[] | undefined;
}

/**
 * Embed each item's text in batches of `batchSize`, depositing every batch's
 * usage into `sink`, and return each item paired with its vector (input order
 * preserved). Provider failures propagate — callers that must degrade (rather
 * than fail the run) wrap the call.
 */
export async function embedInBatches<T>(
  embeddings: EmbeddingGateway,
  items: readonly T[],
  toText: (item: T) => string,
  opts: {
    readonly model: string;
    readonly dimensions: number;
    readonly sink: UsageSink;
    readonly batchSize?: number;
  },
): Promise<ReadonlyArray<EmbeddedItem<T>>> {
  const batchSize = opts.batchSize ?? EMBED_BATCH_SIZE;
  const pairs: EmbeddedItem<T>[] = [];
  for (let offset = 0; offset < items.length; offset += batchSize) {
    const batch = items.slice(offset, offset + batchSize);
    const { vectors, usage } = await embeddings.embed({
      input: batch.map(toText),
      model: opts.model,
      dimensions: opts.dimensions,
    });
    opts.sink.add(usage);
    batch.forEach((item, i) => pairs.push({ item, vector: vectors[i] }));
  }
  return pairs;
}
