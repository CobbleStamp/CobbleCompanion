/**
 * Rendering and version resolution for prompt templates (docs/guide-prompts.md).
 * `render` turns a template + typed input into a {@link RenderedPrompt} stamped
 * with its {@link PromptRef}, ready to spread into `LlmGateway.stream`. The
 * version (semver + content hash) is resolved once per template and cached,
 * so stamping every LLM call costs nothing on the hot path.
 */

import type { PromptTemplate, PromptVersion, RenderedPrompt } from './types.js';
import { contentHash } from './version.js';

// Keyed by template identity, not by id: two templates can legitimately share an
// id across versions (or in tests, since PromptId is a closed union), and each
// must resolve to its OWN content hash. An id-keyed cache would hand the first
// resolved template's version to every later one, masking reworded prompts.
const versionCache = new WeakMap<object, PromptVersion>();

/**
 * Resolve a template's version (semver + content hash of its sample render),
 * computing it once and caching by template identity for subsequent calls.
 */
export function versionOf<I>(template: PromptTemplate<I>): PromptVersion {
  const cached = versionCache.get(template);
  if (cached) {
    return cached;
  }
  const version: PromptVersion = {
    semver: template.semver,
    contentHash: contentHash(template.build(template.sample)),
  };
  versionCache.set(template, version);
  return version;
}

/** Render a template with its input into messages/tools stamped with the version. */
export function render<I>(template: PromptTemplate<I>, input: I): RenderedPrompt {
  const built = template.build(input);
  return {
    messages: built.messages,
    ...(built.tools ? { tools: built.tools } : {}),
    ref: { id: template.id, version: versionOf(template) },
  };
}
