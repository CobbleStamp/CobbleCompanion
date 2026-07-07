/**
 * The Discord service — the always-on sibling process (plans/discord-surface.md §11).
 * It is the composition root that wires the tested pieces together: the gateway
 * manager (one bot per user) → the owner-locked router → the per-user bridge
 * (summon/chat). {@link assembleService} is the wiring (kept injectable so the full
 * manager→router→bridge→chat path is integration-tested with fakes); {@link startService}
 * builds the real dependencies from config.
 */

import {
  DrizzleDiscordConfigStore,
  createPgDatabase,
  decryptSecret,
  keyFromBase64,
  type DiscordConfigStore,
} from '@cobble/db';
import { handleAdvance } from './advance.js';
import { CompanionBridge, type CompanionConnectionFactory } from './bridge.js';
import { handleChat } from './chat.js';
import { COMMAND_SPECS } from './commands.js';
import { startControlServer, type ControlServer } from './control-server.js';
import { createCompanionConnectionFactory } from './connection.js';
import { createDiscordJsGatewayFactory } from './gateway/discord-js-gateway.js';
import { GatewayManager } from './gateway/manager.js';
import type { DiscordGatewayFactory, Logger } from './gateway/types.js';
import { consoleLogger } from './logger.js';
import { handleNotifyBotCommand } from './notify-command.js';
import { handleProposalAction } from './proposals.js';
import { handleReadOnlyCommand } from './read-commands.js';
import { BotRouter } from './router.js';
import { createMintTokenSource } from './token-source.js';

export interface AssembleServiceParts {
  readonly configStore: DiscordConfigStore;
  readonly gatewayFactory: DiscordGatewayFactory;
  readonly connectionFactory: CompanionConnectionFactory;
  /** Decrypt a stored bot token; null if it can't be (bot skipped). */
  readonly decryptToken: (encryptedBotToken: string) => string | null;
  readonly logger: Logger;
}

export interface AssembledService {
  readonly manager: GatewayManager;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Wire manager → router → bridge. The manager's inbound handlers reference `router`
 * (assigned after the bridge it depends on) — a forward reference that's safe because
 * the handlers only fire after `start()`.
 */
export function assembleService(parts: AssembleServiceParts): AssembledService {
  const { logger } = parts;
  let router: BotRouter;

  const manager = new GatewayManager({
    configStore: parts.configStore,
    gatewayFactory: parts.gatewayFactory,
    decryptToken: parts.decryptToken,
    onDirectMessage: (ctx) => {
      router.handleDirectMessage(ctx).catch((error) => {
        logger.error('discord service: DM handling failed', {
          operation: 'discord.service.dm',
          userId: ctx.userId,
          error,
        });
      });
    },
    onSlashCommand: (ctx) => {
      router.handleSlashCommand(ctx).catch((error) => {
        logger.error('discord service: command handling failed', {
          operation: 'discord.service.command',
          userId: ctx.userId,
          error,
        });
        // The interaction was deferred before dispatch (discord-js-gateway.ts §InteractionCreate),
        // so a rejected handler leaves the owner on a perpetual "thinking…" spinner unless we
        // discharge that reply obligation. Edit the deferred interaction with an error notice
        // (`ctx.reply` becomes an editReply). If that send itself fails there is nothing further
        // we can do, so log it and drop.
        ctx
          .reply('Something went wrong handling that command. Please try again.')
          .catch((replyError: unknown) => {
            logger.error('discord service: failed to send command-error reply', {
              operation: 'discord.service.command',
              userId: ctx.userId,
              error: replyError,
            });
          });
      });
    },
    onGuildMessage: (ctx) => {
      router.handleGuildTrigger(ctx).catch((error) => {
        logger.error('discord service: guild-trigger handling failed', {
          operation: 'discord.service.trigger',
          userId: ctx.userId,
          error,
        });
      });
    },
    onProposalAction: (ctx) => {
      bridge.handleProposalAction(ctx).catch((error) => {
        logger.error('discord service: proposal action failed', {
          operation: 'discord.service.proposal',
          userId: ctx.userId,
          error,
        });
      });
    },
    commands: COMMAND_SPECS,
    logger,
  });

  const bridge = new CompanionBridge({
    connectionFactory: parts.connectionFactory,
    configStore: parts.configStore,
    notify: (userId, channelId, content) => manager.sendDirectMessage(userId, channelId, content),
    openOwnerDm: (userId, discordUserId) => manager.openDmChannel(userId, discordUserId),
    onChat: (ctx, connection) => handleChat(ctx, connection, logger),
    onReadOnlyCommand: (ctx, connection) => handleReadOnlyCommand(ctx, connection, logger),
    // `/notifybot` writes config + refreshes the live bot's mission-wake trust snapshot
    // via the manager's reconcile — no API round-trip, no summon needed.
    onConfigureNotifyBot: (ctx) =>
      handleNotifyBotCommand(
        ctx,
        parts.configStore,
        (userId) => manager.reconcileUser(userId),
        logger,
      ),
    onProposalAction: (ctx, connection) => handleProposalAction(ctx, connection, logger),
    onMissionAdvance: (connection, post, missionId, event, userId) =>
      handleAdvance(connection, post, missionId, event, logger, userId),
    logger,
  });

  router = new BotRouter({
    configStore: parts.configStore,
    onOwnerMessage: (ctx) => bridge.handleOwnerMessage(ctx),
    onOwnerCommand: (ctx) => bridge.handleOwnerCommand(ctx),
    onTrigger: (userId, missionId, event) => bridge.handleTrigger(userId, missionId, event),
    logger,
  });

  return {
    manager,
    start: () => manager.start(),
    stop: async () => {
      await manager.stop();
      bridge.stop();
    },
  };
}

export interface ServiceConfig {
  readonly databaseUrl: string;
  readonly wsBaseUrl: string;
  readonly mintUrl: string;
  readonly serviceClientId: string;
  readonly serviceSecret: string;
  readonly tokenKeyBase64: string;
  /** Port the internal (no-auth, network-isolated) reconcile endpoint listens on
   *  (companion-discord.md §2.1). */
  readonly controlPort: number;
}

/** Read + validate the service's environment. Throws (fail-fast) on a missing var. */
export function loadServiceConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const require_ = (name: string): string => {
    const value = env[name];
    if (!value || value.length === 0) throw new Error(`${name} is required`);
    return value;
  };
  const portRaw = env['DISCORD_SERVICE_PORT'];
  const controlPort = portRaw ? Number.parseInt(portRaw, 10) : 8080;
  if (!Number.isFinite(controlPort) || controlPort <= 0) {
    throw new Error('DISCORD_SERVICE_PORT must be a positive integer');
  }
  return {
    databaseUrl: require_('DATABASE_URL'),
    wsBaseUrl: require_('DISCORD_WS_BASE_URL'),
    mintUrl: require_('DISCORD_MINT_URL'),
    serviceClientId: require_('DISCORD_SERVICE_CLIENT_ID'),
    serviceSecret: require_('DISCORD_SERVICE_SECRET'),
    tokenKeyBase64: require_('DISCORD_TOKEN_KEY'),
    controlPort,
  };
}

/** Build real dependencies from config and start the service. Returns a `stop()`. */
export async function startService(
  config: ServiceConfig,
  logger: Logger = consoleLogger,
): Promise<{ stop: () => Promise<void> }> {
  const { db, pool } = createPgDatabase(config.databaseUrl);
  const configStore = new DrizzleDiscordConfigStore(db);
  const tokenKey = keyFromBase64(config.tokenKeyBase64);
  const decryptToken = (encrypted: string): string | null => {
    const result = decryptSecret(encrypted, tokenKey);
    if (!result.ok) {
      logger.error('discord service: failed to decrypt a bot token', {
        operation: 'discord.service.decrypt',
        reason: result.reason,
      });
      return null;
    }
    return result.plaintext;
  };
  const acquireToken = createMintTokenSource({
    mintUrl: config.mintUrl,
    serviceClientId: config.serviceClientId,
    serviceSecret: config.serviceSecret,
    logger,
  });
  const service = assembleService({
    configStore,
    gatewayFactory: createDiscordJsGatewayFactory(logger),
    connectionFactory: createCompanionConnectionFactory({
      wsBaseUrl: config.wsBaseUrl,
      acquireToken,
      decryptToken,
      logger,
    }),
    decryptToken,
    logger,
  });
  await service.start();
  // Steady-state config discovery (companion-discord.md §2.1): the API POSTs to this
  // internal-only endpoint after a discord_config write so the bot (re)starts at once —
  // no poll. The startup reconcile above is the recovery floor if a trigger is missed.
  const control: ControlServer = await startControlServer({
    port: config.controlPort,
    reconcileUser: (userId) => service.manager.reconcileUser(userId),
    logger,
  });
  logger.info('discord service started', { operation: 'discord.service.start' });
  return {
    stop: async () => {
      await control.close();
      await service.stop();
      await pool.end();
    },
  };
}

// Run as a process only when invoked directly (not when imported by tests).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  startService(loadServiceConfig())
    .then(({ stop }) => {
      const shutdown = (): void => {
        void stop().then(() => process.exit(0));
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    })
    .catch((error: unknown) => {
      consoleLogger.error('discord service failed to start', {
        operation: 'discord.service.start',
        error,
      });
      process.exit(1);
    });
}
