/**
 * The per-user bridge (companion-discord.md §4): the embodiment lifecycle behind the
 * owner-locked router. `/summon` opens a companion connection (mint a real-user token →
 * connect to `/ws` → claim embodiment); `/status` reports presence; a supersession
 * (the user opened the companion elsewhere) tears the connection down and DMs the
 * notice; an owner DM while dormant is refused with "summon first".
 *
 * It depends only on the {@link CompanionConnection} seam (so the real WS wiring is
 * swapped for a fake in tests) and the router context shapes — nothing from
 * `@cobble/core`. Chat (T9) and read-only commands (T10) are injected hooks.
 */

import type { DiscordConfigStore } from '@cobble/db';
import type { ChatStreamEvent, CompanionStreamEvent } from '@cobble/shared';
import type {
  DirectMessageContext,
  ProposalActionContext,
  SlashCommandContext,
} from './gateway/manager.js';
import type { Logger } from './gateway/types.js';
import { runProactiveLoop, streamGreeting } from './proactive.js';

/** One companion connection (the bridge's view of an embodying `/ws` session). */
export interface CompanionConnection {
  /** Connect and claim embodiment. Resolves on the lease; rejects if superseded/failed. */
  connect(): Promise<void>;
  /** Register the takeover handler: fired if the room is claimed elsewhere post-ready. */
  onSuperseded(handler: () => void): void;
  /**
   * Register the unexpected-close handler: fired if the socket drops for any reason
   * that is neither a supersession nor a deliberate {@link close} (server bounce, idle
   * timeout, 1006). The bridge uses it to clear the now-dead embodiment.
   */
  onClosed(handler: () => void): void;
  /** Run a chat turn (`messages.send`), yielding the stream until it ends/throws. */
  chat(content: string): AsyncIterable<ChatStreamEvent>;
  /**
   * Invoke a streaming WS method (the post-approval turn — `proposals.confirm`; the
   * mission wake — `mission.advance`). The method's terminal result is the generator's
   * RETURN value (capturable with `yield*`), so a caller can read the outcome — e.g.
   * `mission.advance`'s skip flag — beyond the streamed chunks.
   */
  callStream(method: string, params?: unknown): AsyncGenerator<ChatStreamEvent, unknown>;
  /** Stream the arrival greeting (`greeting.stream`) on summon (T12). */
  greeting(): AsyncIterable<ChatStreamEvent>;
  /** The live companion event stream (autonomous messages — T12), until `signal` aborts. */
  events(signal: AbortSignal): AsyncIterable<CompanionStreamEvent>;
  /** Invoke a non-streaming WS method over this connection (the read-only views — T10). */
  call<T>(method: string, params?: unknown): Promise<T>;
  /** Close the connection (deliberate teardown). */
  close(): void;
}

export type CompanionConnectionFactory = (input: {
  userId: string;
  companionId: string;
  /** The user's stored (encrypted) bot token — decrypted at connect for the mint proof. */
  encryptedBotToken: string;
}) => CompanionConnection;

export interface CompanionBridgeOptions {
  readonly connectionFactory: CompanionConnectionFactory;
  /** Reads the bot config on demand (companion-discord.md §2.1): `/summon` needs the
   *  bound companion + encrypted token, a proposal click needs the owner id. No
   *  snapshot is held — the row is read at the point of use. */
  readonly configStore: DiscordConfigStore;
  /** Send a DM to a user's bot channel — for async notices (e.g. supersession). */
  readonly notify: (userId: string, channelId: string, content: string) => Promise<void>;
  /**
   * Open (or fetch) the owner's DM channel for a trigger-summoned embodiment that has no
   * interaction channel in hand (companion-missions.md §4 — reports ride the owner's DM).
   * Wired to the gateway (via the manager). Returns null if it can't be opened.
   */
  readonly openOwnerDm: (userId: string, discordUserId: string) => Promise<string | null>;
  /**
   * Run one mission advance turn over the live connection (companion-missions.md §5.2),
   * forwarding the turn's spoken output to `post` (the embodied room's DM). Injected —
   * mirrors {@link onChat} — so the bridge stays decoupled from the WS method wiring.
   * Reports whether the server SKIPPED the turn (the named mission is gone — a stale trigger),
   * so the bridge can undo a summon the trigger caused for nothing.
   */
  readonly onMissionAdvance: (
    connection: CompanionConnection,
    post: (content: string) => Promise<void>,
    missionId: string,
    event: string,
    userId: string,
  ) => Promise<MissionAdvanceOutcome>;
  /** Handle an owner DM while embodied (the chat turn — T9). */
  readonly onChat: (
    ctx: DirectMessageContext,
    connection: CompanionConnection,
  ) => void | Promise<void>;
  /**
   * Handle a non-summon/status owner command that passed the lock (the read-only
   * views — T10). Only invoked while embodied: the views call companion-scoped WS
   * methods, which require the live claim, so the bridge passes the active connection.
   */
  readonly onReadOnlyCommand: (
    ctx: SlashCommandContext,
    connection: CompanionConnection,
  ) => void | Promise<void>;
  /**
   * Handle a proposal Confirm/Reject click (approvals — T11). Only invoked while
   * embodied: `proposals.confirm`/`reject` are companion-scoped, so the bridge passes
   * the active connection.
   */
  readonly onProposalAction: (
    ctx: ProposalActionContext,
    connection: CompanionConnection,
  ) => void | Promise<void>;
  readonly logger: Logger;
}

/** How a mission advance turn ended, as far as the bridge needs to know. */
export interface MissionAdvanceOutcome {
  /** True when the server skipped the wake — no active mission (a stale trigger). */
  readonly skipped: boolean;
}

/** Input to {@link CompanionBridge.establishEmbodiment} / `openEmbodiment`. */
interface EstablishEmbodimentInput {
  readonly userId: string;
  readonly companionId: string;
  readonly encryptedBotToken: string;
  readonly channelId: string;
  readonly greet: boolean;
}

interface ActiveEmbodiment {
  readonly companionId: string;
  readonly connection: CompanionConnection;
  /** The DM channel to send async notices to (captured at summon). */
  readonly channelId: string;
  /** Aborts the proactive event loop on teardown (supersession / stop). */
  readonly abort: AbortController;
}

/**
 * Outcome of {@link CompanionBridge.establishEmbodiment}. `opened` distinguishes a
 * connection this call actually dialed (`true`) from one an already-registered
 * establish is serving that this call merely reused (`false`). Only the opener may
 * tear a connection down on a stale-mission skip — a reuser tearing it down would
 * kill an embodiment another live caller still depends on.
 */
interface EstablishResult {
  readonly embodiment: ActiveEmbodiment;
  readonly opened: boolean;
}

export const SUMMON_COMMAND = 'summon';
export const STATUS_COMMAND = 'status';
export const MISSION_COMMAND = 'mission';

/** Shown when the owner chats or runs a view while the companion is dormant. */
const DORMANT_NOTICE = 'I’m not here right now — `/summon` to bring me into this chat.';

export class CompanionBridge {
  private readonly active = new Map<string, ActiveEmbodiment>();
  /** Per-user establish in flight — later establishes queue behind it (see
   *  {@link establishEmbodiment}). */
  private readonly establishing = new Map<string, Promise<EstablishResult | null>>();

  constructor(private readonly opts: CompanionBridgeOptions) {}

  /** Router hook (owner DM): dormant → "summon first"; active → chat (T9). */
  async handleOwnerMessage(ctx: DirectMessageContext): Promise<void> {
    const embodiment = this.active.get(ctx.userId);
    if (!embodiment) {
      await ctx.reply(DORMANT_NOTICE);
      return;
    }
    await this.opts.onChat(ctx, embodiment.connection);
  }

  /**
   * Router hook (owner command): `/summon` + `/status` here; the rest are read-only
   * views. The views are companion-scoped (they need the live claim), so a read-only
   * command while dormant is refused with the same "summon first" prompt as chat —
   * EXCEPT `/mission` (companion-missions.md §5.3): the mission kill switch must work
   * even when the companion is dormant (e.g. after a worker restart with jobs still
   * armed), so it summons first, exactly like a trigger.
   */
  async handleOwnerCommand(ctx: SlashCommandContext): Promise<void> {
    if (ctx.command.name === SUMMON_COMMAND) return this.summon(ctx);
    if (ctx.command.name === STATUS_COMMAND) return this.status(ctx);
    let embodiment = this.active.get(ctx.userId) ?? null;
    if (!embodiment && ctx.command.name === MISSION_COMMAND) {
      embodiment = await this.summonForMissionCommand(ctx);
      if (!embodiment) return; // summonForMissionCommand already replied
    }
    if (!embodiment) {
      await ctx.reply(DORMANT_NOTICE);
      return;
    }
    return this.opts.onReadOnlyCommand(ctx, embodiment.connection);
  }

  /**
   * Summon for a dormant `/mission` command: a greet-less embodiment in the command's
   * channel, like a trigger wake (force-claims — supersedes another surface by design,
   * §3.4). On failure it replies with guidance and returns null; the view itself is
   * then the only reply on success, so there is no "I'm here" chatter.
   */
  private async summonForMissionCommand(
    ctx: SlashCommandContext,
  ): Promise<ActiveEmbodiment | null> {
    const config = await this.opts.configStore.findByUserId(ctx.userId);
    if (!config) {
      await ctx.reply(
        'I’m not set up here yet — add a bot token in your CobbleCompanion settings.',
      );
      return null;
    }
    const established = await this.establishEmbodiment({
      userId: ctx.userId,
      companionId: config.boundCompanionId,
      encryptedBotToken: config.encryptedBotToken,
      channelId: ctx.command.channelId,
      greet: false,
    });
    if (!established) {
      await ctx.reply('I couldn’t come back to check — try `/summon`, then `/mission` again.');
      return null;
    }
    return established.embodiment;
  }

  /**
   * Manager hook (proposal button click): owner-locked upstream and DM-only, so this is
   * defensive — a click while dormant is refused with "summon first", else it runs over
   * the live connection (the proposal methods need the claim).
   */
  async handleProposalAction(ctx: ProposalActionContext): Promise<void> {
    const owner =
      (await this.opts.configStore.findByUserId(ctx.userId))?.ownerDiscordUserId ?? null;
    if (owner !== null && ctx.discordUserId !== owner) {
      return; // not the owner — ignore (proposals live in the owner's DM anyway).
    }
    const embodiment = this.active.get(ctx.userId);
    if (!embodiment) {
      await ctx.reply(DORMANT_NOTICE);
      return;
    }
    await this.opts.onProposalAction(ctx, embodiment.connection);
  }

  /**
   * Trigger hook (mission wake, companion-missions.md §3.2, §3.4): summon-if-dormant, then
   * advance the named mission. Disruptive by design — establishing embodiment supersedes whatever
   * surface the companion was on. If already embodied, advance over the live connection with
   * no re-summon. Drops (logged) when the user is unlinked (no owner DM to report into) or
   * the connection can't be established.
   *
   * A trigger only carries weight while its mission is live: when the server skips the
   * advance (no active mission — a stale job the reconciliation is cancelling), a summon
   * this trigger caused is undone silently, so a stray firing never leaves the companion
   * squatting on a room it superseded for nothing. An embodiment the USER opened (a prior
   * `/summon`) is theirs and stays.
   */
  async handleTrigger(userId: string, missionId: string, event: string): Promise<void> {
    const existing = this.active.get(userId);
    if (existing) {
      await this.advance(userId, existing, missionId, event);
      return;
    }
    const config = await this.opts.configStore.findByUserId(userId);
    if (!config) {
      this.opts.logger.info('discord trigger for a user with no config; dropping', {
        operation: 'discord.bridge.trigger',
        userId,
      });
      return;
    }
    if (!config.ownerDiscordUserId) {
      // Not linked yet — there is no owner DM to report the mission into; drop.
      this.opts.logger.info('discord trigger before /link; no owner DM to report into', {
        operation: 'discord.bridge.trigger',
        userId,
      });
      return;
    }
    const channelId = await this.opts.openOwnerDm(userId, config.ownerDiscordUserId);
    if (channelId === null) {
      this.opts.logger.error('discord trigger could not open the owner DM channel', {
        operation: 'discord.bridge.trigger',
        userId,
      });
      return;
    }
    const established = await this.establishEmbodiment({
      userId,
      companionId: config.boundCompanionId,
      encryptedBotToken: config.encryptedBotToken,
      channelId,
      greet: false,
    });
    if (!established) return; // establishEmbodiment logged the reason (fail / superseded).
    const outcome = await this.advance(userId, established.embodiment, missionId, event);
    if (outcome.skipped && established.opened) {
      // The mission is gone — this trigger summoned the companion for nothing. Leave the
      // room silently (no DM notice: the owner never asked for this embodiment). Only when
      // THIS call opened the connection: a reused one belongs to another live caller (a
      // concurrent active-mission wake, or a prior `/summon`) and is not ours to close.
      this.opts.logger.info('discord trigger was stale; tearing down the embodiment it opened', {
        operation: 'discord.bridge.trigger',
        userId,
      });
      await this.teardown(
        userId,
        established.embodiment.connection,
        null,
        'discord.bridge.trigger',
      );
    }
  }

  isSummoned(userId: string): boolean {
    return this.active.has(userId);
  }

  /** Tear down every embodiment (service shutdown). */
  stop(): void {
    for (const embodiment of this.active.values()) {
      embodiment.abort.abort();
      this.safeClose(embodiment.connection);
    }
    this.active.clear();
  }

  private async summon(ctx: SlashCommandContext): Promise<void> {
    if (this.active.has(ctx.userId)) {
      await ctx.reply('I’m already here. ✨');
      return;
    }
    // Read the binding on demand (no snapshot): the bound companion + the encrypted
    // token the mint proof needs. Absent only if the row was deleted mid-session.
    const config = await this.opts.configStore.findByUserId(ctx.userId);
    if (!config) {
      await ctx.reply(
        'I’m not set up here yet — add a bot token in your CobbleCompanion settings.',
      );
      return;
    }
    const established = await this.establishEmbodiment({
      userId: ctx.userId,
      companionId: config.boundCompanionId,
      encryptedBotToken: config.encryptedBotToken,
      channelId: ctx.command.channelId,
      greet: true,
    });
    if (!established) {
      await ctx.reply(
        'I couldn’t come here — I seem to be active somewhere else. Try `/summon` again.',
      );
      return;
    }
    await ctx.reply('I’m here. ✨');
  }

  /**
   * Serialized entry to {@link openEmbodiment}: at most one connect per user is in
   * flight. A caller that lands while another establish is mid-connect (two mission
   * triggers firing faster than the WS handshake, a trigger racing `/summon`) waits
   * for it and then reuses the registered embodiment instead of dialing a second
   * connection — whose claim would supersede the first, and whose late supersede
   * event would in turn tear the second down (the thrash this serialization exists
   * to prevent).
   */
  private async establishEmbodiment(
    input: EstablishEmbodimentInput,
  ): Promise<EstablishResult | null> {
    const prior = this.establishing.get(input.userId);
    const attempt = (async (): Promise<EstablishResult | null> => {
      // Wait for the in-flight establish to settle; its outcome is read from `active`
      // (registered → reuse it; failed → this caller retries with its own connection).
      await prior?.catch(() => undefined);
      const reused = this.active.get(input.userId);
      if (reused) return { embodiment: reused, opened: false };
      const opened = await this.openEmbodiment(input);
      return opened ? { embodiment: opened, opened: true } : null;
    })();
    this.establishing.set(input.userId, attempt);
    try {
      return await attempt;
    } finally {
      if (this.establishing.get(input.userId) === attempt) {
        this.establishing.delete(input.userId);
      }
    }
  }

  /**
   * Open an embodiment connection, claim the room, register it, and start the background
   * loop — the shared core of `/summon` (with the arrival greeting) and a mission trigger
   * (`greet: false`, companion-missions.md §3.4). Returns the registered embodiment, or null
   * if the claim failed or the room was superseded before registration (both logged; the
   * caller decides how to surface it). Never streams a user-facing reply itself. Callers
   * go through {@link establishEmbodiment} — one connect per user at a time.
   */
  private async openEmbodiment(input: EstablishEmbodimentInput): Promise<ActiveEmbodiment | null> {
    const { userId, companionId, encryptedBotToken, channelId, greet } = input;
    const connection = this.opts.connectionFactory({ userId, companionId, encryptedBotToken });
    // The takeover handler is armed before connect() resolves, but the embodiment is only
    // registered in `active` afterwards. A supersession landing in that gap would find
    // nothing in `active` and be silently dropped — so until we register, record it in a
    // flag and reconcile below instead of routing through handleSuperseded.
    let supersededDuringConnect = false;
    connection.onSuperseded(() => {
      if (this.active.has(userId)) {
        // Teardown is identity-guarded: it no-ops unless the registered embodiment is
        // this very connection, so a late event from an already-replaced connection
        // cannot kill its successor.
        void this.handleSuperseded(userId, connection);
      } else {
        supersededDuringConnect = true;
      }
    });
    // An unexpected drop before registration surfaces as a connect() rejection (handled
    // below), so this only needs to reconcile a drop on an already-registered embodiment
    // — the guard makes a pre-registration fire a no-op.
    connection.onClosed(() => {
      if (this.active.has(userId)) {
        void this.handleClosed(userId, connection);
      }
    });
    try {
      await connection.connect();
    } catch (error) {
      // Most likely a supersession before the lease was granted (active elsewhere).
      this.opts.logger.info('discord embodiment did not claim the companion', {
        operation: 'discord.bridge.embody',
        userId,
        error,
      });
      return null;
    }
    if (supersededDuringConnect) {
      // Claimed elsewhere between connect() resolving and registration: tear down the
      // now-dead connection rather than storing a phantom embodiment.
      this.opts.logger.info('discord embodiment superseded before registration', {
        operation: 'discord.bridge.embody',
        userId,
      });
      this.safeClose(connection);
      return null;
    }
    const embodiment: ActiveEmbodiment = {
      companionId,
      connection,
      channelId,
      abort: new AbortController(),
    };
    this.active.set(userId, embodiment);
    // Run the background loop until torn down. Fire-and-forget: a rejection here would
    // otherwise become an unhandled promise rejection, so funnel it into the logger.
    void this.runBackground(userId, embodiment, greet).catch((error: unknown) => {
      this.opts.logger.error('discord background embodiment loop failed', {
        operation: 'discord.bridge.runBackground',
        userId,
        error,
      });
    });
    return embodiment;
  }

  /**
   * Optionally greet on arrival (a `/summon`, not a mission trigger), then run the proactive
   * forward loop (companion-discord.md §8) so autonomous messages reach the room.
   */
  private async runBackground(
    userId: string,
    embodiment: ActiveEmbodiment,
    greet: boolean,
  ): Promise<void> {
    const post = (content: string): Promise<void> =>
      this.opts.notify(userId, embodiment.channelId, content);
    if (greet) {
      await streamGreeting(embodiment.connection, post, this.opts.logger, {
        operation: 'discord.greeting',
        userId,
      });
    }
    await runProactiveLoop(
      embodiment.connection,
      post,
      this.opts.logger,
      { operation: 'discord.proactive', userId },
      embodiment.abort.signal,
    );
  }

  /** Advance the named mission over the live connection, forwarding output to the owner's DM. */
  private async advance(
    userId: string,
    embodiment: ActiveEmbodiment,
    missionId: string,
    event: string,
  ): Promise<MissionAdvanceOutcome> {
    const post = (content: string): Promise<void> =>
      this.opts.notify(userId, embodiment.channelId, content);
    return this.opts.onMissionAdvance(embodiment.connection, post, missionId, event, userId);
  }

  private async status(ctx: SlashCommandContext): Promise<void> {
    await ctx.reply(
      this.active.has(ctx.userId)
        ? 'I’m here in this chat.'
        : 'I’m not here — `/summon` to bring me in.',
    );
  }

  /** The room was claimed elsewhere (newer wins): tear down and point the owner back. */
  private handleSuperseded(userId: string, connection: CompanionConnection): Promise<void> {
    return this.teardown(
      userId,
      connection,
      'I’ve stepped over to the web — `/summon` to bring me back here.',
      'discord.bridge.supersede',
    );
  }

  /** The socket dropped unexpectedly (bounce / timeout / 1006): tear down so the next
   * `/summon` reconnects instead of finding a phantom embodiment over a dead socket. */
  private handleClosed(userId: string, connection: CompanionConnection): Promise<void> {
    return this.teardown(
      userId,
      connection,
      'I lost the connection — `/summon` to bring me back here.',
      'discord.bridge.closed',
    );
  }

  /**
   * Common embodiment teardown: drop it from `active`, abort the proactive loop, close
   * the connection, and DM the owner the given notice (`null` = silent — a teardown the
   * owner shouldn't hear about, like undoing a stale trigger's summon). Identity-guarded
   * and idempotent: it no-ops unless the registered embodiment is exactly `connection` —
   * so a second call for the same user (supersession and close racing) finds nothing,
   * and a stale event from a torn-down connection cannot tear down a successor
   * embodiment.
   */
  private async teardown(
    userId: string,
    connection: CompanionConnection,
    notice: string | null,
    operation: string,
  ): Promise<void> {
    const embodiment = this.active.get(userId);
    if (!embodiment || embodiment.connection !== connection) return;
    this.active.delete(userId);
    embodiment.abort.abort();
    this.safeClose(embodiment.connection);
    if (notice === null) return;
    try {
      await this.opts.notify(userId, embodiment.channelId, notice);
    } catch (error) {
      this.opts.logger.error('discord teardown notice failed to send', {
        operation,
        userId,
        error,
      });
    }
  }

  private safeClose(connection: CompanionConnection): void {
    try {
      connection.close();
    } catch (error) {
      this.opts.logger.error('discord bridge failed to close connection', {
        operation: 'discord.bridge.close',
        error,
      });
    }
  }
}
