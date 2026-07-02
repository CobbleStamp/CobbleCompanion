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
  /** Invoke a streaming WS method (the post-approval turn — `proposals.confirm`). */
  callStream(method: string, params?: unknown): AsyncIterable<ChatStreamEvent>;
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
   * Run one mission advance turn over the live connection (companion-missions.md §3.4),
   * forwarding the turn's spoken output to `post` (the embodied room's DM). Injected —
   * mirrors {@link onChat} — so the bridge stays decoupled from the WS method wiring.
   */
  readonly onMissionAdvance: (
    connection: CompanionConnection,
    post: (content: string) => Promise<void>,
    event: string,
    userId: string,
  ) => void | Promise<void>;
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

interface ActiveEmbodiment {
  readonly companionId: string;
  readonly connection: CompanionConnection;
  /** The DM channel to send async notices to (captured at summon). */
  readonly channelId: string;
  /** Aborts the proactive event loop on teardown (supersession / stop). */
  readonly abort: AbortController;
}

export const SUMMON_COMMAND = 'summon';
export const STATUS_COMMAND = 'status';

/** Shown when the owner chats or runs a view while the companion is dormant. */
const DORMANT_NOTICE = 'I’m not here right now — `/summon` to bring me into this chat.';

export class CompanionBridge {
  private readonly active = new Map<string, ActiveEmbodiment>();

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
   * command while dormant is refused with the same "summon first" prompt as chat.
   */
  async handleOwnerCommand(ctx: SlashCommandContext): Promise<void> {
    if (ctx.command.name === SUMMON_COMMAND) return this.summon(ctx);
    if (ctx.command.name === STATUS_COMMAND) return this.status(ctx);
    const embodiment = this.active.get(ctx.userId);
    if (!embodiment) {
      await ctx.reply(DORMANT_NOTICE);
      return;
    }
    return this.opts.onReadOnlyCommand(ctx, embodiment.connection);
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
   * Trigger hook (mission wake, companion-missions.md §3.2–§3.3): summon-if-dormant, then
   * advance the mission. Disruptive by design — establishing embodiment supersedes whatever
   * surface the companion was on. If already embodied, advance over the live connection with
   * no re-summon. Drops (logged) when the user is unlinked (no owner DM to report into) or
   * the connection can't be established.
   */
  async handleTrigger(userId: string, event: string): Promise<void> {
    const existing = this.active.get(userId);
    if (existing) {
      await this.advance(userId, existing, event);
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
    const embodiment = await this.establishEmbodiment({
      userId,
      companionId: config.boundCompanionId,
      encryptedBotToken: config.encryptedBotToken,
      channelId,
      greet: false,
    });
    if (!embodiment) return; // establishEmbodiment logged the reason (fail / superseded).
    await this.advance(userId, embodiment, event);
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
    const embodiment = await this.establishEmbodiment({
      userId: ctx.userId,
      companionId: config.boundCompanionId,
      encryptedBotToken: config.encryptedBotToken,
      channelId: ctx.command.channelId,
      greet: true,
    });
    if (!embodiment) {
      await ctx.reply(
        'I couldn’t come here — I seem to be active somewhere else. Try `/summon` again.',
      );
      return;
    }
    await ctx.reply('I’m here. ✨');
  }

  /**
   * Open an embodiment connection, claim the room, register it, and start the background
   * loop — the shared core of `/summon` (with the arrival greeting) and a mission trigger
   * (`greet: false`, companion-missions.md §3.3). Returns the registered embodiment, or null
   * if the claim failed or the room was superseded before registration (both logged; the
   * caller decides how to surface it). Never streams a user-facing reply itself.
   */
  private async establishEmbodiment(input: {
    userId: string;
    companionId: string;
    encryptedBotToken: string;
    channelId: string;
    greet: boolean;
  }): Promise<ActiveEmbodiment | null> {
    const { userId, companionId, encryptedBotToken, channelId, greet } = input;
    const connection = this.opts.connectionFactory({ userId, companionId, encryptedBotToken });
    // The takeover handler is armed before connect() resolves, but the embodiment is only
    // registered in `active` afterwards. A supersession landing in that gap would find
    // nothing in `active` and be silently dropped — so until we register, record it in a
    // flag and reconcile below instead of routing through handleSuperseded.
    let supersededDuringConnect = false;
    connection.onSuperseded(() => {
      if (this.active.has(userId)) {
        void this.handleSuperseded(userId);
      } else {
        supersededDuringConnect = true;
      }
    });
    // An unexpected drop before registration surfaces as a connect() rejection (handled
    // below), so this only needs to reconcile a drop on an already-registered embodiment
    // — the guard makes a pre-registration fire a no-op.
    connection.onClosed(() => {
      if (this.active.has(userId)) {
        void this.handleClosed(userId);
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

  /** Advance the mission over the live connection, forwarding output to the owner's DM. */
  private async advance(
    userId: string,
    embodiment: ActiveEmbodiment,
    event: string,
  ): Promise<void> {
    const post = (content: string): Promise<void> =>
      this.opts.notify(userId, embodiment.channelId, content);
    await this.opts.onMissionAdvance(embodiment.connection, post, event, userId);
  }

  private async status(ctx: SlashCommandContext): Promise<void> {
    await ctx.reply(
      this.active.has(ctx.userId)
        ? 'I’m here in this chat.'
        : 'I’m not here — `/summon` to bring me in.',
    );
  }

  /** The room was claimed elsewhere (newer wins): tear down and point the owner back. */
  private handleSuperseded(userId: string): Promise<void> {
    return this.teardown(
      userId,
      'I’ve stepped over to the web — `/summon` to bring me back here.',
      'discord.bridge.supersede',
    );
  }

  /** The socket dropped unexpectedly (bounce / timeout / 1006): tear down so the next
   * `/summon` reconnects instead of finding a phantom embodiment over a dead socket. */
  private handleClosed(userId: string): Promise<void> {
    return this.teardown(
      userId,
      'I lost the connection — `/summon` to bring me back here.',
      'discord.bridge.closed',
    );
  }

  /**
   * Common embodiment teardown: drop it from `active`, abort the proactive loop, close
   * the connection, and DM the owner the given notice. Idempotent — a second call for
   * the same user (e.g. supersession and close racing) finds nothing and no-ops.
   */
  private async teardown(userId: string, notice: string, operation: string): Promise<void> {
    const embodiment = this.active.get(userId);
    if (!embodiment) return;
    this.active.delete(userId);
    embodiment.abort.abort();
    this.safeClose(embodiment.connection);
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
