/**
 * Public surface of the prompt registry (docs/guide-prompts.md): the rendering
 * primitives, the registry enumeration, and every catalog template. Call sites
 * import their concrete template from here; tests import the registry helpers.
 */

export type {
  PromptBuild,
  PromptId,
  PromptRef,
  PromptTemplate,
  PromptVersion,
  RenderedPrompt,
} from './types.js';
export { render, versionOf } from './render.js';
export { contentHash } from './version.js';
export { getPromptEntry, listPrompts, type PromptEntry } from './registry.js';

export { personaTemplate, type PersonaInput } from './catalog/persona.js';
export {
  affectAttunementTemplate,
  type AffectAttunementInput,
} from './catalog/affect-attunement.js';
export { personaEvolveTemplate, type PersonaEvolveInput } from './catalog/persona-evolve.js';
export { consolidationTemplate, type ConsolidationInput } from './catalog/consolidation.js';
export {
  ingestionAnnounceTemplate,
  type IngestionAnnounceInput,
} from './catalog/ingestion-announce.js';
export { segmenterTemplate, type SegmenterInput } from './catalog/segmenter.js';
export { enricherTemplate, type EnricherInput } from './catalog/enricher.js';
export {
  affectSenseTemplate,
  type AffectSenseInput,
  REPORT_AFFECT,
  REPORT_AFFECT_TOOL,
} from './catalog/affect-sense.js';
export {
  reactionSenseTemplate,
  type ReactionSenseInput,
  REPORT_REACTION,
  REPORT_REACTION_TOOL,
} from './catalog/reaction-sense.js';
export {
  autonomousNoteTemplate,
  type AutonomousNoteInput,
  type ReadSourceDigest,
} from './catalog/autonomous-note.js';
export { greetingTemplate, type GreetingInput } from './catalog/greeting.js';
export { judgeTemplate, type JudgeInput } from './catalog/judge.js';
export {
  toolSearchTemplate,
  type ToolSearchInput,
  type ToolSearchCatalogItem,
  SELECT_TOOLS,
  SELECT_TOOLS_TOOL,
} from './catalog/tool-search.js';
export {
  userExtractTemplate,
  type UserExtractInput,
  REPORT_USER_FACTS,
  REPORT_USER_FACTS_TOOL,
} from './catalog/user-extract.js';
export {
  userBeliefsReflectTemplate,
  type UserBeliefsReflectInput,
  REPORT_USER_BELIEFS,
  REPORT_USER_BELIEFS_TOOL,
  userBeliefsReconcileTemplate,
  type UserBeliefsReconcileInput,
  REPORT_RECONCILIATION,
  REPORT_RECONCILIATION_TOOL,
} from './catalog/user-beliefs.js';
export { userPersonaTemplate, type UserPersonaInput } from './catalog/user-persona.js';
