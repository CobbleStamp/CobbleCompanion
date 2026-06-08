/**
 * Episodic memory routes (Phase 2) — the companion's consolidated memories of
 * your shared history. A read-only timeline for the memory browser and a recall
 * endpoint (hybrid topic search). All owner-scoped; search spends an embedding
 * so it is gated by the same stamina wallet as semantic search.
 */

import type { EpisodeDto, EpisodeSearchResultDto } from '@cobble/shared';
import { episodeSearchSchema } from '@cobble/shared';
import type { EpisodeRecord, EpisodeSearchHit } from '@cobble/core';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import type { RequireAuth } from '../auth-guard.js';
import { overCapGuard } from '../quota-guard.js';

interface CompanionParams {
  readonly companionId: string;
}

/** Most-recent episodes returned on the timeline (the browser paginates later). */
const TIMELINE_LIMIT = 50;

export function registerEpisodeRoutes(
  app: FastifyInstance,
  deps: AppDeps,
  requireAuth: RequireAuth,
): void {
  const { identity, episodic, embeddings, config, quota, logger } = deps;

  // The episode timeline — consolidated memories, most recent first.
  app.get(
    '/companions/:companionId/episodes',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { companionId } = request.params as CompanionParams;
      const companion = await identity.getCompanion(companionId, request.userId!);
      if (!companion) {
        return reply.code(404).send({ error: 'companion not found' });
      }
      const episodes = await episodic.listEpisodes(companion.id, { limit: TIMELINE_LIMIT });
      return reply.send({ episodes: episodes.map(toEpisodeDto) });
    },
  );

  // Recall episodes by topic (hybrid vector + FTS), gated by the stamina wallet.
  app.post(
    '/companions/:companionId/episodes/search',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { companionId } = request.params as CompanionParams;
      const parsed = episodeSearchSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'a search query is required' });
      }
      const companion = await identity.getCompanion(companionId, request.userId!);
      if (!companion) {
        return reply.code(404).send({ error: 'companion not found' });
      }
      const overCap = await overCapGuard(quota, companion.id);
      if (overCap) {
        return reply.code(429).send({ error: overCap });
      }

      // Degrade, don't 500: an embedding failure falls back to the lexical arm
      // (an empty embedding skips vector search in the store).
      let queryEmbedding: readonly number[] = [];
      let searchTokens = 0;
      try {
        const { vectors, usage } = await embeddings.embed({
          input: [parsed.data.query],
          model: config.embeddingModel,
          dimensions: config.embeddingDimensions,
        });
        queryEmbedding = vectors[0] ?? [];
        searchTokens = usage.totalTokens;
      } catch (error) {
        logger.error('episode search embedding failed; degrading to lexical-only', {
          operation: 'episodes.search',
          companionId: companion.id,
          error,
        });
      }
      try {
        await quota.spend(companion.id, searchTokens);
      } catch (error) {
        logger.error('failed to record episode-search token usage', {
          operation: 'episodes.search',
          companionId: companion.id,
          error,
        });
      }

      const hits = await episodic.searchEpisodes(companion.id, {
        queryEmbedding,
        queryText: parsed.data.query,
        topK: parsed.data.topK,
      });
      const results: EpisodeSearchResultDto[] = hits.map(toEpisodeSearchResult);
      return reply.send({ results });
    },
  );
}

function toEpisodeDto(episode: EpisodeRecord): EpisodeDto {
  return {
    id: episode.id,
    summary: episode.summary,
    occurredStart: episode.occurredStart,
    occurredEnd: episode.occurredEnd,
    salience: episode.salience,
  };
}

function toEpisodeSearchResult(hit: EpisodeSearchHit): EpisodeSearchResultDto {
  return {
    episode: {
      id: hit.episodeId,
      summary: hit.summary,
      occurredStart: hit.occurredStart,
      occurredEnd: hit.occurredEnd,
      salience: hit.salience,
    },
    score: hit.score,
  };
}
