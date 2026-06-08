/**
 * Tests for the shared ingestion-status helpers: the active/pending predicates
 * and the per-job label text that both the Sources page and the chat panel use.
 */

import type { IngestionJobDto, IngestionStatus } from '@cobble/shared';
import { describe, expect, it } from 'vitest';
import { isActiveJob, isPendingJob, jobStatusLabel } from './ingestionStatus.js';

function job(overrides: Partial<IngestionJobDto> = {}): IngestionJobDto {
  return {
    id: 'j1',
    sourceId: 's1',
    status: 'queued',
    sectionsTotal: 0,
    sectionsDone: 0,
    error: null,
    ...overrides,
  };
}

const active: readonly IngestionStatus[] = [
  'queued',
  'parsing',
  'segmenting',
  'enriching',
  'embedding',
];

describe('isActiveJob', () => {
  it('is true for states that change on their own', () => {
    for (const status of active) {
      expect(isActiveJob(job({ status }))).toBe(true);
    }
  });

  it('is false for done, failed, and deferred', () => {
    expect(isActiveJob(job({ status: 'done' }))).toBe(false);
    expect(isActiveJob(job({ status: 'failed' }))).toBe(false);
    expect(isActiveJob(job({ status: 'deferred' }))).toBe(false);
  });
});

describe('isPendingJob', () => {
  it('is true for everything not yet done — including failed and deferred', () => {
    for (const status of [...active, 'failed', 'deferred'] as const) {
      expect(isPendingJob(job({ status }))).toBe(true);
    }
  });

  it('is false only for done', () => {
    expect(isPendingJob(job({ status: 'done' }))).toBe(false);
  });
});

describe('jobStatusLabel', () => {
  it('summarises a finished job by section count', () => {
    expect(jobStatusLabel(job({ status: 'done', sectionsTotal: 12 }))).toBe('read · 12 sections');
  });

  it('surfaces the user-safe error for a failed job', () => {
    expect(jobStatusLabel(job({ status: 'failed', error: 'corrupt PDF' }))).toBe(
      'failed: corrupt PDF',
    );
    expect(jobStatusLabel(job({ status: 'failed', error: null }))).toBe('failed: unknown error');
  });

  it('explains a deferred job is waiting to be fed', () => {
    expect(jobStatusLabel(job({ status: 'deferred' }))).toMatch(/waiting to be fed/);
  });

  it('shows live section progress for an active job', () => {
    expect(jobStatusLabel(job({ status: 'enriching', sectionsTotal: 4, sectionsDone: 2 }))).toBe(
      'enriching… 2/4 sections',
    );
  });

  it("falls back to '?' for the total before segmentation is known", () => {
    expect(jobStatusLabel(job({ status: 'parsing', sectionsTotal: 0, sectionsDone: 0 }))).toBe(
      'parsing… 0/? sections',
    );
  });
});
