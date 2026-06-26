/**
 * The real {@link CompanionConnection} factory: wires the bridge's connection seam to
 * the WS transport (T1) and the token source (the mint endpoint, T2b). Each connection
 * mints a short-lived real-user access token, opens `/ws?access_token=…&companion=…`,
 * and claims embodiment; `embodiment.superseded` is surfaced to the bridge.
 *
 * This is thin glue over already-tested parts (the transport's envelope/lifecycle
 * logic is covered by `ws-client.test.ts`); `connection.test.ts` covers the wiring
 * (token → URL → claim → supersede).
 */

import type { ChatStreamEvent } from '@cobble/shared';
import type { CompanionConnection, CompanionConnectionFactory } from './bridge.js';
import type { Logger } from './gateway/types.js';
import { WsTransport, type WsSocketFactory } from './ws-client.js';

export interface CompanionConnectionDeps {
  /** Base `/ws` origin, e.g. `wss://home.cobble.example` (no trailing `/ws`). */
  readonly wsBaseUrl: string;
  /** Mint a short-lived access token for the user (the T2b endpoint client). */
  readonly acquireToken: (userId: string) => Promise<string>;
  /** Socket factory override (tests inject a fake); defaults to the real `ws`. */
  readonly socketFactory?: WsSocketFactory;
  readonly logger: Logger;
}

export function createCompanionConnectionFactory(
  deps: CompanionConnectionDeps,
): CompanionConnectionFactory {
  return ({ userId, companionId }): CompanionConnection => {
    const transport = deps.socketFactory ? new WsTransport(deps.socketFactory) : new WsTransport();
    let supersededHandler: () => void = () => {};
    transport.onEvent((event) => {
      if (event === 'embodiment.superseded') supersededHandler();
    });
    return {
      async connect(): Promise<void> {
        const token = await deps.acquireToken(userId);
        const base = deps.wsBaseUrl.replace(/\/+$/, '');
        const url =
          `${base}/ws?access_token=${encodeURIComponent(token)}` +
          `&companion=${encodeURIComponent(companionId)}`;
        await transport.connect({ url, headers: {}, embodying: true });
      },
      onSuperseded(handler: () => void): void {
        supersededHandler = handler;
      },
      async *chat(content: string): AsyncIterable<ChatStreamEvent> {
        for await (const chunk of transport.callStream('messages.send', { content })) {
          yield chunk as ChatStreamEvent;
        }
      },
      async *callStream(method: string, params?: unknown): AsyncIterable<ChatStreamEvent> {
        for await (const chunk of transport.callStream(method, params)) {
          yield chunk as ChatStreamEvent;
        }
      },
      call<T>(method: string, params?: unknown): Promise<T> {
        return transport.call<T>(method, params);
      },
      close(): void {
        transport.close();
      },
    };
  };
}
