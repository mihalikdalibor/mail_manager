import type { LogLevel } from '../config.js';
import type { CheckStatus } from '../doctor.js';
import type { ImapFailureReason } from '../imap/errors.js';
import type { AuditAction } from '../db/repos.js';
import type { DiscoverySource, DomainProblem } from '../providers/discover.js';
import type { BlockKind } from '../security/events.js';

// The event catalog in code. Each event carries only the fields it may carry, so a password
// or a subject has no field to land in. Every name here must appear in docs/LOGGING.md.

/** app → app-<date>.log (JSON Lines); security → security-<date>.log (`mm-security {json}`). */
export type LogKind = 'app' | 'security';

export type CommandOutcome = 'ok' | 'failed' | 'interrupted';

export interface CommandStartEvent {
  event: 'command.start';
  /** Command path, e.g. `login` or `account add`. */
  cmd: string;
  /** Names of the options given on the command line — never their values. */
  opts: string[];
  ver: string;
  node: string;
  os: string;
}

export interface CommandFinishEvent {
  event: 'command.finish';
  cmd: string;
  outcome: CommandOutcome;
  exit: number;
  ms: number;
}

export interface UnexpectedErrorEvent {
  event: 'error.unexpected';
  errClass: string;
  code?: string;
  /** Stack frames only: relative paths, no message. */
  stack: string[];
}

/** Written once when a day file reaches its size cap; nothing more is written to it. */
export interface LogTruncatedEvent {
  event: 'log.truncated';
}

/** One per `mm doctor` check (the check's fixed name, never its detail text). */
export interface DoctorCheckEvent {
  event: 'doctor.check';
  check: string;
  status: CheckStatus;
}

export type DiscoverOutcome = 'found' | 'needs-host' | 'blocked' | 'manual' | 'invalid';
export type DiscoverChoice = 'picked' | 'host-entered' | 'manual' | 'cancelled';

/** `mm discover` result — never the address, domain, host or username. */
export interface DiscoverFinishEvent {
  event: 'discover.finish';
  outcome: DiscoverOutcome;
  source?: DiscoverySource;
  /** Preset id (e.g. `websupport`), when the settings came from a preset. */
  provider?: string;
  domainProblem?: DomainProblem;
  /** What the user did in the provider picker, when it ran. */
  choice?: DiscoverChoice;
}

/** Successful Mail Manager (Supabase) login. */
export interface AuthLoginEvent {
  event: 'auth.login';
  /** Supabase user id; never the e-mail. */
  user?: string;
}

export type AuthFailureReason = 'invalid-credentials' | 'unreachable' | 'unknown' | 'unexpected';

export interface AuthLoginFailedEvent {
  event: 'auth.login-failed';
  reason: AuthFailureReason;
  /** HMAC of the typed e-mail, or `invalid` when the input wasn't an address. */
  target: string;
}

export interface AuthLogoutEvent {
  event: 'auth.logout';
  outcome: 'logged-out' | 'not-logged-in';
}

/** Successful mailbox login through guardedOpenSession. */
export interface ImapLoginEvent {
  event: 'imap.login';
  /** Mail account UUID, when the login belongs to a saved account. */
  acct?: string;
  /** Preset id or `custom`. */
  provider: string;
  /** Counting bucket: IPv4, IPv6 /64, `local` or `invalid`. */
  ip: string;
  /** HMAC of the mailbox (host + username). */
  target: string;
}

export interface ImapLoginFailedEvent {
  event: 'imap.login-failed';
  acct?: string;
  provider: string;
  /** `blocked`: refused by the login guard without contacting the server. */
  reason: ImapFailureReason | 'blocked';
  /** Whether the failure counts towards the login guard's limits. */
  counted: boolean;
  ip: string;
  target: string;
}

export interface LoginGuardChallengeEvent {
  event: 'login-guard.challenge';
  ip: string;
  attempts: number;
  target: string;
}

/** One per block. Key order is fixed: FAIL2BAN_FAILREGEX anchors on ts, event, kind … addr. */
export interface LoginGuardBlockEvent {
  event: 'login-guard.block';
  kind: BlockKind;
  /** Reason of the counted failure that triggered the block. */
  reason: ImapFailureReason;
  ip: string;
  /** One concrete address a firewall can ban (fail2ban `<ADDR>`), or null. */
  addr: string | null;
  attempts: number;
  until: string | null;
  target: string;
}

export type AuditFailureReason =
  'forbidden' | 'unavailable' | 'conflict' | 'not-found' | 'unknown' | 'invalid';

/** The action happened, but its audit_log row couldn't be written. */
export interface AuditWriteFailedEvent {
  event: 'audit.write-failed';
  action: AuditAction | 'other';
  reason: AuditFailureReason;
}

export type AccountEventName =
  'account.add' | 'account.test' | 'account.password-update' | 'account.remove';

export type AccountOutcome = 'ok' | 'failed';

/** Why an account action failed: an IMAP reason or a typed account/storage problem. */
export type AccountFailureReason =
  | ImapFailureReason
  | 'blocked'
  | 'duplicate'
  | 'not-found'
  | 'secret-unreadable'
  | 'unsupported'
  | 'database'
  | 'unexpected';

/** `mm account …` (M1c-1): ids and codes only — never the address, host or username. */
export interface AccountEvent<N extends AccountEventName = AccountEventName> {
  event: N;
  /** Mail account UUID (none for an add that didn't save). */
  acct?: string;
  /** Preset id or `custom`. */
  provider: string;
  outcome: AccountOutcome;
  /** Only when the outcome is `failed`. */
  reason?: AccountFailureReason;
}

export type LogEvent =
  | CommandStartEvent
  | CommandFinishEvent
  | UnexpectedErrorEvent
  | LogTruncatedEvent
  | DoctorCheckEvent
  | DiscoverFinishEvent
  | AuthLoginEvent
  | AuthLoginFailedEvent
  | AuthLogoutEvent
  | ImapLoginEvent
  | ImapLoginFailedEvent
  | LoginGuardChallengeEvent
  | LoginGuardBlockEvent
  | AuditWriteFailedEvent
  | AccountEvent<'account.add'>
  | AccountEvent<'account.test'>
  | AccountEvent<'account.password-update'>
  | AccountEvent<'account.remove'>;

export type LogEventName = LogEvent['event'];

type FieldsOf<E> = Exclude<keyof E, 'event'>;

/** Field order per event (after `ts`, `event`); fixed so line filters stay stable. */
export const EVENT_FIELDS: {
  [N in LogEventName]: readonly FieldsOf<Extract<LogEvent, { event: N }>>[];
} = {
  'command.start': ['cmd', 'opts', 'ver', 'node', 'os'],
  'command.finish': ['cmd', 'outcome', 'exit', 'ms'],
  'error.unexpected': ['errClass', 'code', 'stack'],
  'log.truncated': [],
  'doctor.check': ['check', 'status'],
  'discover.finish': ['outcome', 'source', 'provider', 'domainProblem', 'choice'],
  'auth.login': ['user'],
  'auth.login-failed': ['reason', 'target'],
  'auth.logout': ['outcome'],
  'imap.login': ['acct', 'provider', 'ip', 'target'],
  'imap.login-failed': ['acct', 'provider', 'reason', 'counted', 'ip', 'target'],
  'login-guard.challenge': ['ip', 'attempts', 'target'],
  'login-guard.block': ['kind', 'reason', 'ip', 'addr', 'attempts', 'until', 'target'],
  'audit.write-failed': ['action', 'reason'],
  'account.add': ['acct', 'provider', 'outcome', 'reason'],
  'account.test': ['acct', 'provider', 'outcome', 'reason'],
  'account.password-update': ['acct', 'provider', 'outcome', 'reason'],
  'account.remove': ['acct', 'provider', 'outcome', 'reason'],
};

export const EVENT_KIND: Record<LogEventName, LogKind> = {
  'command.start': 'app',
  'command.finish': 'app',
  'error.unexpected': 'app',
  'log.truncated': 'app',
  'doctor.check': 'app',
  'discover.finish': 'app',
  'auth.login': 'security',
  'auth.login-failed': 'security',
  'auth.logout': 'security',
  'imap.login': 'security',
  'imap.login-failed': 'security',
  'login-guard.challenge': 'security',
  'login-guard.block': 'security',
  'audit.write-failed': 'app',
  'account.add': 'app',
  'account.test': 'app',
  'account.password-update': 'app',
  'account.remove': 'app',
};

export const LOG_EVENT_NAMES = Object.keys(EVENT_FIELDS) as LogEventName[];

export const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export function eventLevel(e: LogEvent): LogLevel {
  switch (e.event) {
    case 'command.finish':
    case 'account.add':
    case 'account.test':
    case 'account.password-update':
    case 'account.remove':
      return e.outcome === 'ok' ? 'info' : 'warn';
    case 'doctor.check':
      return e.status === 'ok' ? 'info' : 'warn';
    case 'login-guard.block':
      return e.kind === 'permanent' ? 'error' : 'warn';
    case 'error.unexpected':
    case 'audit.write-failed':
      return 'error';
    case 'auth.login-failed':
    case 'imap.login-failed':
    case 'login-guard.challenge':
      return 'warn';
    case 'command.start':
    case 'log.truncated':
    case 'discover.finish':
    case 'auth.login':
    case 'auth.logout':
    case 'imap.login':
      return 'info';
  }
}
