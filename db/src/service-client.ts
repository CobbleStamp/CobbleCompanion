import { randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { createPgDatabase, type Database } from './client.js';
import { serviceRegistry } from './schema.js';

/**
 * Admin CLI + command functions for server-to-server consumer credentials
 * (`service_registry`, implementation.md §5). Run via
 * `pnpm --filter @cobble/db service <subcommand>`.
 *
 *   service add <client_id> [label]   generate a secret, store it, print it ONCE
 *   service list [client_id]          list credentials (never prints secrets)
 *   service revoke <credential_id>    soft-revoke a credential by its row id
 *
 * The DB-touching command functions are exported and unit-tested; `main` is the thin
 * arg-parsing + console-IO entrypoint. Secrets are stored as `plaintext` today
 * (secret_type); the schema leaves room for a future digest scheme without a code
 * change at the auth call sites.
 */

/** Metadata view of a credential row — by construction it carries no secret. */
export interface CredentialSummary {
  readonly id: string;
  readonly clientId: string;
  readonly secretType: string;
  readonly label: string | null;
  readonly createdAt: string;
  readonly revokedAt: string | null;
}

/**
 * Generate a fresh high-entropy secret for `clientId`, store it as `plaintext`, and
 * return its row id plus the raw secret (shown to the operator ONCE — never persisted
 * anywhere it can be read back). 32 random bytes, URL-safe.
 */
export async function addCredential(
  db: Database,
  clientId: string,
  label?: string,
): Promise<{ id: string; secret: string }> {
  const secret = randomBytes(32).toString('base64url');
  const [row] = await db
    .insert(serviceRegistry)
    .values({
      clientId,
      secret,
      secretType: 'plaintext',
      ...(label ? { label } : {}),
    })
    .returning();
  if (!row) {
    throw new Error('failed to create service credential');
  }
  return { id: row.id, secret };
}

/** List credential metadata (all clients, or one), never the secret itself. */
export async function listCredentials(
  db: Database,
  clientId?: string,
): Promise<CredentialSummary[]> {
  const rows = await (clientId
    ? db.select().from(serviceRegistry).where(eq(serviceRegistry.clientId, clientId))
    : db.select().from(serviceRegistry));
  return rows.map((r) => ({
    id: r.id,
    clientId: r.clientId,
    secretType: r.secretType,
    label: r.label,
    createdAt: r.createdAt.toISOString(),
    revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null,
  }));
}

/**
 * Soft-revoke an active credential by row id. Returns true when a still-active row was
 * revoked, false when no active credential has that id (already revoked or unknown).
 */
export async function revokeCredential(db: Database, credentialId: string): Promise<boolean> {
  const revoked = await db
    .update(serviceRegistry)
    .set({ revokedAt: new Date() })
    .where(and(eq(serviceRegistry.id, credentialId), isNull(serviceRegistry.revokedAt)))
    .returning();
  return revoked.length > 0;
}

async function main(): Promise<void> {
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) {
    throw new Error('DATABASE_URL is required to manage service credentials');
  }
  const [subcommand, arg1, arg2] = process.argv.slice(2);
  const { db, pool } = createPgDatabase(connectionString);
  try {
    switch (subcommand) {
      case 'add': {
        if (!arg1) {
          throw new Error('usage: service add <client_id> [label]');
        }
        const { id, secret } = await addCredential(db, arg1, arg2);
        // eslint-disable-next-line no-console
        console.log(
          `created credential ${id} for client "${arg1}".\n` +
            `SECRET (shown once — store it now): ${secret}`,
        );
        break;
      }
      case 'list': {
        // Never print the secret — only metadata.
        // eslint-disable-next-line no-console
        console.table(await listCredentials(db, arg1));
        break;
      }
      case 'revoke': {
        if (!arg1) {
          throw new Error('usage: service revoke <credential_id>');
        }
        const wasRevoked = await revokeCredential(db, arg1);
        // eslint-disable-next-line no-console
        console.log(
          wasRevoked ? `revoked credential ${arg1}` : `no active credential with id ${arg1}`,
        );
        break;
      }
      default:
        throw new Error('usage: service <add|list|revoke> [...args]');
    }
  } finally {
    await pool.end();
  }
}

// Run as a CLI only when invoked directly (not when imported by tests).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error('service-client command failed', error);
    process.exitCode = 1;
  });
}
