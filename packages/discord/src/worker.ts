/**
 * The Discord worker — the always-on sibling process (plans/discord-surface.md §11).
 * It is the composition root that wires the tested pieces together: the gateway
 * manager (one bot per user) → the owner-locked router → the per-user bridge
 * (summon/chat). {@link assembleWorker} is the wiring (kept injectable so the full
 * manager→router→bridge→chat path is integration-tested with fakes); {@link startWorker}
 * builds the real dependencies from config.
 */

import {
  DrizzleDiscordConfigStore,
  createPgDatabase,
  decryptSecret,
  keyFromBase64,
  type DiscordConfigStore,
} from '@cobble/db';
import { CompanionBridge, type CompanionConnectionFactory } from './bridge.js';
import { handleChat } from './chat.js';
import { COMMAND_SPECS } from './commands.js';
import { createCompanionConnectionFactory } from './connection.js';
import { createDiscordJsGatewayFactory } from './gateway/discord-js-gateway.js';
import { GatewayManager } from './gateway/manager.js';
import type { DiscordGatewayFactory, Logger } from './gateway/types.js';
import { consoleLogger } from './logger.js';
import { handleReadOnlyCommand } from './read-commands.js';
import { BotRouter } from './router.js';
import { createMintTokenSource } from './token-source.js';

export interface AssembleWorkerParts {
  readonly configStore: DiscordConfigStore;
  readonly gatewayFactory: DiscordGatewayFactory;
  readonly connectionFactory: CompanionConnectionFactory;
  /** Decrypt a stored bot token; null if it can't be (bot skipped). */
  readonly decryptToken: (encryptedBotToken: string) => string | null;
  readonly pollIntervalMs: number;
  readonly logger: Logger;
}

export interface AssembledWorker {
  readonly manager: GatewayManager;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Wire manager → router → bridge. The manager's inbound handlers reference `router`
 * (assigned after the bridge it depends on) — a forward reference that's safe because
 * the handlers only fire after `start()`.
 */
export function assembleWorker(parts: AssembleWorkerParts): AssembledWorker {
  const { logger } = parts;
  let router: BotRouter;

  const manager = new GatewayManager({
    configStore: parts.configStore,
    gatewayFactory: parts.gatewayFactory,
    decryptToken: parts.decryptToken,
    onDirectMessage: (ctx) => {
      router.handleDirectMessage(ctx).catch((error) => {
        logger.error('discord worker: DM handling failed', {
          operation: 'discord.worker.dm',
          userId: ctx.userId,
          error,
        });
      });
    },
    onSlashCommand: (ctx) => {
      router.handleSlashCommand(ctx).catch((error) => {
        logger.error('discord worker: command handling failed', {
          operation: 'discord.worker.command',
          userId: ctx.userId,
          error,
        });
      });
    },
    commands: COMMAND_SPECS,
    pollIntervalMs: parts.pollIntervalMs,
    logger,
  });

  const bridge = new CompanionBridge({
    connectionFactory: parts.connectionFactory,
    notify: (userId, channelId, content) => manager.sendDirectMessage(userId, channelId, content),
    onChat: (ctx, connection) => handleChat(ctx, connection, logger),
    onReadOnlyCommand: (ctx, connection) => handleReadOnlyCommand(ctx, connection, logger),
    logger,
  });

  router = new BotRouter({
    configStore: parts.configStore,
    onOwnerMessage: (ctx) => bridge.handleOwnerMessage(ctx),
    onOwnerCommand: (ctx) => bridge.handleOwnerCommand(ctx),
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

export interface WorkerConfig {
  readonly databaseUrl: string;
  readonly wsBaseUrl: string;
  readonly mintUrl: string;
  readonly serviceClientId: string;
  readonly serviceSecret: string;
  readonly tokenKeyBase64: string;
  readonly pollIntervalMs: number;
}

/** Read + validate the worker's environment. Throws (fail-fast) on a missing var. */
export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const require_ = (name: string): string => {
    const value = env[name];
    if (!value || value.length === 0) throw new Error(`${name} is required`);
    return value;
  };
  const pollRaw = env['DISCORD_POLL_INTERVAL_MS'];
  const pollIntervalMs = pollRaw ? Number.parseInt(pollRaw, 10) : 20_000;
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error('DISCORD_POLL_INTERVAL_MS must be a positive integer');
  }
  return {
    databaseUrl: require_('DATABASE_URL'),
    wsBaseUrl: require_('DISCORD_WS_BASE_URL'),
    mintUrl: require_('DISCORD_MINT_URL'),
    serviceClientId: require_('DISCORD_SERVICE_CLIENT_ID'),
    serviceSecret: require_('DISCORD_SERVICE_SECRET'),
    tokenKeyBase64: require_('DISCORD_TOKEN_KEY'),
    pollIntervalMs,
  };
}

/** Build real dependencies from config and start the worker. Returns a `stop()`. */
export async function startWorker(
  config: WorkerConfig,
  logger: Logger = consoleLogger,
): Promise<{ stop: () => Promise<void> }> {
  const { db, pool } = createPgDatabase(config.databaseUrl);
  const configStore = new DrizzleDiscordConfigStore(db);
  const tokenKey = keyFromBase64(config.tokenKeyBase64);
  const decryptToken = (encrypted: string): string | null => {
    const result = decryptSecret(encrypted, tokenKey);
    if (!result.ok) {
      logger.error('discord worker: failed to decrypt a bot token', {
        operation: 'discord.worker.decrypt',
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
  const worker = assembleWorker({
    configStore,
    gatewayFactory: createDiscordJsGatewayFactory(logger),
    connectionFactory: createCompanionConnectionFactory({
      wsBaseUrl: config.wsBaseUrl,
      acquireToken,
      logger,
    }),
    decryptToken,
    pollIntervalMs: config.pollIntervalMs,
    logger,
  });
  await worker.start();
  logger.info('discord worker started', { operation: 'discord.worker.start' });
  return {
    stop: async () => {
      await worker.stop();
      await pool.end();
    },
  };
}

// Run as a process only when invoked directly (not when imported by tests).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  startWorker(loadWorkerConfig())
    .then(({ stop }) => {
      const shutdown = (): void => {
        void stop().then(() => process.exit(0));
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    })
    .catch((error: unknown) => {
      consoleLogger.error('discord worker failed to start', {
        operation: 'discord.worker.start',
        error,
      });
      process.exit(1);
    });
}
