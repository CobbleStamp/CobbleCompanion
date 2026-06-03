/**
 * Prompt-injection fencing for the ingestion passes (Pass 1 segmentation, Pass 2
 * enrichment). Source documents are attacker-influenced data, so their verbatim
 * text — and the titles derived from them — must be framed as untrusted and
 * never as instructions. This mirrors the chat-path convention established for
 * grounding blocks (see harness/semantic-retrieve.ts): a single sentinel-fenced
 * region whose sentinels are stripped from the enclosed content so ingested
 * text cannot close (or fake) the fence.
 */

/** Sentinels fencing the untrusted region of an ingestion prompt. */
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
