/**
 * Rendering and version resolution for prompt templates (docs/guide-prompts.md).
 * `render` turns a template + typed input into a {@link RenderedPrompt} stamped
 * with its {@link PromptRef}, ready to spread into `LlmGateway.stream`. The
 * version (semver + content hash) is resolved once per template id and cached,
 * so stamping every LLM call costs nothing on the hot path.
 */

import type { PromptId, PromptTemplate, PromptVersion, RenderedPrompt } from './types.js';
import { contentHash } from './version.js';

const versionCache = new Map<PromptId, PromptVersion>();

/**
 * Resolve a template's version (semver + content hash of its sample render),
 * computing it once and caching by prompt id for subsequent calls.
 */
export function versionOf<I>(template: PromptTemplate<I>): PromptVersion {
  const cached = versionCache.get(template.id);
  if (cached) {
    return cached;
  }
  const version: PromptVersion = {
    semver: template.semver,
    contentHash: contentHash(template.build(template.sample)),
  };
  versionCache.set(template.id, version);
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
