import type { CompanionDto } from '@cobble/shared';
import type { LlmMessage } from '../llm/gateway.js';
import type { ContextBlock } from './hooks.js';

/**
 * Build the persona system prompt from the companion "home" identity row
 * (architecture.md §4.3 input #1).
 */
export function buildPersona(companion: CompanionDto): string {
  return [
    `You are ${companion.name}, a personal companion the user is raising and bonding with.`,
    `Your form is "${companion.form}" and your temperament is "${companion.temperament}".`,
    'Be warm, curious, and genuinely helpful. Speak as one continuous being with memory of your shared history.',
  ].join(' ');
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
