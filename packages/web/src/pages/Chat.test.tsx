/**
 * Chat tests: transcript resume, failure handling, and grounded-turn citation
 * rendering from the streamed citations event.
 */

import type { ChatStreamEvent, CompanionDto, MessageDto } from '@cobble/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchMessages, sendMessage } from '../api/client.js';
import { Chat } from './Chat.js';

const companion: CompanionDto = {
  id: 'companion-1',
  name: 'Pebble',
  form: 'fox',
  temperament: 'curious and warm',
  createdAt: '2026-01-01T00:00:00.000Z',
};

const history: MessageDto[] = [
  {
    id: 'm1',
    companionId: companion.id,
    role: 'user',
    content: 'hello again',
    createdAt: '2026-01-03T00:00:01.000Z',
  },
  {
    id: 'm2',
    companionId: companion.id,
    role: 'assistant',
    content: 'welcome back',
    createdAt: '2026-01-03T00:00:02.000Z',
  },
];

vi.mock('../api/client.js', () => ({
  fetchMessages: vi.fn(),
  sendMessage: vi.fn(async function* () {}),
  // The usage badge polls this; reject so it stays hidden in these tests.
  getUsage: vi.fn(() => Promise.reject(new Error('no usage'))),
}));

function renderChat(): void {
  render(
    <Chat
      companion={companion}
      onSignOut={() => {}}
      onOpenMemory={() => {}}
      onOpenSources={() => {}}
    />,
  );
}

describe('Chat mount', () => {
  beforeEach(() => {
    vi.mocked(fetchMessages).mockReset();
    vi.mocked(sendMessage).mockReset();
  });

  it('resumes the companion transcript on open', async () => {
    vi.mocked(fetchMessages).mockResolvedValue(history);

    renderChat();

    await waitFor(() => expect(screen.getByText('welcome back')).toBeTruthy());
    expect(screen.getByText('hello again')).toBeTruthy();
    // It loads the one continuous transcript, keyed by companion alone.
    expect(fetchMessages).toHaveBeenCalledWith(companion.id);
  });

  it('starts empty for a companion with no history', async () => {
    vi.mocked(fetchMessages).mockResolvedValue([]);

    renderChat();

    await waitFor(() => expect(fetchMessages).toHaveBeenCalledWith(companion.id));
    expect(screen.queryByText('welcome back')).toBeNull();
  });

  it('surfaces an error and keeps the composer disabled when the transcript fails to load', async () => {
    vi.mocked(fetchMessages).mockRejectedValue(new Error('network down'));

    renderChat();

    // The failure message is shown to the user rather than a half-started chat.
    await waitFor(() => expect(screen.getByText('network down')).toBeTruthy());
    // The composer stays disabled because the transcript never became ready.
    expect((screen.getByPlaceholderText(/Message Pebble/) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('Chat grounded turns', () => {
  beforeEach(() => {
    vi.mocked(fetchMessages).mockReset().mockResolvedValue([]);
    vi.mocked(sendMessage).mockReset();
  });

  it('renders the citations chip under a grounded assistant reply', async () => {
    const events: ChatStreamEvent[] = [
      {
        type: 'citations',
        citations: [
          {
            sourceId: 's1',
            sourceTitle: 'Peru: A Culinary History',
            chapterTitle: null,
            topicTitle: 'Ceviche origins',
            paraStart: 12,
            paraEnd: 18,
            pageStart: 41,
            pageEnd: 42,
          },
        ],
      },
      { type: 'token', value: 'Ceviche is cured with lime.' },
      {
        type: 'done',
        message: {
          id: 'm3',
          companionId: companion.id,
          role: 'assistant',
          content: 'Ceviche is cured with lime.',
          createdAt: '2026-01-03T00:00:03.000Z',
        },
      },
    ];
    vi.mocked(sendMessage).mockImplementation(async function* () {
      yield* events;
    });

    renderChat();
    await waitFor(() =>
      expect((screen.getByPlaceholderText(/Message Pebble/) as HTMLInputElement).disabled).toBe(
        false,
      ),
    );

    fireEvent.change(screen.getByPlaceholderText(/Message Pebble/), {
      target: { value: 'how is ceviche made?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(screen.getByText('Ceviche is cured with lime.')).toBeTruthy());
    expect(
      screen.getByText(/Grounded in:.*Peru: A Culinary History \(para 12–18, p\. 41\)/),
    ).toBeTruthy();
  });

  it('shows no citation chip for an ungrounded reply', async () => {
    vi.mocked(sendMessage).mockImplementation(async function* () {
      yield { type: 'token', value: 'Just chatting!' } as ChatStreamEvent;
    });

    renderChat();
    await waitFor(() =>
      expect((screen.getByPlaceholderText(/Message Pebble/) as HTMLInputElement).disabled).toBe(
        false,
      ),
    );

    fireEvent.change(screen.getByPlaceholderText(/Message Pebble/), {
      target: { value: 'hi' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(screen.getByText('Just chatting!')).toBeTruthy());
    expect(screen.queryByText(/Grounded in:/)).toBeNull();
  });
});

describe('Chat send finalization', () => {
  beforeEach(() => {
    vi.mocked(fetchMessages).mockReset().mockResolvedValue([]);
    vi.mocked(sendMessage).mockReset();
  });

  it('replaces the streamed content with the persisted done.message', async () => {
    // Tokens build a partial reply; the authoritative `done.message.content`
    // (here trimmed/corrected by the server) replaces it verbatim.
    const events: ChatStreamEvent[] = [
      { type: 'token', value: 'partial ' },
      { type: 'token', value: 'draft' },
      {
        type: 'done',
        message: {
          id: 'm-final',
          companionId: companion.id,
          role: 'assistant',
          content: 'Final authoritative answer.',
          createdAt: '2026-01-03T00:00:03.000Z',
        },
      },
    ];
    vi.mocked(sendMessage).mockImplementation(async function* () {
      yield* events;
    });

    renderChat();
    await waitFor(() =>
      expect((screen.getByPlaceholderText(/Message Pebble/) as HTMLInputElement).disabled).toBe(
        false,
      ),
    );

    fireEvent.change(screen.getByPlaceholderText(/Message Pebble/), {
      target: { value: 'question' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(screen.getByText('Final authoritative answer.')).toBeTruthy());
    // The streamed-only text is gone — the persisted content won.
    expect(screen.queryByText('partial draft')).toBeNull();
  });

  it('surfaces the error and removes the empty bubble when a send throws', async () => {
    vi.mocked(sendMessage).mockImplementation(
      // A network/parse failure mid-stream before any token arrives.
      async function* (): AsyncGenerator<ChatStreamEvent> {
        throw new Error('stream interrupted');
      },
    );

    renderChat();
    await waitFor(() =>
      expect((screen.getByPlaceholderText(/Message Pebble/) as HTMLInputElement).disabled).toBe(
        false,
      ),
    );

    fireEvent.change(screen.getByPlaceholderText(/Message Pebble/), {
      target: { value: 'will fail' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    // The failure is surfaced to the user...
    await waitFor(() => expect(screen.getByText('stream interrupted')).toBeTruthy());
    // ...the composer is re-enabled (busy reset)...
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    // ...the user's line stays, and exactly one transcript line remains: no
    // empty assistant bubble was left behind.
    expect(screen.getByText('will fail')).toBeTruthy();
    expect(document.querySelectorAll('.transcript .line').length).toBe(1);
    expect(document.querySelector('.transcript .line.assistant')).toBeNull();
  });
});
