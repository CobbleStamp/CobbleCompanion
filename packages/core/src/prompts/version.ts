/**
 * Content hashing for prompt versioning (docs/guide-prompts.md). The hash is
 * taken over the *rendered output* of a template's fixed sample input — i.e.
 * what the model actually sees — not the source text, so reformatting the
 * catalog file (prettier, line wrapping) never churns the version, while any
 * change to the instruction wording or tool schema does. Stable and pure.
 */

import { createHash } from 'node:crypto';
import type { PromptBuild } from './types.js';

/** Length of the hex digest kept — enough to be collision-safe for a small catalog. */
const HASH_LENGTH = 16;

/**
 * Compute the canonical content hash of a built prompt: sha256 over a stable
 * JSON serialization of its messages (role + content) and advertised tools.
 */
export function contentHash(build: PromptBuild): string {
  const canonical = JSON.stringify({
    messages: build.messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    tools: (build.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, HASH_LENGTH);
}
