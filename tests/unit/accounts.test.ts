import { randomBytes } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import {
  AccountError,
  accountFailureReason,
  addAccount,
  assertNotDuplicate,
  assertSecretReadable,
  checkLogin,
  createLocalGuard,
  parseAccountRef,
  removeAccount,
  resolveAccountRef,
  settingsOf,
  shortId,
  testAccount,
  updatePassword,
  knownProvider,
  storedSecretReadable,
} from '../../src/core/accounts.js';
import type { AccountDeps, StoreDeps } from '../../src/core/accounts.js';
import { CredentialError, LocalCredentialProvider } from '../../src/core/credentials.js';
import type { CredentialProvider } from '../../src/core/credentials.js';
import { CryptoError } from '../../src/core/crypto.js';
import type { AccountBinding, EncryptedSecret } from '../../src/core/crypto.js';
import { RepoError } from '../../src/core/db/repos.js';
import type {
  AccountsRepo,
  AuditEntry,
  AuditRepo,
  MailAccount,
  NewMailAccount,
} from '../../src/core/db/repos.js';
import { ImapSessionError } from '../../src/core/imap/errors.js';
import { buildServerFeatures, sanitizeCapabilities } from '../../src/core/imap/features.js';
import type { ImapSession, OpenSessionOptions } from '../../src/core/imap/session.js';
import { MemoryEventLog } from '../../src/core/log/index.js';
import type { LogRecord } from '../../src/core/log/index.js';
import type { ImapSettings } from '../../src/core/providers/settings.js';
import { LoginBlockedError } from '../../src/core/security/login-guard.js';

// M1c-1 accounts core (add / test / update-password / remove), pinned from the spec with a
// fake session opener, in-memory repos and a real LocalCredentialProvider. No network.

const T0 = Date.UTC(2026, 9, 1, 9, 0, 0);
const RUN_ID = '0123456789abcdef';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const ACCOUNT_ID = '3f2a91c0-5d4a-4b6f-9e21-7a8c0d1e2f34';
const OTHER_ID = '3f2a91c0-0000-4000-8000-000000000001';
const HOST = 'imap.example-test-domain.eu';
const EMAIL = 'someone@example-test-domain.eu';
const PASSWORD = 'correct-pw-4c1a';
const SETTINGS: ImapSettings = { host: HOST, port: 993, username: EMAIL };
const CAPS = sanitizeCapabilities({ IMAP4REV1: true, UIDPLUS: true, MOVE: true, IDLE: true });
const FEATURES = buildServerFeatures(CAPS, new Set());
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Opener = (o: OpenSessionOptions) => Promise<ImapSession>;

function fakeSession(): { session: ImapSession; logout: ReturnType<typeof vi.fn> } {
  const logout = vi.fn(() => Promise.resolve());
  const session = { capabilities: CAPS, features: FEATURES, logout } as unknown as ImapSession;
  return { session, logout };
}

function newProvider(version = 1, key: Buffer = randomBytes(32)): LocalCredentialProvider {
  return new LocalCredentialProvider({ masterKey: key, masterKeyVersion: version });
}

function fakeRepo(initial: MailAccount[] = []) {
  const rows = new Map<string, MailAccount>(initial.map((a) => [a.id, a]));
  return {
    rows,
    create: vi.fn<AccountsRepo['create']>((a: NewMailAccount) => {
      const row: MailAccount = {
        id: a.id,
        userId: a.userId,
        label: a.label ?? null,
        email: a.email.toLowerCase(),
        provider: a.provider,
        host: a.host,
        port: a.port,
        username: a.username,
        authType: a.authType,
        secret: a.secret,
        capabilities: null,
        createdAt: new Date(T0),
        updatedAt: new Date(T0),
        lastCheckedAt: null,
      };
      rows.set(a.id, row);
      return Promise.resolve(row);
    }),
    list: vi.fn<AccountsRepo['list']>(() => Promise.resolve([...rows.values()])),
    get: vi.fn<AccountsRepo['get']>((id) => Promise.resolve(rows.get(id) ?? null)),
    findByEmail: vi.fn<AccountsRepo['findByEmail']>((email) =>
      Promise.resolve([...rows.values()].filter((r) => r.email === email.toLowerCase())),
    ),
    updateSecret: vi.fn<AccountsRepo['updateSecret']>((id, secret) => {
      const row = rows.get(id);
      if (row === undefined) return Promise.resolve(false);
      rows.set(id, { ...row, secret });
      return Promise.resolve(true);
    }),
    recordCheck: vi.fn<AccountsRepo['recordCheck']>((id) => Promise.resolve(rows.has(id))),
    remove: vi.fn<AccountsRepo['remove']>((id) => Promise.resolve(rows.delete(id))),
  } satisfies AccountsRepo & { rows: Map<string, MailAccount> };
}

function fakeAudit() {
  const entries: AuditEntry[] = [];
  return {
    entries,
    write: vi.fn<AuditRepo['write']>((e) => {
      entries.push(e);
      return Promise.resolve();
    }),
    listRecent: vi.fn<AuditRepo['listRecent']>(() => Promise.resolve({ records: [], skipped: 0 })),
  } satisfies AuditRepo & { entries: AuditEntry[] };
}

function memoryLog(): MemoryEventLog {
  return new MemoryEventLog({ run: RUN_ID, ver: '0.7.0', now: () => T0, level: 'debug' });
}

/** A saved account whose secret was encrypted under `binding` (defaults: the row's own). */
function storedAccount(
  credentials: CredentialProvider,
  over: Partial<MailAccount> = {},
  binding: Partial<AccountBinding> = {},
  password = PASSWORD,
): MailAccount {
  const base: MailAccount = {
    id: ACCOUNT_ID,
    userId: USER_ID,
    label: null,
    email: EMAIL,
    provider: 'websupport',
    host: HOST,
    port: 993,
    username: EMAIL,
    authType: 'password',
    secret: { ciphertext: '', iv: '', tag: '', keyVersion: 1 },
    capabilities: null,
    createdAt: new Date(T0),
    updatedAt: new Date(T0),
    lastCheckedAt: null,
  };
  const secret = credentials.encryptPassword(
    { userId: USER_ID, accountId: ACCOUNT_ID, host: HOST, port: 993, username: EMAIL, ...binding },
    password,
  );
  return { ...base, secret, ...over };
}

interface SetupOptions {
  open?: Opener;
  accounts?: MailAccount[];
  runId?: string | undefined;
  credentials?: CredentialProvider;
}

function setup(o: SetupOptions = {}) {
  const log = memoryLog();
  const repo = fakeRepo(o.accounts);
  const audit = fakeAudit();
  const credentials = o.credentials ?? newProvider();
  const { session, logout } = fakeSession();
  const open = vi.fn<Opener>(o.open ?? (() => Promise.resolve(session)));
  const onChallenge = vi.fn(() => Promise.resolve());
  const guard = createLocalGuard(randomBytes(32), log);
  const deps: AccountDeps = {
    guard,
    log,
    clientVersion: '9.9.9',
    onChallenge,
    open,
    repo,
    audit,
    credentials,
    runId: 'runId' in o ? o.runId : RUN_ID,
    now: () => T0,
    newId: () => ACCOUNT_ID,
  };
  return { deps, log, repo, audit, credentials, open, onChallenge, logout, guard };
}

type Harness = ReturnType<typeof setup>;

function addInput(over: Partial<Parameters<typeof addAccount>[1]> = {}) {
  return {
    userId: USER_ID,
    email: EMAIL,
    settings: SETTINGS,
    provider: 'websupport',
    password: PASSWORD,
    ...over,
  };
}

const names = (log: MemoryEventLog): string[] => log.records.map((r) => r.event);

function accountRecords(log: MemoryEventLog): LogRecord[] {
  return log.records.filter((r) => r.event.startsWith('account.'));
}

function stripEnvelope(r: LogRecord | undefined): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(r ?? {}).filter(([k]) => !['ts', 'run', 'v'].includes(k)),
  );
}

function rejectWith(err: unknown): Opener {
  return () => Promise.reject(err instanceof Error ? err : new Error(String(err)));
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
}

describe('AccountError', () => {
  it('carries name, code and accountId; it is an Error', () => {
    const e = new AccountError('duplicate', ACCOUNT_ID);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('AccountError');
    expect(e.code).toBe('duplicate');
    expect(e.accountId).toBe(ACCOUNT_ID);
    expect(new AccountError('not-found').accountId).toBeUndefined();
  });
});

describe('shortId / parseAccountRef / resolveAccountRef', () => {
  it('shortId → first 8 characters', () => {
    expect(shortId(ACCOUNT_ID)).toBe('3f2a91c0');
  });

  it.each([
    ['3F2A', '3f2a'],
    [' 3f2a91c0 ', '3f2a91c0'],
    [ACCOUNT_ID, ACCOUNT_ID],
    [ACCOUNT_ID.toUpperCase(), ACCOUNT_ID],
    ['3f2a-91', '3f2a-91'],
  ])('parseAccountRef(%j) → %j', (ref, want) => {
    expect(parseAccountRef(ref)).toBe(want);
  });

  it.each<unknown>(['3f2', 'zz12', `${ACCOUNT_ID}0`, '', '   ', '3f2a 91', 1234, null, undefined])(
    'parseAccountRef(%j) → null',
    (ref) => {
      expect(parseAccountRef(ref)).toBeNull();
    },
  );

  const p = newProvider();
  const a = storedAccount(p);
  const b = storedAccount(p, { id: OTHER_ID });
  const c = storedAccount(p, { id: '9b1c0d2e-1111-4111-8111-111111111111' });

  it('found by a 4+ character prefix, case-insensitive, or the full id', () => {
    expect(resolveAccountRef([a, c], '3F2A')).toEqual({ kind: 'found', account: a });
    expect(resolveAccountRef([a, c], '9b1c0d2e')).toEqual({ kind: 'found', account: c });
    expect(resolveAccountRef([a, b, c], ACCOUNT_ID)).toEqual({ kind: 'found', account: a });
  });

  it('none when nothing matches', () => {
    expect(resolveAccountRef([a, c], 'abcd')).toEqual({ kind: 'none' });
    expect(resolveAccountRef([], '3f2a')).toEqual({ kind: 'none' });
  });

  it('ambiguous with a count when ids share the prefix', () => {
    expect(resolveAccountRef([a, b, c], '3f2a91c0')).toEqual({ kind: 'ambiguous', count: 2 });
  });

  it.each<unknown>(['3f2', 'zz12', '', 42, null])('invalid ref %j', (ref) => {
    expect(resolveAccountRef([a, b, c], ref)).toEqual({ kind: 'invalid' });
  });
});

describe('settingsOf', () => {
  const p = newProvider();

  it('returns host, port 993 and username', () => {
    expect(settingsOf(storedAccount(p))).toEqual({ host: HOST, port: 993, username: EMAIL });
  });

  it.each([
    ['port 143', { port: 143 }],
    ['port 995', { port: 995 }],
    ['oauth2', { authType: 'oauth2' as const }],
  ])('%s → AccountError(unsupported)', (_name, over) => {
    const err = (() => {
      try {
        settingsOf(storedAccount(p, over));
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(err).toBeInstanceOf(AccountError);
    expect(err).toMatchObject({ code: 'unsupported' });
  });
});

describe('accountFailureReason', () => {
  it.each<[string, unknown, string]>([
    ['ImapSessionError(auth-failed)', new ImapSessionError('auth-failed'), 'auth-failed'],
    ['ImapSessionError(timeout)', new ImapSessionError('timeout', 'ETIMEDOUT'), 'timeout'],
    ['LoginBlockedError', new LoginBlockedError('too-many-attempts', new Date(T0)), 'blocked'],
    ['AccountError(duplicate)', new AccountError('duplicate'), 'duplicate'],
    ['AccountError(not-found)', new AccountError('not-found'), 'not-found'],
    ['AccountError(unsupported)', new AccountError('unsupported'), 'unsupported'],
    ['AccountError(secret-unreadable)', new AccountError('secret-unreadable'), 'secret-unreadable'],
    ['RepoError(conflict)', new RepoError('conflict', 'x'), 'database'],
    ['RepoError(unavailable)', new RepoError('unavailable', 'x'), 'database'],
    ['CredentialError', new CredentialError('x'), 'secret-unreadable'],
    ['CryptoError', new CryptoError('x'), 'secret-unreadable'],
    ['Error', new Error('boom'), 'unexpected'],
    ['TypeError', new TypeError('boom'), 'unexpected'],
    ['a string', 'boom', 'unexpected'],
    ['null', null, 'unexpected'],
    ['undefined', undefined, 'unexpected'],
  ])('%s → %s', (_name, err, want) => {
    expect(accountFailureReason(err)).toBe(want);
  });
});

describe('createLocalGuard / checkLogin', () => {
  it('logs in with clientIp local, returns capabilities + features, always logs out', async () => {
    const h = setup();
    const got = await checkLogin(h.deps, {
      settings: SETTINGS,
      password: PASSWORD,
      provider: 'websupport',
    });
    expect(got).toEqual({ capabilities: CAPS, features: FEATURES });
    expect(h.open).toHaveBeenCalledTimes(1);
    expect(h.open.mock.calls[0]?.[0]).toMatchObject({
      settings: SETTINGS,
      password: PASSWORD,
      clientVersion: '9.9.9',
    });
    expect(h.logout).toHaveBeenCalledTimes(1);
    expect(h.log.records).toHaveLength(1);
    expect(h.log.records[0]).toMatchObject({ event: 'imap.login', ip: 'local' });
    expect(Object.keys(h.log.records[0] ?? {})).not.toContain('acct');
  });

  it('passes acct through to the imap.login event', async () => {
    const h = setup();
    await checkLogin(h.deps, {
      settings: SETTINGS,
      password: PASSWORD,
      provider: 'websupport',
      acct: ACCOUNT_ID,
    });
    expect(h.log.records[0]).toMatchObject({ event: 'imap.login', acct: ACCOUNT_ID });
  });

  it('a failed login rejects with the ImapSessionError and emits imap.login-failed', async () => {
    const h = setup({ open: rejectWith(new ImapSessionError('auth-failed')) });
    const err = await caught(
      checkLogin(h.deps, { settings: SETTINGS, password: 'wrong', provider: 'websupport' }),
    );
    expect(err).toBeInstanceOf(ImapSessionError);
    expect(names(h.log)).toEqual(['imap.login-failed']);
  });

  it('works without a master key (random target key)', async () => {
    const log = memoryLog();
    const guard = createLocalGuard(undefined, log);
    const { session } = fakeSession();
    await checkLogin(
      {
        guard,
        log,
        clientVersion: '9.9.9',
        onChallenge: () => Promise.resolve(),
        open: () => Promise.resolve(session),
      },
      { settings: SETTINGS, password: PASSWORD, provider: 'websupport' },
    );
    expect(names(log)).toEqual(['imap.login']);
  });
});

describe('assertNotDuplicate', () => {
  it('no matching row → resolves, nothing emitted or written', async () => {
    const h = setup();
    await expect(
      assertNotDuplicate(h.deps, { email: EMAIL, host: HOST, provider: 'websupport' }),
    ).resolves.toBeUndefined();
    expect(h.log.records).toEqual([]);
    expect(h.audit.entries).toEqual([]);
  });

  it('same email (any case) and same host (any case) → event, failed audit row, AccountError', async () => {
    const existing = storedAccount(newProvider(), { id: OTHER_ID });
    const h = setup({ accounts: [existing] });
    const err = await caught(
      assertNotDuplicate(h.deps, {
        email: EMAIL.toUpperCase(),
        host: HOST.toUpperCase(),
        provider: 'websupport',
      }),
    );
    expect(err).toBeInstanceOf(AccountError);
    expect(err).toMatchObject({ code: 'duplicate', accountId: OTHER_ID });
    expect(accountRecords(h.log).map(stripEnvelope)).toEqual([
      {
        event: 'account.add',
        provider: 'websupport',
        outcome: 'failed',
        reason: 'duplicate',
        level: 'warn',
      },
    ]);
    expect(h.audit.entries).toHaveLength(1);
    expect(h.audit.entries[0]).toMatchObject({
      action: 'account.add',
      result: 'failed',
      reason: 'duplicate',
    });
    // A failed add has no account yet: provider only, no `account` key.
    expect(h.audit.entries[0]?.details).toStrictEqual({ provider: 'websupport' });
    expect(h.audit.entries[0]?.accountId).toBeUndefined();
  });

  it('same email on another host is not a duplicate', async () => {
    const existing = storedAccount(newProvider(), { id: OTHER_ID });
    const h = setup({ accounts: [existing] });
    await expect(
      assertNotDuplicate(h.deps, {
        email: EMAIL,
        host: 'imap2.example-test-domain.eu',
        provider: 'websupport',
      }),
    ).resolves.toBeUndefined();
    expect(h.audit.entries).toEqual([]);
  });
});

describe('addAccount', () => {
  it('success: login, encrypt, create, recordCheck, ok audit row, ok event; returns the row', async () => {
    const h = setup();
    const created = await addAccount(h.deps, addInput());

    expect(h.open).toHaveBeenCalledTimes(1);
    expect(h.open.mock.calls[0]?.[0]).toMatchObject({ settings: SETTINGS, password: PASSWORD });
    expect(h.logout).toHaveBeenCalledTimes(1);

    expect(h.repo.create).toHaveBeenCalledTimes(1);
    const input = h.repo.create.mock.calls[0]?.[0];
    expect(input).toEqual({
      id: ACCOUNT_ID,
      userId: USER_ID,
      email: EMAIL,
      provider: 'websupport',
      host: HOST,
      port: 993,
      username: EMAIL,
      authType: 'password',
      secret: expect.any(Object) as EncryptedSecret,
    });
    const row = h.repo.rows.get(ACCOUNT_ID);
    expect(created).toEqual(row);

    expect(h.repo.recordCheck).toHaveBeenCalledTimes(1);
    const [checkId, caps, checkedAt] = h.repo.recordCheck.mock.calls[0] ?? [];
    expect(checkId).toBe(ACCOUNT_ID);
    expect(caps).toEqual(CAPS);
    expect(checkedAt).toBeInstanceOf(Date);
    expect(checkedAt?.getTime()).toBe(T0);

    expect(h.audit.entries).toEqual([
      {
        accountId: ACCOUNT_ID,
        action: 'account.add',
        details: { provider: 'websupport', account: ACCOUNT_ID },
        result: 'ok',
        runId: RUN_ID,
      },
    ]);
    expect(accountRecords(h.log).map(stripEnvelope)).toEqual([
      {
        event: 'account.add',
        acct: ACCOUNT_ID,
        provider: 'websupport',
        outcome: 'ok',
        level: 'info',
      },
    ]);
  });

  it('the stored secret decrypts with the created row, and is bound to host/port/username', async () => {
    const h = setup();
    await addAccount(h.deps, addInput());
    const row = h.repo.rows.get(ACCOUNT_ID);
    if (row === undefined) throw new Error('row not created');
    expect(h.credentials.decryptPassword(row)).toBe(PASSWORD);
    for (const changed of [
      { host: 'imap.other-domain.example' },
      { port: 995 },
      { username: 'other@example-test-domain.eu' },
      { userId: '33333333-3333-4333-8333-333333333333' },
      { id: OTHER_ID },
    ]) {
      expect(() => h.credentials.decryptPassword({ ...row, ...changed })).toThrow(CryptoError);
    }
  });

  it('without runId the ok audit row has none', async () => {
    const h = setup({ runId: undefined });
    await addAccount(h.deps, addInput());
    expect(h.audit.entries).toHaveLength(1);
    expect(h.audit.entries[0]).toEqual({
      accountId: ACCOUNT_ID,
      action: 'account.add',
      details: { provider: 'websupport', account: ACCOUNT_ID },
      result: 'ok',
    });
    expect(h.audit.entries[0]?.runId).toBeUndefined();
  });

  it('an odd provider is recorded as custom (audit details and event)', async () => {
    const h = setup();
    await addAccount(h.deps, addInput({ provider: 'Bad Provider!' }));
    expect(h.audit.entries[0]?.details).toEqual({ provider: 'custom', account: ACCOUNT_ID });
    expect(accountRecords(h.log)[0]).toMatchObject({ provider: 'custom', outcome: 'ok' });
  });

  it('the id defaults to a random UUID', async () => {
    const h = setup();
    delete h.deps.newId;
    const created = await addAccount(h.deps, addInput());
    expect(created.id).toMatch(UUID_RE);
    expect(created.id).not.toBe(ACCOUNT_ID);
    expect(h.audit.entries[0]?.accountId).toBe(created.id);
    const row = h.repo.rows.get(created.id);
    if (row === undefined) throw new Error('row not created');
    expect(h.credentials.decryptPassword(row)).toBe(PASSWORD);
  });

  it.each<[string, (h: Harness) => void]>([
    [
      'recordCheck throws',
      (h) => h.repo.recordCheck.mockRejectedValue(new RepoError('unavailable', 'x')),
    ],
    ['recordCheck returns false', (h) => h.repo.recordCheck.mockResolvedValue(false)],
  ])('%s → add still succeeds', async (_name, arrange) => {
    const h = setup();
    arrange(h);
    await expect(addAccount(h.deps, addInput())).resolves.toMatchObject({ id: ACCOUNT_ID });
    expect(h.audit.entries).toHaveLength(1);
    expect(h.audit.entries[0]).toMatchObject({ result: 'ok' });
    expect(accountRecords(h.log)[0]).toMatchObject({ outcome: 'ok' });
  });

  it('duplicate → one failed event + audit row, AccountError(existing id), no open', async () => {
    const existing = storedAccount(newProvider(), { id: OTHER_ID });
    const h = setup({ accounts: [existing] });
    const err = await caught(
      addAccount(
        h.deps,
        addInput({
          email: EMAIL.toUpperCase(),
          settings: { ...SETTINGS, host: HOST.toUpperCase() },
        }),
      ),
    );
    expect(err).toBeInstanceOf(AccountError);
    expect(err).toMatchObject({ code: 'duplicate', accountId: OTHER_ID });
    expect(h.open).not.toHaveBeenCalled();
    expect(h.repo.create).not.toHaveBeenCalled();
    expect(accountRecords(h.log).map(stripEnvelope)).toEqual([
      {
        event: 'account.add',
        provider: 'websupport',
        outcome: 'failed',
        reason: 'duplicate',
        level: 'warn',
      },
    ]);
    expect(h.audit.entries).toHaveLength(1);
    expect(h.audit.entries[0]).toMatchObject({
      action: 'account.add',
      result: 'failed',
      reason: 'duplicate',
    });
    // A failed add has no account yet: provider only, no `account` key.
    expect(h.audit.entries[0]?.details).toStrictEqual({ provider: 'websupport' });
    expect(h.audit.entries[0]?.accountId).toBeUndefined();
  });

  it('same email on another host → added', async () => {
    const existing = storedAccount(newProvider(), { id: OTHER_ID });
    const h = setup({ accounts: [existing] });
    const host = 'imap2.example-test-domain.eu';
    await addAccount(h.deps, addInput({ settings: { ...SETTINGS, host } }));
    expect(h.repo.create).toHaveBeenCalledTimes(1);
    expect(h.repo.create.mock.calls[0]?.[0]).toMatchObject({ host });
  });

  it('login fails → nothing created, failed event + audit, original error rethrown', async () => {
    const original = new ImapSessionError('auth-failed');
    const h = setup({ open: rejectWith(original) });
    const err = await caught(addAccount(h.deps, addInput({ password: 'wrong' })));
    expect(err).toBe(original);
    expect(h.repo.create).not.toHaveBeenCalled();
    expect(h.repo.recordCheck).not.toHaveBeenCalled();
    expect(h.repo.rows.size).toBe(0);
    expect(accountRecords(h.log).map(stripEnvelope)).toEqual([
      {
        event: 'account.add',
        provider: 'websupport',
        outcome: 'failed',
        reason: 'auth-failed',
        level: 'warn',
      },
    ]);
    expect(h.audit.entries).toHaveLength(1);
    expect(h.audit.entries[0]).toMatchObject({
      action: 'account.add',
      result: 'failed',
      reason: 'auth-failed',
    });
    // A failed add has no account yet: provider only, no `account` key.
    expect(h.audit.entries[0]?.details).toStrictEqual({ provider: 'websupport' });
    expect(h.audit.entries[0]?.accountId).toBeUndefined();
  });

  it('the login carries no acct (imap.login-failed has none)', async () => {
    const h = setup({ open: rejectWith(new ImapSessionError('auth-failed')) });
    await caught(addAccount(h.deps, addInput()));
    const failed = h.log.records.find((r) => r.event === 'imap.login-failed');
    expect(failed).toBeDefined();
    expect(Object.keys(failed ?? {})).not.toContain('acct');
  });

  it('encrypt throws → secret-unreadable event + audit, error rethrown, session logged out', async () => {
    const boom = new CryptoError('Key must be 32 bytes');
    const credentials: CredentialProvider = {
      encryptPassword: () => {
        throw boom;
      },
      decryptPassword: () => PASSWORD,
    };
    const h = setup({ credentials });
    const err = await caught(addAccount(h.deps, addInput()));
    expect(err).toBe(boom);
    expect(h.logout).toHaveBeenCalledTimes(1);
    expect(h.repo.create).not.toHaveBeenCalled();
    expect(accountRecords(h.log)).toHaveLength(1);
    expect(accountRecords(h.log)[0]).toMatchObject({
      outcome: 'failed',
      reason: 'secret-unreadable',
    });
    expect(h.audit.entries).toHaveLength(1);
    expect(h.audit.entries[0]).toMatchObject({ result: 'failed', reason: 'secret-unreadable' });
    expect(h.audit.entries[0]?.accountId).toBeUndefined();
  });

  it('create throws RepoError(unavailable) → database, rethrown as-is, session logged out', async () => {
    const h = setup();
    const down = new RepoError('unavailable', 'Database unavailable');
    h.repo.create.mockRejectedValue(down);
    const err = await caught(addAccount(h.deps, addInput()));
    expect(err).toBe(down);
    expect(h.logout).toHaveBeenCalledTimes(1);
    expect(h.repo.recordCheck).not.toHaveBeenCalled();
    expect(accountRecords(h.log)).toHaveLength(1);
    expect(accountRecords(h.log)[0]).toMatchObject({ outcome: 'failed', reason: 'database' });
    expect(Object.keys(accountRecords(h.log)[0] ?? {})).not.toContain('acct');
    expect(h.audit.entries).toHaveLength(1);
    expect(h.audit.entries[0]).toMatchObject({ result: 'failed', reason: 'database' });
    expect(h.audit.entries[0]?.accountId).toBeUndefined();
  });

  it('create conflict → AccountError(duplicate) without an id', async () => {
    const h = setup();
    h.repo.create.mockRejectedValue(new RepoError('conflict', 'Account already exists'));
    const err = await caught(addAccount(h.deps, addInput()));
    expect(err).toBeInstanceOf(AccountError);
    expect(err).toMatchObject({ code: 'duplicate' });
    expect((err as AccountError).accountId).toBeUndefined();
    expect(accountRecords(h.log)).toHaveLength(1);
    expect(accountRecords(h.log)[0]).toMatchObject({ outcome: 'failed', reason: 'duplicate' });
    expect(h.audit.entries).toHaveLength(1);
    expect(h.audit.entries[0]).toMatchObject({ result: 'failed', reason: 'duplicate' });
  });

  it('findByEmail throws → database, rethrown, no login', async () => {
    const h = setup();
    const down = new RepoError('unavailable', 'Database unavailable');
    h.repo.findByEmail.mockRejectedValue(down);
    const err = await caught(addAccount(h.deps, addInput()));
    expect(err).toBe(down);
    expect(h.open).not.toHaveBeenCalled();
    expect(accountRecords(h.log)).toHaveLength(1);
    expect(accountRecords(h.log)[0]).toMatchObject({ outcome: 'failed', reason: 'database' });
    expect(h.audit.entries).toHaveLength(1);
    expect(h.audit.entries[0]).toMatchObject({ result: 'failed', reason: 'database' });
  });

  it('login guard: 4 auth-failed, the 5th blocks after open ran 5 times, the 6th never opens', async () => {
    const order: string[] = [];
    const h = setup({
      open: () => {
        order.push('open');
        return Promise.reject(new ImapSessionError('auth-failed'));
      },
    });
    h.onChallenge.mockImplementation(async () => {
      await Promise.resolve();
      order.push('challenge');
    });

    for (let i = 1; i <= 4; i++) {
      const err = await caught(addAccount(h.deps, addInput({ password: `wrong-${i}` })));
      expect(err).toBeInstanceOf(ImapSessionError);
      expect(err).toMatchObject({ reason: 'auth-failed' });
    }
    const fifth = await caught(addAccount(h.deps, addInput({ password: 'wrong-5' })));
    expect(fifth).toBeInstanceOf(LoginBlockedError);
    expect(h.open).toHaveBeenCalledTimes(5);

    const sixth = await caught(addAccount(h.deps, addInput({ password: PASSWORD })));
    expect(sixth).toBeInstanceOf(LoginBlockedError);
    expect(h.open).toHaveBeenCalledTimes(5);

    // LOGIN_POLICY: 2 free attempts, then the challenge is awaited before attempts 3–5.
    expect(order).toEqual([
      'open',
      'open',
      'challenge',
      'open',
      'challenge',
      'open',
      'challenge',
      'open',
    ]);
    expect(h.onChallenge).toHaveBeenCalledTimes(3);
    expect(h.repo.create).not.toHaveBeenCalled();

    expect(accountRecords(h.log).map((r) => r['reason'])).toEqual([
      'auth-failed',
      'auth-failed',
      'auth-failed',
      'auth-failed',
      'blocked',
      'blocked',
    ]);
    expect(h.audit.entries.map((e) => e.reason)).toEqual([
      'auth-failed',
      'auth-failed',
      'auth-failed',
      'auth-failed',
      'blocked',
      'blocked',
    ]);
  });
});

describe('security events go through the same log', () => {
  it('imap.login-failed, login-guard.challenge and login-guard.block, then imap.login', async () => {
    let fail = true;
    const { session } = fakeSession();
    const h = setup({
      open: () =>
        fail ? Promise.reject(new ImapSessionError('auth-failed')) : Promise.resolve(session),
    });
    for (let i = 0; i < 5; i++) await caught(addAccount(h.deps, addInput({ password: 'wrong' })));
    const got = names(h.log);
    expect(got.filter((n) => n === 'imap.login-failed')).toHaveLength(5);
    expect(got.filter((n) => n === 'login-guard.challenge')).toHaveLength(3);
    expect(got.filter((n) => n === 'login-guard.block')).toHaveLength(1);
    expect(got.indexOf('login-guard.block')).toBeGreaterThan(got.lastIndexOf('imap.login-failed'));
    expect(h.log.lines.filter((l) => l.startsWith('mm-security {'))).toHaveLength(9);

    // A different mailbox (fresh pair) logs in fine through the same guard and log.
    fail = false;
    await addAccount(
      h.deps,
      addInput({
        email: 'other@example-test-domain.eu',
        settings: { ...SETTINGS, username: 'other@example-test-domain.eu' },
      }),
    );
    expect(names(h.log)).toContain('imap.login');
  });
});

describe('testAccount', () => {
  it('success: login with the decrypted password and acct, recordCheck, ok event, features', async () => {
    const credentials = newProvider();
    const account = storedAccount(credentials);
    const h = setup({ credentials, accounts: [account] });
    await expect(testAccount(h.deps, account)).resolves.toEqual({ features: FEATURES });
    expect(h.open).toHaveBeenCalledTimes(1);
    expect(h.open.mock.calls[0]?.[0]).toMatchObject({ settings: SETTINGS, password: PASSWORD });
    expect(h.logout).toHaveBeenCalledTimes(1);
    const login = h.log.records.find((r) => r.event === 'imap.login');
    expect(login).toMatchObject({ acct: ACCOUNT_ID, provider: 'websupport', ip: 'local' });

    expect(h.repo.recordCheck).toHaveBeenCalledTimes(1);
    const [id, caps, at] = h.repo.recordCheck.mock.calls[0] ?? [];
    expect(id).toBe(ACCOUNT_ID);
    expect(caps).toEqual(CAPS);
    expect(at).toBeInstanceOf(Date);
    expect(at?.getTime()).toBe(T0);

    expect(accountRecords(h.log).map(stripEnvelope)).toEqual([
      {
        event: 'account.test',
        acct: ACCOUNT_ID,
        provider: 'websupport',
        outcome: 'ok',
        level: 'info',
      },
    ]);
    expect(h.audit.entries).toEqual([]);
    expect(h.audit.write).not.toHaveBeenCalled();
  });

  it('recordCheck throwing is ignored', async () => {
    const credentials = newProvider();
    const account = storedAccount(credentials);
    const h = setup({ credentials, accounts: [account] });
    h.repo.recordCheck.mockRejectedValue(new RepoError('unknown', 'x'));
    await expect(testAccount(h.deps, account)).resolves.toEqual({ features: FEATURES });
    expect(accountRecords(h.log)[0]).toMatchObject({ outcome: 'ok' });
  });

  it('a failed login → failed event with the reason, rethrown, no audit', async () => {
    const credentials = newProvider();
    const account = storedAccount(credentials);
    const original = new ImapSessionError('timeout', 'ETIMEDOUT');
    const h = setup({ credentials, accounts: [account], open: rejectWith(original) });
    const err = await caught(testAccount(h.deps, account));
    expect(err).toBe(original);
    expect(h.repo.recordCheck).not.toHaveBeenCalled();
    expect(accountRecords(h.log).map(stripEnvelope)).toEqual([
      {
        event: 'account.test',
        acct: ACCOUNT_ID,
        provider: 'websupport',
        outcome: 'failed',
        reason: 'timeout',
        level: 'warn',
      },
    ]);
    expect(h.audit.write).not.toHaveBeenCalled();
  });

  const key = randomBytes(32);
  const cases: [string, () => { credentials: CredentialProvider; account: MailAccount }][] = [
    [
      'another key version (CredentialError)',
      () => ({ credentials: newProvider(2, key), account: storedAccount(newProvider(1, key)) }),
    ],
    [
      'another key (CryptoError)',
      () => ({ credentials: newProvider(1), account: storedAccount(newProvider(1)) }),
    ],
    [
      'tampered ciphertext',
      () => {
        const p = newProvider();
        const a = storedAccount(p);
        const bytes = Buffer.from(a.secret.ciphertext, 'base64');
        bytes[0] = (bytes[0] ?? 0) ^ 0xff;
        return {
          credentials: p,
          account: { ...a, secret: { ...a.secret, ciphertext: bytes.toString('base64') } },
        };
      },
    ],
    [
      'host changed after encryption',
      () => {
        const p = newProvider();
        return { credentials: p, account: storedAccount(p, { host: 'imap.evil.example' }) };
      },
    ],
    [
      'port changed after encryption (bound to 995, row says 993)',
      () => {
        const p = newProvider();
        return { credentials: p, account: storedAccount(p, {}, { port: 995 }) };
      },
    ],
    [
      'username changed after encryption',
      () => {
        const p = newProvider();
        return {
          credentials: p,
          account: storedAccount(p, { username: 'other@example-test-domain.eu' }),
        };
      },
    ],
  ];

  it.each(cases)('%s → AccountError(secret-unreadable), no open', async (_name, make) => {
    const { credentials, account } = make();
    const h = setup({ credentials, accounts: [account] });
    const err = await caught(testAccount(h.deps, account));
    expect(err).toBeInstanceOf(AccountError);
    expect(err).toMatchObject({ code: 'secret-unreadable' });
    expect(h.open).not.toHaveBeenCalled();
    expect(accountRecords(h.log).map(stripEnvelope)).toEqual([
      {
        event: 'account.test',
        acct: ACCOUNT_ID,
        provider: 'websupport',
        outcome: 'failed',
        reason: 'secret-unreadable',
        level: 'warn',
      },
    ]);
    expect(h.audit.write).not.toHaveBeenCalled();
  });

  it.each([
    ['port 143', { port: 143 }],
    ['oauth2', { authType: 'oauth2' as const }],
  ])('%s → AccountError(unsupported), no open, failed event', async (_name, over) => {
    const credentials = newProvider();
    const account = storedAccount(credentials, over);
    const h = setup({ credentials, accounts: [account] });
    const err = await caught(testAccount(h.deps, account));
    expect(err).toBeInstanceOf(AccountError);
    expect(err).toMatchObject({ code: 'unsupported' });
    expect(h.open).not.toHaveBeenCalled();
    expect(accountRecords(h.log)).toHaveLength(1);
    expect(accountRecords(h.log)[0]).toMatchObject({
      event: 'account.test',
      outcome: 'failed',
      reason: 'unsupported',
    });
    expect(h.audit.write).not.toHaveBeenCalled();
  });
});

describe('updatePassword', () => {
  const NEW_PASSWORD = 'new-pw-7e2b';

  it('logs in with the NEW password first; on success stores a secret bound to the row', async () => {
    const credentials = newProvider();
    const account = storedAccount(credentials);
    const h = setup({ credentials, accounts: [account] });
    await expect(updatePassword(h.deps, account, NEW_PASSWORD)).resolves.toBeUndefined();

    expect(h.open).toHaveBeenCalledTimes(1);
    expect(h.open.mock.calls[0]?.[0]).toMatchObject({ settings: SETTINGS, password: NEW_PASSWORD });
    expect(h.logout).toHaveBeenCalledTimes(1);
    expect(h.open.mock.invocationCallOrder[0]).toBeLessThan(
      h.repo.updateSecret.mock.invocationCallOrder[0] ?? 0,
    );

    expect(h.repo.updateSecret).toHaveBeenCalledTimes(1);
    const [id, secret] = h.repo.updateSecret.mock.calls[0] ?? [];
    expect(id).toBe(ACCOUNT_ID);
    if (secret === undefined) throw new Error('no secret');
    expect(credentials.decryptPassword({ ...account, secret })).toBe(NEW_PASSWORD);
    expect(() =>
      credentials.decryptPassword({ ...account, secret, host: 'imap.evil.example' }),
    ).toThrow(CryptoError);

    expect(h.audit.entries).toEqual([
      {
        accountId: ACCOUNT_ID,
        action: 'account.password-update',
        details: { provider: 'websupport', account: ACCOUNT_ID },
        result: 'ok',
        runId: RUN_ID,
      },
    ]);
    expect(accountRecords(h.log).map(stripEnvelope)).toEqual([
      {
        event: 'account.password-update',
        acct: ACCOUNT_ID,
        provider: 'websupport',
        outcome: 'ok',
        level: 'info',
      },
    ]);
  });

  it('a failed login leaves the stored secret untouched, failed event, no audit', async () => {
    const credentials = newProvider();
    const account = storedAccount(credentials);
    const original = new ImapSessionError('auth-failed');
    const h = setup({ credentials, accounts: [account], open: rejectWith(original) });
    const err = await caught(updatePassword(h.deps, account, NEW_PASSWORD));
    expect(err).toBe(original);
    expect(h.repo.updateSecret).not.toHaveBeenCalled();
    expect(h.repo.rows.get(ACCOUNT_ID)?.secret).toEqual(account.secret);
    expect(accountRecords(h.log).map(stripEnvelope)).toEqual([
      {
        event: 'account.password-update',
        acct: ACCOUNT_ID,
        provider: 'websupport',
        outcome: 'failed',
        reason: 'auth-failed',
        level: 'warn',
      },
    ]);
    expect(h.audit.write).not.toHaveBeenCalled();
  });

  it('updateSecret returns false → AccountError(not-found), failed event, no ok audit', async () => {
    const credentials = newProvider();
    const account = storedAccount(credentials);
    const h = setup({ credentials, accounts: [account] });
    h.repo.updateSecret.mockResolvedValue(false);
    const err = await caught(updatePassword(h.deps, account, NEW_PASSWORD));
    expect(err).toBeInstanceOf(AccountError);
    expect(err).toMatchObject({ code: 'not-found' });
    expect(accountRecords(h.log)).toHaveLength(1);
    expect(accountRecords(h.log)[0]).toMatchObject({ outcome: 'failed', reason: 'not-found' });
    expect(h.audit.entries.filter((e) => e.result === 'ok')).toEqual([]);
  });
});

describe('removeAccount', () => {
  it('needs only StoreDeps; success → audit row without accountId, ok event with acct', async () => {
    const account = storedAccount(newProvider());
    const repo = fakeRepo([account]);
    const audit = fakeAudit();
    const log = memoryLog();
    const store: StoreDeps = { repo, audit, log, runId: RUN_ID };
    await expect(removeAccount(store, account)).resolves.toBeUndefined();
    expect(repo.remove).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(repo.rows.size).toBe(0);
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({ action: 'account.remove', result: 'ok' });
    // `account_id` is null after the delete; the UUID stays in `details.account`.
    expect(audit.entries[0]?.details).toStrictEqual({
      provider: 'websupport',
      account: ACCOUNT_ID,
    });
    expect(audit.entries[0]?.accountId).toBeUndefined();
    expect(accountRecords(log).map(stripEnvelope)).toEqual([
      {
        event: 'account.remove',
        acct: ACCOUNT_ID,
        provider: 'websupport',
        outcome: 'ok',
        level: 'info',
      },
    ]);
  });

  it('remove returns false → AccountError(not-found), failed event, no audit', async () => {
    const account = storedAccount(newProvider());
    const h = setup();
    const err = await caught(removeAccount(h.deps, account));
    expect(err).toBeInstanceOf(AccountError);
    expect(err).toMatchObject({ code: 'not-found' });
    expect(accountRecords(h.log).map(stripEnvelope)).toEqual([
      {
        event: 'account.remove',
        acct: ACCOUNT_ID,
        provider: 'websupport',
        outcome: 'failed',
        reason: 'not-found',
        level: 'warn',
      },
    ]);
    expect(h.audit.write).not.toHaveBeenCalled();
  });
});

describe('canary: no password, address, domain or host in any log line or audit row', () => {
  it('add (failed + ok + duplicate), test, update-password (failed + ok), remove', async () => {
    const password = 'hunter2-ÄŠť';
    const address = 'canary@secret-domain.example';
    const domain = 'secret-domain.example';
    const host = 'imap.secret-host.example';
    const settings: ImapSettings = { host, port: 993, username: address };
    let fail = true;
    const { session } = fakeSession();
    const h = setup({
      open: () =>
        fail
          ? Promise.reject(new ImapSessionError('auth-failed', 'AUTHENTICATIONFAILED'))
          : Promise.resolve(session),
    });
    const input = addInput({ email: address, settings, password, provider: 'custom' });
    const errors: unknown[] = [];

    errors.push(await caught(addAccount(h.deps, input)));
    fail = false;
    const created = await addAccount(h.deps, input);
    errors.push(await caught(addAccount(h.deps, input)));
    await testAccount(h.deps, created);
    fail = true;
    errors.push(await caught(updatePassword(h.deps, created, `${password}-new`)));
    fail = false;
    await updatePassword(h.deps, created, `${password}-new`);
    const current = h.repo.rows.get(created.id) ?? created;
    await removeAccount(h.deps, current);
    errors.push(await caught(removeAccount(h.deps, current)));

    const kinds = new Set(names(h.log));
    for (const n of [
      'account.add',
      'account.test',
      'account.password-update',
      'account.remove',
      'imap.login',
      'imap.login-failed',
    ]) {
      expect(kinds).toContain(n);
    }

    const text = [
      h.log.lines.join('\n'),
      JSON.stringify(h.audit.entries),
      ...errors.map((e) => (e instanceof Error ? `${e.name} ${e.message}` : String(e))),
      JSON.stringify(errors),
    ].join('\n');
    for (const needle of [password, address, domain, host, 'hunter2', 'canary']) {
      expect(text).not.toContain(needle);
    }
  });
});

describe('review and security-audit follow-ups (M1c-1)', () => {
  it('updatePassword refuses a row whose binding no longer holds: no login, no save', async () => {
    const credentials = newProvider();
    const account = { ...storedAccount(credentials), host: 'imap.attacker.example' };
    const h = setup({ credentials, accounts: [account] });
    const err = await caught(updatePassword(h.deps, account, 'new-pw'));
    expect(err).toMatchObject({ name: 'AccountError', code: 'secret-unreadable' });
    expect(h.open).not.toHaveBeenCalled();
    expect(h.repo.updateSecret).not.toHaveBeenCalled();
    expect(h.audit.entries).toEqual([]);
  });

  it('storedSecretReadable: true for an intact row, false after a host/username change or another key', () => {
    const credentials = newProvider();
    const account = storedAccount(credentials);
    expect(storedSecretReadable(credentials, account)).toBe(true);
    expect(storedSecretReadable(credentials, { ...account, host: 'imap.other.example' })).toBe(
      false,
    );
    expect(storedSecretReadable(credentials, { ...account, username: 'x@example.invalid' })).toBe(
      false,
    );
    expect(storedSecretReadable(newProvider(), account)).toBe(false);
  });

  it('assertSecretReadable: silent for an intact row; no event, no audit, no login', () => {
    const credentials = newProvider();
    const account = storedAccount(credentials);
    const h = setup({ credentials, accounts: [account] });
    expect(() => assertSecretReadable(h.deps, account)).not.toThrow();
    expect(accountRecords(h.log)).toEqual([]);
    expect(h.audit.entries).toEqual([]);
    expect(h.open).not.toHaveBeenCalled();
  });

  it.each([
    ['a changed host', (a: MailAccount) => ({ ...a, host: 'imap.attacker.example' })],
    ['a changed username', (a: MailAccount) => ({ ...a, username: 'x@example.invalid' })],
  ])(
    'assertSecretReadable: %s → failed account.password-update event, AccountError, nothing else',
    (_label, change) => {
      const credentials = newProvider();
      const account = change(storedAccount(credentials));
      const h = setup({ credentials, accounts: [account] });
      let thrown: unknown;
      try {
        assertSecretReadable(h.deps, account);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toMatchObject({ name: 'AccountError', code: 'secret-unreadable' });
      expect(accountRecords(h.log).map(stripEnvelope)).toEqual([
        {
          event: 'account.password-update',
          acct: ACCOUNT_ID,
          provider: 'websupport',
          outcome: 'failed',
          reason: 'secret-unreadable',
          level: 'warn',
        },
      ]);
      expect(h.audit.entries).toEqual([]); // failed password updates aren't audited
      expect(h.open).not.toHaveBeenCalled();
      const text = JSON.stringify(h.log.records);
      expect(text).not.toContain('attacker');
      expect(text).not.toContain(EMAIL);
    },
  );

  it('assertSecretReadable: a secret under another key is refused with the event', () => {
    const account = storedAccount(newProvider());
    const h = setup({ credentials: newProvider(), accounts: [account] });
    expect(() => assertSecretReadable(h.deps, account)).toThrow(AccountError);
    expect(accountRecords(h.log)).toHaveLength(1);
  });

  it('knownProvider: preset ids pass, anything else is custom', () => {
    expect(knownProvider('websupport')).toBe('websupport');
    expect(knownProvider('gmail')).toBe('gmail');
    expect(knownProvider('victim-example-com')).toBe('custom');
    expect(knownProvider('Bad Provider!')).toBe('custom');
    expect(knownProvider('')).toBe('custom');
  });

  it('assertNotDuplicate logs and audits a failed lookup itself', async () => {
    const h = setup();
    h.repo.findByEmail.mockRejectedValue(
      new RepoError('unavailable', 'Database error: unavailable'),
    );
    await expect(
      assertNotDuplicate(h.deps, { email: EMAIL, host: HOST, provider: 'websupport' }),
    ).rejects.toBeInstanceOf(RepoError);
    expect(h.audit.entries).toEqual([
      expect.objectContaining({ action: 'account.add', result: 'failed', reason: 'database' }),
    ]);
    expect(accountRecords(h.log)).toEqual([
      expect.objectContaining({ event: 'account.add', outcome: 'failed', reason: 'database' }),
    ]);
  });
});
