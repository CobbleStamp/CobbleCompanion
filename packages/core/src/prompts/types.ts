/**
 * Core types for the code-as-truth prompt registry (docs/guide-prompts.md). A
 * prompt is a versioned, in-repo artifact: a pure `build(input)` that produces
 * the message(s) sent to the model, identified by a stable {@link PromptId} and
 * stamped with a {@link PromptVersion} (author semver + computed content hash).
 * The catalog files under ./catalog are the single source of truth for prompt
 * wording; call sites render from them instead of inlining strings.
 *
 * `LlmMessage`/`ToolDef` are imported type-only, so the mutual reference with
 * the gateway (which carries an optional {@link PromptRef}) erases at runtime.
 */

import type { LlmMessage, ToolDef } from '../llm/gateway.js';

/** Stable identity of a prompt in the registry — constant across versions. */
export type PromptId =
  | 'persona'
  | 'affect-attunement'
  | 'persona-evolve'
  | 'consolidation'
  | 'ingestion-announce'
  | 'segmenter'
  | 'enricher'
  | 'affect-sense'
  | 'autonomous-note'
  | 'judge'
  | 'tool-search'
  | 'user-extract'
  | 'user-beliefs-reflect'
  | 'user-beliefs-reconcile'
  | 'user-persona';

/**
 * A prompt's version: the author-declared `semver` (the human change-intent and
 * the A/B reference for eval) plus the computed `contentHash` (proves the exact
 * wording that ran, so a reworded prompt that forgot a semver bump is caught).
 */
export interface PromptVersion {
  readonly semver: string;
  readonly contentHash: string;
}

/**
 * What a template's `build` produces: the ordered messages to send, plus any
 * tool it advertises (e.g. the affect-sense `report_affect` tool). Covers all
 * three observed prompt shapes — system-only, system+user, and tool-carrying.
 */
export interface PromptBuild {
  readonly messages: readonly LlmMessage[];
  readonly tools?: readonly ToolDef[];
}

/**
 * A versioned prompt artifact. `build` MUST be a pure function of its typed
 * input (no I/O, no clock, no randomness) so the content hash is reproducible.
 * `sample` is a representative input used to compute that hash and reused by
 * tests; it must exercise the template's literal branches to be meaningful.
 */
export interface PromptTemplate<I> {
  readonly id: PromptId;
  readonly semver: string;
  /** Single-responsibility statement (the docstring gate, AGENTS.md §Iron Laws). */
  readonly description: string;
  readonly sample: I;
  readonly build: (input: I) => PromptBuild;
}

/** The stamp carried into the gateway/trace: which prompt+version produced a call. */
export interface PromptRef {
  readonly id: PromptId;
  readonly version: PromptVersion;
}

/** A rendered prompt ready to stream, stamped with the version that produced it. */
export interface RenderedPrompt {
  readonly messages: readonly LlmMessage[];
  readonly tools?: readonly ToolDef[];
  readonly ref: PromptRef;
}
