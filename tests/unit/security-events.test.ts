import { hkdfSync } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { guardBlock, renderEvent, type GuardBlockFields } from '../../src/core/log/index.js';
import {
  FAIL2BAN_FAILREGEX,
  authEmailTarget,
  authTargetKey,
  guardTargetKey,
  hmacTarget,
  type BlockKind,
} from '../../src/core/security/events.js';

const MASTER = Buffer.alloc(32, 0x42);
const HEX64 = /^[0-9a-f]{64}$/;

const CTX = {
  run: '0123456789abcdef',
  ver: 't',
  now: () => Date.parse('2026-09-22T10:00:00.000Z'),
  level: 'info' as const,
};

function event(overrides: Partial<GuardBlockFields> = {}): GuardBlockFields {
  return {
    kind: 'ip-blocked',
    reason: 'auth-failed',
    ip: '203.0.113.7',
    addr: '203.0.113.7',
    attempts: 3,
    until: '2026-09-23T10:00:00.000Z',
    target: 'a'.repeat(64),
    ...overrides,
  };
}

// fail2ban's <ADDR> matches an IPv4 or IPv6 address only (never a host name or a /64 range).
function failRegex(): RegExp {
  return new RegExp(
    FAIL2BAN_FAILREGEX.replace('<ADDR>', '((?:\\d{1,3}\\.){3}\\d{1,3}|[0-9a-fA-F:]+)'),
  );
}

describe('guardTargetKey', () => {
  it('is HKDF-SHA256(masterKey, empty salt, "mm-login-guard-v1", 32)', () => {
    const expected = Buffer.from(
      hkdfSync('sha256', MASTER, Buffer.alloc(0), 'mm-login-guard-v1', 32),
    );
    const key = guardTargetKey(MASTER);
    expect(Buffer.isBuffer(key)).toBe(true);
    expect(key).toHaveLength(32);
    expect(key.equals(expected)).toBe(true);
  });

  it('is deterministic for the same master key and differs from the master key', () => {
    const a = guardTargetKey(MASTER);
    const b = guardTargetKey(Buffer.from(MASTER));
    expect(a.equals(b)).toBe(true);
    expect(a.equals(MASTER)).toBe(false);
  });

  it('differs for a different master key', () => {
    expect(guardTargetKey(MASTER).equals(guardTargetKey(Buffer.alloc(32, 0x43)))).toBe(false);
  });

  it('without a master key → random 32 bytes, different on every call', () => {
    const a = guardTargetKey(undefined);
    const b = guardTargetKey(undefined);
    expect(Buffer.isBuffer(a)).toBe(true);
    expect(a).toHaveLength(32);
    expect(b).toHaveLength(32);
    expect(a.equals(b)).toBe(false);
  });
});

describe('hmacTarget', () => {
  it('ignores surrounding whitespace in the username', () => {
    const key = guardTargetKey(Buffer.alloc(32, 3));
    expect(hmacTarget(key, 'imap.example.com', '  someone@example.com ')).toBe(
      hmacTarget(key, 'imap.example.com', 'someone@example.com'),
    );
  });

  const key = guardTargetKey(MASTER);

  it('is 64 lowercase hex characters and deterministic', () => {
    const h = hmacTarget(key, 'imap.example.com', 'someone@example.com');
    expect(h).toMatch(HEX64);
    expect(hmacTarget(key, 'imap.example.com', 'someone@example.com')).toBe(h);
  });

  it('ignores case of host and username', () => {
    expect(hmacTarget(key, 'IMAP.Example.COM', 'SomeOne@Example.com')).toBe(
      hmacTarget(key, 'imap.example.com', 'someone@example.com'),
    );
  });

  it('ignores a trailing dot on the host', () => {
    expect(hmacTarget(key, 'IMAP.Example.COM.', 'u@example.com')).toBe(
      hmacTarget(key, 'imap.example.com', 'u@example.com'),
    );
  });

  it('treats an IDN host and its punycode form as the same host', () => {
    expect(hmacTarget(key, 'imap.münchen.de', 'u@example.com')).toBe(
      hmacTarget(key, 'imap.xn--mnchen-3ya.de', 'u@example.com'),
    );
  });

  it('differs for a different key, username or host', () => {
    const base = hmacTarget(key, 'imap.example.com', 'a@example.com');
    expect(
      hmacTarget(guardTargetKey(Buffer.alloc(32, 1)), 'imap.example.com', 'a@example.com'),
    ).not.toBe(base);
    expect(hmacTarget(key, 'imap.example.com', 'b@example.com')).not.toBe(base);
    expect(hmacTarget(key, 'imap.example.org', 'a@example.com')).not.toBe(base);
  });

  it('does not contain the host or username', () => {
    const h = hmacTarget(key, 'canary-host.example', 'canary-user@example.com');
    expect(h).not.toContain('canary');
  });
});

/** The real `login-guard.block` line, as the log core writes it (mm-security prefix, envelope). */
function blockLine(fields: GuardBlockFields): string {
  return renderEvent(guardBlock(fields), CTX)?.line ?? '';
}

describe('FAIL2BAN_FAILREGEX', () => {
  it('uses <ADDR> (IP addresses only), not <HOST>', () => {
    expect(FAIL2BAN_FAILREGEX).toContain('<ADDR>');
    expect(FAIL2BAN_FAILREGEX).not.toContain('<HOST>');
  });

  it.each<[BlockKind, string, string]>([
    ['ip-blocked', '203.0.113.7', '203.0.113.7'],
    ['permanent', '203.0.113.7', '203.0.113.7'],
    ['ip-blocked', '2001:db8:1:2::/64', '2001:db8:1:2:0:0:0:1'],
    ['permanent', '198.51.100.9', '198.51.100.9'],
  ])('matches kind %s (bucket %s) and captures the bannable addr %s', (kind, ip, addr) => {
    const line = blockLine(
      event({ kind, ip, addr, until: kind === 'permanent' ? null : '2026-09-23T10:00:00.000Z' }),
    );
    const m = failRegex().exec(line);
    expect(m).not.toBeNull();
    expect(m?.[1]).toBe(addr);
  });

  it.each(['local', 'invalid'])('does not match a block without a bannable addr (%s)', (ip) => {
    const line = blockLine(event({ ip, addr: null }));
    expect(failRegex().test(line)).toBe(false);
  });

  it('does not match kind too-many-attempts', () => {
    const line = blockLine(event({ kind: 'too-many-attempts', attempts: 5 }));
    expect(failRegex().test(line)).toBe(false);
  });

  it('does not match unrelated lines', () => {
    expect(failRegex().test('some other log line 203.0.113.7')).toBe(false);
  });
});

describe('authTargetKey', () => {
  it('is HKDF-SHA256(masterKey, empty salt, "mm-auth-target-v1", 32)', () => {
    const expected = Buffer.from(
      hkdfSync('sha256', MASTER, Buffer.alloc(0), 'mm-auth-target-v1', 32),
    );
    expect(authTargetKey(MASTER).equals(expected)).toBe(true);
  });

  it('differs from the login-guard key for the same master key', () => {
    expect(authTargetKey(MASTER).equals(guardTargetKey(MASTER))).toBe(false);
  });

  it('without a master key → random 32 bytes, different on every call', () => {
    const a = authTargetKey(undefined);
    expect(a).toHaveLength(32);
    expect(a.equals(authTargetKey(undefined))).toBe(false);
  });
});

describe('authEmailTarget', () => {
  const key = authTargetKey(MASTER);

  it('is a deterministic 64-hex HMAC for a valid address', () => {
    const t = authEmailTarget(key, 'someone@example-test-domain.eu');
    expect(t).toMatch(HEX64);
    expect(authEmailTarget(key, 'someone@example-test-domain.eu')).toBe(t);
  });

  it('ignores surrounding whitespace and case; IDN equals its punycode form', () => {
    const t = authEmailTarget(key, 'someone@example-test-domain.eu');
    expect(authEmailTarget(key, '  SomeOne@EXAMPLE-test-domain.eu ')).toBe(t);
    expect(authEmailTarget(key, 'a@bücher.example')).toBe(
      authEmailTarget(key, 'a@xn--bcher-kva.example'),
    );
  });

  it.each(['', '   ', 'hunter2-ÄŠť', 'no-at-sign', '@example.eu', 'x@', 'x@localhost'])(
    'is "invalid" for a non-address (%j) — a password typed as e-mail is never hashed',
    (input) => {
      expect(authEmailTarget(key, input)).toBe('invalid');
    },
  );

  it('never equals the mailbox target or a guard-keyed hash of the same address', () => {
    const address = 'someone@example-test-domain.eu';
    const t = authEmailTarget(key, address);
    expect(t).not.toBe(hmacTarget(guardTargetKey(MASTER), 'example-test-domain.eu', address));
    expect(t).not.toBe(authEmailTarget(guardTargetKey(MASTER), address));
  });

  it('never contains the address', () => {
    expect(authEmailTarget(key, 'someone@example-test-domain.eu')).not.toContain('someone');
  });
});
