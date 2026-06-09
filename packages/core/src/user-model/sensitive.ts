/**
 * Sensitive-attribute write-gate (docs/companion-memory.md §4, Phase 13).
 *
 * Some matters are protected: a companion should never hold a *shaky guess* about a
 * user's health, religion, sexuality, ethnicity, politics, gender, or age. So a
 * low-confidence INFERENCE about a sensitive matter is gated at write (never persisted);
 * an EXPLICIT user statement (high confidence) always passes and is flagged for scrutiny.
 *
 * Detection is a conservative heuristic — a curated lexicon matched on word boundaries,
 * plus the age-bearing `bornOn` predicate — a deliberate starting point, like the recall
 * relevance floor: it is tuned against the evals as the model grows, not hand-perfected.
 * Erring matters little either way: a false positive only flags an explicit fact (or drops
 * a low-confidence non-sensitive one); the gate never blocks an explicit statement.
 */

/** The protected matters, for documentation and the browser badge (closed set). */
export const SENSITIVE_MATTERS: readonly string[] = [
  'health',
  'religion',
  'sexuality',
  'ethnicity',
  'political',
  'gender',
  'age',
] as const;

/** Confidence an inference about a sensitive matter must clear to be persisted at all. */
export const SENSITIVE_WRITE_CONFIDENCE = 0.7;

/** Predicates whose very subject is a protected attribute, independent of the object text. */
const SENSITIVE_PREDICATES: ReadonlySet<string> = new Set(['bornOn', 'gender']);

/** Curated, word-boundary-matched terms per protected matter (ambiguous color/role words omitted). */
const SENSITIVE_TERMS: readonly string[] = [
  // health
  'depression',
  'anxiety',
  'diabetes',
  'cancer',
  'adhd',
  'autism',
  'autistic',
  'bipolar',
  'disorder',
  'disability',
  'disabled',
  'chronic',
  'illness',
  'disease',
  'diagnosis',
  'diagnosed',
  'medication',
  'antidepressant',
  'therapy',
  'pregnant',
  'pregnancy',
  'hiv',
  // religion
  'muslim',
  'islam',
  'islamic',
  'christian',
  'christianity',
  'jewish',
  'judaism',
  'hindu',
  'buddhist',
  'buddhism',
  'catholic',
  'protestant',
  'atheist',
  'agnostic',
  'religion',
  'religious',
  // sexuality
  'gay',
  'lesbian',
  'bisexual',
  'asexual',
  'queer',
  'homosexual',
  'heterosexual',
  'lgbtq',
  // ethnicity (specific terms only — avoid ambiguous color words)
  'ethnicity',
  'immigrant',
  'refugee',
  // political
  'republican',
  'democrat',
  'conservative',
  'liberal',
  'socialist',
  'communist',
  'libertarian',
  // gender
  'transgender',
  'nonbinary',
  'genderqueer',
  'intersex',
];

/** A single word-boundary regex over the lexicon (case-insensitive). */
const SENSITIVE_PATTERN = new RegExp(`\\b(${SENSITIVE_TERMS.join('|')})\\b`, 'i');

/** Whether a fact concerns a protected matter (heuristic — see the module note). */
export function isSensitiveMatter(predicate: string | null, object: string): boolean {
  if (predicate !== null && SENSITIVE_PREDICATES.has(predicate)) {
    return true;
  }
  return SENSITIVE_PATTERN.test(`${predicate ?? ''} ${object}`);
}

/**
 * Whether a candidate fact must be GATED OUT (not persisted): it concerns a sensitive
 * matter and is below the confidence bar — i.e. a shaky inference, not an explicit
 * statement. A null/absent confidence is treated as authoritative (explicit), so it passes.
 */
export function isGatedSensitive(
  predicate: string | null,
  object: string,
  confidence: number | null | undefined,
): boolean {
  return isSensitiveMatter(predicate, object) && (confidence ?? 1) < SENSITIVE_WRITE_CONFIDENCE;
}
