import { describe, it, expect, vi } from 'vitest';
import { ImapSessionError, type ImapFailureReason } from '../../src/core/imap/errors.js';
import { guardedOpenSession } from '../../src/core/imap/guarded-session.js';
import type { ImapSession, OpenSessionOptions } from '../../src/core/imap/session.js';
import type { ImapSettings } from '../../src/core/providers/settings.js';
import { MemoryAttemptStore } from '../../src/core/security/attempt-store.js';
import { MemoryEventSink, guardTargetKey } from '../../src/core/security/events.js';
import {
  LoginBlockedError,
  LoginGuard,
  type LoginAttempt,
} from '../../src/core/security/login-guard.js';

const MIN = 60_000;
const T0 = Date.UTC(2026, 8, 22, 10, 0, 0);
const IP = '203.0.113.7';
const HOST = 'imap.example-test-domain.eu';
const USERNAME = 'someone@example-test-domain.eu';
const PASSWORD = 'pw-CANARY-9d1e';
const SETTINGS: ImapSettings = { host: HOST, port: 993, username: USERNAME };
const ATTEMPT: LoginAttempt = { ip: IP, host: HOST, username: USERNAME };

type Opener = (o: OpenSessionOptions) => Promise<ImapSession>;

interface FakeSession {
  session: ImapSession;
  logout: ReturnType<typeof vi.fn<() => Promise<void>>>;
}

function fakeSession(): FakeSession {
  const logout = vi.fn<() => Promise<void>>(() => Promise.resolve());
  return { session: { logout } as unknown as ImapSession, logout };
}

function setup(): {
  guard: LoginGuard;
  store: MemoryAttemptStore;
  sink: MemoryEventSink;
  clock: { now: number };
} {
  const store = new MemoryAttemptStore();
  const sink = new MemoryEventSink();
  const clock = { now: T0 };
  const guard = new LoginGuard({
    store,
    sink,
    targetKey: guardTargetKey(Buffer.alloc(32, 3)),
    now: () => clock.now,
  });
  return { guard, store, sink, clock };
}

async function seedFailures(guard: LoginGuard, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await guard.recordFailure(ATTEMPT, 'auth-failed');
}

function options(
  guard: LoginGuard,
  open: Opener,
  onChallenge: () => Promise<void> = vi.fn<() => Promise<void>>(() => Promise.resolve()),
): Parameters<typeof guardedOpenSession>[0] {
  return {
    settings: SETTINGS,
    password: PASSWORD,
    clientVersion: '9.9.9',
    guard,
    clientIp: IP,
    onChallenge,
    open,
  };
}

describe('guardedOpenSession', () => {
  it('allowed → opens once without the guard options, records success, returns the session', async () => {
    const { guard } = setup();
    const { session } = fakeSession();
    const open = vi.fn<Opener>(() => Promise.resolve(session));
    const onChallenge = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const recordSuccess = vi.spyOn(guard, 'recordSuccess');
    const withPairLock = vi.spyOn(guard, 'withPairLock');

    await expect(guardedOpenSession(options(guard, open, onChallenge))).resolves.toBe(session);

    expect(open).toHaveBeenCalledTimes(1);
    const passed = open.mock.calls[0]?.[0];
    expect(passed).toBeDefined();
    for (const key of ['guard', 'clientIp', 'onChallenge', 'open']) {
      expect(Object.keys(passed ?? {})).not.toContain(key);
    }
    expect(passed?.settings).toEqual(SETTINGS);
    expect(passed?.password).toBe(PASSWORD);
    expect(passed?.clientVersion).toBe('9.9.9');
    expect(onChallenge).not.toHaveBeenCalled();
    expect(recordSuccess).toHaveBeenCalledTimes(1);
    expect(recordSuccess).toHaveBeenCalledWith(ATTEMPT);
    expect(withPairLock).toHaveBeenCalledTimes(1);
    expect(withPairLock.mock.calls[0]?.[0]).toEqual(ATTEMPT);
  });

  it('passes the other session options through', async () => {
    const { guard } = setup();
    const { session } = fakeSession();
    const open = vi.fn<Opener>(() => Promise.resolve(session));
    const checkConnectivity = (): Promise<boolean> => Promise.resolve(true);
    await guardedOpenSession({
      ...options(guard, open),
      timeouts: { connectMs: 1234 },
      checkConnectivity,
    });
    const passed = open.mock.calls[0]?.[0];
    expect(passed?.timeouts).toEqual({ connectMs: 1234 });
    expect(passed?.checkConnectivity).toBe(checkConnectivity);
  });

  it('blocked → LoginBlockedError, never opens, never challenges', async () => {
    const { guard } = setup();
    await seedFailures(guard, 5);
    const open = vi.fn<Opener>();
    const onChallenge = vi.fn<() => Promise<void>>(() => Promise.resolve());

    const err: unknown = await guardedOpenSession(options(guard, open, onChallenge)).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LoginBlockedError);
    expect((err as LoginBlockedError).kind).toBe('too-many-attempts');
    expect((err as LoginBlockedError).until).toEqual(new Date(T0 + 15 * MIN));
    expect(open).not.toHaveBeenCalled();
    expect(onChallenge).not.toHaveBeenCalled();
  });

  it('blocked for a mapped IPv4 client address too (IPs are normalized)', async () => {
    const { guard } = setup();
    await seedFailures(guard, 5);
    const open = vi.fn<Opener>();
    await expect(
      guardedOpenSession({ ...options(guard, open), clientIp: '::ffff:203.0.113.7' }),
    ).rejects.toBeInstanceOf(LoginBlockedError);
    expect(open).not.toHaveBeenCalled();
  });

  it('challenge-required → awaits onChallenge before opening', async () => {
    const { guard } = setup();
    await seedFailures(guard, 2);
    const log: string[] = [];
    const { session } = fakeSession();
    const open = vi.fn<Opener>(() => {
      log.push('open');
      return Promise.resolve(session);
    });
    const onChallenge = vi.fn<() => Promise<void>>(async () => {
      log.push('challenge start');
      await new Promise((r) => setImmediate(r));
      log.push('challenge end');
    });

    await expect(guardedOpenSession(options(guard, open, onChallenge))).resolves.toBe(session);
    expect(log).toEqual(['challenge start', 'challenge end', 'open']);
  });

  it('a rejected challenge propagates, opens nothing, records nothing', async () => {
    const { guard } = setup();
    await seedFailures(guard, 2);
    const cancelled = new Error('cancelled');
    const open = vi.fn<Opener>();
    const recordFailure = vi.spyOn(guard, 'recordFailure');
    const recordSuccess = vi.spyOn(guard, 'recordSuccess');

    await expect(
      guardedOpenSession(options(guard, open, () => Promise.reject(cancelled))),
    ).rejects.toBe(cancelled);
    expect(open).not.toHaveBeenCalled();
    expect(recordFailure).not.toHaveBeenCalled();
    expect(recordSuccess).not.toHaveBeenCalled();
  });

  it('counted failure → recorded, the original error is rethrown (same object)', async () => {
    const { guard } = setup();
    const original = new ImapSessionError('auth-failed', 'AUTHENTICATIONFAILED');
    const open = vi.fn<Opener>(() => Promise.reject(original));
    const recordFailure = vi.spyOn(guard, 'recordFailure');
    const recordSuccess = vi.spyOn(guard, 'recordSuccess');

    await expect(guardedOpenSession(options(guard, open))).rejects.toBe(original);
    expect(recordFailure).toHaveBeenCalledTimes(1);
    expect(recordFailure).toHaveBeenCalledWith(ATTEMPT, 'auth-failed');
    expect(recordSuccess).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('the failure that locks the pair → LoginBlockedError instead of the original error', async () => {
    const { guard, sink } = setup();
    await seedFailures(guard, 4);
    const open = vi.fn<Opener>(() => Promise.reject(new ImapSessionError('auth-failed')));
    const err: unknown = await guardedOpenSession(options(guard, open)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LoginBlockedError);
    expect((err as LoginBlockedError).kind).toBe('too-many-attempts');
    expect((err as LoginBlockedError).until).toEqual(new Date(T0 + 15 * MIN));
    expect(sink.events.map((e) => e.kind)).toEqual(['too-many-attempts']);
  });

  it.each<ImapFailureReason>([
    'timeout',
    'host-not-found',
    'tls-certificate',
    'unexpected',
    'oauth-only',
  ])('uncounted failure %s → rethrown as-is, nothing recorded', async (reason) => {
    const { guard, store } = setup();
    const original = new ImapSessionError(reason);
    const open = vi.fn<Opener>(() => Promise.reject(original));
    await expect(guardedOpenSession(options(guard, open))).rejects.toBe(original);
    expect(store.keys()).toEqual([]);
  });

  it('any other error → rethrown as-is, recordFailure not called', async () => {
    const { guard, store } = setup();
    const original = new TypeError('something odd');
    const open = vi.fn<Opener>(() => Promise.reject(original));
    const recordFailure = vi.spyOn(guard, 'recordFailure');
    await expect(guardedOpenSession(options(guard, open))).rejects.toBe(original);
    expect(recordFailure).not.toHaveBeenCalled();
    expect(store.keys()).toEqual([]);
  });

  it('recordSuccess rejects → logs the session out, then rejects with that error', async () => {
    const { guard } = setup();
    const { session, logout } = fakeSession();
    const open = vi.fn<Opener>(() => Promise.resolve(session));
    const storeDown = new Error('store down');
    vi.spyOn(guard, 'recordSuccess').mockRejectedValue(storeDown);

    await expect(guardedOpenSession(options(guard, open))).rejects.toBe(storeDown);
    expect(logout).toHaveBeenCalledTimes(1);
  });

  it('a successful login clears the pair failures', async () => {
    const { guard } = setup();
    await seedFailures(guard, 3);
    const { session } = fakeSession();
    await guardedOpenSession(options(guard, () => Promise.resolve(session)));
    expect(await guard.check(ATTEMPT)).toEqual({ kind: 'allow' });
  });

  it('10 parallel attempts on one pair → exactly 5 reach the server, 5 are blocked', async () => {
    const { guard } = setup();
    const open = vi.fn<Opener>(async () => {
      await new Promise((r) => setImmediate(r));
      throw new ImapSessionError('auth-failed');
    });
    const onChallenge = (): Promise<void> => Promise.resolve();

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => guardedOpenSession(options(guard, open, onChallenge))),
    );

    expect(open).toHaveBeenCalledTimes(5);
    const reasons = results.map((r): unknown => (r.status === 'rejected' ? r.reason : r.value));
    const blockedErrors = reasons.filter((r) => r instanceof LoginBlockedError);
    const authErrors = reasons.filter((r) => r instanceof ImapSessionError);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    // The 5th failure itself turns into LoginBlockedError; the rest never reach the server.
    expect(authErrors).toHaveLength(4);
    expect(blockedErrors).toHaveLength(6);
    for (const e of blockedErrors) expect(e.kind).toBe('too-many-attempts');
  });
});
