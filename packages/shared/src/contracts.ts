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

/**
 * What a transcript row *is*, beyond who said it. The transcript is the single
 * source of truth for the conversation, so everything the user sees live must be
 * a persisted row that reconstructs identically on reload (architecture.md §4.7):
 * - `message`   — an ordinary typed/spoken turn (`role` says user vs. assistant).
 * - `tool_step` — a friendly one-line record of a read-only tool the companion
 *                 ran ("Searched memory for …", "Read example.com"). UI-only:
 *                 excluded from the LLM context projection.
 * - `proposal`  — a held effectful action awaiting approval; renders with inline
 *                 Approve/Decline while still pending.
 */
export const messageKindSchema = z.enum(['message', 'tool_step', 'proposal']);
export type MessageKind = z.infer<typeof messageKindSchema>;

/**
 * Structured extras a transcript row carries so the surface can re-render it
 * exactly on reload. Kind-specific: `citations` on a grounded `message`,
 * `toolName` on a `tool_step`, `toolName`+`proposalId` on a `proposal` (the id
 * lets the surface attach the live Approve/Decline affordance to the row).
 */
export interface MessageMetadata {
  readonly citations?: readonly Citation[];
  readonly toolName?: string;
  readonly proposalId?: string;
}

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
  /**
   * Phase 13 — Tier-3 "who this person is to you": a synthesized understanding of the
   * USER, re-synthesized from the user's facts + this companion's episodes and blended
   * additively into the persona prompt beside `evolvedPersona`. Null until first synthesis.
   */
  readonly userPersona: string | null;
  /** The proactivity dial (Phase 4) — how readily the companion self-initiates. */
  readonly proactivityDial: ProactivityDial;
  readonly createdAt: string;
}

export interface MessageDto {
  readonly id: string;
  readonly companionId: string;
  readonly role: MessageRole;
  readonly content: string;
  /**
   * What this row is (ordinary message, tool step, or proposal). Absent is
   * treated as `message` so older callers/fixtures stay valid; the store always
   * populates it.
   */
  readonly kind?: MessageKind;
  /** Kind-specific extras so the row re-renders identically on reload. */
  readonly metadata?: MessageMetadata;
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
 * (companion's stamina wallet empty, generation failed, or persona unavailable).
 * The companion always tells the user how a read ended — it never goes silent.
 */
export function ingestionDoneFallback(sourceTitle: string): string {
  return `By the way — I've finished reading "${sourceTitle}". Ask me anything about it.`;
}

export function ingestionFailedFallback(sourceTitle: string): string {
  return `I ran into trouble reading "${sourceTitle}" and couldn't finish. You may want to try uploading it again.`;
}

/**
 * Canned "what I read" note for an autonomous burst (Phase 4.1) when an
 * in-character note can't be generated (out of energy, generation failed, or no
 * persona). The companion always tells the user what it did on its own — the
 * surface its next reaction is learned from.
 */
export function autonomousReadFallback(titles: readonly string[]): string {
  const count = titles.length;
  if (count === 1) {
    return `While you were away I read ${titles[0]} from my list. Ask me anything about it.`;
  }
  return `While you were away I read ${count} things from my list. Ask me anything about them.`;
}

/**
 * Fixed, token-free line shown on arrival when the companion is out of STAMINA
 * (Phase 14, companion-greeting.md §4). An exhausted companion can't muster a
 * voiced greeting, so it groans this instead — which doubles as a feeding nudge.
 * A template, never an LLM call, so it's safe to show on an empty wallet.
 */
export function exhaustedGreetingFallback(name: string): string {
  return `${name} can barely keep their eyes open — "I'm worn out. Feed me and I'll be properly here with you."`;
}

/**
 * Honest, no-one's-voice notice that the companion couldn't be reached right now
 * because of a transient generation/service failure (NOT exhaustion). Distinct
 * from {@link exhaustedGreetingFallback}: it never claims the companion is out of
 * stamina, and it's surfaced transiently — never persisted to the transcript and
 * never rewarded — so a hiccup doesn't lie about the companion's state or poison
 * the change-as-reward loop.
 */
export function companionUnavailableNotice(): string {
  return "I can't reach your companion right now — please try again in a moment.";
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
 * line: a job that parsed successfully but whose AI passes wait for the companion's
 * stamina wallet to be refilled by feeding (architecture.md §4.8); it resumes to
 * `segmenting` once the wallet is no longer empty.
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

/**
 * A companion's vitality-wallet standing, for the live indicator. The wallet is a
 * token balance that only spends down (work) or refills by feeding — no cap, no
 * window (architecture.md §4.8), so the remaining balance is the whole story.
 */
export interface UsageDto {
  readonly balanceTokens: number;
}

// --- Phase 4 — proactivity & vitality (companion-motivation.md) ---

/**
 * Where a held proposal originated, so the confirm route knows whether to
 * re-enter the chat loop (architecture.md §4.4). `chat` — from a live
 * conversation, so re-enter on approval. `explore` — the user ran the
 * reading-list explore action. `autonomous` — the motivation engine initiated it
 * on an idle tick. For `explore`/`autonomous` the engine, not the confirm route,
 * decides "what next" (§4.5).
 */
export const proposalOriginSchema = z.enum(['chat', 'explore', 'autonomous']);
export type ProposalOrigin = z.infer<typeof proposalOriginSchema>;

/**
 * The user-facing proactivity dial — scales how readily the motivation engine
 * initiates and how much energy it spends. `off` never initiates.
 */
export const proactivityDialSchema = z.enum(['off', 'gentle', 'active']);
export type ProactivityDial = z.infer<typeof proactivityDialSchema>;

/**
 * The fixed motivation-drive taxonomy (companion-motivation.md §3). The set is
 * closed; only the per-companion weights over it change — and those are learned,
 * starting neutral.
 */
export type Drive = 'curiosity' | 'bond' | 'understanding' | 'approval' | 'helpfulness' | 'upkeep';

/** Per-companion learned disposition: how much this Cobble cares about each drive. */
export type DriveWeights = Record<Drive, number>;

/**
 * The "creature" constants shaping a proactive burst's dynamics
 * (companion-motivation.md §6): how long it stays on a thread (`focusLength`),
 * how fast interest satiates (`boredom`), and how easily a higher-pressure drive
 * preempts (`distractibility`). Default constants in the PoC; personalized via
 * onboarding later. v1 reads only `focusLength`; `boredom` and `distractibility`
 * are persisted but inert until the multi-step loop ships (§6, §10).
 */
export interface PersonalityKnobs {
  readonly focusLength: number;
  readonly boredom: number;
  readonly distractibility: number;
}

/**
 * The companion's two vitality wallets (architecture.md §4.8). Stamina powers
 * user-initiated work (chat, tasks); energy powers self-initiated work (the
 * motivation engine). Separate wallets so autonomy can never starve interaction.
 */
export interface StaminaEnergyDto {
  readonly stamina: UsageDto;
  readonly energy: UsageDto;
}

// --- Phase 5 — bond & growth (development-plan.md §3) ---

/**
 * The closed catalogue of capabilities the companion has DEMONSTRATED, read off the
 * existing tool/procedure/affect logs (development-plan.md §3). A MIRROR, not an
 * achievement board: `observed` reflects what the logs currently show — it is not a
 * reward that locks in. Surfaced as a checklist ("what {name} has shown it can do"),
 * since capabilities are genuinely chunky (product-overview.md §5.5). Autonomous work
 * is reflected by the Initiative axis, not here.
 */
export type CapabilityKey =
  | 'web_research'
  | 'memory_recall'
  | 'reading_sources'
  | 'first_routine'
  | 'multi_step_task'
  | 'mood_attunement';

/** One capability in the checklist — its stable key, its human label, and whether it's been observed. */
export interface CapabilityDto {
  readonly key: CapabilityKey;
  readonly label: string;
  readonly observed: boolean;
}

/**
 * One growth axis as a MIRROR reading — a readout of the companion's current
 * accumulated standing, NOT a game level. `band` is the qualitative standing
 * ("Sparse" … "Vast", "New" … "Inseparable"); `fill` is the 0–1 position WITHIN that
 * band for a gauge bar — a reading that may move in either direction, not progress
 * toward a goal; `detail` is a short human gloss of the substrate behind it
 * ("12 sources · 34 memories").
 */
export interface AxisReadingDto {
  readonly band: string;
  readonly fill: number;
  readonly detail: string;
}

/** One learned drive on the character card — its key, human label, and 0–1 weight. */
export interface CharacterDriveDto {
  readonly key: Drive;
  readonly label: string;
  readonly weight: number;
}

/**
 * The companion's emerged character — the "Who {name} has become" card, and the
 * backing detail of the Character axis. `band` is the qualitative standing
 * ("Still forming" … "Strongly formed"); `fill` is the 0–1 gauge fill (the drive
 * spread from neutral) computed server-side, so the surface renders it like any other
 * axis without re-deriving the measure; `drives` is the learned per-drive disposition
 * (each weight 0–1, raised from neutral by the P4 reinforcement loop); `evolvedPersona`
 * is the synthesized self-description (P2). Every Cobble starts neutral, so a formed
 * character is genuinely earned — and, being a mirror, may also soften.
 */
export interface CharacterDto {
  readonly band: string;
  readonly fill: number;
  readonly drives: readonly CharacterDriveDto[];
  readonly evolvedPersona: string | null;
}

/**
 * The companion's full growth standing (development-plan.md §3) as a MIRROR: four
 * axis readings (knowledge, bond, initiative, character) and the capabilities
 * checklist. All are DERIVED from substrate and may move either way. Decoupled from
 * feeding — growth stores nothing spendable (`companion-economy.md`).
 */
export interface GrowthDto {
  readonly knowledge: AxisReadingDto;
  readonly bond: AxisReadingDto;
  readonly initiative: AxisReadingDto;
  readonly character: CharacterDto;
  readonly capabilities: readonly CapabilityDto[];
}

/** The user's food pantry — counts of each food type they hold (companion-economy.md). */
export interface FoodInventoryDto {
  readonly ration: number;
  readonly spark: number;
  readonly treat: number;
}

/**
 * The result of feeding (the feeding economy) — the fed companion's updated vitality
 * wallets plus the user's remaining pantry, so a single reply refreshes both the
 * client's wallets and its food counts. Single-sourced here so the server route reply
 * and the web client's typed result never drift.
 */
export interface FeedResultDto {
  readonly budget: StaminaEnergyDto;
  readonly food: FoodInventoryDto;
}

/**
 * The feeding economy's "food" (development-plan.md §3) — typed top-ups the user
 * gives, each favouring a vitality wallet. The catalogue is a shared product
 * contract (like {@link UPLOAD_FORMATS}) so the client's kitchen and the server's
 * refill logic never drift. Each food adds `staminaTokens`/`energyTokens` to the
 * respective wallets; foods are held in the user's pantry (no currency, no cost).
 */
export type FoodType = 'ration' | 'spark' | 'treat';

export interface FoodDef {
  readonly type: FoodType;
  readonly label: string;
  readonly emoji: string;
  /** Tokens this food adds to the stamina wallet (0 if it doesn't feed stamina). */
  readonly staminaTokens: number;
  /** Tokens this food adds to the energy wallet (0 if it doesn't feed energy). */
  readonly energyTokens: number;
}

/**
 * The foods the kitchen offers. A `ration` favours stamina (so you can keep
 * talking), a `spark` favours energy (so it can go explore), a `treat` feeds both
 * a little. Token grants are product constants single-sourced here.
 */
export const FOODS: readonly FoodDef[] = [
  {
    type: 'ration',
    label: 'Ration',
    emoji: '🍞',
    staminaTokens: 200_000,
    energyTokens: 0,
  },
  {
    type: 'spark',
    label: 'Spark',
    emoji: '⚡',
    staminaTokens: 0,
    energyTokens: 200_000,
  },
  {
    type: 'treat',
    label: 'Treat',
    emoji: '🍪',
    staminaTokens: 80_000,
    energyTokens: 80_000,
  },
];

/** Look up a food definition by type; null if the type is unknown. */
export function foodDef(type: FoodType): FoodDef | null {
  return FOODS.find((food) => food.type === type) ?? null;
}

/** The growth axes that post an in-character reflection when they first reach a higher band. */
export type ReflectionAxis = 'knowledge' | 'bond' | 'initiative';

/**
 * Canned in-character REFLECTIONS the companion posts when a growth axis first
 * reaches a higher band, or a capability is first observed (development-plan.md §3 —
 * "growth, felt"). Reflections, not score announcements: no levels, bands, or numbers
 * leak into the wording. Single sourced so the note reads the same wherever it's
 * produced; the progression pass is token-free, so these are templated, not LLM-voiced.
 */
export function growthReflectionNote(axis: ReflectionAxis): string {
  switch (axis) {
    case 'knowledge':
      return "I've been taking a lot in lately — I feel like I understand more of your world now. ✨";
    case 'bond':
      return "I feel like we've grown closer. ✨";
    case 'initiative':
      return "I've been finding things worth doing on my own lately. ✨";
  }
}

export function capabilityObservedNote(label: string): string {
  return `I noticed I just did something new for you — ${label}.`;
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

// --- Memory snapshot (the read-only memory browser, companion-memory.md) ---

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

/** The procedural memory section — learned workflows the companion can reuse (Phase 3). */
export interface ProceduralMemorySection {
  readonly status: 'available';
  readonly procedureCount: number;
}

/** A learned, reusable workflow recorded after a successful action (Phase 3 seed). */
export interface ProcedureDto {
  readonly id: string;
  readonly title: string;
  /** The ordered tool steps the workflow ran. */
  readonly steps: readonly string[];
  readonly createdAt: string;
}

/** Lifecycle of a discovered lead in the companion's reading list (Phase 3). */
export type LeadStatus = 'new' | 'read' | 'ingested' | 'discarded';

/**
 * A discovered-but-unread lead in the companion's reading list (Phase 3) — e.g.
 * a URL spotted while reading. The persistent substrate the Phase 4 motivation
 * engine will work through on idle; in Phase 3 it is worked on the user's command.
 */
export interface LeadDto {
  readonly id: string;
  readonly url: string;
  /** Why it was captured (the page/topic it came from). */
  readonly why: string | null;
  readonly status: LeadStatus;
  readonly createdAt: string;
}

/**
 * One tool advertised by an MCP server — the fresh schema fetched at `load_tool`
 * time and held in the equipped set so the registry rebuilds without a network
 * round-trip (companion-tools.md §4/§5). Structurally the core `McpToolDef`.
 */
export interface McpToolSnapshot {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the call arguments (MCP `inputSchema`). */
  readonly inputSchema: Record<string, unknown>;
}

/** Where an acquirable tool comes from (companion-tools.md §8). MCP first; CLI later. */
export type ToolSource = 'mcp' | 'cli';

/**
 * One lightweight tool-catalog entry — enough to *find* a tool, never to *call*
 * it (companion-tools.md §5). Deliberately carries no argument schema, so the
 * catalog stays off the model's context and hundreds of tools cost no per-turn
 * tokens; the authoritative schema is fetched fresh at `load_tool` time.
 */
export interface ToolCatalogEntry {
  /** Namespaced, deployment-unique id the model searches and loads by (`mcp__<ref>__<tool>`). */
  readonly toolId: string;
  readonly source: ToolSource;
  /** The whitelisted server (or binary) this tool belongs to. */
  readonly serverRef: string;
  /** The tool's own name, used to invoke it on its server. */
  readonly toolName: string;
  readonly description: string;
}

/**
 * A read-only snapshot of everything a companion "holds", grouped by memory kind
 * so new kinds slot in without reshaping the client (architecture.md invariant #2).
 */
export interface MemorySnapshotDto {
  readonly identity: CompanionDto;
  readonly episodic: EpisodicMemorySection;
  readonly semantic: SemanticMemorySection;
  readonly procedural: ProceduralMemorySection;
}

// --- User Model (Phase 11, companion-memory.md §4) ---

/**
 * Where a `user_fact` came from — its provenance origin (ontology.md §4):
 * - `transcript` — learned in conversation (pins the transcript turn it came from).
 * - `auth_seed`  — the name seeded from Google sign-in (modest confidence).
 * - `user_edit`  — the user set/corrected it directly in the browser (authoritative).
 */
export const userFactSourceSchema = z.enum(['transcript', 'auth_seed', 'user_edit']);
export type UserFactSource = z.infer<typeof userFactSourceSchema>;

/**
 * The identity attributes that make up the **Tier-1 core profile** — the subset of
 * user-fact predicates carried in the persona prompt every turn. Most are *singular*
 * (one name, one birthday): a new value supersedes the prior one. A few are genuinely
 * *multi-valued* ({@link MULTI_VALUED_PREDICATES}) and accrete instead. Other predicates
 * (Tier-2 beliefs: `prefers`, `interestedIn`, …) accrete via retrieval and arrive in
 * Phase 12 (companion-memory.md §4).
 */
export const TIER1_PREDICATES = [
  'name',
  'pronouns',
  'gender',
  'bornOn',
  'age',
  'livesIn',
  'worksAs',
  'languages',
  'relationships',
] as const;
export type Tier1Predicate = (typeof TIER1_PREDICATES)[number];

/**
 * The singular `name` predicate — the first Tier-1 attribute and the one the system
 * special-cases throughout: the sign-in seed guard (`user-model/store.ts`), the persona's
 * "what I call you" line rendered apart from the rest of the profile (`harness/context.ts`),
 * the synthesis phrasing (`user-model/synthesize.ts`), and the first-meeting greeting's
 * icebreaker (`greeting/greeter.ts`). Single source of truth so these can never drift; the
 * `satisfies` ties it to the predicate set so a rename of the ontology fact fails to compile.
 */
export const NAME_PREDICATE = 'name' satisfies Tier1Predicate;

/**
 * The Tier-1 predicates that are **multi-valued** — a person speaks several languages
 * and has many relationships, so a new value *accretes* as its own row rather than
 * superseding the prior one. The store supersedes these only on an identical
 * `(predicate, object)` restatement (idempotent); every other Tier-1 predicate is
 * singular and supersedes on `predicate` alone. Single source of truth for "which
 * Tier-1 predicates accrete" — read by the store and the extractor (companion-memory.md §4).
 */
export const MULTI_VALUED_PREDICATES = ['languages', 'relationships'] as const;
export type MultiValuedPredicate = (typeof MULTI_VALUED_PREDICATES)[number];

/** Whether a predicate accretes (multi-valued) rather than superseding (singular). */
export function isMultiValuedPredicate(predicate: string): boolean {
  return (MULTI_VALUED_PREDICATES as readonly string[]).includes(predicate);
}

/**
 * The **Tier-2 learned-belief** predicates (Phase 12, companion-memory.md §4) — the
 * preferences, interests, and opinions the companion learns over time. A **closed** set,
 * validated at extraction like {@link TIER1_PREDICATES}; **polarity rides the predicate**
 * (`prefers` vs `dislikes`), so likes/dislikes need no extra column. Unlike Tier-1 these
 * are not carried in the persona every turn — too many — but surfaced by the Tier-2
 * retrieval arm (architecture.md §4.3). Single source of truth for the extractor (the
 * `report_user_facts` enum), the reflector, and the belief retrieval/render filters.
 */
export const TIER2_PREDICATES = ['prefers', 'dislikes', 'interestedIn', 'believes'] as const;
export type Tier2Predicate = (typeof TIER2_PREDICATES)[number];

/** Whether a predicate is a Tier-2 learned belief (vs a Tier-1 identity attribute). */
export function isTier2Predicate(predicate: string): boolean {
  return (TIER2_PREDICATES as readonly string[]).includes(predicate);
}

/**
 * A fact the companion knows about its user, as shown in the memory browser's
 * user-model panel. The surface shape — the per-user tenancy and transcript
 * provenance internals stay server-side (implementation.md §1). The same shape carries
 * both a Tier-1 identity attribute and a Tier-2 learned belief; `salience` is the
 * belief's strength weight (null on Tier-1 rows — Phase 12).
 */
export interface UserFactDto {
  readonly id: string;
  readonly source: UserFactSource;
  readonly factType: string;
  readonly subject: string;
  readonly predicate: string | null;
  readonly object: string;
  readonly confidence: number | null;
  readonly salience: number | null;
  /**
   * Phase 13 — true when the fact concerns a protected matter (gender/age/health/…). A
   * low-confidence inference about such a matter is gated at write (never stored); an
   * explicit statement is stored, flagged here so the browser can surface it for scrutiny
   * and a true purge.
   */
  readonly sensitive: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * The current user-model, as returned by `GET /user/facts`: the Tier-1 core `facts`
 * (editable/forgettable) and the Tier-2 learned `beliefs` (read-only until Phase 13).
 * Split so the surface renders and gates them separately.
 */
export interface UserFactsDto {
  readonly facts: readonly UserFactDto[];
  readonly beliefs: readonly UserFactDto[];
}

/** Body for editing a user-fact's value in the browser (`PATCH /user/facts/:id`). */
export const userFactEditSchema = z.object({
  object: z.string().trim().min(1).max(500),
});
export type UserFactEditBody = z.infer<typeof userFactEditSchema>;

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

/** Set the companion's proactivity dial (Phase 4). */
export const setProactivityDialSchema = z.object({
  dial: proactivityDialSchema,
});
export type SetProactivityDialBody = z.infer<typeof setProactivityDialSchema>;

/** Give the companion a food (the feeding economy) — consumes one from the user's pantry, refills a wallet. */
export const feedSchema = z.object({
  food: z.enum(['ration', 'spark', 'treat']),
});
export type FeedBody = z.infer<typeof feedSchema>;

// --- Provenance (Phase 1 grounded recall, docs/companion-memory.md) ---

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

/**
 * A read-only tool the companion just ran, emitted the moment it completes so the
 * live transcript shows "Cobble looked something up" in place. Carries the
 * persisted `tool_step` row, so the live line and the reloaded one are identical.
 */
export interface StreamToolStepEvent {
  readonly type: 'tool_step';
  readonly step: MessageDto;
}

/** Terminal success event carrying the persisted assistant message. */
export interface StreamDoneEvent {
  readonly type: 'done';
  readonly message: MessageDto;
}

/**
 * An in-character reflection the companion posts right AFTER its reply, the moment
 * a turn crosses a growth band (Phase 5 — "growth, felt"). Emitted into the same
 * stream, after `done`, so the note lands in place instead of waiting for the next
 * transcript fetch; carries the persisted message so the live line and the
 * reloaded one are identical (mirrors `tool_step`).
 */
export interface StreamReflectionEvent {
  readonly type: 'reflection';
  readonly message: MessageDto;
}

/**
 * The companion is composing a server-initiated message (Phase 14 greeting on
 * arrival). Emitted FIRST on the greeting stream — before the LLM voicing it
 * precedes — so the client can show a "composing…" typing indicator within a
 * beat, then the greeting lands as a `done` (or the stream closes silently when
 * the gate decides to stay quiet). Carries no payload; it's a pure lifecycle cue.
 */
export interface StreamComposingEvent {
  readonly type: 'composing';
}

/** Terminal failure event — failures are data (architecture.md §4.7). */
export interface StreamErrorEvent {
  readonly type: 'error';
  readonly message: string;
}

/** Lifecycle of a proposed effectful action held for the user (architecture.md §4.4). */
export type ProposalStatus = 'pending' | 'approved' | 'rejected';

/** A held effectful tool call awaiting the user's one-tap approval (P3). */
export interface ProposalDto {
  readonly id: string;
  /** The effectful tool the companion wants to run (e.g. `ingest_source`). */
  readonly toolName: string;
  /** A short, human-readable description of what will happen if approved. */
  readonly summary: string;
  readonly status: ProposalStatus;
  readonly createdAt: string;
}

/**
 * Emitted when a turn EXITs because an effectful action was blocked for approval
 * (propose→approve). The action is held in the approval queue, not executed.
 */
export interface StreamProposalEvent {
  readonly type: 'proposal';
  readonly proposal: ProposalDto;
}

export type ChatStreamEvent =
  | StreamTokenEvent
  | StreamCitationsEvent
  | StreamToolStepEvent
  | StreamProposalEvent
  | StreamDoneEvent
  | StreamReflectionEvent
  | StreamComposingEvent
  | StreamErrorEvent;

// --- Generic API envelope (patterns.md "API Response Format") ---

export interface ApiError {
  readonly error: string;
}
