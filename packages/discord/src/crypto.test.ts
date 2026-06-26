import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { KEY_BYTES, decryptSecret, encryptSecret, keyFromBase64, secretsEqual } from './crypto.js';

const KEY = randomBytes(KEY_BYTES);
const OTHER_KEY = randomBytes(KEY_BYTES);
const BOT_TOKEN = 'MT234567890.fake.discord-bot-token-value';

describe('encryptSecret / decryptSecret', () => {
  it('round-trips a secret', () => {
    const payload = encryptSecret(BOT_TOKEN, KEY);
    const result = decryptSecret(payload, KEY);
    expect(result).toEqual({ ok: true, plaintext: BOT_TOKEN });
  });

  it('round-trips an empty string', () => {
    const result = decryptSecret(encryptSecret('', KEY), KEY);
    expect(result).toEqual({ ok: true, plaintext: '' });
  });

  it('produces ciphertext that is not the plaintext', () => {
    const payload = encryptSecret(BOT_TOKEN, KEY);
    expect(payload).not.toContain(BOT_TOKEN);
  });

  it('produces a different payload each call (random IV)', () => {
    expect(encryptSecret(BOT_TOKEN, KEY)).not.toBe(encryptSecret(BOT_TOKEN, KEY));
  });

  it('fails with bad_key under the wrong key', () => {
    const payload = encryptSecret(BOT_TOKEN, KEY);
    expect(decryptSecret(payload, OTHER_KEY)).toEqual({ ok: false, reason: 'bad_key' });
  });

  it('fails with bad_key when the ciphertext is tampered', () => {
    const payload = encryptSecret(BOT_TOKEN, KEY);
    const parts = payload.split('.');
    // Flip a whole byte of the ciphertext (decode → mutate → re-encode), so the bytes
    // genuinely change — flipping a base64url char can hit only unused padding bits.
    const bytes = Buffer.from(parts[3] as string, 'base64url');
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    const tampered = [parts[0], parts[1], parts[2], bytes.toString('base64url')].join('.');
    expect(decryptSecret(tampered, KEY)).toEqual({ ok: false, reason: 'bad_key' });
  });

  it('reports malformed for a non-envelope string', () => {
    expect(decryptSecret('not-a-payload', KEY)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('reports malformed for an unknown version prefix', () => {
    const payload = encryptSecret(BOT_TOKEN, KEY).replace(/^v1\./, 'v2.');
    expect(decryptSecret(payload, KEY)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('reports malformed when the IV length is wrong', () => {
    const parts = encryptSecret(BOT_TOKEN, KEY).split('.');
    const shortIv = Buffer.from('too-short').toString('base64url');
    const broken = [parts[0], shortIv, parts[2], parts[3]].join('.');
    expect(decryptSecret(broken, KEY)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('throws when encrypting with a wrong-length key', () => {
    expect(() => encryptSecret(BOT_TOKEN, randomBytes(16))).toThrow(/32 bytes/);
  });

  it('returns bad_key (not a throw) when decrypting with a wrong-length key', () => {
    const payload = encryptSecret(BOT_TOKEN, KEY);
    expect(decryptSecret(payload, randomBytes(16))).toEqual({ ok: false, reason: 'bad_key' });
  });
});

describe('keyFromBase64', () => {
  it('decodes a 32-byte base64 key', () => {
    const encoded = KEY.toString('base64');
    expect(keyFromBase64(encoded).equals(KEY)).toBe(true);
  });

  it('throws on a wrong-length key', () => {
    expect(() => keyFromBase64(Buffer.from('short').toString('base64'))).toThrow(/32 bytes/);
  });
});

describe('secretsEqual', () => {
  it('is true for equal strings and false otherwise', () => {
    expect(secretsEqual('abc123', 'abc123')).toBe(true);
    expect(secretsEqual('abc123', 'abc124')).toBe(false);
    expect(secretsEqual('abc', 'abcd')).toBe(false);
  });
});
