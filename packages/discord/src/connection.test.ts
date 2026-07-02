import type { ChatStreamEvent } from '@cobble/shared';
import { describe, expect, it } from 'vitest';
import { createCompanionConnectionFactory } from './connection.js';
import type { Logger } from './gateway/types.js';
import type { WsSocket, WsSocketFactory } from './ws-client.js';

const silent: Logger = { error: () => {}, warn: () => {}, info: () => {} };

/** Flush pending microtasks so the async token acquisition + socket build complete. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Minimal driveable socket (mirrors ws-client.test's fake) to exercise the glue. */
class FakeSocket implements WsSocket {
  readyState = 1;
  readonly sent: string[] = [];
  private readonly listeners: Record<string, Array<(...args: never[]) => void>> = {
    open: [],
    message: [],
    close: [],
    error: [],
  };
  constructor(
    readonly url: string,
    readonly headers: Record<string, string>,
  ) {}
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.fire('close', 1000);
  }
  on(event: 'open' | 'message' | 'close' | 'error', listener: (...args: never[]) => void): void {
    this.listeners[event]!.push(listener);
  }
  fire(event: 'open' | 'message' | 'close' | 'error', arg?: unknown): void {
    for (const l of this.listeners[event]!) (l as (a: unknown) => void)(arg);
  }
  emit(message: unknown): void {
    this.fire('message', JSON.stringify(message));
  }
}

function captureFactory(): { factory: WsSocketFactory; socket: () => FakeSocket } {
  let built: FakeSocket | null = null;
  return {
    factory: (url, headers) => (built = new FakeSocket(url, headers)),
    socket: () => {
      if (!built) throw new Error('socket not built');
      return built;
    },
  };
}

describe('createCompanionConnectionFactory', () => {
  it('decrypts the bot token, mints with it as proof, builds the /ws URL', async () => {
    const { factory, socket } = captureFactory();
    const mintArgs: Array<{ userId: string; botToken: string }> = [];
    const make = createCompanionConnectionFactory({
      wsBaseUrl: 'wss://home.example/',
      acquireToken: async (userId, botToken) => {
        mintArgs.push({ userId, botToken });
        return 'minted-token';
      },
      // The stored blob decrypts to the plaintext bot token the endpoint will verify.
      decryptToken: (enc) => (enc === 'enc-blob' ? 'plain-bot-token' : null),
      socketFactory: factory,
      logger: silent,
    });
    const connection = make({ userId: 'u1', companionId: 'c-9', encryptedBotToken: 'enc-blob' });

    const connecting = connection.connect();
    await tick(); // let acquireToken resolve + the socket build
    socket().fire('open');
    socket().emit({ event: 'embodiment.ready', data: { companionId: 'c-9' } });
    await connecting;

    // The mint received the decrypted bot token as the per-user proof.
    expect(mintArgs).toEqual([{ userId: 'u1', botToken: 'plain-bot-token' }]);
    expect(socket().url).toBe('wss://home.example/ws?access_token=minted-token&companion=c-9');
  });

  it('refuses to connect when the bot token cannot be decrypted', async () => {
    const { factory } = captureFactory();
    const make = createCompanionConnectionFactory({
      wsBaseUrl: 'wss://home.example',
      acquireToken: async () => 'tok',
      decryptToken: () => null, // undecryptable → no proof → must not mint/connect
      socketFactory: factory,
      logger: silent,
    });
    const connection = make({ userId: 'u1', companionId: 'c-9', encryptedBotToken: 'bad' });
    await expect(connection.connect()).rejects.toThrow(/decrypt bot token/);
  });

  it('surfaces a post-ready supersession to the handler', async () => {
    const { factory, socket } = captureFactory();
    const make = createCompanionConnectionFactory({
      wsBaseUrl: 'wss://home.example',
      acquireToken: async () => 'tok',
      decryptToken: () => 'tok',
      socketFactory: factory,
      logger: silent,
    });
    const connection = make({ userId: 'u1', companionId: 'c-9', encryptedBotToken: 'enc' });
    let superseded = false;
    connection.onSuperseded(() => {
      superseded = true;
    });

    const connecting = connection.connect();
    await tick(); // let acquireToken resolve + the socket build
    socket().fire('open');
    socket().emit({ event: 'embodiment.ready', data: {} });
    await connecting;

    socket().emit({ event: 'embodiment.superseded', data: {} });
    expect(superseded).toBe(true);
  });

  it('dedups turn replies and mid-turn messages from the proactive event stream', async () => {
    const { factory, socket } = captureFactory();
    const make = createCompanionConnectionFactory({
      wsBaseUrl: 'wss://home.example',
      acquireToken: async () => 'tok',
      decryptToken: () => 'tok',
      socketFactory: factory,
      logger: silent,
    });
    const connection = make({ userId: 'u1', companionId: 'c-9', encryptedBotToken: 'enc' });
    const connecting = connection.connect();
    await tick();
    socket().fire('open');
    socket().emit({ event: 'embodiment.ready', data: {} });
    await connecting;

    const ac = new AbortController();
    const received: string[] = [];
    const consume = (async () => {
      for await (const event of connection.events(ac.signal)) {
        if (event.type === 'message') received.push(event.message.id);
      }
    })();
    await tick(); // let events() subscribe

    const companionMessage = (id: string): void =>
      socket().emit({
        event: 'companion',
        data: { type: 'message', message: { id, role: 'assistant', content: 'x' } },
      });

    // An autonomous message before any turn → forwarded.
    companionMessage('auto-1');
    await tick();

    // A chat turn is in flight (turnDepth > 0).
    const turn = (async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of connection.chat('yo')) {
        /* drain */
      }
    })();
    await tick(); // the messages.send request (r1) is sent; turnDepth is now 1

    // A message arriving mid-turn is suppressed (it's the turn's own reply).
    companionMessage('mid-1');
    await tick();

    // The turn yields its reply (recorded) and ends.
    socket().emit({
      id: 'r1',
      stream: { type: 'done', message: { id: 'reply-1', role: 'assistant', content: 'reply' } },
    });
    socket().emit({ id: 'r1', result: { done: true } });
    await turn;

    // The same reply now arrives on the live log → deduped by id.
    companionMessage('reply-1');
    // A later autonomous message → forwarded.
    companionMessage('auto-2');
    await tick();

    ac.abort();
    await consume;
    expect(received).toEqual(['auto-1', 'auto-2']);
  });

  it('forwards the method terminal result as the stream return value (the skip flag)', async () => {
    const { factory, socket } = captureFactory();
    const make = createCompanionConnectionFactory({
      wsBaseUrl: 'wss://home.example',
      acquireToken: async () => 'tok',
      decryptToken: () => 'tok',
      socketFactory: factory,
      logger: silent,
    });
    const connection = make({ userId: 'u1', companionId: 'c-9', encryptedBotToken: 'enc' });
    const connecting = connection.connect();
    await tick();
    socket().fire('open');
    socket().emit({ event: 'embodiment.ready', data: {} });
    await connecting;

    // Consume the way handleAdvance does: `yield*` returns the terminal result. This pins
    // recordingStream's manual pump forwarding `next.value` — a rewrite to `for await`
    // would silently lose it and disable teardown-on-skip with every other test green.
    const stream = connection.callStream('mission.advance', { missionId: 'm-1', event: 'tick' });
    let result: unknown;
    const contents: string[] = [];
    const consume = (async () => {
      async function* capture(): AsyncGenerator<ChatStreamEvent, void> {
        result = yield* stream;
      }
      for await (const chunk of capture()) {
        if (chunk.type === 'done') contents.push(chunk.message.content);
      }
    })();
    await tick(); // the mission.advance request (r1) is sent

    socket().emit({
      id: 'r1',
      stream: { type: 'done', message: { id: 'rep-1', role: 'assistant', content: 'stale' } },
    });
    socket().emit({ id: 'r1', result: { done: true, skipped: 'mission not active' } });
    await consume;

    expect(contents).toEqual(['stale']);
    expect(result).toEqual({ done: true, skipped: 'mission not active' });
  });

  it('ends the events() loop when the socket drops (no abort needed)', async () => {
    const { factory, socket } = captureFactory();
    const make = createCompanionConnectionFactory({
      wsBaseUrl: 'wss://home.example',
      acquireToken: async () => 'tok',
      decryptToken: () => 'tok',
      socketFactory: factory,
      logger: silent,
    });
    const connection = make({ userId: 'u1', companionId: 'c-9', encryptedBotToken: 'enc' });
    const connecting = connection.connect();
    await tick();
    socket().fire('open');
    socket().emit({ event: 'embodiment.ready', data: {} });
    await connecting;

    // The proactive loop is parked waiting on a companion event. A plain socket drop
    // (not a supersession, not a deliberate close) must end the generator — otherwise
    // it waits forever and the bridge never reconciles the dead embodiment.
    let ended = false;
    const ac = new AbortController();
    const consume = (async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of connection.events(ac.signal)) {
        /* drain */
      }
      ended = true;
    })();
    await tick(); // let events() subscribe and park

    socket().fire('close', 1006);
    await consume;
    expect(ended).toBe(true);
  });

  it('reports an unexpected drop to the onClosed handler, but not a supersession', async () => {
    const { factory, socket } = captureFactory();
    const make = createCompanionConnectionFactory({
      wsBaseUrl: 'wss://home.example',
      acquireToken: async () => 'tok',
      decryptToken: () => 'tok',
      socketFactory: factory,
      logger: silent,
    });

    // An unexpected drop fires onClosed.
    const dropped = make({ userId: 'u1', companionId: 'c-9', encryptedBotToken: 'enc' });
    let closedCalls = 0;
    dropped.onClosed(() => (closedCalls += 1));
    const connecting = dropped.connect();
    await tick();
    socket().fire('open');
    socket().emit({ event: 'embodiment.ready', data: {} });
    await connecting;
    socket().fire('close', 1006);
    expect(closedCalls).toBe(1);
  });

  it('does not fire onClosed when the close follows a supersession', async () => {
    const { factory, socket } = captureFactory();
    const make = createCompanionConnectionFactory({
      wsBaseUrl: 'wss://home.example',
      acquireToken: async () => 'tok',
      decryptToken: () => 'tok',
      socketFactory: factory,
      logger: silent,
    });
    const connection = make({ userId: 'u1', companionId: 'c-9', encryptedBotToken: 'enc' });
    let supersededCalls = 0;
    let closedCalls = 0;
    connection.onSuperseded(() => (supersededCalls += 1));
    connection.onClosed(() => (closedCalls += 1));
    const connecting = connection.connect();
    await tick();
    socket().fire('open');
    socket().emit({ event: 'embodiment.ready', data: {} });
    await connecting;

    // Supersession then the socket closes: the supersededHandler owns teardown, so
    // onClosed must stay silent (no double teardown).
    socket().emit({ event: 'embodiment.superseded', data: {} });
    socket().fire('close', 1000);
    expect(supersededCalls).toBe(1);
    expect(closedCalls).toBe(0);
  });
});
