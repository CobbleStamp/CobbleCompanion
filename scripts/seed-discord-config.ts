/**
 * TEMP local-dev helper — stands in for the unbuilt web settings panel (T13).
 * Encrypts a Discord bot token and writes a `discord_config` row for a user,
 * issuing a fresh single-use `/link` code (printed once).
 *
 * Usage (from repo root):
 *   DATABASE_URL=postgres://... DISCORD_TOKEN_KEY=<base64-32-bytes> \
 *     pnpm exec tsx scripts/seed-discord-config.ts <userId> <companionId> <botToken>
 */
import { randomBytes } from 'node:crypto';
import {
  createPgDatabase,
  DrizzleDiscordConfigStore,
  encryptSecret,
  keyFromBase64,
} from '@cobble/db';

const [, , userId, companionId, botToken] = process.argv;
if (!userId || !companionId || !botToken) {
  console.error('usage: tsx scripts/seed-discord-config.ts <userId> <companionId> <botToken>');
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
const tokenKeyB64 = process.env.DISCORD_TOKEN_KEY;
if (!databaseUrl || !tokenKeyB64) {
  console.error('DATABASE_URL and DISCORD_TOKEN_KEY must be set');
  process.exit(1);
}

// 8-char, no-look-alike alphabet (matches the API mint behaviour).
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const linkCode = Array.from(randomBytes(8))
  .map((b) => ALPHABET[b % ALPHABET.length])
  .join('');

const { db, pool } = createPgDatabase(databaseUrl);
const store = new DrizzleDiscordConfigStore(db);
const encryptedBotToken = encryptSecret(botToken, keyFromBase64(tokenKeyB64));

await store.upsert({
  userId,
  encryptedBotToken,
  boundCompanionId: companionId,
  linkCode,
  linkCodeIssuedAt: new Date(),
});
await pool.end();

console.log(`\n✓ discord_config seeded for user ${userId}`);
console.log(`  bound companion: ${companionId}`);
console.log(`\n  In your bot DM, run:  /link ${linkCode}`);
console.log(`  (valid ~15 min, single-use)\n`);
