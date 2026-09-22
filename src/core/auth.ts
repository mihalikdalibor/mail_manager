// Auth contract for the CLI and doctor. No Supabase imports: the implementation lives in
// src/core/db/supabase/auth-service.ts.

export interface AuthUser {
  email: string;
  userId: string;
}

export interface AuthService {
  login(email: string, password: string): Promise<AuthUser>;
  /** Always clears the local session, even when the server can't be reached. */
  logout(): Promise<void>;
  /**
   * null when not logged in or the session is no longer valid.
   * Throws AuthError('unreachable') when the auth server can't be reached.
   */
  currentUser(): Promise<AuthUser | null>;
}

export type AuthErrorCode = 'invalid_credentials' | 'unreachable' | 'unknown';

/** Messages never include the email's password or raw server responses. */
export class AuthError extends Error {
  readonly code: AuthErrorCode;

  constructor(code: AuthErrorCode, message: string) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}
