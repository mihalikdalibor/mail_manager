import { describe, it, expect, vi } from 'vitest';
import {
  IMAP_FAILURE_REASONS,
  ImapSessionError,
  type ImapFailureReason,
} from '../../src/core/imap/errors.js';
import { guardedOpenSession } from '../../src/core/imap/guarded-session.js';
import type { ImapSession, OpenSessionOptions } from '../../src/core/imap/session.js';
import { MemoryEventLog } from '../../src/core/log/index.js';
import type { EventLog, LogRecord } from '../../src/core/log/index.js';
import type { ImapSettings } from '../../src/core/providers/settings.js';
import { MemoryAttemptStore } from '../../src/core/security/attempt-store.js';
import { guardTargetKey, hmacTarget } from '../../src/core/security/events.js';
import {
  COUNTED_REASONS,
  LoginBlockedError,
  LoginGuard,
  type LoginAttempt,
} from '../../src/core/security/login-guard.js';

// M1b-4b: LoginGuard + guardedOpenSession emit imap.* / login-guard.* events through an
// EventLog (spec). Fake opener only — no network, no logins.

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const T0 = Date.UTC(2026, 8, 29, 10, 0, 0);
const IP = '203.0.113.7';
const HOST = 'imap.example-test-domain.eu';
const USERNAME = 'someone@example-test-domain.eu';
const PASSWORD = 'pw-CANARY-4b17';
const ACCT = '3f2b8c1e-5d4a-4b6f-9e21-7a8c0d1e2f34';
const SETTINGS: ImapSettings = { host: HOST, port: 993, username: USERNAME };
const ATTEMPT: LoginAttempt = { ip: IP, host: HOST, username: USERNAME };
const KEY = guardTargetKey(Buffer.alloc(32, 9));
const TARGET = hmacTarget(KEY, HOST, USERNAME);

type Opener = (o: OpenSessionOptions) => Promise<ImapSession>;

interface Harness {
  guard: LoginGuard;
  store: MemoryAttemptStore;
  log: MemoryEventLog;
  clock: { now: number };
}

function setup(log?: EventLog): Harness {
  const clock = { now: T0 };
  const memory = new MemoryEventLog({
    run: '0123456789abcdef',
    ver: '0.5.0',
    now: () => clock.now,
    level: 'debug',
  });
  const store = new MemoryAttemptStore();
  const guard = new LoginGuard({
    store,
    targetKey: KEY,
    log: log ?? memory,
    now: () => clock.now,
  });
  return { guard, store, log: memory, clock };
}

function fakeSession(): { session: ImapSession; logout: ReturnType<typeof vi.fn> } {
  const logout = vi.fn(() => Promise.resolve());
  return { session: { logout } as unknown as ImapSession, logout };
}

function options(
  h: { guard: LoginGuard },
  log: EventLog | undefined,
  open: Opener,
  extra: Partial<Parameters<typeof guardedOpenSession>[0]> = {},
): Parameters<typeof guardedOpenSession>[0] {
  return {
    settings: SETTINGS,
    password: PASSWORD,
    clientVersion: '9.9.9',
    guard: h.guard,
    clientIp: IP,
    onChallenge: () => Promise.resolve(),
    open,
    provider: 'websupport',
    acct: ACCT,
    ...(log === undefined ? {} : { log }),
    ...extra,
  };
}

async function seed(guard: LoginGuard, n: number, a: LoginAttempt = ATTEMPT): Promise<void> {
  for (let i = 0; i < n; i++) await guard.recordFailure(a, 'auth-failed');
}

/** Records emitted after `from` (seeding may already have produced block events). */
function since(log: MemoryEventLog, from: number): LogRecord[] {
  return log.records.slice(from);
}

const names = (records: LogRecord[]): string[] => records.map((r) => r.event);

function stripEnvelope(r: LogRecord | undefined): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(r ?? {}).filter(([k]) => !['ts', 'run', 'v'].includes(k)),
  );
}

describe('LoginGuard.identify', () => {
  it('returns the normalised IP bucket and the HMAC target used in events', () => {
    const { guard } = setup();
    expect(guard.identify(ATTEMPT)).toEqual({ ip: IP, target: TARGET });
  });

  it.each([
    ['::ffff:203.0.113.7', IP],
    ['2001:db8:1:2::1', '2001:db8:1:2::/64'],
    ['local', 'local'],
  ])('ip %s → bucket %s', (ip, bucket) => {
    const { guard } = setup();
    expect(guard.identify({ ...ATTEMPT, ip }).ip).toBe(bucket);
  });

  it('host/username case variants give the same target', () => {
    const { guard } = setup();
    expect(
      guard.identify({ ip: IP, host: HOST.toUpperCase(), username: USERNAME.toUpperCase() }).target,
    ).toBe(TARGET);
  });
});

describe('guardedOpenSession events', () => {
  it('success → one imap.login after recordSuccess', async () => {
    const h = setup();
    const { session } = fakeSession();
    const recordSuccess = vi.spyOn(h.guard, 'recordSuccess');
    await expect(
      guardedOpenSession(options(h, h.log, () => Promise.resolve(session))),
    ).resolves.toBe(session);
    expect(names(h.log.records)).toEqual(['imap.login']);
    expect(stripEnvelope(h.log.records[0])).toEqual({
      event: 'imap.login',
      acct: ACCT,
      provider: 'websupport',
      ip: IP,
      target: h.guard.identify(ATTEMPT).target,
      level: 'info',
    });
    expect(h.log.records[0]?.ts).toBe(new Date(T0).toISOString());
    expect(recordSuccess).toHaveBeenCalledTimes(1);
  });

  it('without acct the field is omitted; an unknown provider becomes custom', async () => {
    const h = setup();
    const { session } = fakeSession();
    const o = options(h, h.log, () => Promise.resolve(session), { provider: HOST });
    delete o.acct;
    await guardedOpenSession(o);
    const r = h.log.records[0];
    expect(r?.['provider']).toBe('custom');
    expect(Object.keys(r ?? {})).not.toContain('acct');
  });

  it('log, provider and acct never reach open()', async () => {
    const h = setup();
    const { session } = fakeSession();
    const open = vi.fn<Opener>(() => Promise.resolve(session));
    await guardedOpenSession(options(h, h.log, open));
    const passed = Object.keys(open.mock.calls[0]?.[0] ?? {});
    for (const key of ['log', 'provider', 'acct', 'guard', 'clientIp', 'onChallenge', 'open']) {
      expect(passed).not.toContain(key);
    }
    expect(passed).toContain('password');
  });

  it('without a log nothing is recorded and the login still works', async () => {
    const h = setup();
    const { session } = fakeSession();
    await expect(
      guardedOpenSession(options(h, undefined, () => Promise.resolve(session))),
    ).resolves.toBe(session);
    // The guard's own log gets no imap.* events from guardedOpenSession.
    expect(names(h.log.records).filter((n) => n.startsWith('imap.'))).toEqual([]);
  });

  it('challenge-required → login-guard.challenge BEFORE onChallenge, then imap.login', async () => {
    const h = setup();
    await seed(h.guard, 2);
    const from = h.log.records.length;
    const { session } = fakeSession();
    let seenAtChallenge: string[] = [];
    const onChallenge = vi.fn(() => {
      seenAtChallenge = names(since(h.log, from));
      return Promise.resolve();
    });
    await guardedOpenSession(options(h, h.log, () => Promise.resolve(session), { onChallenge }));
    expect(onChallenge).toHaveBeenCalledTimes(1);
    expect(seenAtChallenge).toEqual(['login-guard.challenge']);
    const got = since(h.log, from);
    expect(names(got)).toEqual(['login-guard.challenge', 'imap.login']);
    expect(stripEnvelope(got[0])).toEqual({
      event: 'login-guard.challenge',
      ip: IP,
      attempts: 2,
      target: TARGET,
      level: 'warn',
    });
  });

  it('blocked at check → imap.login-failed {blocked, counted false}, LoginBlockedError, no open', async () => {
    const h = setup();
    await seed(h.guard, 5);
    const from = h.log.records.length;
    const open = vi.fn<Opener>();
    const onChallenge = vi.fn(() => Promise.resolve());
    await expect(
      guardedOpenSession(options(h, h.log, open, { onChallenge })),
    ).rejects.toBeInstanceOf(LoginBlockedError);
    expect(open).not.toHaveBeenCalled();
    expect(onChallenge).not.toHaveBeenCalled();
    const got = since(h.log, from);
    expect(names(got)).toEqual(['imap.login-failed']);
    expect(stripEnvelope(got[0])).toEqual({
      event: 'imap.login-failed',
      acct: ACCT,
      provider: 'websupport',
      reason: 'blocked',
      counted: false,
      ip: IP,
      target: TARGET,
      level: 'warn',
    });
  });

  it('a counted failure → imap.login-failed {reason, counted true}; the error is rethrown', async () => {
    const h = setup();
    const original = new ImapSessionError('auth-failed');
    await expect(
      guardedOpenSession(options(h, h.log, () => Promise.reject(original))),
    ).rejects.toBe(original);
    expect(h.log.records.map(stripEnvelope)).toEqual([
      {
        event: 'imap.login-failed',
        acct: ACCT,
        provider: 'websupport',
        reason: 'auth-failed',
        counted: true,
        ip: IP,
        target: TARGET,
        level: 'warn',
      },
    ]);
  });

  it.each(IMAP_FAILURE_REASONS)(
    'ImapSessionError(%s) → counted = COUNTED_REASONS.has(reason)',
    async (reason: ImapFailureReason) => {
      const h = setup();
      const original = new ImapSessionError(reason);
      await expect(
        guardedOpenSession(options(h, h.log, () => Promise.reject(original))),
      ).rejects.toBe(original);
      expect(h.log.records).toHaveLength(1);
      expect(h.log.records[0]).toMatchObject({
        event: 'imap.login-failed',
        reason,
        counted: COUNTED_REASONS.has(reason),
      });
    },
  );

  it('any other error → imap.login-failed {unexpected, counted false}; rethrown as-is', async () => {
    const h = setup();
    const original = new TypeError(`odd ${PASSWORD}`);
    await expect(
      guardedOpenSession(options(h, h.log, () => Promise.reject(original))),
    ).rejects.toBe(original);
    expect(h.log.records).toHaveLength(1);
    expect(h.log.records[0]).toMatchObject({
      event: 'imap.login-failed',
      reason: 'unexpected',
      counted: false,
    });
    expect(h.log.lines.join('\n')).not.toContain(PASSWORD);
  });

  it('the locking failure: challenge, imap.login-failed, then login-guard.block', async () => {
    const h = setup();
    await seed(h.guard, 4);
    const from = h.log.records.length;
    expect(from).toBe(0);
    await expect(
      guardedOpenSession(
        options(h, h.log, () => Promise.reject(new ImapSessionError('password-expired'))),
      ),
    ).rejects.toBeInstanceOf(LoginBlockedError);
    const got = h.log.records;
    expect(names(got)).toEqual(['login-guard.challenge', 'imap.login-failed', 'login-guard.block']);
    expect(got[0]?.['attempts']).toBe(4);
    expect(got[1]).toMatchObject({ reason: 'password-expired', counted: true });
    expect(stripEnvelope(got[2])).toEqual({
      event: 'login-guard.block',
      kind: 'too-many-attempts',
      reason: 'password-expired',
      ip: IP,
      addr: IP,
      attempts: 5,
      until: new Date(T0 + 15 * MIN).toISOString(),
      target: TARGET,
      level: 'warn',
    });
    expect(got[2]?.ts).toBe(new Date(T0).toISOString());
  });

  it('recordSuccess throws → session logged out, error propagates, no imap.login', async () => {
    const h = setup();
    const { session, logout } = fakeSession();
    const down = new Error('store down');
    vi.spyOn(h.guard, 'recordSuccess').mockRejectedValue(down);
    await expect(
      guardedOpenSession(options(h, h.log, () => Promise.resolve(session))),
    ).rejects.toBe(down);
    expect(logout).toHaveBeenCalledTimes(1);
    expect(names(h.log.records)).not.toContain('imap.login');
    expect(h.log.records).toEqual([]);
  });

  it('check throws → error propagates, no event', async () => {
    const h = setup();
    const down = new Error('store down');
    vi.spyOn(h.guard, 'check').mockRejectedValue(down);
    const open = vi.fn<Opener>();
    await expect(guardedOpenSession(options(h, h.log, open))).rejects.toBe(down);
    expect(open).not.toHaveBeenCalled();
    expect(h.log.records).toEqual([]);
  });

  it('onChallenge rejects → only the challenge event, error propagates, no open', async () => {
    const h = setup();
    await seed(h.guard, 2);
    const cancelled = new Error('cancelled');
    const open = vi.fn<Opener>();
    await expect(
      guardedOpenSession(options(h, h.log, open, { onChallenge: () => Promise.reject(cancelled) })),
    ).rejects.toBe(cancelled);
    expect(open).not.toHaveBeenCalled();
    expect(names(h.log.records)).toEqual(['login-guard.challenge']);
  });

  it('recordFailure throws → imap.login-failed (emitted before it), then that error, nothing more', async () => {
    const h = setup();
    const down = new Error('store down');
    vi.spyOn(h.guard, 'recordFailure').mockRejectedValue(down);
    await expect(
      guardedOpenSession(
        options(h, h.log, () => Promise.reject(new ImapSessionError('auth-failed'))),
      ),
    ).rejects.toBe(down);
    expect(names(h.log.records)).toEqual(['imap.login-failed']);
  });
});

describe('challenge attempts', () => {
  async function challengeAttempts(h: Harness, ip = IP): Promise<unknown> {
    const from = h.log.records.length;
    const { session } = fakeSession();
    await guardedOpenSession(options(h, h.log, () => Promise.resolve(session), { clientIp: ip }));
    const challenge = since(h.log, from).find((r) => r.event === 'login-guard.challenge');
    expect(challenge).toBeDefined();
    return challenge?.['attempts'];
  }

  it('pair rule → the pair failure count in the window', async () => {
    const h = setup();
    await seed(h.guard, 3);
    expect(await challengeAttempts(h)).toBe(3);
  });

  it('only the mailbox-wide rule → the mailbox failure count', async () => {
    const h = setup();
    await seed(h.guard, 1);
    for (let i = 1; i <= 9; i++) await seed(h.guard, 1, { ...ATTEMPT, ip: `10.0.0.${i}` });
    expect(await challengeAttempts(h)).toBe(10);
  });

  it('mailbox-wide rule from a fresh IP → the mailbox failure count', async () => {
    const h = setup();
    for (let i = 1; i <= 12; i++) await seed(h.guard, 1, { ...ATTEMPT, ip: `10.0.0.${i}` });
    expect(await challengeAttempts(h, '198.51.100.9')).toBe(12);
  });

  it('only lockout history → the pair count, 0 right after the lock expires', async () => {
    const h = setup();
    await seed(h.guard, 5);
    h.clock.now = T0 + 15 * MIN;
    expect(await challengeAttempts(h)).toBe(0);
  });

  it('only lockout history with one new failure → 1', async () => {
    const h = setup();
    await seed(h.guard, 5);
    h.clock.now = T0 + 15 * MIN;
    await seed(h.guard, 1);
    expect(await challengeAttempts(h)).toBe(1);
  });
});

describe('LoginGuard block events through the log', () => {
  const mailbox = (name: string): LoginAttempt => ({
    ip: IP,
    host: HOST,
    username: `${name}@example-test-domain.eu`,
  });

  it('too-many-attempts, ip-blocked (warn) and permanent (error), ts from the log clock', async () => {
    const h = setup();
    for (const round of [0, 1, 2]) {
      h.clock.now = T0 + round * DAY;
      for (const n of ['a', 'b', 'c']) await seed(h.guard, 5, mailbox(n));
    }
    const blocks = h.log.records.filter((r) => r.event === 'login-guard.block');
    expect(blocks.map((r) => r['kind'])).toEqual([
      ...Array<string>(3).fill('too-many-attempts'),
      'ip-blocked',
      ...Array<string>(3).fill('too-many-attempts'),
      'ip-blocked',
      ...Array<string>(3).fill('too-many-attempts'),
      'ip-blocked',
      'permanent',
    ]);
    expect(h.log.records.every((r) => r.event === 'login-guard.block')).toBe(true);
    for (const r of blocks) expect(r.level).toBe(r['kind'] === 'permanent' ? 'error' : 'warn');
    expect(stripEnvelope(blocks[3])).toEqual({
      event: 'login-guard.block',
      kind: 'ip-blocked',
      reason: 'auth-failed',
      ip: IP,
      addr: IP,
      attempts: 3,
      until: new Date(T0 + DAY).toISOString(),
      target: h.guard.identify(mailbox('c')).target,
      level: 'warn',
    });
    const permanent = blocks[12];
    expect(permanent?.ts).toBe(new Date(T0 + 2 * DAY).toISOString());
    expect(permanent?.['until']).toBeNull();
    expect(h.log.lines.every((l) => l.startsWith('mm-security {'))).toBe(true);
  });
});

describe('a throwing EventLog never changes the flow', () => {
  const broken: EventLog = {
    emit: () => {
      throw new Error('disk full');
    },
  };

  type Scenario = (h: Harness, log: EventLog) => Promise<unknown>;

  const scenarios: [string, Scenario][] = [
    [
      'success',
      (h, log) => guardedOpenSession(options(h, log, () => Promise.resolve(fakeSession().session))),
    ],
    [
      'challenge then success',
      async (h, log) => {
        await seed(h.guard, 2);
        return guardedOpenSession(options(h, log, () => Promise.resolve(fakeSession().session)));
      },
    ],
    [
      'counted failure',
      (h, log) =>
        guardedOpenSession(
          options(h, log, () => Promise.reject(new ImapSessionError('auth-failed'))),
        ),
    ],
    [
      'locking failure',
      async (h, log) => {
        await seed(h.guard, 4);
        return guardedOpenSession(
          options(h, log, () => Promise.reject(new ImapSessionError('auth-failed'))),
        );
      },
    ],
    [
      'blocked at check',
      async (h, log) => {
        await seed(h.guard, 5);
        return guardedOpenSession(options(h, log, vi.fn<Opener>()));
      },
    ],
    [
      'unexpected error',
      (h, log) => guardedOpenSession(options(h, log, () => Promise.reject(new TypeError('x')))),
    ],
  ];

  function describeOutcome(r: PromiseSettledResult<unknown>): unknown {
    if (r.status === 'fulfilled') return { ok: typeof r.value };
    const e: unknown = r.reason;
    if (e instanceof LoginBlockedError) return { blocked: e.kind, until: e.until?.getTime() };
    if (e instanceof ImapSessionError) return { imap: e.reason };
    return { other: (e as Error).name };
  }

  it.each(scenarios)('%s: same result with a broken log', async (_name, run) => {
    const good = setup();
    const bad = setup(broken);
    const [a, b] = await Promise.allSettled([run(good, good.log), run(bad, broken)]);
    expect(a).toBeDefined();
    expect(describeOutcome(b)).toEqual(describeOutcome(a));
    expect(await bad.guard.check(ATTEMPT)).toEqual(await good.guard.check(ATTEMPT));
  });

  it('the guard with a broken log still escalates to permanent', async () => {
    const h = setup(broken);
    for (const round of [0, 1, 2]) {
      h.clock.now = T0 + round * DAY;
      for (const n of ['a', 'b', 'c']) {
        await seed(h.guard, 5, { ...ATTEMPT, username: `${n}@example-test-domain.eu` });
      }
    }
    expect(await h.guard.check(ATTEMPT)).toEqual({
      kind: 'blocked',
      block: 'permanent',
      until: null,
    });
  });
});

describe('canary: no host, username or password in any line', () => {
  it('success, failures, lock, blocked and challenge paths', async () => {
    const h = setup();
    const host = 'imap.secret-host.example';
    const username = 'canary@secret-domain.example';
    const password = 'hunter2-ÄŠť';
    const settings: ImapSettings = { host, port: 993, username };
    const attempt: LoginAttempt = { ip: IP, host, username };
    const run = (open: Opener): Promise<unknown> =>
      guardedOpenSession({ ...options(h, h.log, open), settings, password }).catch(
        (e: unknown) => e,
      );
    await run(() => Promise.resolve(fakeSession().session));
    await run(() => Promise.reject(new ImapSessionError('auth-failed', `NO ${username}`)));
    await run(() => Promise.reject(new Error(`${host} ${password}`)));
    for (let i = 0; i < 4; i++) {
      await run(() => Promise.reject(new ImapSessionError('auth-failed')));
    }
    await run(() => Promise.resolve(fakeSession().session));
    expect(await h.guard.check(attempt)).toMatchObject({ kind: 'blocked' });

    const text = h.log.lines.join('\n');
    expect(names(h.log.records)).toEqual(
      expect.arrayContaining([
        'imap.login',
        'imap.login-failed',
        'login-guard.challenge',
        'login-guard.block',
      ]),
    );
    for (const needle of [host, username, password, 'secret', 'canary', 'hunter2']) {
      expect(text).not.toContain(needle);
    }
  });
});
