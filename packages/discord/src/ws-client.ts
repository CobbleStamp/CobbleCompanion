/**
 * The Discord adapter's binding to the shared `/ws` transport (`@cobble/shared`,
 * docs/companion-endpoints.md). The envelope/lifecycle logic now lives in
 * {@link WsTransport} there — shared with the API test client — so this module is just
 * the adapter's Node socket factory plus a re-export of the transport surface its
 * consumers (`connection.ts`, `turn-render.ts`, …) import from here.
 *
 * Each per-user bridge owns exactly one connection (one companion, one room): no
 * singleton, no reconnect-on-tab, no companion-switching — a bridge that needs a
 * different companion opens a fresh transport. It is auth-agnostic: `connect` takes the
 * fully-formed `/ws` URL plus handshake `headers`; how those are produced is the
 * caller's concern (docs/plans/discord-surface.md §11).
 */

import { WebSocket as NodeWebSocket } from 'ws';
import type { WsSocket, WsSocketFactory } from '@cobble/shared';

export {
  WsTransport,
  StreamQueue,
  SupersededError,
  ConnectionClosedError,
  WsCallError,
  type WsSocket,
  type WsSocketFactory,
  type WsTransportOptions,
  type WsTransportLogger,
  type ConnectOptions,
  type CloseInfo,
  type EventListener,
  type CloseListener,
} from '@cobble/shared';

/** The production factory: a real `ws` socket, normalising inbound frames to string. */
export const defaultSocketFactory: WsSocketFactory = (url, headers) => {
  const socket = new NodeWebSocket(url, { headers });
  const adapter: WsSocket = {
    get readyState(): number {
      return socket.readyState;
    },
    send: (data) => socket.send(data),
    close: (code) => socket.close(code),
    on(event, listener): void {
      if (event === 'message') {
        socket.on('message', (data) =>
          (listener as (data: string) => void)(
            typeof data === 'string' ? data : data.toString('utf8'),
          ),
        );
      } else if (event === 'close') {
        socket.on('close', (code) => (listener as (code: number) => void)(code));
      } else if (event === 'error') {
        socket.on('error', (error) => (listener as (error: Error) => void)(error));
      } else {
        socket.on('open', listener as () => void);
      }
    },
  };
  return adapter;
};
