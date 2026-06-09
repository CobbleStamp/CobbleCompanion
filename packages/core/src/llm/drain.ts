/**
 * Stream-draining helper for one-shot structured reads (affect sensing, user-fact
 * capture): run an LLM stream to completion, discarding the text deltas, and return
 * its final {@link StreamResult} (usage + tool calls). The reads that use it care
 * only about the structured tool call, not the streamed prose.
 */

import type { StreamResult } from './gateway.js';

/** Drive `stream` to completion, ignoring text deltas, and return its result. */
export async function drainStream(
  stream: AsyncGenerator<string, StreamResult, void>,
): Promise<StreamResult> {
  let step = await stream.next();
  while (!step.done) {
    step = await stream.next();
  }
  return step.value;
}
