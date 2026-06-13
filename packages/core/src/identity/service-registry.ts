import { createHash, timingSafeEqual } from 'node:crypto';
import { serviceRegistry, type Database } from '@cobble/db';
import { and, eq, isNull } from 'drizzle-orm';

/**
 * Validates server-to-server consumer credentials against the `service_registry`
 * table (implementation.md §5). A consumer (`client_id`) may hold several active
 * secrets at once for overlap rotation; any non-revoked one authenticates.
 */
export interface ServiceRegistry {
  /** True when `presentedSecret` is an active (non-revoked) credential for `clientId`. */
  authenticate(clientId: string, presentedSecret: string): Promise<boolean>;
}

/** Constant-time string compare that does not leak length (see jwt-verifier.ts). */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/**
 * Compare a presented secret to a stored credential per its `secret_type`. Starts at
 * `plaintext`; `sha256` is wired so a future migration to hashed secrets needs no code
 * change at the call sites. An unknown scheme fails closed.
 */
function secretMatches(secretType: string, stored: string, presented: string): boolean {
  switch (secretType) {
    case 'plaintext':
      return timingSafeEqualStr(presented, stored);
    case 'sha256':
      return timingSafeEqualStr(createHash('sha256').update(presented).digest('hex'), stored);
    default:
      return false;
  }
}

export class DrizzleServiceRegistry implements ServiceRegistry {
  constructor(private readonly db: Database) {}

  async authenticate(clientId: string, presentedSecret: string): Promise<boolean> {
    const rows = await this.db
      .select()
      .from(serviceRegistry)
      .where(and(eq(serviceRegistry.clientId, clientId), isNull(serviceRegistry.revokedAt)));
    // Evaluate every candidate (no early return) so a match's position isn't timing-
    // observable; secrets are high-entropy so this is defense-in-depth, not required.
    let ok = false;
    for (const row of rows) {
      if (secretMatches(row.secretType, row.secret, presentedSecret)) {
        ok = true;
      }
    }
    return ok;
  }
}
