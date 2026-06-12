/**
 * Reaction learning (companion-reactions.md §4, §7) — the WILL's half of the
 * reaction loop, the sibling of motivation/reinforce.ts. A user reaction is an
 * *addressed* reward: the body reads the value it signals (reactions/sense.ts) and
 * this attributes it.
 *
 * - On a message that was a **proactive act's report note** (an unresolved outcome
 *   found by `note_message_id`), it resolves *that* outcome — atomically claimed,
 *   so the ambient affect delta can't double-score it — and nudges the served
 *   drive (and any driving belief's salience), at parity with the affect rate.
 * - On an **ordinary answer** (no outcome), it nudges the **approval** drive at a
 *   gentler rate — addressed credit on everyday chat the ambient loop forgoes.
 *
 * The read's reward is also recorded on the reaction row (the reflection corpus,
 * §6) whenever a genuine reading came back. A `null` read (failure/decline) teaches
 * nothing — never a fabricated neutral. The read is billed to stamina, so it is
 * gated on the wallet like every other LLM consumer (empty → no read, no learning),
 * and a re-add of a just-removed reaction is debounced — an un-react → re-react
 * toggle must not re-bill the read or re-nudge the drives for the same signal.
 * Fire-and-forget and self-catching: it runs
 * after the reaction route has already responded, so it can never block the UI, and
 * a hiccup never surfaces (logging.md). In-flight reads are tracked so tests and a
 * graceful shutdown can drain them ({@link whenIdle}).
 */

import type { MessageDto } from '@cobble/shared';
import type { IdentityStore } from '../identity/store.js';
import type { Logger } from '../logging.js';
import type { MemoryStore } from '../memory/store.js';
import { resolveWeights } from '../motivation/drives.js';
import type { ProactiveOutcomeRecord, ProactiveOutcomeStore } from '../motivation/reward-store.js';
import { nudgeDriveWeight } from '../motivation/weights.js';
import type { UserModelStore } from '../user-model/store.js';
import { senseReaction, type ReactionSenseDeps } from './sense.js';
import type { ReactionStore } from './store.js';

/** A proactive-act reaction nudges the served drive at parity with the affect
 *  delta's rate — an addressed reaction is at least as trustworthy (§4). */
const REACTION_LEARNING_RATE = 0.1;
/** An ordinary-answer reaction nudges `approval` more gently — lighter, fuzzier,
 *  far more frequent, so everyday feedback drifts the dial rather than whipsawing it. */
const APPROVAL_REACTION_RATE = 0.04;
/** How strongly a reaction's reward moves a driving belief's salience (mirrors
 *  reinforce.ts). */
const BELIEF_REWARD_RATE = 0.1;
/** Recent turns fed to the read as context. */
const RECENT_CONTEXT_TURNS = 8;
/**
 * An un-react → re-react toggle replays a signal the first read already taught
 * (the un-react deletes the row, so the recorded reward can't be consulted).
 * Within this window the same (companion, message, emoji) is not re-read — damping
 * a toggle loop from re-billing reads and re-nudging drives. In-memory and
 * best-effort; the stamina gate below is the hard cost backstop.
 */
const RELEARN_DEBOUNCE_MS = 10 * 60 * 1000;
/** Bound on the debounce map so it can never grow without limit. */
const RELEARN_MAX_TRACKED = 1024;

/** Context line handed to the read on a proactive act, so the value judgement knows
 *  the message was self-initiated (not a reply). */
const PROACTIVE_ACT_CONTEXT =
  'The companion sent this message on its own initiative — a self-directed update it ' +
  'chose to share, not a reply to a question.';

export interface ReactionLearnerDeps {
  readonly rewards: ProactiveOutcomeStore;
  readonly reactions: ReactionStore;
  readonly identity: IdentityStore;
  readonly memory: MemoryStore;
  /** When present, a belief-driven act's reaction also moves the belief's salience. */
  readonly userModel?: UserModelStore;
  /** The body's read (gateway, model, stamina meter). */
  readonly sense: ReactionSenseDeps;
  readonly logger: Logger;
}

export class ReactionLearner {
  private readonly inflight = new Set<Promise<void>>();
  /** When each (companion, message, emoji) was last read — the toggle debounce. */
  private readonly recentlyLearned = new Map<string, number>();

  constructor(private readonly deps: ReactionLearnerDeps) {}

  /**
   * Read the value a user reaction signals and learn from it. Fire-and-forget: the
   * route has already responded, so this runs detached and never throws. Tracked so
   * {@link whenIdle} can drain it.
   */
  learn(companionId: string, messageId: string, emoji: string): void {
    const task = this.run(companionId, messageId, emoji).finally(() => {
      this.inflight.delete(task);
    });
    this.inflight.add(task);
  }

  /** Await all in-flight reads (test teardown / graceful shutdown). */
  async whenIdle(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.allSettled([...this.inflight]);
    }
  }

  private async run(companionId: string, messageId: string, emoji: string): Promise<void> {
    try {
      // Toggle debounce: an un-react → re-add of the same emoji re-inserts the row
      // (the delete took the recorded reward with it), so the route fires learn()
      // again. The first read already taught this signal — don't re-bill or
      // re-nudge for a repeat within the window.
      const key = `${companionId}:${messageId}:${emoji}`;
      const lastRead = this.recentlyLearned.get(key);
      if (lastRead !== undefined && Date.now() - lastRead < RELEARN_DEBOUNCE_MS) {
        return;
      }

      // Don't spend stamina the companion doesn't have: the read bills post-hoc
      // (sense.ts) and `spend` floors at 0, so without this pre-flight an empty
      // wallet would still let billed reads through — the same gate every other
      // LLM consumer applies (announcer, evolve, reflector, overCapGuard routes).
      const { quota } = this.deps.sense;
      if (quota && (await quota.isEmpty(companionId))) {
        return;
      }

      const recent = await this.deps.memory.getRecentMessages(companionId, RECENT_CONTEXT_TURNS);
      const reacted =
        recent.find((message) => message.id === messageId) ??
        (await this.deps.memory.getMessageById(companionId, messageId));
      if (!reacted) {
        return; // the message is gone — nothing to read
      }

      // Addressed attribution: was this message a proactive act's report note?
      const outcome = await this.deps.rewards.findUnresolvedByNoteMessageId(companionId, messageId);

      // Mark only once the read actually fires, so a gated/blocked attempt above
      // doesn't start the debounce window.
      this.markLearned(key);
      const reading = await senseReaction(this.deps.sense, {
        companionId,
        recentContext: formatContext(recent),
        reactedMessage: reacted.content,
        emoji,
        actContext: outcome ? PROACTIVE_ACT_CONTEXT : '',
      });
      if (!reading) {
        return; // null read → no learning, ever (never a fabricated neutral)
      }

      // Record the value on the reaction row — the reflection corpus (§6).
      await this.deps.reactions.setReward(
        companionId,
        messageId,
        emoji,
        reading.reward,
        reading.note,
      );

      if (outcome) {
        await this.reinforceProactive(companionId, outcome, reading.reward);
      } else {
        await this.reinforceOrdinary(companionId, reading.reward);
      }
    } catch (error) {
      this.deps.logger.error('failed to learn from reaction', {
        operation: 'reactions.learn',
        companionId,
        messageId,
        error,
      });
    }
  }

  /** Stamp the debounce window for a key, pruning so the map stays bounded. */
  private markLearned(key: string): void {
    if (this.recentlyLearned.size >= RELEARN_MAX_TRACKED) {
      const cutoff = Date.now() - RELEARN_DEBOUNCE_MS;
      for (const [tracked, at] of this.recentlyLearned) {
        if (at < cutoff) {
          this.recentlyLearned.delete(tracked);
        }
      }
      // Still full of in-window entries → evict oldest-inserted first.
      while (this.recentlyLearned.size >= RELEARN_MAX_TRACKED) {
        const oldest = this.recentlyLearned.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        this.recentlyLearned.delete(oldest);
      }
    }
    this.recentlyLearned.set(key, Date.now());
  }

  /** A reaction on a self-initiated act: resolve its outcome and nudge the served
   *  drive (and any driving belief). */
  private async reinforceProactive(
    companionId: string,
    outcome: ProactiveOutcomeRecord,
    reward: number,
  ): Promise<void> {
    // Claim atomically — first resolver wins, so the ambient affect delta can't also
    // score this outcome (companion-motivation.md §7). A 0 reward resolves it but
    // moves no personality.
    const claimed = await this.deps.rewards.setReward(companionId, outcome.id, reward);
    if (!claimed || reward === 0) {
      return;
    }
    const companion = await this.deps.identity.getCompanionById(companionId);
    if (!companion) {
      return;
    }
    const next = nudgeDriveWeight(
      resolveWeights(companion.driveWeights),
      outcome.drive,
      reward,
      REACTION_LEARNING_RATE,
    );
    await this.deps.identity.updateDriveWeights(companionId, next);

    if (this.deps.userModel && outcome.drivenByUserFactId) {
      try {
        await this.deps.userModel.adjustBeliefSalience(
          companion.ownerId,
          outcome.drivenByUserFactId,
          BELIEF_REWARD_RATE * reward,
        );
      } catch (error) {
        this.deps.logger.error('failed to adjust driving belief salience from reaction', {
          operation: 'reactions.learn.belief',
          companionId,
          error,
        });
      }
    }
  }

  /** A reaction on an ordinary answer: nudge the approval drive gently. */
  private async reinforceOrdinary(companionId: string, reward: number): Promise<void> {
    if (reward === 0) {
      return;
    }
    const companion = await this.deps.identity.getCompanionById(companionId);
    if (!companion) {
      return;
    }
    const next = nudgeDriveWeight(
      resolveWeights(companion.driveWeights),
      'approval',
      reward,
      APPROVAL_REACTION_RATE,
    );
    await this.deps.identity.updateDriveWeights(companionId, next);
  }
}

/** Format recent message-kind turns as a plain `role: content` slice for the read
 *  (tool steps / proposals are UI chrome and never enter the judgement). */
function formatContext(recent: readonly MessageDto[]): string {
  return recent
    .filter((message) => (message.kind ?? 'message') === 'message')
    .map((message) => `${message.role}: ${message.content}`)
    .join('\n');
}
