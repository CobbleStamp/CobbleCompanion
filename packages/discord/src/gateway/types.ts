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

/**
 * An inbound Discord GUILD (channel) message — the mission wake path (companion-missions.md
 * §3.2). Unlike a DM, the author may be a bot (the scheduler's trigger sender IS a bot), so
 * the gateway does not filter bot authors here; the router applies the trust gate (author id
 * === the allowlisted trigger bot AND channel === the mission channel). The gateway drops
 * only the companion bot's OWN messages before emitting this.
 */
export interface InboundGuildMessage {
  /** Discord user id of the author (checked against the allowlisted trigger bot downstream). */
  readonly authorId: string;
  /** The channel id (checked against the configured mission channel downstream). */
  readonly channelId: string;
  /** Discord message id (stable id for future replay/dedup). */
  readonly messageId: string;
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
 * A proposal card to render in a DM (companion-discord.md §7): an embed describing the
 * held effectful action, with Confirm and Reject buttons whose ids encode the proposal.
 */
export interface ProposalCard {
  readonly proposalId: string;
  /** The effectful tool the companion wants to run (e.g. `ingest_source`). */
  readonly toolName: string;
  /** Human-readable description of what will happen if confirmed. */
  readonly summary: string;
}

/** An inbound proposal button click (a Discord component interaction). */
export interface InboundProposalAction {
  /** Discord user id of the clicker (checked against the owner lock downstream). */
  readonly userId: string;
  readonly channelId: string;
  readonly proposalId: string;
  readonly action: 'confirm' | 'reject';
  /** Post a message in the DM channel (the resolution / streamed turn). */
  reply(content: string): Promise<void>;
  /** Edit the original proposal message (disable the buttons / mark resolved). */
  update(content: string): Promise<void>;
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
  /**
   * The bot's OWN Discord user id, known once {@link start} has resolved (ClientReady).
   * The manager persists it to `discord_config` so core can build the mission scheduler
   * action that @-mentions this bot (companion-missions.md §1.2). Null before ready.
   */
  botUserId(): string | null;
  /** Register the inbound-DM handler. Set before {@link start}. */
  onDirectMessage(handler: (message: InboundDirectMessage) => void): void;
  /** Register the inbound guild-message handler (the mission wake). Set before {@link start}. */
  onGuildMessage(handler: (message: InboundGuildMessage) => void): void;
  /** Register the inbound slash-command handler. Set before {@link start}. */
  onSlashCommand(handler: (command: InboundSlashCommand) => void): void;
  /** Register the inbound proposal-button handler. Set before {@link start}. */
  onProposalAction(handler: (action: InboundProposalAction) => void): void;
  /** Send a message to a DM channel (a reply, a proactive note, a chat turn). */
  sendDirectMessage(channelId: string, content: string): Promise<void>;
  /**
   * Open (or fetch) the DM channel to a Discord user and return its channel id, so a
   * trigger-summoned embodiment (no interaction in hand) has a channel to report/notice
   * into (companion-missions.md §4 — reports ride the owner's DM). Returns null if the
   * channel can't be opened (logged); the caller drops the trigger.
   */
  openDmChannel(discordUserId: string): Promise<string | null>;
  /** Show the "typing…" indicator in a DM channel (the composing cue). */
  sendTyping(channelId: string): Promise<void>;
  /** Post a proposal embed with Confirm/Reject buttons to a DM channel. */
  sendProposal(channelId: string, card: ProposalCard): Promise<void>;
  /** Register (idempotently) the global slash commands, with DM context enabled. */
  registerCommands(commands: readonly SlashCommandSpec[]): Promise<void>;
}

/** Builds a gateway for a bot token (the real factory wires `discord.js`). */
export type DiscordGatewayFactory = (botToken: string) => DiscordGateway;
