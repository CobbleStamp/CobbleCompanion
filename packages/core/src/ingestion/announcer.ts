/**
 * Ingestion announcer — the companion proactively telling its user how a
 * background read ended. When a source finishes (or fails) ingesting, the
 * pipeline asks this collaborator to post a short, in-character note to the
 * transcript ("By the way — I've finished reading X…").
 *
 * Kept separate from the pipeline so the pipeline stays ignorant of personas,
 * chat, and token metering: it just signals a terminal outcome. The note is
 * generated in the companion's voice when the companion has stamina; otherwise
 * (no stamina, generation failure, or no persona) it falls back to a single-sourced
 * canned line — the user is always told, the companion never goes silent.
 */

import { ingestionDoneFallback, ingestionFailedFallback } from '@cobble/shared';
import type { IdentityStore } from '../identity/store.js';
import type { LlmGateway } from '../llm/gateway.js';
import type { Logger } from '../logging.js';
import type { MemoryStore } from '../memory/store.js';
import { ingestionAnnounceTemplate, render } from '../prompts/index.js';
import type { VitalityStore } from '../quota/vitality-store.js';
import { createUsageAccumulator, meteredLlmGateway } from '../usage.js';

/** A terminal ingestion outcome worth telling the user about. */
export interface IngestionOutcome {
  readonly companionId: string;
  /** Owner — resolves the companion (ownership check) so its persona voices the note. */
  readonly ownerId?: string;
  readonly sourceTitle: string;
  readonly outcome: 'done' | 'failed';
}

export interface IngestionAnnouncer {
  /** Post a proactive note about how a read ended; never throws. */
  announce(outcome: IngestionOutcome): Promise<void>;
}

export interface LlmIngestionAnnouncerOptions {
  readonly identity: IdentityStore;
  readonly memory: MemoryStore;
  readonly llm: LlmGateway;
  /** Cheap model for the short note — reuse the ingestion model. */
  readonly model: string;
  readonly logger: Logger;
  /** Meters the note's tokens and gates generation when the wallet is empty; omit = unmetered. */
  readonly quota?: VitalityStore;
}

export class LlmIngestionAnnouncer implements IngestionAnnouncer {
  constructor(private readonly options: LlmIngestionAnnouncerOptions) {}

  async announce(outcome: IngestionOutcome): Promise<void> {
    try {
      const text = await this.composeText(outcome);
      await this.options.memory.appendMessage(outcome.companionId, 'assistant', text);
    } catch (error) {
      // Best-effort: a failed announcement must never disrupt the run that
      // triggered it (logging.md — no silent swallow, but no rethrow either).
      this.options.logger.error('failed to announce ingestion outcome', {
        operation: 'ingestion.announcer.announce',
        companionId: outcome.companionId,
        sourceId: outcome.sourceTitle,
        error,
      });
    }
  }

  /** The note text: in the companion's voice when possible, else a canned line. */
  private async composeText(outcome: IngestionOutcome): Promise<string> {
    const fallback = cannedFor(outcome);
    const { ownerId } = outcome;
    if (!ownerId) {
      return fallback;
    }
    // Don't spend stamina the companion doesn't have — a canned line still informs.
    if (this.options.quota && (await this.options.quota.isEmpty(outcome.companionId))) {
      return fallback;
    }
    const companion = await this.options.identity.getCompanion(outcome.companionId, ownerId);
    if (!companion) {
      return fallback;
    }
    try {
      const generated = await this.generateInVoice(companion, outcome);
      return generated.length > 0 ? generated : fallback;
    } catch (error) {
      this.options.logger.error('failed to generate in-character ingestion note', {
        operation: 'ingestion.announcer.generate',
        companionId: outcome.companionId,
        ownerId,
        error,
      });
      return fallback;
    }
  }

  /** Generate a short note in the companion's voice and debit its stamina. */
  private async generateInVoice(
    companion: { readonly name: string; readonly form: string; readonly temperament: string },
    outcome: IngestionOutcome,
  ): Promise<string> {
    const usage = createUsageAccumulator();
    const llm = meteredLlmGateway(this.options.llm, usage.sink);
    const prompt = render(ingestionAnnounceTemplate, {
      name: companion.name,
      form: companion.form,
      temperament: companion.temperament,
      sourceTitle: outcome.sourceTitle,
      outcome: outcome.outcome,
    });

    let text = '';
    for await (const delta of llm.stream({
      model: this.options.model,
      messages: prompt.messages,
      promptRef: prompt.ref,
    })) {
      text += delta;
    }

    await this.debit(outcome.companionId, usage.total().totalTokens);
    return text.trim();
  }

  /** Meter the note's tokens against the companion's stamina; best-effort (logging.md). */
  private async debit(companionId: string, totalTokens: number): Promise<void> {
    if (!this.options.quota || totalTokens <= 0) {
      return;
    }
    try {
      await this.options.quota.spend(companionId, totalTokens);
    } catch (error) {
      this.options.logger.error('failed to record ingestion-note token usage', {
        operation: 'ingestion.announcer.debit',
        companionId,
        error,
      });
    }
  }
}

function cannedFor(outcome: IngestionOutcome): string {
  return outcome.outcome === 'done'
    ? ingestionDoneFallback(outcome.sourceTitle)
    : ingestionFailedFallback(outcome.sourceTitle);
}
