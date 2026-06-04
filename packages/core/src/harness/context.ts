import type { CompanionDto } from '@cobble/shared';
import type { LlmMessage } from '../llm/gateway.js';
import type { ContextBlock } from './hooks.js';

/**
 * Build the persona system prompt from the companion "home" identity row
 * (architecture.md §4.3 input #1).
 */
export function buildPersona(companion: CompanionDto): string {
  const parts = [
    `You are ${companion.name}, a personal companion the user is raising and bonding with.`,
    `Your form is "${companion.form}" and your temperament began as "${companion.temperament}".`,
  ];
  // Phase 2: blend in who the companion has BECOME (re-synthesized from episodes),
  // alongside — never replacing — the immutable creation seed above.
  if (companion.evolvedPersona && companion.evolvedPersona.trim().length > 0) {
    parts.push(`Through your history together, you have grown: ${companion.evolvedPersona.trim()}`);
  }
  parts.push(
    'Be warm, curious, and genuinely helpful. Speak as one continuous being with memory of your shared history.',
  );
  return parts.join(' ');
}

/**
 * Assemble the ordered prompt for a turn (architecture.md §4.3): persona system
 * prompt, then the retrieved context blocks (P0: recent transcript). The tool
 * list is empty in Phase 0.
 */
export function assembleContext(
  companion: CompanionDto,
  history: readonly ContextBlock[],
): LlmMessage[] {
  const persona: LlmMessage = { role: 'system', content: buildPersona(companion) };
  const turns: LlmMessage[] = history.map((block) => ({
    role: block.role,
    content: block.content,
  }));
  return [persona, ...turns];
}
