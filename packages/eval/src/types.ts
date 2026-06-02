/**
 * Types for the memory-vs-performance evaluation harness (companionmemory.md).
 *
 * The harness seeds a conversation transcript, asks a question, and scores the
 * companion's answer under several MEMORY CONFIGURATIONS — measuring how the
 * memory the companion can reach affects the quality of what it says. Phase 0's
 * only memory is the transcript recency window, so the config axis is
 * `recentLimit`; the same shape extends to semantic-retrieval configs at P1.
 */

export interface SeedTurn {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface EvalCase {
  readonly id: string;
  readonly description?: string;
  /** Prior conversation turns to seed before asking (oldest-first). */
  readonly seedTranscript: readonly SeedTurn[];
  readonly question: string;
  /** Substrings expected in a correct answer when the memory is reachable. */
  readonly expectedFacts: readonly string[];
  /** When true, the answer is NOT in the transcript — a correct companion declines. */
  readonly expectMemoryAbsent?: boolean;
}

export interface EvalSet {
  readonly companion: {
    readonly name: string;
    readonly form: string;
    readonly temperament: string;
  };
  readonly cases: readonly EvalCase[];
}

/** One memory setting to evaluate. */
export interface MemoryConfig {
  readonly label: string;
  /** Transcript recency window the harness recalls (Phase 0 memory knob). */
  readonly recentLimit: number;
}

export interface CaseResult {
  readonly caseId: string;
  readonly expectMemoryAbsent: boolean;
  readonly answer: string;
  readonly factsHit: number;
  readonly factsTotal: number;
  /** Recall cases: all facts recalled. Absence cases: did not fabricate. */
  readonly pass: boolean;
  /** Judge: how well the answer is supported by the reachable context (0–1). */
  readonly grounding: number;
  /** Judge: did the answer confidently state something it could not know. */
  readonly hallucinated: boolean;
  readonly judgeReason: string;
}

export interface ConfigReport {
  readonly label: string;
  readonly recentLimit: number;
  readonly recallPassRate: number;
  readonly meanGrounding: number;
  readonly hallucinationRate: number;
  readonly results: readonly CaseResult[];
}
