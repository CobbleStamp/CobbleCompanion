/**
 * `@cobble/discord` — the decoupled Discord surface adapter
 * (`docs/companion-discord.md`). It speaks only the public `/ws` contract
 * (`docs/companion-endpoints.md`); it imports nothing from `@cobble/core`.
 *
 * Build status: scaffolding (T1) — the WebSocket transport. The gateway manager,
 * bridge, and worker entrypoint land in later tasks (`docs/plans/discord-surface.md`
 * §9).
 */

export {
  WsTransport,
  SupersededError,
  ConnectionClosedError,
  WsCallError,
  defaultSocketFactory,
} from './ws-client.js';
export type { WsSocket, WsSocketFactory, ConnectOptions, EventListener } from './ws-client.js';

// Token-at-rest crypto + the `/link` code generator now live in `@cobble/db` (the
// shared data layer) so the api can encrypt on write; import them from there.

export { GatewayManager } from './gateway/manager.js';
export type {
  GatewayManagerOptions,
  DirectMessageContext,
  SlashCommandContext,
} from './gateway/manager.js';
export { BotRouter, LINK_CODE_TTL_MS, LINK_COMMAND } from './router.js';
export type { RouterOptions } from './router.js';

export { CompanionBridge, SUMMON_COMMAND, STATUS_COMMAND } from './bridge.js';
export type {
  CompanionBridgeOptions,
  CompanionConnection,
  CompanionConnectionFactory,
} from './bridge.js';
export { createCompanionConnectionFactory } from './connection.js';
export type { CompanionConnectionDeps } from './connection.js';
export { handleChat } from './chat.js';
export { COMMAND_SPECS } from './commands.js';
export { consoleLogger } from './logger.js';
export { createMintTokenSource } from './token-source.js';
export type { MintTokenSourceDeps } from './token-source.js';
export { assembleWorker, loadWorkerConfig, startWorker } from './worker.js';
export type { AssembleWorkerParts, AssembledWorker, WorkerConfig } from './worker.js';
export { createDiscordJsGatewayFactory } from './gateway/discord-js-gateway.js';
export type {
  DiscordGateway,
  DiscordGatewayFactory,
  InboundDirectMessage,
  SlashCommandSpec,
  Logger,
} from './gateway/types.js';
