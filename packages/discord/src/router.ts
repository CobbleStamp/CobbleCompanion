/**
 * The bot router (companion-discord.md §4, §9): the single sink the gateway manager
 * feeds inbound DMs and slash commands into. It owns the **owner lock** (the bot
 * answers only its owner) and the **`/link` handshake** (binding that owner once via a
 * single-use code). Everything that survives the lock — owner DMs and owner commands —
 * is handed to injected handlers that later tasks fill in (summon/status → T8, chat →
 * T9, read-only commands → T10).
 *
 * It depends only on the `@cobble/db` config store and the gateway-context shapes —
 * nothing from `@cobble/core`.
 */

import { secretsEqual, type DiscordConfigStore } from '@cobble/db';
import type {
  DirectMessageContext,
  GuildMessageContext,
  SlashCommandContext,
} from './gateway/manager.js';
import type { Logger } from './gateway/types.js';
import { parseTriggerEvent } from './parse-trigger.js';

/** `/link` codes expire 15 minutes after they're issued (companion-discord.md §9). */
export const LINK_CODE_TTL_MS = 15 * 60 * 1000;

export const LINK_COMMAND = 'link';

export interface RouterOptions {
  readonly configStore: DiscordConfigStore;
  /** Handle an owner DM that passed the lock while linked (summon-gating/chat — T8+). */
  readonly onOwnerMessage: (ctx: DirectMessageContext) => void | Promise<void>;
  /** Handle a non-`/link` owner command that passed the lock (summon/status — T8+). */
  readonly onOwnerCommand: (ctx: SlashCommandContext) => void | Promise<void>;
  /**
   * Handle a mission trigger that passed the trust gate (companion-missions.md §3.2) — a
   * SEPARATE authority from the owner: a trigger sender may only fire a mission advance,
   * never chat/summon/commands. The bridge summons-if-dormant and advances the NAMED
   * mission (every wake carries its mission id).
   */
  readonly onTrigger: (userId: string, missionId: string, event: string) => void | Promise<void>;
  /** Injectable clock (ms) for deterministic TTL tests; defaults to wall clock. */
  readonly now?: () => number;
  readonly logger: Logger;
}

export class BotRouter {
  private readonly now: () => number;

  constructor(private readonly opts: RouterOptions) {
    this.now = opts.now ?? (() => Date.now());
  }

  /** Route an inbound DM through the owner lock. */
  async handleDirectMessage(ctx: DirectMessageContext): Promise<void> {
    const config = await this.opts.configStore.findByUserId(ctx.userId);
    const owner = config?.ownerDiscordUserId ?? null;
    if (owner === null) {
      // Not linked yet — anyone DMing gets the same prompt (no companion data leaks).
      await ctx.reply(
        'This companion isn’t linked yet. Run `/link <code>` with the code from your ' +
          'CobbleCompanion settings to connect.',
      );
      return;
    }
    if (ctx.message.authorId !== owner) {
      // Owner lock: silently ignore anyone else (the bot speaks only to its owner).
      this.opts.logger.info('discord: ignoring DM from non-owner', {
        operation: 'discord.router.dm',
        userId: ctx.userId,
      });
      return;
    }
    await this.opts.onOwnerMessage(ctx);
  }

  /**
   * Route an inbound guild (channel) message as a possible mission trigger
   * (companion-missions.md §3.2). Trust is the (author, channel) PAIR — the author id
   * equals the allowlisted `trigger_bot_id` AND the channel equals `mission_channel_id` —
   * never the message content (anyone in-channel could type a mention). This is a distinct
   * authority from the owner lock: a trigger sender can ONLY fire an advance. Anything that
   * fails the gate is dropped (logged), never answered.
   */
  async handleGuildTrigger(ctx: GuildMessageContext): Promise<void> {
    // The trust snapshot rides the context (the manager holds it per-bot), NOT a per-message
    // config read — a guild message fires for every message the bot can see, so a DB read
    // here would be an un-rate-limited amplification surface (companion-missions.md §3.2).
    const { triggerBotId, missionChannelId } = ctx;
    if (triggerBotId === null || missionChannelId === null) {
      // Mission wake not configured for this user — nothing to trust; drop silently.
      return;
    }
    if (ctx.message.authorId !== triggerBotId || ctx.message.channelId !== missionChannelId) {
      // Not the allowlisted sender, or not the mission channel — not a trusted trigger.
      this.opts.logger.info('discord: ignoring untrusted guild message on the trigger path', {
        operation: 'discord.router.trigger',
        userId: ctx.userId,
      });
      return;
    }
    const trigger = parseTriggerEvent(ctx.message.content);
    if (trigger === null) {
      // Not a well-formed mission wake: no `mission:<id>` tag, or no event text after it.
      // Every wake names its mission (the tag is stamped at arm time) — a message that
      // doesn't cannot be routed, so it is dropped loudly, never advanced on a guess.
      this.opts.logger.error(
        'discord: dropping mission trigger without a valid mission tag or event',
        {
          operation: 'discord.router.trigger',
          userId: ctx.userId,
        },
      );
      return;
    }
    await this.opts.onTrigger(ctx.userId, trigger.missionId, trigger.event);
  }

  /** Route an inbound slash command: `/link` is handled here; the rest pass the lock. */
  async handleSlashCommand(ctx: SlashCommandContext): Promise<void> {
    if (ctx.command.name === LINK_COMMAND) {
      await this.handleLink(ctx);
      return;
    }
    const config = await this.opts.configStore.findByUserId(ctx.userId);
    const owner = config?.ownerDiscordUserId ?? null;
    if (owner === null) {
      await ctx.reply('Link this companion first: `/link <code>` (code in your settings).');
      return;
    }
    if (ctx.command.userId !== owner) {
      await ctx.reply('This companion only responds to its owner.');
      return;
    }
    await this.opts.onOwnerCommand(ctx);
  }

  /**
   * The `/link <code>` handshake: bind the invoker as the owner iff the code matches
   * the stored single-use code and hasn't expired. Re-reads the config so a code minted
   * after the last poll is seen immediately.
   */
  private async handleLink(ctx: SlashCommandContext): Promise<void> {
    const config = await this.opts.configStore.findByUserId(ctx.userId);
    if (!config || config.linkCode === null || config.linkCodeIssuedAt === null) {
      await ctx.reply('No pending link. Generate a code in your CobbleCompanion settings first.');
      return;
    }
    if (this.now() - config.linkCodeIssuedAt.getTime() > LINK_CODE_TTL_MS) {
      await ctx.reply('That code has expired. Generate a new one in your settings.');
      return;
    }
    const provided = ctx.command.options['code'] ?? '';
    if (!secretsEqual(provided, config.linkCode)) {
      await ctx.reply('That code didn’t match. Check your settings and try again.');
      return;
    }
    const consumed = await this.opts.configStore.bindOwner(
      ctx.userId,
      ctx.command.userId,
      config.linkCode,
    );
    if (!consumed) {
      // Another `/link` won the race and consumed the single-use code first.
      await ctx.reply('That code was just used. Generate a new one in your settings to re-link.');
      return;
    }
    this.opts.logger.info('discord: owner linked', {
      operation: 'discord.router.link',
      userId: ctx.userId,
    });
    await ctx.reply('Linked! I’ll answer you here now. Use `/summon` to bring me into this chat.');
  }
}
