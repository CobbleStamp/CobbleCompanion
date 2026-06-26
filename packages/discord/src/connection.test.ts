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
  it('mints a token, builds the /ws URL, and claims embodiment', async () => {
    const { factory, socket } = captureFactory();
    const make = createCompanionConnectionFactory({
      wsBaseUrl: 'wss://home.example/',
      acquireToken: async () => 'minted-token',
      socketFactory: factory,
      logger: silent,
    });
    const connection = make({ userId: 'u1', companionId: 'c-9' });

    const connecting = connection.connect();
    await tick(); // let acquireToken resolve + the socket build
    socket().fire('open');
    socket().emit({ event: 'embodiment.ready', data: { companionId: 'c-9' } });
    await connecting;

    expect(socket().url).toBe('wss://home.example/ws?access_token=minted-token&companion=c-9');
  });

  it('surfaces a post-ready supersession to the handler', async () => {
    const { factory, socket } = captureFactory();
    const make = createCompanionConnectionFactory({
      wsBaseUrl: 'wss://home.example',
      acquireToken: async () => 'tok',
      socketFactory: factory,
      logger: silent,
    });
    const connection = make({ userId: 'u1', companionId: 'c-9' });
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
      socketFactory: factory,
      logger: silent,
    });
    const connection = make({ userId: 'u1', companionId: 'c-9' });
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
});
