import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { auditEntrySchema } from '../../audit.js';
import {
  AUDIT_ACTIONS,
  RepoError,
  type AuditEntry,
  type AuditRecord,
  type AuditRepo,
} from '../repos.js';
import { toRepoError } from './accounts-repo.js';

const TABLE = 'audit_log';
const COLUMNS =
  'id, user_id, account_id, action, folder, message_count, bytes, details, result, reason, run_id, created_at';
const MAX_LIST = 500;

// Reading back: rows may have been written by the user directly (their JWT allows inserts),
// so they're untrusted. `details` is loose here (any JSON object); rows that don't match are
// skipped, never thrown. Stored text such as `folder` must still be sanitised for display.
const rowSchema = z.object({
  id: z.number().int(),
  user_id: z.uuid(),
  account_id: z.uuid().nullable(),
  action: z.enum(AUDIT_ACTIONS),
  folder: z.string().nullable(),
  message_count: z.number().int().nonnegative().nullable(),
  bytes: z.number().int().nonnegative().nullable(),
  details: z.record(z.string(), z.unknown()).nullable(),
  result: z.enum(['ok', 'partial', 'failed', 'aborted']),
  reason: z.string().nullable(),
  run_id: z.string().nullable(),
  created_at: z.string().refine((s) => !Number.isNaN(Date.parse(s))),
});

type AuditRow = z.infer<typeof rowSchema>;

/** camelCase entry → insert row. Only defined values; never id, user_id or created_at. */
export function entryToInsertRow(e: z.output<typeof auditEntrySchema>): Record<string, unknown> {
  const row: Record<string, unknown> = {
    account_id: e.accountId,
    action: e.action,
    folder: e.folder,
    message_count: e.messageCount,
    bytes: e.bytes,
    details: e.details,
    result: e.result,
    reason: e.reason,
    run_id: e.runId,
  };
  return Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined));
}

function rowToRecord(r: AuditRow): AuditRecord {
  return {
    id: r.id,
    userId: r.user_id,
    action: r.action,
    result: r.result,
    createdAt: new Date(r.created_at),
    ...(r.account_id !== null && { accountId: r.account_id }),
    ...(r.folder !== null && { folder: r.folder }),
    ...(r.message_count !== null && { messageCount: r.message_count }),
    ...(r.bytes !== null && { bytes: r.bytes }),
    ...(r.details !== null && { details: r.details }),
    ...(r.reason !== null && { reason: r.reason }),
    ...(r.run_id !== null && { runId: r.run_id }),
  };
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 1;
  return Math.min(MAX_LIST, Math.max(1, Math.floor(limit)));
}

export class SupabaseAuditRepo implements AuditRepo {
  constructor(private readonly client: SupabaseClient) {}

  async write(entry: AuditEntry): Promise<void> {
    // Fixed message: zod's text can contain key names taken from the input.
    let parsed: ReturnType<typeof auditEntrySchema.safeParse>;
    try {
      parsed = auditEntrySchema.safeParse(entry);
    } catch {
      throw new RepoError('unknown', 'Invalid audit entry'); // e.g. a throwing getter
    }
    if (!parsed.success) throw new RepoError('unknown', 'Invalid audit entry');
    // Insert what zod returned, never the input: zod skips keys like an own `__proto__`
    // (from JSON.parse), which would otherwise ride along into `details` unchecked.
    // No .select(): the row isn't read back.
    const { error } = await this.client.from(TABLE).insert(entryToInsertRow(parsed.data));
    if (error) throw toRepoError(error);
  }

  async listRecent(limit: number): Promise<{ records: AuditRecord[]; skipped: number }> {
    const { data, error } = await this.client
      .from(TABLE)
      .select(COLUMNS)
      // id breaks ties between rows with the same timestamp, so the order is stable.
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(clampLimit(limit));
    if (error) throw toRepoError(error);
    if (data !== null && !Array.isArray(data)) {
      throw new RepoError('unknown', 'Unexpected audit_log response');
    }
    const records: AuditRecord[] = [];
    let skipped = 0;
    for (const raw of (data ?? []) as unknown[]) {
      const parsed = rowSchema.safeParse(raw);
      if (parsed.success) records.push(rowToRecord(parsed.data));
      else skipped++;
    }
    return { records, skipped };
  }
}
