/**
 * Embedding-input construction (architecture.md ingestion flow). The STORED
 * section text is always pure verbatim source; only the EMBEDDING INPUT may be
 * prefixed with the Pass-2 context header, which injects the entities that
 * unresolved references hide from the encoder (contextual retrieval). The
 * `useHeader` knob is the eval A/B switch. Pure computation — the pipeline
 * owns the gateway call.
 */

/** Build the text an embedding is computed from, optionally header-prefixed. */
export function buildEmbeddingInput(
  section: { readonly originalText: string; readonly contextHeader: string | null },
  useHeader: boolean,
): string {
  if (useHeader && section.contextHeader) {
    return `${section.contextHeader}\n${section.originalText}`;
  }
  return section.originalText;
}
