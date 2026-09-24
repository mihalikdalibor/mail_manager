import type { LoginBlockedError } from '../core/security/login-guard.js';

function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** "14:32 CEST" today, "23 Sept 2026, 14:32 CEST" otherwise — always with the time zone. */
export function formatUntil(d: Date, now: Date = new Date()): string {
  const time: Intl.DateTimeFormatOptions = {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  };
  const options: Intl.DateTimeFormatOptions = sameLocalDay(d, now)
    ? time
    : { day: 'numeric', month: 'short', year: 'numeric', ...time };
  return new Intl.DateTimeFormat('en-GB', options).format(d);
}

/** Plain-language text for a login the guard stopped: what happened, until when, what to do. */
export function loginBlockedText(err: LoginBlockedError, now: Date = new Date()): string {
  switch (err.kind) {
    case 'too-many-attempts':
      return (
        'Too many wrong passwords for this mailbox. Check the password — or use an app ' +
        `password if your provider requires one — and try again after ${until(err, now)}.`
      );
    case 'ip-blocked':
      return (
        'Too many failed sign-ins from this connection, so it is blocked for now. ' +
        `Try again after ${until(err, now)}.`
      );
    case 'permanent':
      return "Couldn't connect — this connection is blocked. Contact Mail Manager support.";
  }
}

function until(err: LoginBlockedError, now: Date): string {
  return err.until === null ? 'a while' : formatUntil(err.until, now);
}

/** CLI challenge: a short, announced wait before the next attempt (server: Turnstile, M6a). */
export function cliChallenge(
  write: (line: string) => void = (line) => console.error(line),
  delayMs = 5000,
): Promise<void> {
  const seconds = Math.round(delayMs / 1000);
  write(
    `Several wrong passwords for this mailbox — waiting ${seconds} seconds before trying again.`,
  );
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
