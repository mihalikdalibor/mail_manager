import { IMAP_FAILURE_REASONS, type ImapFailureReason } from '../imap/errors.js';
import type { BlockKind } from '../security/events.js';
import { cleanProvider, count, oneOf, uuidOrUndefined } from './builders.js';
import type {
  ImapLoginEvent,
  ImapLoginFailedEvent,
  LoginGuardBlockEvent,
  LoginGuardChallengeEvent,
} from './events.js';

// Builders for mailbox logins and the login guard. `ip` and `target` come from the guard
// (normalised bucket + HMAC), so no host, username or password can reach these lines; the
// builders still allowlist them, so a caller bug can't either (or break fail2ban's format).

/** normalizeIp buckets: IPv4, IPv6 /64 (`h:h:h:h::/64`), `local`, `invalid`. */
const IP_BUCKET_RE = /^(?:local|invalid|(?:\d{1,3}\.){3}\d{1,3}|(?:[0-9a-f]{1,4}:){4}:\/64)$/;
/** eventAddress output: IPv4 or a full 8-hextet IPv6 address. */
const ADDR_RE = /^(?:(?:\d{1,3}\.){3}\d{1,3}|(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4})$/;
const TARGET_RE = /^[0-9a-f]{64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const BLOCK_KINDS: Record<BlockKind, true> = {
  'too-many-attempts': true,
  'ip-blocked': true,
  permanent: true,
};
const FAILURE_REASONS = new Set<string>(IMAP_FAILURE_REASONS);

/** A known ImapFailureReason (or `blocked` where allowed), else `unexpected`. */
function cleanReason(reason: unknown, allowBlocked: boolean): ImapFailureReason | 'blocked' {
  if (allowBlocked && reason === 'blocked') return 'blocked';
  return typeof reason === 'string' && FAILURE_REASONS.has(reason)
    ? (reason as ImapFailureReason)
    : 'unexpected';
}

function cleanIp(ip: string): string {
  return IP_BUCKET_RE.test(ip) ? ip : 'invalid';
}

function cleanTarget(target: string): string {
  return TARGET_RE.test(target) ? target : 'invalid';
}

export interface ImapLoginContext {
  /** Preset id or `custom`. */
  provider: string;
  /** Mail account UUID, when the login belongs to a saved account. */
  acct?: string | undefined;
  ip: string;
  target: string;
}

function common(c: ImapLoginContext): Pick<ImapLoginEvent, 'acct' | 'provider'> {
  const acct = uuidOrUndefined(c.acct);
  return { ...(acct !== undefined && { acct }), provider: cleanProvider(c.provider) ?? 'custom' };
}

export function imapLogin(c: ImapLoginContext): ImapLoginEvent {
  return { event: 'imap.login', ...common(c), ip: cleanIp(c.ip), target: cleanTarget(c.target) };
}

export function imapLoginFailed(
  c: ImapLoginContext,
  reason: ImapFailureReason | 'blocked',
  counted: boolean,
): ImapLoginFailedEvent {
  return {
    event: 'imap.login-failed',
    ...common(c),
    reason: cleanReason(reason, true),
    counted: counted === true,
    ip: cleanIp(c.ip),
    target: cleanTarget(c.target),
  };
}

export function guardChallenge(
  ip: string,
  attempts: number,
  target: string,
): LoginGuardChallengeEvent {
  return {
    event: 'login-guard.challenge',
    ip: cleanIp(ip),
    attempts: count(attempts),
    target: cleanTarget(target),
  };
}

export interface GuardBlockFields {
  kind: BlockKind;
  reason: ImapFailureReason;
  ip: string;
  addr: string | null;
  attempts: number;
  until: string | null;
  target: string;
}

/** Field order is fixed by EVENT_FIELDS: fail2ban's regex anchors on it. */
export function guardBlock(f: GuardBlockFields): LoginGuardBlockEvent {
  return {
    event: 'login-guard.block',
    // Unknown kind → the least severe one: it never matches fail2ban's IP-level regex.
    kind: oneOf(f.kind, BLOCK_KINDS, 'too-many-attempts'),
    reason: cleanReason(f.reason, false) as ImapFailureReason,
    ip: cleanIp(f.ip),
    addr: f.addr !== null && ADDR_RE.test(f.addr) ? f.addr : null,
    attempts: count(f.attempts),
    until: f.until !== null && ISO_RE.test(f.until) ? f.until : null,
    target: cleanTarget(f.target),
  };
}
