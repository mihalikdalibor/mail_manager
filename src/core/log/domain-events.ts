import { AuthError } from '../auth.js';
import type { CheckStatus } from '../doctor.js';
import type { DiscoverySource, DomainProblem } from '../providers/discover.js';
import { cleanProvider, oneOf, uuidOrUndefined } from './builders.js';
import type {
  AuthFailureReason,
  AuthLoginEvent,
  AuthLoginFailedEvent,
  AuthLogoutEvent,
  DiscoverChoice,
  DiscoverFinishEvent,
  DiscoverOutcome,
  DoctorCheckEvent,
} from './events.js';

// Builders for the events of today's commands (doctor, discover, login/logout). Like the
// core builders, they allowlist every field: only ids, fixed names and codes reach a line.

const CHECK_RE = /^[a-z0-9-]{1,40}$/;
const TARGET_RE = /^(?:[0-9a-f]{64}|invalid)$/;

const STATUSES: Record<CheckStatus, true> = { ok: true, warn: true, fail: true };
const OUTCOMES: Record<DiscoverOutcome, true> = {
  found: true,
  'needs-host': true,
  blocked: true,
  manual: true,
  invalid: true,
};
const SOURCES: Record<DiscoverySource, true> = {
  'preset-domain': true,
  'preset-mx': true,
  ispdb: true,
  autoconfig: true,
  srv: true,
};
const DOMAIN_PROBLEMS: Record<DomainProblem, true> = {
  'not-exist': true,
  'dns-error': true,
  'dns-unreachable': true,
};
const CHOICES: Record<DiscoverChoice, true> = {
  picked: true,
  'host-entered': true,
  manual: true,
  cancelled: true,
};
const AUTH_REASONS: Record<AuthFailureReason, true> = {
  'invalid-credentials': true,
  unreachable: true,
  unknown: true,
  unexpected: true,
};
const LOGOUT_OUTCOMES: Record<AuthLogoutEvent['outcome'], true> = {
  'logged-out': true,
  'not-logged-in': true,
};

/** An optional enum field: kept when allowed, dropped otherwise. */
function optional<T extends string>(value: unknown, allowed: Record<T, true>): T | undefined {
  return typeof value === 'string' && Object.hasOwn(allowed, value) ? (value as T) : undefined;
}

export function doctorCheck(check: string, status: CheckStatus): DoctorCheckEvent {
  return {
    event: 'doctor.check',
    check: CHECK_RE.test(check) ? check : 'other',
    status: oneOf(status, STATUSES, 'warn'),
  };
}

export interface DiscoverFinishFields {
  outcome: DiscoverOutcome;
  source?: DiscoverySource | undefined;
  provider?: string | undefined;
  domainProblem?: DomainProblem | undefined;
  choice?: DiscoverChoice | undefined;
}

export function discoverFinish(f: DiscoverFinishFields): DiscoverFinishEvent {
  const provider = cleanProvider(f.provider);
  const source = optional(f.source, SOURCES);
  const domainProblem = optional(f.domainProblem, DOMAIN_PROBLEMS);
  const choice = optional(f.choice, CHOICES);
  return {
    event: 'discover.finish',
    outcome: oneOf(f.outcome, OUTCOMES, 'invalid'),
    ...(source !== undefined && { source }),
    ...(provider !== undefined && { provider }),
    ...(domainProblem !== undefined && { domainProblem }),
    ...(choice !== undefined && { choice }),
  };
}

export function authLogin(userId: string): AuthLoginEvent {
  const user = uuidOrUndefined(userId);
  return { event: 'auth.login', ...(user !== undefined && { user }) };
}

/** Typed reason of a failed Mail Manager login; anything that isn't an AuthError is unexpected. */
export function authFailureReason(err: unknown): AuthFailureReason {
  if (!(err instanceof AuthError)) return 'unexpected';
  switch (err.code) {
    case 'invalid_credentials':
      return 'invalid-credentials';
    case 'unreachable':
      return 'unreachable';
    case 'unknown':
      return 'unknown';
    default:
      // A code outside the type (forged or from a future version) is not trusted.
      return 'unexpected';
  }
}

/** `target` must already be an HMAC (authEmailTarget) or `invalid`; anything else becomes `invalid`. */
export function authLoginFailed(reason: AuthFailureReason, target: string): AuthLoginFailedEvent {
  return {
    event: 'auth.login-failed',
    reason: oneOf(reason, AUTH_REASONS, 'unexpected'),
    target: TARGET_RE.test(target) ? target : 'invalid',
  };
}

export function authLogout(outcome: AuthLogoutEvent['outcome']): AuthLogoutEvent {
  return { event: 'auth.logout', outcome: oneOf(outcome, LOGOUT_OUTCOMES, 'not-logged-in') };
}
