import websocketPlugin, { type WebSocket } from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import { WsConnection } from './connection.js';
import { dispatchMessage, type WsMethods } from './dispatch.js';
import { makeWsAuth } from './handshake.js';

/**
 * Mount the realtime WebSocket endpoint (deliver-scalability.md §5.2, Phase D). The
 * upgrade is authenticated once at the handshake (preValidation), then every inbound
 * frame is dispatched as a request envelope. Frames are handled concurrently (fired
 * without awaiting), so many requests multiplex over the one socket. Mounted
 * alongside the HTTP routes — additive until D3 moves the API onto it.
 */
export async function registerWebSocket(
  app: FastifyInstance,
  deps: AppDeps,
  methods: WsMethods,
): Promise<void> {
  await app.register(websocketPlugin);
  const wsAuth = makeWsAuth(deps);

  app.get('/ws', { websocket: true, preValidation: wsAuth }, (socket: WebSocket, request) => {
    const userId = request.userId;
    if (!userId) {
      // preValidation guarantees a userId; this is a belt-and-suspenders guard.
      socket.close(4001, 'unauthenticated');
      return;
    }
    const connection = new WsConnection(socket, userId, deps.logger);
    socket.on('message', (data: Buffer) => {
      void dispatchMessage(methods, connection, data.toString(), deps.logger);
    });
    socket.on('error', (error: Error) => {
      deps.logger.error('ws socket error', { operation: 'ws.socket', userId, error });
    });
  });
}
