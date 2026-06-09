/**
 * Tier-3 user-persona synthesis (Phase 13, companion-memory.md §4) — the mirror of the
 * Personality Evolver, pointed at the USER. After the reflector updates the user's beliefs
 * (and consolidation forms episodes), this re-synthesizes a short "who this person is to
 * you" narrative from the user's current facts + this companion's recent episodes, and
 * persists it to `companions.user_persona`. buildPersona blends it ADDITIVELY into the
 * persona prompt (the verbatim Tier-1 facts still render), so accumulated understanding
 * of the user shapes tone without ever paraphrasing their identity.
 *
 * Background + off the request path, metered + cap-gated, never throws. Its own cursor
 * (`userModelUpdatedThroughSeq`) tracks the furthest of the belief + episode cursors it has
 * synthesized from, so it only re-derives when one of them advanced (no wasted tokens).
 */

import { isTier2Predicate, type UserFactDto } from '@cobble/shared';
import type { IdentityStore } from '../identity/store.js';
import type { LlmGateway } from '../llm/gateway.js';
import type { Logger } from '../logging.js';
import type { EpisodicMemoryStore } from '../memory/episodic-store.js';
import { render, userPersonaTemplate } from '../prompts/index.js';
import type { VitalityStore } from '../quota/vitality-store.js';
import { createUsageAccumulator, meteredLlmGateway } from '../usage.js';
import { beliefPhrase } from './phrasing.js';
import type { UserModelStore } from './store.js';

export interface UserPersonaSynthesizerOptions {
  readonly identity: IdentityStore;
  readonly episodic: EpisodicMemoryStore;
  readonly store: UserModelStore;
  readonly llm: LlmGateway;
  /** Cheap model for the short synthesis (input-light, bounded prose out). */
  readonly model: string;
  readonly logger: Logger;
  readonly quota?: VitalityStore;
  /** Recent episodes the synthesis draws on. */
  readonly recentEpisodes?: number;
}

/** The interface the consolidation service triggers after the reflector runs. */
export interface UserPersonaSynthesizer {
  synthesize(companionId: string): Promise<void>;
}

const DEFAULT_RECENT_EPISODES = 20;
/** Cap the user persona so it stays a flavour paragraph, not a second transcript. */
const MAX_PERSONA_CHARS = 1_200;

/** Render one current user-fact as a natural-language line for the synthesis prompt. */
function factLine(fact: UserFactDto): string {
  if (fact.predicate === 'name') {
    return `their name is ${fact.object}`;
  }
  if (fact.predicate !== null && isTier2Predicate(fact.predicate)) {
    return beliefPhrase(fact.predicate, fact.object);
  }
  return fact.predicate ? `${fact.predicate}: ${fact.object}` : fact.object;
}

export class LlmUserPersonaSynthesizer implements UserPersonaSynthesizer {
  private readonly recentEpisodes: number;

  constructor(private readonly options: UserPersonaSynthesizerOptions) {
    this.recentEpisodes = options.recentEpisodes ?? DEFAULT_RECENT_EPISODES;
  }

  async synthesize(companionId: string): Promise<void> {
    const { identity, episodic, store, logger } = this.options;
    try {
      const companion = await identity.getCompanionById(companionId);
      if (!companion) {
        return;
      }
      // Re-synthesize only when the belief OR episode cursor has advanced past what the
      // persona was last built from — so it never re-derives the same understanding.
      const throughSeq = Math.max(companion.userFactsThroughSeq, companion.consolidatedThroughSeq);
      if (throughSeq <= companion.userModelUpdatedThroughSeq) {
        return;
      }
      const facts = await store.listCurrent(companion.ownerId);
      const episodes = await episodic.listEpisodes(companionId, { limit: this.recentEpisodes });
      if (facts.length === 0 && episodes.length === 0) {
        // Cursor advanced over filler only; move the persona cursor up so we don't re-check,
        // but there's nothing to synthesize from yet.
        await identity.updateUserPersona(companionId, companion.userPersona ?? '', throughSeq);
        return;
      }
      if (this.options.quota && (await this.options.quota.isEmpty(companionId))) {
        return; // empty — retry on the next pass
      }

      const usage = createUsageAccumulator();
      const llm = meteredLlmGateway(this.options.llm, usage.sink);
      const text = await this.run(llm, companion, facts, episodes);
      await this.debit(companionId, usage.total().totalTokens);
      if (text.length === 0) {
        return; // unusable generation — keep the prior persona, retry later
      }
      await identity.updateUserPersona(companionId, text, throughSeq);
    } catch (error) {
      logger.error('user-persona synthesis failed', {
        operation: 'userModel.synthesize',
        companionId,
        error,
      });
    }
  }

  /** Re-synthesize the user persona from the user's facts + recent shared episodes. */
  private async run(
    llm: LlmGateway,
    companion: { readonly name: string; readonly userPersona: string | null },
    facts: readonly UserFactDto[],
    episodes: readonly { readonly summary: string }[],
  ): Promise<string> {
    const nameFact = facts.find((fact) => fact.predicate === 'name');
    const prompt = render(userPersonaTemplate, {
      companionName: companion.name,
      userName: nameFact?.object ?? null,
      priorUserPersona: companion.userPersona,
      facts: facts.map(factLine),
      memories: episodes.map((episode) => episode.summary),
    });

    let text = '';
    for await (const delta of llm.stream({
      model: this.options.model,
      messages: prompt.messages,
      promptRef: prompt.ref,
    })) {
      text += delta;
    }
    return text.trim().slice(0, MAX_PERSONA_CHARS);
  }

  /** Meter the synthesis tokens against the companion's stamina; best-effort (logging.md). */
  private async debit(companionId: string, totalTokens: number): Promise<void> {
    if (!this.options.quota || totalTokens <= 0) {
      return;
    }
    try {
      await this.options.quota.spend(companionId, totalTokens);
    } catch (error) {
      this.options.logger.error('failed to record user-persona synthesis token usage', {
        operation: 'userModel.synthesize.debit',
        companionId,
        error,
      });
    }
  }
}
