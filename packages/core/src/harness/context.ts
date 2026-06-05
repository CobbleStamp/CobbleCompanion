import type { CompanionDto } from '@cobble/shared';
import type { LlmMessage } from '../llm/gateway.js';
import type { AffectReading } from '../motivation/affect.js';
import type { ContextBlock } from './hooks.js';

/**
 * The fast-loop attunement line (Phase 4.2, companion-motivation.md §7): the
 * companion's rolling read of the user's mood, fed *forward* so the next reply
 * adjusts tone, warmth, and detail to where the user is. Returns null when there
 * is no meaningful read yet (no note) so a neutral/empty mood adds nothing to the
 * prompt. The valence number is deliberately NOT surfaced — only the human note.
 */
export function affectAttunementLine(affect: AffectReading | null | undefined): string | null {
  if (!affect || affect.note.trim().length === 0) {
    return null;
  }
  return (
    `The user has recently seemed: ${affect.note.trim()}. ` +
    'Attune your tone, warmth, and level of detail to this. ' +
    'Do not mention that you are tracking their mood.'
  );
}

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
 * prompt, an optional affect-attunement system line (Phase 4.2), then the
 * retrieved context blocks (P0: recent transcript). The tool list is empty in
 * Phase 0.
 */
export function assembleContext(
  companion: CompanionDto,
  history: readonly ContextBlock[],
  affect?: AffectReading | null,
): LlmMessage[] {
  const messages: LlmMessage[] = [{ role: 'system', content: buildPersona(companion) }];
  const attunement = affectAttunementLine(affect);
  if (attunement) {
    messages.push({ role: 'system', content: attunement });
  }
  for (const block of history) {
    messages.push({ role: block.role, content: block.content });
  }
  return messages;
}
