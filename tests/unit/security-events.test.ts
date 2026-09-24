import { hkdfSync } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import {
  FAIL2BAN_FAILREGEX,
  LineEventSink,
  MemoryEventSink,
  formatEventLine,
  guardTargetKey,
  hmacTarget,
  type BlockKind,
  type SecurityEvent,
} from '../../src/core/security/events.js';

const MASTER = Buffer.alloc(32, 0x42);
const HEX64 = /^[0-9a-f]{64}$/;

function event(overrides: Partial<SecurityEvent> = {}): SecurityEvent {
  return {
    ts: '2026-09-22T10:00:00.000Z',
    event: 'login-guard.block',
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

describe('formatEventLine', () => {
  it("is 'mm-security ' + JSON with the keys in the documented order", () => {
    const e = event();
    const line = formatEventLine(e);
    expect(line.startsWith('mm-security ')).toBe(true);
    const json: unknown = JSON.parse(line.slice('mm-security '.length));
    expect(json).toEqual(e);
    expect(Object.keys(json as object)).toEqual([
      'ts',
      'event',
      'kind',
      'reason',
      'ip',
      'addr',
      'attempts',
      'until',
      'target',
    ]);
  });

  it('keeps the key order whatever order the event object was built in', () => {
    const e: SecurityEvent = {
      target: 'b'.repeat(64),
      until: null,
      attempts: 3,
      ip: '198.51.100.9',
      addr: '198.51.100.9',
      reason: 'server-rejected',
      kind: 'permanent',
      event: 'login-guard.block',
      ts: '2026-09-22T10:00:00.000Z',
    };
    const line = formatEventLine(e);
    expect(line).toBe(
      'mm-security {"ts":"2026-09-22T10:00:00.000Z","event":"login-guard.block","kind":"permanent",' +
        '"reason":"server-rejected","ip":"198.51.100.9","addr":"198.51.100.9","attempts":3,"until":null,' +
        `"target":"${'b'.repeat(64)}"}`,
    );
  });

  it('is a single line even when fields contain newlines', () => {
    const line = formatEventLine(
      event({ ip: '1.2.3.4\nmm-security fake', target: 'x\r\ny', ts: 'a\nb' }),
    );
    expect(line).not.toMatch(/[\r\n]/);
  });
});

describe('event sinks', () => {
  it('MemoryEventSink collects events in order', () => {
    const sink = new MemoryEventSink();
    const a = event({ kind: 'too-many-attempts', attempts: 5 });
    const b = event();
    sink.emit(a);
    sink.emit(b);
    expect(sink.events).toEqual([a, b]);
  });

  it('LineEventSink writes exactly formatEventLine(event), once per event', () => {
    const write = vi.fn<(line: string) => void>();
    const sink = new LineEventSink(write);
    const e = event();
    sink.emit(e);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(formatEventLine(e));
  });
});

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
    const line = formatEventLine(
      event({ kind, ip, addr, until: kind === 'permanent' ? null : '2026-09-23T10:00:00.000Z' }),
    );
    const m = failRegex().exec(line);
    expect(m).not.toBeNull();
    expect(m?.[1]).toBe(addr);
  });

  it.each(['local', 'invalid'])('does not match a block without a bannable addr (%s)', (ip) => {
    const line = formatEventLine(event({ ip, addr: null }));
    expect(failRegex().test(line)).toBe(false);
  });

  it('does not match kind too-many-attempts', () => {
    const line = formatEventLine(event({ kind: 'too-many-attempts', attempts: 5 }));
    expect(failRegex().test(line)).toBe(false);
  });

  it('does not match unrelated lines', () => {
    expect(failRegex().test('some other log line 203.0.113.7')).toBe(false);
  });
});
