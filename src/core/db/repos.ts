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

// Audit trail (M1b-4d): append-only record of what a user changed. Counts, bytes, folder
// names, the filter definition and reason codes only — never message content.

export const AUDIT_ACTIONS = [
  'account.add',
  'account.remove',
  'account.password-update',
  'filter.save',
  'filter.delete',
  'mail.trash',
  'mail.expunge',
  'mail.move',
  'backup',
  'migrate',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export type AuditResult = 'ok' | 'partial' | 'failed' | 'aborted';

export interface AuditEntry {
  /** The mail account the action belongs to; must be one of the user's own accounts. */
  accountId?: string;
  action: AuditAction;
  folder?: string;
  messageCount?: number;
  bytes?: number;
  /** Per-action details (validated by src/core/audit.ts), e.g. `{ provider }` for account.*. */
  details?: Record<string, unknown>;
  result: AuditResult;
  /** Typed reason code, never raw error text. */
  reason?: string;
  /** The local run id — links the row to the app log. */
  runId?: string;
}

export interface AuditRecord extends AuditEntry {
  id: number;
  userId: string;
  createdAt: Date;
}

export interface AuditRepo {
  /** Throws RepoError (codes only) when the row can't be written. */
  write(entry: AuditEntry): Promise<void>;
  /**
   * Newest first. Rows the user wrote directly (with their JWT) may not match the app's
   * schema: those are skipped and counted, never thrown, so one bad row can't break the list.
   */
  listRecent(limit: number): Promise<{ records: AuditRecord[]; skipped: number }>;
}
