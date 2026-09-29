import { createHmac, hkdfSync } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  authEmailTarget,
  authTargetKey,
  guardTargetKey,
  hmacTarget,
} from '../../src/core/security/events.js';

// auth.login-failed targets: HMAC of the e-mail typed into `mm login`, with its own key.

const MASTER = Buffer.alloc(32, 0x5a);
const HEX64 = /^[0-9a-f]{64}$/;
const ADDRESS = 'someone@example-test-domain.eu';

function expectedTarget(key: Buffer, normalised: string): string {
  return createHmac('sha256', key).update(normalised).digest('hex');
}

describe('authTargetKey', () => {
  it('is HKDF-SHA256(masterKey, empty salt, "mm-auth-target-v1", 32)', () => {
    const expected = Buffer.from(
      hkdfSync('sha256', MASTER, Buffer.alloc(0), 'mm-auth-target-v1', 32),
    );
    const key = authTargetKey(MASTER);
    expect(Buffer.isBuffer(key)).toBe(true);
    expect(key).toHaveLength(32);
    expect(key.equals(expected)).toBe(true);
    expect(authTargetKey(MASTER).equals(key)).toBe(true);
  });

  it('differs from the login-guard key of the same master key', () => {
    expect(authTargetKey(MASTER).equals(guardTargetKey(MASTER))).toBe(false);
  });

  it('differs per master key', () => {
    expect(authTargetKey(MASTER).equals(authTargetKey(Buffer.alloc(32, 0x5b)))).toBe(false);
  });

  it('without a master key: 32 random bytes, different on every call', () => {
    const a = authTargetKey(undefined);
    const b = authTargetKey(undefined);
    expect(Buffer.isBuffer(a)).toBe(true);
    expect(a).toHaveLength(32);
    expect(b).toHaveLength(32);
    expect(a.equals(b)).toBe(false);
  });
});

describe('authEmailTarget', () => {
  const key = authTargetKey(MASTER);

  it('is HMAC-SHA256(key, "<local lowercased>@<ascii domain>") as 64 hex', () => {
    const t = authEmailTarget(key, ADDRESS);
    expect(t).toMatch(HEX64);
    expect(t).toBe(expectedTarget(key, ADDRESS));
  });

  it('is deterministic for the same key and address', () => {
    expect(authEmailTarget(authTargetKey(MASTER), ADDRESS)).toBe(authEmailTarget(key, ADDRESS));
  });

  it.each([
    `  ${ADDRESS}  `,
    `\t${ADDRESS}\n`,
    'SomeOne@Example-Test-Domain.EU',
    'SOMEONE@EXAMPLE-TEST-DOMAIN.EU',
  ])('normalises %j to the same target', (typed) => {
    expect(authEmailTarget(key, typed)).toBe(authEmailTarget(key, ADDRESS));
  });

  it('an IDN domain and its punycode give the same target', () => {
    const unicode = authEmailTarget(key, 'user@bücher.example');
    const puny = authEmailTarget(key, 'user@xn--bcher-kva.example');
    expect(unicode).toMatch(HEX64);
    expect(unicode).toBe(puny);
    expect(unicode).toBe(expectedTarget(key, 'user@xn--bcher-kva.example'));
    expect(authEmailTarget(key, 'User@BÜCHER.example')).toBe(puny);
  });

  it('different addresses give different targets', () => {
    expect(authEmailTarget(key, 'a@example-test-domain.eu')).not.toBe(
      authEmailTarget(key, 'b@example-test-domain.eu'),
    );
  });

  it('a different key gives a different target', () => {
    expect(authEmailTarget(authTargetKey(Buffer.alloc(32, 1)), ADDRESS)).not.toBe(
      authEmailTarget(key, ADDRESS),
    );
  });

  it.each([
    '',
    '   ',
    '\n',
    '@x',
    'x@',
    '@',
    'x@y',
    'hunter2-ÄŠť',
    'P@ssw0rd',
    'correct horse battery staple',
    'someone',
    'some one@example-test-domain.eu',
    'someone@exa mple.eu',
    'someone@127.0.0.1',
    'someone@localhost',
    `${'a'.repeat(250)}@example.eu`,
  ])('returns "invalid" for %j', (typed) => {
    expect(authEmailTarget(key, typed)).toBe('invalid');
  });

  it('differs from mailbox targets (hmacTarget) and from a guard-keyed HMAC', () => {
    const t = authEmailTarget(key, ADDRESS);
    const guardKey = guardTargetKey(MASTER);
    expect(t).not.toBe(hmacTarget(key, 'example-test-domain.eu', ADDRESS));
    expect(t).not.toBe(hmacTarget(key, 'imap.example-test-domain.eu', ADDRESS));
    expect(t).not.toBe(hmacTarget(guardKey, 'imap.example-test-domain.eu', ADDRESS));
    expect(t).not.toBe(expectedTarget(guardKey, ADDRESS));
    expect(t).not.toBe(authEmailTarget(guardKey, ADDRESS));
  });

  it('never contains the address or its parts', () => {
    const t = authEmailTarget(key, 'canary@secret-domain.example');
    expect(t).toMatch(HEX64);
    expect(t).not.toContain('canary');
    expect(t).not.toContain('secret');
  });
});
