import type { LlmGateway, LlmMessage, PromptRef } from '@cobble/core';

/** Drain a gateway stream into the full assistant text, stamping the prompt version. */
export async function collectText(
  gateway: LlmGateway,
  messages: readonly LlmMessage[],
  model: string,
  promptRef?: PromptRef,
): Promise<string> {
  let text = '';
  for await (const delta of gateway.stream({
    messages,
    model,
    ...(promptRef ? { promptRef } : {}),
  })) {
    text += delta;
  }
  return text;
}
