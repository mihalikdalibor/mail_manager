import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { imapErrorText } from '../../src/cli/imap-errors.js';
import { LocalCredentialProvider } from '../../src/core/credentials.js';
import type { AccountsRepo, AuditRepo, MailAccount } from '../../src/core/db/repos.js';
import { ImapSessionError } from '../../src/core/imap/errors.js';
import { buildServerFeatures, sanitizeCapabilities } from '../../src/core/imap/features.js';
import type {
  ImapClientLike,
  ImapSession,
  OpenSessionOptions,
} from '../../src/core/imap/session.js';
import type { RunContext } from '../../src/core/log/index.js';

// M2a `mm folders [id] [--json] [--no-size]` (spec). Supabase, the IMAP socket and env files are
// mocked; the accounts core, login guard, listFolders, credential decryption and the CLI texts
// are real. The fake IMAP client answers LIST / STATUS / EXAMINE + FETCH like imapflow.

const PASSWORD = 'hunter2-ÄŠť';
const EMAIL = 'someone@example-test-domain.eu';
const HOST = 'imap.example-test-domain.eu';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const A_ID = '3f2a91c0-5d4a-4b6f-9e21-7a8c0d1e2f34';
const B_ID = '9b1c0d2e-1111-4111-8111-111111111111';
const MASTER = Buffer.alloc(32, 7);
const RUN = '0123456789abcdef';
const T0 = Date.UTC(2026, 9, 1, 9, 0, 0);
const HOSTILE = 'Evil\x1b[31mRed‮Folder';
const SERVER_TEXT = 'NO [SERVERBUG] secret-server-text';

const NOT_LOGGED_IN = 'Not logged in — run `mm login`';
const ID_FORMAT = 'A mailbox id is 4–36 characters 0-9, a-f (from `mm account list`).';
const GENERIC = imapErrorText('auth-failed', { kind: 'this-computer' });

const { currentUser, createSupabaseServices, loadEnvFiles, openSession } = vi.hoisted(() => ({
  currentUser: vi.fn<() => Promise<{ email: string; userId: string } | null>>(),
  createSupabaseServices: vi.fn<(...args: unknown[]) => unknown>(),
  loadEnvFiles: vi.fn(),
  openSession: vi.fn<(o: OpenSessionOptions) => Promise<ImapSession>>(),
}));

vi.mock('../../src/core/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/config.js')>();
  return { ...actual, loadEnvFiles };
});
vi.mock('../../src/core/db/supabase/index.js', () => ({
  createSupabaseServices,
  FileSessionStorage: class {
    getItem(): string | null {
      return null;
    }
    setItem(): void {}
    removeItem(): void {}
  },
}));
vi.mock('../../src/core/paths.js', () => ({
  configDir: vi.fn(() => '/nonexistent/mm-test-config'),
  logDir: vi.fn(() => '/nonexistent/mm-test-config/logs'),
}));
vi.mock('../../src/core/imap/session.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/imap/session.js')>();
  return { ...actual, openSession };
});

const { buildProgram } = await import('../../src/cli/index.js');
const { runCli } = await import('../../src/cli/run.js');
const { MemoryEventLog } = await import('../../src/core/log/index.js');
type Log = InstanceType<typeof MemoryEventLog>;

// ---- fakes ----

const credentials = new LocalCredentialProvider({ masterKey: MASTER, masterKeyVersion: 1 });

function row(id = A_ID): MailAccount {
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
    secret: credentials.encryptPassword(
      { userId: USER_ID, accountId: id, host: HOST, port: 993, username: EMAIL },
      PASSWORD,
    ),
    capabilities: null,
    createdAt: new Date(T0),
    updatedAt: new Date(T0),
    lastCheckedAt: null,
  };
}

interface FakeFolder {
  path: string;
  messages: number;
  unseen: number;
  sizes?: number[];
  flags?: string[];
  specialUse?: string;
  subscribed?: boolean;
}

const DEFAULT_FOLDERS: FakeFolder[] = [
  { path: 'INBOX', messages: 3, unseen: 1, sizes: [100, 200, 300] },
  { path: 'INBOX/Work', messages: 1, unseen: 0, sizes: [1024] },
  { path: 'Sent', messages: 0, unseen: 0, specialUse: '\\Sent' },
  { path: 'Old', messages: 2, unseen: 2, sizes: [10, 20], subscribed: false },
];

interface Behaviour {
  folders: FakeFolder[];
  caps: Record<string, true>;
  listError?: Error;
  /** The connection drops during this STATUS. */
  dropOnStatus?: string;
}

let behaviour: Behaviour;
let calls: string[];

function fakeSession(): ImapSession {
  const state = { closed: false };
  const b = behaviour;
  const client: ImapClientLike = {
    options: {},
    capabilities: new Map(),
    enabled: new Set(),
    serverInfo: null,
    usable: true,
    mailbox: false,
    connect: () => Promise.resolve(),
    logout: () => Promise.resolve(),
    noop: () => Promise.resolve(),
    close: () => undefined,
    on: () => undefined,
    list: (opts) => {
      calls.push(`list${opts?.statusQuery ? ' +status' : ''}`);
      if (b.listError) return Promise.reject(b.listError);
      return Promise.resolve(
        b.folders.map((f) => {
          const parts = f.path.split('/');
          return {
            path: f.path,
            pathAsListed: f.path,
            name: parts.at(-1) ?? f.path,
            delimiter: '/',
            parent: parts.slice(0, -1),
            parentPath: parts.slice(0, -1).join('/'),
            flags: new Set(f.flags ?? []),
            ...(f.specialUse !== undefined && {
              specialUse: f.specialUse,
              specialUseSource: 'extension' as const,
            }),
            listed: true,
            subscribed: f.subscribed !== false,
          };
        }),
      );
    },
    status: (path) => {
      calls.push(`status ${path}`);
      if (b.dropOnStatus === path) {
        state.closed = true;
        return Promise.reject(new Error(SERVER_TEXT));
      }
      const f = b.folders.find((x) => x.path === path);
      return Promise.resolve(
        f === undefined ? false : { path, messages: f.messages, unseen: f.unseen },
      );
    },
    getQuota: () => Promise.resolve(false),
    getMailboxLock: (path, opts) => {
      calls.push(`examine ${path} ${opts?.readOnly === true ? 'ro' : 'RW'}`);
      const f = b.folders.find((x) => x.path === path);
      (client as { mailbox: { exists: number } | false }).mailbox = {
        exists: f?.sizes?.length ?? 0,
      };
      return Promise.resolve({ path, release: () => calls.push(`release ${path}`) });
    },
    fetch: (range) => {
      calls.push(`fetch ${range}`);
      const [from, to] = range.split(':').map(Number);
      const lock = calls.filter((c) => c.startsWith('examine ')).at(-1) ?? '';
      const f = b.folders.find((x) => lock.startsWith(`examine ${x.path} `));
      const sizes = f?.sizes ?? [];
      return (async function* () {
        await Promise.resolve();
        for (let seq = from ?? 1; seq <= (to ?? 0); seq++) {
          const size = sizes[seq - 1];
          if (size !== undefined) yield { seq, size };
        }
      })();
    },
  };
  const caps = sanitizeCapabilities({ IMAP4REV1: true, ...b.caps });
  return {
    client,
    capabilities: caps,
    features: buildServerFeatures(caps, new Set()),
    get closed() {
      return state.closed;
    },
    logout: () => {
      calls.push('logout');
      return Promise.resolve();
    },
  } as unknown as ImapSession;
}

function fakeRepo(rows: MailAccount[]): AccountsRepo {
  return {
    create: vi.fn(() => Promise.reject(new Error('not used'))),
    list: vi.fn(() => Promise.resolve(rows)),
    get: vi.fn((id: string) => Promise.resolve(rows.find((r) => r.id === id) ?? null)),
    findByEmail: vi.fn(() => Promise.resolve([])),
    updateSecret: vi.fn(() => Promise.resolve(false)),
    recordCheck: vi.fn(() => Promise.resolve(false)),
    remove: vi.fn(() => Promise.resolve(false)),
  };
}

const audit: AuditRepo = {
  write: vi.fn(() => Promise.resolve()),
  listRecent: vi.fn(() => Promise.resolve({ records: [], skipped: 0 })),
};

// ---- harness ----

let out = { stdout: '', stderr: '' };
let log: Log;
let rows: MailAccount[];
const originalErrIsTTY = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
const originalInIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
const originalOutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
const originalMasterKey = process.env['MM_MASTER_KEY'];

function chunkToString(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString('utf8');
  return String(chunk);
}

function setStderrTTY(value: boolean | undefined): void {
  Object.defineProperty(process.stderr, 'isTTY', { value, configurable: true, writable: true });
}

beforeEach(() => {
  out = { stdout: '', stderr: '' };
  calls = [];
  process.exitCode = undefined;
  process.env['MM_MASTER_KEY'] = MASTER.toString('base64');
  log = new MemoryEventLog({ run: RUN, ver: '0.8.0', now: () => T0, level: 'debug' });
  rows = [row()];
  behaviour = { folders: DEFAULT_FOLDERS, caps: {} };
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    out.stdout += chunkToString(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    out.stderr += chunkToString(chunk);
    return true;
  });
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    out.stdout += `${args.map(chunkToString).join(' ')}\n`;
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    out.stderr += `${args.map(chunkToString).join(' ')}\n`;
  });
  currentUser.mockResolvedValue({ email: 'user@example-test-domain.eu', userId: USER_ID });
  createSupabaseServices.mockImplementation(() => ({
    auth: { currentUser },
    accounts: fakeRepo(rows),
    audit,
  }));
  openSession.mockImplementation((o) => {
    calls.push('login');
    if (o.password !== PASSWORD) return Promise.reject(new ImapSessionError('auth-failed'));
    return Promise.resolve(fakeSession());
  });
  setStderrTTY(false);
  // The M2a output: stdin/stdout are no terminal, so the M2b-2 browser never opens (also when
  // the tests run in a real terminal).
  Object.defineProperty(process.stdin, 'isTTY', {
    value: false,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(process.stdout, 'isTTY', {
    value: false,
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const fn of [currentUser, createSupabaseServices, loadEnvFiles, openSession]) {
    fn.mockReset();
  }
  process.exitCode = undefined;
  if (originalMasterKey === undefined) delete process.env['MM_MASTER_KEY'];
  else process.env['MM_MASTER_KEY'] = originalMasterKey;
  if (originalErrIsTTY) Object.defineProperty(process.stderr, 'isTTY', originalErrIsTTY);
  else delete (process.stderr as { isTTY?: boolean }).isTTY;
  if (originalInIsTTY) Object.defineProperty(process.stdin, 'isTTY', originalInIsTTY);
  else delete (process.stdin as { isTTY?: boolean }).isTTY;
  if (originalOutIsTTY) Object.defineProperty(process.stdout, 'isTTY', originalOutIsTTY);
  else delete (process.stdout as { isTTY?: boolean }).isTTY;
});

async function mm(...args: string[]): Promise<void> {
  await buildProgram({ exitOverride: true, log, run: RUN }).parseAsync(['node', 'mm', ...args]);
}

function exitCode(): number {
  return typeof process.exitCode === 'number' ? process.exitCode : 0;
}

function events(name: string): Record<string, unknown>[] {
  return log.records.filter((r) => r.event === name);
}

function short(id: string): string {
  return id.slice(0, 8);
}

// ---- tests ----

describe('mm folders — which mailbox', () => {
  it('no id + exactly one saved mailbox: uses it and names it', async () => {
    await mm('folders');
    expect(out.stdout).toContain(`Mailbox: ${EMAIL} (Websupport, id ${short(A_ID)})`);
    expect(calls).toContain('login');
    expect(exitCode()).toBe(0);
  });

  it('no id + no saved mailbox: "No mailboxes yet", no login, exit 1', async () => {
    rows = [];
    await mm('folders');
    expect(out.stderr).toContain('No mailboxes yet — run `mm account add <email>`.');
    expect(calls).not.toContain('login');
    expect(events('folders.list')).toEqual([]);
    expect(exitCode()).toBe(1);
  });

  it('no id + several saved mailboxes: asks for an id with the table, no login, exit 1', async () => {
    rows = [row(A_ID), row(B_ID)];
    await mm('folders');
    expect(out.stderr).toContain('Several mailboxes saved — run `mm folders <id>`');
    expect(out.stderr).toContain(short(A_ID));
    expect(out.stderr).toContain(short(B_ID));
    expect(calls).not.toContain('login');
    expect(exitCode()).toBe(1);
  });

  it('an id picks that mailbox among several', async () => {
    rows = [row(A_ID), row(B_ID)];
    await mm('folders', short(B_ID));
    expect(out.stdout).toContain(`id ${short(B_ID)}`);
    expect(exitCode()).toBe(0);
  });

  it('an invalid id: the id format text before anything else, exit 1', async () => {
    await mm('folders', 'not-an-id!');
    expect(out.stderr).toContain(ID_FORMAT);
    expect(currentUser).not.toHaveBeenCalled();
    expect(exitCode()).toBe(1);
  });

  it('an unknown id: "No mailbox with id …", exit 1', async () => {
    await mm('folders', 'abcd');
    expect(out.stderr).toContain('No mailbox with id abcd');
    expect(exitCode()).toBe(1);
  });

  it('not logged in → the login hint, exit 1', async () => {
    currentUser.mockResolvedValue(null);
    await mm('folders');
    expect(out.stderr).toContain(NOT_LOGGED_IN);
    expect(exitCode()).toBe(1);
  });
});

describe('mm folders — output', () => {
  it('prints the tree (indented, tags), totals and the quota fallback line', async () => {
    behaviour.folders = [...DEFAULT_FOLDERS, { path: HOSTILE, messages: 0, unseen: 0 }];
    await mm('folders');
    const lines = out.stdout.split('\n');
    expect(lines.some((l) => l.startsWith('FOLDER') && l.includes('SIZE'))).toBe(true);
    expect(lines.find((l) => l.startsWith('INBOX'))).toContain('[Inbox]');
    expect(lines.some((l) => l.startsWith('  Work'))).toBe(true);
    expect(lines.find((l) => l.startsWith('Sent'))).toContain('[Sent]');
    expect(lines.find((l) => l.startsWith('Old'))).toContain('(hidden)');
    expect(out.stdout).toContain('Total: 6 messages, 3 unread, ~1.6 KB');
    // No STATUS=SIZE on the fake: sizes are added up by us, so "~" and the footer note.
    expect(out.stdout).toContain('Quota: not available from the mail server');
    expect(out.stdout).toContain('~ = added up from the message sizes');
    expect(out.stdout).toContain('Evil[31mRedFolder'); // ESC and the bidi override removed
    expect(out.stdout).not.toContain('\x1b');
    expect(out.stdout).not.toContain('‮');
    expect(exitCode()).toBe(0);
  });

  it('reads read-only only: every EXAMINE is readOnly and released; STATUS before EXAMINE', async () => {
    await mm('folders');
    const examines = calls.filter((c) => c.startsWith('examine '));
    expect(examines.length).toBeGreaterThan(0);
    for (const e of examines) expect(e.endsWith(' ro')).toBe(true);
    expect(calls.filter((c) => c.startsWith('release ')).length).toBe(examines.length);
    const lastStatus = calls.map((c) => c.startsWith('status ')).lastIndexOf(true);
    const firstExamine = calls.findIndex((c) => c.startsWith('examine '));
    expect(lastStatus).toBeLessThan(firstExamine);
    expect(calls.at(-1)).toBe('logout');
  });

  it('--no-size: no size column, no EXAMINE/FETCH', async () => {
    await mm('folders', '--no-size');
    expect(out.stdout).not.toContain('SIZE');
    expect(out.stdout).not.toContain('~');
    expect(calls.some((c) => c.startsWith('examine ') || c.startsWith('fetch '))).toBe(false);
    expect(events('imap.capability-fallback').map((e) => e['feature'])).not.toContain(
      'status-size',
    );
  });

  it('--json: one versioned object on stdout, the mailbox line on stderr', async () => {
    setStderrTTY(true);
    await mm('folders', '--json');
    const parsed = JSON.parse(out.stdout) as Record<string, unknown>;
    expect(parsed['v']).toBe(1);
    expect(parsed['account']).toBe(A_ID);
    expect(Object.keys(parsed).sort()).toEqual(
      ['account', 'folders', 'quota', 'totals', 'truncated', 'unreadable', 'v'].sort(),
    );
    expect(parsed['folders']).toHaveLength(DEFAULT_FOLDERS.length);
    expect(out.stderr).toContain('Mailbox:');
    expect(out.stderr).not.toContain('Sizing folder');
    expect(exitCode()).toBe(0);
  });

  it('progress goes to stderr only when stderr is a terminal', async () => {
    setStderrTTY(true);
    await mm('folders');
    expect(out.stderr).toContain('Sizing folder 1/');
    expect(out.stdout).not.toContain('Sizing folder');

    out = { stdout: '', stderr: '' };
    setStderrTTY(false);
    await mm('folders');
    expect(out.stderr).not.toContain('Sizing folder');
  });
});

describe('mm folders — errors', () => {
  it('a failed login: the generic login text, folders.list failed (auth-failed), exit 1', async () => {
    openSession.mockRejectedValue(new ImapSessionError('auth-failed'));
    await mm('folders');
    expect(out.stderr).toContain(GENERIC);
    expect(events('folders.list')).toEqual([
      expect.objectContaining({ acct: A_ID, outcome: 'failed', reason: 'auth-failed' }),
    ]);
    expect(exitCode()).toBe(1);
  });

  it('a stored secret that no longer decrypts: never logs in, the remove/add hint, exit 1', async () => {
    const other = new LocalCredentialProvider({
      masterKey: Buffer.alloc(32, 9),
      masterKeyVersion: 1,
    });
    rows = [
      {
        ...row(),
        secret: other.encryptPassword(
          { userId: USER_ID, accountId: A_ID, host: HOST, port: 993, username: EMAIL },
          PASSWORD,
        ),
      },
    ];
    await mm('folders');
    expect(calls).not.toContain('login');
    expect(out.stderr).toContain(`mm account remove ${short(A_ID)}`);
    expect(events('folders.list')).toEqual([
      expect.objectContaining({ outcome: 'failed', reason: 'secret-unreadable' }),
    ]);
    expect(exitCode()).toBe(1);
  });

  it('LIST fails: its own text (not the login text, no server text), logout, exit 1', async () => {
    behaviour.listError = new Error(SERVER_TEXT);
    await mm('folders');
    expect(out.stderr).toContain('The mail server could not list the folders — try again later.');
    expect(out.stderr).not.toContain(GENERIC);
    expect(out.stderr).not.toContain('secret-server-text');
    expect(out.stderr).not.toContain('Unexpected error');
    expect(calls.at(-1)).toBe('logout');
    expect(events('folders.list')).toEqual([
      expect.objectContaining({ outcome: 'failed', reason: 'list-failed' }),
    ]);
    expect(events('error.unexpected')).toEqual([]);
    expect(exitCode()).toBe(1);
  });

  it('the connection drops while counting: connection-lost text, never a list of "—"', async () => {
    behaviour.dropOnStatus = 'Sent';
    await mm('folders');
    expect(out.stderr).toContain(
      'The connection to the mail server was lost while reading folders — try again.',
    );
    expect(out.stdout).not.toContain('FOLDER');
    expect(events('folders.list')).toEqual([
      expect.objectContaining({ outcome: 'failed', reason: 'connection-lost' }),
    ]);
    expect(exitCode()).toBe(1);
  });
});

describe('mm folders — logging', () => {
  it('folders.list ok with the account id and folder count; each fallback once', async () => {
    await mm('folders');
    expect(events('folders.list')).toEqual([
      expect.objectContaining({ acct: A_ID, folders: DEFAULT_FOLDERS.length, outcome: 'ok' }),
    ]);
    const fallbacks = events('imap.capability-fallback').map((e) => e['feature']);
    expect(fallbacks.sort()).toEqual(['list-status', 'quota', 'status-size']);
  });

  it('no folder name, address or host in any log record', async () => {
    behaviour.folders = [...DEFAULT_FOLDERS, { path: 'Tajný priečinok', messages: 1, unseen: 0 }];
    await mm('folders');
    const text = JSON.stringify(log.records);
    for (const needle of [EMAIL, HOST, 'example-test-domain', 'Tajn', 'Work', 'INBOX', 'Old']) {
      expect(text).not.toContain(needle);
    }
  });
});

describe('mm folders --json through runCli: a closed pipe is quiet', () => {
  class FakeProc {
    exitCode: number | string | null | undefined;
    readonly exits: (number | undefined)[] = [];
    on(): void {}
    exit(code?: number): never {
      this.exits.push(code);
      return undefined as never;
    }
  }

  it('EPIPE on stdout after the JSON: no "Unexpected error", exit code 0', async () => {
    const streams = [new EventEmitter(), new EventEmitter()];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      out.stdout += `${args.map(chunkToString).join(' ')}\n`;
      streams[0]?.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    });
    const proc = new FakeProc();
    const ctx: RunContext = { run: RUN, ver: '0.8.0', now: () => T0, level: 'debug' };
    await runCli({
      argv: ['node', 'mm', 'folders', '--json'],
      build: (o) => buildProgram({ ...o, exitOverride: true }),
      log,
      ctx,
      proc,
      flush: () => Promise.resolve(),
      streams,
    });
    expect(out.stdout).toContain('"v": 1');
    expect(out.stderr).not.toContain('Unexpected error');
    expect(proc.exitCode ?? 0).toBe(0);
    expect(events('error.unexpected')).toEqual([]);
  });
});
