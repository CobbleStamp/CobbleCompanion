import { describe, expect, it } from 'vitest';
import {
  ConnectionClosedError,
  StreamQueue,
  SupersededError,
  WsCallError,
  WsTransport,
  type WsSocket,
  type WsSocketFactory,
  type WsTransportLogger,
} from './ws-transport.js';

const silent: WsTransportLogger = { error: () => {}, warn: () => {} };

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
    for (const l of this.listeners.message) l(JSON.stringify(message));
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

/** Open a transport-only connection and return the driven transport + its socket. */
async function connectedTransport(): Promise<{ transport: WsTransport; socket: () => FakeSocket }> {
  const { factory, socket } = fakeFactory();
  const transport = new WsTransport({ factory, logger: silent });
  const connecting = transport.connect({ url: 'wss://x/ws', headers: {}, embodying: false });
  socket().open();
  await connecting;
  return { transport, socket };
}

describe('StreamQueue', () => {
  it('yields buffered frames in push order', async () => {
    const queue = new StreamQueue();
    queue.push('a');
    queue.push('b');
    queue.push('c');
    queue.end();

    const out: unknown[] = [];
    for await (const chunk of queue.iterate()) out.push(chunk);
    expect(out).toEqual(['a', 'b', 'c']);
  });

  it('resolves a parked waiter when a later frame arrives', async () => {
    const queue = new StreamQueue();
    const out: unknown[] = [];
    const drain = (async () => {
      for await (const chunk of queue.iterate()) {
        out.push(chunk);
        if (out.length === 2) return; // stop after two so iteration can settle
      }
    })();

    // The consumer is now parked on an empty buffer; pushing wakes it in order.
    await Promise.resolve();
    queue.push('first');
    await Promise.resolve();
    queue.push('second');
    await drain;
    expect(out).toEqual(['first', 'second']);
  });

  it('end() terminates a parked iteration', async () => {
    const queue = new StreamQueue();
    const out: unknown[] = [];
    const drain = (async () => {
      for await (const chunk of queue.iterate()) out.push(chunk);
    })();
    await Promise.resolve(); // park the waiter
    queue.end();
    await drain;
    expect(out).toEqual([]);
  });

  it('fail() makes a parked iteration throw the failure', async () => {
    const queue = new StreamQueue();
    const boom = new Error('stream boom');
    const drain = (async () => {
      for await (const _ of queue.iterate()) void _;
    })();
    await Promise.resolve(); // park the waiter
    queue.fail(boom);
    await expect(drain).rejects.toBe(boom);
  });

  it('fail() drains the buffer first, then throws (double-failure re-check in iterate)', async () => {
    // A frame is buffered, then the stream fails while the consumer is between yields.
    // iterate() yields the buffered frame, parks, and the post-await failure re-check
    // (the second `if (this.failure) throw` guard) surfaces the error.
    const queue = new StreamQueue();
    const boom = new Error('late boom');
    queue.push('buffered');

    const out: unknown[] = [];
    const drain = (async () => {
      for await (const chunk of queue.iterate()) {
        out.push(chunk);
        queue.fail(boom); // fail right after the buffered frame is consumed
      }
    })();
    await expect(drain).rejects.toBe(boom);
    expect(out).toEqual(['buffered']);
  });

  it('ignores push/end/fail after the queue is terminated', async () => {
    const queue = new StreamQueue();
    queue.push('a');
    queue.end();
    queue.push('ignored'); // dropped: already finished
    queue.fail(new Error('ignored too'));

    const out: unknown[] = [];
    for await (const chunk of queue.iterate()) out.push(chunk);
    expect(out).toEqual(['a']);
  });
});

describe('WsTransport demux', () => {
  it('resolves the pending call on a matching result envelope', async () => {
    const { transport, socket } = await connectedTransport();
    const call = transport.call<{ pong: boolean }>('ping', { hi: 1 });
    expect(socket().sent[0]).toMatchObject({ method: 'ping', params: { hi: 1 } });
    socket().emit({ id: socket().idOf(0), result: { pong: true } });
    await expect(call).resolves.toEqual({ pong: true });
  });

  it('rejects the pending call with WsCallError (carrying code) on an error envelope', async () => {
    const { transport, socket } = await connectedTransport();
    const call = transport.call('embodiment.whoami');
    socket().emit({
      id: socket().idOf(0),
      error: { message: 'not embodied', code: 'not_embodied' },
    });
    await expect(call).rejects.toBeInstanceOf(WsCallError);
    await call.catch((error: WsCallError) => {
      expect(error.message).toBe('not embodied');
      expect(error.code).toBe('not_embodied');
    });
  });

  it('feeds stream frames into the queue and ends on the terminal result', async () => {
    const { transport, socket } = await connectedTransport();
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

  it('returns the terminal result as the stream generator’s return value', async () => {
    // The skip flag of a stale mission.advance rides the terminal result — a consumer
    // that `yield*`s the stream must see it (a plain `for await` ignores it by design).
    const { transport, socket } = await connectedTransport();
    const chunks: unknown[] = [];
    let terminal: unknown;
    const drain = (async () => {
      const stream = transport.callStream('mission.advance', { event: 'tick' });
      let next = await stream.next();
      while (!next.done) {
        chunks.push(next.value);
        next = await stream.next();
      }
      terminal = next.value;
    })();
    const id = socket().idOf(0);
    socket().emit({ id, stream: { type: 'composing' } });
    socket().emit({ id, result: { done: true, skipped: 'no active mission' } });
    await drain;
    expect(chunks).toEqual([{ type: 'composing' }]);
    expect(terminal).toEqual({ done: true, skipped: 'no active mission' });
  });

  it('fails the stream with WsCallError on an error envelope mid-stream', async () => {
    const { transport, socket } = await connectedTransport();
    const drain = (async () => {
      for await (const _ of transport.callStream('messages.send')) void _;
    })();
    const id = socket().idOf(0);
    socket().emit({ id, stream: { type: 'token', value: 'partial' } });
    socket().emit({ id, error: { message: 'over cap', code: 'over_cap' } });
    await expect(drain).rejects.toBeInstanceOf(WsCallError);
  });
});

describe('WsTransport lifecycle', () => {
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

  it('sets superseded and rejects the open with SupersededError when the room is lost first', async () => {
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
});

describe('WsTransport close handling', () => {
  it('rejects in-flight calls with ConnectionClosedError carrying the code', async () => {
    const { transport, socket } = await connectedTransport();
    const call = transport.call('memory.snapshot');
    socket().closeRemote(1006);
    await expect(call).rejects.toBeInstanceOf(ConnectionClosedError);
    await call.catch((error: ConnectionClosedError) => {
      expect(error.message).toContain('1006');
    });
  });

  it('fails in-flight streams with ConnectionClosedError on close', async () => {
    const { transport, socket } = await connectedTransport();
    const drain = (async () => {
      for await (const _ of transport.callStream('messages.send')) void _;
    })();
    socket().idOf(0); // ensure the stream request went out
    socket().closeRemote(1006);
    await expect(drain).rejects.toBeInstanceOf(ConnectionClosedError);
  });

  it('rejects in-flight calls with SupersededError when superseded before close', async () => {
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

    const call = transport.call('memory.snapshot');
    socket().emit({ event: 'embodiment.superseded', data: { companionId: 'c1' } });
    socket().closeRemote(1000);
    await expect(call).rejects.toBeInstanceOf(SupersededError);
  });
});

describe('WsTransport send guard', () => {
  it('drops a write (no throw) when the socket is not open', async () => {
    const { factory, socket } = fakeFactory();
    const transport = new WsTransport({ factory, logger: silent });
    const connecting = transport.connect({ url: 'wss://x/ws', headers: {}, embodying: false });
    socket().open();
    await connecting;

    // Close drops the socket to readyState CLOSED; a subsequent call must not throw,
    // and the pending entry is failed via the close path rather than by a send error.
    socket().closeRemote(1006);
    expect(() => {
      void transport.call('ping').catch(() => {});
    }).not.toThrow();
    // Nothing was written after the close.
    expect(socket().sent).toHaveLength(0);
  });
});
