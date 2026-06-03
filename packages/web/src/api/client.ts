import type {
  ChatStreamEvent,
  CompanionDto,
  CreateCompanionBody,
  MemorySnapshotDto,
  MessageDto,
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const auth = await authHeaders();
  // Only declare a JSON content-type when there's a body — Fastify rejects an
  // empty body with content-type: application/json (FST_ERR_CTP_EMPTY_JSON_BODY),
  // which would otherwise 400 bodyless requests (e.g. a GET, or a bodyless POST).
  const contentType = init?.body != null ? { 'content-type': 'application/json' } : {};
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { ...contentType, ...auth, ...(init?.headers ?? {}) },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `request failed (${response.status})`);
  }
  return (await response.json()) as T;
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

/** Send a message and yield streamed chat events (SSE). */
export async function* sendMessage(
  companionId: string,
  content: string,
): AsyncGenerator<ChatStreamEvent> {
  const auth = await authHeaders();
  const response = await fetch(`${API_URL}/companions/${companionId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify({ content }),
  });
  if (!response.ok || !response.body) {
    throw new Error(`message failed (${response.status})`);
  }

  const reader = response.body.getReader();
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
      const payload = line.slice('data:'.length).trim();
      yield JSON.parse(payload) as ChatStreamEvent;
    }
  }
}
