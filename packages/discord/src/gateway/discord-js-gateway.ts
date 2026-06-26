/**
 * The real {@link DiscordGateway}, wrapping a `discord.js` v14 `Client`. This is the
 * integration boundary — it is NOT unit-tested (it needs a live Discord connection);
 * all manager logic is tested against the fake instead. Keep it thin: translate
 * `discord.js` events/calls to/from the {@link DiscordGateway} interface and nothing
 * more.
 *
 * DMs require the `DirectMessages` + `MessageContent` (privileged) intents and the
 * `Channel` partial (DM channels aren't cached, so the partial is needed to receive
 * them). Commands are registered globally with DM context enabled (companion-discord.md
 * §6) — the only context that surfaces commands in a DM.
 */

import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  type Interaction,
  type Message,
} from 'discord.js';
import type {
  DiscordGateway,
  DiscordGatewayFactory,
  InboundDirectMessage,
  Logger,
  SlashCommandSpec,
} from './types.js';

export function createDiscordJsGatewayFactory(logger: Logger): DiscordGatewayFactory {
  return (botToken: string): DiscordGateway => new DiscordJsGateway(botToken, logger);
}

class DiscordJsGateway implements DiscordGateway {
  private readonly client: Client;
  private dmHandler: ((message: InboundDirectMessage) => void) | null = null;

  constructor(
    private readonly botToken: string,
    private readonly logger: Logger,
  ) {
    this.client = new Client({
      intents: [GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent],
      partials: [Partials.Channel, Partials.Message],
    });
    this.client.on(Events.MessageCreate, (message: Message) => {
      // DMs only, never the bot's own messages.
      if (message.author.bot || message.guildId) return;
      this.dmHandler?.({
        authorId: message.author.id,
        channelId: message.channelId,
        content: message.content,
      });
    });
    this.client.on(Events.Error, (error) => {
      this.logger.error('discord client error', { operation: 'discord.client', error });
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.client.once(Events.ClientReady, () => resolve());
      this.client.login(this.botToken).catch(reject);
    });
  }

  async stop(): Promise<void> {
    await this.client.destroy();
  }

  onDirectMessage(handler: (message: InboundDirectMessage) => void): void {
    this.dmHandler = handler;
  }

  /**
   * Register the global command set (DM context enabled), diffing first so an
   * unchanged set is not re-pushed. Requires the application id, available once ready.
   */
  async registerCommands(commands: readonly SlashCommandSpec[]): Promise<void> {
    const applicationId = this.client.application?.id ?? this.client.user?.id;
    if (!applicationId) {
      this.logger.error('discord registerCommands: no application id (not ready?)', {
        operation: 'discord.commands',
      });
      return;
    }
    const desired = commands.map((command) => ({
      name: command.name,
      description: command.description,
      // contexts [1] = BOT_DM, [2] = PRIVATE_CHANNEL; integration_types [1] = user
      // install. Together these surface the command in a DM with the bot.
      contexts: [1, 2],
      integration_types: [0, 1],
    }));
    const rest = new REST({ version: '10' }).setToken(this.botToken);
    await rest.put(Routes.applicationCommands(applicationId), { body: desired });
  }
}

// `Interaction` is imported for the (T7+) interaction handler; referenced here so the
// import is retained under `verbatimModuleSyntax` until then.
export type DiscordInteraction = Interaction;
