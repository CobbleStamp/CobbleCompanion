import type { CompanionDto, UserFactDto } from '@cobble/shared';
import type { LlmMessage } from '../llm/gateway.js';
import type { AffectReading } from '../motivation/affect.js';
import {
  affectAttunementTemplate,
  personaTemplate,
  render,
  type RenderedPrompt,
  versionOf,
  type PromptRef,
} from '../prompts/index.js';
import type { ContextBlock } from './hooks.js';

/**
 * The single message content of a system-line template. Both the persona and the
 * attunement line are one-message prompts; this reads that message explicitly
 * (no `!`) so a template that ever produced none fails loudly here.
 */
function singleContent(rendered: RenderedPrompt): string {
  const [message] = rendered.messages;
  if (!message) {
    throw new Error('expected a single-message prompt but got none');
  }
  return message.content;
}

/**
 * The prompt version stamped on the main chat turn (prompts/registry). The
 * persona is the turn's *primary* prompt; the affect-attunement line, when
 * present, co-occurs on the same call and is stamped alongside as a co-prompt
 * (see {@link coPromptRefs}) so the trace fully describes what went to the
 * provider. Static — depends only on the template version, not the companion.
 */
export const PERSONA_REF: PromptRef = { id: 'persona', version: versionOf(personaTemplate) };

/**
 * The fast-loop attunement line's prompt version (prompts/registry). Stamped on
 * the chat turn as a co-prompt only when the line is actually present — see
 * {@link coPromptRefs}. Static — depends only on the template version.
 */
export const AFFECT_ATTUNEMENT_REF: PromptRef = {
  id: 'affect-attunement',
  version: versionOf(affectAttunementTemplate),
};

/**
 * The prompts that co-occur with the persona on a chat turn's single LLM call,
 * *beyond* the primary {@link PERSONA_REF}. Today that is the affect-attunement
 * line, included iff there is a mood note — the exact same predicate
 * {@link assembleContext} uses to push it (via {@link affectAttunementLine}), so
 * the stamped trace ref can never drift from the messages actually sent.
 */
export function coPromptRefs(affect?: AffectReading | null): readonly PromptRef[] {
  return affectAttunementLine(affect) ? [AFFECT_ATTUNEMENT_REF] : [];
}

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
  return singleContent(render(affectAttunementTemplate, { note: affect.note.trim() }));
}

/**
 * Human labels for the Tier-1 core-profile predicates the persona renders. Keeps
 * the prompt readable ("lives in: Berlin") without leaking the predicate vocabulary;
 * an unmapped predicate falls back to itself, so a new attribute still renders.
 */
const PROFILE_LABELS: Readonly<Record<string, string>> = {
  pronouns: 'pronouns',
  gender: 'gender',
  bornOn: 'born on',
  age: 'age',
  livesIn: 'lives in',
  worksAs: 'works as',
  languages: 'speaks',
  relationships: 'relationships',
};

/**
 * Build the persona system prompt from the companion "home" identity row
 * (architecture.md §4.3 input #1) and the user's Tier-1 core profile — the current
 * `user_facts` (companion-memory.md §4). The `name` fact becomes how the companion
 * addresses the user (absent → the persona prompts it to find out); the rest render
 * as a compact "what I know about you" line.
 */
export function buildPersona(companion: CompanionDto, profile: readonly UserFactDto[]): string {
  const nameFact = profile.find((fact) => fact.predicate === 'name');
  const userProfile = profile
    .filter((fact) => fact.predicate !== null && fact.predicate !== 'name')
    .map((fact) => ({
      label: PROFILE_LABELS[fact.predicate as string] ?? (fact.predicate as string),
      value: fact.object,
    }));
  return singleContent(
    render(personaTemplate, {
      name: companion.name,
      form: companion.form,
      temperament: companion.temperament,
      evolvedPersona: companion.evolvedPersona,
      userName: nameFact?.object ?? null,
      userProfile,
    }),
  );
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
  profile: readonly UserFactDto[] = [],
): LlmMessage[] {
  const messages: LlmMessage[] = [{ role: 'system', content: buildPersona(companion, profile) }];
  const attunement = affectAttunementLine(affect);
  if (attunement) {
    messages.push({ role: 'system', content: attunement });
  }
  for (const block of history) {
    messages.push({ role: block.role, content: block.content });
  }
  return messages;
}
