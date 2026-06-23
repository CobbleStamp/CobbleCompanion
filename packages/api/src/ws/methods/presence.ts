import { z } from 'zod';
import type { AppDeps } from '../../app.js';
import type { WsMethods } from '../dispatch.js';
import { requireEmbodiment } from '../fencing.js';
import { parseParams } from './helpers.js';

const heartbeatParams = z.object({ tabVisible: z.boolean() });

/**
 * Presence heartbeat (mirrors the HTTP heartbeat route). D5 derives presence from
 * the embodiment claim — the standing WS connection *is* "here" — so this records
 * only the foreground/background bit the motivation engine reads
 * (companion-motivation.md §4). Deliberately NOT a motivation trigger: the triggers
 * are a sent turn, an opened transcript, and the periodic sweep, never the presence
 * cadence (which would be a nudge storm).
 */
export function presenceMethods(deps: AppDeps): WsMethods {
  const { presence, embodiment } = deps;
  return {
    'presence.heartbeat': async (ctx, params) => {
      const { tabVisible } = parseParams(
        heartbeatParams,
        params,
        'tabVisible (boolean) is required',
      );
      const binding = await requireEmbodiment(embodiment, ctx);
      presence.recordHeartbeat(binding.companionId, {
        tabVisible,
        fence: { connectionId: binding.connectionId, claimSeq: binding.claimSeq },
      });
      return { ok: true };
    },
  };
}
