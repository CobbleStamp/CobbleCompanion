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
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  type ButtonInteraction,
  type Message,
} from 'discord.js';
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

/** customId prefix for proposal buttons; `proposal:<action>:<proposalId>`. */
const PROPOSAL_PREFIX = 'proposal';

/** Max wait for a client to reach ClientReady before start() gives up and tears down. */
const START_TIMEOUT_MS = 30_000;

export function createDiscordJsGatewayFactory(logger: Logger): DiscordGatewayFactory {
  return (botToken: string): DiscordGateway => new DiscordJsGateway(botToken, logger);
}

class DiscordJsGateway implements DiscordGateway {
  private readonly client: Client;
  private dmHandler: ((message: InboundDirectMessage) => void) | null = null;
  private guildHandler: ((message: InboundGuildMessage) => void) | null = null;
  private commandHandler: ((command: InboundSlashCommand) => void) | null = null;
  private proposalHandler: ((action: InboundProposalAction) => void) | null = null;

  constructor(
    private readonly botToken: string,
    private readonly logger: Logger,
  ) {
    // `GuildMessages` is required to receive channel-message events at all (the mission
    // wake, companion-missions.md §3.2); without it Discord delivers none. `MessageContent`
    // stays for DMs — and it also lets the guild path read `.content` for a message that
    // @-mentions the bot (which the trigger always does), so no extra privileged intent.
    this.client = new Client({
      intents: [
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel, Partials.Message],
    });
    this.client.on(Events.MessageCreate, (message: Message) => {
      // Never react to the bot's own messages (in a DM or the mission channel).
      if (message.author.id === this.client.user?.id) return;
      if (message.guildId) {
        // A guild (channel) message — the mission wake. The author MAY be a bot (the
        // trigger sender is one), so we do NOT filter bot authors here; the router applies
        // the trust gate (allowlisted sender + configured mission channel).
        this.guildHandler?.({
          authorId: message.author.id,
          channelId: message.channelId,
          messageId: message.id,
          content: message.content,
        });
        return;
      }
      // A DM: never from another bot (the owner lock + bots-can't-DM-bots).
      if (message.author.bot) return;
      this.dmHandler?.({
        authorId: message.author.id,
        channelId: message.channelId,
        content: message.content,
      });
    });
    this.client.on(Events.InteractionCreate, (interaction) => {
      if (interaction.isButton()) {
        this.handleButton(interaction);
        return;
      }
      if (!interaction.isChatInputCommand()) return;
      const options: Record<string, string> = {};
      for (const option of interaction.options.data) {
        if (typeof option.value === 'string') options[option.name] = option.value;
      }
      this.commandHandler?.({
        name: interaction.commandName,
        userId: interaction.user.id,
        channelId: interaction.channelId,
        options,
        reply: async (content) => {
          await interaction.reply({ content, ephemeral: true });
        },
      });
    });
    this.client.on(Events.Error, (error) => {
      this.logger.error('discord client error', { operation: 'discord.client', error });
    });
  }

  async start(): Promise<void> {
    // `login()` rejects only if the HTTP login throws; it can otherwise resolve while
    // the client never reaches ClientReady (Discord outage mid-handshake, a disabled
    // privileged intent stalling identify). Bound the wait so start() always settles —
    // a hung bot must not park the manager's serial reconcile or its poll loop.
    await new Promise<void>((resolve, reject) => {
      const onReady = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.client.off(Events.ClientReady, onReady);
        void this.client.destroy();
        reject(new Error(`discord client did not become ready within ${START_TIMEOUT_MS}ms`));
      }, START_TIMEOUT_MS);
      this.client.once(Events.ClientReady, onReady);
      this.client.login(this.botToken).catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  async stop(): Promise<void> {
    await this.client.destroy();
  }

  botUserId(): string | null {
    return this.client.user?.id ?? null;
  }

  onDirectMessage(handler: (message: InboundDirectMessage) => void): void {
    this.dmHandler = handler;
  }

  onGuildMessage(handler: (message: InboundGuildMessage) => void): void {
    this.guildHandler = handler;
  }

  onSlashCommand(handler: (command: InboundSlashCommand) => void): void {
    this.commandHandler = handler;
  }

  onProposalAction(handler: (action: InboundProposalAction) => void): void {
    this.proposalHandler = handler;
  }

  /** Translate a proposal button click into an {@link InboundProposalAction}. */
  private handleButton(interaction: ButtonInteraction): void {
    const parts = interaction.customId.split(':');
    if (parts.length !== 3 || parts[0] !== PROPOSAL_PREFIX) return;
    const action = parts[1] === 'confirm' ? 'confirm' : parts[1] === 'reject' ? 'reject' : null;
    if (action === null) return;
    const proposalId = parts[2] as string;
    this.proposalHandler?.({
      userId: interaction.user.id,
      channelId: interaction.channelId,
      proposalId,
      action,
      // Edit the original message (drop the buttons) — also acknowledges the interaction.
      update: async (content) => {
        await interaction.update({ content, embeds: [], components: [] });
      },
      // The interaction is acknowledged by `update`, so further posts are follow-ups.
      reply: async (content) => {
        await interaction.followUp({ content });
      },
    });
  }

  async sendDirectMessage(channelId: string, content: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (channel?.isSendable()) {
      await channel.send(content);
    } else {
      this.logger.error('discord sendDirectMessage: channel not sendable', {
        operation: 'discord.send',
        channelId,
      });
    }
  }

  async openDmChannel(discordUserId: string): Promise<string | null> {
    try {
      const user = await this.client.users.fetch(discordUserId);
      const dm = await user.createDM();
      return dm.id;
    } catch (error) {
      this.logger.error('discord openDmChannel: could not open a DM to the user', {
        operation: 'discord.openDmChannel',
        discordUserId,
        error,
      });
      return null;
    }
  }

  async sendTyping(channelId: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (channel?.isTextBased() && 'sendTyping' in channel) {
      await channel.sendTyping();
    }
  }

  async sendProposal(channelId: string, card: ProposalCard): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isSendable()) {
      this.logger.error('discord sendProposal: channel not sendable', {
        operation: 'discord.proposal',
        channelId,
      });
      return;
    }
    const embed = new EmbedBuilder()
      .setTitle('Approval needed')
      .setDescription(card.summary)
      .setFooter({ text: card.toolName });
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${PROPOSAL_PREFIX}:confirm:${card.proposalId}`)
        .setLabel('Confirm')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`${PROPOSAL_PREFIX}:reject:${card.proposalId}`)
        .setLabel('Reject')
        .setStyle(ButtonStyle.Danger),
    );
    await channel.send({ embeds: [embed], components: [row] });
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
      // Option type 3 = STRING.
      options: (command.options ?? []).map((option) => ({
        type: 3,
        name: option.name,
        description: option.description,
        required: option.required,
      })),
      // contexts [1] = BOT_DM, [2] = PRIVATE_CHANNEL; integration_types [0] = guild
      // install, [1] = user install. Together these surface the command in a DM.
      contexts: [1, 2],
      integration_types: [0, 1],
    }));
    const rest = new REST({ version: '10' }).setToken(this.botToken);
    await rest.put(Routes.applicationCommands(applicationId), { body: desired });
  }
}
