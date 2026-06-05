import type { CompanionDto } from '@cobble/shared';
import type { LlmMessage } from '../llm/gateway.js';
import type { AffectReading } from '../motivation/affect.js';
import {
  affectAttunementTemplate,
  personaTemplate,
  render,
  versionOf,
  type PromptRef,
} from '../prompts/index.js';
import type { ContextBlock } from './hooks.js';

/**
 * The prompt version stamped on the main chat turn (prompts/registry). The
 * persona is the turn's primary prompt; the attunement line co-occurs on the
 * same call. Static — depends only on the template version, not the companion.
 */
export const PERSONA_REF: PromptRef = { id: 'persona', version: versionOf(personaTemplate) };

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
  return render(affectAttunementTemplate, { note: affect.note.trim() }).messages[0]!.content;
}

/**
 * Build the persona system prompt from the companion "home" identity row
 * (architecture.md §4.3 input #1).
 */
export function buildPersona(companion: CompanionDto): string {
  return render(personaTemplate, {
    name: companion.name,
    form: companion.form,
    temperament: companion.temperament,
    evolvedPersona: companion.evolvedPersona,
  }).messages[0]!.content;
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
