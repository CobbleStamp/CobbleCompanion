import {
  semanticSearchSchema,
  type EpisodicMemorySection,
  type MemorySnapshotDto,
  type ProceduralMemorySection,
  type SemanticMemorySection,
  type SemanticSearchResultDto,
} from '@cobble/shared';
import type { AppDeps } from '../../app.js';
import type { WsMethods } from '../dispatch.js';
import { companionOf, embedSearchQuery, NotFoundError, parseParams } from './helpers.js';

/** Memory browser (mirrors memory.routes): a sectioned snapshot + hybrid search. */
export function memoryMethods(deps: AppDeps): WsMethods {
  const { identity, memory, semantic, episodic, procedural, embodiment } = deps;
  return {
    'memory.snapshot': async (ctx) => {
      const companionId = await companionOf(embodiment, ctx);
      const companion = await identity.getCompanion(companionId, ctx.userId);
      if (!companion) {
        throw new NotFoundError('companion not found');
      }
      const episodicSection: EpisodicMemorySection = {
        status: 'available',
        messageCount: await memory.countMessages(companionId),
        episodeCount: await episodic.countEpisodes(companionId),
      };
      const counts = await semantic.counts(companionId);
      const jobs = await semantic.listJobs(companionId);
      const semanticSection: SemanticMemorySection = {
        status: 'available',
        sourceCount: counts.sources,
        sectionCount: counts.sections,
        factCount: counts.facts,
        jobs: jobs.map((job) => ({
          id: job.id,
          sourceId: job.sourceId,
          status: job.status,
          sectionsTotal: job.sectionsTotal,
          sectionsDone: job.sectionsDone,
          error: job.error,
        })),
      };
      const proceduralSection: ProceduralMemorySection = {
        status: 'available',
        procedureCount: await procedural.count(companionId),
      };
      const snapshot: MemorySnapshotDto = {
        identity: companion,
        episodic: episodicSection,
        semantic: semanticSection,
        procedural: proceduralSection,
      };
      return { memory: snapshot };
    },

    'memory.search': async (ctx, params) => {
      const { query, topK } = parseParams(
        semanticSearchSchema,
        params,
        'a search query is required',
      );
      const companionId = await companionOf(embodiment, ctx);
      const queryEmbedding = await embedSearchQuery(
        deps,
        companionId,
        query,
        'memory.search',
        ctx.logger,
      );
      const hits = await semantic.search(companionId, { queryEmbedding, queryText: query, topK });
      const results: SemanticSearchResultDto[] = hits.map((hit) => ({
        citation: {
          sourceId: hit.sourceId,
          sourceTitle: hit.sourceTitle,
          chapterTitle: hit.chapterTitle,
          topicTitle: hit.topicTitle,
          paraStart: hit.paraStart,
          paraEnd: hit.paraEnd,
          pageStart: hit.pageStart,
          pageEnd: hit.pageEnd,
        },
        originalText: hit.originalText,
        score: hit.score,
      }));
      return { results };
    },
  };
}
