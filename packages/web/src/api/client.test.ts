/**
 * The WebSocket transport (Phase D, D6). These pin the request/reply correlation,
 * streaming, the live-event channel, the superseded handoff, and the presigned
 * two-step file upload (slot request over WS → direct PUT to the backend → enqueue;
 * staging-object-storage.md) — exercised through the public client API over a
 * controllable fake socket.
 */

import type { ChatStreamEvent, CompanionStreamEvent, MessageDto } from '@cobble/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  confirmProposal,
  createCompanion,
  fetchBudget,
  fetchMessages,
  getFood,
  listCompanions,
  onEmbodimentMoved,
  reclaimEmbodiment,
  sendMessage,
  setAccessTokenGetter,
  subscribeCompanionEvents,
  uploadFileSource,
} from './client.js';

/** A drivable WebSocket double: records sent frames, opens on the next microtask,
 *  and lets the test push server frames or close the socket. */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState: number = FakeWebSocket.CONNECTING;
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.();
      // Mirror the server granting the embodiment lease: a companion-scoped socket
      // becomes usable only after `embodiment.ready`, which the transport waits for
      // before sending companion-scoped frames.
      if (this.url.includes('companion=')) {
        this.onmessage?.({ data: JSON.stringify({ event: 'embodiment.ready', data: {} }) });
      }
    });
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code });
  }

  /** Push a server frame to the transport. */
  serverSend(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** The current (latest) fake socket, after letting it open. */
async function liveSocket(): Promise<FakeWebSocket> {
  await tick();
  const socket = FakeWebSocket.instances.at(-1);
  if (!socket) throw new Error('no socket opened');
  return socket;
}

/** The parsed request envelope the transport last sent on `socket`. */
function lastRequest(socket: FakeWebSocket): { id: string; method: string; params: unknown } {
  const raw = socket.sent.at(-1);
  if (!raw) throw new Error('no frame sent');
  return JSON.parse(raw) as { id: string; method: string; params: unknown };
}

beforeEach(() => {
  setAccessTokenGetter(async () => 'tok');
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
});

afterEach(() => {
  // Drop any socket so the next test reconnects fresh, and clear a superseded yield.
  for (const socket of FakeWebSocket.instances) {
    if (socket.readyState === FakeWebSocket.OPEN) socket.close();
  }
  reclaimEmbodiment();
  vi.unstubAllGlobals();
  setAccessTokenGetter(async () => null);
});

describe('WS request/reply correlation', () => {
  it('opens a companion-scoped socket and resolves a call by id', async () => {
    const promise = fetchBudget('c1');
    const socket = await liveSocket();
    expect(socket.url).toContain('/ws?');
    expect(socket.url).toContain('access_token=tok');
    expect(socket.url).toContain('companion=c1');

    const request = lastRequest(socket);
    expect(request.method).toBe('budget.get');
    const budget = { stamina: { balanceTokens: 1 }, energy: { balanceTokens: 2 } };
    socket.serverSend({ id: request.id, result: budget });

    expect(await promise).toEqual(budget);
  });

  it('opens a transport-only socket (no companion) for an agnostic call', async () => {
    const promise = listCompanions();
    const socket = await liveSocket();
    expect(socket.url).not.toContain('companion=');

    const request = lastRequest(socket);
    expect(request.method).toBe('companions.list');
    socket.serverSend({ id: request.id, result: { companions: [] } });
    expect(await promise).toEqual([]);
  });

  it('sends the params an RPC method expects', async () => {
    const promise = createCompanion({ name: 'Cobble', form: 'fox', temperament: 'curious' });
    const socket = await liveSocket();
    const request = lastRequest(socket);
    expect(request.method).toBe('companions.create');
    expect(request.params).toEqual({ name: 'Cobble', form: 'fox', temperament: 'curious' });
    socket.serverSend({ id: request.id, result: { companion: { id: 'k1' } } });
    expect((await promise).id).toBe('k1');
  });

  it('unwraps a wrapped agnostic result (getFood → food)', async () => {
    const food = { ration: 10, spark: 10, treat: 10 };
    const promise = getFood();
    const socket = await liveSocket();
    socket.serverSend({ id: lastRequest(socket).id, result: { food } });
    expect(await promise).toEqual(food);
  });

  it('reuses the open socket for a second same-companion call', async () => {
    const first = fetchMessages('c1');
    const socket = await liveSocket();
    socket.serverSend({ id: lastRequest(socket).id, result: { messages: [] } });
    await first;

    const opened = FakeWebSocket.instances.length;
    const second = fetchBudget('c1');
    await tick();
    expect(FakeWebSocket.instances.length).toBe(opened); // no reconnect
    socket.serverSend({ id: lastRequest(socket).id, result: { stamina: {}, energy: {} } });
    await second;
  });
});

describe('streaming methods', () => {
  async function collect(stream: AsyncGenerator<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
    const events: ChatStreamEvent[] = [];
    for await (const event of stream) events.push(event);
    return events;
  }

  it('yields each streamed chunk then ends on the terminal result', async () => {
    const events: ChatStreamEvent[] = [];
    const done = (async () => {
      for await (const event of sendMessage('c1', 'hi')) events.push(event);
    })();
    const socket = await liveSocket();
    const { id, method } = lastRequest(socket);
    expect(method).toBe('messages.send');

    socket.serverSend({ id, stream: { type: 'token', value: 'He' } });
    socket.serverSend({ id, stream: { type: 'token', value: 'llo' } });
    socket.serverSend({ id, result: { done: true } });
    await done;

    expect(events).toEqual([
      { type: 'token', value: 'He' },
      { type: 'token', value: 'llo' },
    ]);
  });

  it('throws out of the stream on a terminal error frame (confirmProposal)', async () => {
    const promise = collect(confirmProposal('c1', 'p1'));
    const socket = await liveSocket();
    const { id } = lastRequest(socket);
    socket.serverSend({
      id,
      error: { message: 'Cobble is out of stamina for now. Feed it a Ration to continue.' },
    });
    await expect(promise).rejects.toThrow('Cobble is out of stamina for now');
  });
});

describe('subscribeCompanionEvents live channel', () => {
  function row(id: string): MessageDto {
    return {
      id,
      companionId: 'c1',
      role: 'assistant',
      content: `row ${id}`,
      kind: 'message',
      sourceId: null,
      createdAt: '2026-01-03T00:00:00.000Z',
    };
  }

  it('yields pushed companion events, ignoring other server frames', async () => {
    const controller = new AbortController();
    const got: CompanionStreamEvent[] = [];
    const done = (async () => {
      for await (const event of subscribeCompanionEvents('c1', controller.signal)) {
        got.push(event);
        if (got.length === 2) controller.abort();
      }
    })();
    const socket = await liveSocket();

    socket.serverSend({ event: 'companion', data: { type: 'message', message: row('m1') } });
    socket.serverSend({ id: 'rX', result: { ignored: true } }); // a stray reply: ignored
    socket.serverSend({
      event: 'companion',
      data: { type: 'reaction_added', messageId: 'm1', reactor: 'user', emoji: '❤️' },
    });
    await done;

    expect(got).toEqual([
      { type: 'message', message: row('m1') },
      { type: 'reaction_added', messageId: 'm1', reactor: 'user', emoji: '❤️' },
    ]);
  });

  it('ends quietly when aborted before connect', async () => {
    const controller = new AbortController();
    controller.abort();
    const got: CompanionStreamEvent[] = [];
    for await (const event of subscribeCompanionEvents('c1', controller.signal)) {
      got.push(event);
    }
    expect(got).toEqual([]);
  });

  it('ends quietly when the socket drops mid-stream', async () => {
    const controller = new AbortController();
    const got: CompanionStreamEvent[] = [];
    const done = (async () => {
      for await (const event of subscribeCompanionEvents('c1', controller.signal)) {
        got.push(event);
      }
    })();
    const socket = await liveSocket();
    socket.serverSend({ event: 'companion', data: { type: 'message', message: row('m1') } });
    await tick();
    socket.close(1006); // connection dropped
    await done;
    expect(got).toHaveLength(1);
  });
});

describe('superseded handoff', () => {
  it('fires the moved listener and stops reconnecting until reclaim', async () => {
    let moved = 0;
    const off = onEmbodimentMoved(() => {
      moved += 1;
    });

    // Establish a socket, then have the server supersede it (and close 4002).
    const promise = fetchMessages('c1');
    const socket = await liveSocket();
    socket.serverSend({ id: lastRequest(socket).id, result: { messages: [] } });
    await promise;

    socket.serverSend({ event: 'embodiment.superseded', data: { companionId: 'c1' } });
    socket.close(4002);
    expect(moved).toBe(1);

    // A call while yielded fails fast (no reconnect, no claim war).
    const opened = FakeWebSocket.instances.length;
    await expect(fetchBudget('c1')).rejects.toThrow(/another window/);
    expect(FakeWebSocket.instances.length).toBe(opened);

    // Reclaiming clears the yield: the next call reconnects and force-claims.
    reclaimEmbodiment();
    const next = fetchBudget('c1');
    const reconnected = await liveSocket();
    expect(FakeWebSocket.instances.length).toBe(opened + 1);
    reconnected.serverSend({
      id: lastRequest(reconnected).id,
      result: { stamina: {}, energy: {} },
    });
    await next;
    off();
  });
});

describe('file upload (presigned two-step flow)', () => {
  it('requests a slot, PUTs to the presigned S3 URL (no auth), then enqueues', async () => {
    const intake = { source: { id: 's1' }, job: { id: 'j1' }, messages: [] };
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const file = new File(['hello'], 'note.txt', { type: 'text/plain' });
    const promise = uploadFileSource('c1', file);

    // Step 1: the slot request over the companion-scoped WS.
    const socket = await liveSocket();
    expect(socket.url).toContain('companion=c1');
    const slotReq = lastRequest(socket);
    expect(slotReq.method).toBe('sources.requestFileUpload');
    expect(slotReq.params).toEqual({ filename: 'note.txt', byteSize: file.size });
    const slot = {
      uploadId: 'tmp-uploads/u1/abc__txt',
      url: 'https://bucket.s3.amazonaws.com/tmp-uploads/u1/abc__txt?sig=x',
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      expiresAt: '2030-01-01T00:00:00.000Z',
    };
    socket.serverSend({ id: slotReq.id, result: slot });

    // Step 2: the direct PUT to the presigned URL — no Authorization header (it
    // would break the S3 signature).
    await tick();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [putUrl, putInit] = fetchMock.mock.calls[0]!;
    expect(putUrl).toBe(slot.url);
    expect(putInit?.method).toBe('PUT');
    expect((putInit?.headers as Record<string, string>)['content-type']).toBe('text/plain');
    expect((putInit?.headers as Record<string, string>).authorization).toBeUndefined();

    // Step 3: enqueue the source referencing the staged bytes.
    const fileReq = lastRequest(socket);
    expect(fileReq.method).toBe('sources.file');
    expect(fileReq.params).toEqual({ uploadId: slot.uploadId, filename: 'note.txt' });
    socket.serverSend({ id: fileReq.id, result: intake });

    expect(await promise).toEqual(intake);
  });

  it('sends the bearer when the slot is the same-origin local filesystem route', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const file = new File(['hi'], 'a.txt', { type: 'text/plain' });
    const promise = uploadFileSource('c1', file);
    const socket = await liveSocket();
    socket.serverSend({
      id: lastRequest(socket).id,
      result: {
        uploadId: 'tmp-uploads/u1/abc__txt',
        url: 'http://localhost:3000/uploads/local/tmp-uploads%2Fu1%2Fabc__txt',
        method: 'PUT',
        headers: { 'content-type': 'text/plain' },
        expiresAt: '2030-01-01T00:00:00.000Z',
      },
    });

    await tick();
    const [, putInit] = fetchMock.mock.calls[0]!;
    expect((putInit?.headers as Record<string, string>).authorization).toBe('Bearer tok');

    socket.serverSend({
      id: lastRequest(socket).id,
      result: { source: { id: 's1' }, job: { id: 'j1' }, messages: [] },
    });
    await promise;
  });
});
