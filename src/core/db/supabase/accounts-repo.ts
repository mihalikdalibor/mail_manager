import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { EncryptedSecret } from '../../crypto.js';
import {
  RepoError,
  type AccountsRepo,
  type MailAccount,
  type NewMailAccount,
  type RepoErrorCode,
} from '../repos.js';

const TABLE = 'mail_accounts';

const rowSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  label: z.string().nullable(),
  email: z.string(),
  provider: z.string(),
  host: z.string(),
  port: z.number().int(),
  username: z.string(),
  auth_type: z.enum(['password', 'oauth2']),
  secret_ciphertext: z.string(),
  secret_iv: z.string(),
  secret_tag: z.string(),
  key_version: z.number().int().positive(),
  capabilities: z.record(z.string(), z.unknown()).nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  last_checked_at: z.string().nullable(),
});

export type MailAccountRow = z.infer<typeof rowSchema>;

/** Validates a raw row and maps it to the domain type. Errors never include row values. */
export function rowToAccount(raw: unknown): MailAccount {
  const parsed = rowSchema.safeParse(raw);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join('.')))].join(', ');
    throw new RepoError('unknown', `Unexpected mail_accounts row shape (${fields})`);
  }
  const r = parsed.data;
  return {
    id: r.id,
    userId: r.user_id,
    label: r.label,
    email: r.email,
    provider: r.provider,
    host: r.host,
    port: r.port,
    username: r.username,
    authType: r.auth_type,
    secret: {
      ciphertext: r.secret_ciphertext,
      iv: r.secret_iv,
      tag: r.secret_tag,
      keyVersion: r.key_version,
    },
    capabilities: r.capabilities,
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at),
    lastCheckedAt: r.last_checked_at === null ? null : new Date(r.last_checked_at),
  };
}

function secretColumns(secret: EncryptedSecret) {
  return {
    secret_ciphertext: secret.ciphertext,
    secret_iv: secret.iv,
    secret_tag: secret.tag,
    key_version: secret.keyVersion,
  };
}

export function accountToInsertRow(a: NewMailAccount) {
  return {
    id: a.id,
    user_id: a.userId,
    label: a.label ?? null,
    email: a.email.toLowerCase(),
    provider: a.provider,
    host: a.host,
    port: a.port,
    username: a.username,
    auth_type: a.authType,
    ...secretColumns(a.secret),
  };
}

export interface PostgrestLikeError {
  code?: string | undefined;
  message?: string | undefined;
}

/** Maps PostgREST/Postgres errors to RepoError. Only codes go into the message. */
export function toRepoError(err: PostgrestLikeError): RepoError {
  const code = err.code ?? '';
  let kind: RepoErrorCode = 'unknown';
  if (code === '23505') kind = 'conflict';
  else if (code === '42501') kind = 'forbidden';
  else if (code === 'PGRST116') kind = 'not_found';
  else if (
    code === '' &&
    /fetch failed|network|ECONN|ENOTFOUND|timeout|aborted/i.test(err.message ?? '')
  ) {
    kind = 'unavailable';
  }
  return new RepoError(kind, `Database error: ${kind}${code ? ` (${code})` : ''}`);
}

export class SupabaseAccountsRepo implements AccountsRepo {
  constructor(private readonly client: SupabaseClient) {}

  async create(account: NewMailAccount): Promise<MailAccount> {
    const { data, error } = await this.client
      .from(TABLE)
      .insert(accountToInsertRow(account))
      .select()
      .single<unknown>();
    if (error) throw toRepoError(error);
    return rowToAccount(data);
  }

  async list(): Promise<MailAccount[]> {
    const { data, error } = await this.client.from(TABLE).select().order('created_at');
    if (error) throw toRepoError(error);
    return (data as unknown[]).map(rowToAccount);
  }

  async get(id: string): Promise<MailAccount | null> {
    const { data, error } = await this.client
      .from(TABLE)
      .select()
      .eq('id', id)
      .maybeSingle<unknown>();
    if (error) throw toRepoError(error);
    return data === null ? null : rowToAccount(data);
  }

  async findByEmail(email: string): Promise<MailAccount[]> {
    const { data, error } = await this.client
      .from(TABLE)
      .select()
      .eq('email', email.toLowerCase())
      .order('created_at');
    if (error) throw toRepoError(error);
    return (data as unknown[]).map(rowToAccount);
  }

  async updateSecret(id: string, secret: EncryptedSecret): Promise<boolean> {
    return this.updateOne(id, secretColumns(secret));
  }

  async recordCheck(
    id: string,
    capabilities: Record<string, unknown>,
    checkedAt: Date,
  ): Promise<boolean> {
    return this.updateOne(id, { capabilities, last_checked_at: checkedAt.toISOString() });
  }

  async remove(id: string): Promise<boolean> {
    const { data, error } = await this.client.from(TABLE).delete().eq('id', id).select('id');
    if (error) throw toRepoError(error);
    return data.length === 1;
  }

  private async updateOne(id: string, values: Record<string, unknown>): Promise<boolean> {
    const { data, error } = await this.client.from(TABLE).update(values).eq('id', id).select('id');
    if (error) throw toRepoError(error);
    return data.length === 1;
  }
}
