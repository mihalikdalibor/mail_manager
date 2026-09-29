import {
  guardChallenge,
  imapLogin,
  imapLoginFailed,
  NullEventLog,
  safeEmit,
  type EventLog,
  type ImapLoginContext,
} from '../log/index.js';
import {
  COUNTED_REASONS,
  LoginBlockedError,
  type LoginAttempt,
  type LoginGuard,
} from '../security/login-guard.js';
import { ImapSessionError } from './errors.js';
import { openSession, type ImapSession, type OpenSessionOptions } from './session.js';

export interface GuardedOpenOptions extends OpenSessionOptions {
  guard: LoginGuard;
  /** Client IP (server) or `local` (CLI). */
  clientIp: string;
  /** Runs when the guard asks for a challenge (CLI: short delay; server: Turnstile, M6a). */
  onChallenge: () => Promise<void>;
  /** Preset id or `custom` — logged instead of the host. */
  provider: string;
  /** Mail account UUID, when the login belongs to a saved account. */
  acct?: string;
  /** Where `imap.*` / `login-guard.challenge` events go (default: nothing is recorded). */
  log?: EventLog;
  /** Session opener; tests pass a fake. */
  open?: (options: OpenSessionOptions) => Promise<ImapSession>;
}

/**
 * The only way the app logs in to a mailbox: login guard first, then one openSession attempt,
 * then the result is recorded. A blocked attempt never reaches the mail server. Attempts for
 * the same (IP, mailbox) run one after another, so parallel requests can't slip past a lock.
 * Events carry the guard's IP bucket and HMAC target — never the host, username or password.
 * If `guard.check`, `onChallenge` or `recordFailure` throws, its error propagates unchanged and
 * nothing further is logged for that attempt (only what was already emitted stays).
 */
export function guardedOpenSession(o: GuardedOpenOptions): Promise<ImapSession> {
  // Everything that isn't a session option is taken out before `open()` sees the rest.
  const {
    guard,
    clientIp,
    onChallenge,
    provider,
    acct,
    log = new NullEventLog(),
    open = openSession,
    ...sessionOptions
  } = o;
  const attempt: LoginAttempt = {
    ip: clientIp,
    host: sessionOptions.settings.host,
    username: sessionOptions.settings.username,
  };

  return guard.withPairLock(attempt, async () => {
    const id = guard.identify(attempt);
    const ctx: ImapLoginContext = { provider, acct, ip: id.ip, target: id.target };

    const decision = await guard.check(attempt);
    if (decision.kind === 'blocked') {
      safeEmit(log, () => imapLoginFailed(ctx, 'blocked', false));
      throw new LoginBlockedError(decision.block, decision.until);
    }
    if (decision.kind === 'challenge-required') {
      safeEmit(log, () => guardChallenge(id.ip, decision.attempts, id.target));
      await onChallenge();
    }

    let session: ImapSession;
    try {
      session = await open(sessionOptions);
    } catch (err) {
      if (err instanceof ImapSessionError) {
        const counted = COUNTED_REASONS.has(err.reason);
        // Before recordFailure, so the line comes before any login-guard.block it causes.
        safeEmit(log, () => imapLoginFailed(ctx, err.reason, counted));
        if (counted) {
          const after = await guard.recordFailure(attempt, err.reason);
          if (after.kind === 'blocked') throw new LoginBlockedError(after.block, after.until);
        }
      } else {
        safeEmit(log, () => imapLoginFailed(ctx, 'unexpected', false));
      }
      throw err;
    }

    try {
      await guard.recordSuccess(attempt);
    } catch (err) {
      // Don't leave a logged-in connection behind when the guard store fails.
      await session.logout();
      throw err;
    }
    safeEmit(log, () => imapLogin(ctx));
    return session;
  });
}
