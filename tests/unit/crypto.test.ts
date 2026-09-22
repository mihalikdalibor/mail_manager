import { randomBytes } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { accountAad, CryptoError, decryptSecret, encryptSecret } from '../../src/core/crypto.js';
import type { EncryptedSecret } from '../../src/core/crypto.js';

const PLAIN = 'hunter2-ÄŠť';
const AAD = 'mail_accounts:user-1:acct-1';

function key(): Buffer {
  return randomBytes(32);
}

/** Flip one bit of a base64-encoded field. */
function tamper(b64: string, byteIndex = 0): string {
  const buf = Buffer.from(b64, 'base64');
  const i = Math.min(byteIndex, buf.length - 1);
  buf[i] = (buf[i] ?? 0) ^ 0x01;
  return buf.toString('base64');
}

function expectCryptoError(fn: () => unknown, message?: string): CryptoError {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(CryptoError);
  const err = caught as CryptoError;
  if (message !== undefined) expect(err.message).toBe(message);
  return err;
}

describe('accountAad', () => {
  it('builds the exact AAD string', () => {
    expect(accountAad('u-123', 'a-456')).toBe('mail_accounts:u-123:a-456');
  });
});

describe('encryptSecret / decryptSecret', () => {
  it.each([
    ['ascii-ish', PLAIN],
    ['empty string', ''],
    ['unicode', 'heslo-ščťžýáíé-🔒'],
  ])('round-trips %s', (_label, plaintext) => {
    const k = key();
    const secret = encryptSecret(plaintext, k, 1, AAD);
    expect(decryptSecret(secret, k, AAD)).toBe(plaintext);
  });

  it('produces base64 fields with a 12-byte IV and 16-byte tag and echoes keyVersion', () => {
    const secret = encryptSecret(PLAIN, key(), 7, AAD);
    expect(secret.keyVersion).toBe(7);
    for (const field of [secret.ciphertext, secret.iv, secret.tag]) {
      expect(typeof field).toBe('string');
      expect(field).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
    }
    expect(Buffer.from(secret.iv, 'base64')).toHaveLength(12);
    expect(Buffer.from(secret.tag, 'base64')).toHaveLength(16);
  });

  it('ciphertext is not the plaintext', () => {
    const secret = encryptSecret(PLAIN, key(), 1, AAD);
    expect(secret.ciphertext).not.toBe(Buffer.from(PLAIN, 'utf8').toString('base64'));
    expect(secret.ciphertext).not.toContain(PLAIN);
  });

  it('uses a unique IV for each of 100 encryptions', () => {
    const k = key();
    const ivs = new Set<string>();
    for (let i = 0; i < 100; i++) ivs.add(encryptSecret(PLAIN, k, 1, AAD).iv);
    expect(ivs.size).toBe(100);
  });

  it.each([0, 16, 31, 33, 64])('encrypt throws CryptoError for a %d-byte key', (n) => {
    const err = expectCryptoError(() => encryptSecret(PLAIN, randomBytes(n), 1, AAD));
    expect(err.message).not.toContain(PLAIN);
  });

  it.each([16, 31, 33])('decrypt throws CryptoError for a %d-byte key', (n) => {
    const secret = encryptSecret(PLAIN, key(), 1, AAD);
    const err = expectCryptoError(() => decryptSecret(secret, randomBytes(n), AAD));
    expect(err.message).not.toContain(PLAIN);
  });

  describe('decryption failures', () => {
    const k = key();
    const good = encryptSecret(PLAIN, k, 1, AAD);

    const cases: Array<[string, () => string]> = [
      ['wrong key', () => decryptSecret(good, key(), AAD)],
      ['wrong aad', () => decryptSecret(good, k, 'mail_accounts:user-1:acct-2')],
      [
        'tampered ciphertext',
        () => decryptSecret({ ...good, ciphertext: tamper(good.ciphertext) }, k, AAD),
      ],
      ['tampered iv', () => decryptSecret({ ...good, iv: tamper(good.iv) }, k, AAD)],
      ['tampered tag', () => decryptSecret({ ...good, tag: tamper(good.tag, 15) }, k, AAD)],
      [
        'iv not 12 bytes',
        () => decryptSecret({ ...good, iv: randomBytes(16).toString('base64') }, k, AAD),
      ],
      [
        'tag not 16 bytes',
        () => decryptSecret({ ...good, tag: randomBytes(8).toString('base64') }, k, AAD),
      ],
      ['empty tag', () => decryptSecret({ ...good, tag: '' }, k, AAD)],
    ];

    it.each(cases)('%s -> CryptoError("Decryption failed")', (_label, fn) => {
      const err = expectCryptoError(fn, 'Decryption failed');
      expect(err.message).not.toContain(PLAIN);
      expect(String(err)).not.toContain(PLAIN);
    });

    it('the original secret still decrypts (tampering used copies)', () => {
      expect(decryptSecret(good, k, AAD)).toBe(PLAIN);
    });
  });

  it('a truncated ciphertext fails', () => {
    const k = key();
    const long = 'x'.repeat(64);
    const secret: EncryptedSecret = encryptSecret(long, k, 1, AAD);
    const cut = Buffer.from(secret.ciphertext, 'base64').subarray(0, 10).toString('base64');
    expectCryptoError(
      () => decryptSecret({ ...secret, ciphertext: cut }, k, AAD),
      'Decryption failed',
    );
  });
});
