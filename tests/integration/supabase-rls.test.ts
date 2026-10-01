import { randomBytes, randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateSupabaseEnv } from '../../src/core/config.js';
import {
  createLocalCredentialProvider,
  type CredentialProvider,
} from '../../src/core/credentials.js';
import {
  RepoError,
  type AccountsRepo,
  type AuditEntry,
  type MailAccount,
} from '../../src/core/db/repos.js';
import { createSupabase } from '../../src/core/db/supabase/client.js';
import {
  createSupabaseServices,
  MemorySessionStorage,
  type SupabaseServices,
} from '../../src/core/db/supabase/index.js';

// Proves row-level security on mail_accounts against the real cloud project with two users.
// Skipped unless the test-user credentials are configured (CI has none).

const env = process.env;
const REQUIRED = [
  'SUPABASE_URL',
  'SUPABASE_PUBLISHABLE_KEY',
  'MM_MASTER_KEY',
  'MM_TEST_SUPABASE_A_EMAIL',
  'MM_TEST_SUPABASE_A_PASSWORD',
  'MM_TEST_SUPABASE_B_EMAIL',
  'MM_TEST_SUPABASE_B_PASSWORD',
] as const;
const hasTestUsers = REQUIRED.every((name) => (env[name] ?? '').trim() !== '');

const LABEL = 'mm-rls-test';
const PLAINTEXT = `rls-plaintext-${randomUUID()}`;

function required(name: (typeof REQUIRED)[number]): string {
  const value = env[name];
  if (!value) throw new Error(`${name} missing`);
  return value;
}

interface TestUser {
  services: SupabaseServices;
  userId: string;
}

async function signIn(prefix: 'A' | 'B'): Promise<TestUser> {
  const services = createSupabaseServices(env, new MemorySessionStorage());
  const user = await services.auth.login(
    required(`MM_TEST_SUPABASE_${prefix}_EMAIL`),
    required(`MM_TEST_SUPABASE_${prefix}_PASSWORD`),
  );
  return { services, userId: user.userId };
}

describe.skipIf(!hasTestUsers)('mail_accounts row-level security (live Supabase)', () => {
  let a: TestUser;
  let b: TestUser;
  let credentials: CredentialProvider;
  const created: { repo: AccountsRepo; id: string }[] = [];

  async function createAs(
    user: TestUser,
    overrides: { userId?: string } = {},
  ): Promise<MailAccount> {
    const id = randomUUID();
    const userId = overrides.userId ?? user.userId;
    const account = await user.services.accounts.create({
      id,
      userId,
      label: LABEL,
      email: `RLS-Test+${id.slice(0, 8)}@Example.invalid`,
      provider: 'custom',
      host: 'imap.example.invalid',
      port: 993,
      username: `rls-${id.slice(0, 8)}`,
      authType: 'password',
      secret: credentials.encryptPassword(
        {
          userId,
          accountId: id,
          host: 'imap.example.invalid',
          port: 993,
          username: `rls-${id.slice(0, 8)}`,
        },
        PLAINTEXT,
      ),
    });
    created.push({ repo: user.services.accounts, id: account.id });
    return account;
  }

  beforeAll(async () => {
    credentials = createLocalCredentialProvider(env);
    a = await signIn('A');
    b = await signIn('B');
    expect(a.userId).not.toBe(b.userId);
  });

  afterAll(async () => {
    if (!a || !b) return;
    for (const { repo, id } of created) await repo.remove(id).catch(() => false);
    // Sweep leftovers from earlier crashed runs.
    for (const user of [a, b]) {
      for (const row of await user.services.accounts.list()) {
        if (row.label === LABEL) await user.services.accounts.remove(row.id);
      }
      await user.services.auth.logout();
    }
  });

  it('lets a user create, read, update and delete their own row', async () => {
    const row = await createAs(a);
    expect(row.userId).toBe(a.userId);
    expect(row.email).toBe(row.email.toLowerCase());

    expect((await a.services.accounts.get(row.id))?.id).toBe(row.id);
    expect((await a.services.accounts.list()).map((r) => r.id)).toContain(row.id);
    expect(await a.services.accounts.findByEmail(row.email.toUpperCase())).toHaveLength(1);

    const newSecret = credentials.encryptPassword(
      {
        userId: a.userId,
        accountId: row.id,
        host: row.host,
        port: row.port,
        username: row.username,
      },
      'x2',
    );
    expect(await a.services.accounts.updateSecret(row.id, newSecret)).toBe(true);
    expect(await a.services.accounts.recordCheck(row.id, { UIDPLUS: true }, new Date())).toBe(true);
    const updated = await a.services.accounts.get(row.id);
    expect(updated?.capabilities).toEqual({ UIDPLUS: true });
    expect(updated?.lastCheckedAt).toBeInstanceOf(Date);
    expect(updated && updated.updatedAt >= row.updatedAt).toBe(true);

    expect(await a.services.accounts.remove(row.id)).toBe(true);
    expect(await a.services.accounts.get(row.id)).toBeNull();
  });

  it("hides a user's rows from another user and blocks cross-user writes", async () => {
    const rowA = await createAs(a);

    expect((await b.services.accounts.list()).map((r) => r.id)).not.toContain(rowA.id);
    expect(await b.services.accounts.get(rowA.id)).toBeNull();
    expect(await b.services.accounts.findByEmail(rowA.email)).toHaveLength(0);

    const forged = credentials.encryptPassword(
      {
        userId: b.userId,
        accountId: rowA.id,
        host: rowA.host,
        port: rowA.port,
        username: rowA.username,
      },
      'evil',
    );
    expect(await b.services.accounts.updateSecret(rowA.id, forged)).toBe(false);
    expect(await b.services.accounts.recordCheck(rowA.id, { x: 1 }, new Date())).toBe(false);
    expect(await b.services.accounts.remove(rowA.id)).toBe(false);

    // A's row is unchanged.
    const stillA = await a.services.accounts.get(rowA.id);
    expect(stillA?.secret).toEqual(rowA.secret);

    // B can't create a row owned by A.
    await expect(createAs(b, { userId: a.userId })).rejects.toMatchObject({
      name: 'RepoError',
      code: 'forbidden',
    });
  });

  it('keeps id and user_id immutable even for the owner', async () => {
    const rowB = await createAs(b);
    const cfg = validateSupabaseEnv(env);
    if (!cfg.ok) throw new Error('config invalid');
    // Raw client sharing B's session, to attempt a column the repo never updates.
    const storage = new MemorySessionStorage();
    const raw = createSupabase(cfg.value, storage);
    await raw.auth.signInWithPassword({
      email: required('MM_TEST_SUPABASE_B_EMAIL'),
      password: required('MM_TEST_SUPABASE_B_PASSWORD'),
    });
    const { error } = await raw
      .from('mail_accounts')
      .update({ user_id: a.userId })
      .eq('id', rowB.id);
    expect(error?.code).toBe('42501');
    const { error: idError } = await raw
      .from('mail_accounts')
      .update({ id: randomUUID() })
      .eq('id', rowB.id);
    expect(idError?.code).toBe('42501');
    await raw.auth.signOut({ scope: 'local' });
    expect((await b.services.accounts.get(rowB.id))?.userId).toBe(b.userId);
  });

  it('denies the anon role entirely: select, insert, update, delete (42501)', async () => {
    const cfg = validateSupabaseEnv(env);
    if (!cfg.ok) throw new Error('config invalid');
    const anon = createClient(cfg.value.url, cfg.value.publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await anon.from('mail_accounts').select('id').limit(1);
    expect(data).toBeNull();
    expect(error?.code).toBe('42501');

    // Writes are denied too — not merely filtered to zero rows by RLS.
    const id = randomUUID();
    const insert = await anon.from('mail_accounts').insert({
      id,
      user_id: randomUUID(),
      email: `anon-${id.slice(0, 8)}@example.invalid`,
      host: 'imap.example.invalid',
      username: 'anon',
      secret_ciphertext: 'x',
      secret_iv: 'x',
      secret_tag: 'x',
      key_version: 1,
    });
    expect(insert.error?.code).toBe('42501');
    const update = await anon.from('mail_accounts').update({ label: 'anon' }).eq('id', id);
    expect(update.error?.code).toBe('42501');
    const del = await anon.from('mail_accounts').delete().eq('id', id);
    expect(del.error?.code).toBe('42501');
  });

  it('stores only ciphertext, which decrypts back for the owner', async () => {
    const row = await createAs(a);
    // Every column of the raw row, not just the ciphertext field.
    const cfg = validateSupabaseEnv(env);
    if (!cfg.ok) throw new Error('config invalid');
    const raw = createSupabase(cfg.value, new MemorySessionStorage());
    await raw.auth.signInWithPassword({
      email: required('MM_TEST_SUPABASE_A_EMAIL'),
      password: required('MM_TEST_SUPABASE_A_PASSWORD'),
    });
    const { data: rawRow, error } = await raw
      .from('mail_accounts')
      .select('*')
      .eq('id', row.id)
      .single<Record<string, unknown>>();
    await raw.auth.signOut({ scope: 'local' });
    expect(error).toBeNull();
    for (const value of Object.values(rawRow ?? {})) {
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      expect(text).not.toContain(PLAINTEXT);
      expect(Buffer.from(text, 'base64').toString('utf8')).not.toContain(PLAINTEXT);
    }

    const stored = await a.services.accounts.get(row.id);
    if (!stored) throw new Error('row missing');
    expect(stored.secret.ciphertext).not.toContain(PLAINTEXT);
    expect(Buffer.from(stored.secret.ciphertext, 'base64').toString('utf8')).not.toContain(
      PLAINTEXT,
    );
    expect(credentials.decryptPassword(stored)).toBe(PLAINTEXT);
  });
});

// audit_log (M1b-4d): append-only for users. Rows can't be deleted by anyone but the database
// (deleting the user cascades), so every run leaves a few rows tagged reason 'rls-test' and
// this run's id — accepted (decided 2026-09-29). Exact error codes: anything looser would miss
// a regressed grant (e.g. an UPDATE grant without a policy returns 0 rows, not an error).
describe.skipIf(!hasTestUsers)('audit_log row-level security (live Supabase)', () => {
  const RUN = randomBytes(8).toString('hex');
  const AUDIT_LABEL = 'mm-rls-audit-test';
  let a: TestUser;
  let b: TestUser;
  let rawA: SupabaseClient;
  let rawB: SupabaseClient;
  let credentials: CredentialProvider;
  const accounts: string[] = [];

  function entry(overrides: Partial<AuditEntry> = {}): AuditEntry {
    return { action: 'account.add', result: 'ok', reason: 'rls-test', runId: RUN, ...overrides };
  }

  /** A raw row as the app would never send it (bypasses zod), tagged for this run. */
  function rawRow(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { action: 'account.add', result: 'ok', reason: 'rls-test', run_id: RUN, ...extra };
  }

  async function rawClient(prefix: 'A' | 'B'): Promise<SupabaseClient> {
    const cfg = validateSupabaseEnv(env);
    if (!cfg.ok) throw new Error('config invalid');
    const raw = createSupabase(cfg.value, new MemorySessionStorage());
    const { error } = await raw.auth.signInWithPassword({
      email: required(`MM_TEST_SUPABASE_${prefix}_EMAIL`),
      password: required(`MM_TEST_SUPABASE_${prefix}_PASSWORD`),
    });
    if (error) throw new Error(`sign-in ${prefix} failed`);
    return raw;
  }

  async function accountOfA(): Promise<MailAccount> {
    const id = randomUUID();
    const account = await a.services.accounts.create({
      id,
      userId: a.userId,
      label: AUDIT_LABEL,
      email: `rls-audit+${id.slice(0, 8)}@example.invalid`,
      provider: 'custom',
      host: 'imap.example.invalid',
      port: 993,
      username: `rls-audit-${id.slice(0, 8)}`,
      authType: 'password',
      secret: credentials.encryptPassword(
        {
          userId: a.userId,
          accountId: id,
          host: 'imap.example.invalid',
          port: 993,
          username: `rls-audit-${id.slice(0, 8)}`,
        },
        'rls-audit',
      ),
    });
    accounts.push(account.id);
    return account;
  }

  async function rowsOfRun(client: SupabaseClient): Promise<Record<string, unknown>[]> {
    const { data, error } = await client
      .from('audit_log')
      .select('*')
      .eq('run_id', RUN)
      .order('id');
    expect(error).toBeNull();
    return (data ?? []) as Record<string, unknown>[];
  }

  beforeAll(async () => {
    credentials = createLocalCredentialProvider(env);
    a = await signIn('A');
    b = await signIn('B');
    rawA = await rawClient('A');
    rawB = await rawClient('B');
  });

  afterAll(async () => {
    if (!a) return;
    for (const id of accounts) await a.services.accounts.remove(id).catch(() => false);
    for (const row of await a.services.accounts.list()) {
      if (row.label === AUDIT_LABEL) await a.services.accounts.remove(row.id);
    }
    for (const raw of [rawA, rawB]) await raw?.auth.signOut({ scope: 'local' });
    await a.services.auth.logout();
    await b?.services.auth.logout();
  });

  it('the owner writes a row (user_id and created_at set by the database) and reads it back', async () => {
    await a.services.audit.write(entry({ details: { provider: 'custom' } }));
    const rows = await rowsOfRun(rawA);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]).toMatchObject({ user_id: a.userId, action: 'account.add', reason: 'rls-test' });
    expect(typeof rows[0]?.['created_at']).toBe('string');
    const { records } = await a.services.audit.listRecent(50);
    expect(records.some((r) => r.runId === RUN)).toBe(true);
  });

  it("another user sees none of A's rows", async () => {
    await a.services.audit.write(entry());
    expect(await rowsOfRun(rawB)).toEqual([]);
  });

  it("B can't reference A's account or an unknown one (42501, before the FK check)", async () => {
    const account = await accountOfA();
    const err: unknown = await b.services.audit
      .write(entry({ accountId: account.id }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RepoError);
    expect((err as RepoError).code).toBe('forbidden');
    const unknown = await rawB.from('audit_log').insert(rawRow({ account_id: randomUUID() }));
    expect(unknown.error?.code).toBe('42501');
  });

  it("the client can't set user_id (42501), created_at (42501) or id (428C9)", async () => {
    const withUser = await rawA.from('audit_log').insert(rawRow({ user_id: a.userId }));
    expect(withUser.error?.code).toBe('42501');
    const withCreated = await rawA
      .from('audit_log')
      .insert(rawRow({ created_at: '2020-01-01T00:00:00Z' }));
    expect(withCreated.error?.code).toBe('42501');
    const withId = await rawA.from('audit_log').insert(rawRow({ id: 1 }));
    expect(withId.error?.code).toBe('428C9');
  });

  it('rows are immutable for their owner: update and delete → 42501, row unchanged', async () => {
    await a.services.audit.write(entry());
    const before = await rowsOfRun(rawA);
    const update = await rawA.from('audit_log').update({ result: 'failed' }).eq('run_id', RUN);
    expect(update.error?.code).toBe('42501');
    const del = await rawA.from('audit_log').delete().eq('run_id', RUN);
    expect(del.error?.code).toBe('42501');
    const after = await rowsOfRun(rawA);
    expect(after).toEqual(before);
  });

  it('anon can neither read nor insert (42501)', async () => {
    const cfg = validateSupabaseEnv(env);
    if (!cfg.ok) throw new Error('config invalid');
    const anon = createClient(cfg.value.url, cfg.value.publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const read = await anon.from('audit_log').select('id').limit(1);
    expect(read.error?.code).toBe('42501');
    const insert = await anon.from('audit_log').insert(rawRow());
    expect(insert.error?.code).toBe('42501');
  });

  it('the database rejects details over 4 KB (23514)', async () => {
    const res = await rawA
      .from('audit_log')
      .insert(rawRow({ details: { provider: 'x'.repeat(5000) } }));
    expect(res.error?.code).toBe('23514');
  });

  it('removing an account keeps its audit rows, with account_id set to null', async () => {
    const account = await accountOfA();
    // Written before the delete: afterwards the insert policy refuses the unknown account id.
    await a.services.audit.write(entry({ action: 'account.remove', accountId: account.id }));
    expect(await a.services.accounts.remove(account.id)).toBe(true);
    const rows = (await rowsOfRun(rawA)).filter((r) => r['action'] === 'account.remove');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['account_id']).toBeNull();
  });
});
