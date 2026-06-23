import type {
  ChatStreamEvent,
  CompanionDto,
  CompanionStreamEvent,
  CreateCompanionBody,
  CreateLinkSourceBody,
  CreateNoteSourceBody,
  EpisodeDto,
  EpisodeSearchResultDto,
  FeedResultDto,
  FoodInventoryDto,
  FoodType,
  GrowthDto,
  IngestionJobDto,
  LeadDto,
  MemorySnapshotDto,
  MessageDto,
  ProactiveActivityDto,
  ProactivityDial,
  ProcedureDto,
  ProposalDto,
  SemanticSearchResultDto,
  SourceDto,
  StaminaEnergyDto,
  UploadSlotDto,
  UsageDto,
  UserFactDto,
  UserFactsDto,
} from '@cobble/shared';
import { authHeaders, SupersededError, wsClient } from './ws.js';

export interface CurrentUser {
  readonly id: string;
  readonly email: string | null;
}

// The bearer token is wired here (it rides the WS handshake and the file-upload
// request); re-exported from the transport so <App/> need not know about ws.ts.
export { setAccessTokenGetter, SupersededError } from './ws.js';

/**
 * Whether the user is signed in (and who). Opening the WS authenticates at the
 * handshake, so `auth.me` succeeding IS the gate; any failure (bad/expired token,
 * no connection) reads as signed-out.
 */
export async function fetchCurrentUser(): Promise<CurrentUser | null> {
  try {
    const { user } = await wsClient.call<{ user: CurrentUser }>('auth.me', undefined, null);
    return user;
  } catch {
    return null;
  }
}

export async function listCompanions(): Promise<CompanionDto[]> {
  const { companions } = await wsClient.call<{ companions: CompanionDto[] }>(
    'companions.list',
    undefined,
    null,
  );
  return companions;
}

export async function createCompanion(input: CreateCompanionBody): Promise<CompanionDto> {
  const { companion } = await wsClient.call<{ companion: CompanionDto }>(
    'companions.create',
    input,
    null,
  );
  return companion;
}

/** The companion's single continuous transcript (oldest-first). */
export async function fetchMessages(companionId: string): Promise<MessageDto[]> {
  const { messages } = await wsClient.call<{ messages: MessageDto[] }>(
    'messages.list',
    undefined,
    companionId,
  );
  return messages;
}

/** Add an emoji reaction to one of the companion's messages (companion-reactions.md §8). */
export async function addReaction(
  companionId: string,
  messageId: string,
  emoji: string,
): Promise<void> {
  await wsClient.call('reactions.add', { messageId, emoji }, companionId);
}

/** Remove a previously added reaction. Idempotent — un-reacting a gone reaction is fine. */
export async function removeReaction(
  companionId: string,
  messageId: string,
  emoji: string,
): Promise<void> {
  await wsClient.call('reactions.remove', { messageId, emoji }, companionId);
}

/** Read-only snapshot of everything the companion holds (the memory browser). */
export async function getCompanionMemory(companionId: string): Promise<MemorySnapshotDto> {
  const { memory } = await wsClient.call<{ memory: MemorySnapshotDto }>(
    'memory.snapshot',
    undefined,
    companionId,
  );
  return memory;
}

/**
 * The current user-model: the Tier-1 core `facts` (editable) and the Tier-2 learned
 * `beliefs` (read-only) the companion holds about the user (per-user).
 */
export async function getUserFacts(): Promise<UserFactsDto> {
  return wsClient.call<UserFactsDto>('userFacts.list', undefined, null);
}

/** Correct a fact the companion holds about the user (authoritative user edit). */
export async function updateUserFact(factId: string, object: string): Promise<UserFactDto> {
  return wsClient.call<UserFactDto>('userFacts.update', { factId, object }, null);
}

/** Forget a fact the companion holds about the user (it leaves the current set). */
export async function forgetUserFact(factId: string): Promise<void> {
  await wsClient.call('userFacts.delete', { factId }, null);
}

/** A source intake response: the created source and its queued ingestion job. */
export interface SourceIntake {
  readonly source: SourceDto;
  readonly job: IngestionJobDto;
}

/**
 * A file-upload intake response. Unlike note/link sources, a file upload also
 * writes the attachment chip + acknowledgement to the transcript and returns
 * them, so the chat can show id-bearing (reload-safe) lines immediately.
 */
export interface FileSourceIntake extends SourceIntake {
  readonly messages: readonly MessageDto[];
}

/** Add a plain-text note to the companion's knowledge base. */
export async function createNoteSource(
  companionId: string,
  input: CreateNoteSourceBody,
): Promise<SourceIntake> {
  return wsClient.call<SourceIntake>('sources.note', input, companionId);
}

/** Add a web link; the article is fetched and read in the background. */
export async function createLinkSource(
  companionId: string,
  input: CreateLinkSourceBody,
): Promise<SourceIntake> {
  return wsClient.call<SourceIntake>('sources.link', input, companionId);
}

/**
 * Upload a document file (PDF/txt/md/docx/pptx); reading happens in the background.
 * Three steps (staging-object-storage.md): (1) request a direct-upload slot over
 * the WS — the server derives the kind from the filename; (2) PUT the bytes
 * straight to the slot URL; (3) enqueue the source referencing the staged bytes.
 *
 * Step 2's target differs by backend: the S3 backend returns a presigned,
 * cross-origin URL that must NOT carry our Authorization header (it would break
 * the signature), while the local filesystem backend returns the same-origin
 * `/uploads/local/...` route, which requires the bearer. Detect by the path.
 */
export async function uploadFileSource(companionId: string, file: File): Promise<FileSourceIntake> {
  const slot = await wsClient.call<UploadSlotDto>(
    'sources.requestFileUpload',
    { filename: file.name, byteSize: file.size },
    companionId,
  );

  const origin = globalThis.location?.origin ?? 'http://localhost';
  const isLocalRoute = new URL(slot.url, origin).pathname.startsWith('/uploads/local/');
  const headers: Record<string, string> = { ...(slot.headers ?? {}) };
  if (isLocalRoute) {
    Object.assign(headers, await authHeaders());
  }
  const put = await fetch(slot.url, { method: slot.method, headers, body: file });
  if (!put.ok) {
    throw new Error(`upload failed (${put.status})`);
  }

  return wsClient.call<FileSourceIntake>(
    'sources.file',
    { uploadId: slot.uploadId, filename: file.name },
    companionId,
  );
}

/** The companion's sources, newest first. */
export async function listSources(companionId: string): Promise<SourceDto[]> {
  const { sources } = await wsClient.call<{ sources: SourceDto[] }>(
    'sources.list',
    undefined,
    companionId,
  );
  return sources;
}

/** Ingestion progress for all sources ("Cobble has read N of M"). */
export async function listIngestionJobs(companionId: string): Promise<IngestionJobDto[]> {
  const { jobs } = await wsClient.call<{ jobs: IngestionJobDto[] }>(
    'ingestion.list',
    undefined,
    companionId,
  );
  return jobs;
}

/** Delete a source (and its job + sections) — e.g. dropping a job parked at the cap. */
export async function deleteSource(companionId: string, sourceId: string): Promise<void> {
  await wsClient.call('sources.delete', { sourceId }, companionId);
}

/** A companion's stamina-wallet balance (the live indicator). */
export async function getUsage(companionId: string): Promise<UsageDto> {
  const { usage } = await wsClient.call<{ usage: UsageDto }>('usage.get', undefined, companionId);
  return usage;
}

/** The companion's two vitality wallets — stamina + energy (Phase 4 meter). */
export async function fetchBudget(companionId: string): Promise<StaminaEnergyDto> {
  return wsClient.call<StaminaEnergyDto>('budget.get', undefined, companionId);
}

/** The signed-in user's food pantry — the Kitchen's supply (per user). */
export async function getFood(): Promise<FoodInventoryDto> {
  const { food } = await wsClient.call<{ food: FoodInventoryDto }>('food.get', undefined, null);
  return food;
}

/** The companion's four-axis growth standing (Phase 5). */
export async function fetchGrowth(companionId: string): Promise<GrowthDto> {
  return wsClient.call<GrowthDto>('growth.get', undefined, companionId);
}

/**
 * A page of the companion's autonomous-activity log (Phase 4), newest-first. Pass
 * the previous page's `nextCursor` as `before` to load older entries.
 */
export async function fetchActivity(
  companionId: string,
  before?: number,
): Promise<ProactiveActivityDto> {
  return wsClient.call<ProactiveActivityDto>(
    'activity.list',
    before !== undefined ? { before } : {},
    companionId,
  );
}

/** Feed the companion a food — consumes one from the user's pantry, refills a wallet. */
export async function feedCompanion(companionId: string, food: FoodType): Promise<FeedResultDto> {
  return wsClient.call<FeedResultDto>('feed', { food }, companionId);
}

/** Set the companion's proactivity dial (off / gentle / active). */
export async function setProactivityDial(
  companionId: string,
  dial: ProactivityDial,
): Promise<ProactivityDial> {
  const result = await wsClient.call<{ dial: ProactivityDial }>(
    'proactivity.set',
    { dial },
    companionId,
  );
  return result.dial;
}

/** Search the companion's semantic memory (the browser's recall window). */
export async function searchMemory(
  companionId: string,
  query: string,
): Promise<SemanticSearchResultDto[]> {
  const { results } = await wsClient.call<{ results: SemanticSearchResultDto[] }>(
    'memory.search',
    { query },
    companionId,
  );
  return results;
}

/** The companion's consolidated episodic memories, most recent first. */
export async function listEpisodes(companionId: string): Promise<EpisodeDto[]> {
  const { episodes } = await wsClient.call<{ episodes: EpisodeDto[] }>(
    'episodes.list',
    undefined,
    companionId,
  );
  return episodes;
}

/** Recall episodes by topic (the browser's episodic recall window). */
export async function searchEpisodes(
  companionId: string,
  query: string,
): Promise<EpisodeSearchResultDto[]> {
  const { results } = await wsClient.call<{ results: EpisodeSearchResultDto[] }>(
    'episodes.search',
    { query },
    companionId,
  );
  return results;
}

/** The companion's pending approval queue (propose→approve, P3). */
export async function listProposals(companionId: string): Promise<ProposalDto[]> {
  const { proposals } = await wsClient.call<{ proposals: ProposalDto[] }>(
    'proposals.list',
    undefined,
    companionId,
  );
  return proposals;
}

/**
 * Approve a held action. The companion executes it, then RE-ENTERS the agent
 * loop to narrate the outcome and continue the task, streamed back — so
 * approving "remember this and summarize it" yields the summary, not a dead
 * tool-result line. The streamed turn's rows land in the transcript.
 */
export async function* confirmProposal(
  companionId: string,
  proposalId: string,
): AsyncGenerator<ChatStreamEvent> {
  yield* asChatStream(wsClient.callStream('proposals.confirm', { proposalId }, companionId));
}

/** Decline a held action (nothing executes). */
export async function rejectProposal(companionId: string, proposalId: string): Promise<void> {
  await wsClient.call('proposals.reject', { proposalId }, companionId);
}

/**
 * Tell the backend the tab's foreground/background state (Phase 4). D5 derives
 * presence from the standing WS connection itself; this records only the visibility
 * bit the motivation engine reads. Fire-and-forget.
 */
export async function sendHeartbeat(companionId: string, tabVisible: boolean): Promise<void> {
  await wsClient.call('presence.heartbeat', { tabVisible }, companionId);
}

/** The companion's reading list — leads it discovered but hasn't acted on (P3). */
export async function listLeads(companionId: string): Promise<LeadDto[]> {
  const { leads } = await wsClient.call<{ leads: LeadDto[] }>('leads.list', undefined, companionId);
  return leads;
}

/** The companion's learned, reusable workflows (procedural memory, P3). */
export async function listProcedures(companionId: string): Promise<ProcedureDto[]> {
  const { procedures } = await wsClient.call<{ procedures: ProcedureDto[] }>(
    'procedures.list',
    undefined,
    companionId,
  );
  return procedures;
}

/** Send a message and yield streamed chat events. */
export async function* sendMessage(
  companionId: string,
  content: string,
): AsyncGenerator<ChatStreamEvent> {
  yield* asChatStream(wsClient.callStream('messages.send', { content }, companionId));
}

/**
 * Ask the companion to react to the user's arrival (Phase 14). Yields a
 * `composing` cue (→ typing indicator) then the voiced greeting as `done`, or no
 * events when the gate decides to stay quiet. Opened on mount and on tab-return.
 */
export async function* streamGreeting(companionId: string): AsyncGenerator<ChatStreamEvent> {
  yield* asChatStream(wsClient.callStream('greeting.stream', undefined, companionId));
}

/**
 * Subscribe to the embodiment connection's live event stream (architecture.md
 * §6): yields each transcript row / reaction the server pushes for as long as the
 * embodiment connection stays open. `signal` cancels it (the caller aborts on unmount), and an
 * abort — or a clean socket drop — ends the generator quietly rather than as an
 * error; the caller owns reconnect. A takeover by another tab/device (superseded)
 * also ends it quietly — {@link onEmbodimentMoved} carries that to the UI.
 */
export function subscribeCompanionEvents(
  companionId: string,
  signal: AbortSignal,
): AsyncGenerator<CompanionStreamEvent> {
  return wsClient.events(companionId, signal);
}

/**
 * Notify the UI when this companion was claimed by a newer connection (another tab
 * or device). The owner stops reconnecting until {@link reclaimEmbodiment}; the UI
 * offers a "use here" affordance. Returns an unsubscribe.
 */
export function onEmbodimentMoved(listener: () => void): () => void {
  return wsClient.onState((state) => {
    if (state === 'superseded') listener();
  });
}

/** Take the room back after a move: the next call/subscription reconnects and
 *  force-claims (newer wins). Pair with re-subscribing the event channel. */
export function reclaimEmbodiment(): void {
  wsClient.reclaim();
}

/** Adapt the transport's untyped stream chunks to typed chat events. */
async function* asChatStream(stream: AsyncGenerator<unknown>): AsyncGenerator<ChatStreamEvent> {
  for await (const chunk of stream) {
    yield chunk as ChatStreamEvent;
  }
}
