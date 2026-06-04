/**
 * Chat tests: transcript resume, failure handling, and grounded-turn citation
 * rendering from the streamed citations event.
 */

import type { ChatStreamEvent, CompanionDto, MessageDto } from '@cobble/shared';
import { fileSourceAcknowledgement } from '@cobble/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchMessages,
  listIngestionJobs,
  listSources,
  sendMessage,
  uploadFileSource,
} from '../api/client.js';
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
    sourceId: null,
    role: 'user',
    content: 'hello again',
    createdAt: '2026-01-03T00:00:01.000Z',
  },
  {
    id: 'm2',
    companionId: companion.id,
    sourceId: null,
    role: 'assistant',
    content: 'welcome back',
    createdAt: '2026-01-03T00:00:02.000Z',
  },
];

vi.mock('../api/client.js', () => ({
  fetchMessages: vi.fn(),
  sendMessage: vi.fn(async function* () {}),
  uploadFileSource: vi.fn(),
  // The ingestion-status hook polls these; default to empty so the header badge
  // and panel stay quiet unless a test opts in.
  listSources: vi.fn(() => Promise.resolve([])),
  listIngestionJobs: vi.fn(() => Promise.resolve([])),
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
          sourceId: null,
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
          sourceId: null,
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

describe('Chat attach file', () => {
  beforeEach(() => {
    vi.mocked(fetchMessages).mockReset().mockResolvedValue([]);
    vi.mocked(sendMessage).mockReset();
    vi.mocked(uploadFileSource).mockReset();
  });

  async function renderReady(): Promise<HTMLInputElement> {
    renderChat();
    await waitFor(() =>
      expect((screen.getByPlaceholderText(/Message Pebble/) as HTMLInputElement).disabled).toBe(
        false,
      ),
    );
    return screen.getByLabelText('Attach file source') as HTMLInputElement;
  }

  it('uploads the file and shows the attachment chip plus an acknowledgement', async () => {
    vi.mocked(uploadFileSource).mockResolvedValue({
      source: {
        id: 's1',
        kind: 'pdf',
        title: 'report.pdf',
        origin: null,
        byteSize: 1,
        createdAt: '2026-01-03T00:00:00.000Z',
      },
      job: {
        id: 'j1',
        sourceId: 's1',
        status: 'queued',
        sectionsTotal: 0,
        sectionsDone: 0,
        error: null,
      },
      messages: [
        {
          id: 'um1',
          companionId: companion.id,
          sourceId: 's1',
          role: 'user',
          content: 'report.pdf',
          createdAt: '2026-01-03T00:00:03.000Z',
        },
        {
          id: 'am1',
          companionId: companion.id,
          sourceId: 's1',
          role: 'assistant',
          content: fileSourceAcknowledgement('report.pdf'),
          createdAt: '2026-01-03T00:00:04.000Z',
        },
      ],
    });

    const fileInput = await renderReady();
    const file = new File(['x'], 'report.pdf', { type: 'application/pdf' });
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => expect(uploadFileSource).toHaveBeenCalledWith(companion.id, file));
    // The 📎 chip carries the filename...
    await waitFor(() => expect(screen.getByText(/📎 report\.pdf/)).toBeTruthy());
    // ...and the companion acknowledges it without an LLM round-trip.
    expect(screen.getByText(/reading through "report\.pdf" now/)).toBeTruthy();
    // The acknowledgement carries a link into the reading-status panel.
    fireEvent.click(screen.getByRole('button', { name: 'View status →' }));
    expect(screen.getByRole('dialog', { name: 'Reading status' })).toBeTruthy();
  });

  it('rejects an unsupported file type without uploading', async () => {
    const fileInput = await renderReady();
    const file = new File(['x'], 'notes.exe', { type: 'application/octet-stream' });
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => expect(screen.getByText(/Unsupported file type/)).toBeTruthy());
    expect(uploadFileSource).not.toHaveBeenCalled();
  });

  it('surfaces the error and removes the chip when the upload fails', async () => {
    vi.mocked(uploadFileSource).mockRejectedValue(new Error('upload failed (413)'));

    const fileInput = await renderReady();
    const file = new File(['x'], 'big.pdf', { type: 'application/pdf' });
    fireEvent.change(fileInput, { target: { files: [file] } });

    // The failure is surfaced...
    await waitFor(() => expect(screen.getByText('upload failed (413)')).toBeTruthy());
    // ...the optimistic attachment chip is gone...
    expect(screen.queryByText(/📎 big\.pdf/)).toBeNull();
    // ...and the composer is usable again (attaching reset).
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});

describe('Chat ingestion status indicator', () => {
  beforeEach(() => {
    vi.mocked(fetchMessages).mockReset().mockResolvedValue([]);
    vi.mocked(sendMessage).mockReset();
    vi.mocked(listSources).mockReset().mockResolvedValue([]);
    vi.mocked(listIngestionJobs).mockReset().mockResolvedValue([]);
  });

  it('shows the header indicator while a job is reading and opens the panel', async () => {
    vi.mocked(listSources).mockResolvedValue([
      {
        id: 's1',
        kind: 'pdf',
        title: 'report.pdf',
        origin: 'report.pdf',
        byteSize: 1,
        createdAt: '2026-01-03T00:00:00.000Z',
      },
    ]);
    vi.mocked(listIngestionJobs).mockResolvedValue([
      {
        id: 'j1',
        sourceId: 's1',
        status: 'enriching',
        sectionsTotal: 4,
        sectionsDone: 2,
        error: null,
      },
    ]);

    renderChat();

    const indicator = await screen.findByRole('button', { name: 'View ingestion status' });
    fireEvent.click(indicator);

    const dialog = screen.getByRole('dialog', { name: 'Reading status' });
    expect(dialog).toBeTruthy();
    // The panel reuses the Sources label and the joined source title.
    expect(screen.getByText('report.pdf')).toBeTruthy();
    expect(screen.getByText('enriching… 2/4 sections')).toBeTruthy();
  });

  it('hides the header indicator for a failed job but still surfaces it in the panel', async () => {
    // A settled failure is not "reading" — it must not drive the "Reading…" badge,
    // yet the user can still reach the failure detail via the upload acknowledgement.
    vi.mocked(listSources).mockResolvedValue([
      {
        id: 's1',
        kind: 'pdf',
        title: 'broken.pdf',
        origin: 'broken.pdf',
        byteSize: 1,
        createdAt: '2026-01-03T00:00:00.000Z',
      },
    ]);
    vi.mocked(listIngestionJobs).mockResolvedValue([
      {
        id: 'j1',
        sourceId: 's1',
        status: 'failed',
        sectionsTotal: 0,
        sectionsDone: 0,
        error: 'Cobble could not finish reading this source.',
      },
    ]);

    renderChat();

    await waitFor(() => expect(listIngestionJobs).toHaveBeenCalled());
    // No "Reading…" badge for a failed (terminal) job.
    expect(screen.queryByRole('button', { name: 'View ingestion status' })).toBeNull();
  });

  it('hides the header indicator for a deferred job', async () => {
    // Deferred = parked until the daily allowance resets; not actively reading.
    vi.mocked(listSources).mockResolvedValue([
      {
        id: 's1',
        kind: 'pdf',
        title: 'parked.pdf',
        origin: 'parked.pdf',
        byteSize: 1,
        createdAt: '2026-01-03T00:00:00.000Z',
      },
    ]);
    vi.mocked(listIngestionJobs).mockResolvedValue([
      {
        id: 'j1',
        sourceId: 's1',
        status: 'deferred',
        sectionsTotal: 0,
        sectionsDone: 0,
        error: null,
      },
    ]);

    renderChat();

    await waitFor(() => expect(listIngestionJobs).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'View ingestion status' })).toBeNull();
  });

  it('hides the header indicator when every job is done', async () => {
    vi.mocked(listSources).mockResolvedValue([
      {
        id: 's1',
        kind: 'pdf',
        title: 'report.pdf',
        origin: 'report.pdf',
        byteSize: 1,
        createdAt: '2026-01-03T00:00:00.000Z',
      },
    ]);
    vi.mocked(listIngestionJobs).mockResolvedValue([
      { id: 'j1', sourceId: 's1', status: 'done', sectionsTotal: 4, sectionsDone: 4, error: null },
    ]);

    renderChat();

    await waitFor(() => expect(listIngestionJobs).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'View ingestion status' })).toBeNull();
  });
});

describe('Chat upload-turn persistence and proactive notes', () => {
  beforeEach(() => {
    vi.mocked(fetchMessages).mockReset().mockResolvedValue([]);
    vi.mocked(sendMessage).mockReset();
    vi.mocked(listSources).mockReset().mockResolvedValue([]);
    vi.mocked(listIngestionJobs).mockReset().mockResolvedValue([]);
  });

  it('reconstructs the attachment chip and status link from the persisted transcript', async () => {
    // A reload: the upload turns come back from the transcript as real messages.
    vi.mocked(fetchMessages).mockResolvedValue([
      {
        id: 'u1',
        companionId: companion.id,
        sourceId: 's1',
        role: 'user',
        content: 'report.pdf',
        createdAt: '2026-01-03T00:00:01.000Z',
      },
      {
        id: 'a1',
        companionId: companion.id,
        sourceId: 's1',
        role: 'assistant',
        content: fileSourceAcknowledgement('report.pdf'),
        createdAt: '2026-01-03T00:00:02.000Z',
      },
    ]);

    renderChat();

    // The 📎 chip and the acknowledgement survive the reload...
    await waitFor(() => expect(screen.getByText(/📎 report\.pdf/)).toBeTruthy());
    expect(screen.getByText(/reading through "report\.pdf" now/)).toBeTruthy();
    // ...and the "View status →" link is reconstructed on the acknowledgement only.
    expect(screen.getAllByRole('button', { name: 'View status →' })).toHaveLength(1);
  });

  it('appends the proactive note when a reading finishes, without duplicating turns', async () => {
    vi.mocked(listSources).mockResolvedValue([
      {
        id: 's1',
        kind: 'pdf',
        title: 'report.pdf',
        origin: 'report.pdf',
        byteSize: 1,
        createdAt: '2026-01-03T00:00:00.000Z',
      },
    ]);
    // The job is reading on the first poll, then settles to done on the next.
    vi.mocked(listIngestionJobs)
      .mockResolvedValueOnce([
        {
          id: 'j1',
          sourceId: 's1',
          status: 'enriching',
          sectionsTotal: 4,
          sectionsDone: 2,
          error: null,
        },
      ])
      .mockResolvedValue([
        {
          id: 'j1',
          sourceId: 's1',
          status: 'done',
          sectionsTotal: 4,
          sectionsDone: 4,
          error: null,
        },
      ]);
    const note: MessageDto = {
      id: 'note1',
      companionId: companion.id,
      sourceId: null,
      role: 'assistant',
      content: 'All read — ask away!',
      createdAt: '2026-01-03T00:00:05.000Z',
    };
    // Mount transcript is empty; the refresh triggered by the job settling sees the note.
    vi.mocked(fetchMessages).mockReset().mockResolvedValueOnce([]).mockResolvedValue([note]);

    renderChat();

    // The note is pulled into the open chat once the job flips to done (next poll).
    await waitFor(() => expect(screen.getByText('All read — ask away!')).toBeTruthy(), {
      timeout: 4000,
    });
    // Merge-by-id: delivered exactly once, never duplicated by repeated fetches.
    expect(screen.getAllByText('All read — ask away!')).toHaveLength(1);
  });
});
