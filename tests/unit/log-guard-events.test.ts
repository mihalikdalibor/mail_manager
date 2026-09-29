import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { IMAP_FAILURE_REASONS } from '../../src/core/imap/errors.js';
import {
  eventLevel,
  guardBlock,
  guardChallenge,
  imapLogin,
  imapLoginFailed,
  renderEvent,
} from '../../src/core/log/index.js';
import type { LogEvent, RunContext } from '../../src/core/log/index.js';
import { FAIL2BAN_FAILREGEX, type BlockKind } from '../../src/core/security/events.js';

// M1b-4b login-guard / mailbox-login events (security log), from the spec.

const CTX: RunContext = {
  run: '0123456789abcdef',
  ver: '0.5.0',
  now: () => Date.UTC(2026, 8, 29, 8, 0, 0),
  level: 'error',
};
const IP = '203.0.113.7';
const TARGET = 'b2'.repeat(32);
const ACCT = randomUUID();

function rendered(e: LogEvent): { kind: string; line: string; keys: string[] } {
  const r = renderEvent(e, CTX);
  expect(r).not.toBeNull();
  return { kind: r?.kind ?? '', line: r?.line ?? '', keys: Object.keys(r?.record ?? {}) };
}

// fail2ban's <ADDR> matches an IPv4 or IPv6 address only.
function failRegex(): RegExp {
  return new RegExp(
    FAIL2BAN_FAILREGEX.replace('<ADDR>', '((?:\\d{1,3}\\.){3}\\d{1,3}|[0-9a-fA-F:]+)'),
  );
}

describe('imapLogin', () => {
  it('with an account: acct, provider, ip, target in that order, info, security', () => {
    const e = imapLogin({ provider: 'websupport', acct: ACCT, ip: IP, target: TARGET });
    expect(e).toEqual({
      event: 'imap.login',
      acct: ACCT,
      provider: 'websupport',
      ip: IP,
      target: TARGET,
    });
    expect(eventLevel(e)).toBe('info');
    const r = rendered(e);
    expect(r.kind).toBe('security');
    expect(r.line.startsWith('mm-security {')).toBe(true);
    expect(r.keys).toEqual([
      'ts',
      'event',
      'acct',
      'provider',
      'ip',
      'target',
      'level',
      'run',
      'v',
    ]);
  });

  it('without an account the acct field is omitted', () => {
    const e = imapLogin({ provider: 'custom', ip: 'local', target: TARGET });
    expect(e).toEqual({ event: 'imap.login', provider: 'custom', ip: 'local', target: TARGET });
    expect(Object.keys(e)).not.toContain('acct');
  });

  it('lowercases the account UUID', () => {
    expect(
      imapLogin({ provider: 'custom', acct: ACCT.toUpperCase(), ip: IP, target: TARGET }).acct,
    ).toBe(ACCT);
  });

  it.each(['acct-1', '', 'canary@secret-domain.example', `${ACCT}x`])(
    'drops an invalid acct %j',
    (acct) => {
      const e = imapLogin({ provider: 'custom', acct, ip: IP, target: TARGET });
      expect(Object.keys(e)).not.toContain('acct');
    },
  );

  it.each(['', 'imap.secret-host.example', 'Web Support', 'a'.repeat(41), 'x\ny'])(
    'an invalid provider %j becomes "custom"',
    (provider) => {
      expect(imapLogin({ provider, ip: IP, target: TARGET }).provider).toBe('custom');
    },
  );
});

describe('imapLoginFailed', () => {
  it.each([...IMAP_FAILURE_REASONS, 'blocked' as const])(
    'reason %s: warn, fields in catalog order',
    (reason) => {
      const e = imapLoginFailed(
        { provider: 'gmail', acct: ACCT, ip: IP, target: TARGET },
        reason,
        reason === 'auth-failed',
      );
      expect(e).toEqual({
        event: 'imap.login-failed',
        acct: ACCT,
        provider: 'gmail',
        reason,
        counted: reason === 'auth-failed',
        ip: IP,
        target: TARGET,
      });
      expect(eventLevel(e)).toBe('warn');
      const r = rendered(e);
      expect(r.kind).toBe('security');
      expect(r.keys).toEqual([
        'ts',
        'event',
        'acct',
        'provider',
        'reason',
        'counted',
        'ip',
        'target',
        'level',
        'run',
        'v',
      ]);
    },
  );

  it('counted false is kept (not omitted)', () => {
    const e = imapLoginFailed({ provider: 'custom', ip: IP, target: TARGET }, 'blocked', false);
    expect(e.counted).toBe(false);
    expect(rendered(e).line).toContain('"counted":false');
    expect(Object.keys(e)).not.toContain('acct');
  });

  it('provider and acct are cleaned like imapLogin', () => {
    const e = imapLoginFailed(
      { provider: 'imap.secret-host.example', acct: 'nope', ip: IP, target: TARGET },
      'timeout',
      false,
    );
    expect(e.provider).toBe('custom');
    expect(Object.keys(e)).not.toContain('acct');
  });
});

describe('guardChallenge', () => {
  it('ip, attempts, target; warn; security', () => {
    const e = guardChallenge(IP, 2, TARGET);
    expect(e).toEqual({ event: 'login-guard.challenge', ip: IP, attempts: 2, target: TARGET });
    expect(eventLevel(e)).toBe('warn');
    const r = rendered(e);
    expect(r.kind).toBe('security');
    expect(r.keys).toEqual(['ts', 'event', 'ip', 'attempts', 'target', 'level', 'run', 'v']);
  });

  it('keeps attempts 0', () => {
    expect(guardChallenge(IP, 0, TARGET).attempts).toBe(0);
  });
});

describe('guardBlock', () => {
  const UNTIL = '2026-09-29T08:15:00.000Z';

  it.each<[BlockKind, string]>([
    ['too-many-attempts', 'warn'],
    ['ip-blocked', 'warn'],
    ['permanent', 'error'],
  ])('%s → level %s, fields in the fail2ban-stable order', (kind, level) => {
    const until = kind === 'permanent' ? null : UNTIL;
    const e = guardBlock({
      kind,
      reason: 'auth-failed',
      ip: IP,
      addr: IP,
      attempts: kind === 'too-many-attempts' ? 5 : 3,
      until,
      target: TARGET,
    });
    expect(e).toEqual({
      event: 'login-guard.block',
      kind,
      reason: 'auth-failed',
      ip: IP,
      addr: IP,
      attempts: kind === 'too-many-attempts' ? 5 : 3,
      until,
      target: TARGET,
    });
    expect(eventLevel(e)).toBe(level);
    const r = rendered(e);
    expect(r.kind).toBe('security');
    expect(r.line.startsWith('mm-security {')).toBe(true);
    expect(r.keys).toEqual([
      'ts',
      'event',
      'kind',
      'reason',
      'ip',
      'addr',
      'attempts',
      'until',
      'target',
      'level',
      'run',
      'v',
    ]);
  });

  it('keeps null addr and null until in the line', () => {
    const e = guardBlock({
      kind: 'permanent',
      reason: 'auth-failed',
      ip: 'local',
      addr: null,
      attempts: 3,
      until: null,
      target: TARGET,
    });
    const line = rendered(e).line;
    expect(line).toContain('"addr":null');
    expect(line).toContain('"until":null');
  });

  it.each<[BlockKind, string, string]>([
    ['ip-blocked', IP, IP],
    ['permanent', IP, IP],
    ['ip-blocked', '2001:db8:1:2::/64', '2001:db8:1:2:0:0:0:1'],
  ])('rendered %s line still matches FAIL2BAN_FAILREGEX and captures %s', (kind, ip, addr) => {
    const line = rendered(
      guardBlock({
        kind,
        reason: 'auth-failed',
        ip,
        addr,
        attempts: 3,
        until: kind === 'permanent' ? null : UNTIL,
        target: TARGET,
      }),
    ).line;
    const m = failRegex().exec(line);
    expect(m).not.toBeNull();
    expect(m?.[1]).toBe(addr);
  });

  it('a too-many-attempts line does not match the fail2ban regex', () => {
    const line = rendered(
      guardBlock({
        kind: 'too-many-attempts',
        reason: 'auth-failed',
        ip: IP,
        addr: IP,
        attempts: 5,
        until: UNTIL,
        target: TARGET,
      }),
    ).line;
    expect(failRegex().test(line)).toBe(false);
  });
});
