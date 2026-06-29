/**
 * Record → DTO mappers for the source/ingestion WS surface. The transport layer
 * owns the wire shape, so these live in one place rather than being re-derived
 * per method — `toJobDto` in particular is needed by both `sources.ts` (the
 * source-intake methods) and `memory.ts` (the memory snapshot's job list).
 */

import type { JobRecord, SectionRecord, SourceRecord } from '@cobble/core';
import type { IngestionJobDto, SectionDto, SourceDto } from '@cobble/shared';

export function toSourceDto(source: SourceRecord): SourceDto {
  return {
    id: source.id,
    kind: source.kind,
    title: source.title,
    origin: source.origin,
    byteSize: source.byteSize,
    createdAt: source.createdAt,
  };
}

export function toJobDto(job: JobRecord): IngestionJobDto {
  return {
    id: job.id,
    sourceId: job.sourceId,
    status: job.status,
    sectionsTotal: job.sectionsTotal,
    sectionsDone: job.sectionsDone,
    error: job.error,
  };
}

export function toSectionDto(section: SectionRecord): SectionDto {
  return {
    id: section.id,
    sourceId: section.sourceId,
    chapterTitle: section.chapterTitle,
    topicTitle: section.topicTitle,
    originalText: section.originalText,
    contextHeader: section.contextHeader,
    paraStart: section.paraStart,
    paraEnd: section.paraEnd,
    pageStart: section.pageStart,
    pageEnd: section.pageEnd,
    ord: section.ord,
  };
}
