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

import type { ChatStreamEvent, CompanionStreamEvent } from '@cobble/shared';
import type { CompanionConnection, CompanionConnectionFactory } from './bridge.js';
import type { Logger } from './gateway/types.js';
import { WsTransport, type WsSocketFactory } from './ws-client.js';

/** Cap on remembered turn-reply ids (for proactive dedup); oldest are trimmed. */
const PRODUCED_ID_CAP = 500;

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

    // Proactive dedup (companion-discord.md §8, plans/discord-surface.md D5): a turn
    // reply lands BOTH on the request stream (rendered inline) AND on the live
    // `companion` event log. Remember the ids we render inline (`producedIds`) and
    // suppress any companion message that arrives mid-turn (`turnDepth`), so the
    // proactive loop forwards only genuinely autonomous messages.
    const producedIds = new Set<string>();
    let turnDepth = 0;
    const recordProduced = (chunk: ChatStreamEvent): void => {
      if (chunk.type !== 'done') return;
      const id = chunk.message.id;
      if (typeof id !== 'string') return;
      producedIds.add(id);
      if (producedIds.size > PRODUCED_ID_CAP) {
        const oldest = producedIds.values().next().value;
        if (oldest !== undefined) producedIds.delete(oldest);
      }
    };

    async function* recordingStream(
      method: string,
      params?: unknown,
    ): AsyncIterable<ChatStreamEvent> {
      turnDepth += 1;
      try {
        for await (const chunk of transport.callStream(method, params)) {
          const event = chunk as ChatStreamEvent;
          recordProduced(event);
          yield event;
        }
      } finally {
        turnDepth -= 1;
      }
    }

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
      chat(content: string): AsyncIterable<ChatStreamEvent> {
        return recordingStream('messages.send', { content });
      },
      callStream(method: string, params?: unknown): AsyncIterable<ChatStreamEvent> {
        return recordingStream(method, params);
      },
      greeting(): AsyncIterable<ChatStreamEvent> {
        return recordingStream('greeting.stream');
      },
      async *events(signal: AbortSignal): AsyncIterable<CompanionStreamEvent> {
        const queue: CompanionStreamEvent[] = [];
        let waiter: (() => void) | null = null;
        const wake = (): void => {
          const w = waiter;
          waiter = null;
          w?.();
        };
        const unsubscribe = transport.onEvent((name, data) => {
          if (name !== 'companion') return;
          queue.push(data as CompanionStreamEvent);
          wake();
        });
        signal.addEventListener('abort', wake);
        try {
          for (;;) {
            if (signal.aborted) return;
            const event = queue.shift();
            if (event === undefined) {
              await new Promise<void>((resolve) => {
                waiter = resolve;
              });
              continue;
            }
            // Dedup: drop a reply we rendered inline, or any message mid-turn.
            if (event.type === 'message') {
              if (turnDepth > 0 || producedIds.has(event.message.id)) continue;
            }
            yield event;
          }
        } finally {
          unsubscribe();
          signal.removeEventListener('abort', wake);
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
