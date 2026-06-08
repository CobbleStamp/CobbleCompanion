/**
 * IngestionPanel tests: hides finished jobs, shows the same labels as the
 * Sources page for in-progress/failed/deferred jobs, and the empty state.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { IngestionPanel } from './IngestionPanel.js';
import type { JobWithTitle } from './useIngestionJobs.js';

function job(overrides: Partial<JobWithTitle>): JobWithTitle {
  return {
    id: 'j1',
    sourceId: 's1',
    title: 'report.pdf',
    status: 'enriching',
    sectionsTotal: 4,
    sectionsDone: 2,
    error: null,
    ...overrides,
  };
}

describe('IngestionPanel', () => {
  it('lists in-progress jobs with their title and Sources-matching label', () => {
    render(<IngestionPanel jobs={[job({ title: 'peru.pdf' })]} />);
    expect(screen.getByText('peru.pdf')).toBeTruthy();
    expect(screen.getByText('enriching… 2/4 sections')).toBeTruthy();
  });

  it('hides finished (done) jobs', () => {
    render(
      <IngestionPanel
        jobs={[
          job({ id: 'j-done', title: 'finished.pdf', status: 'done', sectionsTotal: 9 }),
          job({ id: 'j-active', title: 'still-reading.pdf' }),
        ]}
      />,
    );
    expect(screen.queryByText('finished.pdf')).toBeNull();
    expect(screen.getByText('still-reading.pdf')).toBeTruthy();
  });

  it('shows failed and deferred jobs with their messages', () => {
    render(
      <IngestionPanel
        jobs={[
          job({ id: 'j-fail', title: 'broken.pdf', status: 'failed', error: 'corrupt PDF' }),
          job({ id: 'j-defer', title: 'parked.pdf', status: 'deferred' }),
        ]}
      />,
    );
    expect(screen.getByText('failed: corrupt PDF')).toBeTruthy();
    expect(screen.getByText(/waiting to be fed/)).toBeTruthy();
  });

  it('shows the empty state when every job is done', () => {
    render(<IngestionPanel jobs={[job({ status: 'done' })]} />);
    expect(screen.getByText('Nothing in progress right now.')).toBeTruthy();
  });
});
