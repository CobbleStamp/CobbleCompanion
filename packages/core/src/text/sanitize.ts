/**
 * Text sanitization for the persistence boundary. PDF/pdf.js extraction (and,
 * rarely, other parsers) can surface control characters — most importantly the
 * NUL byte (U+0000), which a Postgres `text` column rejects outright with
 * `invalid byte sequence for encoding "UTF8": 0x00`. These helpers strip such
 * characters so untrusted source text is safe to store and clean to embed.
 *
 * Implemented over char codes (not regex literals) so no control characters
 * appear in this source file.
 */

/** The NUL code point — the one byte a Postgres `text` column cannot store. */
const NUL_CODE = 0x00;

/**
 * Is this code point a control character we strip? Covers the C0 range
 * (U+0000–U+001F) and the C1 range (U+007F–U+009F), but NOT the whitespace
 * controls tab (U+0009), newline (U+000A), and carriage return (U+000D), which
 * downstream paragraph splitting normalizes on its own.
 */
function isStrippableControl(code: number): boolean {
  if (code === 0x09 || code === 0x0a || code === 0x0d) {
    return false;
  }
  return (code >= 0x00 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f);
}

/**
 * Remove control characters that are invalid in Postgres UTF-8 text (NUL) or
 * are noise to an encoder, while leaving the whitespace controls (\t \n \r) for
 * downstream whitespace normalization. Use at the parser boundary so every
 * `ParsedDocument` is clean regardless of source kind.
 */
export function sanitizeText(text: string): string {
  let hasControl = false;
  for (let i = 0; i < text.length; i++) {
    if (isStrippableControl(text.charCodeAt(i))) {
      hasControl = true;
      break;
    }
  }
  if (!hasControl) {
    return text;
  }
  let result = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (!isStrippableControl(code)) {
      result += text[i];
    }
  }
  return result;
}

/**
 * Strip only NUL — the one byte a Postgres `text` column cannot store. Used as
 * the last-line guard in the persistence layer so a future parser/LLM
 * regression can never reintroduce the `0x00` write error.
 */
export function stripNul(text: string): string {
  if (!text.includes(String.fromCharCode(NUL_CODE))) {
    return text;
  }
  let result = '';
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) !== NUL_CODE) {
      result += text[i];
    }
  }
  return result;
}
