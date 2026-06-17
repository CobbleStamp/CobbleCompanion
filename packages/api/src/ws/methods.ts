import type { AppDeps } from '../app.js';
import type { WsMethods } from './dispatch.js';

/**
 * The WS method table (deliver-scalability.md §5.2, Phase D). D1 seeds the
 * transport with `ping` (liveness/echo) and `auth.me` (proves the handshake-derived
 * identity) so the request/response loop is exercised end-to-end; D3 moves the HTTP
 * routes here as methods. The HTTP routes remain mounted in parallel until then, so
 * this is additive and single-node-safe.
 */
export function buildWsMethods(_deps: AppDeps): WsMethods {
  return {
    ping: async (_ctx, params) => ({ pong: true, echo: params ?? null }),
    'auth.me': async (ctx) => ({ user: { id: ctx.userId } }),
  };
}
