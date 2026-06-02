import { authTokens, type Database } from '@cobble/db';
import { and, eq, gt, isNull } from 'drizzle-orm';

/**
 * Storage for single-use magic-link tokens. Tokens are email-scoped (a user need
 * not exist yet) and consumed atomically on verification.
 */
export interface AuthTokenStore {
  createToken(email: string, token: string, expiresAt: Date): Promise<void>;
  /** Atomically consume an unexpired, unconsumed token; returns its email or null. */
  consumeToken(token: string, now: Date): Promise<string | null>;
}

export class DrizzleAuthTokenStore implements AuthTokenStore {
  constructor(private readonly db: Database) {}

  async createToken(email: string, token: string, expiresAt: Date): Promise<void> {
    await this.db.insert(authTokens).values({ email, token, expiresAt });
  }

  async consumeToken(token: string, now: Date): Promise<string | null> {
    const [row] = await this.db
      .update(authTokens)
      .set({ consumedAt: now })
      .where(
        and(
          eq(authTokens.token, token),
          isNull(authTokens.consumedAt),
          gt(authTokens.expiresAt, now),
        ),
      )
      .returning({ email: authTokens.email });
    return row?.email ?? null;
  }
}
