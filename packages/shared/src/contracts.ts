import { z } from 'zod';

/**
 * Surface ↔ core contracts. These types and schemas are the *only* thing that
 * crosses the surface/core boundary (architecture.md invariant #1). Every request
 * body is validated here before it reaches the core (security.md "validate at
 * boundaries").
 */

/** Role of a transcript message — the episodic-memory substrate (implementation.md §1). */
export const messageRoleSchema = z.enum(['user', 'assistant', 'system']);
export type MessageRole = z.infer<typeof messageRoleSchema>;

// --- Entities (mirror the persisted rows, minus tenancy internals) ---

export interface CompanionDto {
  readonly id: string;
  readonly name: string;
  readonly form: string;
  /** The immutable creation seed; personality EVOLUTION is additive (below). */
  readonly temperament: string;
  /**
   * Phase 2 — "who I've become with you": a short description re-synthesized from
   * accumulated episodes, blended into the persona prompt alongside the seed and
   * shown on the identity card. Null until the first evolution pass runs.
   */
  readonly evolvedPersona: string | null;
  readonly createdAt: string;
}

export interface MessageDto {
  readonly id: string;
  readonly companionId: string;
  readonly role: MessageRole;
  readonly content: string;
  /**
   * The source this turn is about, when it was written by an upload (the
   * attachment chip and its acknowledgement). Null for ordinary typed turns.
   * Lets the chat surface reconstruct the 📎 chip and "View status →" link on
   * reload rather than losing them with the page (architecture.md §4.7).
   */
  readonly sourceId: string | null;
  readonly createdAt: string;
}

/**
 * The acknowledgement the companion posts the moment a file is attached, before
 * it has read it. Single-sourced here so the optimistic client line and the
 * persisted transcript turn are byte-for-byte identical (no drift across reload).
 */
export function fileSourceAcknowledgement(filename: string): string {
  return `Got it — I'm reading through "${filename}" now. I'll be able to reference it once I've finished.`;
}

/**
 * Canned proactive notes used when an in-character LLM note can't be generated
 * (owner over their daily token cap, generation failed, or persona unavailable).
 * The companion always tells the user how a read ended — it never goes silent.
 */
export function ingestionDoneFallback(sourceTitle: string): string {
  return `By the way — I've finished reading "${sourceTitle}". Ask me anything about it.`;
}

export function ingestionFailedFallback(sourceTitle: string): string {
  return `I ran into trouble reading "${sourceTitle}" and couldn't finish. You may want to try uploading it again.`;
}

// --- Sources & ingestion (Phase 1 semantic memory) ---

/** How a source entered the companion's knowledge base. */
export type SourceKind = 'pdf' | 'note' | 'link' | 'txt' | 'md' | 'docx' | 'pptx';

/** Source kinds that arrive through the multipart file-upload channel. */
export type UploadSourceKind = Extract<SourceKind, 'pdf' | 'txt' | 'md' | 'docx' | 'pptx'>;

/** One accepted upload format (architecture.md §4.8 acceptance contract). */
export interface UploadFormat {
  readonly kind: UploadSourceKind;
  readonly extensions: readonly string[];
  readonly mimeTypes: readonly string[];
}

/**
 * The file formats the upload channel accepts. The server is authoritative —
 * it re-detects the kind and validates magic bytes — but the client uses this
 * to build the file picker's `accept` attribute so the two never drift.
 */
export const UPLOAD_FORMATS: readonly UploadFormat[] = [
  { kind: 'pdf', extensions: ['.pdf'], mimeTypes: ['application/pdf'] },
  { kind: 'txt', extensions: ['.txt'], mimeTypes: ['text/plain'] },
  { kind: 'md', extensions: ['.md', '.markdown'], mimeTypes: ['text/markdown'] },
  {
    kind: 'docx',
    extensions: ['.docx'],
    mimeTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  },
  {
    kind: 'pptx',
    extensions: ['.pptx'],
    mimeTypes: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  },
];

/** `accept` attribute value for an upload `<input type="file">`. */
export const UPLOAD_ACCEPT_ATTR: string = UPLOAD_FORMATS.flatMap((format) => [
  ...format.extensions,
  ...format.mimeTypes,
]).join(',');

/** Resolve a filename's extension to its upload kind; null if unsupported. */
export function uploadKindForFilename(filename: string): UploadSourceKind | null {
  const lower = filename.toLowerCase();
  const match = UPLOAD_FORMATS.find((format) =>
    format.extensions.some((extension) => lower.endsWith(extension)),
  );
  return match?.kind ?? null;
}

/**
 * Ingestion job lifecycle states, in pipeline order. `deferred` is off the main
 * line: a job that parsed successfully but whose AI passes wait for the owner's
 * daily token allowance to reset (architecture.md §4.8); it resumes to
 * `segmenting` once under the cap.
 */
export type IngestionStatus =
  | 'queued'
  | 'parsing'
  | 'deferred'
  | 'segmenting'
  | 'enriching'
  | 'embedding'
  | 'done'
  | 'failed';

/** A source the user fed the companion (the verbatim text is fetched on demand). */
export interface SourceDto {
  readonly id: string;
  readonly kind: SourceKind;
  readonly title: string;
  readonly origin: string | null;
  readonly byteSize: number | null;
  readonly createdAt: string;
}

/** Ingestion progress for one source — drives "Cobble has read N of M". */
export interface IngestionJobDto {
  readonly id: string;
  readonly sourceId: string;
  readonly status: IngestionStatus;
  readonly sectionsTotal: number;
  readonly sectionsDone: number;
  readonly error: string | null;
}

/** The signed-in user's daily token-budget standing, for the live usage indicator. */
export interface UsageDto {
  readonly usedTokens: number;
  readonly capTokens: number;
  /** Whole-percent of the cap consumed, clamped to 0–100. */
  readonly percentUsed: number;
  /** ISO instant the daily allowance resets (00:00 UTC). */
  readonly resetsAt: string;
}

/** A retrieval section: verbatim original text plus its location in the source. */
export interface SectionDto {
  readonly id: string;
  readonly sourceId: string;
  readonly chapterTitle: string | null;
  readonly topicTitle: string;
  readonly originalText: string;
  /** The companion's one-line reading of the section (Pass 2 of ingestion). */
  readonly contextHeader: string | null;
  readonly paraStart: number;
  readonly paraEnd: number;
  readonly pageStart: number | null;
  readonly pageEnd: number | null;
  readonly ord: number;
}

/** One semantic-search result for the memory browser. */
export interface SemanticSearchResultDto {
  readonly citation: Citation;
  readonly originalText: string;
  readonly score: number;
}

/**
 * A consolidated episodic memory (Phase 2) — a time-anchored summary derived
 * from the transcript. Surfaced in the memory browser's episode timeline and as
 * a recall result.
 */
export interface EpisodeDto {
  readonly id: string;
  readonly summary: string;
  readonly occurredStart: string;
  readonly occurredEnd: string;
  /** 0–1 salience weight, or null if the reflection pass omitted it. */
  readonly salience: number | null;
}

/** One episodic-recall result for the memory browser (episode + fused score). */
export interface EpisodeSearchResultDto {
  readonly episode: EpisodeDto;
  readonly score: number;
}

// --- Memory snapshot (the read-only memory browser, companionmemory.md) ---

/**
 * A memory section that is designed but not yet built. The browser renders these
 * as "coming soon" panels so the full knowledge-base shape is visible before the
 * stores exist (procedural = P3). See companionmemory.md.
 */
export interface PlannedMemorySection {
  readonly status: 'not_implemented';
  /** Phase that introduces this memory kind, for the browser to surface. */
  readonly plannedPhase: string;
}

/**
 * The episodic memory section — the companion's single continuous transcript
 * (implementation.md §1). One companion holds one lifelong conversation, so
 * this is a single message stream, not a list.
 */
export interface EpisodicMemorySection {
  readonly status: 'available';
  readonly messageCount: number;
  /** Consolidated episodes formed from the transcript so far (Phase 2). */
  readonly episodeCount: number;
}

/** The semantic memory section — what the companion has read (Phase 1). */
export interface SemanticMemorySection {
  readonly status: 'available';
  readonly sourceCount: number;
  readonly sectionCount: number;
  readonly factCount: number;
  readonly jobs: readonly IngestionJobDto[];
}

/**
 * A read-only snapshot of everything a companion "holds", grouped by memory kind
 * so new kinds slot in without reshaping the client (architecture.md invariant #2).
 */
export interface MemorySnapshotDto {
  readonly identity: CompanionDto;
  readonly episodic: EpisodicMemorySection;
  readonly semantic: SemanticMemorySection;
  readonly procedural: PlannedMemorySection;
}

// --- Request bodies (validated at the API boundary) ---

export const createCompanionSchema = z.object({
  name: z.string().trim().min(1).max(80),
  form: z.string().trim().min(1).max(80),
  temperament: z.string().trim().min(1).max(280),
});
export type CreateCompanionBody = z.infer<typeof createCompanionSchema>;

export const sendMessageSchema = z.object({
  content: z.string().trim().min(1).max(8_000),
});
export type SendMessageBody = z.infer<typeof sendMessageSchema>;

export const createNoteSourceSchema = z.object({
  title: z.string().trim().min(1).max(200),
  text: z.string().trim().min(1).max(500_000),
});
export type CreateNoteSourceBody = z.infer<typeof createNoteSourceSchema>;

export const createLinkSourceSchema = z.object({
  url: z.string().url().max(2_000),
  title: z.string().trim().min(1).max(200).optional(),
});
export type CreateLinkSourceBody = z.infer<typeof createLinkSourceSchema>;

export const semanticSearchSchema = z.object({
  query: z.string().trim().min(1).max(1_000),
  topK: z.number().int().min(1).max(20).default(8),
});
export type SemanticSearchBody = z.infer<typeof semanticSearchSchema>;

export const episodeSearchSchema = z.object({
  query: z.string().trim().min(1).max(1_000),
  topK: z.number().int().min(1).max(20).default(5),
});
export type EpisodeSearchBody = z.infer<typeof episodeSearchSchema>;

// --- Provenance (Phase 1 grounded recall, docs/companionmemory.md) ---

/**
 * Where a retrieved passage came from — renderable ("from your Peru book,
 * ch. 4, para 12–18") and locatable, so the user can always see the verbatim
 * original text behind an answer.
 */
export interface Citation {
  readonly sourceId: string;
  readonly sourceTitle: string;
  readonly chapterTitle: string | null;
  readonly topicTitle: string;
  readonly paraStart: number;
  readonly paraEnd: number;
  readonly pageStart: number | null;
  readonly pageEnd: number | null;
}

// --- Streaming protocol (Server-Sent Events for chat, architecture.md §4.6) ---

/** A single token delta streamed from the model as the assistant turn is produced. */
export interface StreamTokenEvent {
  readonly type: 'token';
  readonly value: string;
}

/**
 * The sources grounding this turn, emitted once (before `done`) when semantic
 * recall contributed passages. A separate event — citations are retrieval-time
 * data, structurally distinct from token deltas and the persisted message.
 */
export interface StreamCitationsEvent {
  readonly type: 'citations';
  readonly citations: readonly Citation[];
}

/** Terminal success event carrying the persisted assistant message. */
export interface StreamDoneEvent {
  readonly type: 'done';
  readonly message: MessageDto;
}

/** Terminal failure event — failures are data (architecture.md §4.7). */
export interface StreamErrorEvent {
  readonly type: 'error';
  readonly message: string;
}

export type ChatStreamEvent =
  | StreamTokenEvent
  | StreamCitationsEvent
  | StreamDoneEvent
  | StreamErrorEvent;

// --- Generic API envelope (patterns.md "API Response Format") ---

export interface ApiError {
  readonly error: string;
}
