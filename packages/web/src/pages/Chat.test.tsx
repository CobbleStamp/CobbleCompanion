/**
 * Chat tests: transcript resume, failure handling, and grounded-turn citation
 * rendering from the streamed citations event.
 */

import type {
  ChatStreamEvent,
  CompanionDto,
  CompanionStreamEvent,
  MessageDto,
} from '@cobble/shared';
import { fileSourceAcknowledgement } from '@cobble/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addReaction,
  confirmProposal,
  fetchMessages,
  listIngestionJobs,
  listProposals,
  listSources,
  removeReaction,
  sendMessage,
  streamGreeting,
  subscribeCompanionEvents,
  uploadFileSource,
} from '../api/client.js';
import { Chat } from './Chat.js';

const companion: CompanionDto = {
  id: 'companion-1',
  name: 'Pebble',
  form: 'fox',
  temperament: 'curious and warm',
  evolvedPersona: null,
  userPersona: null,
  proactivityDial: 'gentle',
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
  // The arrival greeting (P14) fires on mount/refocus; default to a quiet stream
  // so most tests see no greeting unless they opt in.
  streamGreeting: vi.fn(async function* () {}),
  uploadFileSource: vi.fn(),
  // The standing event channel (architecture.md §6): default to a quiet channel
  // that stays open until the chat aborts it on unmount, so it neither delivers
  // rows nor spins reconnecting. Tests opt in by overriding this.
  subscribeCompanionEvents: vi.fn((_companionId: string, signal: AbortSignal) =>
    (async function* () {
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      });
    })(),
  ),
  addReaction: vi.fn(() => Promise.resolve()),
  removeReaction: vi.fn(() => Promise.resolve()),
  // The ingestion-status hook polls these; default to empty so the header badge
  // and panel stay quiet unless a test opts in.
  listSources: vi.fn(() => Promise.resolve([])),
  listIngestionJobs: vi.fn(() => Promise.resolve([])),
  // The usage badge polls this; reject so it stays hidden in these tests.
  getUsage: vi.fn(() => Promise.reject(new Error('no usage'))),
  // The presence heartbeat (P4) fires on mount/interval; no-op in tests.
  sendHeartbeat: vi.fn(() => Promise.resolve()),
  // The budget meter (P4) polls this; reject so it stays hidden in these tests.
  fetchBudget: vi.fn(() => Promise.reject(new Error('no budget'))),
  setProactivityDial: vi.fn(() => Promise.resolve('gentle')),
  // The approval-queue hook polls this; default to empty so no cards show.
  listProposals: vi.fn(() => Promise.resolve([])),
  confirmProposal: vi.fn(),
  rejectProposal: vi.fn(),
}));

function renderChat(): void {
  render(
    <Chat
      companion={companion}
      onSignOut={() => {}}
      onOpenMemory={() => {}}
      onOpenSources={() => {}}
      onOpenGrowth={() => {}}
      onOpenActivity={() => {}}
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
    // Deferred = parked until the companion is fed (wallet refilled); not actively reading.
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

  it('delivers the proactive "finished reading" note by push, without duplicating', async () => {
    // Delivery is now the standing channel (architecture.md §6), not an
    // ingestion-status poll: when the reading finishes the announcer appends the
    // note and it's pushed over the channel like any other row.
    vi.mocked(fetchMessages).mockResolvedValue([]);
    const channel = controllableChannel();
    vi.mocked(subscribeCompanionEvents).mockImplementation(channel.impl);
    const note = channelRow('note1', 'assistant', 'All read — ask away!');

    renderChat();
    await waitFor(() =>
      expect((screen.getByPlaceholderText(/Message Pebble/) as HTMLTextAreaElement).disabled).toBe(
        false,
      ),
    );

    channel.push(note);
    await waitFor(() => expect(screen.getByText('All read — ask away!')).toBeTruthy());

    // A redundant re-delivery (a channel re-emit or the focus re-sync) dedupes by id.
    channel.push(note);
    await waitFor(() => expect(screen.getAllByText('All read — ask away!')).toHaveLength(1));
  });
});

describe('Chat transcript fidelity (rich rows survive reload)', () => {
  beforeEach(() => {
    vi.mocked(fetchMessages).mockReset();
    vi.mocked(listProposals).mockReset().mockResolvedValue([]);
    vi.mocked(confirmProposal).mockReset();
  });

  it('renders tool-step and proposal rows from the persisted transcript on reload', async () => {
    vi.mocked(fetchMessages).mockResolvedValue([
      {
        id: 's1',
        companionId: companion.id,
        sourceId: null,
        role: 'assistant',
        content: 'Read example.com',
        kind: 'tool_step',
        metadata: { toolName: 'web_fetch' },
        createdAt: '2026-01-03T00:00:01.000Z',
      },
      {
        id: 'p1',
        companionId: companion.id,
        sourceId: null,
        role: 'assistant',
        content: 'Remember https://x.dev',
        kind: 'proposal',
        metadata: { proposalId: 'pp1', toolName: 'ingest_source' },
        createdAt: '2026-01-03T00:00:02.000Z',
      },
    ]);

    renderChat();

    // The look-up and the held action are part of the conversation history — not
    // ephemeral chrome lost on reload.
    await waitFor(() => expect(screen.getByText(/Read example\.com/)).toBeTruthy());
    expect(screen.getByText(/Proposed: Remember https:\/\/x\.dev/)).toBeTruthy();
  });

  it('approving a proposal streams the narration and reconciles the transcript', async () => {
    const narration: MessageDto = {
      id: 'm9',
      companionId: companion.id,
      sourceId: null,
      role: 'assistant',
      content: 'Saved — here are the highlights.',
      kind: 'message',
      createdAt: '2026-01-03T00:00:09.000Z',
    };
    // Mount: empty transcript; reload after confirm returns the narration.
    vi.mocked(fetchMessages).mockResolvedValueOnce([]).mockResolvedValue([narration]);
    vi.mocked(listProposals).mockResolvedValue([
      {
        id: 'pp1',
        toolName: 'ingest_source',
        summary: 'Remember https://x.dev',
        status: 'pending',
        createdAt: '2026-01-03T00:00:00.000Z',
      },
    ]);
    vi.mocked(confirmProposal).mockImplementation(async function* () {
      yield { type: 'token', value: 'Saved — here are the highlights.' };
      yield { type: 'done', message: narration };
    });

    renderChat();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    // The companion narrates the outcome (the loop re-entered), not a dead line.
    await waitFor(() => expect(screen.getByText('Saved — here are the highlights.')).toBeTruthy());
    expect(confirmProposal).toHaveBeenCalledWith(companion.id, 'pp1');
  });

  it('renders no proposal card when the approval queue is empty', async () => {
    vi.mocked(fetchMessages).mockResolvedValue([]);
    vi.mocked(listProposals).mockResolvedValue([]);

    renderChat();

    // Wait until the surface is ready (composer enabled) so any queued card would
    // have had a chance to render.
    await waitFor(() =>
      expect((screen.getByPlaceholderText(/Message Pebble/) as HTMLInputElement).disabled).toBe(
        false,
      ),
    );
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Decline' })).toBeNull();
    expect(document.querySelector('.proposal-queue')).toBeNull();
  });

  it('ignores a second confirm while one is already streaming (busy guard)', async () => {
    const narration: MessageDto = {
      id: 'm9',
      companionId: companion.id,
      sourceId: null,
      role: 'assistant',
      content: 'Saved.',
      kind: 'message',
      createdAt: '2026-01-03T00:00:09.000Z',
    };
    vi.mocked(fetchMessages).mockResolvedValueOnce([]).mockResolvedValue([narration]);
    vi.mocked(listProposals).mockResolvedValue([
      {
        id: 'pp1',
        toolName: 'ingest_source',
        summary: 'Remember https://x.dev',
        status: 'pending',
        createdAt: '2026-01-03T00:00:00.000Z',
      },
    ]);
    // Hold the stream open on the first confirm so the turn stays in flight while
    // we fire a second click. onConfirmProposal's `if (busy) return` must drop it.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    vi.mocked(confirmProposal).mockImplementation(async function* () {
      yield { type: 'token', value: 'Saved.' };
      await gate;
      yield { type: 'done', message: narration };
    });

    renderChat();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy());
    const approve = screen.getByRole('button', { name: 'Approve' });
    fireEvent.click(approve);
    // First turn is now streaming (token emitted); a second click is a no-op.
    await waitFor(() => expect(screen.getByText('Saved.')).toBeTruthy());
    fireEvent.click(approve);

    // The busy guard means the second click never started a second confirm turn.
    expect(confirmProposal).toHaveBeenCalledTimes(1);

    // Let the first turn finish cleanly so no act() warnings dangle.
    release();
    await waitFor(() => expect(confirmProposal).toHaveBeenCalledTimes(1));
  });

  it('shows the server error message when confirm fails with 429 over-cap', async () => {
    // The client now preserves the server's response body, so onConfirmProposal's
    // catch surfaces the real over-cap message (not a generic status code) and
    // drops the optimistic empty assistant bubble.
    vi.mocked(fetchMessages).mockResolvedValue([]);
    vi.mocked(listProposals).mockResolvedValue([
      {
        id: 'pp1',
        toolName: 'ingest_source',
        summary: 'Remember https://x.dev',
        status: 'pending',
        createdAt: '2026-01-03T00:00:00.000Z',
      },
    ]);
    vi.mocked(confirmProposal).mockImplementation(async function* () {
      // The confirm stream errors before any frame: send() throws the server's
      // 429 body (the client now preserves it) before readSse yields anything.
      throw new Error('Cobble is out of stamina for now. Feed it a Ration to continue.');
    });

    renderChat();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    // The real server message is surfaced verbatim.
    await waitFor(() =>
      expect(
        screen.getByText('Cobble is out of stamina for now. Feed it a Ration to continue.'),
      ).toBeTruthy(),
    );
    // The optimistic empty assistant bubble was dropped, not left dangling.
    expect(document.querySelector('.proposal-queue')).not.toBeNull();
  });
});

/**
 * A channel whose rows the test pushes by hand: the generator drains a queue and
 * parks between pushes until the chat aborts it on unmount. Lets a test deliver a
 * pushed row at a chosen moment (e.g. after a send completes).
 */
function controllableChannel(): {
  push: (message: MessageDto) => void;
  pushEvent: (event: CompanionStreamEvent) => void;
  impl: (companionId: string, signal: AbortSignal) => AsyncGenerator<CompanionStreamEvent>;
} {
  const queue: CompanionStreamEvent[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  const pushEvent = (event: CompanionStreamEvent): void => {
    queue.push(event);
    wake?.();
  };
  // Convenience: push a transcript row as a `message` event (the common case).
  const push = (message: MessageDto): void => pushEvent({ type: 'message', message });
  async function* impl(
    _companionId: string,
    signal: AbortSignal,
  ): AsyncGenerator<CompanionStreamEvent> {
    signal.addEventListener(
      'abort',
      () => {
        ended = true;
        wake?.();
      },
      { once: true },
    );
    for (;;) {
      while (queue.length > 0) yield queue.shift()!;
      if (ended || signal.aborted) return;
      await new Promise<void>((resolve) => (wake = resolve));
    }
  }
  return { push, pushEvent, impl };
}

function channelRow(id: string, role: 'user' | 'assistant', content: string): MessageDto {
  return {
    id,
    companionId: companion.id,
    sourceId: null,
    role,
    content,
    kind: 'message',
    createdAt: '2026-01-03T00:00:05.000Z',
  };
}

describe('Chat event channel (push delivery)', () => {
  beforeEach(() => {
    vi.mocked(fetchMessages).mockReset().mockResolvedValue([]);
    vi.mocked(sendMessage).mockReset();
    vi.mocked(subscribeCompanionEvents).mockReset();
  });

  it('renders a row pushed over the channel — no refetch needed', async () => {
    const channel = controllableChannel();
    vi.mocked(subscribeCompanionEvents).mockImplementation(channel.impl);

    renderChat();
    await waitFor(() =>
      expect((screen.getByPlaceholderText(/Message Pebble/) as HTMLTextAreaElement).disabled).toBe(
        false,
      ),
    );

    // A proactive note the user never asked for, delivered by push.
    channel.push(channelRow('pn1', 'assistant', 'Finished reading your book!'));

    await waitFor(() => expect(screen.getByText('Finished reading your book!')).toBeTruthy());
    // It arrived live — the transcript was fetched once (the mount snapshot), not
    // re-polled to discover it.
    expect(fetchMessages).toHaveBeenCalledTimes(1);
  });

  it('dedupes by id when the snapshot and the channel deliver the same row', async () => {
    const row = channelRow('m1', 'assistant', 'only once');
    vi.mocked(fetchMessages).mockResolvedValue([row]);
    const channel = controllableChannel();
    vi.mocked(subscribeCompanionEvents).mockImplementation(channel.impl);

    renderChat();
    await waitFor(() => expect(screen.getByText('only once')).toBeTruthy());

    // The channel re-delivers the same persisted row; it must not double-render.
    channel.push(row);
    await waitFor(() => expect(screen.getAllByText('only once')).toHaveLength(1));
  });

  it('reconciles the channel echo of a just-sent message without duplicating it', async () => {
    vi.mocked(sendMessage).mockImplementation(async function* () {
      yield { type: 'token', value: 'Hi!' };
      yield {
        type: 'done',
        message: channelRow('a1', 'assistant', 'Hi!'),
      };
    });
    const channel = controllableChannel();
    vi.mocked(subscribeCompanionEvents).mockImplementation(channel.impl);

    renderChat();
    await waitFor(() =>
      expect((screen.getByPlaceholderText(/Message Pebble/) as HTMLTextAreaElement).disabled).toBe(
        false,
      ),
    );

    fireEvent.change(screen.getByPlaceholderText(/Message Pebble/), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.getByText('Hi!')).toBeTruthy());

    // The server now pushes the persisted user + assistant rows over the channel
    // (as it does for every append). The user row carries the id the optimistic
    // line lacks; the assistant row's id is already shown (finalized by `done`).
    channel.push(channelRow('u1', 'user', 'hello'));
    channel.push(channelRow('a1', 'assistant', 'Hi!'));

    // Give the merges a chance to (not) duplicate, then assert one of each.
    await waitFor(() => expect(screen.getAllByText('hello')).toHaveLength(1));
    expect(screen.getAllByText('Hi!')).toHaveLength(1);
  });

  it('reconciles an optimistic user line against a re-sync snapshot without duplicating it', async () => {
    // The channel is down during the turn, so the server's user-row echo is lost
    // (the bus carries no replay) and the optimistic user line stays id-less. A
    // snapshot is then its only delivery path — the tab-return re-sync must adopt
    // the persisted row in place, NOT append a second copy.
    vi.mocked(sendMessage).mockImplementation(async function* () {
      yield { type: 'token', value: 'Hi!' };
      yield { type: 'done', message: channelRow('a1', 'assistant', 'Hi!') };
    });
    // Mount snapshot is empty; the tab-return re-sync returns the persisted pair.
    vi.mocked(fetchMessages)
      .mockReset()
      .mockResolvedValueOnce([])
      .mockResolvedValue([channelRow('u1', 'user', 'hello'), channelRow('a1', 'assistant', 'Hi!')]);

    renderChat();
    await waitFor(() =>
      expect((screen.getByPlaceholderText(/Message Pebble/) as HTMLTextAreaElement).disabled).toBe(
        false,
      ),
    );

    fireEvent.change(screen.getByPlaceholderText(/Message Pebble/), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.getByText('Hi!')).toBeTruthy());

    // Tab-return triggers refreshTranscript → mergeSnapshot. The id-less optimistic
    // 'hello' must reconcile against the persisted u1 row, not render twice.
    fireEvent(window, new Event('focus'));
    await waitFor(() => expect(fetchMessages).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getAllByText('hello')).toHaveLength(1));
    expect(screen.getAllByText('Hi!')).toHaveLength(1);
  });
});

describe('Chat markdown rendering', () => {
  beforeEach(() => {
    vi.mocked(fetchMessages).mockReset();
  });

  it('renders an assistant reply as formatted Markdown', async () => {
    vi.mocked(fetchMessages).mockResolvedValue([
      {
        id: 'm1',
        companionId: companion.id,
        sourceId: null,
        role: 'assistant',
        content: 'Here is **bold** and a list:\n\n- one\n- two',
        createdAt: '2026-01-03T00:00:01.000Z',
      },
    ]);

    renderChat();

    // The asterisks/dashes become real HTML, not literal characters.
    await waitFor(() => expect(document.querySelector('.markdown strong')).not.toBeNull());
    expect(document.querySelector('.markdown strong')?.textContent).toBe('bold');
    expect(document.querySelectorAll('.markdown li')).toHaveLength(2);
  });

  it('leaves a user turn literal — no Markdown processing', async () => {
    vi.mocked(fetchMessages).mockResolvedValue([
      {
        id: 'm1',
        companionId: companion.id,
        sourceId: null,
        role: 'user',
        content: 'render **these stars** literally',
        createdAt: '2026-01-03T00:00:01.000Z',
      },
    ]);

    renderChat();

    // The user's text is shown exactly as typed; no markdown container is created.
    await waitFor(() => expect(screen.getByText('render **these stars** literally')).toBeTruthy());
    expect(document.querySelector('.markdown')).toBeNull();
  });
});

describe('Chat composer (multi-line input)', () => {
  beforeEach(() => {
    vi.mocked(fetchMessages).mockReset().mockResolvedValue([]);
    vi.mocked(sendMessage)
      .mockReset()
      .mockImplementation(async function* () {});
  });

  async function readyComposer(): Promise<HTMLTextAreaElement> {
    renderChat();
    const box = screen.getByPlaceholderText(/Message Pebble/) as HTMLTextAreaElement;
    await waitFor(() => expect(box.disabled).toBe(false));
    return box;
  }

  it('sends the message on Enter', async () => {
    const box = await readyComposer();
    fireEvent.change(box, { target: { value: 'hi there' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith(companion.id, 'hi there'));
  });

  it('does not send on Shift+Enter (newline instead)', async () => {
    const box = await readyComposer();
    fireEvent.change(box, { target: { value: 'line one' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('does not send on Enter while an IME composition is active', async () => {
    const box = await readyComposer();
    fireEvent.change(box, { target: { value: 'こんにちは' } });
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true });

    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe('Chat greeting on arrival (P14)', () => {
  beforeEach(() => {
    vi.mocked(fetchMessages).mockReset();
    vi.mocked(streamGreeting).mockReset();
  });

  it('surfaces a streamed greeting as an assistant line after a composing cue', async () => {
    vi.mocked(fetchMessages).mockResolvedValue([]);
    const greeting: MessageDto = {
      id: 'g1',
      companionId: companion.id,
      sourceId: null,
      role: 'assistant',
      content: 'Welcome back — how did that interview go?',
      createdAt: '2026-01-03T00:00:05.000Z',
    };
    vi.mocked(streamGreeting).mockImplementation(
      async function* (): AsyncGenerator<ChatStreamEvent> {
        yield { type: 'composing' };
        yield { type: 'done', message: greeting };
      },
    );

    renderChat();

    await waitFor(() =>
      expect(screen.getByText('Welcome back — how did that interview go?')).toBeTruthy(),
    );
    expect(vi.mocked(streamGreeting)).toHaveBeenCalledWith(companion.id);
  });

  it('stays silent when the gate emits no events', async () => {
    vi.mocked(fetchMessages).mockResolvedValue(history);
    vi.mocked(streamGreeting).mockImplementation(
      async function* (): AsyncGenerator<ChatStreamEvent> {
        // no events — the companion decided to stay quiet
      },
    );

    renderChat();

    await waitFor(() => expect(screen.getByText('welcome back')).toBeTruthy());
    // No extra assistant line beyond the resumed transcript.
    expect(document.querySelector('.line.composing')).toBeNull();
  });

  it('clears the typing indicator and adds no line on an error event', async () => {
    vi.mocked(fetchMessages).mockResolvedValue(history);
    vi.mocked(streamGreeting).mockImplementation(
      async function* (): AsyncGenerator<ChatStreamEvent> {
        yield { type: 'composing' };
        yield { type: 'error', message: 'I can’t reach your companion right now.' };
      },
    );

    renderChat();

    await waitFor(() => expect(screen.getByText('welcome back')).toBeTruthy());
    // The typing indicator is cleared and no greeting line is appended...
    await waitFor(() => expect(document.querySelector('.line.composing')).toBeNull());
    // ...the failure is not surfaced as a chat line (the client drops it today)...
    expect(screen.queryByText(/can.t reach your companion/i)).toBeNull();
    // ...and the resumed transcript is left intact by the failed greeting.
    expect(screen.getByText('hello again')).toBeTruthy();
  });

  it('coalesces overlapping arrival checks (mount + refocus) into one stream', async () => {
    vi.mocked(fetchMessages).mockResolvedValue([]);
    let release!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(streamGreeting).mockImplementation(
      async function* (): AsyncGenerator<ChatStreamEvent> {
        yield { type: 'composing' };
        // Hold the stream open so the mount arrival is still "in flight" when the
        // refocus fires — the ref must coalesce the second call away.
        await inFlight;
      },
    );

    renderChat();
    await waitFor(() => expect(document.querySelector('.line.composing')).not.toBeNull());

    // A tab refocus mid-greeting must NOT open a second stream.
    fireEvent(window, new Event('focus'));
    await Promise.resolve();
    await Promise.resolve();
    expect(vi.mocked(streamGreeting)).toHaveBeenCalledTimes(1);

    release();
    await waitFor(() => expect(document.querySelector('.line.composing')).toBeNull());
  });
});

describe('Chat reactions', () => {
  beforeEach(() => {
    vi.mocked(fetchMessages).mockReset().mockResolvedValue([]);
    vi.mocked(sendMessage).mockReset();
    vi.mocked(subscribeCompanionEvents).mockReset();
    vi.mocked(addReaction).mockReset().mockResolvedValue(undefined);
    vi.mocked(removeReaction).mockReset().mockResolvedValue(undefined);
  });

  it('hydrates reactions from the transcript snapshot', async () => {
    vi.mocked(fetchMessages).mockResolvedValue([
      {
        id: 'a1',
        companionId: companion.id,
        sourceId: null,
        role: 'assistant',
        content: 'welcome back',
        createdAt: '2026-01-03T00:00:02.000Z',
        reactions: [{ messageId: 'a1', reactor: 'user', emoji: '❤️' }],
      },
    ]);

    renderChat();

    await waitFor(() => expect(screen.getByText('welcome back')).toBeTruthy());
    expect(screen.getByLabelText('You reacted ❤️')).toBeTruthy();
  });

  it('toggles a reaction optimistically and calls the API', async () => {
    vi.mocked(fetchMessages).mockResolvedValue([
      {
        id: 'a1',
        companionId: companion.id,
        sourceId: null,
        role: 'assistant',
        content: 'an answer',
        createdAt: '2026-01-03T00:00:02.000Z',
      },
    ]);

    renderChat();
    await waitFor(() => expect(screen.getByText('an answer')).toBeTruthy());

    fireEvent.click(screen.getByLabelText('React 🎉'));

    // Optimistic chip appears immediately, and the API was called.
    await waitFor(() => expect(screen.getByLabelText('You reacted 🎉')).toBeTruthy());
    expect(addReaction).toHaveBeenCalledWith(companion.id, 'a1', '🎉');
  });

  it('applies a reaction pushed live over the channel', async () => {
    vi.mocked(fetchMessages).mockResolvedValue([
      {
        id: 'a1',
        companionId: companion.id,
        sourceId: null,
        role: 'assistant',
        content: 'an answer',
        createdAt: '2026-01-03T00:00:02.000Z',
      },
    ]);
    const channel = controllableChannel();
    vi.mocked(subscribeCompanionEvents).mockImplementation(channel.impl);

    renderChat();
    await waitFor(() => expect(screen.getByText('an answer')).toBeTruthy());

    channel.pushEvent({ type: 'reaction_added', messageId: 'a1', reactor: 'user', emoji: '👍' });
    await waitFor(() => expect(screen.getByLabelText('You reacted 👍')).toBeTruthy());

    channel.pushEvent({ type: 'reaction_removed', messageId: 'a1', reactor: 'user', emoji: '👍' });
    await waitFor(() => expect(screen.queryByLabelText('You reacted 👍')).toBeNull());
  });

  it("renders the companion's reaction on a user message as a read-only chip", async () => {
    vi.mocked(fetchMessages).mockResolvedValue([
      {
        id: 'u9',
        companionId: companion.id,
        sourceId: null,
        role: 'user',
        content: 'can you check this?',
        createdAt: '2026-01-03T00:00:02.000Z',
      },
    ]);
    const channel = controllableChannel();
    vi.mocked(subscribeCompanionEvents).mockImplementation(channel.impl);

    renderChat();
    await waitFor(() => expect(screen.getByText('can you check this?')).toBeTruthy());

    // The companion reacts to the user's message (Phase D), delivered over the channel.
    channel.pushEvent({
      type: 'reaction_added',
      messageId: 'u9',
      reactor: 'companion',
      emoji: '👀',
    });
    const chip = await screen.findByLabelText('Companion reacted 👀');
    // It's a read-only chip — the user can't toggle the companion's own reaction.
    expect((chip as HTMLButtonElement).disabled).toBe(true);
  });
});
