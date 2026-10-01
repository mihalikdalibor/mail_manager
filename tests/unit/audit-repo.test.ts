import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect } from 'vitest';
import { RepoError } from '../../src/core/db/repos.js';
import type { AuditEntry } from '../../src/core/db/repos.js';
import { toRepoError } from '../../src/core/db/supabase/accounts-repo.js';
import { SupabaseAuditRepo } from '../../src/core/db/supabase/audit-repo.js';
import { createSupabaseServices, MemorySessionStorage } from '../../src/core/db/supabase/index.js';

// M1b-4d SupabaseAuditRepo against a fake supabase-js client, pinned from the spec.

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const RUN_ID = '0123456789abcdef';
const COLUMNS = [
  'id',
  'user_id',
  'account_id',
  'action',
  'folder',
  'message_count',
  'bytes',
  'details',
  'result',
  'reason',
  'run_id',
  'created_at',
];

interface Call {
  method: string;
  args: unknown[];
}

interface FakeResponse {
  data?: unknown;
  error?: unknown;
}

const CHAIN_METHODS = [
  'insert',
  'select',
  'order',
  'limit',
  'range',
  'eq',
  'single',
  'maybeSingle',
  'abortSignal',
  'returns',
  'throwOnError',
];

/** Records every builder call; awaiting any point of the chain yields `response`. */
function fakeClient(response: FakeResponse = { data: null, error: null }) {
  const calls: Call[] = [];
  const settled = { data: response.data ?? null, error: response.error ?? null };
  const chain: Record<string, unknown> = {};
  for (const method of CHAIN_METHODS) {
    chain[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return chain;
    };
  }
  chain['then'] = (onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
    Promise.resolve(settled).then(onFulfilled, onRejected);
  const client = {
    from: (table: string) => {
      calls.push({ method: 'from', args: [table] });
      return chain;
    },
  } as unknown as SupabaseClient;
  const methods = () => calls.map((c) => c.method);
  const argsOf = (method: string): unknown[] => {
    const found = calls.filter((c) => c.method === method);
    expect(found).toHaveLength(1);
    return found[0]?.args ?? [];
  };
  return { client, calls, methods, argsOf };
}

/** A client that fails the test if the repo sends any request. */
function noRequestClient(): { client: SupabaseClient; calls: () => number } {
  let calls = 0;
  const client = {
    from: () => {
      calls += 1;
      throw new Error('unexpected request');
    },
  } as unknown as SupabaseClient;
  return { client, calls: () => calls };
}

async function rejection(p: Promise<unknown>): Promise<RepoError> {
  const err: unknown = await p.then(
    () => {
      throw new Error('expected a rejection');
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(RepoError);
  return err as RepoError;
}

function fullEntry(): AuditEntry {
  return {
    accountId: ACCOUNT_ID,
    action: 'mail.trash',
    folder: 'INBOX/Staré',
    messageCount: 12,
    bytes: 345_678,
    result: 'partial',
    reason: 'uidvalidity-changed',
    runId: RUN_ID,
  };
}

describe('SupabaseAuditRepo.write', () => {
  it('inserts a minimal entry into audit_log with only the defined columns and no select', async () => {
    const fake = fakeClient();
    await new SupabaseAuditRepo(fake.client).write({ action: 'backup', result: 'ok' });
    expect(fake.argsOf('from')).toEqual(['audit_log']);
    const [row] = fake.argsOf('insert');
    expect(row).toEqual({ action: 'backup', result: 'ok' });
    expect(fake.methods()).not.toContain('select');
  });

  it('maps a full entry to snake_case columns', async () => {
    const fake = fakeClient();
    await new SupabaseAuditRepo(fake.client).write(fullEntry());
    const [row] = fake.argsOf('insert');
    expect(row).toEqual({
      account_id: ACCOUNT_ID,
      action: 'mail.trash',
      folder: 'INBOX/Staré',
      message_count: 12,
      bytes: 345_678,
      result: 'partial',
      reason: 'uidvalidity-changed',
      run_id: RUN_ID,
    });
    expect(fake.methods()).not.toContain('select');
  });

  it('passes account details through', async () => {
    const fake = fakeClient();
    await new SupabaseAuditRepo(fake.client).write({
      accountId: ACCOUNT_ID,
      action: 'account.add',
      details: { provider: 'gmail' },
      result: 'ok',
    });
    const [row] = fake.argsOf('insert');
    expect(row).toEqual({
      account_id: ACCOUNT_ID,
      action: 'account.add',
      details: { provider: 'gmail' },
      result: 'ok',
    });
  });

  it('never sends id, user_id or created_at (the database sets them)', async () => {
    const fake = fakeClient();
    await new SupabaseAuditRepo(fake.client).write(fullEntry());
    const [row] = fake.argsOf('insert');
    const keys = Object.keys(row as object);
    for (const k of ['id', 'user_id', 'created_at', 'userId', 'createdAt']) {
      expect(keys).not.toContain(k);
    }
    for (const k of keys) expect(k).toMatch(/^[a-z_]+$/);
    expect(Object.values(row as object)).not.toContain(undefined);
  });

  it.each<[string, unknown]>([
    ['an unknown action', { action: 'foo.bar', result: 'ok' }],
    ['a folder with a newline', { ...fullEntry(), folder: 'LEAKCANARY\nforged' }],
    ['an unknown key', { ...fullEntry(), subject: 'LEAKCANARY subject' }],
    ['a user_id smuggled in', { ...fullEntry(), user_id: USER_ID }],
    ['details on a mail action', { ...fullEntry(), details: { provider: 'gmail' } }],
    [
      'a bad provider',
      { action: 'account.add', result: 'ok', details: { provider: 'LEAKCANARY' } },
    ],
    ['a negative messageCount', { ...fullEntry(), messageCount: -1 }],
    ['a raw-text reason', { ...fullEntry(), reason: 'LEAKCANARY Invalid credentials' }],
  ])('rejects %s with RepoError(unknown, "Invalid audit entry") and no request', async (_l, e) => {
    const { client, calls } = noRequestClient();
    const err = await rejection(new SupabaseAuditRepo(client).write(e as AuditEntry));
    expect(err.code).toBe('unknown');
    expect(err.message).toBe('Invalid audit entry');
    expect(calls()).toBe(0);
  });

  const CANARY_ERROR = {
    message: 'new row violates row-level security policy LEAKCANARY-msg',
    details: 'Failing row contains (7, LEAKCANARY-details, INBOX/Súkromné, 12).',
    hint: 'LEAKCANARY-hint',
  };

  it.each([
    ['42501', 'forbidden'],
    ['23505', 'conflict'],
    ['23514', 'unknown'],
    ['XX000', 'unknown'],
  ] as const)('maps insert error code %s to %s without leaking its text', async (code, kind) => {
    const fake = fakeClient({ error: { code, ...CANARY_ERROR } });
    const err = await rejection(new SupabaseAuditRepo(fake.client).write(fullEntry()));
    expect(err.code).toBe(kind);
    expect(err.message).not.toContain('LEAKCANARY');
    expect(err.message).not.toContain('Failing row');
    expect(err.message).not.toContain('INBOX');
  });

  it('maps a network failure to unavailable', async () => {
    const fake = fakeClient({
      error: { code: '', message: 'TypeError: fetch failed', details: 'LEAKCANARY', hint: '' },
    });
    const err = await rejection(new SupabaseAuditRepo(fake.client).write(fullEntry()));
    expect(err.code).toBe('unavailable');
    expect(err.message).not.toContain('LEAKCANARY');
  });
});

function row(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 7,
    user_id: USER_ID,
    account_id: ACCOUNT_ID,
    action: 'mail.trash',
    folder: 'INBOX/Staré',
    message_count: 12,
    bytes: 345678,
    details: null,
    result: 'ok',
    reason: null,
    run_id: RUN_ID,
    // PostgREST's timestamptz format (microseconds, numeric offset).
    created_at: '2026-09-29T06:33:14.123456+00:00',
    ...extra,
  };
}

describe('SupabaseAuditRepo.listRecent', () => {
  it('selects the audit columns from audit_log, newest first, with the limit', async () => {
    const fake = fakeClient({ data: [] });
    await expect(new SupabaseAuditRepo(fake.client).listRecent(20)).resolves.toEqual({
      records: [],
      skipped: 0,
    });
    expect(fake.argsOf('from')).toEqual(['audit_log']);
    const [cols] = fake.argsOf('select');
    expect(typeof cols).toBe('string');
    if (cols !== '*') {
      const selected = String(cols)
        .split(',')
        .map((c) => c.trim());
      for (const c of COLUMNS) expect(selected).toContain(c);
    }
    expect(fake.argsOf('order')).toEqual(['created_at', { ascending: false }]);
    expect(fake.argsOf('limit')).toEqual([20]);
    expect(fake.methods()).not.toContain('insert');
  });

  it.each([
    [0, 1],
    [-5, 1],
    [Number.NaN, 1],
    [1, 1],
    [2.7, 2],
    [499.9, 499],
    [500, 500],
    [501, 500],
    [10000, 500],
  ])('clamps limit %d to %d', async (limit, expected) => {
    const fake = fakeClient({ data: [] });
    await new SupabaseAuditRepo(fake.client).listRecent(limit);
    expect(fake.argsOf('limit')).toEqual([expected]);
  });

  it('maps a full row to a camelCase AuditRecord with a Date', async () => {
    const fake = fakeClient({
      data: [
        row({
          action: 'account.add',
          details: { provider: 'gmail' },
          reason: 'user-cancelled',
          result: 'aborted',
        }),
      ],
    });
    const { records, skipped } = await new SupabaseAuditRepo(fake.client).listRecent(10);
    expect(skipped).toBe(0);
    expect(records).toEqual([
      {
        id: 7,
        userId: USER_ID,
        accountId: ACCOUNT_ID,
        action: 'account.add',
        folder: 'INBOX/Staré',
        messageCount: 12,
        bytes: 345678,
        details: { provider: 'gmail' },
        result: 'aborted',
        reason: 'user-cancelled',
        runId: RUN_ID,
        createdAt: new Date('2026-09-29T06:33:14.123Z'),
      },
    ]);
    expect(records[0]?.createdAt).toBeInstanceOf(Date);
  });

  it('leaves null columns out of the record', async () => {
    const fake = fakeClient({
      data: [
        row({
          account_id: null,
          folder: null,
          message_count: null,
          bytes: null,
          details: null,
          reason: null,
          run_id: null,
        }),
      ],
    });
    const { records } = await new SupabaseAuditRepo(fake.client).listRecent(10);
    expect(records).toHaveLength(1);
    const rec = records[0];
    for (const k of [
      'accountId',
      'folder',
      'messageCount',
      'bytes',
      'details',
      'reason',
      'runId',
    ]) {
      expect(rec).not.toHaveProperty(k);
    }
    expect(rec).toMatchObject({ id: 7, userId: USER_ID, action: 'mail.trash', result: 'ok' });
  });

  it('accepts loose details on read (any JSON object)', async () => {
    const fake = fakeClient({
      data: [
        row({ action: 'account.add', details: { provider: 'gmail', extra: 1 } }),
        row({ id: 8, action: 'mail.trash', details: { foo: 'bar' } }),
        row({ id: 9, action: 'filter.save', details: { filter: { from: 'x' }, n: [1, 2] } }),
      ],
    });
    const { records, skipped } = await new SupabaseAuditRepo(fake.client).listRecent(10);
    expect(skipped).toBe(0);
    expect(records.map((r) => r.details)).toEqual([
      { provider: 'gmail', extra: 1 },
      { foo: 'bar' },
      { filter: { from: 'x' }, n: [1, 2] },
    ]);
  });

  it('skips and counts rows that do not validate, keeping the order of the rest', async () => {
    const fake = fakeClient({
      data: [
        row({ id: 1 }),
        row({ id: 2, action: 'foo.bar' }),
        row({ id: 3, result: 'done' }),
        row({ id: 'abc' }),
        row({ id: 5, user_id: 'not-a-uuid' }),
        row({ id: 6, created_at: 'yesterday' }),
        row({ id: 7, details: 'a string' }),
        row({ id: 8, details: 42 }),
        null,
        'row',
        row({ id: 11, result: 'failed' }),
      ],
    });
    const { records, skipped } = await new SupabaseAuditRepo(fake.client).listRecent(50);
    expect(records.map((r) => r.id)).toEqual([1, 11]);
    expect(skipped).toBe(9);
  });

  it('does not throw when every row is invalid', async () => {
    const fake = fakeClient({ data: [row({ action: 'x' }), row({ result: 'y' })] });
    await expect(new SupabaseAuditRepo(fake.client).listRecent(5)).resolves.toEqual({
      records: [],
      skipped: 2,
    });
  });

  it.each([
    ['42501', 'forbidden'],
    ['XX000', 'unknown'],
  ] as const)('maps query error %s to RepoError(%s) without leaking text', async (code, kind) => {
    const fake = fakeClient({
      error: { code, message: 'LEAKCANARY-msg', details: 'LEAKCANARY-details', hint: 'x' },
    });
    const err = await rejection(new SupabaseAuditRepo(fake.client).listRecent(10));
    expect(err.code).toBe(kind);
    expect(err.message).not.toContain('LEAKCANARY');
  });

  it('maps a network failure on listing to unavailable', async () => {
    const fake = fakeClient({ error: { message: 'TypeError: fetch failed' } });
    const err = await rejection(new SupabaseAuditRepo(fake.client).listRecent(10));
    expect(err.code).toBe('unavailable');
  });
});

describe('createSupabaseServices', () => {
  it('exposes a SupabaseAuditRepo as audit', () => {
    const services = createSupabaseServices(
      {
        SUPABASE_URL: 'https://abcdefghijklmnop.supabase.co',
        SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_TESTKEY123',
      },
      new MemorySessionStorage(),
    );
    expect(services.audit).toBeInstanceOf(SupabaseAuditRepo);
  });
});

// Round 2 (review hardening).

describe('SupabaseAuditRepo.write sends the validated data, not the input', () => {
  it('drops a __proto__ key smuggled into details', async () => {
    const fake = fakeClient();
    const e = JSON.parse(
      '{"action":"account.add","result":"ok","details":{"provider":"gmail","__proto__":{"subject":"CANARY"}}}',
    ) as AuditEntry;
    await new SupabaseAuditRepo(fake.client).write(e);
    const [row] = fake.argsOf('insert');
    const details = (row as { details?: unknown }).details;
    expect(details).toEqual({ provider: 'gmail' });
    expect(Object.keys(details as object)).toEqual(['provider']);
    expect(Object.getPrototypeOf(details)).not.toHaveProperty('subject');
    expect((details as Record<string, unknown>)['subject']).toBeUndefined();
    expect(JSON.stringify(fake.calls)).not.toContain('CANARY');
  });

  it('rejects an entry whose getter throws, without a request', async () => {
    const { client, calls } = noRequestClient();
    const e: Record<string, unknown> = { action: 'backup' };
    Object.defineProperty(e, 'result', {
      enumerable: true,
      get: () => {
        throw new Error('LEAKCANARY getter');
      },
    });
    const err = await rejection(new SupabaseAuditRepo(client).write(e as unknown as AuditEntry));
    expect(err.code).toBe('unknown');
    expect(err.message).toBe('Invalid audit entry');
    expect(calls()).toBe(0);
  });
});

describe('toRepoError (round 2): only well-formed codes in the message', () => {
  it.each([
    ['42501', 'forbidden'],
    ['23505', 'conflict'],
    ['PGRST116', 'not_found'],
    ['XX000', 'unknown'],
    ['PGRST205', 'unknown'],
  ] as const)('shows %s and maps it to %s', (code, kind) => {
    const err = toRepoError({ code, message: 'LEAKCANARY' });
    expect(err.code).toBe(kind);
    expect(err.message).toBe(`Database error: ${kind} (${code})`);
  });

  it.each([
    'X\u001b]0;pwn\u0007',
    'abc',
    '4250',
    '425011',
    'pgrst116',
    'PGRST11',
    'PGRST1166',
    '42501 ',
    '42501\n',
    'LEAKCANARY',
  ])('does not show the code %j', (code) => {
    const err = toRepoError({ code, message: 'something' });
    expect(err.code).toBe('unknown');
    expect(err.message).toBe('Database error: unknown');
  });
});

describe('SupabaseAuditRepo.listRecent with odd data', () => {
  it.each<unknown>([{}, 'rows', 42, true, { 0: {} }])(
    'rejects non-array data %j with RepoError(unknown)',
    async (data) => {
      const fake = fakeClient({ data });
      const err = await rejection(new SupabaseAuditRepo(fake.client).listRecent(10));
      expect(err.code).toBe('unknown');
    },
  );

  it('treats data null as an empty list', async () => {
    const fake = fakeClient({ data: null });
    await expect(new SupabaseAuditRepo(fake.client).listRecent(10)).resolves.toEqual({
      records: [],
      skipped: 0,
    });
  });
});
