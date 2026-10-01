import { CommanderError } from 'commander';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { imapErrorText } from '../../src/cli/imap-errors.js';
import { LocalCredentialProvider } from '../../src/core/credentials.js';
import type { AccountBinding } from '../../src/core/crypto.js';
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
import type { DiscoveryDeps, DiscoveryResult } from '../../src/core/providers/discover.js';
import { parseEmail } from '../../src/core/providers/email.js';
import { PRESETS, type Preset } from '../../src/core/providers/presets.js';

// M1c-1 `mm account add|list|test|update-password|remove` (spec). Supabase, prompts, discovery,
// the IMAP socket and env files are mocked; the accounts core, login guard, credential
// encryption and CLI texts are real.

const PASSWORD = 'hunter2-ÄŠť';
const EMAIL = 'someone@example-test-domain.eu';
const DOMAIN = 'example-test-domain.eu';
const HOST = 'imap.example-test-domain.eu';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const A_ID = '3f2a91c0-5d4a-4b6f-9e21-7a8c0d1e2f34';
const B_ID = '3f2a91c0-0000-4000-8000-000000000001';
const C_ID = '9b1c0d2e-1111-4111-8111-111111111111';
const MASTER = Buffer.alloc(32, 7);
const RUN = '0123456789abcdef';
const T0 = Date.UTC(2026, 9, 1, 9, 0, 0);
const CAPS = sanitizeCapabilities({
  IMAP4REV1: true,
  UIDPLUS: true,
  MOVE: true,
  'XYZZY-SERVER-TEXT': true,
});
const FEATURES = buildServerFeatures(CAPS, new Set());

const NOT_LOGGED_IN = 'Not logged in — run `mm login`';
const ID_FORMAT = 'A mailbox id is 4–36 characters 0-9, a-f (from `mm account list`).';
const GENERIC = imapErrorText('auth-failed', { kind: 'this-computer' });
const TRY_AGAIN = 'Try another password?';
const USE_SETTINGS = 'Use these settings?';
const REMOVE_CONFIRM = 'Remove this mailbox from Mail Manager? Its messages are not touched.';

interface PromptConfig {
  message: string;
  default?: boolean | string;
}

const {
  currentUser,
  createSupabaseServices,
  loadEnvFiles,
  input,
  password,
  confirm,
  select,
  discover,
  openSession,
  cliChallenge,
  order,
} = vi.hoisted(() => {
  const order: string[] = [];
  return {
    currentUser: vi.fn<() => Promise<{ email: string; userId: string } | null>>(),
    createSupabaseServices: vi.fn<(...args: unknown[]) => unknown>(),
    loadEnvFiles: vi.fn(),
    input: vi.fn<(config: PromptConfig) => Promise<string>>(),
    password: vi.fn<(config: PromptConfig) => Promise<string>>(),
    confirm: vi.fn<(config: PromptConfig) => Promise<boolean>>(),
    select: vi.fn<(config: PromptConfig) => Promise<string>>(),
    discover: vi.fn<(input: string, deps: DiscoveryDeps) => Promise<DiscoveryResult>>(),
    openSession: vi.fn<(o: OpenSessionOptions) => Promise<ImapSession>>(),
    cliChallenge: vi.fn(() => {
      order.push('challenge');
      return Promise.resolve();
    }),
    order,
  };
});

vi.mock('../../src/core/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/config.js')>();
  return { ...actual, loadEnvFiles };
});
vi.mock('../../src/core/db/supabase/index.js', () => ({
  createSupabaseServices,
  FileSessionStorage: class {
    readonly file: string;
    constructor(dir: string) {
      this.file = `${dir}/session.json`;
    }
    getItem(): string | null {
      return null;
    }
    setItem(): void {}
    removeItem(): void {}
    clear(): void {}
    isEmpty(): boolean {
      return false;
    }
  },
}));
vi.mock('../../src/core/paths.js', () => ({
  configDir: vi.fn(() => '/nonexistent/mm-test-config'),
  logDir: vi.fn(() => '/nonexistent/mm-test-config/logs'),
}));
vi.mock('@inquirer/prompts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@inquirer/prompts')>();
  return { ...actual, input, password, confirm, select };
});
vi.mock('../../src/core/providers/discover.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/providers/discover.js')>();
  return { ...actual, discover };
});
vi.mock('../../src/core/imap/session.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/imap/session.js')>();
  return { ...actual, openSession };
});
vi.mock('../../src/cli/login-guard-text.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/cli/login-guard-text.js')>();
  return { ...actual, cliChallenge };
});

const { buildProgram } = await import('../../src/cli/index.js');
const { MemoryEventLog } = await import('../../src/core/log/index.js');
const { providerInfo } = await import('../../src/core/providers/discover.js');
const { loginBlockedText } = await import('../../src/cli/login-guard-text.js');
const { LoginBlockedError } = await import('../../src/core/security/login-guard.js');
type Log = InstanceType<typeof MemoryEventLog>;

// ---- fakes ----

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

const credentials = new LocalCredentialProvider({ masterKey: MASTER, masterKeyVersion: 1 });

/** A saved row whose secret was encrypted under `binding` (defaults: the row's own values). */
function row(
  over: Partial<MailAccount> = {},
  binding: Partial<AccountBinding> = {},
  provider: LocalCredentialProvider = credentials,
  pw = PASSWORD,
): MailAccount {
  const id = over.id ?? A_ID;
  const secret = provider.encryptPassword(
    {
      userId: USER_ID,
      accountId: id,
      host: over.host ?? HOST,
      port: 993,
      username: over.username ?? EMAIL,
      ...binding,
    },
    pw,
  );
  return {
    id,
    userId: USER_ID,
    label: null,
    email: EMAIL,
    provider: 'websupport',
    host: HOST,
    port: 993,
    username: EMAIL,
    authType: 'password',
    secret,
    capabilities: null,
    createdAt: new Date(T0),
    updatedAt: new Date(T0),
    lastCheckedAt: null,
    ...over,
  };
}

function preset(id: string): Preset {
  const p = PRESETS.find((x) => x.id === id);
  if (p === undefined) throw new Error(`no preset ${id}`);
  return p;
}

function found(host = HOST, email = EMAIL): DiscoveryResult {
  return {
    email: parseEmail(email),
    notices: [],
    tried: [],
    status: 'found',
    source: 'preset-domain',
    provider: providerInfo(preset('websupport')),
    imap: { host, port: 993, username: email },
    altHosts: [],
  };
}

function manual(email = EMAIL): DiscoveryResult {
  return { email: parseEmail(email), notices: [], tried: [], status: 'manual' };
}

function blocked(email = EMAIL): DiscoveryResult {
  const outlook = preset('outlook');
  return {
    email: parseEmail(email),
    notices: [],
    tried: [],
    status: 'blocked',
    source: 'preset-domain',
    provider: providerInfo(outlook),
    reason: outlook.blocked ?? 'blocked',
  };
}

function exitPrompt(): Error {
  const cancel = new Error('User force closed the prompt with SIGINT');
  cancel.name = 'ExitPromptError';
  return cancel;
}

// ---- harness ----

let out = { stdout: '', stderr: '' };
let repo: ReturnType<typeof fakeRepo>;
let audit: ReturnType<typeof fakeAudit>;
let log: Log;
/** Answers for confirm(), queued per message; a missing answer fails the test. */
let confirmAnswers: Record<string, (boolean | Error)[]>;
let passwords: (string | Error)[];

const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
const originalOutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
const originalMasterKey = process.env['MM_MASTER_KEY'];
const originalKeyVersion = process.env['MM_MASTER_KEY_VERSION'];

function chunkToString(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString('utf8');
  return String(chunk);
}

type WriteCallback = (err?: Error | null) => void;

function capture(key: 'stdout' | 'stderr') {
  return (chunk: unknown, encoding?: unknown, cb?: unknown): boolean => {
    out[key] += chunkToString(chunk);
    const done = typeof encoding === 'function' ? encoding : cb;
    if (typeof done === 'function') queueMicrotask(() => (done as WriteCallback)());
    return true;
  };
}

function setTTY(value: boolean | undefined, stdout: boolean | undefined = value): void {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true, writable: true });
  Object.defineProperty(process.stdout, 'isTTY', {
    value: stdout,
    configurable: true,
    writable: true,
  });
}

function useRepo(rows: MailAccount[]): void {
  repo = fakeRepo(rows);
}

beforeEach(() => {
  out = { stdout: '', stderr: '' };
  process.exitCode = undefined;
  process.env['MM_MASTER_KEY'] = MASTER.toString('base64');
  delete process.env['MM_MASTER_KEY_VERSION'];
  order.length = 0;
  repo = fakeRepo();
  audit = fakeAudit();
  log = new MemoryEventLog({ run: RUN, ver: '0.7.0', now: () => T0, level: 'debug' });
  confirmAnswers = {};
  passwords = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(capture('stdout'));
  vi.spyOn(process.stderr, 'write').mockImplementation(capture('stderr'));
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    out.stdout += `${args.map(chunkToString).join(' ')}\n`;
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    out.stderr += `${args.map(chunkToString).join(' ')}\n`;
  });
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    out.stderr += `${args.map(chunkToString).join(' ')}\n`;
  });
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`real process.exit(${String(code)}) called`);
  });
  currentUser.mockResolvedValue({ email: 'user@example-test-domain.eu', userId: USER_ID });
  createSupabaseServices.mockImplementation(() => ({
    auth: { currentUser },
    accounts: repo,
    audit,
  }));
  discover.mockResolvedValue(found());
  input.mockResolvedValue(EMAIL);
  password.mockImplementation(() => {
    const next = passwords.shift();
    if (next === undefined) return Promise.reject(new Error('unexpected password prompt'));
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
  confirm.mockImplementation((config) => {
    const next = confirmAnswers[config.message]?.shift();
    if (next === undefined) {
      return Promise.reject(new Error(`unexpected confirm: ${config.message}`));
    }
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
  select.mockRejectedValue(new Error('unexpected select'));
  openSession.mockImplementation((o) => {
    order.push('open');
    if (o.password !== PASSWORD && !o.password.startsWith('new-')) {
      return Promise.reject(new ImapSessionError('auth-failed'));
    }
    const session = {
      capabilities: CAPS,
      features: FEATURES,
      logout: () => Promise.resolve(),
    };
    return Promise.resolve(session as unknown as ImapSession);
  });
  setTTY(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const fn of [
    currentUser,
    createSupabaseServices,
    loadEnvFiles,
    input,
    password,
    confirm,
    select,
    discover,
    openSession,
  ]) {
    fn.mockReset();
  }
  cliChallenge.mockClear();
  process.exitCode = undefined;
  if (originalMasterKey === undefined) delete process.env['MM_MASTER_KEY'];
  else process.env['MM_MASTER_KEY'] = originalMasterKey;
  if (originalKeyVersion === undefined) delete process.env['MM_MASTER_KEY_VERSION'];
  else process.env['MM_MASTER_KEY_VERSION'] = originalKeyVersion;
  if (originalIsTTY) Object.defineProperty(process.stdin, 'isTTY', originalIsTTY);
  else delete (process.stdin as { isTTY?: boolean }).isTTY;
  if (originalOutIsTTY) Object.defineProperty(process.stdout, 'isTTY', originalOutIsTTY);
  else delete (process.stdout as { isTTY?: boolean }).isTTY;
});

async function mm(...args: string[]): Promise<void> {
  await buildProgram({ exitOverride: true, log, run: RUN }).parseAsync(['node', 'mm', ...args]);
}

function all(): string {
  return `${out.stdout}\n${out.stderr}`;
}

function exitCode(): number {
  return Number(process.exitCode ?? 0);
}

function confirmMessages(): string[] {
  return confirm.mock.calls.map((c) => c[0].message);
}

/** Nothing past the cheap checks ran: no services, no user lookup. */
function expectNoServices(): void {
  expect(createSupabaseServices).not.toHaveBeenCalled();
  expect(currentUser).not.toHaveBeenCalled();
}

const short = (id: string): string => id.slice(0, 8);

// ---- tests ----

describe('mm --help', () => {
  it('shows the getting-started steps', async () => {
    await expect(mm('--help')).rejects.toBeInstanceOf(CommanderError);
    for (const text of [
      'Getting started:',
      'mm login',
      'mm discover <email>',
      'mm account add <email>',
      'mm account test <id>',
    ]) {
      expect(out.stdout).toContain(text);
    }
  });
});

describe('check order', () => {
  it('loadEnvFiles runs before the MM_MASTER_KEY check (a key from .env counts)', async () => {
    useRepo([row()]);
    delete process.env['MM_MASTER_KEY'];
    loadEnvFiles.mockImplementation(() => {
      process.env['MM_MASTER_KEY'] = MASTER.toString('base64');
    });
    await mm('account', 'test', short(A_ID));
    expect(loadEnvFiles).toHaveBeenCalled();
    expect(all()).not.toContain('mm keygen');
    expect(all()).toContain('Login works.');
    expect(exitCode()).toBe(0);
  });

  it('add: the terminal check comes before the key check', async () => {
    delete process.env['MM_MASTER_KEY'];
    setTTY(false);
    await mm('account', 'add', EMAIL);
    expect(out.stderr).toContain('mm account add needs a terminal (password prompt)');
    expect(all()).not.toContain('mm keygen');
    expect(exitCode()).toBe(1);
    expectNoServices();
  });

  it('update-password: the terminal check comes before the id check', async () => {
    setTTY(false);
    await mm('account', 'update-password', 'zz');
    expect(out.stderr).toContain('mm account update-password needs a terminal (password prompt)');
    expect(all()).not.toContain(ID_FORMAT);
    expect(exitCode()).toBe(1);
    expectNoServices();
  });

  it.each([['test'], ['update-password']])(
    '%s: the id check comes before the key check',
    async (cmd) => {
      delete process.env['MM_MASTER_KEY'];
      await mm('account', cmd, 'zz');
      expect(all()).toContain(ID_FORMAT);
      expect(all()).not.toContain('mm keygen');
      expect(exitCode()).toBe(1);
      expectNoServices();
    },
  );
});

describe('not logged in', () => {
  it.each<[string, string[]]>([
    ['list', ['account', 'list']],
    ['add', ['account', 'add', EMAIL]],
    ['test', ['account', 'test', short(A_ID)]],
    ['update-password', ['account', 'update-password', short(A_ID)]],
    ['remove', ['account', 'remove', short(A_ID), '--yes']],
  ])('%s → Not logged in, exit 1', async (_name, args) => {
    useRepo([row()]);
    currentUser.mockResolvedValue(null);
    await mm(...args);
    expect(out.stderr).toContain(NOT_LOGGED_IN);
    expect(exitCode()).toBe(1);
    expect(password).not.toHaveBeenCalled();
    expect(openSession).not.toHaveBeenCalled();
    expect(repo.rows.size).toBe(1);
  });
});

describe('missing MM_MASTER_KEY', () => {
  it.each<[string, string[]]>([
    ['add', ['account', 'add', EMAIL]],
    ['test', ['account', 'test', short(A_ID)]],
    ['update-password', ['account', 'update-password', short(A_ID)]],
  ])('%s → MM_MASTER_KEY + mm keygen, exit 1, before currentUser', async (_name, args) => {
    delete process.env['MM_MASTER_KEY'];
    await mm(...args);
    expect(out.stderr).toContain('MM_MASTER_KEY');
    expect(out.stderr).toContain('mm keygen');
    expect(exitCode()).toBe(1);
    expectNoServices();
    expect(password).not.toHaveBeenCalled();
  });

  it('list works without it', async () => {
    delete process.env['MM_MASTER_KEY'];
    useRepo([row()]);
    await mm('account', 'list');
    expect(out.stdout).toContain(short(A_ID));
    expect(exitCode()).toBe(0);
  });

  it('remove works without it', async () => {
    delete process.env['MM_MASTER_KEY'];
    useRepo([row()]);
    await mm('account', 'remove', short(A_ID), '--yes');
    expect(out.stdout).toContain(`Removed ${EMAIL}.`);
    expect(repo.rows.size).toBe(0);
    expect(exitCode()).toBe(0);
  });
});

describe('mm account add', () => {
  it.each<[string, boolean | undefined, boolean | undefined]>([
    ['no stdin TTY', undefined, true],
    ['no stdout TTY', true, false],
    ['neither', false, false],
  ])('%s → needs a terminal, exit 1', async (_name, stdin, stdout) => {
    setTTY(stdin, stdout);
    await mm('account', 'add', EMAIL);
    expect(out.stderr).toContain('mm account add needs a terminal (password prompt)');
    expect(exitCode()).toBe(1);
    expectNoServices();
    expect(password).not.toHaveBeenCalled();
  });

  it('success: found settings confirmed, password asked, saved with a lowercase host', async () => {
    confirmAnswers = { [USE_SETTINGS]: [true] };
    passwords = [PASSWORD];
    await mm('account', 'add', EMAIL);

    expect(input).not.toHaveBeenCalled();
    expect(discover.mock.calls[0]?.[0]).toBe(EMAIL);
    expect(out.stdout).toContain('Websupport');
    expect(out.stdout).toMatch(/IMAP\s+imap\.example-test-domain\.eu/);
    expect(out.stdout).toContain('Found via');
    expect(confirmMessages()).toEqual([USE_SETTINGS]);
    expect(password).toHaveBeenCalledTimes(1);
    expect(password.mock.calls[0]?.[0].message).toBe('Password (or app password):');

    expect(repo.rows.size).toBe(1);
    const saved = [...repo.rows.values()][0];
    if (saved === undefined) throw new Error('not saved');
    expect(saved.host).toBe(HOST);
    expect(saved.email).toBe(EMAIL);
    expect(saved.provider).toBe('websupport');
    expect(credentials.decryptPassword(saved)).toBe(PASSWORD);
    const id8 = short(saved.id);
    expect(out.stdout).toContain(
      `Added ${EMAIL} (id ${id8}). Test it any time with \`mm account test ${id8}\`.`,
    );
    expect(exitCode()).toBe(0);
  });

  it('a host with capitals from discovery is saved lowercased', async () => {
    discover.mockResolvedValue(found('IMAP.Example-Test-Domain.eu'));
    confirmAnswers = { [USE_SETTINGS]: [true] };
    passwords = [PASSWORD];
    await mm('account', 'add', EMAIL);
    expect([...repo.rows.values()].map((r) => r.host)).toEqual([HOST]);
    expect(exitCode()).toBe(0);
  });

  it('a host typed with capitals in manual entry is saved lowercased', async () => {
    discover.mockResolvedValue(manual());
    select.mockResolvedValue('__manual__');
    input.mockImplementation((config) =>
      Promise.resolve(config.message === 'IMAP username' ? EMAIL : 'IMAP.Example-Test-Domain.eu'),
    );
    passwords = [PASSWORD];
    await mm('account', 'add', EMAIL);
    expect([...repo.rows.values()].map((r) => r.host)).toEqual([HOST]);
    expect([...repo.rows.values()].map((r) => r.provider)).toEqual(['custom']);
    expect(exitCode()).toBe(0);
  });

  it('without an email argument asks for it', async () => {
    confirmAnswers = { [USE_SETTINGS]: [true] };
    passwords = [PASSWORD];
    await mm('account', 'add');
    expect(input).toHaveBeenCalledTimes(1);
    expect(input.mock.calls[0]?.[0].message).toBe('Email address:');
    expect(discover.mock.calls[0]?.[0]).toBe(EMAIL);
    expect(repo.rows.size).toBe(1);
  });

  it('found, "No" to the settings → the provider picker; Cancel → nothing saved', async () => {
    confirmAnswers = { [USE_SETTINGS]: [false] };
    select.mockResolvedValue('__cancel__');
    await mm('account', 'add', EMAIL);
    expect(select).toHaveBeenCalledTimes(1);
    expect(select.mock.calls[0]?.[0].message).toBe('Choose your email provider');
    expect(all()).toContain('Cancelled — nothing saved.');
    expect(password).not.toHaveBeenCalled();
    expect(repo.rows.size).toBe(0);
    expect(exitCode()).toBe(1);
  });

  it('found, "No", a preset picked → saved with the preset host and id', async () => {
    confirmAnswers = { [USE_SETTINGS]: [false] };
    select.mockResolvedValue('gmail');
    passwords = [PASSWORD];
    await mm('account', 'add', EMAIL);
    const saved = [...repo.rows.values()];
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ host: 'imap.gmail.com', provider: 'gmail' });
    expect(exitCode()).toBe(0);
  });

  it('blocked → Not supported yet, exit 1, no password prompt', async () => {
    discover.mockResolvedValue(blocked());
    await mm('account', 'add', EMAIL);
    expect(all()).toContain(`Not supported yet: ${preset('outlook').blocked ?? ''}`);
    expect(password).not.toHaveBeenCalled();
    expect(repo.rows.size).toBe(0);
    expect(exitCode()).toBe(1);
  });

  it('manual → No IMAP settings found, then the picker; Cancel → nothing saved', async () => {
    discover.mockResolvedValue(manual());
    select.mockResolvedValue('__cancel__');
    await mm('account', 'add', EMAIL);
    const text = all();
    expect(text).toContain(`No IMAP settings found for ${DOMAIN}.`);
    expect(select.mock.calls[0]?.[0].message).toBe('Choose your email provider');
    expect(text.indexOf(`No IMAP settings found for ${DOMAIN}.`)).toBeLessThan(
      text.indexOf('Cancelled — nothing saved.'),
    );
    expect(password).not.toHaveBeenCalled();
    expect(exitCode()).toBe(1);
  });

  it('already saved (same email + host) → stops before the password prompt', async () => {
    useRepo([row({ id: A_ID })]);
    confirmAnswers = { [USE_SETTINGS]: [true] };
    await mm('account', 'add', EMAIL);
    expect(all()).toContain(
      `This mailbox is already saved (id ${short(A_ID)}). To change its password run \`mm account update-password ${short(A_ID)}\`.`,
    );
    expect(password).not.toHaveBeenCalled();
    expect(openSession).not.toHaveBeenCalled();
    expect(repo.rows.size).toBe(1);
    expect(exitCode()).toBe(1);
  });

  it('wrong password → generic text, "Try another password?" yes → asks again → saved', async () => {
    confirmAnswers = { [USE_SETTINGS]: [true], [TRY_AGAIN]: [true] };
    passwords = ['wrong-1', PASSWORD];
    await mm('account', 'add', EMAIL);
    expect(out.stderr).toContain(GENERIC);
    expect(password).toHaveBeenCalledTimes(2);
    const tries = confirm.mock.calls.filter((c) => c[0].message === TRY_AGAIN);
    expect(tries).toHaveLength(1);
    expect(tries[0]?.[0].default).toBe(true);
    expect(repo.rows.size).toBe(1);
    expect(exitCode()).toBe(0);
  });

  it('wrong password, "Try another password?" no → exit 1, nothing saved', async () => {
    confirmAnswers = { [USE_SETTINGS]: [true], [TRY_AGAIN]: [false] };
    passwords = ['wrong-1'];
    await mm('account', 'add', EMAIL);
    expect(out.stderr).toContain(GENERIC);
    expect(repo.rows.size).toBe(0);
    expect(repo.create).not.toHaveBeenCalled();
    expect(exitCode()).toBe(1);
  });

  it('challenge before the 3rd attempt; the 5th failure → too many wrong passwords', async () => {
    confirmAnswers = {
      [USE_SETTINGS]: [true],
      [TRY_AGAIN]: Array<boolean>(10).fill(true),
    };
    passwords = ['wrong-1', 'wrong-2', 'wrong-3', 'wrong-4', 'wrong-5', PASSWORD, PASSWORD];
    await mm('account', 'add', EMAIL);
    expect(openSession).toHaveBeenCalledTimes(5);
    expect(password).toHaveBeenCalledTimes(5);
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
    const blockedText = loginBlockedText(new LoginBlockedError('too-many-attempts', null));
    expect(blockedText).toContain('Too many wrong passwords');
    expect(all()).toContain('Too many wrong passwords');
    expect(repo.rows.size).toBe(0);
    expect(exitCode()).toBe(1);
  });

  it('a non-credential failure → its text, exit 1, no "Try another password?"', async () => {
    openSession.mockRejectedValue(new ImapSessionError('throttled'));
    confirmAnswers = { [USE_SETTINGS]: [true], [TRY_AGAIN]: [true] };
    passwords = [PASSWORD];
    await mm('account', 'add', EMAIL);
    expect(out.stderr).toContain(imapErrorText('throttled', { kind: 'this-computer' }));
    expect(confirmMessages()).not.toContain(TRY_AGAIN);
    expect(repo.rows.size).toBe(0);
    expect(exitCode()).toBe(1);
  });

  it('a timeout → generic text, exit 1, no "Try another password?"', async () => {
    openSession.mockRejectedValue(new ImapSessionError('timeout', 'ETIMEDOUT'));
    confirmAnswers = { [USE_SETTINGS]: [true], [TRY_AGAIN]: [true] };
    passwords = [PASSWORD];
    await mm('account', 'add', EMAIL);
    expect(out.stderr).toContain(imapErrorText('timeout', { kind: 'this-computer' }));
    expect(confirmMessages()).not.toContain(TRY_AGAIN);
    expect(password).toHaveBeenCalledTimes(1);
    expect(exitCode()).toBe(1);
  });

  it.each<[string, () => void]>([
    [
      'at the password prompt',
      () => {
        confirmAnswers = { [USE_SETTINGS]: [true] };
        passwords = [exitPrompt()];
      },
    ],
    [
      'at "Use these settings?"',
      () => {
        confirmAnswers = { [USE_SETTINGS]: [exitPrompt()] };
      },
    ],
    [
      'at the email prompt',
      () => {
        input.mockRejectedValue(exitPrompt());
      },
    ],
    [
      'at "Try another password?"',
      () => {
        confirmAnswers = { [USE_SETTINGS]: [true], [TRY_AGAIN]: [exitPrompt()] };
        passwords = ['wrong-1'];
      },
    ],
  ])('Ctrl+C %s → exit 130, nothing saved', async (name, arrange) => {
    arrange();
    if (name === 'at the email prompt') await mm('account', 'add');
    else await mm('account', 'add', EMAIL);
    expect(exitCode()).toBe(130);
    expect(repo.rows.size).toBe(0);
  });
});

describe('mm account list', () => {
  it('empty → hint, exit 0', async () => {
    await mm('account', 'list');
    expect(out.stdout).toContain('No mailboxes yet — run `mm account add <email>`.');
    expect(exitCode()).toBe(0);
  });

  it('header + one line per account; provider names; never for unchecked; no secrets', async () => {
    const a = row({ id: A_ID, provider: 'gmail', host: 'imap.gmail.com' });
    const c = row({
      id: C_ID,
      email: 'other@example-test-domain.eu',
      username: 'other@example-test-domain.eu',
      provider: 'weird-unknown',
      lastCheckedAt: new Date(T0),
    });
    useRepo([a, c]);
    await mm('account', 'list');
    const lines = out.stdout.split('\n');
    const header = lines.find((l) => l.includes('ID') && l.includes('EMAIL'));
    expect(header).toBeDefined();
    for (const col of ['ID', 'EMAIL', 'PROVIDER', 'HOST', 'LAST CHECKED']) {
      expect(header).toContain(col);
    }
    const lineA = lines.find((l) => l.includes(short(A_ID)));
    expect(lineA).toBeDefined();
    expect(lineA).toContain(EMAIL);
    expect(lineA).toContain('Gmail');
    expect(lineA).toContain('imap.gmail.com');
    expect(lineA).toContain('never');
    const lineC = lines.find((l) => l.includes(short(C_ID)));
    expect(lineC).toContain('other@example-test-domain.eu');
    expect(lineC).toContain('Custom');
    expect(lineC).toContain(HOST);
    expect(lineC).not.toContain('never');
    expect(lineA).not.toContain(A_ID);
    for (const r of [a, c]) {
      expect(all()).not.toContain(r.secret.ciphertext);
      expect(all()).not.toContain(r.secret.tag);
    }
    expect(exitCode()).toBe(0);
  });

  it('control and bidi characters in email/host are not printed', async () => {
    useRepo([
      row({
        email: 'evil\u001b[31m@example-test-domain.eu',
        host: 'imap.‮example-test-domain.eu',
      }),
    ]);
    await mm('account', 'list');
    expect(out.stdout).toContain(short(A_ID));
    expect(out.stdout).not.toContain('\u001b');
    expect(out.stdout).not.toContain('‮');
    expect(exitCode()).toBe(0);
  });
});

describe('mailbox refs', () => {
  const CMDS: [string, string[]][] = [
    ['test', []],
    ['update-password', []],
    ['remove', ['--yes']],
  ];

  it.each(CMDS)('%s without an id → Which mailbox?, exit 1', async (cmd, extra) => {
    useRepo([row()]);
    await mm('account', cmd, ...extra);
    expect(all()).toContain(
      `Which mailbox? Run \`mm account list\` and pass its id, e.g. \`mm account ${cmd} 3f2a91c0\`.`,
    );
    expect(exitCode()).toBe(1);
    expect(repo.rows.size).toBe(1);
  });

  for (const bad of ['zz', 'abc']) {
    it.each(CMDS)(`%s ${bad} → id format, before currentUser`, async (cmd, extra) => {
      useRepo([row()]);
      await mm('account', cmd, bad, ...extra);
      expect(all()).toContain(ID_FORMAT);
      expect(exitCode()).toBe(1);
      expectNoServices();
    });
  }

  it.each(CMDS)('%s with no match → No mailbox with id', async (cmd, extra) => {
    useRepo([row()]);
    await mm('account', cmd, 'abcd', ...extra);
    expect(all()).toContain('No mailbox with id abcd — see `mm account list`.');
    expect(exitCode()).toBe(1);
    expect(repo.rows.size).toBe(1);
    expect(password).not.toHaveBeenCalled();
  });

  it.each(CMDS)('%s with an ambiguous prefix → matches 2 mailboxes', async (cmd, extra) => {
    useRepo([row({ id: A_ID }), row({ id: B_ID, host: 'imap2.example-test-domain.eu' })]);
    await mm('account', cmd, '3f2a', ...extra);
    expect(all()).toContain('3f2a matches 2 mailboxes — type more characters of the id.');
    expect(exitCode()).toBe(1);
    expect(repo.rows.size).toBe(2);
    expect(password).not.toHaveBeenCalled();
  });
});

describe('mm account test', () => {
  it('prints the mailbox, Login works. and the supported features', async () => {
    useRepo([row()]);
    await mm('account', 'test', short(A_ID));
    expect(out.stdout).toContain(`Testing ${EMAIL} (Websupport, id ${short(A_ID)})`);
    expect(out.stdout).toContain('Login works.');
    const supports = out.stdout.split('\n').find((l) => l.startsWith('Server supports:'));
    expect(supports).toBeDefined();
    expect(supports).toContain('MOVE');
    expect(supports).toContain('UIDPLUS');
    expect(all()).not.toContain('XYZZY');
    expect(openSession).toHaveBeenCalledTimes(1);
    expect(openSession.mock.calls[0]?.[0]).toMatchObject({
      settings: { host: HOST, port: 993, username: EMAIL },
      password: PASSWORD,
    });
    expect(exitCode()).toBe(0);
  });

  it('a full id works too', async () => {
    useRepo([row()]);
    await mm('account', 'test', A_ID);
    expect(out.stdout).toContain('Login works.');
  });

  it('a failed login → its text, exit 1', async () => {
    useRepo([row({}, {}, credentials, 'stale-password')]);
    await mm('account', 'test', short(A_ID));
    expect(out.stderr).toContain(GENERIC);
    expect(out.stdout).not.toContain('Login works.');
    expect(exitCode()).toBe(1);
  });

  it.each<[string, () => MailAccount]>([
    [
      'saved under another key',
      () =>
        row(
          {},
          {},
          new LocalCredentialProvider({ masterKey: Buffer.alloc(32, 9), masterKeyVersion: 1 }),
        ),
    ],
    ['host changed after encryption', () => ({ ...row(), host: 'imap.other.example' })],
    [
      'saved under another key version',
      () => row({}, {}, new LocalCredentialProvider({ masterKey: MASTER, masterKeyVersion: 2 })),
    ],
  ])(
    // Security review (M1c-1): the recovery is remove + add (re-discovery), never update-password,
    // which would send a typed password to a server read from an untrusted row.
    'a secret that cannot be decrypted (%s) → remove + add hint, no login',
    async (_n, make) => {
      useRepo([make()]);
      await mm('account', 'test', short(A_ID));
      expect(all()).toContain("can't be decrypted");
      expect(all()).toContain(`mm account remove ${short(A_ID)}`);
      expect(all()).toContain('mm account add <email>');
      expect(all()).not.toContain('mm account update-password');
      expect(openSession).not.toHaveBeenCalled();
      expect(exitCode()).toBe(1);
    },
  );
});

describe('mm account update-password', () => {
  const NEW = 'new-password-7e2b';

  it.each<[string, boolean | undefined, boolean | undefined]>([
    ['no stdin TTY', undefined, true],
    ['no stdout TTY', true, false],
  ])('%s → needs a terminal', async (_name, stdin, stdout) => {
    useRepo([row()]);
    setTTY(stdin, stdout);
    await mm('account', 'update-password', short(A_ID));
    expect(out.stderr).toContain('mm account update-password needs a terminal (password prompt)');
    expect(exitCode()).toBe(1);
    expectNoServices();
  });

  it('success → Mailbox line, new-password prompt, Password updated, secret replaced', async () => {
    useRepo([row()]);
    passwords = [NEW];
    await mm('account', 'update-password', short(A_ID));
    expect(out.stdout).toContain(`Mailbox: ${EMAIL} (`);
    expect(out.stdout).toContain(`id ${short(A_ID)})`);
    expect(password.mock.calls[0]?.[0].message).toBe('New password (or app password):');
    expect(openSession.mock.calls[0]?.[0].password).toBe(NEW);
    expect(out.stdout).toContain(`Password updated for ${EMAIL}.`);
    const saved = repo.rows.get(A_ID);
    if (saved === undefined) throw new Error('row gone');
    expect(credentials.decryptPassword(saved)).toBe(NEW);
    expect(exitCode()).toBe(0);
  });

  it('wrong password, retry yes → second password saved', async () => {
    useRepo([row()]);
    confirmAnswers = { [TRY_AGAIN]: [true] };
    passwords = ['wrong-1', NEW];
    await mm('account', 'update-password', short(A_ID));
    expect(out.stderr).toContain(GENERIC);
    const saved = repo.rows.get(A_ID);
    if (saved === undefined) throw new Error('row gone');
    expect(credentials.decryptPassword(saved)).toBe(NEW);
    expect(exitCode()).toBe(0);
  });

  it('wrong password, retry no → stored secret unchanged, exit 1', async () => {
    const original = row();
    useRepo([original]);
    confirmAnswers = { [TRY_AGAIN]: [false] };
    passwords = ['wrong-1'];
    await mm('account', 'update-password', short(A_ID));
    expect(out.stderr).toContain(GENERIC);
    expect(repo.updateSecret).not.toHaveBeenCalled();
    expect(repo.rows.get(A_ID)?.secret).toEqual(original.secret);
    expect(out.stdout).not.toContain('Password updated');
    expect(exitCode()).toBe(1);
  });

  it('Ctrl+C at the password prompt → 130, secret unchanged', async () => {
    const original = row();
    useRepo([original]);
    passwords = [exitPrompt()];
    await mm('account', 'update-password', short(A_ID));
    expect(exitCode()).toBe(130);
    expect(repo.rows.get(A_ID)?.secret).toEqual(original.secret);
  });
});

describe('mm account remove', () => {
  it('no TTY and no --yes → needs a terminal, before currentUser', async () => {
    useRepo([row()]);
    setTTY(false);
    await mm('account', 'remove', short(A_ID));
    expect(out.stderr).toContain('mm account remove needs a terminal to confirm, or --yes');
    expect(exitCode()).toBe(1);
    expectNoServices();
    expect(repo.rows.size).toBe(1);
  });

  it('TTY, confirm no → Nothing removed, exit 0, still saved', async () => {
    useRepo([row()]);
    confirmAnswers = { [REMOVE_CONFIRM]: [false] };
    await mm('account', 'remove', short(A_ID));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]?.[0]).toMatchObject({ message: REMOVE_CONFIRM, default: false });
    expect(out.stdout).toContain('Nothing removed.');
    expect(repo.rows.size).toBe(1);
    expect(exitCode()).toBe(0);
  });

  it('TTY, confirm yes → Removed, gone', async () => {
    useRepo([row()]);
    confirmAnswers = { [REMOVE_CONFIRM]: [true] };
    await mm('account', 'remove', short(A_ID));
    expect(out.stdout).toContain(`Removed ${EMAIL}.`);
    expect(repo.rows.size).toBe(0);
    expect(exitCode()).toBe(0);
  });

  it('--yes without a TTY → Removed, no prompt', async () => {
    useRepo([row()]);
    setTTY(false);
    await mm('account', 'remove', short(A_ID), '--yes');
    expect(confirm).not.toHaveBeenCalled();
    expect(out.stdout).toContain(`Removed ${EMAIL}.`);
    expect(repo.rows.size).toBe(0);
    expect(exitCode()).toBe(0);
  });

  it('Ctrl+C at the confirm → 130, still saved', async () => {
    useRepo([row()]);
    confirmAnswers = { [REMOVE_CONFIRM]: [exitPrompt()] };
    await mm('account', 'remove', short(A_ID));
    expect(exitCode()).toBe(130);
    expect(repo.rows.size).toBe(1);
  });
});

describe('logging and audit', () => {
  const needles = [PASSWORD, EMAIL, HOST, DOMAIN, 'hunter2'];

  it('a successful add → account.add ok; no password, address or host in any line', async () => {
    confirmAnswers = { [USE_SETTINGS]: [true] };
    passwords = [PASSWORD];
    await mm('account', 'add', EMAIL);
    const adds = log.records.filter((r) => r.event === 'account.add');
    expect(adds).toHaveLength(1);
    expect(adds[0]).toMatchObject({ outcome: 'ok', provider: 'websupport' });
    expect(log.records.map((r) => r.event)).toContain('imap.login');
    const text = log.lines.join('\n');
    for (const n of needles) expect(text).not.toContain(n);
  });

  it('wrong passwords → account.add failed auth-failed and one failed audit row per attempt', async () => {
    confirmAnswers = { [USE_SETTINGS]: [true], [TRY_AGAIN]: [true, false] };
    passwords = [`${PASSWORD}-wrong-1`, `${PASSWORD}-wrong-2`];
    await mm('account', 'add', EMAIL);
    expect(exitCode()).toBe(1);
    const failed = log.records.filter((r) => r.event === 'account.add');
    expect(failed).toHaveLength(2); // one per attempt
    for (const r of failed) expect(r).toMatchObject({ outcome: 'failed', reason: 'auth-failed' });
    expect(log.records.filter((r) => r.event === 'imap.login-failed')).toHaveLength(2);
    const rows = audit.entries.filter((e) => e.action === 'account.add');
    expect(rows).toHaveLength(2);
    for (const e of rows) {
      expect(e).toMatchObject({ result: 'failed', reason: 'auth-failed' });
      expect(e.accountId).toBeUndefined();
    }
    const text = [log.lines.join('\n'), JSON.stringify(audit.entries)].join('\n');
    for (const n of needles) expect(text).not.toContain(n);
  });

  it('test, update-password and remove leave no address or host in the log', async () => {
    useRepo([row()]);
    await mm('account', 'test', short(A_ID));
    passwords = ['new-pw-1'];
    await mm('account', 'update-password', short(A_ID));
    await mm('account', 'remove', short(A_ID), '--yes');
    const names = log.records.map((r) => r.event);
    for (const n of ['account.test', 'account.password-update', 'account.remove']) {
      expect(names).toContain(n);
    }
    const text = [log.lines.join('\n'), JSON.stringify(audit.entries)].join('\n');
    for (const n of needles) expect(text).not.toContain(n);
  });
});

describe('review and security-audit follow-ups (M1c-1)', () => {
  it('update-password on a row whose host was changed in the database → refused before the prompt', async () => {
    const tampered = { ...row(), host: 'imap.attacker.example' };
    useRepo([tampered]);
    await mm('account', 'update-password', short(A_ID));
    expect(password).not.toHaveBeenCalled();
    expect(openSession).not.toHaveBeenCalled();
    expect(all()).toContain("can't be decrypted");
    expect(all()).toContain(`mm account remove ${short(A_ID)}`);
    expect(repo.rows.get(A_ID)?.secret).toEqual(tampered.secret);
    expect(exitCode()).toBe(1);
  });

  it('update-password shows the server and username the new password goes to', async () => {
    useRepo([row()]);
    passwords = ['new-pw'];
    await mm('account', 'update-password', short(A_ID));
    expect(out.stdout).toContain(`Server:  ${HOST} (port 993), username ${EMAIL}`);
    expect(out.stdout).toContain(`Password updated for ${EMAIL}.`);
  });

  it('declining another try ends with a closing line (add: Nothing saved, update: Password not changed)', async () => {
    confirmAnswers = { [USE_SETTINGS]: [true], [TRY_AGAIN]: [false] };
    passwords = ['wrong-1'];
    await mm('account', 'add', EMAIL);
    expect(out.stdout).toContain('Nothing saved.');
    expect(exitCode()).toBe(1);

    process.exitCode = undefined;
    out = { stdout: '', stderr: '' };
    useRepo([row()]);
    confirmAnswers = { [TRY_AGAIN]: [false] };
    passwords = ['wrong-2'];
    await mm('account', 'update-password', short(A_ID));
    expect(out.stdout).toContain('Password not changed.');
    expect(exitCode()).toBe(1);
  });

  it('a preset picked after "No" is shown (IMAP line) before the password is asked', async () => {
    confirmAnswers = { [USE_SETTINGS]: [false] };
    select.mockResolvedValue('gmail');
    let shownBeforePassword = false;
    password.mockImplementationOnce(() => {
      shownBeforePassword = out.stdout.includes('imap.gmail.com');
      return Promise.resolve(PASSWORD);
    });
    await mm('account', 'add', EMAIL);
    expect(shownBeforePassword).toBe(true);
  });

  it('an invalid MM_MASTER_KEY names mm keygen, before the login check', async () => {
    process.env['MM_MASTER_KEY'] = 'not base64!!';
    await mm('account', 'test', short(A_ID));
    expect(out.stderr).toContain('MM_MASTER_KEY');
    expect(out.stderr).toContain('mm keygen');
    expect(currentUser).not.toHaveBeenCalled();
    expect(exitCode()).toBe(1);
  });

  it('a saved row with port 143, OAuth or a username with a line break → unsupported, no login', async () => {
    for (const over of [
      { port: 143 },
      { authType: 'oauth2' as const },
      { username: `${EMAIL}\r\nX` },
    ]) {
      process.exitCode = undefined;
      out = { stdout: '', stderr: '' };
      useRepo([row(over)]);
      await mm('account', 'test', short(A_ID));
      expect(all()).toContain("This saved mailbox uses settings Mail Manager can't use");
      expect(openSession).not.toHaveBeenCalled();
      expect(exitCode()).toBe(1);
    }
  });

  it('remove of a mailbox deleted meanwhile → no longer saved text, no audit row', async () => {
    useRepo([row()]);
    repo.remove.mockResolvedValueOnce(false);
    await mm('account', 'remove', short(A_ID), '--yes');
    expect(all()).toContain('That mailbox is no longer saved');
    expect(audit.entries.filter((e) => e.action === 'account.remove')).toHaveLength(0);
    expect(exitCode()).toBe(1);
  });

  it('the duplicate pre-check writes the failed account.add event and audit row', async () => {
    useRepo([row({ id: A_ID })]);
    confirmAnswers = { [USE_SETTINGS]: [true] };
    await mm('account', 'add', EMAIL);
    expect(log.records.filter((r) => r.event === 'account.add')).toEqual([
      expect.objectContaining({ outcome: 'failed', reason: 'duplicate' }),
    ]);
    expect(audit.entries).toEqual([
      expect.objectContaining({ action: 'account.add', result: 'failed', reason: 'duplicate' }),
    ]);
    expect(audit.entries[0]?.accountId).toBeUndefined();
  });

  it('a slug-shaped provider that is no preset (from a hostile row) is logged and audited as custom', async () => {
    useRepo([row({ provider: 'victim-example-com' })]);
    await mm('account', 'remove', short(A_ID), '--yes');
    expect(audit.entries[0]?.details).toEqual({ provider: 'custom' });
    const text = log.lines.join('\n');
    expect(text).not.toContain('victim-example-com');
    expect(log.records.find((r) => r.event === 'account.remove')).toMatchObject({
      provider: 'custom',
    });
  });
});
