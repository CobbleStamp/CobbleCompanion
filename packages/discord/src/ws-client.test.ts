import { describe, expect, it } from 'vitest';
import type { Logger } from './gateway/types.js';
import {
  ConnectionClosedError,
  SupersededError,
  WsTransport,
  type WsSocket,
  type WsSocketFactory,
} from './ws-client.js';

const silent: Logger = { error: () => {}, warn: () => {}, info: () => {} };

/** A logger that records every call, for asserting that drops/throws are logged. */
function recordingLogger(): {
  logger: Logger;
  warns: Array<{ message: string; meta: Record<string, unknown> | undefined }>;
  errors: Array<{ message: string; meta: Record<string, unknown> | undefined }>;
} {
  const warns: Array<{ message: string; meta: Record<string, unknown> | undefined }> = [];
  const errors: Array<{ message: string; meta: Record<string, unknown> | undefined }> = [];
  return {
    logger: {
      error: (message, meta) => errors.push({ message, meta }),
      warn: (message, meta) => warns.push({ message, meta }),
      info: () => {},
    },
    warns,
    errors,
  };
}

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
    this.emitRaw(JSON.stringify(message));
  }

  /** Push a raw (possibly malformed) wire string straight to the transport. */
  emitRaw(raw: string): void {
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
    const transport = new WsTransport({ factory, logger: silent });
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
    const transport = new WsTransport({ factory, logger: silent });
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
    const transport = new WsTransport({ factory, logger: silent });
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
    const transport = new WsTransport({ factory, logger: silent });
    const connecting = transport.connect({ url: 'wss://x/ws', headers: {}, embodying: false });
    socket().open();
    await connecting;

    const call = transport.call<{ user: { id: string; email: string | null } }>('auth.me');
    socket().emit({ id: socket().idOf(0), result: { user: { id: 'u-42', email: null } } });
    await expect(call).resolves.toEqual({ user: { id: 'u-42', email: null } });
  });

  it('rejects a call when the server returns an error frame', async () => {
    const { factory, socket } = fakeFactory();
    const transport = new WsTransport({ factory, logger: silent });
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
    const transport = new WsTransport({ factory, logger: silent });
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
    const transport = new WsTransport({ factory, logger: silent });
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
    const transport = new WsTransport({ factory, logger: silent });
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
    const transport = new WsTransport({ factory, logger: silent });
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
    const transport = new WsTransport({ factory, logger: silent });
    const connecting = transport.connect({ url: 'wss://x/ws', headers: {}, embodying: false });
    socket().open();
    await connecting;

    const call = transport.call('memory.snapshot');
    socket().closeRemote(1006);
    await expect(call).rejects.toBeInstanceOf(ConnectionClosedError);
  });

  it('notifies onClose subscribers when the socket drops, with the close code', async () => {
    const { factory, socket } = fakeFactory();
    const transport = new WsTransport({ factory, logger: silent });
    const connecting = transport.connect({ url: 'wss://x/ws', headers: {}, embodying: false });
    socket().open();
    await connecting;

    // The proactive events() loop subscribes here — it has no in-flight call to fail,
    // so without this notice a drop leaves it parked forever.
    const closes: Array<{ code: number; superseded: boolean; deliberate: boolean }> = [];
    transport.onClose((info) => closes.push(info));
    socket().closeRemote(1006);

    expect(closes).toEqual([{ code: 1006, superseded: false, deliberate: false }]);
  });

  it('marks a caller-initiated close as deliberate so subscribers can skip teardown', async () => {
    const { factory, socket } = fakeFactory();
    const transport = new WsTransport({ factory, logger: silent });
    const connecting = transport.connect({ url: 'wss://x/ws', headers: {}, embodying: false });
    socket().open();
    await connecting;

    const closes: Array<{ deliberate: boolean }> = [];
    transport.onClose((info) => closes.push({ deliberate: info.deliberate }));
    transport.close();

    expect(closes).toEqual([{ deliberate: true }]);
  });

  it('marks a post-supersession close as superseded to onClose subscribers', async () => {
    const { factory, socket } = fakeFactory();
    const transport = new WsTransport({ factory, logger: silent });
    const connecting = transport.connect({
      url: 'wss://x/ws?companion=c1',
      headers: {},
      embodying: true,
    });
    socket().open();
    socket().emit({ event: 'embodiment.ready', data: { companionId: 'c1' } });
    await connecting;

    const closes: Array<{ superseded: boolean }> = [];
    transport.onClose((info) => closes.push({ superseded: info.superseded }));
    socket().emit({ event: 'embodiment.superseded', data: { companionId: 'c1' } });
    socket().closeRemote(1000);

    expect(closes).toEqual([{ superseded: true }]);
  });

  it('an unsubscribed onClose listener is not called', async () => {
    const { factory, socket } = fakeFactory();
    const transport = new WsTransport({ factory, logger: silent });
    const connecting = transport.connect({ url: 'wss://x/ws', headers: {}, embodying: false });
    socket().open();
    await connecting;

    let calls = 0;
    const unsubscribe = transport.onClose(() => (calls += 1));
    unsubscribe();
    socket().closeRemote(1006);

    expect(calls).toBe(0);
  });

  it('isolates a throwing onClose listener: it is logged, not propagated', async () => {
    const { factory, socket } = fakeFactory();
    const { logger, errors } = recordingLogger();
    const transport = new WsTransport({ factory, logger });
    const connecting = transport.connect({ url: 'wss://x/ws', headers: {}, embodying: false });
    socket().open();
    await connecting;

    transport.onClose(() => {
      throw new Error('close listener boom');
    });
    const reached: number[] = [];
    transport.onClose((info) => reached.push(info.code));

    expect(() => socket().closeRemote(1006)).not.toThrow();
    expect(reached).toEqual([1006]); // the second listener still ran
    expect(errors).toHaveLength(1);
    expect(errors[0]?.meta?.code).toBe(1006);
  });

  it('warns and drops an unparseable server frame instead of swallowing it', async () => {
    const { factory, socket } = fakeFactory();
    const { logger, warns } = recordingLogger();
    const transport = new WsTransport({ factory, logger });
    const connecting = transport.connect({ url: 'wss://x/ws', headers: {}, embodying: false });
    socket().open();
    await connecting;

    // A malformed frame must not throw out of the message pump (which would crash the
    // socket handler) and must be logged, not silently dropped.
    expect(() => socket().emitRaw('{not json')).not.toThrow();
    expect(warns).toHaveLength(1);
    expect(warns[0]?.message).toContain('unparseable');
    expect(warns[0]?.meta?.bytes).toBe('{not json'.length);
  });

  it('isolates a throwing event listener: others still run and the throw is logged', async () => {
    const { factory, socket } = fakeFactory();
    const { logger, errors } = recordingLogger();
    const transport = new WsTransport({ factory, logger });
    const connecting = transport.connect({ url: 'wss://x/ws', headers: {}, embodying: false });
    socket().open();
    await connecting;

    const reached: string[] = [];
    transport.onEvent(() => {
      throw new Error('listener boom');
    });
    transport.onEvent((event) => reached.push(event));

    // The first listener throwing must not abort the second nor propagate into the pump.
    expect(() => socket().emit({ event: 'companion', data: {} })).not.toThrow();
    expect(reached).toEqual(['companion']);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.meta?.event).toBe('companion');
  });
});
