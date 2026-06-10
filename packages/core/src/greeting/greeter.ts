/**
 * The greeting service (Phase 14, companion-greeting.md) — the companion's
 * reaction to the user arriving. The social sibling of the autonomous burst: on
 * an arrival it senses the gap (from the durable `last_seen_at`), the
 * relationship depth, and any unfinished business, runs the token-free
 * {@link decideGreeting} gate, and — when it decides to greet — voices ONE
 * in-character greeting billed to STAMINA (a greeting is interaction, not solo
 * work), or shows the fixed token-free exhausted line when stamina is gone. It
 * records a `bond`-drive proactive outcome so the change-as-reward loop teaches
 * the companion to greet less when greetings land cold.
 *
 * Split into three steps so the route can stream a `composing` cue at the right
 * moment: {@link GreetingService.prepare} (token-free sense + gate),
 * {@link GreetingService.compose} (the stamina-billed voicing), and
 * {@link GreetingService.markSeen} (stamp the arrival clock AFTER the gap was
 * read). Never throws on the sensing path — a hiccup just yields "stay quiet".
 */

import {
  exhaustedGreetingFallback,
  type Drive,
  type DriveWeights,
  type MessageDto,
} from '@cobble/shared';
import type { LlmGateway } from '../llm/gateway.js';
import type { Logger } from '../logging.js';
import type { MemoryStore } from '../memory/store.js';
import { resolveWeights } from '../motivation/drives.js';
import type { ProactiveOutcomeStore } from '../motivation/reward-store.js';
import { greetingTemplate, render, type GreetingInput } from '../prompts/index.js';
import type { VitalityStore } from '../quota/vitality-store.js';
import type { ProposalStore } from '../tools/proposal-store.js';
import type { UserModelStore } from '../user-model/store.js';
import { createUsageAccumulator, meteredLlmGateway } from '../usage.js';
import type { IdentityStore } from '../identity/store.js';
import { decideGreeting, type GreetingMove } from './decide.js';

/** A greeting is a `bond`/connection-driven move (companion-motivation.md §3). */
const GREETING_DRIVE: Drive = 'bond';

/** At most this many known things are offered to the brief (reference one, never list). */
const MAX_KNOWN_THINGS = 2;

export interface GreetingServiceDeps {
  readonly identity: IdentityStore;
  readonly memory: MemoryStore;
  readonly proposals: ProposalStore;
  readonly rewards: ProactiveOutcomeStore;
  readonly userModel: UserModelStore;
  /** The STAMINA wallet — a greeting is interaction, so it spends stamina, not energy. */
  readonly stamina: VitalityStore;
  readonly llm: LlmGateway;
  /** Cheap model for the short greeting (reuse the ingestion model). */
  readonly model: string;
  readonly logger: Logger;
}

export interface GreetingServiceOptions {
  readonly now?: () => Date;
}

/**
 * The result of {@link GreetingService.compose}: either a persisted greeting to
 * deliver, or a transient failure (the voicing hit an LLM/service error) the
 * caller should surface as a generic "unavailable" notice — never as a message
 * and never with a reward attributed.
 */
export type GreetingComposeResult =
  | { readonly ok: true; readonly message: MessageDto }
  | { readonly ok: false };

/**
 * The result of voicing a greeting: the in-character text, or a tagged failure
 * (`empty` stream or generation `error`) the caller turns into the generic
 * unavailable notice. A discriminated union, not a nullable string — a failure
 * is data the caller must branch on, never a silently-swallowed `null`.
 */
type VoiceResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: 'empty' | 'error' };

/** The outcome of {@link GreetingService.prepare}: stay quiet, or act (with the brief). */
export type GreetingPlan =
  | { readonly act: false }
  | {
      readonly act: true;
      readonly move: GreetingMove;
      /** Stamina was empty → show the fixed exhausted line instead of a voiced greeting. */
      readonly exhausted: boolean;
      /** The assembled brief the greeting is voiced from. */
      readonly voice: GreetingInput;
      /** Weights snapshot for the outcome (reward attribution). */
      readonly weights: DriveWeights;
    };

export class GreetingService {
  private readonly now: () => Date;

  constructor(
    private readonly deps: GreetingServiceDeps,
    options: GreetingServiceOptions = {},
  ) {
    this.now = options.now ?? ((): Date => new Date());
  }

  /**
   * Token-free: sense the arrival (gap, depth, open loops), run the gate, and
   * assemble the brief. Returns `{ act: false }` to stay quiet — including when a
   * prior proactive note still awaits the user's reaction (don't stack;
   * companion-motivation.md §7). Best-effort: any sensing error logs and yields
   * "stay quiet" so an arrival can never error out the chat.
   */
  async prepare(companionId: string, ownerId: string): Promise<GreetingPlan> {
    const { identity, rewards, logger } = this.deps;
    try {
      const companion = await identity.getCompanionById(companionId);
      if (!companion) {
        return { act: false };
      }
      // Don't stack a greeting on an act still awaiting a reaction — a scalar mood
      // delta attributes to a single pending outcome (companion-motivation.md §7).
      if (await rewards.findLatestUnresolved(companionId)) {
        return { act: false };
      }

      const firstMeeting = companion.lastSeenAt === null;
      const gapMs = firstMeeting
        ? 0
        : Math.max(0, this.now().getTime() - Date.parse(companion.lastSeenAt as string));

      const openLoop = firstMeeting ? null : await this.findOpenLoop(companionId);
      const move = decideGreeting({
        firstMeeting,
        gapMs,
        dial: companion.proactivityDial,
        hasOpenLoop: openLoop !== null,
      });
      if (!move) {
        return { act: false };
      }

      const knownThings = firstMeeting ? [] : await this.knownThings(ownerId);
      const exhausted = await this.deps.stamina.isEmpty(companionId);
      const voice: GreetingInput = {
        name: companion.name,
        form: companion.form,
        temperament: companion.temperament,
        evolvedPersona: companion.evolvedPersona,
        userPersona: companion.userPersona,
        kind: move.kind,
        gapPhrase: move.kind === 'introduce' ? null : describeGap(gapMs),
        knownThings,
        openLoop,
      };
      return {
        act: true,
        move,
        exhausted,
        voice,
        weights: resolveWeights(companion.driveWeights),
      };
    } catch (error) {
      logger.error('greeting prepare failed; staying quiet', {
        operation: 'greeting.prepare',
        companionId,
        error,
      });
      return { act: false };
    }
  }

  /**
   * Voice and persist the greeting. When stamina is exhausted, post the fixed
   * token-free line (no LLM call, no reward outcome — it's a forced groan, not a
   * drive-serving act). Otherwise voice it in-character, billed to STAMINA, and
   * record a pending `bond` outcome linked to the note.
   *
   * Returns `{ ok: false }` when the voicing fails (LLM error or empty result):
   * a transient hiccup must NOT masquerade as the exhausted "feed me" line, must
   * NOT persist a turn, and must NOT record a reward — the caller surfaces a
   * generic unavailable notice instead.
   */
  async compose(
    companionId: string,
    plan: Extract<GreetingPlan, { act: true }>,
  ): Promise<GreetingComposeResult> {
    const { memory, rewards, logger } = this.deps;
    if (plan.exhausted) {
      const line = exhaustedGreetingFallback(plan.voice.name);
      const message = await memory.appendMessage(companionId, 'assistant', line);
      return { ok: true, message };
    }

    const voiced = await this.voice(companionId, plan.voice);
    if (!voiced.ok) {
      // Voicing failed (logged in voice()); stay honest — no message, no reward.
      return { ok: false };
    }
    const message = await memory.appendMessage(companionId, 'assistant', voiced.text);
    try {
      await rewards.record(companionId, {
        drive: GREETING_DRIVE,
        driveSnapshot: plan.weights,
        noteMessageId: message.id,
      });
    } catch (error) {
      logger.error('failed to record greeting outcome', {
        operation: 'greeting.record',
        companionId,
        error,
      });
    }
    return { ok: true, message };
  }

  /**
   * Stamp the arrival clock to now — AFTER {@link prepare} read the prior value.
   * Unconditional last-writer-wins (no compare-and-set), so concurrent arrivals
   * that don't share the client guard can double-greet; accepted, see the route's
   * `greetingEvents` doc for the cases and the fix if it ever needs closing.
   */
  async markSeen(companionId: string): Promise<void> {
    await this.deps.identity.markSeen(companionId, this.now());
  }

  /**
   * Voice the greeting in the companion's own words, billed to STAMINA. Returns
   * a {@link VoiceResult}: the text, or a tagged failure on a generation error or
   * empty stream — a transient hiccup is NOT the exhausted state, so the caller
   * surfaces a generic unavailable notice rather than the misleading "feed me"
   * line (and skips the reward outcome).
   */
  private async voice(companionId: string, input: GreetingInput): Promise<VoiceResult> {
    const usage = createUsageAccumulator();
    try {
      const llm = meteredLlmGateway(this.deps.llm, usage.sink);
      const prompt = render(greetingTemplate, input);
      let text = '';
      for await (const delta of llm.stream({
        model: this.deps.model,
        messages: prompt.messages,
        promptRef: prompt.ref,
      })) {
        text += delta;
      }
      const trimmed = text.trim();
      return trimmed.length > 0 ? { ok: true, text: trimmed } : { ok: false, reason: 'empty' };
    } catch (error) {
      this.deps.logger.error('failed to voice greeting', {
        operation: 'greeting.voice',
        companionId,
        error,
      });
      return { ok: false, reason: 'error' };
    } finally {
      // Bill STAMINA in `finally` so a mid-stream throw still spends what was metered.
      const total = usage.total().totalTokens;
      if (total > 0) {
        try {
          await this.deps.stamina.spend(companionId, total);
        } catch (error) {
          this.deps.logger.error('failed to record greeting stamina spend', {
            operation: 'greeting.bill',
            companionId,
            error,
          });
        }
      }
    }
  }

  /**
   * The single most relevant unfinished thread to pick up, or null. Priority:
   * a pending approval (P3) over an unanswered question the companion left
   * (companion-greeting.md §5, Axis C). Best-effort — a read error means "no loop".
   */
  private async findOpenLoop(companionId: string): Promise<string | null> {
    try {
      const pending = await this.deps.proposals.listPending(companionId);
      if (pending.length > 0) {
        const more = pending.length > 1 ? ` (and ${pending.length - 1} more)` : '';
        return `something you left waiting for your approval: "${pending[0]!.summary}"${more}`;
      }
    } catch (error) {
      this.deps.logger.error('greeting open-loop proposal read failed', {
        operation: 'greeting.openLoop.proposals',
        companionId,
        error,
      });
    }
    try {
      const [last] = await this.deps.memory.getRecentMessages(companionId, 1);
      if (last && last.role === 'assistant' && last.content.trimEnd().endsWith('?')) {
        return `a question you left them with: "${truncate(last.content, 160)}"`;
      }
    } catch (error) {
      this.deps.logger.error('greeting open-loop transcript read failed', {
        operation: 'greeting.openLoop.transcript',
        companionId,
        error,
      });
    }
    return null;
  }

  /** Up to {@link MAX_KNOWN_THINGS} things known about the user, strongest first. */
  private async knownThings(ownerId: string): Promise<readonly string[]> {
    try {
      const beliefs = await this.deps.userModel.listCurrentBeliefs(ownerId);
      return [...beliefs]
        .sort((a, b) => (b.salience ?? 0) - (a.salience ?? 0))
        .slice(0, MAX_KNOWN_THINGS)
        .map((b) => (b.predicate ? `${b.predicate} ${b.object}` : b.object));
    } catch (error) {
      this.deps.logger.error('greeting known-things read failed', {
        operation: 'greeting.knownThings',
        ownerId,
        error,
      });
      return [];
    }
  }
}

/** A human phrase for an arrival gap, for the greeting's tone (not its content). */
export function describeGap(gapMs: number): string {
  const minutes = Math.round(gapMs / 60_000);
  if (minutes < 90) {
    return 'a little while';
  }
  const hours = Math.round(gapMs / 3_600_000);
  if (hours < 36) {
    return hours <= 1 ? 'about an hour' : `about ${hours} hours`;
  }
  const days = Math.round(gapMs / 86_400_000);
  return days <= 1 ? 'about a day' : `about ${days} days`;
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}
