/**
 * A WebSocket test client for the API suite (Phase D final cleanup). Route tests
 * and the phase-DoD acceptance tests drive the product over the realtime WS — the
 * one surface — instead of HTTP `inject`. Mirrors the web transport
 * (`packages/web/src/api/ws.ts`): a request is correlated to its reply by id, a
 * streaming method's chunks arrive as stream frames until the terminal result, and
 * server-pushed events fan out to a listener.
 *
 * Backed by Node's global `WebSocket` against a real listener (the embodiment claim
 * + heartbeat need a live socket), so a test using this calls {@link openWs}, which
 * lazily starts the app listening.
 */

import type { AddressInfo } from 'node:net';
import type { WsServerMessage } from '@cobble/shared';
import type { TestApp } from './helpers.js';

/** A method call failed: the server's error reply, surfaced as a thrown Error whose
 *  `.code` carries the WS error code (the analogue of an HTTP status). */
export class WsCallError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
  ) {
    super(message);
    this.name = 'WsCallError';
  }
}

export interface WsTestClient {
  /** Send an RPC and resolve its result (or throw {@link WsCallError}). */
  call<T = unknown>(method: string, params?: unknown): Promise<T>;
  /** Drive a streaming method; resolve the ordered chunks once it ends. */
  stream<T = unknown>(method: string, params?: unknown): Promise<T[]>;
  /** Collect the next `n` server-pushed events (e.g. `companion`), oldest-first. */
  nextEvents(n: number): Promise<Array<{ event: string; data: unknown }>>;
  close(): Promise<void>;
}

/** Ensure the app is listening and return its `host:port`. */
async function ensureListening(ctx: TestApp): Promise<string> {
  const existing = ctx.app.server.address();
  if (existing && typeof existing === 'object') {
    return `127.0.0.1:${existing.port}`;
  }
  await ctx.app.listen({ port: 0, host: '127.0.0.1' });
  return `127.0.0.1:${(ctx.app.server.address() as AddressInfo).port}`;
}

/**
 * Open a WS for `address`'s bearer, embodying `companionId` when given (so
 * companion-scoped methods are authorized + fenced). Resolves once the socket is
 * open and ready to carry frames.
 */
export async function openWs(
  ctx: TestApp,
  address: string,
  companionId?: string,
): Promise<WsTestClient> {
  const host = await ensureListening(ctx);
  const token = ctx.bearerFor(address).authorization.slice('Bearer '.length);
  const query = new URLSearchParams({ access_token: token });
  if (companionId) query.set('companion', companionId);
  const socket = new WebSocket(`ws://${host}/ws?${query.toString()}`);

  let seq = 0;
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const streams = new Map<string, { chunks: unknown[]; resolve: (v: unknown[]) => void }>();
  const eventQueue: Array<{ event: string; data: unknown }> = [];
  let eventWaiter: (() => void) | null = null;

  socket.addEventListener('message', (event: MessageEvent) => {
    const message = JSON.parse(String(event.data)) as WsServerMessage;
    if ('stream' in message) {
      streams.get(message.id)?.chunks.push(message.stream);
      return;
    }
    if ('result' in message) {
      const stream = streams.get(message.id);
      if (stream) {
        streams.delete(message.id);
        stream.resolve(stream.chunks);
      }
      const call = pending.get(message.id);
      if (call) {
        pending.delete(message.id);
        call.resolve(message.result);
      }
      return;
    }
    if ('error' in message) {
      const error = new WsCallError(message.error.message, message.error.code);
      streams.get(message.id) && streams.delete(message.id);
      const call = pending.get(message.id);
      if (call) {
        pending.delete(message.id);
        call.reject(error);
      }
      return;
    }
    eventQueue.push({ event: message.event, data: message.data });
    eventWaiter?.();
  });

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('ws connection failed')), {
      once: true,
    });
  });

  const nextId = (): string => {
    seq += 1;
    return `t${seq}`;
  };

  return {
    call<T = unknown>(method: string, params?: unknown): Promise<T> {
      const id = nextId();
      const result = new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
      socket.send(JSON.stringify({ id, method, params }));
      return result as Promise<T>;
    },
    stream<T = unknown>(method: string, params?: unknown): Promise<T[]> {
      const id = nextId();
      const done = new Promise<unknown[]>((resolve) => {
        streams.set(id, { chunks: [], resolve });
      });
      socket.send(JSON.stringify({ id, method, params }));
      return done as Promise<T[]>;
    },
    async nextEvents(n: number): Promise<Array<{ event: string; data: unknown }>> {
      while (eventQueue.length < n) {
        await new Promise<void>((resolve) => {
          eventWaiter = resolve;
        });
        eventWaiter = null;
      }
      return eventQueue.splice(0, n);
    },
    close(): Promise<void> {
      socket.close();
      return Promise.resolve();
    },
  };
}
