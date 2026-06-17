import type { AppDeps } from '../app.js';
import type { WsMethods } from './dispatch.js';
import { requireEmbodiment } from './fencing.js';

/**
 * The WS method table (deliver-scalability.md §5.2, Phase D). D1 seeds the
 * transport with `ping` (liveness/echo) and `auth.me` (handshake identity); D2 adds
 * `embodiment.whoami`, fenced on the live claim (proving claim + fencing). D3 moves
 * the HTTP routes here as methods. The HTTP routes remain mounted in parallel until
 * then, so this is additive and single-node-safe.
 */
export function buildWsMethods(deps: AppDeps): WsMethods {
  return {
    ping: async (_ctx, params) => ({ pong: true, echo: params ?? null }),
    'auth.me': async (ctx) => ({ user: { id: ctx.userId } }),
    'embodiment.whoami': async (ctx) => {
      const binding = await requireEmbodiment(deps.embodiment, ctx);
      return { companionId: binding.companionId, generation: binding.generation };
    },
  };
}
