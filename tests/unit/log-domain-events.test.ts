import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { AuthError } from '../../src/core/auth.js';
import {
  authFailureReason,
  authLogin,
  authLoginFailed,
  authLogout,
  cleanProvider,
  discoverFinish,
  doctorCheck,
  eventLevel,
  renderEvent,
  uuidOrUndefined,
} from '../../src/core/log/index.js';
import type { LogEvent, RunContext } from '../../src/core/log/index.js';

// M1b-4b domain events (app: doctor.check, discover.finish; security: auth.*), from the spec.

const CTX: RunContext = {
  run: '0123456789abcdef',
  ver: '0.5.0',
  now: () => Date.UTC(2026, 8, 29, 8, 0, 0),
  level: 'debug',
};
const HEX64 = 'a1'.repeat(32);

function rendered(e: LogEvent): { kind: string; line: string; keys: string[] } {
  const r = renderEvent(e, CTX);
  expect(r).not.toBeNull();
  return { kind: r?.kind ?? '', line: r?.line ?? '', keys: Object.keys(r?.record ?? {}) };
}

describe('cleanProvider', () => {
  it.each(['websupport', 'custom', 'gmail', 'm365-business', 'a', 'a'.repeat(40), 'x1-2'])(
    'keeps the preset id %j',
    (id) => {
      expect(cleanProvider(id)).toBe(id);
    },
  );

  it.each<unknown>([
    '',
    'a'.repeat(41),
    'WebSupport',
    'imap.secret-host.example',
    'canary@secret-domain.example',
    'web support',
    'websupport\n',
    '\nwebsupport',
    'web_support',
    'webšupport',
    123,
    null,
    undefined,
    {},
    ['websupport'],
  ])('drops %j', (id) => {
    expect(cleanProvider(id)).toBeUndefined();
  });
});

describe('uuidOrUndefined', () => {
  it('keeps a UUID and lowercases it', () => {
    const id = randomUUID();
    expect(uuidOrUndefined(id)).toBe(id);
    expect(uuidOrUndefined(id.toUpperCase())).toBe(id);
  });

  it.each<unknown>([
    'u1',
    '',
    `${randomUUID()}0`,
    `x${randomUUID()}`,
    `${randomUUID()}\n`,
    randomUUID().replace(/-/g, ''),
    randomUUID().replace(/-/g, '_'),
    'zzzzzzzz-zzzz-4zzz-8zzz-zzzzzzzzzzzz',
    123,
    null,
    undefined,
    { id: randomUUID() },
  ])('rejects %j', (value) => {
    expect(uuidOrUndefined(value)).toBeUndefined();
  });
});

describe('doctorCheck', () => {
  it.each([
    ['node', 'ok', 'info'],
    ['master-key', 'warn', 'warn'],
    ['supabase-api', 'fail', 'warn'],
    ['logs', 'ok', 'info'],
  ] as const)('%s / %s → level %s', (check, status, level) => {
    const e = doctorCheck(check, status);
    expect(e).toEqual({ event: 'doctor.check', check, status });
    expect(eventLevel(e)).toBe(level);
    expect(rendered(e).kind).toBe('app');
  });

  it.each(['', 'Node', 'supabase api', 'a'.repeat(41), 'imap.secret-host.example', 'x\ny'])(
    'an unexpected check name %j becomes "other"',
    (check) => {
      expect(doctorCheck(check, 'warn')).toEqual({
        event: 'doctor.check',
        check: 'other',
        status: 'warn',
      });
    },
  );

  it('renders in the fixed key order', () => {
    expect(rendered(doctorCheck('node', 'ok')).keys).toEqual([
      'ts',
      'event',
      'check',
      'status',
      'level',
      'run',
      'v',
    ]);
  });
});

describe('discoverFinish', () => {
  it('found with every field', () => {
    const e = discoverFinish({
      outcome: 'found',
      source: 'preset-mx',
      provider: 'websupport',
      domainProblem: 'dns-error',
      choice: 'picked',
    });
    expect(e).toEqual({
      event: 'discover.finish',
      outcome: 'found',
      source: 'preset-mx',
      provider: 'websupport',
      domainProblem: 'dns-error',
      choice: 'picked',
    });
    expect(eventLevel(e)).toBe('info');
    const r = rendered(e);
    expect(r.kind).toBe('app');
    expect(r.line.startsWith('{')).toBe(true);
    expect(r.keys).toEqual([
      'ts',
      'event',
      'outcome',
      'source',
      'provider',
      'domainProblem',
      'choice',
      'level',
      'run',
      'v',
    ]);
  });

  it('omits undefined fields (invalid → outcome only)', () => {
    const e = discoverFinish({ outcome: 'invalid' });
    expect(e).toEqual({ event: 'discover.finish', outcome: 'invalid' });
    expect(Object.keys(e).sort()).toEqual(['event', 'outcome']);
    expect(rendered(e).keys).toEqual(['ts', 'event', 'outcome', 'level', 'run', 'v']);
  });

  it('keeps explicitly undefined optional fields out of the object', () => {
    const e = discoverFinish({
      outcome: 'manual',
      source: undefined,
      provider: undefined,
      domainProblem: undefined,
      choice: 'cancelled',
    });
    expect(Object.keys(e).sort()).toEqual(['choice', 'event', 'outcome']);
  });

  it.each(['imap.secret-host.example', 'Web Support', '', 'a'.repeat(41)])(
    'drops an invalid provider %j (field omitted)',
    (provider) => {
      const e = discoverFinish({ outcome: 'needs-host', source: 'preset-mx', provider });
      expect(e).toEqual({ event: 'discover.finish', outcome: 'needs-host', source: 'preset-mx' });
      expect(Object.keys(e)).not.toContain('provider');
    },
  );

  it.each(['found', 'needs-host', 'blocked', 'manual', 'invalid'] as const)(
    'outcome %s is info',
    (outcome) => {
      expect(eventLevel(discoverFinish({ outcome }))).toBe('info');
    },
  );
});

describe('authLogin', () => {
  it('carries the Supabase user id', () => {
    const id = randomUUID();
    const e = authLogin(id);
    expect(e).toEqual({ event: 'auth.login', user: id });
    expect(eventLevel(e)).toBe('info');
    const r = rendered(e);
    expect(r.kind).toBe('security');
    expect(r.line.startsWith('mm-security {')).toBe(true);
    expect(r.keys).toEqual(['ts', 'event', 'user', 'level', 'run', 'v']);
  });

  it('lowercases an uppercase UUID', () => {
    const id = randomUUID();
    expect(authLogin(id.toUpperCase())).toEqual({ event: 'auth.login', user: id });
  });

  it.each([
    'u1',
    '',
    'canary@secret-domain.example',
    `${randomUUID()}x`,
    ` ${randomUUID()}`,
    `${randomUUID()}\n`,
    `{${randomUUID()}}`,
    randomUUID().replace(/-/g, ''),
    'g'.repeat(8) + '-0000-4000-8000-000000000000',
  ])('omits an invalid user id %j', (id) => {
    const e = authLogin(id);
    expect(e).toEqual({ event: 'auth.login' });
    expect(Object.keys(e)).not.toContain('user');
    expect(rendered(e).keys).toEqual(['ts', 'event', 'level', 'run', 'v']);
  });
});

describe('authFailureReason', () => {
  it.each([
    ['invalid_credentials', 'invalid-credentials'],
    ['unreachable', 'unreachable'],
    ['unknown', 'unknown'],
  ] as const)('AuthError(%s) → %s', (code, reason) => {
    expect(authFailureReason(new AuthError(code, 'msg'))).toBe(reason);
  });

  it.each<[string, unknown]>([
    ['a plain Error', new Error('invalid_credentials')],
    ['a TypeError', new TypeError('fetch failed')],
    ['a string', 'invalid_credentials'],
    ['null', null],
    ['undefined', undefined],
    ['a look-alike object', { name: 'AuthError', code: 'invalid_credentials' }],
    ['an AuthError with a forged code', new AuthError('bogus' as 'unknown', 'x')],
  ])('%s → unexpected', (_label, err) => {
    expect(authFailureReason(err)).toBe('unexpected');
  });
});

describe('authLoginFailed', () => {
  it.each(['invalid-credentials', 'unreachable', 'unknown', 'unexpected'] as const)(
    'reason %s with a 64-hex target, level warn',
    (reason) => {
      const e = authLoginFailed(reason, HEX64);
      expect(e).toEqual({ event: 'auth.login-failed', reason, target: HEX64 });
      expect(eventLevel(e)).toBe('warn');
      const r = rendered(e);
      expect(r.kind).toBe('security');
      expect(r.keys).toEqual(['ts', 'event', 'reason', 'target', 'level', 'run', 'v']);
    },
  );

  it('keeps the literal "invalid" target', () => {
    expect(authLoginFailed('unknown', 'invalid')).toEqual({
      event: 'auth.login-failed',
      reason: 'unknown',
      target: 'invalid',
    });
  });

  it.each([
    HEX64.toUpperCase(),
    HEX64.slice(1),
    `${HEX64}0`,
    'g'.repeat(64),
    '',
    'canary@secret-domain.example',
    'hunter2-ÄŠť',
    `${HEX64}\n`,
    'INVALID',
  ])('replaces a bad target %j with "invalid"', (target) => {
    expect(authLoginFailed('invalid-credentials', target).target).toBe('invalid');
  });
});

describe('authLogout', () => {
  it.each(['logged-out', 'not-logged-in'] as const)('%s, info, no user id', (outcome) => {
    const e = authLogout(outcome);
    expect(e).toEqual({ event: 'auth.logout', outcome });
    expect(eventLevel(e)).toBe('info');
    const r = rendered(e);
    expect(r.kind).toBe('security');
    expect(r.keys).toEqual(['ts', 'event', 'outcome', 'level', 'run', 'v']);
  });
});
