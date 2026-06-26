/**
 * At-rest encryption for the Discord **bot token** (secret #1 — the credential the
 * bot presents to Discord). The adapter stores it in `discord_config`
 * (`docs/companion-discord.md` §9), and per the security rules a secret is never
 * persisted in plaintext.
 *
 * AES-256-GCM via `node:crypto`: authenticated encryption, so a tampered or
 * wrong-key payload fails closed rather than returning garbage. The 256-bit key is
 * supplied by the worker from its environment / KMS (see {@link keyFromBase64}); this
 * module is key-source-agnostic and pure, so it is fully unit-testable without env.
 *
 * Payload format (one opaque string, safe to store in a text column):
 *   `v1.<base64url(iv)>.<base64url(authTag)>.<base64url(ciphertext)>`
 * The `v1` prefix lets the algorithm change later without ambiguity.
 */

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';
/** GCM's standard nonce length; 96 bits is the recommended IV size for AES-GCM. */
const IV_BYTES = 12;
/** AES-256 key length. */
export const KEY_BYTES = 32;
/** GCM authentication tag length. */
const TAG_BYTES = 16;

/**
 * Decode a base64-encoded 256-bit key (how the worker passes `DISCORD_TOKEN_KEY`).
 * Throws on a wrong-length key — a misconfiguration the operator must fix at boot,
 * not a runtime-recoverable condition.
 */
export function keyFromBase64(encoded: string): Buffer {
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(`DISCORD_TOKEN_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}`);
  }
  return key;
}

/**
 * Encrypt a secret with a 256-bit key. A fresh random IV per call means the same
 * plaintext encrypts to a different payload every time. Throws only on a wrong-length
 * key (programmer/operator error, not a recoverable failure).
 */
export function encryptSecret(plaintext: string, key: Buffer): string {
  if (key.length !== KEY_BYTES) {
    throw new Error(`encryption key must be ${KEY_BYTES} bytes, got ${key.length}`);
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

/**
 * The outcome of a decrypt: the plaintext, or a typed failure the caller must handle
 * (`bad_key` = wrong key or tampered ciphertext — the GCM auth tag rejected it;
 * `malformed` = the payload isn't a well-formed `v1` envelope). Never `null` — the
 * reason travels with the result (coding-style: Result over null).
 */
export type DecryptResult =
  | { readonly ok: true; readonly plaintext: string }
  | { readonly ok: false; readonly reason: 'bad_key' | 'malformed' };

/** Decrypt a payload produced by {@link encryptSecret}. */
export function decryptSecret(payload: string, key: Buffer): DecryptResult {
  if (key.length !== KEY_BYTES) {
    // A wrong-length key can never have produced a valid tag; treat as bad_key
    // rather than throwing, so a key rotation/misconfig degrades gracefully.
    return { ok: false, reason: 'bad_key' };
  }
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    return { ok: false, reason: 'malformed' };
  }
  const [, ivPart, tagPart, dataPart] = parts as [string, string, string, string];
  const iv = Buffer.from(ivPart, 'base64url');
  const tag = Buffer.from(tagPart, 'base64url');
  const ciphertext = Buffer.from(dataPart, 'base64url');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    return { ok: false, reason: 'malformed' };
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return { ok: true, plaintext: plaintext.toString('utf8') };
  } catch {
    // `final()` throws when the auth tag doesn't verify — wrong key or tampering.
    return { ok: false, reason: 'bad_key' };
  }
}

/**
 * Constant-time equality for two secrets (e.g. comparing a presented `/link` code
 * against the stored one), avoiding the timing leak of `===`. Length mismatch is an
 * immediate, safe `false`.
 */
export function secretsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
