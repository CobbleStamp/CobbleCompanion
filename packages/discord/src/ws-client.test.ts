import { describe, expect, it } from 'vitest';
import {
  ConnectionClosedError,
  SupersededError,
  WsTransport,
  type WsSocket,
  type WsSocketFactory,
} from './ws-client.js';

/**
 * A scriptable fake `/ws` socket: the test drives the server side by hand
 * (`open`/`emit`/`closeRemote`) and inspects what the transport sent. No network,
 * fully deterministic — fakes over mocks (we don't own `ws`, so we fake its surface).
 */
class FakeSocket implements WsSocket {
  readyState = 0; // CONNECTING
  readonly sent: Array<{ id: string; method: string; params?: unknown }> = [];
  private readonly listeners = {
    open: [] as Array<() => void>,
    message: [] as Array<(data: string) => void>,
    close: [] as Array<(code: number) => void>,
    error: [] as Array<(error: Error) => void>,
  };

  constructor(
    readonly url: string,
    readonly headers: Record<string, string>,
  ) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data) as { id: string; method: string; params?: unknown });
  }

  close(code = 1000): void {
    this.closeRemote(code);
  }

  on(event: 'open', listener: () => void): void;
  on(event: 'message', listener: (data: string) => void): void;
  on(event: 'close', listener: (code: number) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'open' | 'message' | 'close' | 'error', listener: (...args: never[]) => void): void {
    (this.listeners[event] as Array<typeof listener>).push(listener);
  }

  // --- server-side test controls ---

  open(): void {
    this.readyState = 1; // OPEN
    for (const l of this.listeners.open) l();
  }

  /** Push a server frame to the transport. */
  emit(message: unknown): void {
    const raw = JSON.stringify(message);
    for (const l of this.listeners.message) l(raw);
  }

  closeRemote(code = 1000): void {
    this.readyState = 3; // CLOSED
    for (const l of this.listeners.close) l(code);
  }

  /** The id the transport assigned to the Nth (0-based) request it sent. */
  idOf(index: number): string {
    const message = this.sent[index];
    if (!message) throw new Error(`no request sent at index ${index}`);
    return message.id;
  }
}

/** A factory that captures the single FakeSocket it builds for the test to drive. */
function fakeFactory(): { factory: WsSocketFactory; socket: () => FakeSocket } {
  let built: FakeSocket | null = null;
  return {
    factory: (url, headers) => (built = new FakeSocket(url, headers)),
    socket: () => {
      if (!built) throw new Error('socket not yet created');
      return built;
    },
  };
}

describe('WsTransport', () => {
  it('passes the url and auth headers through to the socket', async () => {
    const { factory, socket } = fakeFactory();
    const transport = new WsTransport(factory);
    const connecting = transport.connect({
      url: 'wss://api.test/ws?access_token=tok',
      headers: { 'x-user-id': 'u1' },
      embodying: false,
    });
    socket().open();
    await connecting;
    expect(socket().url).toBe('wss://api.test/ws?access_token=tok');
    expect(socket().headers).toEqual({ 'x-user-id': 'u1' });
  });

  it('resolves a transport-only connect on socket open', async () => {
    const { factory, socket } = fakeFactory();
    const transport = new WsTransport(factory);
    let opened = false;
    const connecting = transport
      .connect({ url: 'wss://x/ws', headers: {}, embodying: false })
      .then(() => {
        opened = true;
      });
    expect(opened).toBe(false);
    socket().open();
    await connecting;
    expect(opened).toBe(true);
  });

  it('round-trips ping → pong', async () => {
    const { factory, socket } = fakeFactory();
    const transport = new WsTransport(factory);
    const connecting = transport.connect({ url: 'wss://x/ws', headers: {}, embodying: false });
    socket().open();
    await connecting;

    const call = transport.call<{ pong: boolean; echo: unknown }>('ping', { hi: 1 });
    expect(socket().sent[0]).toMatchObject({ method: 'ping', params: { hi: 1 } });
    socket().emit({ id: socket().idOf(0), result: { pong: true, echo: { hi: 1 } } });
    await expect(call).resolves.toEqual({ pong: true, echo: { hi: 1 } });
  });

  it('round-trips auth.me', async () => {
    const { factory, socket } = fakeFactory();
    const transport = new WsTransport(factory);
    const connecting = transport.connect({ url: 'wss://x/ws', headers: {}, embodying: false });
    socket().open();
    await connecting;

    const call = transport.call<{ user: { id: string; email: string | null } }>('auth.me');
    socket().emit({ id: socket().idOf(0), result: { user: { id: 'u-42', email: null } } });
    await expect(call).resolves.toEqual({ user: { id: 'u-42', email: null } });
  });

  it('rejects a call when the server returns an error frame', async () => {
    const { factory, socket } = fakeFactory();
    const transport = new WsTransport(factory);
    const connecting = transport.connect({ url: 'wss://x/ws', headers: {}, embodying: false });
    socket().open();
    await connecting;

    const call = transport.call('embodiment.whoami');
    socket().emit({
      id: socket().idOf(0),
      error: { message: 'not embodied', code: 'not_embodied' },
    });
    await expect(call).rejects.toThrow('not embodied');
  });

  it('waits for embodiment.ready before resolving an embodying connect', async () => {
    const { factory, socket } = fakeFactory();
    const transport = new WsTransport(factory);
    let ready = false;
    const connecting = transport
      .connect({ url: 'wss://x/ws?companion=c1', headers: {}, embodying: true })
      .then(() => {
        ready = true;
      });
    socket().open();
    await Promise.resolve();
    expect(ready).toBe(false); // open alone is not enough while embodying
    socket().emit({ event: 'embodiment.ready', data: { companionId: 'c1' } });
    await connecting;
    expect(ready).toBe(true);
  });

  it('rejects an embodying connect with SupersededError if the room is lost first', async () => {
    const { factory, socket } = fakeFactory();
    const transport = new WsTransport(factory);
    const connecting = transport.connect({
      url: 'wss://x/ws?companion=c1',
      headers: {},
      embodying: true,
    });
    socket().open();
    socket().emit({ event: 'embodiment.superseded', data: { companionId: 'c1' } });
    await expect(connecting).rejects.toBeInstanceOf(SupersededError);
    expect(transport.isSuperseded).toBe(true);
  });

  it('streams chunks and ends on the terminal result', async () => {
    const { factory, socket } = fakeFactory();
    const transport = new WsTransport(factory);
    const connecting = transport.connect({ url: 'wss://x/ws', headers: {}, embodying: false });
    socket().open();
    await connecting;

    const chunks: unknown[] = [];
    const drain = (async () => {
      for await (const chunk of transport.callStream('messages.send', { content: 'hi' })) {
        chunks.push(chunk);
      }
    })();
    const id = socket().idOf(0);
    socket().emit({ id, stream: { type: 'composing' } });
    socket().emit({ id, stream: { type: 'token', value: 'he' } });
    socket().emit({ id, stream: { type: 'token', value: 'llo' } });
    socket().emit({ id, result: { done: true } });
    await drain;
    expect(chunks).toEqual([
      { type: 'composing' },
      { type: 'token', value: 'he' },
      { type: 'token', value: 'llo' },
    ]);
  });

  it('fans out unsolicited events to subscribers', async () => {
    const { factory, socket } = fakeFactory();
    const transport = new WsTransport(factory);
    const connecting = transport.connect({
      url: 'wss://x/ws?companion=c1',
      headers: {},
      embodying: true,
    });
    socket().open();
    socket().emit({ event: 'embodiment.ready', data: { companionId: 'c1' } });
    await connecting;

    const received: Array<{ event: string; data: unknown }> = [];
    transport.onEvent((event, data) => received.push({ event, data }));
    socket().emit({ event: 'companion', data: { type: 'message', message: { id: 'm1' } } });
    expect(received).toEqual([
      { event: 'companion', data: { type: 'message', message: { id: 'm1' } } },
    ]);
  });

  it('fails in-flight calls when the socket closes', async () => {
    const { factory, socket } = fakeFactory();
    const transport = new WsTransport(factory);
    const connecting = transport.connect({ url: 'wss://x/ws', headers: {}, embodying: false });
    socket().open();
    await connecting;

    const call = transport.call('memory.snapshot');
    socket().closeRemote(1006);
    await expect(call).rejects.toBeInstanceOf(ConnectionClosedError);
  });
});
