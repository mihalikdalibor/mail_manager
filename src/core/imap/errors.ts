import { hasUnsafeChars } from '../providers/email.js';

/**
 * Why an IMAP connection failed. Core keeps the precise reason (tests, logs); the shell decides
 * how much of it the user sees — most reasons share one generic message (src/cli/imap-errors.ts)
 * so the app can't be used to probe hosts or accounts.
 */
export type ImapFailureReason =
  | 'auth-failed'
  | 'app-password-required'
  | 'password-expired'
  | 'contact-admin'
  | 'server-rejected'
  | 'oauth-only'
  | 'host-not-found'
  | 'no-internet'
  | 'unreachable'
  | 'refused'
  | 'reset'
  | 'timeout'
  | 'tls-certificate'
  | 'server-unavailable'
  | 'throttled'
  | 'unsupported-server'
  | 'invalid-credentials-input'
  | 'unexpected';

export const IMAP_FAILURE_REASONS: readonly ImapFailureReason[] = [
  'auth-failed',
  'app-password-required',
  'password-expired',
  'contact-admin',
  'server-rejected',
  'oauth-only',
  'host-not-found',
  'no-internet',
  'unreachable',
  'refused',
  'reset',
  'timeout',
  'tls-certificate',
  'server-unavailable',
  'throttled',
  'unsupported-server',
  'invalid-credentials-input',
  'unexpected',
];

const SAFE_CODE = /^[A-Z0-9_-]{1,40}$/i;

/**
 * The only error openSession rejects with. Carries a reason and a whitelisted code token —
 * never server text, the executed command, the original error (`cause`) or the password.
 */
export class ImapSessionError extends Error {
  readonly reason: ImapFailureReason;
  readonly code: string | undefined;

  constructor(reason: ImapFailureReason, code?: string) {
    const safeCode = code !== undefined && SAFE_CODE.test(code) ? code : undefined;
    super(`IMAP connection failed: ${reason}${safeCode === undefined ? '' : ` (${safeCode})`}`);
    this.name = 'ImapSessionError';
    this.reason = reason;
    this.code = safeCode;
  }

  toJSON(): { name: string; reason: ImapFailureReason; code?: string } {
    return this.code === undefined
      ? { name: this.name, reason: this.reason }
      : { name: this.name, reason: this.reason, code: this.code };
  }
}

/** Fields read from an imapflow / Node error. Read-only: nothing is ever copied out as text. */
interface ErrorLike {
  code?: unknown;
  authenticationFailed?: unknown;
  serverResponseCode?: unknown;
  responseText?: unknown;
  _err?: unknown;
  cause?: unknown;
}

function asErrorLike(value: unknown): ErrorLike | undefined {
  return typeof value === 'object' && value !== null ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Codes of the error and the errors it wraps (imapflow `_err`, standard `cause`). */
function nodeCodes(err: ErrorLike): string[] {
  const codes: string[] = [];
  for (const candidate of [err, asErrorLike(err._err), asErrorLike(err.cause)]) {
    const code = str(candidate?.code);
    if (code !== undefined) codes.push(code);
  }
  return codes;
}

const NETWORK_DOWN = new Set(['EAI_AGAIN', 'ENETUNREACH', 'ENETDOWN']);

const TLS_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_REVOKED',
  'CERT_UNTRUSTED',
  'CERT_SIGNATURE_FAILURE',
  'HOSTNAME_MISMATCH',
  // TLS handshake failure, e.g. a server that only offers TLS below 1.2.
  'EPROTO',
]);

function isTlsCode(code: string): boolean {
  return TLS_CODES.has(code) || code.startsWith('ERR_SSL_') || code.startsWith('ERR_TLS_');
}

/**
 * True for errors that may mean "no internet on our side" — or only that the target's DNS
 * or IPv6 route failed. The caller confirms with a connectivity check before saying so.
 */
export function isNetworkDownCandidate(err: unknown): boolean {
  try {
    const e = asErrorLike(err);
    return e !== undefined && nodeCodes(e).some((c) => NETWORK_DOWN.has(c));
  } catch {
    return false; // A value with throwing getters is not a network error.
  }
}

const RESPONSE_CODES: Record<string, ImapFailureReason> = {
  AUTHENTICATIONFAILED: 'auth-failed',
  AUTHORIZATIONFAILED: 'auth-failed',
  EXPIRED: 'password-expired',
  CONTACTADMIN: 'contact-admin',
  PRIVACYREQUIRED: 'server-rejected',
  UNAVAILABLE: 'server-unavailable',
  LIMIT: 'throttled',
};

const APP_PASSWORD = /application-specific password|app password/i;

/**
 * Password login is impossible: LOGINDISABLED and no PLAIN/LOGIN mechanism. An OAuth mechanism
 * alone isn't enough — imapflow then still sends LOGIN, and a failure there may simply be a
 * wrong password (it must get the generic message, not "this provider needs OAuth").
 */
function isOAuthOnly(caps: ReadonlySet<string>): boolean {
  const upper = new Set([...caps].map((c) => c.toUpperCase()));
  if (upper.has('AUTH=PLAIN') || upper.has('AUTH=LOGIN')) return false;
  return upper.has('LOGINDISABLED');
}

interface MapContext {
  preAuthCaps?: ReadonlySet<string>;
  internetReachable?: boolean;
}

/**
 * Maps any thrown value to an ImapSessionError. Pure: server text is only matched against,
 * never copied. `internetReachable` comes from the caller's connectivity check. Never throws
 * (it also runs inside the client's 'error' listener), whatever getters the value has.
 */
export function mapImapError(err: unknown, ctx: MapContext = {}): ImapSessionError {
  try {
    return mapKnownError(err, ctx);
  } catch {
    return new ImapSessionError('unexpected');
  }
}

function mapKnownError(err: unknown, ctx: MapContext): ImapSessionError {
  const e = asErrorLike(err);
  if (e === undefined) return new ImapSessionError('unexpected');
  const authFailed = e.authenticationFailed === true;

  // 1. OAuth-only servers (imapflow reports them as a plain authentication failure).
  if (authFailed && ctx.preAuthCaps !== undefined && isOAuthOnly(ctx.preAuthCaps)) {
    return new ImapSessionError('oauth-only');
  }

  // 2. Response codes (RFC 5530) of the failed tagged response.
  const responseCode = str(e.serverResponseCode)?.toUpperCase();
  if (responseCode !== undefined) {
    const reason = RESPONSE_CODES[responseCode];
    if (reason !== undefined) return new ImapSessionError(reason, responseCode);
    if (responseCode === 'ALERT' && APP_PASSWORD.test(str(e.responseText) ?? '')) {
      return new ImapSessionError('app-password-required', responseCode);
    }
  }

  // 3. Any other authentication failure.
  if (authFailed) return new ImapSessionError('auth-failed', responseCode);

  // 4. imapflow's own codes.
  const code = str(e.code);
  switch (code) {
    case 'ETHROTTLE':
      return new ImapSessionError('throttled', code);
    case 'CONNECT_TIMEOUT':
    case 'GREETING_TIMEOUT':
    case 'ETIMEOUT':
    case 'UPGRADE_TIMEOUT':
      return new ImapSessionError('timeout', code);
    case 'MissingServerExtension':
      return new ImapSessionError('unsupported-server', code);
    // The server closed the connection (BYE, or dropped after TLS). imapflow 2.0.5 keeps only
    // the BYE's text (`err.reason`, untrusted, never read) and drops its [CODE], so
    // UNAVAILABLE/LIMIT can't be told apart here: generic "reset" like any other drop.
    case 'ClosedAfterConnectTLS':
    case 'ClosedAfterConnectText':
    case 'NoConnection':
      return new ImapSessionError('reset', code);
  }

  // 5. Node socket / DNS / TLS codes, on the error or the error it wraps.
  for (const nodeCode of nodeCodes(e)) {
    if (nodeCode === 'ENOTFOUND') return new ImapSessionError('host-not-found', nodeCode);
    if (NETWORK_DOWN.has(nodeCode)) {
      return new ImapSessionError(
        ctx.internetReachable === false ? 'no-internet' : 'unreachable',
        nodeCode,
      );
    }
    if (nodeCode === 'EHOSTUNREACH') return new ImapSessionError('unreachable', nodeCode);
    if (nodeCode === 'ECONNREFUSED') return new ImapSessionError('refused', nodeCode);
    if (nodeCode === 'ECONNRESET' || nodeCode === 'EPIPE') {
      return new ImapSessionError('reset', nodeCode);
    }
    if (nodeCode === 'ETIMEDOUT') return new ImapSessionError('timeout', nodeCode);
    if (isTlsCode(nodeCode)) return new ImapSessionError('tls-certificate', nodeCode);
  }

  return new ImapSessionError('unexpected');
}

/**
 * Rejects credentials that can't be sent safely: CR/LF/NUL could break out of an IMAP command,
 * invisible characters make a username look different from what's sent.
 */
export function validateCredentialsInput(
  username: string,
  password: string,
): ImapSessionError | null {
  const badPassword = password === '' || password.length > 1024 || /[\r\n\0]/.test(password);
  const badUsername = username.trim() === '' || username.length > 254 || hasUnsafeChars(username);
  return badPassword || badUsername ? new ImapSessionError('invalid-credentials-input') : null;
}
