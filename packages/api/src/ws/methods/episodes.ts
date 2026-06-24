import type { EpisodeRecord, EpisodeSearchHit } from '@cobble/core';
import { episodeSearchSchema, type EpisodeDto, type EpisodeSearchResultDto } from '@cobble/shared';
import type { AppDeps } from '../../app.js';
import type { WsMethods } from '../dispatch.js';
import { companionOf, embedSearchQuery, parseParams } from './helpers.js';

const TIMELINE_LIMIT = 50;

/** Episodic memory (mirrors episode.routes): timeline + hybrid topic search. */
export function episodeMethods(deps: AppDeps): WsMethods {
  const { episodic, embodiment } = deps;
  return {
    'episodes.list': async (ctx) => {
      const companionId = await companionOf(embodiment, ctx);
      const episodes = await episodic.listEpisodes(companionId, { limit: TIMELINE_LIMIT });
      return { episodes: episodes.map(toEpisodeDto) };
    },
    'episodes.search': async (ctx, params) => {
      const { query, topK } = parseParams(
        episodeSearchSchema,
        params,
        'a search query is required',
      );
      const companionId = await companionOf(embodiment, ctx);
      const queryEmbedding = await embedSearchQuery(
        deps,
        companionId,
        query,
        'episodes.search',
        ctx.logger,
      );
      const hits = await episodic.searchEpisodes(companionId, {
        queryEmbedding,
        queryText: query,
        topK,
      });
      return { results: hits.map(toEpisodeSearchResult) };
    },
  };
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
