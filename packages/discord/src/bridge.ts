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

import type { ChatStreamEvent } from '@cobble/shared';
import type { DirectMessageContext, SlashCommandContext } from './gateway/manager.js';
import type { Logger } from './gateway/types.js';

/** One companion connection (the bridge's view of an embodying `/ws` session). */
export interface CompanionConnection {
  /** Connect and claim embodiment. Resolves on the lease; rejects if superseded/failed. */
  connect(): Promise<void>;
  /** Register the takeover handler: fired if the room is claimed elsewhere post-ready. */
  onSuperseded(handler: () => void): void;
  /** Run a chat turn (`messages.send`), yielding the stream until it ends/throws. */
  chat(content: string): AsyncIterable<ChatStreamEvent>;
  /** Invoke a non-streaming WS method over this connection (the read-only views — T10). */
  call<T>(method: string, params?: unknown): Promise<T>;
  /** Close the connection (deliberate teardown). */
  close(): void;
}

export type CompanionConnectionFactory = (input: {
  userId: string;
  companionId: string;
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
  readonly logger: Logger;
}

interface ActiveEmbodiment {
  readonly companionId: string;
  readonly connection: CompanionConnection;
  /** The DM channel to send async notices to (captured at summon). */
  readonly channelId: string;
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

  isSummoned(userId: string): boolean {
    return this.active.has(userId);
  }

  /** Tear down every embodiment (worker shutdown). */
  stop(): void {
    for (const embodiment of this.active.values()) {
      this.safeClose(embodiment);
    }
    this.active.clear();
  }

  private async summon(ctx: SlashCommandContext): Promise<void> {
    if (this.active.has(ctx.userId)) {
      await ctx.reply('I’m already here. ✨');
      return;
    }
    const companionId = ctx.config.boundCompanionId;
    const connection = this.opts.connectionFactory({ userId: ctx.userId, companionId });
    connection.onSuperseded(() => {
      void this.handleSuperseded(ctx.userId);
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
    this.active.set(ctx.userId, { companionId, connection, channelId: ctx.command.channelId });
    // The arrival greeting (greeting.stream) lands in T12; for now a simple presence cue.
    await ctx.reply('I’m here. ✨');
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
    this.safeClose(embodiment);
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

  private safeClose(embodiment: ActiveEmbodiment): void {
    try {
      embodiment.connection.close();
    } catch (error) {
      this.opts.logger.error('discord bridge failed to close connection', {
        operation: 'discord.bridge.close',
        error,
      });
    }
  }
}
