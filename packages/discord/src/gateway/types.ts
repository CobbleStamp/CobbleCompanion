/**
 * The seam between the gateway manager and `discord.js` (companion-discord.md §2).
 * The manager depends only on {@link DiscordGateway}; the real implementation
 * (`discord-js-gateway.ts`) wraps a `discord.js` `Client`, and tests inject a fake
 * (`test/fake-gateway.ts`) — so all routing/lifecycle logic is exercised without a
 * network (fakes over mocks; we don't own `discord.js`, so we fake its surface).
 */

/** Minimal structured logger (kept local so `@cobble/discord` need not import core). */
export interface Logger {
  error(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
}

/** An inbound Discord direct message addressed to a user's bot. */
export interface InboundDirectMessage {
  /** Discord user id of the sender (checked against the owner lock downstream). */
  readonly authorId: string;
  /** The DM channel id (where a reply is sent). */
  readonly channelId: string;
  readonly content: string;
}

/** A global slash command to register on the bot (DM-context enabled). */
export interface SlashCommandSpec {
  readonly name: string;
  readonly description: string;
  /** String options the command accepts (e.g. `code` for `/link`). */
  readonly options?: readonly SlashCommandOptionSpec[];
}

export interface SlashCommandOptionSpec {
  readonly name: string;
  readonly description: string;
  readonly required: boolean;
}

/** An inbound slash-command invocation (a Discord interaction). */
export interface InboundSlashCommand {
  readonly name: string;
  /** Discord user id of the invoker (checked against the owner lock downstream). */
  readonly userId: string;
  readonly channelId: string;
  /** Option name → string value. */
  readonly options: Readonly<Record<string, string>>;
  /** Reply to the interaction (ephemeral — only the invoker sees it). */
  reply(content: string): Promise<void>;
}

/**
 * One bot's connection to Discord's gateway. Created per configured user from its bot
 * token. The manager owns its lifecycle; later tasks add reply/typing/interaction
 * surfaces.
 */
export interface DiscordGateway {
  /** Connect and resolve once the bot is ready (logged in + session established). */
  start(): Promise<void>;
  /** Disconnect and release resources. Safe to call more than once. */
  stop(): Promise<void>;
  /** Register the inbound-DM handler. Set before {@link start}. */
  onDirectMessage(handler: (message: InboundDirectMessage) => void): void;
  /** Register the inbound slash-command handler. Set before {@link start}. */
  onSlashCommand(handler: (command: InboundSlashCommand) => void): void;
  /** Send a message to a DM channel (a reply, a proactive note, a chat turn). */
  sendDirectMessage(channelId: string, content: string): Promise<void>;
  /** Register (idempotently) the global slash commands, with DM context enabled. */
  registerCommands(commands: readonly SlashCommandSpec[]): Promise<void>;
}

/** Builds a gateway for a bot token (the real factory wires `discord.js`). */
export type DiscordGatewayFactory = (botToken: string) => DiscordGateway;
