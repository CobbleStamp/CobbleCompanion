/**
 * Read-only memory browser routes (companionmemory.md). Exposes what a
 * companion "holds", grouped by memory kind: the episodic transcript, the
 * Phase 1 semantic store (sources/sections/facts + ingestion progress, with a
 * search endpoint), and procedural as a planned-but-empty section (P3).
 */

import type {
  EpisodicMemorySection,
  MemorySnapshotDto,
  SemanticMemorySection,
  SemanticSearchResultDto,
} from '@cobble/shared';
import { semanticSearchSchema } from '@cobble/shared';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import type { RequireAuth } from '../auth-guard.js';

interface CompanionParams {
  readonly companionId: string;
}

export function registerMemoryRoutes(
  app: FastifyInstance,
  deps: AppDeps,
  requireAuth: RequireAuth,
): void {
  const { identity, memory, semantic, embeddings, config } = deps;

  // A sectioned snapshot of everything the companion holds.
  app.get(
    '/companions/:companionId/memory',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { companionId } = request.params as CompanionParams;
      const companion = await identity.getCompanion(companionId, request.userId!);
      if (!companion) {
        return reply.code(404).send({ error: 'companion not found' });
      }

      const episodic: EpisodicMemorySection = {
        status: 'available',
        messageCount: await memory.countMessages(companion.id),
      };

      const counts = await semantic.counts(companion.id);
      const jobs = await semantic.listJobs(companion.id);
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

      const snapshot: MemorySnapshotDto = {
        identity: companion,
        episodic,
        semantic: semanticSection,
        procedural: { status: 'not_implemented', plannedPhase: 'Phase 3' },
      };
      return reply.send({ memory: snapshot });
    },
  );

  // Search the semantic store directly (the browser's recall window).
  app.post(
    '/companions/:companionId/memory/search',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { companionId } = request.params as CompanionParams;
      const parsed = semanticSearchSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'a search query is required' });
      }
      const companion = await identity.getCompanion(companionId, request.userId!);
      if (!companion) {
        return reply.code(404).send({ error: 'companion not found' });
      }

      // Degrade, don't 500: if the embedding provider fails, fall back to the
      // lexical arm (an empty embedding skips vector search in the store).
      let queryEmbedding: readonly number[] = [];
      try {
        const [embedded] = await embeddings.embed({
          input: [parsed.data.query],
          model: config.embeddingModel,
          dimensions: config.embeddingDimensions,
        });
        queryEmbedding = embedded ?? [];
      } catch (error) {
        deps.logger.error('memory search embedding failed; degrading to lexical-only', {
          operation: 'memory.search',
          companionId: companion.id,
          error,
        });
      }
      const hits = await semantic.search(companion.id, {
        queryEmbedding,
        queryText: parsed.data.query,
        topK: parsed.data.topK,
      });
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
      return reply.send({ results });
    },
  );
}
