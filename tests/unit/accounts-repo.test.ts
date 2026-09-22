import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect } from 'vitest';
import {
  accountToInsertRow,
  rowToAccount,
  SupabaseAccountsRepo,
  toRepoError,
} from '../../src/core/db/supabase/accounts-repo.js';
import type { CapabilityRecord } from '../../src/core/imap/features.js';
import { RepoError } from '../../src/core/db/repos.js';

type NewAccountInput = Parameters<typeof accountToInsertRow>[0];

function validRow(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    user_id: '22222222-2222-4222-8222-222222222222',
    label: 'Work',
    email: 'a@x.sk',
    provider: 'gmail',
    host: 'imap.gmail.com',
    port: 993,
    username: 'a@x.sk',
    auth_type: 'password',
    secret_ciphertext: 'Y2lwaGVy',
    secret_iv: 'aXZpdml2aXZpdml2',
    secret_tag: 'dGFndGFndGFndGFndGFn',
    key_version: 1,
    capabilities: { idle: true },
    created_at: '2026-01-02T03:04:05.000Z',
    updated_at: '2026-02-03T04:05:06.000Z',
    last_checked_at: null,
    ...extra,
  };
}

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected function to throw');
}

describe('rowToAccount', () => {
  it('maps a snake_case row to a camelCase MailAccount', () => {
    const account = rowToAccount(validRow());
    expect(account).toEqual({
      id: '11111111-1111-4111-8111-111111111111',
      userId: '22222222-2222-4222-8222-222222222222',
      label: 'Work',
      email: 'a@x.sk',
      provider: 'gmail',
      host: 'imap.gmail.com',
      port: 993,
      username: 'a@x.sk',
      authType: 'password',
      secret: {
        ciphertext: 'Y2lwaGVy',
        iv: 'aXZpdml2aXZpdml2',
        tag: 'dGFndGFndGFndGFndGFn',
        keyVersion: 1,
      },
      capabilities: { idle: true },
      createdAt: new Date('2026-01-02T03:04:05.000Z'),
      updatedAt: new Date('2026-02-03T04:05:06.000Z'),
      lastCheckedAt: null,
    });
    expect(account.createdAt).toBeInstanceOf(Date);
    expect(account.updatedAt).toBeInstanceOf(Date);
  });

  it('parses last_checked_at to a Date and accepts null capabilities and oauth2', () => {
    const account = rowToAccount(
      validRow({
        last_checked_at: '2026-03-04T05:06:07.000Z',
        capabilities: null,
        auth_type: 'oauth2',
      }),
    );
    expect(account.lastCheckedAt).toEqual(new Date('2026-03-04T05:06:07.000Z'));
    expect(account.capabilities).toBeNull();
    expect(account.authType).toBe('oauth2');
  });

  it.each([
    ['missing id', 'id', undefined],
    ['missing user_id', 'user_id', undefined],
    ['missing secret_ciphertext', 'secret_ciphertext', undefined],
    ['port as string', 'port', '993'],
    ['key_version 0', 'key_version', 0],
    ['unknown auth_type', 'auth_type', 'kerberos'],
    ['capabilities as string', 'capabilities', 'idle'],
    ['created_at as number', 'created_at', 12345],
  ])('throws RepoError(unknown) for %s, naming the field but no values', (_label, field, value) => {
    const CANARY = 'LEAKCANARY-hunter2-ÄŠť';
    const row = validRow({ username: CANARY, label: CANARY });
    if (value === undefined) delete row[field];
    else row[field] = value;
    const err = thrown(() => rowToAccount(row));
    expect(err).toBeInstanceOf(RepoError);
    const repoErr = err as RepoError;
    expect(repoErr.code).toBe('unknown');
    expect(repoErr.message).toContain(field);
    expect(repoErr.message).not.toContain('LEAKCANARY');
    expect(repoErr.message).not.toContain('Y2lwaGVy');
    if (typeof value === 'string') expect(repoErr.message).not.toContain(value);
  });

  it.each([null, undefined, 'row', 42, []])('throws RepoError for non-object %j', (raw) => {
    const err = thrown(() => rowToAccount(raw));
    expect(err).toBeInstanceOf(RepoError);
    expect((err as RepoError).code).toBe('unknown');
  });
});

describe('accountToInsertRow', () => {
  const base = {
    id: '33333333-3333-4333-8333-333333333333',
    userId: '44444444-4444-4444-8444-444444444444',
    email: 'Mixed.Case@Example.SK',
    provider: 'custom',
    host: 'imap.example.sk',
    port: 993,
    username: 'Mixed.Case@Example.SK',
    authType: 'password',
    secret: { ciphertext: 'Y3Q=', iv: 'aXY=', tag: 'dGFn', keyVersion: 2 },
  };

  it('produces a snake_case insert row with a lowercased email and null label', () => {
    const row = accountToInsertRow(base as unknown as NewAccountInput);
    expect(row).toMatchObject({
      id: base.id,
      user_id: base.userId,
      label: null,
      email: 'mixed.case@example.sk',
      provider: 'custom',
      host: 'imap.example.sk',
      port: 993,
      auth_type: 'password',
      secret_ciphertext: 'Y3Q=',
      secret_iv: 'aXY=',
      secret_tag: 'dGFn',
      key_version: 2,
    });
    const keys = Object.keys(row);
    expect(keys).not.toContain('secret');
    expect(keys).not.toContain('userId');
    expect(keys).not.toContain('authType');
  });

  it('keeps an explicit label', () => {
    const row = accountToInsertRow({ ...base, label: 'Home' } as unknown as NewAccountInput);
    expect(row).toMatchObject({ label: 'Home' });
  });
});

describe('toRepoError', () => {
  const SECRET_MSG = 'LEAKCANARY duplicate key value violates unique constraint';

  it.each([
    ['23505', 'conflict'],
    ['42501', 'forbidden'],
    ['PGRST116', 'not_found'],
    ['XX000', 'unknown'],
  ] as const)('maps code %s -> %s', (code, expected) => {
    const err = toRepoError({ code, message: SECRET_MSG });
    expect(err).toBeInstanceOf(RepoError);
    expect(err.code).toBe(expected);
    expect(err.message).not.toContain('LEAKCANARY');
  });

  it.each([
    ['empty code', '', 'TypeError: fetch failed'],
    ['undefined code', undefined, 'network error LEAKCANARY'],
    ['ECONNREFUSED', '', 'connect ECONNREFUSED 127.0.0.1:443 LEAKCANARY'],
    ['ENOTFOUND', undefined, 'getaddrinfo ENOTFOUND abc.supabase.co LEAKCANARY'],
    ['request timeout', '', 'TimeoutError: The operation was aborted due to timeout'],
  ])('maps network failures (%s) to unavailable', (_label, code, message) => {
    const input = code === undefined ? { message } : { code, message };
    const err = toRepoError(input);
    expect(err.code).toBe('unavailable');
    expect(err.message).not.toContain('LEAKCANARY');
    expect(err.message).not.toContain(message);
  });

  it('does not treat a network-looking message with a real code as unavailable', () => {
    expect(toRepoError({ code: '23505', message: 'fetch failed' }).code).toBe('conflict');
  });

  it('maps an empty object to unknown', () => {
    expect(toRepoError({}).code).toBe('unknown');
  });

  it('maps an unrecognised message without code to unknown', () => {
    const err = toRepoError({ message: 'LEAKCANARY something odd' });
    expect(err.code).toBe('unknown');
    expect(err.message).not.toContain('LEAKCANARY');
  });
});

describe('rowToAccount capabilities', () => {
  it('accepts a sanitised capability map (true / non-negative integers)', () => {
    const caps = { UIDPLUS: true, 'STATUS=SIZE': true, APPENDLIMIT: 35_651_584 };
    expect(rowToAccount(validRow({ capabilities: caps })).capabilities).toEqual(caps);
  });

  it.each([
    ['a nested object value', { UIDPLUS: { x: 1 } }],
    ['a string value', { UIDPLUS: 'yes' }],
    ['false', { UIDPLUS: false }],
    ['a negative number', { APPENDLIMIT: -1 }],
    ['a name with a space', { 'UID PLUS': true }],
    ['a name with a control character', { 'UID\nPLUS': true }],
    ['an over-long name', { ['A'.repeat(65)]: true }],
    [
      'too many entries',
      Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`C${i}`, true])),
    ],
  ])('rejects %s', (_label, capabilities) => {
    expect(() => rowToAccount(validRow({ capabilities }))).toThrow(/capabilities/);
  });

  it('never puts a stored capability key into the error message', () => {
    const run = (): unknown => rowToAccount(validRow({ capabilities: { 'CANARY KEY': true } }));
    expect(run).toThrow(RepoError);
    expect(run).not.toThrow(/CANARY/);
  });
});

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

describe('SupabaseAccountsRepo id and capabilities guards', () => {
  const secret = { ciphertext: 'Y2lwaGVy', iv: 'aXZpdml2aXZpdml2', tag: 'dGFn', keyVersion: 1 };
  const caps: CapabilityRecord = { UIDPLUS: true };

  it.each(['', 'not-a-uuid', "1' or '1'='1", '11111111-1111-4111-8111-11111111111', 'id,eq.x'])(
    'non-UUID id %j → no request; get null, others false',
    async (id) => {
      const { client, calls } = noRequestClient();
      const repo = new SupabaseAccountsRepo(client);
      await expect(repo.get(id)).resolves.toBeNull();
      await expect(repo.updateSecret(id, secret)).resolves.toBe(false);
      await expect(repo.recordCheck(id, caps, new Date())).resolves.toBe(false);
      await expect(repo.remove(id)).resolves.toBe(false);
      expect(calls()).toBe(0);
    },
  );

  it('recordCheck rejects an invalid capability record before any request', async () => {
    const { client, calls } = noRequestClient();
    const repo = new SupabaseAccountsRepo(client);
    const bad = { UIDPLUS: 'x' } as unknown as CapabilityRecord;
    await expect(
      repo.recordCheck('11111111-1111-4111-8111-111111111111', bad, new Date()),
    ).rejects.toBeInstanceOf(RepoError);
    expect(calls()).toBe(0);
  });
});
