/**
 * Sources page tests: reading-progress headline, per-source job status, the
 * note intake form, and failure surfacing.
 */

import type { IngestionJobDto, SourceDto } from '@cobble/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLinkSource,
  createNoteSource,
  listIngestionJobs,
  listSources,
  uploadFileSource,
} from '../api/client.js';
import { Sources } from './Sources.js';

vi.mock('../api/client.js', () => ({
  listSources: vi.fn(),
  listIngestionJobs: vi.fn(),
  createNoteSource: vi.fn(),
  createLinkSource: vi.fn(),
  uploadFileSource: vi.fn(),
}));

const sources: SourceDto[] = [
  {
    id: 's1',
    kind: 'pdf',
    title: 'Peru: A Culinary History',
    origin: 'peru.pdf',
    byteSize: 1024,
    createdAt: '2026-06-01T00:00:00.000Z',
  },
  {
    id: 's2',
    kind: 'note',
    title: 'Trip ideas',
    origin: null,
    byteSize: 64,
    createdAt: '2026-06-02T00:00:00.000Z',
  },
];

const jobs: IngestionJobDto[] = [
  { id: 'j1', sourceId: 's1', status: 'done', sectionsTotal: 12, sectionsDone: 12, error: null },
  {
    id: 'j2',
    sourceId: 's2',
    status: 'enriching',
    sectionsTotal: 4,
    sectionsDone: 2,
    error: null,
  },
];

describe('Sources', () => {
  beforeEach(() => {
    vi.mocked(listSources).mockReset().mockResolvedValue(sources);
    vi.mocked(listIngestionJobs).mockReset().mockResolvedValue(jobs);
    vi.mocked(createNoteSource).mockReset();
    vi.mocked(createLinkSource).mockReset();
    vi.mocked(uploadFileSource).mockReset();
  });

  it('shows the reading-progress headline and per-source status', async () => {
    render(<Sources companionName="Pebble" companionId="companion-1" onBack={() => {}} />);

    await waitFor(() => expect(screen.getByText(/Pebble has read 1 of 2 sources/)).toBeTruthy());
    expect(screen.getByText('Peru: A Culinary History')).toBeTruthy();
    expect(screen.getByText(/read · 12 sections/)).toBeTruthy();
    expect(screen.getByText(/enriching… 2\/4 sections/)).toBeTruthy();
  });

  it('shows a failed job with its user-safe error', async () => {
    vi.mocked(listIngestionJobs).mockResolvedValue([
      {
        id: 'j1',
        sourceId: 's1',
        status: 'failed',
        sectionsTotal: 0,
        sectionsDone: 0,
        error: 'Cobble could not finish reading this source. Please try again.',
      },
    ]);
    vi.mocked(listSources).mockResolvedValue([sources[0]!]);

    render(<Sources companionName="Pebble" companionId="companion-1" onBack={() => {}} />);

    await waitFor(() => expect(screen.getByText(/failed: Cobble could not finish/)).toBeTruthy());
  });

  it('submits a note and refreshes the list', async () => {
    vi.mocked(createNoteSource).mockResolvedValue({
      source: sources[1]!,
      job: jobs[1]!,
    });

    render(<Sources companionName="Pebble" companionId="companion-1" onBack={() => {}} />);
    await waitFor(() => expect(listSources).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText('Note title'), { target: { value: 'Trip ideas' } });
    fireEvent.change(screen.getByLabelText('Note text'), {
      target: { value: 'Visit the plaza in Lima.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));

    await waitFor(() =>
      expect(createNoteSource).toHaveBeenCalledWith('companion-1', {
        title: 'Trip ideas',
        text: 'Visit the plaza in Lima.',
      }),
    );
    // The list refreshes after intake (initial load + post-submit).
    await waitFor(() => expect(vi.mocked(listSources).mock.calls.length).toBeGreaterThan(1));
  });

  it('shows the empty state when nothing has been fed yet', async () => {
    vi.mocked(listSources).mockResolvedValue([]);
    vi.mocked(listIngestionJobs).mockResolvedValue([]);

    render(<Sources companionName="Pebble" companionId="companion-1" onBack={() => {}} />);

    await waitFor(() =>
      expect(screen.getByText(/No sources yet — hand Pebble something to read/)).toBeTruthy(),
    );
  });
});
