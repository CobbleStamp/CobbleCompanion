/**
 * A scriptable fake {@link DiscordGateway} for tests: records lifecycle calls and lets
 * a test drive inbound DMs by hand, with no `discord.js` and no network. Fakes over
 * mocks — we don't own `discord.js`, so we fake its interface, not its internals.
 */

import type {
  DiscordGateway,
  DiscordGatewayFactory,
  InboundDirectMessage,
  InboundProposalAction,
  InboundSlashCommand,
  ProposalCard,
  SlashCommandSpec,
} from '../gateway/types.js';

/** A message the fake "sent" to a DM channel, captured for assertions. */
export interface SentMessage {
  readonly channelId: string;
  readonly content: string;
}

/** A proposal card the fake "sent" to a DM channel, captured for assertions. */
export interface SentProposal {
  readonly channelId: string;
  readonly card: ProposalCard;
}

export class FakeGateway implements DiscordGateway {
  started = false;
  stopped = false;
  registeredCommands: readonly SlashCommandSpec[] = [];
  readonly sent: SentMessage[] = [];
  readonly sentProposals: SentProposal[] = [];
  readonly typingChannels: string[] = [];
  private dmHandler: ((message: InboundDirectMessage) => void) | null = null;
  private commandHandler: ((command: InboundSlashCommand) => void) | null = null;
  private proposalHandler: ((action: InboundProposalAction) => void) | null = null;

  constructor(readonly token: string) {}

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  onDirectMessage(handler: (message: InboundDirectMessage) => void): void {
    this.dmHandler = handler;
  }

  onSlashCommand(handler: (command: InboundSlashCommand) => void): void {
    this.commandHandler = handler;
  }

  onProposalAction(handler: (action: InboundProposalAction) => void): void {
    this.proposalHandler = handler;
  }

  async sendDirectMessage(channelId: string, content: string): Promise<void> {
    this.sent.push({ channelId, content });
  }

  async sendTyping(channelId: string): Promise<void> {
    this.typingChannels.push(channelId);
  }

  async sendProposal(channelId: string, card: ProposalCard): Promise<void> {
    this.sentProposals.push({ channelId, card });
  }

  async registerCommands(commands: readonly SlashCommandSpec[]): Promise<void> {
    this.registeredCommands = [...commands];
  }

  // --- test controls ---

  /** Simulate Discord delivering a DM to this bot. */
  receiveDirectMessage(message: InboundDirectMessage): void {
    this.dmHandler?.(message);
  }

  /**
   * Simulate a slash-command invocation. Returns the captured interaction replies
   * (the command's `reply` pushes into it), so a test can assert what the user saw.
   */
  receiveSlashCommand(input: {
    name: string;
    userId: string;
    channelId?: string;
    options?: Record<string, string>;
  }): string[] {
    const replies: string[] = [];
    this.commandHandler?.({
      name: input.name,
      userId: input.userId,
      channelId: input.channelId ?? 'dm-channel',
      options: input.options ?? {},
      reply: async (content) => {
        replies.push(content);
      },
    });
    return replies;
  }

  /**
   * Simulate a Confirm/Reject button click. Returns the captured follow-up replies and
   * the message edits (`update`), so a test can assert what the user saw.
   */
  receiveProposalAction(input: {
    proposalId: string;
    action: 'confirm' | 'reject';
    userId: string;
    channelId?: string;
  }): { replies: string[]; updates: string[] } {
    const replies: string[] = [];
    const updates: string[] = [];
    this.proposalHandler?.({
      userId: input.userId,
      channelId: input.channelId ?? 'dm-channel',
      proposalId: input.proposalId,
      action: input.action,
      reply: async (content) => {
        replies.push(content);
      },
      update: async (content) => {
        updates.push(content);
      },
    });
    return { replies, updates };
  }
}

/** A factory that captures every {@link FakeGateway} it builds, for assertions. */
export function fakeGatewayFactory(): {
  factory: DiscordGatewayFactory;
  created: FakeGateway[];
  byToken: (token: string) => FakeGateway | undefined;
} {
  const created: FakeGateway[] = [];
  return {
    factory: (token) => {
      const gateway = new FakeGateway(token);
      created.push(gateway);
      return gateway;
    },
    created,
    byToken: (token) => created.find((gateway) => gateway.token === token),
  };
}
