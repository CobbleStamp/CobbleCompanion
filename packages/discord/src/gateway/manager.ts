/**
 * The gateway manager (companion-discord.md §2): owns one Discord bot connection per
 * configured user, reconciling the live set against `discord_config` on a poll. It runs
 * as the single always-on sibling worker (plans/discord-surface.md §11) — Discord allows
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
  Logger,
  SlashCommandSpec,
} from './types.js';

/** An inbound DM, tagged with the user whose bot received it and that bot's config. */
export interface DirectMessageContext {
  readonly userId: string;
  readonly config: DiscordConfigRecord;
  readonly message: InboundDirectMessage;
}

export interface GatewayManagerOptions {
  readonly configStore: DiscordConfigStore;
  readonly gatewayFactory: DiscordGatewayFactory;
  /** Decrypt a stored bot token; null when it can't be (logged, the bot is skipped). */
  readonly decryptToken: (encryptedBotToken: string) => string | null;
  /** Inbound-DM sink — the bridge/router (T7+) owns lock/summon/chat handling. */
  readonly onDirectMessage: (ctx: DirectMessageContext) => void;
  /** Global slash commands (re)registered per bot on connect (DM-context enabled). */
  readonly commands: readonly SlashCommandSpec[];
  readonly pollIntervalMs: number;
  readonly logger: Logger;
}

interface RunningBot {
  encryptedBotToken: string;
  config: DiscordConfigRecord;
  readonly gateway: DiscordGateway;
}

export class GatewayManager {
  private readonly bots = new Map<string, RunningBot>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(private readonly opts: GatewayManagerOptions) {}

  /** Initial reconcile, then poll forever (until {@link stop}). */
  async start(): Promise<void> {
    this.running = true;
    await this.sync();
    this.scheduleNextPoll();
  }

  /** Stop polling and disconnect every bot. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const stopping = [...this.bots.values()].map((bot) => this.safeStop(bot));
    this.bots.clear();
    await Promise.all(stopping);
  }

  /** Number of live bots (observability / tests). */
  get size(): number {
    return this.bots.size;
  }

  /**
   * Reconcile the live bots against the current `discord_config` rows: start newly
   * configured bots, restart any whose token changed, refresh config on the rest, and
   * stop bots whose config was removed.
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
    for (const config of configs) {
      seen.add(config.userId);
      const existing = this.bots.get(config.userId);
      if (!existing) {
        await this.startBot(config);
      } else if (existing.encryptedBotToken !== config.encryptedBotToken) {
        // The stored token blob only changes when the row is rewritten (a settings
        // save) → the credential changed, so restart with it.
        await this.safeStop(existing);
        this.bots.delete(config.userId);
        await this.startBot(config);
      } else {
        // Same token; refresh the cached config so handlers see the latest fields.
        existing.config = config;
      }
    }

    for (const [userId, bot] of [...this.bots]) {
      if (!seen.has(userId)) {
        await this.safeStop(bot);
        this.bots.delete(userId);
      }
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
    gateway.onDirectMessage((message) => {
      // Resolve the freshest config at dispatch time (a poll may have refreshed it).
      const current = this.bots.get(config.userId);
      this.opts.onDirectMessage({
        userId: config.userId,
        config: current?.config ?? config,
        message,
      });
    });
    // Record before start so a fast inbound event finds the entry.
    const bot: RunningBot = {
      encryptedBotToken: config.encryptedBotToken,
      config,
      gateway,
    };
    this.bots.set(config.userId, bot);
    try {
      await gateway.start();
      await gateway.registerCommands(this.opts.commands);
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

  private async safeStop(bot: RunningBot): Promise<void> {
    try {
      await bot.gateway.stop();
    } catch (error) {
      this.opts.logger.error('discord gateway failed to stop bot', {
        operation: 'discord.gateway.stop',
        userId: bot.config.userId,
        error,
      });
    }
  }

  private scheduleNextPoll(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      void this.sync().finally(() => this.scheduleNextPoll());
    }, this.opts.pollIntervalMs);
    // Don't let the poll timer alone keep the process alive.
    (this.timer as { unref?: () => void }).unref?.();
  }
}
