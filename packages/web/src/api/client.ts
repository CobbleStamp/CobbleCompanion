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
  ProactivityDial,
  ProcedureDto,
  ProposalDto,
  SectionDto,
  SemanticSearchResultDto,
  SourceDto,
  StaminaEnergyDto,
  UsageDto,
  UserFactDto,
  UserFactsDto,
} from '@cobble/shared';

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? '';

export interface CurrentUser {
  readonly id: string;
  readonly email: string;
}

/**
 * Returns the bearer token (a Google ID token, or null when auth is bypassed).
 * Wired up by <App/> once the user signs in, so the client need not import the
 * auth SDK.
 */
type AccessTokenGetter = () => Promise<string | null>;
let getAccessToken: AccessTokenGetter = async () => null;

export function setAccessTokenGetter(getter: AccessTokenGetter): void {
  getAccessToken = getter;
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getAccessToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

/**
 * The single fetch path: applies the bearer token (and a JSON content-type when
 * the body is a JSON string), then throws a body-aware error on any non-2xx.
 * Returns the raw Response so callers can read it as JSON, drain it as an SSE
 * stream, or ignore it (a 204). Every request flows through here so the
 * auth-header and error-surfacing contracts can't diverge between call sites.
 */
async function send(path: string, init?: RequestInit): Promise<Response> {
  const auth = await authHeaders();
  // Only declare a JSON content-type for a string (JSON) body. A bodyless
  // request must omit it — Fastify rejects an empty body with content-type:
  // application/json (FST_ERR_CTP_EMPTY_JSON_BODY), 400-ing bodyless GET/POST.
  // A FormData body (file upload) must also omit it so the browser can set the
  // multipart boundary itself.
  const contentType = typeof init?.body === 'string' ? { 'content-type': 'application/json' } : {};
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { ...contentType, ...auth, ...(init?.headers ?? {}) },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `request failed (${response.status})`);
  }
  return response;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await send(path, init);
  return (await response.json()) as T;
}

/** Drive an endpoint that streams SSE chat events (chat + confirm). */
async function* stream(path: string, init?: RequestInit): AsyncGenerator<ChatStreamEvent> {
  const response = await send(path, init);
  if (!response.body) throw new Error('streamed response has no body');
  yield* readSse(response);
}

export async function fetchCurrentUser(): Promise<CurrentUser | null> {
  const auth = await authHeaders();
  const response = await fetch(`${API_URL}/auth/me`, { headers: auth });
  if (!response.ok) return null;
  const body = (await response.json()) as { user: CurrentUser };
  return body.user;
}

export async function listCompanions(): Promise<CompanionDto[]> {
  const body = await request<{ companions: CompanionDto[] }>('/companions');
  return body.companions;
}

export async function createCompanion(input: CreateCompanionBody): Promise<CompanionDto> {
  const body = await request<{ companion: CompanionDto }>('/companions', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return body.companion;
}

/** The companion's single continuous transcript (oldest-first). */
export async function fetchMessages(companionId: string): Promise<MessageDto[]> {
  const body = await request<{ messages: MessageDto[] }>(`/companions/${companionId}/messages`);
  return body.messages;
}

/** Read-only snapshot of everything the companion holds (the memory browser). */
export async function getCompanionMemory(companionId: string): Promise<MemorySnapshotDto> {
  const body = await request<{ memory: MemorySnapshotDto }>(`/companions/${companionId}/memory`);
  return body.memory;
}

/**
 * The current user-model: the Tier-1 core `facts` (editable) and the Tier-2 learned
 * `beliefs` (read-only) the companion holds about the user (per-user).
 */
export async function getUserFacts(): Promise<UserFactsDto> {
  return request<UserFactsDto>('/user/facts');
}

/** Correct a fact the companion holds about the user (authoritative user edit). */
export async function updateUserFact(factId: string, object: string): Promise<UserFactDto> {
  return request<UserFactDto>(`/user/facts/${factId}`, {
    method: 'PATCH',
    body: JSON.stringify({ object }),
  });
}

/** Forget a fact the companion holds about the user (it leaves the current set). */
export async function forgetUserFact(factId: string): Promise<void> {
  await send(`/user/facts/${factId}`, { method: 'DELETE' });
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
  return request<SourceIntake>(`/companions/${companionId}/sources/note`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** Add a web link; the article is fetched and read in the background. */
export async function createLinkSource(
  companionId: string,
  input: CreateLinkSourceBody,
): Promise<SourceIntake> {
  return request<SourceIntake>(`/companions/${companionId}/sources/link`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** Upload a document file (PDF/txt/md/docx/pptx); reading happens in the background. */
export async function uploadFileSource(companionId: string, file: File): Promise<FileSourceIntake> {
  const form = new FormData();
  form.append('file', file);
  const response = await send(`/companions/${companionId}/sources/file`, {
    method: 'POST',
    body: form,
  });
  return (await response.json()) as FileSourceIntake;
}

/** The companion's sources, newest first. */
export async function listSources(companionId: string): Promise<SourceDto[]> {
  const body = await request<{ sources: SourceDto[] }>(`/companions/${companionId}/sources`);
  return body.sources;
}

/** One source plus its sections (verbatim text + provenance). */
export async function getSourceDetail(
  companionId: string,
  sourceId: string,
): Promise<{ source: SourceDto; sections: SectionDto[] }> {
  return request(`/companions/${companionId}/sources/${sourceId}`);
}

/** Ingestion progress for all sources ("Cobble has read N of M"). */
export async function listIngestionJobs(companionId: string): Promise<IngestionJobDto[]> {
  const body = await request<{ jobs: IngestionJobDto[] }>(`/companions/${companionId}/ingestion`);
  return body.jobs;
}

/** Delete a source (and its job + sections) — e.g. dropping a job parked at the cap. */
export async function deleteSource(companionId: string, sourceId: string): Promise<void> {
  await send(`/companions/${companionId}/sources/${sourceId}`, { method: 'DELETE' });
}

/** A companion's stamina-wallet balance (the live indicator). */
export async function getUsage(companionId: string): Promise<UsageDto> {
  const body = await request<{ usage: UsageDto }>(`/companions/${companionId}/usage`);
  return body.usage;
}

/** The companion's two vitality wallets — stamina + energy (Phase 4 meter). */
export async function fetchBudget(companionId: string): Promise<StaminaEnergyDto> {
  return request<StaminaEnergyDto>(`/companions/${companionId}/budget`);
}

/** The signed-in user's food pantry — the Kitchen's supply (per user). */
export async function getFood(): Promise<FoodInventoryDto> {
  const body = await request<{ food: FoodInventoryDto }>(`/food`);
  return body.food;
}

/** The companion's four-axis growth standing (Phase 5). */
export async function fetchGrowth(companionId: string): Promise<GrowthDto> {
  return request<GrowthDto>(`/companions/${companionId}/growth`);
}

/** Feed the companion a food — consumes one from the user's pantry, refills a wallet. */
export async function feedCompanion(companionId: string, food: FoodType): Promise<FeedResultDto> {
  return request<FeedResultDto>(`/companions/${companionId}/feed`, {
    method: 'POST',
    body: JSON.stringify({ food }),
  });
}

/** Set the companion's proactivity dial (off / gentle / active). */
export async function setProactivityDial(
  companionId: string,
  dial: ProactivityDial,
): Promise<ProactivityDial> {
  const body = await request<{ dial: ProactivityDial }>(`/companions/${companionId}/proactivity`, {
    method: 'PATCH',
    body: JSON.stringify({ dial }),
  });
  return body.dial;
}

/** Search the companion's semantic memory (the browser's recall window). */
export async function searchMemory(
  companionId: string,
  query: string,
): Promise<SemanticSearchResultDto[]> {
  const body = await request<{ results: SemanticSearchResultDto[] }>(
    `/companions/${companionId}/memory/search`,
    { method: 'POST', body: JSON.stringify({ query }) },
  );
  return body.results;
}

/** The companion's consolidated episodic memories, most recent first. */
export async function listEpisodes(companionId: string): Promise<EpisodeDto[]> {
  const body = await request<{ episodes: EpisodeDto[] }>(`/companions/${companionId}/episodes`);
  return body.episodes;
}

/** Recall episodes by topic (the browser's episodic recall window). */
export async function searchEpisodes(
  companionId: string,
  query: string,
): Promise<EpisodeSearchResultDto[]> {
  const body = await request<{ results: EpisodeSearchResultDto[] }>(
    `/companions/${companionId}/episodes/search`,
    { method: 'POST', body: JSON.stringify({ query }) },
  );
  return body.results;
}

/** The companion's pending approval queue (propose→approve, P3). */
export async function listProposals(companionId: string): Promise<ProposalDto[]> {
  const body = await request<{ proposals: ProposalDto[] }>(`/companions/${companionId}/proposals`);
  return body.proposals;
}

/**
 * Approve a held action. The companion executes it, then RE-ENTERS the agent
 * loop to narrate the outcome and continue the task, streamed back as SSE — so
 * approving "remember this and summarize it" yields the summary, not a dead
 * tool-result line. The streamed turn's rows land in the transcript.
 */
export async function* confirmProposal(
  companionId: string,
  proposalId: string,
): AsyncGenerator<ChatStreamEvent> {
  yield* stream(`/companions/${companionId}/proposals/${proposalId}/confirm`, { method: 'POST' });
}

/** Decline a held action (nothing executes). */
export async function rejectProposal(companionId: string, proposalId: string): Promise<void> {
  await send(`/companions/${companionId}/proposals/${proposalId}/reject`, { method: 'POST' });
}

/**
 * Tell the backend the user is present (Phase 4). The motivation engine reads
 * this volatile signal to decide whether/how to initiate. Fire-and-forget.
 */
export async function sendHeartbeat(companionId: string, tabVisible: boolean): Promise<void> {
  await send(`/companions/${companionId}/heartbeat`, {
    method: 'POST',
    body: JSON.stringify({ tabVisible }),
  });
}

/** The companion's reading list — leads it discovered but hasn't acted on (P3). */
export async function listLeads(companionId: string): Promise<LeadDto[]> {
  const body = await request<{ leads: LeadDto[] }>(`/companions/${companionId}/leads`);
  return body.leads;
}

/** "Go through your reading list": propose remembering the next leads. */
export async function explore(companionId: string): Promise<ProposalDto[]> {
  const body = await request<{ proposals: ProposalDto[] }>(`/companions/${companionId}/explore`, {
    method: 'POST',
  });
  return body.proposals;
}

/** The companion's learned, reusable workflows (procedural memory, P3). */
export async function listProcedures(companionId: string): Promise<ProcedureDto[]> {
  const body = await request<{ procedures: ProcedureDto[] }>(
    `/companions/${companionId}/procedures`,
  );
  return body.procedures;
}

/** Send a message and yield streamed chat events (SSE). */
export async function* sendMessage(
  companionId: string,
  content: string,
): AsyncGenerator<ChatStreamEvent> {
  yield* stream(`/companions/${companionId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content }),
  });
}

/**
 * Ask the companion to react to the user's arrival (Phase 14). Yields a
 * `composing` cue (→ typing indicator) then the voiced greeting as `done`, or no
 * events when the gate decides to stay quiet. Opened on mount and on tab-return.
 */
export async function* streamGreeting(companionId: string): AsyncGenerator<ChatStreamEvent> {
  yield* stream(`/companions/${companionId}/greeting`, { method: 'POST' });
}

/**
 * Subscribe to the standing companion event channel (architecture.md §6): yields
 * each transcript row the server pushes (`{ type: 'message' }`) — a turn reply, an
 * ingestion note, a greeting — for as long as the connection stays open. `signal`
 * cancels the underlying fetch (the caller aborts it on unmount), and an abort
 * ends the generator quietly rather than surfacing as an error; the caller owns
 * any reconnect. GET (no side effects); the bearer rides the `Authorization`
 * header via `send`, so no `EventSource` cookie workaround is needed.
 */
export async function* subscribeMessages(
  companionId: string,
  signal: AbortSignal,
): AsyncGenerator<MessageDto> {
  let response: Response;
  try {
    response = await send(`/companions/${companionId}/events`, { method: 'GET', signal });
  } catch (error) {
    if (signal.aborted) return; // an unmount/abort is a clean stop, not a failure
    throw error;
  }
  if (!response.body) throw new Error('event channel response has no body');
  try {
    for await (const payload of readSseData(response)) {
      const event = JSON.parse(payload) as CompanionStreamEvent;
      if (event.type === 'message') yield event.message;
    }
  } catch (error) {
    if (signal.aborted) return;
    throw error;
  }
}

/**
 * Yield the JSON payload of each `data:` SSE frame from a `text/event-stream`
 * body. Splits on the `\n\n` frame boundary, carries any partial trailing frame
 * across reads, and skips non-`data:` lines (e.g. the standing channel's `: ping`
 * heartbeat comments). Shared by the per-turn parser and the channel subscription.
 */
async function* readSseData(response: Response): AsyncGenerator<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const line = frame.trim();
      if (!line.startsWith('data:')) continue;
      yield line.slice('data:'.length).trim();
    }
  }
}

/** Parse a `text/event-stream` body into chat events (shared by chat + confirm). */
async function* readSse(response: Response): AsyncGenerator<ChatStreamEvent> {
  for await (const payload of readSseData(response)) {
    yield JSON.parse(payload) as ChatStreamEvent;
  }
}
