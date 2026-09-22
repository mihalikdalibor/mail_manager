import type { EncryptedSecret } from '../crypto.js';
import type { CapabilityRecord } from '../imap/features.js';

// Domain types and repository interfaces only — no Supabase imports here, so the
// storage backend can be swapped without touching callers.

export type AuthType = 'password' | 'oauth2';

export interface MailAccount {
  id: string;
  userId: string;
  label: string | null;
  email: string;
  provider: string;
  host: string;
  port: number;
  username: string;
  authType: AuthType;
  secret: EncryptedSecret;
  capabilities: CapabilityRecord | null;
  createdAt: Date;
  updatedAt: Date;
  lastCheckedAt: Date | null;
}

export interface NewMailAccount {
  id: string;
  userId: string;
  label?: string | null;
  email: string;
  provider: string;
  host: string;
  port: number;
  username: string;
  authType: AuthType;
  secret: EncryptedSecret;
}

export interface AccountsRepo {
  create(account: NewMailAccount): Promise<MailAccount>;
  list(): Promise<MailAccount[]>;
  /** null when not found, hidden by RLS, or `id` is not a UUID. */
  get(id: string): Promise<MailAccount | null>;
  findByEmail(email: string): Promise<MailAccount[]>;
  /** true when exactly one row changed; false when not found, hidden by RLS, or not a UUID. */
  updateSecret(id: string, secret: EncryptedSecret): Promise<boolean>;
  /**
   * true when exactly one row changed; false when not found, hidden by RLS, or `id` is not a
   * UUID (no request). Throws RepoError for a capability record outside the sanitised shape.
   */
  recordCheck(id: string, capabilities: CapabilityRecord, checkedAt: Date): Promise<boolean>;
  /** true when exactly one row was deleted; false when not found, hidden by RLS, or not a UUID. */
  remove(id: string): Promise<boolean>;
}

export type RepoErrorCode = 'not_found' | 'conflict' | 'forbidden' | 'unavailable' | 'unknown';

/** Messages carry codes only, never row data or secrets. */
export class RepoError extends Error {
  readonly code: RepoErrorCode;

  constructor(code: RepoErrorCode, message: string) {
    super(message);
    this.name = 'RepoError';
    this.code = code;
  }
}
