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
  /** Send a DM to a user's bot channel — for async notices (e.g. supersession). */
  readonly notify: (userId: string, channelId: string, content: string) => Promise<void>;
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
    if (
      ctx.config.ownerDiscordUserId !== null &&
      ctx.discordUserId !== ctx.config.ownerDiscordUserId
    ) {
      return; // not the owner — ignore (proposals live in the owner's DM anyway).
    }
    const embodiment = this.active.get(ctx.userId);
    if (!embodiment) {
      await ctx.reply(DORMANT_NOTICE);
      return;
    }
    await this.opts.onProposalAction(ctx, embodiment.connection);
  }

  isSummoned(userId: string): boolean {
    return this.active.has(userId);
  }

  /** Tear down every embodiment (worker shutdown). */
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
    const companionId = ctx.config.boundCompanionId;
    const connection = this.opts.connectionFactory({
      userId: ctx.userId,
      companionId,
      encryptedBotToken: ctx.config.encryptedBotToken,
    });
    // The takeover handler is armed before connect() resolves, but the embodiment is
    // only registered in `active` afterwards. A supersession landing in that gap would
    // find nothing in `active` and be silently dropped — so until we register, record
    // it in a flag and reconcile below instead of routing through handleSuperseded.
    let supersededDuringConnect = false;
    connection.onSuperseded(() => {
      if (this.active.has(ctx.userId)) {
        void this.handleSuperseded(ctx.userId);
      } else {
        supersededDuringConnect = true;
      }
    });
    try {
      await connection.connect();
    } catch (error) {
      // Most likely a supersession before the lease was granted (active elsewhere).
      this.opts.logger.info('discord summon did not claim the companion', {
        operation: 'discord.bridge.summon',
        userId: ctx.userId,
        error,
      });
      await ctx.reply(
        'I couldn’t come here — I seem to be active somewhere else. Try `/summon` again.',
      );
      return;
    }
    if (supersededDuringConnect) {
      // Claimed elsewhere between connect() resolving and registration: tear down the
      // now-dead connection rather than storing a phantom embodiment and lying "I’m here".
      this.opts.logger.info('discord summon superseded before registration', {
        operation: 'discord.bridge.summon',
        userId: ctx.userId,
      });
      this.safeClose(connection);
      await ctx.reply(
        'I couldn’t come here — I seem to be active somewhere else. Try `/summon` again.',
      );
      return;
    }
    const embodiment: ActiveEmbodiment = {
      companionId,
      connection,
      channelId: ctx.command.channelId,
      abort: new AbortController(),
    };
    this.active.set(ctx.userId, embodiment);
    await ctx.reply('I’m here. ✨');
    // Stream the arrival greeting, then forward autonomous messages until torn down.
    // Fire-and-forget: a rejection here would otherwise become an unhandled promise
    // rejection, so funnel it into the structured logger for debugging and audit.
    void this.runBackground(ctx.userId, embodiment).catch((error: unknown) => {
      this.opts.logger.error('discord background embodiment loop failed', {
        operation: 'discord.bridge.runBackground',
        userId: ctx.userId,
        error,
      });
    });
  }

  /** Greet on arrival, then run the proactive forward loop (companion-discord.md §8). */
  private async runBackground(userId: string, embodiment: ActiveEmbodiment): Promise<void> {
    const post = (content: string): Promise<void> =>
      this.opts.notify(userId, embodiment.channelId, content);
    await streamGreeting(embodiment.connection, post, this.opts.logger, {
      operation: 'discord.greeting',
      userId,
    });
    await runProactiveLoop(
      embodiment.connection,
      post,
      this.opts.logger,
      { operation: 'discord.proactive', userId },
      embodiment.abort.signal,
    );
  }

  private async status(ctx: SlashCommandContext): Promise<void> {
    await ctx.reply(
      this.active.has(ctx.userId)
        ? 'I’m here in this chat.'
        : 'I’m not here — `/summon` to bring me in.',
    );
  }

  private async handleSuperseded(userId: string): Promise<void> {
    const embodiment = this.active.get(userId);
    if (!embodiment) return;
    this.active.delete(userId);
    embodiment.abort.abort();
    this.safeClose(embodiment.connection);
    try {
      await this.opts.notify(
        userId,
        embodiment.channelId,
        'I’ve stepped over to the web — `/summon` to bring me back here.',
      );
    } catch (error) {
      this.opts.logger.error('discord supersede notice failed to send', {
        operation: 'discord.bridge.supersede',
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
