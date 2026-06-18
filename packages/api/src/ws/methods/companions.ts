import { createCompanionSchema } from '@cobble/shared';
import type { AppDeps } from '../../app.js';
import type { WsMethods } from '../dispatch.js';
import { parseParams } from './helpers.js';

/** Companion CRUD (mirrors companion.routes) — per-user, not companion-scoped. */
export function companionMethods(deps: AppDeps): WsMethods {
  const { identity } = deps;
  return {
    'companions.list': async (ctx) => ({ companions: await identity.listCompanions(ctx.userId) }),
    'companions.create': async (ctx, params) => {
      const data = parseParams(createCompanionSchema, params, 'invalid companion details');
      return { companion: await identity.createCompanion(ctx.userId, data) };
    },
  };
}
