import { AuthError } from '../auth.js';
import { RepoError, type AuditAction } from '../db/repos.js';
import type { CheckStatus } from '../doctor.js';
import type { DiscoverySource, DomainProblem } from '../providers/discover.js';
import { cleanProvider, oneOf, uuidOrUndefined } from './builders.js';
import {
  AUDIT_ACTION_SET,
  AUDIT_FAILURE_REASONS,
  AUTH_FAILURE_REASONS,
  CHECK_RE,
  CHECK_STATUSES,
  DISCOVER_CHOICES,
  DISCOVER_OUTCOMES,
  DISCOVERY_SOURCES,
  DOMAIN_PROBLEMS,
  LOGOUT_OUTCOMES,
  TARGET_RE,
} from './event-schemas.js';
import type {
  AuditFailureReason,
  AuditWriteFailedEvent,
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

/** An optional enum field: kept when allowed, dropped otherwise. */
function optional<T extends string>(value: unknown, allowed: Record<T, true>): T | undefined {
  return typeof value === 'string' && Object.hasOwn(allowed, value) ? (value as T) : undefined;
}

export function doctorCheck(check: string, status: CheckStatus): DoctorCheckEvent {
  return {
    event: 'doctor.check',
    check: typeof check === 'string' && CHECK_RE.test(check) ? check : 'other',
    status: oneOf(status, CHECK_STATUSES, 'warn'),
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
  const source = optional(f.source, DISCOVERY_SOURCES);
  const domainProblem = optional(f.domainProblem, DOMAIN_PROBLEMS);
  const choice = optional(f.choice, DISCOVER_CHOICES);
  return {
    event: 'discover.finish',
    outcome: oneOf(f.outcome, DISCOVER_OUTCOMES, 'invalid'),
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
    reason: oneOf(reason, AUTH_FAILURE_REASONS, 'unexpected'),
    target: TARGET_RE.test(target) ? target : 'invalid',
  };
}

export function authLogout(outcome: AuthLogoutEvent['outcome']): AuthLogoutEvent {
  return { event: 'auth.logout', outcome: oneOf(outcome, LOGOUT_OUTCOMES, 'not-logged-in') };
}

/** Typed reason of a failed audit write: the RepoError code, anything else `unknown`. */
export function auditFailureReason(err: unknown): AuditFailureReason {
  if (!(err instanceof RepoError)) return 'unknown';
  switch (err.code) {
    case 'forbidden':
      return 'forbidden';
    case 'unavailable':
      return 'unavailable';
    case 'conflict':
      return 'conflict';
    case 'not_found':
      return 'not-found';
    default:
      return 'unknown';
  }
}

export function auditWriteFailed(
  action: string,
  reason: AuditFailureReason,
): AuditWriteFailedEvent {
  return {
    event: 'audit.write-failed',
    action: AUDIT_ACTION_SET.has(action) ? (action as AuditAction) : 'other',
    reason: oneOf(reason, AUDIT_FAILURE_REASONS, 'unknown'),
  };
}
