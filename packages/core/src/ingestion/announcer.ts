/**
 * Ingestion announcer — the companion proactively telling its user how a
 * background read ended. When a source finishes (or fails) ingesting, the
 * pipeline asks this collaborator to post a short, in-character note to the
 * transcript ("By the way — I've finished reading X…").
 *
 * Kept separate from the pipeline so the pipeline stays ignorant of personas,
 * chat, and token metering: it just signals a terminal outcome. The note is
 * generated in the companion's voice when the owner has budget; otherwise (over
 * cap, generation failure, or no persona) it falls back to a single-sourced
 * canned line — the user is always told, the companion never goes silent.
 */

import { ingestionDoneFallback, ingestionFailedFallback } from '@cobble/shared';
import type { IdentityStore } from '../identity/store.js';
import type { LlmGateway } from '../llm/gateway.js';
import type { Logger } from '../logging.js';
import type { MemoryStore } from '../memory/store.js';
import type { TokenQuotaStore } from '../quota/stamina-store.js';
import { createUsageAccumulator, meteredLlmGateway } from '../usage.js';

/** A terminal ingestion outcome worth telling the user about. */
export interface IngestionOutcome {
  readonly companionId: string;
  /** Owner whose persona voices the note and whose cap meters its tokens. */
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
  /** Meters the note's tokens and gates generation when over cap; omit = unmetered. */
  readonly quota?: TokenQuotaStore;
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
    // Don't spend tokens the owner doesn't have — a canned line still informs them.
    if (this.options.quota && (await this.options.quota.isOverCap(ownerId))) {
      return fallback;
    }
    const companion = await this.options.identity.getCompanion(outcome.companionId, ownerId);
    if (!companion) {
      return fallback;
    }
    try {
      const generated = await this.generateInVoice(companion, outcome, ownerId);
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

  /** Generate a short note in the companion's voice and debit its tokens. */
  private async generateInVoice(
    companion: { readonly name: string; readonly form: string; readonly temperament: string },
    outcome: IngestionOutcome,
    ownerId: string,
  ): Promise<string> {
    const usage = createUsageAccumulator();
    const llm = meteredLlmGateway(this.options.llm, usage.sink);
    const system =
      `You are ${companion.name}, ${companion.form}. Your temperament: ${companion.temperament}. ` +
      `You speak directly, in your own voice, to the person you accompany.`;
    const user =
      outcome.outcome === 'done'
        ? `You've just finished reading the document they shared, titled "${outcome.sourceTitle}". ` +
          `Send a brief, in-character heads-up (one or two sentences) that you're done and can now ` +
          `answer questions about it. Plain text only, no markdown.`
        : `You tried to read the document they shared, titled "${outcome.sourceTitle}", but ran into ` +
          `trouble and couldn't finish. Send a brief, in-character note (one or two sentences) letting ` +
          `them know, and gently suggest they try uploading it again. Plain text only, no markdown.`;

    let text = '';
    for await (const delta of llm.stream({
      model: this.options.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    })) {
      text += delta;
    }

    await this.debit(ownerId, usage.total().totalTokens);
    return text.trim();
  }

  /** Meter the note's tokens against the owner's cap; best-effort (logging.md). */
  private async debit(ownerId: string, totalTokens: number): Promise<void> {
    if (!this.options.quota || totalTokens <= 0) {
      return;
    }
    try {
      await this.options.quota.recordUsage(ownerId, totalTokens);
    } catch (error) {
      this.options.logger.error('failed to record ingestion-note token usage', {
        operation: 'ingestion.announcer.debit',
        ownerId,
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
