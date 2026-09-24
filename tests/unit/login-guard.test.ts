import { describe, it, expect } from 'vitest';
import { IMAP_FAILURE_REASONS, type ImapFailureReason } from '../../src/core/imap/errors.js';
import { MemoryAttemptStore } from '../../src/core/security/attempt-store.js';
import {
  MemoryEventSink,
  guardTargetKey,
  hmacTarget,
  type SecurityEvent,
} from '../../src/core/security/events.js';
import {
  COUNTED_REASONS,
  LOGIN_POLICY,
  LoginBlockedError,
  LoginGuard,
  type GuardDecision,
  type LoginAttempt,
  type LoginPolicy,
} from '../../src/core/security/login-guard.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 8, 22, 10, 0, 0);

const IP = '203.0.113.7';
const OTHER_IP = '198.51.100.9';
const HOST = 'imap.example-test-domain.eu';

const ALLOW: GuardDecision = { kind: 'allow' };
const CHALLENGE: GuardDecision = { kind: 'challenge-required' };

const COUNTED: ImapFailureReason[] = [
  'auth-failed',
  'app-password-required',
  'password-expired',
  'contact-admin',
  'server-rejected',
];
const UNCOUNTED = IMAP_FAILURE_REASONS.filter((r) => !COUNTED.includes(r));

function mailbox(name: string, ip = IP): LoginAttempt {
  return { ip, host: HOST, username: `${name}@example-test-domain.eu` };
}

function blocked(block: 'too-many-attempts' | 'ip-blocked', until: number): GuardDecision {
  return { kind: 'blocked', block, until: new Date(until) };
}

const PERMANENT: GuardDecision = { kind: 'blocked', block: 'permanent', until: null };

function setup(policy?: LoginPolicy): {
  store: MemoryAttemptStore;
  sink: MemoryEventSink;
  targetKey: Buffer;
  clock: { now: number };
  guard: LoginGuard;
} {
  const store = new MemoryAttemptStore();
  const sink = new MemoryEventSink();
  const targetKey = guardTargetKey(Buffer.alloc(32, 7));
  const clock = { now: T0 };
  const guard = new LoginGuard({
    store,
    targetKey,
    sink,
    now: () => clock.now,
    ...(policy === undefined ? {} : { policy }),
  });
  return { store, sink, targetKey, clock, guard };
}

async function fail(
  guard: LoginGuard,
  a: LoginAttempt,
  times: number,
  reason: ImapFailureReason = 'auth-failed',
): Promise<GuardDecision> {
  let decision: GuardDecision = ALLOW;
  for (let i = 0; i < times; i++) decision = await guard.recordFailure(a, reason);
  return decision;
}

const lockOut = (guard: LoginGuard, a: LoginAttempt): Promise<GuardDecision> => fail(guard, a, 5);

function kinds(events: readonly SecurityEvent[]): string[] {
  return events.map((e) => e.kind);
}

describe('LOGIN_POLICY and COUNTED_REASONS', () => {
  it('has the documented values', () => {
    expect(LOGIN_POLICY).toEqual({
      pairChallengeAfter: 2,
      pairLockAfter: 5,
      pairWindowMs: 15 * MIN,
      pairLockMs: 15 * MIN,
      pairLockoutChallengeMs: 24 * HOUR,
      mailboxChallengeAfter: 10,
      mailboxWindowMs: 15 * MIN,
      ipLockoutsForBlock: 3,
      ipLockoutWindowMs: 24 * HOUR,
      ipBlockMs: 24 * HOUR,
      ipBlocksForPermanent: 3,
      ipBlockWindowMs: 30 * DAY,
    });
  });

  it('counts exactly the credential-related reasons', () => {
    expect([...COUNTED_REASONS].sort()).toEqual([...COUNTED].sort());
  });
});

describe('MemoryAttemptStore', () => {
  it('returns empty defaults for unknown keys', async () => {
    const store = new MemoryAttemptStore();
    expect(await store.getTimes('k')).toEqual([]);
    expect(await store.getUntil('k')).toBeNull();
    expect(await store.getFlag('k')).toBe(false);
    expect(store.keys()).toEqual([]);
  });

  it('stores and returns values', async () => {
    const store = new MemoryAttemptStore();
    await store.setTimes('t', [1, 2, 3]);
    await store.setUntil('u', 42);
    await store.setFlag('f', true);
    expect(await store.getTimes('t')).toEqual([1, 2, 3]);
    expect(await store.getUntil('u')).toBe(42);
    expect(await store.getFlag('f')).toBe(true);
    expect(store.keys().sort()).toEqual(['f', 't', 'u']);
  });

  it('empty times / null until / false flag delete the entry', async () => {
    const store = new MemoryAttemptStore();
    await store.setTimes('t', [1]);
    await store.setUntil('u', 42);
    await store.setFlag('f', true);
    await store.setTimes('t', []);
    await store.setUntil('u', null);
    await store.setFlag('f', false);
    expect(store.keys()).toEqual([]);
    expect(await store.getTimes('t')).toEqual([]);
    expect(await store.getUntil('u')).toBeNull();
    expect(await store.getFlag('f')).toBe(false);
  });
});

describe('LoginBlockedError', () => {
  it('carries kind and until, and serializes safely', () => {
    const until = new Date(T0 + DAY);
    const err = new LoginBlockedError('ip-blocked', until);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('LoginBlockedError');
    expect(err.kind).toBe('ip-blocked');
    expect(err.until).toEqual(until);
    expect(err.toJSON()).toEqual({
      name: 'LoginBlockedError',
      kind: 'ip-blocked',
      until: until.toISOString(),
    });
    expect(JSON.parse(JSON.stringify(err))).toEqual(err.toJSON());
  });

  it('permanent has until null', () => {
    const err = new LoginBlockedError('permanent', null);
    expect(err.until).toBeNull();
    expect(err.toJSON()).toEqual({ name: 'LoginBlockedError', kind: 'permanent', until: null });
  });

  it('message names no address or host', () => {
    const err = new LoginBlockedError('too-many-attempts', new Date(T0));
    expect(err.message).not.toMatch(/@|example|imap\./i);
  });
});

describe('LoginGuard — pair (ip + mailbox)', () => {
  it('a fresh pair is allowed', async () => {
    const { guard } = setup();
    expect(await guard.check(mailbox('a'))).toEqual(ALLOW);
  });

  it('1 failure → allow; 2 failures → challenge-required', async () => {
    const { guard } = setup();
    expect(await fail(guard, mailbox('a'), 1)).toEqual(ALLOW);
    expect(await guard.check(mailbox('a'))).toEqual(ALLOW);
    expect(await fail(guard, mailbox('a'), 1)).toEqual(CHALLENGE);
    expect(await guard.check(mailbox('a'))).toEqual(CHALLENGE);
  });

  it('4 failures → still only challenge; the 5th locks the pair for 15 minutes', async () => {
    const { guard } = setup();
    expect(await fail(guard, mailbox('a'), 4)).toEqual(CHALLENGE);
    expect(await fail(guard, mailbox('a'), 1)).toEqual(blocked('too-many-attempts', T0 + 15 * MIN));
    expect(await guard.check(mailbox('a'))).toEqual(blocked('too-many-attempts', T0 + 15 * MIN));
  });

  it('the lock emits one too-many-attempts event without plain host/username', async () => {
    const { guard, sink, targetKey } = setup();
    await fail(guard, mailbox('a'), 4);
    expect(sink.events).toEqual([]);
    await fail(guard, mailbox('a'), 1, 'password-expired');
    expect(sink.events).toEqual([
      {
        ts: new Date(T0).toISOString(),
        event: 'login-guard.block',
        kind: 'too-many-attempts',
        reason: 'password-expired',
        ip: IP,
        addr: IP,
        attempts: 5,
        until: new Date(T0 + 15 * MIN).toISOString(),
        target: hmacTarget(targetKey, HOST, 'a@example-test-domain.eu'),
      },
    ]);
  });

  it('lock boundaries: active until `until`, then challenge for 24h after the lockout, then allow', async () => {
    const { guard, clock } = setup();
    await lockOut(guard, mailbox('a'));
    clock.now = T0 + 15 * MIN - 1;
    expect(await guard.check(mailbox('a'))).toEqual(blocked('too-many-attempts', T0 + 15 * MIN));
    clock.now = T0 + 15 * MIN;
    expect(await guard.check(mailbox('a'))).toEqual(CHALLENGE);
    clock.now = T0 + DAY - 1;
    expect(await guard.check(mailbox('a'))).toEqual(CHALLENGE);
    clock.now = T0 + DAY;
    expect(await guard.check(mailbox('a'))).toEqual(ALLOW);
  });

  it('the lock clears the pair failures: after it expires it takes 5 new failures to lock again', async () => {
    const { guard, clock } = setup();
    await lockOut(guard, mailbox('a'));
    clock.now = T0 + 15 * MIN;
    expect(await fail(guard, mailbox('a'), 4)).toEqual(CHALLENGE);
    expect(await fail(guard, mailbox('a'), 1)).toEqual(blocked('too-many-attempts', T0 + 30 * MIN));
  });

  it('pair failures slide out of the 15-minute window (exactly 15 minutes old no longer counts)', async () => {
    const a = setup();
    await fail(a.guard, mailbox('a'), 1);
    a.clock.now = T0 + 15 * MIN - 1;
    expect(await fail(a.guard, mailbox('a'), 1)).toEqual(CHALLENGE);

    const b = setup();
    await fail(b.guard, mailbox('a'), 1);
    b.clock.now = T0 + 15 * MIN;
    expect(await fail(b.guard, mailbox('a'), 1)).toEqual(ALLOW);
  });

  it('5 failures spread over more than 15 minutes do not lock', async () => {
    const { guard, clock, sink } = setup();
    await fail(guard, mailbox('a'), 4);
    clock.now = T0 + 15 * MIN;
    expect(await fail(guard, mailbox('a'), 1)).toEqual(ALLOW);
    expect(sink.events).toEqual([]);
  });

  it.each(COUNTED)('reason %s is counted', async (reason) => {
    const { guard } = setup();
    expect(await fail(guard, mailbox('a'), 5, reason)).toEqual(
      blocked('too-many-attempts', T0 + 15 * MIN),
    );
  });

  it.each(UNCOUNTED)('reason %s is not counted and records nothing', async (reason) => {
    const { guard, store, sink } = setup();
    expect(await fail(guard, mailbox('a'), 12, reason)).toEqual(ALLOW);
    expect(await guard.check(mailbox('a'))).toEqual(ALLOW);
    expect(await guard.check(mailbox('a', OTHER_IP))).toEqual(ALLOW);
    expect(store.keys()).toEqual([]);
    expect(sink.events).toEqual([]);
  });

  it('an uncounted failure still returns the current decision', async () => {
    const { guard } = setup();
    await lockOut(guard, mailbox('a'));
    expect(await guard.recordFailure(mailbox('a'), 'timeout')).toEqual(
      blocked('too-many-attempts', T0 + 15 * MIN),
    );
  });

  it('different mailboxes on the same IP have separate pair counters', async () => {
    const { guard } = setup();
    await lockOut(guard, mailbox('a'));
    expect(await guard.check(mailbox('b'))).toEqual(ALLOW);
  });

  it('the same mailbox from another IP is not locked', async () => {
    const { guard } = setup();
    await lockOut(guard, mailbox('a'));
    expect(await guard.check(mailbox('a', OTHER_IP))).toEqual(ALLOW);
  });

  it('host and username are compared case-insensitively (and host trailing dot ignored)', async () => {
    const { guard } = setup();
    await fail(
      guard,
      { ip: IP, host: 'IMAP.Example-Test-Domain.EU.', username: 'A@Example-Test-Domain.eu' },
      1,
    );
    expect(await fail(guard, mailbox('a'), 1)).toEqual(CHALLENGE);
  });

  it('an IPv4-mapped IPv6 address shares counters with the IPv4 address', async () => {
    const { guard, sink } = setup();
    await fail(guard, mailbox('a', '::ffff:203.0.113.7'), 2);
    await fail(guard, mailbox('a', '::FFFF:203.0.113.7'), 2);
    expect(await guard.check(mailbox('a'))).toEqual(CHALLENGE);
    expect(await fail(guard, mailbox('a'), 1)).toEqual(blocked('too-many-attempts', T0 + 15 * MIN));
    expect(sink.events[0]?.ip).toBe(IP);
  });

  it('IPv6 addresses in the same /64 share counters; the event names the /64', async () => {
    const { guard, sink } = setup();
    await fail(guard, mailbox('a', '2001:db8:1:2::1'), 3);
    await fail(guard, mailbox('a', '2001:db8:1:2:ffff::9'), 2);
    expect(await guard.check(mailbox('a', '2001:db8:1:2::77'))).toEqual(
      blocked('too-many-attempts', T0 + 15 * MIN),
    );
    expect(await guard.check(mailbox('a', '2001:db8:1:3::1'))).toEqual(ALLOW);
    expect(sink.events[0]?.ip).toBe('2001:db8:1:2::/64');
  });
});

describe('LoginGuard — mailbox (all IPs)', () => {
  it('10 failures across IPs → challenge for any IP; 9 → allow', async () => {
    const nine = setup();
    for (let i = 1; i <= 9; i++) await fail(nine.guard, mailbox('a', `10.0.0.${i}`), 1);
    expect(await nine.guard.check(mailbox('a', '10.0.1.1'))).toEqual(ALLOW);

    const ten = setup();
    for (let i = 1; i <= 10; i++) await fail(ten.guard, mailbox('a', `10.0.0.${i}`), 1);
    expect(await ten.guard.check(mailbox('a', '10.0.1.1'))).toEqual(CHALLENGE);
    expect(await ten.guard.check(mailbox('b', '10.0.1.1'))).toEqual(ALLOW);
  });

  it('never locks, however many failures', async () => {
    const { guard, sink } = setup();
    for (let i = 1; i <= 40; i++) await fail(guard, mailbox('a', `10.0.0.${i}`), 1);
    expect(await guard.check(mailbox('a', '10.0.1.1'))).toEqual(CHALLENGE);
    expect(sink.events).toEqual([]);
  });

  it('mailbox failures slide out of the 15-minute window', async () => {
    const { guard, clock } = setup();
    for (let i = 1; i <= 10; i++) await fail(guard, mailbox('a', `10.0.0.${i}`), 1);
    clock.now = T0 + 15 * MIN - 1;
    expect(await guard.check(mailbox('a', '10.0.1.1'))).toEqual(CHALLENGE);
    clock.now = T0 + 15 * MIN;
    expect(await guard.check(mailbox('a', '10.0.1.1'))).toEqual(ALLOW);
  });
});

describe('LoginGuard — recordSuccess', () => {
  it('clears the pair failures', async () => {
    const { guard } = setup();
    await fail(guard, mailbox('a'), 2);
    await guard.recordSuccess(mailbox('a'));
    expect(await guard.check(mailbox('a'))).toEqual(ALLOW);
    expect(await fail(guard, mailbox('a'), 4)).toEqual(CHALLENGE);
  });

  it('keeps the pair lockout history (24h challenge)', async () => {
    const { guard, clock } = setup();
    await lockOut(guard, mailbox('a'));
    clock.now = T0 + 15 * MIN;
    await guard.recordSuccess(mailbox('a'));
    expect(await guard.check(mailbox('a'))).toEqual(CHALLENGE);
  });

  it('keeps IP lockouts: a third lockout after successes still blocks the IP', async () => {
    const { guard, clock } = setup();
    await lockOut(guard, mailbox('a'));
    await lockOut(guard, mailbox('b'));
    clock.now = T0 + 15 * MIN;
    await guard.recordSuccess(mailbox('a'));
    await guard.recordSuccess(mailbox('b'));
    expect(await lockOut(guard, mailbox('c'))).toEqual(blocked('ip-blocked', T0 + 15 * MIN + DAY));
  });

  it('does not lift an IP block or a permanent block', async () => {
    const { guard, clock } = setup();
    await lockOut(guard, mailbox('a'));
    await lockOut(guard, mailbox('b'));
    await lockOut(guard, mailbox('c'));
    await guard.recordSuccess(mailbox('d'));
    expect(await guard.check(mailbox('d'))).toEqual(blocked('ip-blocked', T0 + DAY));

    for (const round of [1, 2]) {
      clock.now = T0 + round * DAY;
      await lockOut(guard, mailbox('a'));
      await lockOut(guard, mailbox('b'));
      await lockOut(guard, mailbox('c'));
    }
    await guard.recordSuccess(mailbox('d'));
    expect(await guard.check(mailbox('d'))).toEqual(PERMANENT);
  });
});

describe('LoginGuard — IP escalation', () => {
  it('3 lockouts within 24h block the IP for 24h, then 3 blocks within 30 days → permanent', async () => {
    const { guard, clock, sink, targetKey } = setup();

    // Round 1: three mailboxes × 5 failures from one IP.
    expect(await lockOut(guard, mailbox('a'))).toEqual(blocked('too-many-attempts', T0 + 15 * MIN));
    expect(await lockOut(guard, mailbox('b'))).toEqual(blocked('too-many-attempts', T0 + 15 * MIN));
    expect(await lockOut(guard, mailbox('c'))).toEqual(blocked('ip-blocked', T0 + DAY));
    expect(kinds(sink.events)).toEqual([
      'too-many-attempts',
      'too-many-attempts',
      'too-many-attempts',
      'ip-blocked',
    ]);
    expect(sink.events[3]).toEqual({
      ts: new Date(T0).toISOString(),
      event: 'login-guard.block',
      kind: 'ip-blocked',
      reason: 'auth-failed',
      ip: IP,
      addr: IP,
      attempts: 3,
      until: new Date(T0 + DAY).toISOString(),
      target: hmacTarget(targetKey, HOST, 'c@example-test-domain.eu'),
    });

    // Every mailbox from that IP is blocked (ip block wins over the pair lock); another IP is not.
    expect(await guard.check(mailbox('a'))).toEqual(blocked('ip-blocked', T0 + DAY));
    expect(await guard.check(mailbox('zzz'))).toEqual(blocked('ip-blocked', T0 + DAY));
    expect(await guard.check(mailbox('a', OTHER_IP))).toEqual(ALLOW);
    expect(await guard.check(mailbox('zzz', OTHER_IP))).toEqual(ALLOW);

    clock.now = T0 + DAY - 1;
    expect(await guard.check(mailbox('zzz'))).toEqual(blocked('ip-blocked', T0 + DAY));
    clock.now = T0 + DAY;
    expect(await guard.check(mailbox('a'))).toEqual(ALLOW);
    expect(await guard.check(mailbox('zzz'))).toEqual(ALLOW);

    // Round 2 (IP lockouts were cleared by the block, so it again takes three).
    await lockOut(guard, mailbox('a'));
    expect(await guard.check(mailbox('zzz'))).toEqual(ALLOW);
    await lockOut(guard, mailbox('b'));
    expect(await lockOut(guard, mailbox('c'))).toEqual(blocked('ip-blocked', T0 + 2 * DAY));

    // Round 3 → permanent.
    clock.now = T0 + 2 * DAY;
    await lockOut(guard, mailbox('a'));
    await lockOut(guard, mailbox('b'));
    expect(await lockOut(guard, mailbox('c'))).toEqual(PERMANENT);
    expect(kinds(sink.events)).toEqual([
      ...Array<string>(3).fill('too-many-attempts'),
      'ip-blocked',
      ...Array<string>(3).fill('too-many-attempts'),
      'ip-blocked',
      ...Array<string>(3).fill('too-many-attempts'),
      'ip-blocked',
      'permanent',
    ]);
    expect(sink.events[12]).toEqual({
      ts: new Date(T0 + 2 * DAY).toISOString(),
      event: 'login-guard.block',
      kind: 'permanent',
      reason: 'auth-failed',
      ip: IP,
      addr: IP,
      attempts: 3,
      until: null,
      target: hmacTarget(targetKey, HOST, 'c@example-test-domain.eu'),
    });

    expect(await guard.check(mailbox('zzz'))).toEqual(PERMANENT);
    expect(await guard.check(mailbox('a', OTHER_IP))).toEqual(ALLOW);
    clock.now = T0 + 2 * DAY + 365 * DAY;
    expect(await guard.check(mailbox('zzz'))).toEqual(PERMANENT);
    expect(await guard.check(mailbox('zzz', '::ffff:203.0.113.7'))).toEqual(PERMANENT);
  });

  it('IP lockouts slide out of the 24h window', async () => {
    const early = setup();
    await lockOut(early.guard, mailbox('a'));
    await lockOut(early.guard, mailbox('b'));
    early.clock.now = T0 + DAY - 1;
    expect(await lockOut(early.guard, mailbox('c'))).toEqual(
      blocked('ip-blocked', T0 + 2 * DAY - 1),
    );

    const late = setup();
    await lockOut(late.guard, mailbox('a'));
    await lockOut(late.guard, mailbox('b'));
    late.clock.now = T0 + DAY;
    expect(await lockOut(late.guard, mailbox('c'))).toEqual(
      blocked('too-many-attempts', T0 + DAY + 15 * MIN),
    );
    expect(kinds(late.sink.events)).not.toContain('ip-blocked');
  });

  it('IP blocks slide out of the 30-day window', async () => {
    async function blockAt(g: ReturnType<typeof setup>, at: number): Promise<GuardDecision> {
      g.clock.now = at;
      await lockOut(g.guard, mailbox('a'));
      await lockOut(g.guard, mailbox('b'));
      return lockOut(g.guard, mailbox('c'));
    }

    const inside = setup();
    await blockAt(inside, T0);
    await blockAt(inside, T0 + DAY);
    expect(await blockAt(inside, T0 + 30 * DAY - 1)).toEqual(PERMANENT);

    const outside = setup();
    await blockAt(outside, T0);
    await blockAt(outside, T0 + DAY);
    expect(await blockAt(outside, T0 + 30 * DAY)).toEqual(blocked('ip-blocked', T0 + 31 * DAY));
    expect(kinds(outside.sink.events)).not.toContain('permanent');
  });

  it('honours an injected policy', async () => {
    const policy: LoginPolicy = {
      ...LOGIN_POLICY,
      pairChallengeAfter: 1,
      pairLockAfter: 2,
      pairLockMs: MIN,
    };
    const { guard } = setup(policy);
    expect(await fail(guard, mailbox('a'), 1)).toEqual(CHALLENGE);
    expect(await fail(guard, mailbox('a'), 1)).toEqual(blocked('too-many-attempts', T0 + MIN));
  });
});

describe('LoginGuard — privacy', () => {
  it('store keys and events never contain the plain host or username', async () => {
    const { guard, store, sink, clock } = setup();
    const canary = (n: number): LoginAttempt => ({
      ip: IP,
      host: 'canary-host.example',
      username: `canary-user${n === 0 ? '' : String(n)}@example.com`,
    });
    await fail(guard, canary(0), 2);
    await guard.recordSuccess(canary(0));
    for (const round of [0, 1, 2]) {
      clock.now = T0 + round * DAY;
      for (const n of [0, 1, 2]) await lockOut(guard, canary(n));
    }
    expect(await guard.check(canary(0))).toEqual(PERMANENT);
    await fail(guard, { ...canary(0), ip: OTHER_IP }, 3);

    expect(store.keys().length).toBeGreaterThan(0);
    for (const key of store.keys()) expect(key.toLowerCase()).not.toContain('canary');
    const events = JSON.stringify(sink.events);
    expect(sink.events.length).toBeGreaterThan(0);
    expect(events).not.toContain('canary');
    expect(events).not.toContain('example.com');
  });
});

describe('LoginGuard.withPairLock', () => {
  interface Deferred {
    promise: Promise<void>;
    resolve: () => void;
    reject: (err: Error) => void;
  }

  function deferred(): Deferred {
    let resolve!: () => void;
    let reject!: (err: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

  it('returns the value of fn', async () => {
    const { guard } = setup();
    expect(await guard.withPairLock(mailbox('a'), () => Promise.resolve(42))).toBe(42);
  });

  it('runs calls for the same pair one after another', async () => {
    const { guard } = setup();
    const log: string[] = [];
    const d1 = deferred();
    const p1 = guard.withPairLock(mailbox('a'), async () => {
      log.push('1 start');
      await d1.promise;
      log.push('1 end');
    });
    const p2 = guard.withPairLock(mailbox('a'), () => {
      log.push('2 start');
      return Promise.resolve();
    });
    await tick();
    await tick();
    expect(log).toEqual(['1 start']);
    d1.resolve();
    await Promise.all([p1, p2]);
    expect(log).toEqual(['1 start', '1 end', '2 start']);
  });

  it('the next call still runs after the previous one rejects', async () => {
    const { guard } = setup();
    const log: string[] = [];
    const d1 = deferred();
    const boom = new Error('boom');
    const p1 = guard.withPairLock(mailbox('a'), async () => {
      log.push('1 start');
      await d1.promise;
    });
    const p2 = guard.withPairLock(mailbox('a'), () => {
      log.push('2 start');
      return Promise.resolve('ok');
    });
    await tick();
    await tick();
    expect(log).toEqual(['1 start']);
    d1.reject(boom);
    await expect(p1).rejects.toBe(boom);
    expect(await p2).toBe('ok');
    expect(log).toEqual(['1 start', '2 start']);
  });

  it('a synchronous throw in fn rejects and releases the lock', async () => {
    const { guard } = setup();
    const boom = new Error('boom');
    await expect(
      guard.withPairLock(mailbox('a'), () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(await guard.withPairLock(mailbox('a'), () => Promise.resolve(1))).toBe(1);
  });

  it('equivalent pairs (mapped IPv4, host/username case) share the lock', async () => {
    const { guard } = setup();
    const log: string[] = [];
    const d1 = deferred();
    const p1 = guard.withPairLock(mailbox('a'), async () => {
      log.push('1 start');
      await d1.promise;
    });
    const p2 = guard.withPairLock(
      { ip: '::ffff:203.0.113.7', host: HOST.toUpperCase(), username: 'A@EXAMPLE-TEST-DOMAIN.EU' },
      () => {
        log.push('2 start');
        return Promise.resolve();
      },
    );
    await tick();
    await tick();
    expect(log).toEqual(['1 start']);
    d1.resolve();
    await Promise.all([p1, p2]);
    expect(log).toEqual(['1 start', '2 start']);
  });

  it('different pairs run concurrently', async () => {
    const { guard } = setup();
    const log: string[] = [];
    const d1 = deferred();
    const d2 = deferred();
    const p1 = guard.withPairLock(mailbox('a'), async () => {
      log.push('a');
      await d1.promise;
    });
    const p2 = guard.withPairLock(mailbox('b'), async () => {
      log.push('b');
      await d2.promise;
    });
    const p3 = guard.withPairLock(mailbox('a', OTHER_IP), async () => {
      log.push('a other ip');
      await d2.promise;
    });
    await tick();
    await tick();
    expect(log.sort()).toEqual(['a', 'a other ip', 'b']);
    d1.resolve();
    d2.resolve();
    await Promise.all([p1, p2, p3]);
  });
});

describe('LoginGuard: parallel attempts on different pairs (shared counters)', () => {
  it('3 pairs from one IP locked in parallel still block the IP', async () => {
    const { guard, sink } = setup();
    await Promise.all(
      ['a', 'b', 'c'].flatMap((name) =>
        Array.from({ length: 5 }, () => guard.recordFailure(mailbox(name), 'auth-failed')),
      ),
    );
    expect(sink.events.map((e) => e.kind)).toEqual([
      'too-many-attempts',
      'too-many-attempts',
      'too-many-attempts',
      'ip-blocked',
    ]);
    expect(await guard.check(mailbox('zzz'))).toEqual(blocked('ip-blocked', T0 + DAY));
  });

  it('10 failures on one mailbox from 10 IPs in parallel all count → challenge', async () => {
    const { guard } = setup();
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        guard.recordFailure(mailbox('shared', `192.0.2.${i + 1}`), 'auth-failed'),
      ),
    );
    expect(await guard.check(mailbox('shared', '198.51.100.200'))).toEqual(CHALLENGE);
  });
});
