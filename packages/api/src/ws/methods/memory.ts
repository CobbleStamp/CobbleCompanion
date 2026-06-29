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
import { toJobDto } from './dto.js';
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
      // Independent per-store reads — fan out together rather than awaiting in series.
      const [messageCount, episodeCount, counts, jobs, procedureCount] = await Promise.all([
        memory.countMessages(companionId),
        episodic.countEpisodes(companionId),
        semantic.counts(companionId),
        semantic.listJobs(companionId),
        procedural.count(companionId),
      ]);
      const episodicSection: EpisodicMemorySection = {
        status: 'available',
        messageCount,
        episodeCount,
      };
      const semanticSection: SemanticMemorySection = {
        status: 'available',
        sourceCount: counts.sources,
        sectionCount: counts.sections,
        factCount: counts.facts,
        jobs: jobs.map(toJobDto),
      };
      const proceduralSection: ProceduralMemorySection = {
        status: 'available',
        procedureCount,
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
