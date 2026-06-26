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
  defaultSocketFactory,
} from './ws-client.js';
export type { WsSocket, WsSocketFactory, ConnectOptions, EventListener } from './ws-client.js';

export { encryptSecret, decryptSecret, keyFromBase64, secretsEqual, KEY_BYTES } from './crypto.js';
export type { DecryptResult } from './crypto.js';

export { GatewayManager } from './gateway/manager.js';
export type {
  GatewayManagerOptions,
  DirectMessageContext,
  SlashCommandContext,
} from './gateway/manager.js';
export { BotRouter, LINK_CODE_TTL_MS, LINK_COMMAND } from './router.js';
export type { RouterOptions } from './router.js';
export { createDiscordJsGatewayFactory } from './gateway/discord-js-gateway.js';
export type {
  DiscordGateway,
  DiscordGatewayFactory,
  InboundDirectMessage,
  SlashCommandSpec,
  Logger,
} from './gateway/types.js';
