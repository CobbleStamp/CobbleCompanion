/**
 * The gateway manager (companion-discord.md §2): owns one Discord bot connection per
 * configured user, reconciling the live set against `discord_config` (startup pass + per-user reconcile triggers). It runs
 * as the single always-on sibling service (plans/discord-surface.md §11) — Discord allows
 * one gateway connection per bot, so this must be singleton. It depends only on the
 * {@link DiscordGateway} seam and the `@cobble/db` config store, never on `@cobble/core`.
 *
 * Inbound DMs are routed to {@link GatewayManagerOptions.onDirectMessage} tagged with the
 * owning user — the bridge/router (T7+) applies the owner lock, summon gating, and chat.
 */

import type { DiscordConfigRecord, DiscordConfigStore } from '@cobble/db';
import type {
  DiscordGateway,
  DiscordGatewayFactory,
  InboundDirectMessage,
  InboundGuildMessage,
  InboundProposalAction,
  InboundSlashCommand,
  Logger,
  ProposalCard,
  SlashCommandSpec,
} from './types.js';

/** An inbound DM, tagged with the user whose bot received it. The handler reads any
 *  config it needs on demand (`configStore.findByUserId`) — no snapshot is carried. */
export interface DirectMessageContext {
  readonly userId: string;
  readonly message: InboundDirectMessage;
  /** Reply in the same DM channel. */
  reply(content: string): Promise<void>;
  /** Show the "typing…" cue in the same DM channel. */
  typing(): Promise<void>;
  /** Post a proposal embed + Confirm/Reject buttons in the same DM channel. */
  sendProposal(card: ProposalCard): Promise<void>;
}

/**
 * An inbound guild (channel) message, tagged with the user whose bot received it — the
 * mission wake (companion-missions.md §3.2). The router applies the trust gate; the manager
 * only tags it. No reply/typing surface: a trigger is not answered in-channel; the mission
 * turn's output rides the owner's DM (§4).
 */
export interface GuildMessageContext {
  readonly userId: string;
  readonly message: InboundGuildMessage;
}

/** An inbound proposal button click, tagged with the owning user. */
export interface ProposalActionContext {
  readonly userId: string;
  readonly proposalId: string;
  readonly action: 'confirm' | 'reject';
  /** The clicker's Discord user id (checked against the owner lock). */
  readonly discordUserId: string;
  /** Post a message (the resolution / streamed turn) in the DM channel. */
  reply(content: string): Promise<void>;
  /** Edit the original proposal message (disable buttons / mark resolved). */
  update(content: string): Promise<void>;
  /** Show the "typing…" cue in the DM channel. */
  typing(): Promise<void>;
  /** Post a further proposal embed (a post-approval turn can hold another action). */
  sendProposal(card: ProposalCard): Promise<void>;
}

/** An inbound slash command, tagged with the owning user. */
export interface SlashCommandContext {
  readonly userId: string;
  readonly command: InboundSlashCommand;
  /** Reply to the interaction (ephemeral). */
  reply(content: string): Promise<void>;
}

export interface GatewayManagerOptions {
  readonly configStore: DiscordConfigStore;
  readonly gatewayFactory: DiscordGatewayFactory;
  /** Decrypt a stored bot token; null when it can't be (logged, the bot is skipped). */
  readonly decryptToken: (encryptedBotToken: string) => string | null;
  /** Inbound-DM sink — the bridge/router owns lock/summon/chat handling. */
  readonly onDirectMessage: (ctx: DirectMessageContext) => void;
  /** Inbound guild-message sink — the router owns the trigger trust gate + parse (mission wake). */
  readonly onGuildMessage: (ctx: GuildMessageContext) => void;
  /** Inbound slash-command sink — the router owns lock + `/link`/summon/commands. */
  readonly onSlashCommand: (ctx: SlashCommandContext) => void;
  /** Inbound proposal-button sink — the bridge owns the owner lock + confirm/reject. */
  readonly onProposalAction: (ctx: ProposalActionContext) => void;
  /** Global slash commands (re)registered per bot on connect (DM-context enabled). */
  readonly commands: readonly SlashCommandSpec[];
  readonly logger: Logger;
}

interface RunningBot {
  readonly userId: string;
  /** The encrypted token the live connection runs on — diffed on reconcile to decide
   *  restart-vs-no-op. The only `discord_config` field the manager holds; everything
   *  else is read on demand (companion-discord.md §2.1). */
  readonly encryptedBotToken: string;
  readonly gateway: DiscordGateway;
}

export class GatewayManager {
  private readonly bots = new Map<string, RunningBot>();

  constructor(private readonly opts: GatewayManagerOptions) {}

  /**
   * One-shot startup reconcile (companion-discord.md §2.1): reconnect every configured
   * bot. There is **no poll** — ongoing token/config changes arrive via
   * {@link reconcileUser}, called by the API's reconcile trigger.
   */
  async start(): Promise<void> {
    await this.sync();
  }

  /** Disconnect every bot. */
  async stop(): Promise<void> {
    const stopping = [...this.bots.values()].map((bot) => this.safeStop(bot));
    this.bots.clear();
    await Promise.all(stopping);
  }

  /** Number of live bots (observability / tests). */
  get size(): number {
    return this.bots.size;
  }

  /**
   * Send a DM through a user's bot (async notices like the supersession notice). A
   * no-op (logged) if that user's bot isn't running.
   */
  async sendDirectMessage(userId: string, channelId: string, content: string): Promise<void> {
    const bot = this.bots.get(userId);
    if (!bot) {
      this.opts.logger.error('discord sendDirectMessage: no running bot for user', {
        operation: 'discord.gateway.send',
        userId,
      });
      return;
    }
    await bot.gateway.sendDirectMessage(channelId, content);
  }

  /**
   * Open (or fetch) the DM channel to a Discord user through a user's bot, for a
   * trigger-summoned embodiment that has no interaction channel in hand
   * (companion-missions.md §4). Returns null if that user's bot isn't running or the DM
   * can't be opened (both logged).
   */
  async openDmChannel(userId: string, discordUserId: string): Promise<string | null> {
    const bot = this.bots.get(userId);
    if (!bot) {
      this.opts.logger.error('discord openDmChannel: no running bot for user', {
        operation: 'discord.gateway.openDm',
        userId,
      });
      return null;
    }
    return bot.gateway.openDmChannel(discordUserId);
  }

  /**
   * Full reconcile (startup): start newly configured bots, restart any whose token
   * changed, and stop bots whose config row was removed. Reads every row once; the
   * steady-state path is the targeted {@link reconcileUser}, not a repeat of this.
   */
  async sync(): Promise<void> {
    let configs: readonly DiscordConfigRecord[];
    try {
      configs = await this.opts.configStore.list();
    } catch (error) {
      this.opts.logger.error('discord gateway sync failed to list config', {
        operation: 'discord.gateway.sync',
        error,
      });
      return;
    }

    const seen = new Set<string>();
    // Fan the bot starts out rather than awaiting each in turn: a slow start (a bot
    // that takes the full ready-timeout to fail) must not block reconciling the others.
    // startBot never rejects (it catches internally), so allSettled is belt-and-braces
    // against a future change.
    const starts: Promise<void>[] = [];
    for (const config of configs) {
      seen.add(config.userId);
      const existing = this.bots.get(config.userId);
      if (!existing) {
        starts.push(this.startBot(config));
      } else if (existing.encryptedBotToken !== config.encryptedBotToken) {
        // The stored token blob only changes when the row is rewritten (a settings
        // save) → the credential changed, so restart with it.
        await this.safeStop(existing);
        this.bots.delete(config.userId);
        starts.push(this.startBot(config));
      }
      // else: same token, already running — nothing to do (no cached config to refresh).
    }
    await Promise.allSettled(starts);

    for (const [userId, bot] of [...this.bots]) {
      if (!seen.has(userId)) {
        await this.safeStop(bot);
        this.bots.delete(userId);
      }
    }
  }

  /**
   * Targeted reconcile for one user (companion-discord.md §2.1) — the steady-state
   * path, invoked by the API's reconcile trigger after a `discord_config` write. Reads
   * **only** that user's row on demand and converges that one bot: start it when a
   * token first appears, restart it when the token changed, stop it when the row is
   * gone. Same token → no-op (so a settings save that didn't touch the token never
   * needlessly drops the gateway connection). Never throws — a read failure is logged
   * and left for the next trigger / a restart's startup reconcile to recover.
   */
  async reconcileUser(userId: string): Promise<void> {
    let config: DiscordConfigRecord | null;
    try {
      config = await this.opts.configStore.findByUserId(userId);
    } catch (error) {
      this.opts.logger.error('discord gateway reconcileUser failed to read config', {
        operation: 'discord.gateway.reconcileUser',
        userId,
        error,
      });
      return;
    }
    const existing = this.bots.get(userId);
    if (!config) {
      if (existing) {
        await this.safeStop(existing);
        this.bots.delete(userId);
      }
      return;
    }
    if (!existing) {
      await this.startBot(config);
      return;
    }
    if (existing.encryptedBotToken !== config.encryptedBotToken) {
      await this.safeStop(existing);
      this.bots.delete(userId);
      await this.startBot(config);
    }
  }

  private async startBot(config: DiscordConfigRecord): Promise<void> {
    const token = this.opts.decryptToken(config.encryptedBotToken);
    if (token === null) {
      this.opts.logger.error('discord gateway cannot decrypt bot token; skipping bot', {
        operation: 'discord.gateway.start',
        userId: config.userId,
      });
      return;
    }
    const gateway = this.opts.gatewayFactory(token);
    // Events are tagged with the owning userId only; the router/bridge read whatever
    // config they need on demand (companion-discord.md §2.1) — no snapshot is carried.
    gateway.onDirectMessage((message) => {
      this.opts.onDirectMessage({
        userId: config.userId,
        message,
        reply: (content) => gateway.sendDirectMessage(message.channelId, content),
        typing: () => gateway.sendTyping(message.channelId),
        sendProposal: (card) => gateway.sendProposal(message.channelId, card),
      });
    });
    gateway.onGuildMessage((message) => {
      this.opts.onGuildMessage({ userId: config.userId, message });
    });
    gateway.onSlashCommand((command) => {
      this.opts.onSlashCommand({
        userId: config.userId,
        command,
        reply: (content) => command.reply(content),
      });
    });
    gateway.onProposalAction((action: InboundProposalAction) => {
      this.opts.onProposalAction({
        userId: config.userId,
        proposalId: action.proposalId,
        action: action.action,
        discordUserId: action.userId,
        reply: (content) => action.reply(content),
        update: (content) => action.update(content),
        typing: () => gateway.sendTyping(action.channelId),
        sendProposal: (card) => gateway.sendProposal(action.channelId, card),
      });
    });
    // Record before start so a fast inbound event finds the entry.
    const bot: RunningBot = {
      userId: config.userId,
      encryptedBotToken: config.encryptedBotToken,
      gateway,
    };
    this.bots.set(config.userId, bot);
    try {
      await gateway.start();
      await gateway.registerCommands(this.opts.commands);
      await this.captureBotUserId(config.userId, gateway);
    } catch (error) {
      this.opts.logger.error('discord gateway failed to start bot', {
        operation: 'discord.gateway.start',
        userId: config.userId,
        error,
      });
      this.bots.delete(config.userId);
      await this.safeStop(bot);
    }
  }

  /**
   * Persist the bot's own Discord user id, known once the gateway is ready
   * (companion-missions.md §1.2) — core reads it to build the mission scheduler action.
   * Best-effort and self-catching: the bot is already up and serving, so a missing id
   * (not yet ready) or a write failure is logged and left for the next connect, never a
   * reason to tear the bot down.
   */
  private async captureBotUserId(userId: string, gateway: DiscordGateway): Promise<void> {
    const botUserId = gateway.botUserId();
    if (botUserId === null) {
      this.opts.logger.warn('discord gateway: bot user id unavailable at start; skipping', {
        operation: 'discord.gateway.botUserId',
        userId,
      });
      return;
    }
    try {
      await this.opts.configStore.setBotUserId(userId, botUserId);
    } catch (error) {
      this.opts.logger.error('discord gateway: failed to persist bot user id', {
        operation: 'discord.gateway.botUserId',
        userId,
        error,
      });
    }
  }

  private async safeStop(bot: RunningBot): Promise<void> {
    try {
      await bot.gateway.stop();
    } catch (error) {
      this.opts.logger.error('discord gateway failed to stop bot', {
        operation: 'discord.gateway.stop',
        userId: bot.userId,
        error,
      });
    }
  }
}
