/**
 * Types for the memory-vs-performance evaluation harness (companionmemory.md).
 *
 * The harness seeds a conversation transcript (and, for Phase 1 cases, ingests
 * sources), asks a question, and scores the companion's answer under several
 * MEMORY CONFIGURATIONS — measuring how the memory the companion can reach
 * affects the quality of what it says. Config axes: the transcript recency
 * window (`recentLimit`, Phase 0) and semantic retrieval over ingested sources
 * (`semantic`, Phase 1 — including the contextual-header A/B knob).
 */

export interface SeedTurn {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

/** A source ingested before asking (Phase 1 grounded-recall cases). */
export interface SeedSource {
  readonly title: string;
  readonly text: string;
}

export interface EvalCase {
  readonly id: string;
  readonly description?: string;
  /** Prior conversation turns to seed before asking (oldest-first). */
  readonly seedTranscript: readonly SeedTurn[];
  /** Sources fed through the real ingestion pipeline before asking (P1). */
  readonly sources?: readonly SeedSource[];
  readonly question: string;
  /** Substrings expected in a correct answer when the memory is reachable. */
  readonly expectedFacts: readonly string[];
  /** When true, the answer is NOT in reachable memory — a correct companion declines. */
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
  /** Semantic retrieval over ingested sources (Phase 1 memory knob). */
  readonly semantic?: {
    readonly topK: number;
    /** A/B: prefix the Pass-2 context header onto embedding inputs. */
    readonly useContextHeader: boolean;
  };
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
