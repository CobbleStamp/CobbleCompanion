/**
 * A scriptable fake {@link DiscordGateway} for tests: records lifecycle calls and lets
 * a test drive inbound DMs by hand, with no `discord.js` and no network. Fakes over
 * mocks — we don't own `discord.js`, so we fake its interface, not its internals.
 */

import type {
  DiscordGateway,
  DiscordGatewayFactory,
  InboundDirectMessage,
  SlashCommandSpec,
} from '../gateway/types.js';

export class FakeGateway implements DiscordGateway {
  started = false;
  stopped = false;
  registeredCommands: readonly SlashCommandSpec[] = [];
  private handler: ((message: InboundDirectMessage) => void) | null = null;

  constructor(readonly token: string) {}

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  onDirectMessage(handler: (message: InboundDirectMessage) => void): void {
    this.handler = handler;
  }

  async registerCommands(commands: readonly SlashCommandSpec[]): Promise<void> {
    this.registeredCommands = [...commands];
  }

  // --- test controls ---

  /** Simulate Discord delivering a DM to this bot. */
  receiveDirectMessage(message: InboundDirectMessage): void {
    this.handler?.(message);
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
