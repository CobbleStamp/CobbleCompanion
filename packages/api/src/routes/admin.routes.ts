import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import type { RequireAuth } from '../auth-guard.js';

/**
 * Admin-only operability surface (deliver-scalability.md §C "C2"). A read-only
 * window into the durable background machinery — queue depth/age, failures, and
 * live job/embodiment claims — for an operator to watch as the fleet runs. Gated
 * behind auth **and** the `is_admin` flag; an ordinary signed-in user gets 403.
 *
 * This is the one non-public HTTP route besides the file upload: it stays HTTP
 * (not a WS method) precisely because ops tooling — `curl`, a monitor, a
 * dashboard scraper — speaks HTTP, not the product's WebSocket envelope.
 */
export function registerAdminRoutes(
  app: FastifyInstance,
  deps: AppDeps,
  requireAuth: RequireAuth,
  requireAdmin: RequireAuth,
): void {
  app.get('/admin/queue', { preHandler: [requireAuth, requireAdmin] }, async () => {
    return deps.queueMetrics.snapshot();
  });
}
