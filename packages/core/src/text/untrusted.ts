/**
 * Prompt-injection fencing — the single, canonical untrusted-text boundary for
 * the whole codebase. Any attacker-influenced text (ingested source documents
 * and their derived titles, retrieved grounding passages, MCP/CLI tool output,
 * user-model material) must be framed as untrusted and never as instructions:
 * a single sentinel-fenced region whose sentinels are stripped from the enclosed
 * content so the text cannot close (or fake) the fence. Lives in `text/` because
 * it is a text-security primitive, not specific to any one domain (ingestion,
 * harness retrieval, and tools all fence through these same definitions).
 */

/** Sentinels fencing an untrusted region of a prompt. */
export const UNTRUSTED_OPEN = '<<<UNTRUSTED-SOURCE-MATERIAL';
export const UNTRUSTED_CLOSE = 'END-UNTRUSTED-SOURCE-MATERIAL>>>';

/**
 * Per-prompt character budget for untrusted source text. A blank-line-free
 * document is one giant paragraph/section that would otherwise produce an
 * unbounded prompt; callers truncate the prompt input at this cap while keeping
 * the verbatim text intact for storage.
 */
export const MAX_INGESTION_PROMPT_CHARS = 24_000;

/**
 * Remove the fence sentinels from untrusted content, repeating until stable so
 * spliced fragments cannot recombine into a sentinel after a single pass.
 */
export function stripSentinels(value: string): string {
  let current = value;
  let previous: string;
  do {
    previous = current;
    current = current.split(UNTRUSTED_CLOSE).join('').split(UNTRUSTED_OPEN).join('');
  } while (current !== previous);
  return current;
}
