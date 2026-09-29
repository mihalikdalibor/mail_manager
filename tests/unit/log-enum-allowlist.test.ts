import { describe, it, expect } from 'vitest';
import {
  authLoginFailed,
  authLogout,
  count,
  discoverFinish,
  doctorCheck,
  eventLevel,
  guardBlock,
  guardChallenge,
  imapLoginFailed,
  oneOf,
  renderEvent,
} from '../../src/core/log/index.js';
import type { LogEvent, RunContext } from '../../src/core/log/index.js';
import { FAIL2BAN_FAILREGEX } from '../../src/core/security/events.js';

// M1b-4b hardening: enum fields are checked at runtime too (TypeScript types can be bypassed).
// Canary strings are cast into every enum field; the fallbacks below are the spec.

const CTX: RunContext = {
  run: '0123456789abcdef',
  ver: '0.5.0',
  now: () => Date.UTC(2026, 8, 29, 8, 0, 0),
  level: 'debug',
};
const IP = '203.0.113.7';
const TARGET = 'd4'.repeat(32);
const UNTIL = '2026-09-29T08:15:00.000Z';
const CANARIES = [
  'hunter2',
  'hunter2-ÄŠť',
  'canary@secret-domain.example',
  'imap.secret-host.example',
  'Tajný predmet',
  '',
  'toString',
  '__proto__',
  'constructor',
];
const NEEDLES = ['hunter2', 'canary', 'secret', 'Tajn', 'predmet'];

function line(e: LogEvent): string {
  const r = renderEvent(e, CTX);
  expect(r).not.toBeNull();
  const text = r?.line ?? '';
  for (const n of NEEDLES) expect(text, `leaks ${n}`).not.toContain(n);
  return text;
}

function failRegex(): RegExp {
  return new RegExp(
    FAIL2BAN_FAILREGEX.replace('<ADDR>', '((?:\\d{1,3}\\.){3}\\d{1,3}|[0-9a-fA-F:]+)'),
  );
}

describe('oneOf', () => {
  const ALLOWED = { ok: true, warn: true, fail: true } as const;

  it.each(['ok', 'warn', 'fail'] as const)('keeps an allowed value %s', (v) => {
    expect(oneOf(v, ALLOWED, 'warn')).toBe(v);
  });

  it.each<unknown>([...CANARIES, 'OK', ' ok', 'ok\n', 1, null, undefined, {}, ['ok'], true])(
    'falls back for %j',
    (v) => {
      expect(oneOf(v, ALLOWED, 'warn')).toBe('warn');
    },
  );

  it('does not accept inherited keys', () => {
    for (const k of ['toString', 'hasOwnProperty', 'valueOf', '__proto__', 'constructor']) {
      expect(oneOf(k, ALLOWED, 'fail')).toBe('fail');
    }
  });
});

describe('count', () => {
  it.each([0, 1, 5, 1000, Number.MAX_SAFE_INTEGER])('keeps %d', (n) => {
    expect(count(n)).toBe(n);
  });

  it.each<unknown>([
    -1,
    -0.5,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    2 ** 60,
    '5',
    'hunter2',
    null,
    undefined,
    true,
    {},
    [3],
  ])('turns %j into 0', (v) => {
    expect(count(v)).toBe(0);
  });

  it('turns a bigint into 0', () => {
    expect(count(5n)).toBe(0);
  });
});

describe('runtime allowlists: domain events', () => {
  it.each(CANARIES)('doctorCheck status %j → warn', (c) => {
    const e = doctorCheck('node', c as never);
    expect(e).toEqual({ event: 'doctor.check', check: 'node', status: 'warn' });
    expect(eventLevel(e)).toBe('warn');
    line(e);
  });

  it.each(CANARIES)('discoverFinish outcome %j → invalid', (c) => {
    const e = discoverFinish({ outcome: c as never });
    expect(e).toEqual({ event: 'discover.finish', outcome: 'invalid' });
    line(e);
  });

  it.each(CANARIES)('discoverFinish source/domainProblem/choice %j → omitted', (c) => {
    const e = discoverFinish({
      outcome: 'found',
      source: c as never,
      provider: 'websupport',
      domainProblem: c as never,
      choice: c as never,
    });
    expect(e).toEqual({ event: 'discover.finish', outcome: 'found', provider: 'websupport' });
    for (const k of ['source', 'domainProblem', 'choice']) expect(Object.keys(e)).not.toContain(k);
    line(e);
  });

  it('discoverFinish keeps valid enum values next to the check', () => {
    expect(
      discoverFinish({
        outcome: 'manual',
        source: 'srv',
        domainProblem: 'dns-unreachable',
        choice: 'host-entered',
      }),
    ).toEqual({
      event: 'discover.finish',
      outcome: 'manual',
      source: 'srv',
      domainProblem: 'dns-unreachable',
      choice: 'host-entered',
    });
  });

  it.each(CANARIES)('authLoginFailed reason %j → unexpected', (c) => {
    const e = authLoginFailed(c as never, TARGET);
    expect(e).toEqual({ event: 'auth.login-failed', reason: 'unexpected', target: TARGET });
    line(e);
  });

  it.each(CANARIES)('authLogout outcome %j → not-logged-in', (c) => {
    const e = authLogout(c as never);
    expect(e).toEqual({ event: 'auth.logout', outcome: 'not-logged-in' });
    line(e);
  });
});

describe('runtime allowlists: guard events', () => {
  const who = { provider: 'custom', ip: IP, target: TARGET };

  it.each(CANARIES)('imapLoginFailed reason %j → unexpected', (c) => {
    const e = imapLoginFailed(who, c as never, false);
    expect(e).toMatchObject({ event: 'imap.login-failed', reason: 'unexpected' });
    line(e);
  });

  it("imapLoginFailed allows 'blocked'", () => {
    expect(imapLoginFailed(who, 'blocked', false).reason).toBe('blocked');
  });

  it.each<unknown>(['true', 1, 'hunter2', {}, null, undefined, false, 'yes'])(
    'imapLoginFailed counted %j → false',
    (c) => {
      const e = imapLoginFailed(who, 'auth-failed', c as never);
      expect(e).toMatchObject({ counted: false });
      expect(line(e)).toContain('"counted":false');
    },
  );

  it('imapLoginFailed counted true stays true', () => {
    expect(imapLoginFailed(who, 'auth-failed', true).counted).toBe(true);
  });

  it.each<unknown>([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '3', 'hunter2', null, 2 ** 60])(
    'guardChallenge attempts %j → 0',
    (c) => {
      const e = guardChallenge(IP, c as never, TARGET);
      expect(e).toEqual({ event: 'login-guard.challenge', ip: IP, attempts: 0, target: TARGET });
      line(e);
    },
  );

  const block = (over: Record<string, unknown>): LogEvent =>
    guardBlock({
      kind: 'ip-blocked',
      reason: 'auth-failed',
      ip: IP,
      addr: IP,
      attempts: 3,
      until: UNTIL,
      target: TARGET,
      ...over,
    } as never);

  it.each<unknown>([-1, 2.5, Number.NaN, '3', 'hunter2', null])(
    'guardBlock attempts %j → 0',
    (c) => {
      expect(block({ attempts: c })).toMatchObject({ attempts: 0 });
    },
  );

  it.each(CANARIES)('guardBlock kind %j → too-many-attempts, which fail2ban ignores', (c) => {
    const e = block({ kind: c });
    expect(e).toMatchObject({ event: 'login-guard.block', kind: 'too-many-attempts' });
    expect(eventLevel(e)).toBe('warn');
    expect(failRegex().test(line(e))).toBe(false);
  });

  it('a valid ip-blocked kind still matches fail2ban (control)', () => {
    expect(failRegex().test(line(block({})))).toBe(true);
  });

  it.each([...CANARIES, 'blocked'])('guardBlock reason %j → unexpected', (c) => {
    const e = block({ reason: c });
    expect(e).toMatchObject({ reason: 'unexpected' });
    line(e);
  });
});
