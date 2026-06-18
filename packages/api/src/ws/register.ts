import websocketPlugin, { type WebSocket } from '@fastify/websocket';
import { hostname } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { monotonicFactory } from 'ulid';
import type { AppDeps } from '../app.js';
import { SUPERSEDED_CLOSE, WsConnection } from './connection.js';
import { dispatchMessage, type WsMethods } from './dispatch.js';
import { makeWsAuth } from './handshake.js';

/** Max events delivered per heartbeat tick (bounds a catch-up burst). */
const EVENT_BATCH = 200;

/**
 * Monotonic ULID owner tokens: within this process every token is strictly greater
 * than the last, so a later connection always force-claims over an earlier one even
 * within the same millisecond (the "newer wins" handoff rule). Across nodes a
 * same-ms tie is broken by the DB-stamped `generation` if strictness is ever needed
 * (deliver-scalability.md §5.2).
 */
const nextOwner = monotonicFactory();

/**
 * Mount the realtime WebSocket endpoint (deliver-scalability.md §5.2, Phase D). The
 * upgrade is authenticated once at the handshake (preValidation), which also
 * ownership-checks any named companion. A connection that names a companion
 * **claims** it (D2): a fresh ULID force-claims, a heartbeat renews the claim while
 * the socket is open, and if a newer connection takes over, this one self-fences
 * (pushes `embodiment.superseded` and closes). Frames are dispatched concurrently,
 * so requests multiplex over the one socket. Mounted alongside the HTTP routes.
 */
export async function registerWebSocket(
  app: FastifyInstance,
  deps: AppDeps,
  methods: WsMethods,
): Promise<void> {
  // Cap inbound frame size at the transport: an oversized frame is rejected by `ws`
  // (close 1009) before we ever `JSON.parse` it, bounding event-loop stall (S3).
  await app.register(websocketPlugin, {
    options: { maxPayload: deps.config.wsMaxPayloadBytes },
  });
  const wsAuth = makeWsAuth(deps);
  const node = `${hostname()}-${process.pid}`;

  app.get('/ws', { websocket: true, preValidation: wsAuth }, (socket: WebSocket, request) => {
    const userId = request.userId;
    if (!userId) {
      socket.close(4001, 'unauthenticated'); // preValidation guarantees a userId; defensive.
      return;
    }
    const connection = new WsConnection(socket, userId, deps.logger, deps.config.wsMaxInFlight);

    // Dispatch frames immediately (don't await the claim below) so none are lost;
    // methods that mutate fence on the DB claim, so they're correct regardless of
    // the claim/first-frame ordering. Frames multiplex, so each spawns a concurrent
    // handler — bound that concurrency per connection (S3): past the cap a frame is
    // shed with a `rate_limited` reply, so one authed client can't fan out unbounded
    // work and exhaust CPU / the DB pool.
    socket.on('message', (data: Buffer) => {
      if (!connection.beginRequest()) {
        connection.fail('', 'too many concurrent requests; retry shortly', 'rate_limited');
        return;
      }
      void dispatchMessage(methods, connection, data.toString(), deps.logger).finally(() => {
        connection.endRequest();
      });
    });
    socket.on('error', (error: Error) => {
      deps.logger.error('ws socket error', { operation: 'ws.socket', userId, error });
    });

    const companionId = request.companionId;
    if (companionId) {
      void embody(deps, connection, socket, companionId, node);
    }
  });
}

/** Claim the companion for this connection and keep the claim alive while the socket
 *  is open; self-fence + close if superseded. */
async function embody(
  deps: AppDeps,
  connection: WsConnection,
  socket: WebSocket,
  companionId: string,
  node: string,
): Promise<void> {
  const owner = nextOwner();
  const ttlMs = deps.config.wsClaimTtlMs;
  let claim;
  try {
    claim = await deps.embodiment.claim({ companionId, owner, node, ttlMs });
  } catch (error) {
    deps.logger.error('ws embodiment claim failed', { operation: 'ws.embody', companionId, error });
    socket.close(1011, 'claim failed');
    return;
  }
  if (!claim) {
    // A newer connection beat us to it (rare race). Yield the room immediately.
    connection.pushEvent('embodiment.superseded', { companionId });
    connection.close(SUPERSEDED_CLOSE, 'superseded');
    return;
  }
  connection.bindEmbodiment({ companionId, owner, generation: claim.generation });

  // Deliver only events that arrive AFTER connect; the client loads the transcript
  // snapshot (messages.list) for everything before, merging by id (D4). The initial
  // cursor is the settled horizon (not the raw max seq) so an event still in-flight
  // at connect isn't stranded between the snapshot and live delivery — see the
  // visibility-gap guard in core/src/events/log.ts (deliver-scalability.md §C).
  //
  // Fail closed on a DB error here (mirror the claim path above): a legitimate empty
  // log returns 0, but a *failed* query must NOT fall back to 0 — that would make the
  // first heartbeat read from seq 0 and re-deliver the companion's entire settled
  // history as live events. Closing lets the client reconnect and re-init the cursor
  // cleanly (its reconnect already reloads the snapshot), with no replay.
  let cursor: number;
  try {
    cursor = await deps.eventLog.latestSettledSeq(companionId);
  } catch (error) {
    deps.logger.error('ws live-cursor init failed', {
      operation: 'ws.embody',
      companionId,
      error,
    });
    socket.close(1011, 'cursor init failed');
    return;
  }

  const heartbeat = setInterval(() => {
    void (async () => {
      let held: boolean;
      try {
        held = await deps.embodiment.renew(companionId, owner);
      } catch (error) {
        deps.logger.error('ws heartbeat renew failed', {
          operation: 'ws.embody',
          companionId,
          error,
        });
        return; // transient; try again next tick rather than dropping the room
      }
      if (!held) {
        // A newer connection took the room. Self-fence.
        clearInterval(heartbeat);
        connection.pushEvent('embodiment.superseded', { companionId });
        connection.close(SUPERSEDED_CLOSE, 'superseded');
        return;
      }
      // Cross-node live delivery: push events written on any node since our cursor.
      try {
        const events = await deps.eventLog.readSince(companionId, cursor, EVENT_BATCH);
        for (const { seq, event } of events) {
          connection.pushEvent('companion', event);
          cursor = seq;
        }
      } catch (error) {
        deps.logger.error('ws event delivery failed', {
          operation: 'ws.embody',
          companionId,
          error,
        });
      }
    })();
  }, deps.config.wsHeartbeatMs);
  heartbeat.unref?.();

  socket.on('close', () => {
    clearInterval(heartbeat);
    void deps.embodiment.release(companionId, owner).catch((error: unknown) => {
      deps.logger.error('ws embodiment release failed', {
        operation: 'ws.embody',
        companionId,
        error,
      });
    });
  });
}
