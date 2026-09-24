import type { ImapFailureReason } from '../imap/errors.js';
import type { AttemptStore } from './attempt-store.js';
import { hmacTarget, type BlockKind, type SecurityEventSink } from './events.js';
import { eventAddress, normalizeIp } from './ip.js';

// Brute-force policy for IMAP logins made on a user's behalf (decided with the user 2026-09-22):
// - per (IP + mailbox) pair: 2 failures free, then a challenge; 5 failures in 15 min lock the
//   pair for 15 min; after a lock the pair keeps the challenge for 24 h (no free guesses);
// - per IP: 3 pair lockouts in 24 h block the IP for 24 h; 3 IP blocks in 30 days → permanent;
// - per mailbox across all IPs: 10 failures in 15 min → challenge only, never a lock, so an
//   attacker can't lock the real owner out.
// Only credential failures count — a flaky network must never lock anyone out.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface LoginPolicy {
  pairChallengeAfter: number;
  pairLockAfter: number;
  pairWindowMs: number;
  pairLockMs: number;
  pairLockoutChallengeMs: number;
  mailboxChallengeAfter: number;
  mailboxWindowMs: number;
  ipLockoutsForBlock: number;
  ipLockoutWindowMs: number;
  ipBlockMs: number;
  ipBlocksForPermanent: number;
  ipBlockWindowMs: number;
}

export const LOGIN_POLICY: LoginPolicy = {
  pairChallengeAfter: 2,
  pairLockAfter: 5,
  pairWindowMs: 15 * MINUTE,
  pairLockMs: 15 * MINUTE,
  pairLockoutChallengeMs: DAY,
  mailboxChallengeAfter: 10,
  mailboxWindowMs: 15 * MINUTE,
  ipLockoutsForBlock: 3,
  ipLockoutWindowMs: DAY,
  ipBlockMs: DAY,
  ipBlocksForPermanent: 3,
  ipBlockWindowMs: 30 * DAY,
};

/** Failures that say something about the credentials. Network/TLS/input problems don't count. */
export const COUNTED_REASONS: ReadonlySet<ImapFailureReason> = new Set<ImapFailureReason>([
  'auth-failed',
  'app-password-required',
  'password-expired',
  'contact-admin',
  'server-rejected',
]);

export interface LoginAttempt {
  /** Client IP (server) or `local` (CLI). */
  ip: string;
  host: string;
  username: string;
}

export type GuardDecision =
  | { kind: 'allow' }
  | { kind: 'challenge-required' }
  | { kind: 'blocked'; block: BlockKind; until: Date | null };

/** Thrown instead of connecting. Carries no address — only what's needed for the message. */
export class LoginBlockedError extends Error {
  readonly kind: BlockKind;
  readonly until: Date | null;

  constructor(kind: BlockKind, until: Date | null) {
    super(`Login blocked: ${kind}`);
    this.name = 'LoginBlockedError';
    this.kind = kind;
    this.until = until;
  }

  toJSON(): { name: 'LoginBlockedError'; kind: BlockKind; until: string | null } {
    return {
      name: 'LoginBlockedError',
      kind: this.kind,
      until: this.until === null ? null : this.until.toISOString(),
    };
  }
}

interface Keys {
  ip: string;
  addr: string | null;
  target: string;
  pair: string;
  pairLock: string;
  pairLockouts: string;
  mailbox: string;
  ipLockouts: string;
  ipBlock: string;
  ipBlocks: string;
  ipPermanent: string;
}

export class LoginGuard {
  private readonly store: AttemptStore;
  private readonly targetKey: Buffer;
  private readonly sink: SecurityEventSink | undefined;
  private readonly now: () => number;
  private readonly policy: LoginPolicy;
  private readonly pairQueues = new Map<string, Promise<unknown>>();
  // All counter reads/writes run one at a time: IP and mailbox counters are shared between
  // pairs, so parallel attempts on different pairs would otherwise lose each other's updates.
  private stateQueue: Promise<unknown> = Promise.resolve();

  constructor(opts: {
    store: AttemptStore;
    targetKey: Buffer;
    sink?: SecurityEventSink;
    now?: () => number;
    policy?: LoginPolicy;
  }) {
    this.store = opts.store;
    this.targetKey = opts.targetKey;
    this.sink = opts.sink;
    this.now = opts.now ?? Date.now;
    this.policy = opts.policy ?? LOGIN_POLICY;
  }

  /** Store keys: normalised IP + HMAC target only — never a plain host or address. */
  private keys(a: LoginAttempt): Keys {
    const ip = normalizeIp(a.ip);
    const target = hmacTarget(this.targetKey, a.host, a.username);
    return {
      ip,
      addr: eventAddress(a.ip),
      target,
      pair: `pair:${ip}:${target}`,
      pairLock: `pairlock:${ip}:${target}`,
      pairLockouts: `pairlockouts:${ip}:${target}`,
      mailbox: `mbox:${target}`,
      ipLockouts: `iplockouts:${ip}`,
      ipBlock: `ipblock:${ip}`,
      ipBlocks: `ipblocks:${ip}`,
      ipPermanent: `ipperm:${ip}`,
    };
  }

  /** Timestamps inside the sliding window (t > now - window); prunes the stored list. */
  private async recent(key: string, windowMs: number, now: number): Promise<number[]> {
    const all = await this.store.getTimes(key);
    const kept = all.filter((t) => t > now - windowMs);
    if (kept.length !== all.length) await this.store.setTimes(key, kept);
    return kept;
  }

  /** Active until-time (until > now), or null; expired entries are removed. */
  private async activeUntil(key: string, now: number): Promise<number | null> {
    const until = await this.store.getUntil(key);
    if (until === null) return null;
    if (until > now) return until;
    await this.store.setUntil(key, null);
    return null;
  }

  private async decide(k: Keys, now: number): Promise<GuardDecision> {
    const p = this.policy;
    if (await this.store.getFlag(k.ipPermanent)) {
      return { kind: 'blocked', block: 'permanent', until: null };
    }
    const ipBlock = await this.activeUntil(k.ipBlock, now);
    if (ipBlock !== null) return { kind: 'blocked', block: 'ip-blocked', until: new Date(ipBlock) };
    const pairLock = await this.activeUntil(k.pairLock, now);
    if (pairLock !== null) {
      return { kind: 'blocked', block: 'too-many-attempts', until: new Date(pairLock) };
    }
    const pairFailures = await this.recent(k.pair, p.pairWindowMs, now);
    const pairLockouts = await this.recent(k.pairLockouts, p.pairLockoutChallengeMs, now);
    const mailboxFailures = await this.recent(k.mailbox, p.mailboxWindowMs, now);
    if (
      pairFailures.length >= p.pairChallengeAfter ||
      pairLockouts.length > 0 ||
      mailboxFailures.length >= p.mailboxChallengeAfter
    ) {
      return { kind: 'challenge-required' };
    }
    return { kind: 'allow' };
  }

  /** Runs `fn` after every earlier state operation of this guard has settled. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.stateQueue.then(fn, fn);
    this.stateQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  check(a: LoginAttempt): Promise<GuardDecision> {
    return this.exclusive(() => this.decide(this.keys(a), this.now()));
  }

  /** Records a failed login; only COUNTED_REASONS change anything. Returns the new decision. */
  recordFailure(a: LoginAttempt, reason: ImapFailureReason): Promise<GuardDecision> {
    return this.exclusive(() => this.applyFailure(a, reason));
  }

  private async applyFailure(a: LoginAttempt, reason: ImapFailureReason): Promise<GuardDecision> {
    const k = this.keys(a);
    const now = this.now();
    if (!COUNTED_REASONS.has(reason)) return this.decide(k, now);
    const p = this.policy;

    const pairFailures = [...(await this.recent(k.pair, p.pairWindowMs, now)), now];
    await this.store.setTimes(k.pair, pairFailures);
    const mailboxFailures = await this.recent(k.mailbox, p.mailboxWindowMs, now);
    await this.store.setTimes(k.mailbox, [...mailboxFailures, now]);

    if (pairFailures.length >= p.pairLockAfter) {
      const until = now + p.pairLockMs;
      await this.store.setUntil(k.pairLock, until);
      await this.store.setTimes(k.pair, []);
      const lockouts = await this.recent(k.pairLockouts, p.pairLockoutChallengeMs, now);
      await this.store.setTimes(k.pairLockouts, [...lockouts, now]);
      this.emit(k, reason, 'too-many-attempts', pairFailures.length, until, now);

      const ipLockouts = [...(await this.recent(k.ipLockouts, p.ipLockoutWindowMs, now)), now];
      if (ipLockouts.length >= p.ipLockoutsForBlock) {
        const blockUntil = now + p.ipBlockMs;
        await this.store.setUntil(k.ipBlock, blockUntil);
        await this.store.setTimes(k.ipLockouts, []);
        const ipBlocks = [...(await this.recent(k.ipBlocks, p.ipBlockWindowMs, now)), now];
        await this.store.setTimes(k.ipBlocks, ipBlocks);
        this.emit(k, reason, 'ip-blocked', ipLockouts.length, blockUntil, now);

        if (ipBlocks.length >= p.ipBlocksForPermanent) {
          await this.store.setFlag(k.ipPermanent, true);
          this.emit(k, reason, 'permanent', ipBlocks.length, null, now);
        }
      } else {
        await this.store.setTimes(k.ipLockouts, ipLockouts);
      }
    }
    return this.decide(k, now);
  }

  /** A successful login resets the pair's failure counter; lock/block history stays. */
  recordSuccess(a: LoginAttempt): Promise<void> {
    return this.exclusive(() => this.store.setTimes(this.keys(a).pair, []));
  }

  /**
   * Runs `fn` after every earlier call for the same (IP, mailbox) pair has settled, so
   * check → login → record can't be raced by parallel attempts. Not re-entrant: `fn` must not
   * call withPairLock for the same pair (it would wait for itself forever).
   */
  async withPairLock<T>(a: LoginAttempt, fn: () => Promise<T>): Promise<T> {
    const key = this.keys(a).pair;
    const previous = this.pairQueues.get(key) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.pairQueues.set(key, tail);
    try {
      return await run;
    } finally {
      // Drop the queue entry once nothing else is waiting behind this call.
      if (this.pairQueues.get(key) === tail) this.pairQueues.delete(key);
    }
  }

  private emit(
    k: Keys,
    reason: ImapFailureReason,
    kind: BlockKind,
    attempts: number,
    until: number | null,
    now: number,
  ): void {
    this.sink?.emit({
      ts: new Date(now).toISOString(),
      event: 'login-guard.block',
      kind,
      reason,
      ip: k.ip,
      addr: k.addr,
      attempts,
      until: until === null ? null : new Date(until).toISOString(),
      target: k.target,
    });
  }
}
