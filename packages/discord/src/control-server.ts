/**
 * The internal reconcile endpoint (companion-discord.md §2.1): the steady-state path
 * by which the API tells the adapter a user's `discord_config` changed, replacing the
 * old poll. After a settings save/delete the API POSTs `{ userId }` here; the adapter
 * reconciles **only** that bot ({@link GatewayManager.reconcileUser}).
 *
 * Its sole protection is the network: it is **internal-only** — never host-mapped (no
 * published compose port; a closed security group on the single box). It carries no
 * auth because its blast radius is tiny: a request can only trigger a reconcile (start /
 * stop / restart one bot against the DB the adapter already trusts) — it exposes no
 * secret, injects no token, impersonates no one. Keeping it unauthenticated is the
 * simplest thing that works for an internal-only endpoint (AGENTS.md Iron Law 10).
 *
 * The request handling is factored into a transport-free {@link handleReconcileRequest}
 * (unit-tested without binding a socket); {@link startControlServer} wraps it in a
 * `node:http` server.
 */

import { createServer, type Server } from 'node:http';
import type { Logger } from './gateway/types.js';

/** Reconcile one user's bot (the manager's targeted reconcile). */
export type ReconcileUser = (userId: string) => Promise<void>;

export interface ReconcileHandlerDeps {
  readonly reconcileUser: ReconcileUser;
  readonly logger: Logger;
}

export interface ReconcileHttpRequest {
  readonly method: string | undefined;
  readonly url: string | undefined;
  /** The raw request body (expected JSON `{ userId }`). */
  readonly body: string;
}

/** The route the API POSTs to. */
export const RECONCILE_PATH = '/internal/reconcile';

/**
 * Validate + dispatch a reconcile request. Returns the HTTP status to send. A bad
 * method/path is 404 and a bad body is 400; a `reconcileUser` throw is logged and
 * surfaced as 500 (the API retries — companion-discord.md §2.1).
 */
export async function handleReconcileRequest(
  deps: ReconcileHandlerDeps,
  req: ReconcileHttpRequest,
): Promise<number> {
  if (req.method !== 'POST' || (req.url ?? '').split('?')[0] !== RECONCILE_PATH) {
    return 404;
  }
  let userId: unknown;
  try {
    userId = (JSON.parse(req.body) as { userId?: unknown }).userId;
  } catch {
    return 400;
  }
  if (typeof userId !== 'string' || userId.length === 0) {
    return 400;
  }
  try {
    await deps.reconcileUser(userId);
  } catch (error) {
    deps.logger.error('discord control: reconcile failed', {
      operation: 'discord.control.reconcile',
      userId,
      error,
    });
    return 500;
  }
  return 204;
}

export interface ControlServerDeps extends ReconcileHandlerDeps {
  /** Port to listen on (`DISCORD_SERVICE_PORT`). Kept off the host by deployment (no
   *  published port / a closed security group) — that network posture is its only guard. */
  readonly port: number;
}

export interface ControlServer {
  close(): Promise<void>;
}

/** Start the reconcile HTTP server. Resolves once it is listening. */
export async function startControlServer(deps: ControlServerDeps): Promise<ControlServer> {
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      void handleReconcileRequest(deps, {
        method: req.method,
        url: req.url,
        body: Buffer.concat(chunks).toString('utf8'),
      })
        .then((status) => {
          res.statusCode = status;
          res.end();
        })
        .catch((error: unknown) => {
          // handleReconcileRequest never throws, but guard the fire-and-forget path.
          deps.logger.error('discord control: request handling threw', {
            operation: 'discord.control.request',
            error,
          });
          res.statusCode = 500;
          res.end();
        });
    });
    req.on('error', (error) => {
      deps.logger.error('discord control: request stream error', {
        operation: 'discord.control.request',
        error,
      });
      res.statusCode = 400;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(deps.port, resolve));
  deps.logger.info('discord control server listening', {
    operation: 'discord.control.start',
    port: deps.port,
  });
  return {
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
