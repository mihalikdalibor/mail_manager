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
  /** Session opener; tests pass a fake. */
  open?: (options: OpenSessionOptions) => Promise<ImapSession>;
}

/**
 * The only way the app logs in to a mailbox: login guard first, then one openSession attempt,
 * then the result is recorded. A blocked attempt never reaches the mail server. Attempts for
 * the same (IP, mailbox) run one after another, so parallel requests can't slip past a lock.
 */
export function guardedOpenSession(o: GuardedOpenOptions): Promise<ImapSession> {
  const { guard, clientIp, onChallenge, open = openSession, ...sessionOptions } = o;
  const attempt: LoginAttempt = {
    ip: clientIp,
    host: sessionOptions.settings.host,
    username: sessionOptions.settings.username,
  };

  return guard.withPairLock(attempt, async () => {
    const decision = await guard.check(attempt);
    if (decision.kind === 'blocked') throw new LoginBlockedError(decision.block, decision.until);
    if (decision.kind === 'challenge-required') await onChallenge();

    let session: ImapSession;
    try {
      session = await open(sessionOptions);
    } catch (err) {
      if (err instanceof ImapSessionError && COUNTED_REASONS.has(err.reason)) {
        const after = await guard.recordFailure(attempt, err.reason);
        if (after.kind === 'blocked') throw new LoginBlockedError(after.block, after.until);
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
    return session;
  });
}
