import type { AppDeps } from '../app.js';
import type { WsMethods } from './dispatch.js';
import { requireEmbodiment } from './fencing.js';
import { activityMethods } from './methods/activity.js';
import { companionMethods } from './methods/companions.js';
import { episodeMethods } from './methods/episodes.js';
import { inventoryMethods } from './methods/inventory.js';
import { memoryMethods } from './methods/memory.js';
import { messageMethods } from './methods/messages.js';
import { presenceMethods } from './methods/presence.js';
import { proposalMethods } from './methods/proposals.js';
import { reactionMethods } from './methods/reactions.js';
import { sourceMethods } from './methods/sources.js';
import { streamingMethods } from './methods/streaming.js';
import { userModelMethods } from './methods/usermodel.js';
import { vitalityMethods } from './methods/vitality.js';

/**
 * The WS method table (deliver-scalability.md §5.2, Phase D). Transport seeds
 * (`ping`, `auth.me`, `embodiment.whoami`) plus the per-domain method modules. These
 * superseded the former HTTP routes (D3); the web client is fully on the WS and the
 * dead HTTP routes have been removed — only `/auth/config`, the multipart file
 * upload, `/health`, the admin-only `/admin/queue`, and the SPA serve remain HTTP.
 */
export function buildWsMethods(deps: AppDeps): WsMethods {
  return {
    ping: async (_ctx, params) => ({ pong: true, echo: params ?? null }),
    'auth.me': async (ctx) => {
      // Mirrors GET /auth/me: the handshake already authenticated this connection,
      // so the user resolves (email may be null for a service consumer).
      const user = await deps.identity.getUserById(ctx.userId);
      return { user: { id: ctx.userId, email: user?.email ?? null } };
    },
    'embodiment.whoami': async (ctx) => {
      const binding = await requireEmbodiment(deps.embodiment, ctx);
      return { companionId: binding.companionId, generation: binding.generation };
    },
    ...companionMethods(deps),
    ...messageMethods(deps),
    ...reactionMethods(deps),
    ...memoryMethods(deps),
    ...presenceMethods(deps),
    ...episodeMethods(deps),
    ...sourceMethods(deps),
    ...userModelMethods(deps),
    ...proposalMethods(deps),
    ...inventoryMethods(deps),
    ...activityMethods(deps),
    ...vitalityMethods(deps),
    ...streamingMethods(deps),
  };
}
