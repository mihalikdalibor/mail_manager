import { z } from 'zod';
import { AUDIT_ACTIONS, type AuditAction, type AuditEntry, type AuditRepo } from './db/repos.js';
import {
  auditFailureReason,
  auditWriteFailed,
  cleanProvider,
  safeEmit,
  type EventLog,
} from './log/index.js';
import { hasUnsafeChars } from './providers/email.js';

// Validation of audit rows before they reach the cloud database (zod at the boundary).
// Only counts, bytes, folder names, preset ids and reason codes pass — never message content.

const INT4_MAX = 2_147_483_647;

// Line/paragraph separators, the Arabic letter mark and Unicode tag characters: invisible text
// that hasUnsafeChars doesn't cover (it's shared with e-mail parsing).
const EXTRA_INVISIBLE = /[\u2028\u2029\u061c]|[\u{e0000}-\u{e007f}]/u;
/** A high surrogate without a low one after it, or a low one without a high one before it. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * A folder name that may be stored in the cloud: no control or invisible characters, no lone
 * surrogates, and no `@` — shared namespaces (`Other Users/alice@example.com`) and contact folders
 * carry addresses, which must never reach the database. M4 decides how such folders are
 * recorded (special-use role or a keyed hash of the path).
 */
function isStorableFolder(folder: string): boolean {
  return (
    !LONE_SURROGATE.test(folder) &&
    !hasUnsafeChars(folder) &&
    !EXTRA_INVISIBLE.test(folder) &&
    !folder.includes('@')
  );
}

/**
 * Per-action `details`. Actions without a schema yet (later milestones) take none.
 * `account` is the mailbox UUID (an id, never the address): it keeps the history linked after
 * a remove, when the row's `account_id` is null. Failed adds have no account yet.
 */
const accountDetails = z
  .strictObject({
    provider: z.string().refine((p) => cleanProvider(p) !== undefined, 'invalid provider'),
    account: z.uuid().optional(),
  })
  .optional();

const DETAILS: Record<AuditAction, z.ZodType<Record<string, unknown> | undefined>> = {
  'account.add': accountDetails,
  'account.remove': accountDetails,
  'account.password-update': accountDetails,
  'filter.save': z.undefined(),
  'filter.delete': z.undefined(),
  'mail.trash': z.undefined(),
  'mail.expunge': z.undefined(),
  'mail.move': z.undefined(),
  backup: z.undefined(),
  migrate: z.undefined(),
};

export const auditEntrySchema = z
  .strictObject({
    accountId: z.uuid().optional(),
    action: z.enum(AUDIT_ACTIONS),
    folder: z.string().max(1024).refine(isStorableFolder, 'not storable').optional(),
    messageCount: z.number().int().nonnegative().max(INT4_MAX).optional(),
    bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    details: z.record(z.string(), z.unknown()).optional(),
    result: z.enum(['ok', 'partial', 'failed', 'aborted']),
    reason: z
      .string()
      .regex(/^[a-z0-9-]{1,60}$/)
      .optional(),
    runId: z
      .string()
      .regex(/^[0-9a-f]{16}$/)
      .optional(),
  })
  .superRefine((entry, ctx) => {
    if (!DETAILS[entry.action].safeParse(entry.details).success) {
      ctx.addIssue({ code: 'custom', path: ['details'], message: 'invalid details' });
    }
  });

/** true when the entry may be written (never throws — also not on throwing getters). */
export function isValidAuditEntry(entry: unknown): entry is AuditEntry {
  try {
    return auditEntrySchema.safeParse(entry).success;
  } catch {
    return false;
  }
}

/**
 * Writes one audit row. Never throws: the action already happened, so a lost row is reported
 * as `audit.write-failed` (action + reason code, no row values) and the result is `false`.
 */
export async function recordAudit(
  repo: AuditRepo,
  entry: AuditEntry,
  log: EventLog,
): Promise<boolean> {
  let action = 'other';
  try {
    if (typeof entry.action === 'string') action = entry.action;
  } catch {
    // A missing entry or a throwing getter: logged as `other`, reported as invalid below.
  }
  if (!isValidAuditEntry(entry)) {
    safeEmit(log, () => auditWriteFailed(action, 'invalid'));
    return false;
  }
  try {
    await repo.write(entry);
    return true;
  } catch (err) {
    safeEmit(log, () => auditWriteFailed(action, auditFailureReason(err)));
    return false;
  }
}
