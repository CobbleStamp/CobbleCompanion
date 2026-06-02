import type { LlmGateway, LlmMessage } from '@cobble/core';

/** Drain a gateway stream into the full assistant text. */
export async function collectText(
  gateway: LlmGateway,
  messages: readonly LlmMessage[],
  model: string,
): Promise<string> {
  let text = '';
  for await (const delta of gateway.stream({ messages, model })) {
    text += delta;
  }
  return text;
}
