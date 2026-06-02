import type {
  ChatStreamEvent,
  CompanionDto,
  ConversationDto,
  CreateCompanionBody,
  MessageDto,
} from '@cobble/shared';

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? '';

export interface CurrentUser {
  readonly id: string;
  readonly email: string;
}

/**
 * Returns an Auth0 access token (or null when auth is bypassed). Wired up by
 * <AuthBridge/> once Auth0 is ready, so the client need not import the SDK.
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
  const response = await fetch(`${API_URL}${path}`, {
    headers: { 'content-type': 'application/json', ...auth },
    ...init,
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

export async function createConversation(companionId: string): Promise<ConversationDto> {
  const body = await request<{ conversation: ConversationDto }>(
    `/companions/${companionId}/conversations`,
    { method: 'POST' },
  );
  return body.conversation;
}

export async function fetchMessages(
  companionId: string,
  conversationId: string,
): Promise<MessageDto[]> {
  const body = await request<{ messages: MessageDto[] }>(
    `/companions/${companionId}/conversations/${conversationId}/messages`,
  );
  return body.messages;
}

/** Send a message and yield streamed chat events (SSE). */
export async function* sendMessage(
  companionId: string,
  conversationId: string,
  content: string,
): AsyncGenerator<ChatStreamEvent> {
  const auth = await authHeaders();
  const response = await fetch(
    `${API_URL}/companions/${companionId}/conversations/${conversationId}/messages`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({ content }),
    },
  );
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
