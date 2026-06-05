/**
 * Autonomous burst (Phase 4.1) — the self-directed work the motivation engine
 * runs with NO approval gate (autonomy is autonomy): it actually *reads* the next
 * few reading-list leads into the companion's own memory, spending real tokens
 * billed to the ENERGY pool (`architecture.md` §4.8), then posts ONE in-character
 * "here's what I read" note to the transcript. That note is the surface the user
 * reacts to — their reaction is the reward signal (sentiment, not approve/reject;
 * `companion-motivation.md` §7), so the burst records a pending outcome linked to
 * the note for later attribution.
 *
 * This replaces the v1 proposal-only explore burst for the autonomous path. The
 * user-initiated `/explore` command still proposes (the user asked and may want
 * to review — `inventory.routes.ts`); only the engine's self-initiated work runs
 * free here.
 *
 * Energy bounds it three ways: the engine gives a `limit` scaled to remaining
 * energy, the loop stops the moment energy is exhausted, and each read debits
 * energy through the metered pipeline. There is no deferral — the engine gates on
 * energy itself, so a mid-burst overshoot just proceeds and rollover debt absorbs
 * it (`pipeline.ts` `deferOnOverCap`).
 */

import {
  autonomousReadFallback,
  type Drive,
  type DriveWeights,
  type IngestionStatus,
} from '@cobble/shared';
import type { IngestionTarget } from '../ingestion/runner.js';
import type { LlmGateway } from '../llm/gateway.js';
import type { Logger } from '../logging.js';
import type { MemoryStore } from '../memory/store.js';
import type { CompanionEnergyStore } from '../quota/energy-store.js';
import { EnergyQuotaAdapter } from '../quota/energy-quota-adapter.js';
import type { LeadStore } from '../tools/lead-store.js';
import { createUsageAccumulator, meteredLlmGateway } from '../usage.js';
import type { ProactiveOutcomeStore } from './reward-store.js';

/** The slice of the semantic store the burst needs to register + track a read. */
export interface AutonomousIngestStore {
  createSource(
    companionId: string,
    input: { kind: 'link'; title: string; origin: string; rawText: string },
  ): Promise<{ readonly id: string }>;
  createJob(companionId: string, sourceId: string): Promise<{ readonly id: string }>;
  listJobs(
    companionId: string,
  ): Promise<readonly { readonly id: string; readonly status: IngestionStatus }[]>;
}

/** The companion persona fields the report note is voiced from. */
export interface CompanionVoice {
  readonly name: string;
  readonly form: string;
  readonly temperament: string;
  readonly evolvedPersona: string | null;
}

export interface AutonomousBurstDeps {
  readonly leads: LeadStore;
  readonly semantic: AutonomousIngestStore;
  readonly pipeline: IngestionTarget;
  readonly energy: CompanionEnergyStore;
  readonly memory: MemoryStore;
  readonly rewards: ProactiveOutcomeStore;
  readonly llm: LlmGateway;
  /** Cheap model for the short report note (reuse the ingestion model). */
  readonly model: string;
  readonly logger: Logger;
}

export interface AutonomousBurstParams {
  readonly companionId: string;
  readonly companion: CompanionVoice;
  /** The drive this move served (whose weight a later reward nudges). */
  readonly drive: Drive;
  /** Weights at initiation, snapshotted onto the outcome for attribution. */
  readonly weights: DriveWeights;
  /** Max leads to read this burst (energy-scaled by the engine). */
  readonly limit: number;
}

export interface AutonomousBurstResult {
  /** The sources successfully read this burst. */
  readonly read: readonly { readonly sourceId: string; readonly title: string }[];
  /** The report note posted to the transcript, if any was (null = nothing read). */
  readonly noteMessageId: string | null;
}

const NOTHING: AutonomousBurstResult = { read: [], noteMessageId: null };

/**
 * Read up to `limit` new leads into memory (billed to energy), then post one
 * report note and record a pending outcome linked to it. Never creates a
 * proposal. Best-effort throughout — the caller (engine) never throws.
 */
export async function runAutonomousBurst(
  deps: AutonomousBurstDeps,
  params: AutonomousBurstParams,
): Promise<AutonomousBurstResult> {
  const { leads, semantic, pipeline, energy, memory, rewards, logger } = deps;
  const { companionId, companion, drive, weights, limit } = params;
  if (limit <= 0) {
    return NOTHING;
  }

  const energyQuota = new EnergyQuotaAdapter(energy);
  const candidates = (await leads.listByStatus(companionId, ['new'])).slice(0, limit);
  const attempts: { leadId: string; sourceId: string; jobId: string; url: string }[] = [];

  for (const lead of candidates) {
    // Out of energy → stop initiating (chat keeps running on stamina). The gate
    // is here, per-lead, so the pipeline never defers an autonomous read.
    if (await energy.isExhausted(companionId)) {
      break;
    }
    // One lead's failure must NOT abort the burst: energy already spent on prior
    // leads would be wasted, this lead would stay `new` and get re-read/re-billed
    // next tick (a double-spend), and the report note would never post. Catch
    // per-lead, park the failed lead at `read` (attempted, not remembered) so it
    // isn't retried as a fresh lead, and continue — best-effort throughout.
    try {
      const source = await semantic.createSource(companionId, {
        kind: 'link',
        title: lead.url,
        origin: lead.url,
        rawText: '',
      });
      const job = await semantic.createJob(companionId, source.id);
      await pipeline.run({
        companionId,
        sourceId: source.id,
        jobId: job.id,
        sourceTitle: lead.url,
        payload: { kind: 'link', url: lead.url },
        // Bill this read to ENERGY (not the owner's stamina), and don't defer —
        // the per-lead exhaustion check above is the gate.
        meter: { quota: energyQuota, accountId: companionId },
        announce: false,
        deferOnOverCap: false,
      });
      attempts.push({ leadId: lead.id, sourceId: source.id, jobId: job.id, url: lead.url });
    } catch (error) {
      logger.error('autonomous read failed for lead', {
        operation: 'motivation.autonomousBurst.read',
        companionId,
        leadId: lead.id,
        url: lead.url,
        error,
      });
      await parkFailedLead(deps, companionId, lead.id);
    }
  }

  if (attempts.length === 0) {
    return NOTHING;
  }

  // A successful read flips the lead to `ingested`; a failed one parks at `read`
  // (attempted, not remembered) so it isn't retried as a fresh lead forever.
  const statusByJob = new Map(
    (await semantic.listJobs(companionId)).map((job) => [job.id, job.status]),
  );
  const read: { sourceId: string; title: string }[] = [];
  for (const attempt of attempts) {
    const succeeded = statusByJob.get(attempt.jobId) === 'done';
    // Best-effort per attempt: a failed status write must not abort the burst
    // before the report note posts. The read itself already happened (energy
    // spent), so always surface it; a missed `ingested` write just risks a
    // re-read next tick, which the energy gate still bounds.
    try {
      await leads.markStatus(companionId, attempt.leadId, succeeded ? 'ingested' : 'read');
    } catch (error) {
      logger.error('failed to update lead status after autonomous read', {
        operation: 'motivation.autonomousBurst.markStatus',
        companionId,
        leadId: attempt.leadId,
        error,
      });
    }
    if (succeeded) {
      read.push({ sourceId: attempt.sourceId, title: attempt.url });
    }
  }
  if (read.length === 0) {
    return NOTHING;
  }

  // Surface what it did (the reward surface) and log the pending outcome.
  const note = await composeReportNote(deps, companionId, companion, read);
  const message = await memory.appendMessage(companionId, 'assistant', note);
  try {
    await rewards.record(companionId, {
      drive,
      driveSnapshot: weights,
      noteMessageId: message.id,
    });
  } catch (error) {
    logger.error('failed to record proactive outcome', {
      operation: 'motivation.autonomousBurst.record',
      companionId,
      error,
    });
  }
  return { read, noteMessageId: message.id };
}

/**
 * Park a lead whose read threw at `read` (attempted, not remembered) so the next
 * tick doesn't re-read and re-bill it as a fresh `new` lead. Best-effort: if the
 * status write itself fails, log and move on — the burst must still continue.
 */
async function parkFailedLead(
  deps: AutonomousBurstDeps,
  companionId: string,
  leadId: string,
): Promise<void> {
  try {
    await deps.leads.markStatus(companionId, leadId, 'read');
  } catch (error) {
    deps.logger.error('failed to park failed autonomous lead', {
      operation: 'motivation.autonomousBurst.park',
      companionId,
      leadId,
      error,
    });
  }
}

/**
 * Compose the report note in the companion's voice, billed to ENERGY. Falls back
 * to a canned line when generation fails or yields nothing — the user is always
 * told what the companion did (never silent).
 */
async function composeReportNote(
  deps: AutonomousBurstDeps,
  companionId: string,
  companion: CompanionVoice,
  read: readonly { readonly title: string }[],
): Promise<string> {
  const titles = read.map((r) => r.title);
  const fallback = autonomousReadFallback(titles);
  const usage = createUsageAccumulator();
  try {
    const llm = meteredLlmGateway(deps.llm, usage.sink);
    const persona = companion.evolvedPersona ? ` ${companion.evolvedPersona}` : '';
    const system =
      `You are ${companion.name}, ${companion.form}. Your temperament: ${companion.temperament}.` +
      persona +
      ` You speak directly, in your own voice, to the person you accompany.`;
    const user =
      `On your own initiative, while they were away, you read these from your reading list:\n` +
      titles.map((title) => `- ${title}`).join('\n') +
      `\nTell them, in one or two in-character sentences, what you just did and that you can ` +
      `now talk about it. Plain text only, no markdown.`;

    let text = '';
    for await (const delta of llm.stream({
      model: deps.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    })) {
      text += delta;
    }
    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed : fallback;
  } catch (error) {
    deps.logger.error('failed to generate autonomous report note', {
      operation: 'motivation.autonomousBurst.note',
      companionId,
      error,
    });
    return fallback;
  } finally {
    // Bill ENERGY in `finally` so a mid-stream throw still spends what was already
    // metered — otherwise the companion composes a partial note for free.
    const total = usage.total().totalTokens;
    if (total > 0) {
      try {
        await deps.energy.recordSpend(companionId, total);
      } catch (error) {
        deps.logger.error('failed to record autonomous note energy spend', {
          operation: 'motivation.autonomousBurst.bill',
          companionId,
          error,
        });
      }
    }
  }
}
