import { isAuthRetryableFetchError, type SupabaseClient } from '@supabase/supabase-js';
import { AuthError, type AuthService, type AuthUser, type LogoutResult } from '../../auth.js';
import { DEFAULT_TIMEOUT_MS } from './client.js';
import type { SessionStorage } from './session-storage.js';

interface AuthErrorLike {
  code?: string | undefined;
  status?: number | undefined;
}

export function toAuthError(err: unknown): AuthError {
  if (isAuthRetryableFetchError(err)) return new AuthError('unreachable', 'Supabase unreachable');
  const e = (err ?? {}) as AuthErrorLike;
  if (e.code === 'invalid_credentials') {
    return new AuthError('invalid_credentials', 'Invalid email or password');
  }
  if (e.status === 0) return new AuthError('unreachable', 'Supabase unreachable');
  return new AuthError('unknown', `Login failed${e.code ? ` (${e.code})` : ''}`);
}

const NETWORK_CODES = new Set([
  'ENOTFOUND',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/** Network-level failures only; programming errors must not look like an outage. */
export function isUnreachable(err: unknown): boolean {
  if (isAuthRetryableFetchError(err)) return true;
  if ((err as AuthErrorLike | null)?.status === 0) return true;
  if (!(err instanceof Error)) return false;
  if (err.name === 'TimeoutError') return true; // AbortSignal.timeout from fetchWithTimeout
  if (!(err instanceof TypeError)) return false;
  // fetch() rejects with TypeError('fetch failed', { cause }) when the host can't be reached.
  if (err.message === 'fetch failed') return true;
  const code = (err.cause as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' && NETWORK_CODES.has(code);
}

/**
 * Caps a whole auth operation. Per-request timeouts aren't enough: auth-js retries a
 * token refresh with backoff for ~30 s, and every call first waits for that refresh.
 */
function withDeadline<T>(operation: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new AuthError('unreachable', 'Supabase unreachable'));
    }, ms);
    timer.unref();
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

export class SupabaseAuthService implements AuthService {
  constructor(
    private readonly client: SupabaseClient,
    private readonly storage: SessionStorage,
    private readonly deadlineMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  async login(email: string, password: string): Promise<AuthUser> {
    let result;
    try {
      result = await withDeadline(
        this.client.auth.signInWithPassword({ email, password }),
        this.deadlineMs,
      );
    } catch (err) {
      throw err instanceof AuthError ? err : toAuthError(err);
    }
    const { data, error } = result;
    if (error) throw toAuthError(error);
    return { email: data.user.email ?? email, userId: data.user.id };
  }

  async logout(): Promise<LogoutResult> {
    // Checked first, before any await: auth-js initialize() (started with the client) may
    // asynchronously remove an invalid stored session, which would flip the answer.
    // Any stored data counts as a session: with the implicit flow, password login writes only
    // the `sb-<host>-auth-token` key, and that name depends on SUPABASE_URL — so data left under
    // an old key is still a local session to delete ("Logged out", the conservative answer).
    if (this.storage.isEmpty()) {
      this.storage.clear(); // removes a corrupt file
      return 'not-logged-in';
    }
    try {
      // Revokes the refresh token server-side when reachable; result deliberately ignored.
      await withDeadline(this.client.auth.signOut({ scope: 'local' }), this.deadlineMs);
    } catch {
      // Offline logout must still succeed locally.
    }
    // signOut keeps the session on network errors, so always clear it ourselves.
    this.storage.clear();
    return 'logged-out';
  }

  currentUser(): Promise<AuthUser | null> {
    return withDeadline(this.lookupUser(), this.deadlineMs);
  }

  private async lookupUser(): Promise<AuthUser | null> {
    try {
      // getSession() refreshes an expired access token and persists the rotated refresh token.
      const { data: sessionData, error: sessionError } = await this.client.auth.getSession();
      if (sessionError) return this.invalidOrUnreachable(sessionError);
      if (!sessionData.session) return null;
      // Confirm with the auth server (catches sessions revoked elsewhere).
      const { data, error } = await this.client.auth.getUser();
      if (error) return this.invalidOrUnreachable(error);
      return { email: data.user.email ?? '', userId: data.user.id };
    } catch (err) {
      if (err instanceof AuthError) throw err;
      return this.invalidOrUnreachable(err);
    }
  }

  /** A network failure is not "logged out": report it so the user isn't told to log in again. */
  private invalidOrUnreachable(err: unknown): null {
    if (isUnreachable(err)) throw new AuthError('unreachable', 'Supabase unreachable');
    return null;
  }
}
