import { CommanderError } from 'commander';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { lineErrorText } from '../../src/cli/filter-text.js';
import { imapErrorText } from '../../src/cli/imap-errors.js';
import { LocalCredentialProvider } from '../../src/core/credentials.js';
import type { AccountsRepo, AuditRepo, MailAccount } from '../../src/core/db/repos.js';
import type { RunContext } from '../../src/core/log/index.js';
import { parseFilterLine } from '../../src/core/filters/line.js';
import { runCli, type ProcLike } from '../../src/cli/run.js';
import { ImapSessionError } from '../../src/core/imap/errors.js';
import { buildServerFeatures, sanitizeCapabilities } from '../../src/core/imap/features.js';
import type {
  FetchedMessage,
  ImapClientLike,
  ImapSession,
  OpenSessionOptions,
} from '../../src/core/imap/session.js';

// M3b `mm search "<filter>" [--account] [--folder] [--sent] [--body] [--order] [--limit] [--json]`
// (spec). Supabase, the IMAP socket and env files are mocked; the accounts core, login guard,
// the folder listing, the search core and the CLI texts are real. The fake IMAP client answers
// LIST / EXAMINE, UID SEARCH and UID FETCH like imapflow, but it does not evaluate the criteria:
// it answers every UID of the folder, so exact counts are not asserted here (the live test pins
// them). What is asserted: the queries it receives, the texts, the exit codes and the log.

const PASSWORD = 'hunter2-ÄŠť';
const EMAIL = 'someone@example-test-domain.eu';
const HOST = 'imap.example-test-domain.eu';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const A_ID = '3f2a91c0-5d4a-4b6f-9e21-7a8c0d1e2f34';
const B_ID = '9b1c0d2e-1111-4111-8111-111111111111';
const MASTER = Buffer.alloc(32, 7);
const RUN = '0123456789abcdef';
const T0 = Date.UTC(2026, 9, 1, 9, 0, 0);
const HOSTILE = 'Evil\x1b[31mRed\u202eFolder';
const SERVER_TEXT = 'NO [SERVERBUG] secret-server-text';

const NOT_LOGGED_IN = 'Not logged in — run `mm login`';
const ID_FORMAT = 'A mailbox id is 4–36 characters 0-9, a-f (from `mm account list`).';
const SEARCH_EMPTY_TEXT =
  'Type a filter, e.g. mm search "from:@shop.sk older:1y" — see `mm search --help`.';
const SEARCH_LIMIT_TEXT = '--limit takes a whole number from 0 to 200.';
const SEARCH_ORDER_TEXT = '--order takes newest, oldest or largest.';
const SEARCH_BODY_TEXT =
  'The --body text can\'t be used — up to 200 characters, without quotes (") or control characters.';
const BODY_WARNING =
  'Body search is done by the mail server — some servers are slow at it or search only part of a mail.';
const FOLDER_NOT_FOUND =
  'There is no folder with that path in this mailbox — use the full path from `mm folders --json` (e.g. "INBOX.Sent" or "[Gmail]/Sent Mail").';
const GMAIL_HIDDEN =
  'Gmail hides "All Mail" from IMAP for this account, so the totals can\'t be counted without double counting labels. Turn on "Show in IMAP" for All Mail in Gmail\'s settings (Labels), or pick one folder with --folder.';
const SEARCH_FAILED = "The mail server couldn't run this search — try a simpler filter.";
const TOO_MANY = 'Too many mails match (more than 500,000) — narrow the filter.';
const CONNECTION_LOST =
  'The connection to the mail server was lost while reading folders — try again.';
const SENT_SUFFIX = ' — dates are sent dates (the Date: header)';

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
const { MemoryEventLog } = await import('../../src/core/log/index.js');
type Log = InstanceType<typeof MemoryEventLog>;
const CTX: RunContext = { run: RUN, ver: '0.10.0', now: () => T0, level: 'debug' };

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

interface MailSpec {
  size?: number;
  date?: Date | string;
  address?: string;
  name?: string;
  subject?: string;
}

function mail(o: MailSpec = {}): FetchedMessage {
  const from =
    o.address !== undefined || o.name !== undefined
      ? [
          {
            ...(o.address !== undefined && { address: o.address }),
            ...(o.name !== undefined && { name: o.name }),
          },
        ]
      : undefined;
  return {
    ...(o.size !== undefined && { size: o.size }),
    ...(o.date !== undefined && { internalDate: o.date }),
    envelope: {
      ...(from !== undefined && { from }),
      ...(o.subject !== undefined && { subject: o.subject }),
    },
  };
}

const JUN_2023 = new Date('2023-06-15T12:00:00Z');
const JUN_2024 = new Date('2024-06-15T12:00:00Z');

interface FakeFolder {
  path: string;
  mails?: FetchedMessage[];
  flags?: string[];
  specialUse?: string;
  /** The connection drops during the FETCH of this folder. */
  drop?: boolean;
}

const DEFAULT_FOLDERS: FakeFolder[] = [
  {
    path: 'INBOX',
    mails: [
      mail({
        size: 1_048_576,
        date: JUN_2024,
        address: 'alice@example-sender.test',
        name: 'Alice A',
        subject: 'Quarterly report',
      }),
      mail({ size: 524_288, date: JUN_2023, address: 'ALICE@example-sender.test', subject: 'Old' }),
      mail({ size: 2048, subject: 'No sender, no date' }),
    ],
  },
  {
    path: 'Work',
    mails: [
      mail({ size: 1024, date: JUN_2024, address: 'bob@shop.example', subject: 'Invoice 1' }),
      mail({ size: 1024, date: JUN_2024, address: 'bob@shop.example', subject: 'Invoice 2' }),
    ],
  },
  {
    path: 'Sent',
    specialUse: '\\Sent',
    mails: [mail({ size: 100, date: JUN_2023, address: 'me@sender-home.test', subject: 'Sent' })],
  },
  {
    path: 'Trash',
    specialUse: '\\Trash',
    mails: [mail({ size: 50, date: JUN_2024, address: 'x@junk.test', subject: 'Trashed' })],
  },
];

interface Behaviour {
  folders: FakeFolder[];
  caps: Record<string, true>;
  /** Folders whose UID SEARCH is refused. */
  searchFail: string[];
  /** Folders whose UID SEARCH answers more UIDs than the search allows. */
  searchBig: string[];
  /** Folders whose UIDVALIDITY changes on a later EXAMINE (the list after the search). */
  reset: string[];
  /** Folders whose messages are gone on a later EXAMINE (expunged after the search). */
  expunged: string[];
  /** EXAMINEs so far, per folder path. */
  examines: Record<string, number>;
}

let behaviour: Behaviour;
let calls: string[];
/** Every UID SEARCH the fake received: the folder and the query object as imapflow gets it. */
let queries: { folder: string; query: unknown }[];

/** The UIDs of an IMAP set such as "1:3" or "1,4:5". */
function uidsOf(set: string): number[] {
  return set.split(',').flatMap((part) => {
    const [from, to] = part.split(':').map(Number);
    const first = from ?? 0;
    const last = to ?? first;
    return Array.from({ length: last - first + 1 }, (_v, i) => first + i);
  });
}

function fakeSession(): ImapSession {
  const state = { closed: false };
  const b = behaviour;
  let selected = '';
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
            subscribed: true,
          };
        }),
      );
    },
    status: () => Promise.resolve(false),
    getQuota: () => Promise.resolve(false),
    getMailboxLock: (path, opts) => {
      calls.push(`examine ${path} ${opts?.readOnly === true ? 'ro' : 'RW'}`);
      const f = b.folders.find((x) => x.path === path);
      if (f === undefined) return Promise.reject(new Error(SERVER_TEXT));
      selected = path;
      const examined = (b.examines[path] ?? 0) + 1;
      b.examines[path] = examined;
      const later = examined > 1;
      (client as { mailbox: { exists: number; uidValidity: bigint } | false }).mailbox = {
        exists: f.mails?.length ?? 0,
        uidValidity: later && b.reset.includes(path) ? 8n : 7n,
      };
      return Promise.resolve({ path, release: () => calls.push(`release ${path}`) });
    },
    search: (query) => {
      calls.push(`search ${selected}`);
      queries.push({ folder: selected, query });
      if (b.searchFail.includes(selected)) return Promise.reject(new Error(SERVER_TEXT));
      if (b.searchBig.includes(selected)) {
        return Promise.resolve(Array.from({ length: 500_001 }, (_v, i) => i + 1));
      }
      const f = b.folders.find((x) => x.path === selected);
      return Promise.resolve(Array.from({ length: f?.mails?.length ?? 0 }, (_v, i) => i + 1));
    },
    fetch: (range) => {
      calls.push(`fetch ${range}`);
      const f = b.folders.find((x) => x.path === selected);
      return (async function* () {
        await Promise.resolve();
        for (const uid of uidsOf(range)) {
          const m = f?.mails?.[uid - 1];
          if (m === undefined) continue;
          const reopened = (b.examines[selected] ?? 0) > 1;
          if (b.expunged.includes(selected) && reopened) continue;
          if (f?.drop === true) {
            state.closed = true;
            throw new Error(SERVER_TEXT);
          }
          yield { ...m, uid, seq: uid };
        }
      })();
    },
  };
  const caps = sanitizeCapabilities({
    IMAP4REV1: true,
    ...b.caps,
  });
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

function setTTY(stream: NodeJS.WriteStream | NodeJS.ReadStream, value: boolean | undefined): void {
  Object.defineProperty(stream, 'isTTY', { value, configurable: true, writable: true });
}

beforeEach(() => {
  out = { stdout: '', stderr: '' };
  calls = [];
  queries = [];
  process.exitCode = undefined;
  process.env['MM_MASTER_KEY'] = MASTER.toString('base64');
  log = new MemoryEventLog({ run: RUN, ver: '0.10.0', now: () => T0, level: 'debug' });
  rows = [row()];
  behaviour = {
    folders: DEFAULT_FOLDERS,
    caps: {},
    searchFail: [],
    searchBig: [],
    reset: [],
    expunged: [],
    examines: {},
  };
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
  // Pinned explicitly: nothing may depend on the terminal the tests run in.
  setTTY(process.stderr, false);
  setTTY(process.stdin, false);
  setTTY(process.stdout, false);
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

/** Control characters (but not the line break) and the bidi controls: never on a terminal. */
function unsafeChars(text: string): string[] {
  return [...text].filter((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return (
      (code < 0x20 && code !== 0x0a) ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x200e ||
      code === 0x200f ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    );
  });
}

/** Every string inside a JSON value, at any depth. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}

/** Every key inside a query object, at any depth. */
function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => [k, ...keysOf(v)]);
  }
  return [];
}

/** The text report: stdout without the `Mailbox:` line. */
function reportLines(): string[] {
  return out.stdout.split('\n').filter((l) => !l.startsWith('Mailbox:'));
}

function filterLine(): string | undefined {
  return reportLines().find((l) => l.startsWith('Filter: '));
}

function jsonOut(): Record<string, unknown> {
  return JSON.parse(out.stdout) as Record<string, unknown>;
}

function folderCalls(): string[] {
  return calls.filter((c) => c.startsWith('examine ')).map((c) => c.split(' ')[1] ?? '');
}

/** The process runCli ends with: exit is recorded as a throw so the test gets control back. */
class ProcExit extends Error {}

class StubProc implements ProcLike {
  exitCode: number | string | null | undefined = undefined;

  on(): void {}

  exit(code?: number): never {
    throw new ProcExit(String(code ?? 0));
  }
}

// ---- tests ----

describe('mm search — which mailbox', () => {
  it('no --account + exactly one saved mailbox: uses it and names it on the first line', async () => {
    await mm('search', 'older:1y');
    expect(out.stdout).toContain(`Mailbox: ${EMAIL} (Websupport, id ${short(A_ID)})`);
    expect(calls).toContain('login');
    expect(exitCode()).toBe(0);
  });

  it('no --account + several saved mailboxes: asks for one, no login, exit 1', async () => {
    rows = [row(A_ID), row(B_ID)];
    await mm('search', 'older:1y');
    expect(out.stderr).toContain(
      'Several mailboxes saved — run `mm search "<filter>" --account <id>` with one of these ids:',
    );
    expect(calls).not.toContain('login');
    expect(exitCode()).toBe(1);
  });

  it('--account picks that mailbox among several', async () => {
    rows = [row(A_ID), row(B_ID)];
    await mm('search', 'older:1y', '--account', short(B_ID));
    expect(out.stdout).toContain(`id ${short(B_ID)}`);
    expect(exitCode()).toBe(0);
  });

  it('--account in the wrong format: the id format text before any login, exit 1', async () => {
    await mm('search', 'older:1y', '--account', 'zz');
    expect(out.stderr).toContain(ID_FORMAT);
    expect(calls).not.toContain('login');
    expect(exitCode()).toBe(1);
  });

  it('not logged in → the login hint, no login to the mail server, exit 1', async () => {
    currentUser.mockResolvedValue(null);
    await mm('search', 'older:1y');
    expect(out.stderr).toContain(NOT_LOGGED_IN);
    expect(calls).not.toContain('login');
    expect(exitCode()).toBe(1);
  });
});

describe('mm search — the filter as typed', () => {
  it('quoted filter: the filter line, found mails, the sample heading, one login; search.finish ok', async () => {
    await mm('search', 'from:@shop.example');
    expect(out.stdout).toContain('Mailbox:');
    expect(filterLine()).toBe('Filter: from:@shop.example');
    expect(out.stdout).toMatch(/^Found \d[\d,]* mails?, /m);
    expect(exitCode()).toBe(0);
    expect(calls.filter((c) => c === 'login')).toHaveLength(1);
    expect(events('search.finish')).toEqual([
      expect.objectContaining({ acct: A_ID, outcome: 'ok', criteria: ['from'] }),
    ]);
    const finish = events('search.finish')[0];
    expect(typeof finish?.['count']).toBe('number');
    expect(typeof finish?.['bytes']).toBe('number');
  });

  it('unquoted words: the same filter line and criteria as the quoted form', async () => {
    await mm('search', 'from:@shop.example', '-att');
    const unquoted = { line: filterLine(), criteria: events('search.finish')[0]?.['criteria'] };
    expect(unquoted.criteria).toEqual(['from', 'hasAttachments']);
    expect(exitCode()).toBe(0);

    out = { stdout: '', stderr: '' };
    calls = [];
    queries = [];
    log = new MemoryEventLog({ run: RUN, ver: '0.10.0', now: () => T0, level: 'debug' });
    await mm('search', 'from:@shop.example -att');
    expect({ line: filterLine(), criteria: events('search.finish')[0]?.['criteria'] }).toEqual(
      unquoted,
    );
    expect(filterLine()).toBe('Filter: from:@shop.example -att');
  });

  it('double dash: -att after -- is a filter term (hasAttachments)', async () => {
    await mm('search', '--', '-att');
    expect(events('search.finish')[0]?.['criteria']).toContain('hasAttachments');
    expect(filterLine()).toBe('Filter: -att');
    expect(exitCode()).toBe(0);
  });

  it('leading dash words without --: -att and larger:1mb are filter terms', async () => {
    await mm('search', '-att', 'larger:1mb');
    expect(filterLine()).toBe('Filter: -att larger:1mb');
    expect(events('search.finish')[0]?.['criteria']).toEqual(
      expect.arrayContaining(['hasAttachments', 'larger']),
    );
    expect(exitCode()).toBe(0);
  });

  it('a quoted phrase passed unquoted (subject:faktura 2023) is two terms', async () => {
    await mm('search', 'subject:faktura', '2023');
    expect(filterLine()).toBe('Filter: subject:faktura 2023');
    const criteria = events('search.finish')[0]?.['criteria'] as string[] | undefined;
    expect(criteria).toHaveLength(2);
    expect(criteria).toContain('subject');
    expect(exitCode()).toBe(0);
  });

  it('unknown option (--jsno): the unknown option text before any login, exit 1; --json still parses', async () => {
    await mm('search', 'older:1y', '--jsno');
    expect(out.stderr).toContain('Unknown option "--jsno" — see `mm search --help`.');
    expect(openSession).not.toHaveBeenCalled();
    expect(exitCode()).toBe(1);

    process.exitCode = undefined;
    await mm('search', 'older:1y', '--json');
    expect(jsonOut()['v']).toBe(1);
    expect(exitCode()).toBe(0);
  });

  it('empty: no filter or only quotes / spaces → the empty text, no login, exit 1', async () => {
    await mm('search');
    expect(out.stderr).toContain(SEARCH_EMPTY_TEXT);
    expect(calls).not.toContain('login');
    expect(exitCode()).toBe(1);

    process.exitCode = undefined;
    out = { stdout: '', stderr: '' };
    await mm('search', '""');
    expect(out.stderr).toContain(SEARCH_EMPTY_TEXT);
    expect(calls).not.toContain('login');
    expect(exitCode()).toBe(1);
  });

  it('a filter with only spaces: the empty text, no login, exit 1', async () => {
    await mm('search', '   ');
    expect(out.stderr).toContain(SEARCH_EMPTY_TEXT);
    expect(calls).not.toContain('login');
    expect(exitCode()).toBe(1);
  });

  it('line error: the line parser text for the unknown key, no login, exit 1', async () => {
    const parsed = parseFilterLine('form:x');
    if (parsed.ok) throw new Error('form:x should not parse');
    await mm('search', 'form:x');
    expect(out.stderr).toContain(lineErrorText(parsed.error));
    expect(calls).not.toContain('login');
    expect(exitCode()).toBe(1);
  });

  it('--body alone is a valid search: criteria body, the body warning printed', async () => {
    await mm('search', '--body', 'invoice');
    expect(events('search.finish')[0]?.['criteria']).toEqual(['body']);
    expect(out.stdout).toContain(BODY_WARNING);
    expect(exitCode()).toBe(0);
  });

  it.each<[string, string[]]>([
    ['--body with a blank text', ['--body', '']],
    ['--body with spaces only', ['--body', '   ']],
  ])('%s → the body text, no login, exit 1', async (_name, extra) => {
    await mm('search', 'older:1y', ...extra);
    expect(out.stderr).toContain(SEARCH_BODY_TEXT);
    expect(calls).not.toContain('login');
    expect(exitCode()).toBe(1);
  });

  it.each<[string, string[], string]>([
    ['--limit -1', ['--limit', '-1'], SEARCH_LIMIT_TEXT],
    ['--limit 201', ['--limit', '201'], SEARCH_LIMIT_TEXT],
    ['--limit abc', ['--limit', 'abc'], SEARCH_LIMIT_TEXT],
    ['--order biggest', ['--order', 'biggest'], SEARCH_ORDER_TEXT],
    ['--body with a quote', ['--body', 'a"b'], SEARCH_BODY_TEXT],
  ])('%s → its text, no login, exit 1', async (_name, extra, text) => {
    await mm('search', 'older:1y', ...extra);
    expect(out.stderr).toContain(text);
    expect(calls).not.toContain('login');
    expect(exitCode()).toBe(1);
  });

  it('--limit 0 and --limit 200 are accepted (the edges of the range)', async () => {
    await mm('search', 'older:1y', '--limit', '200');
    expect(exitCode()).toBe(0);
    process.exitCode = undefined;
    out = { stdout: '', stderr: '' };
    await mm('search', 'older:1y', '--limit', '0');
    expect(exitCode()).toBe(0);
  });

  it('--limit 0: no sample section and fewer fetches than with the default limit', async () => {
    await mm('search', 'older:1y');
    const withSamples = calls.filter((c) => c.startsWith('fetch ')).length;
    expect(out.stdout).toMatch(/^NEWEST \d+ OF \d+$/m);

    calls = [];
    out = { stdout: '', stderr: '' };
    await mm('search', 'older:1y', '--limit', '0');
    const withoutSamples = calls.filter((c) => c.startsWith('fetch ')).length;
    expect(out.stdout).not.toMatch(/^(NEWEST|OLDEST|LARGEST) /m);
    expect(withoutSamples).toBeLessThan(withSamples);
  });

  it('--order largest and --order oldest name the sample list', async () => {
    await mm('search', 'older:1y', '--order', 'largest');
    expect(out.stdout).toMatch(/^LARGEST \d+ OF \d+$/m);
    process.exitCode = undefined;
    out = { stdout: '', stderr: '' };
    await mm('search', 'older:1y', '--order', 'oldest');
    expect(out.stdout).toMatch(/^OLDEST \d+ OF \d+$/m);
    expect(exitCode()).toBe(0);
  });

  it('--folder: only that folder is read; the folder name is the one searched', async () => {
    await mm('search', 'older:1y', '--folder', 'Work');
    // The samples are read after the search, so the folder is opened again; nothing else is.
    expect(new Set(folderCalls())).toEqual(new Set(['Work']));
    expect(queries.map((q) => q.folder)).toEqual(['Work']);
    expect(exitCode()).toBe(0);
  });

  it('--folder "" → the "Unexpected options" text, no login, exit 1', async () => {
    await mm('search', 'older:1y', '--folder', '');
    expect(out.stderr).toContain('Unexpected options');
    expect(calls).not.toContain('login');
    expect(exitCode()).toBe(1);
  });
});

describe('mm search — the server query', () => {
  it('--sent: the query has sentSince and no since; the filter line carries the sent suffix', async () => {
    await mm('search', 'newer:30d', '--sent');
    expect(queries.length).toBeGreaterThan(0);
    for (const q of queries) {
      const keys = keysOf(q.query);
      expect(keys).toContain('sentSince');
      expect(keys).not.toContain('since');
    }
    expect(filterLine()).toBe(`Filter: newer:30d${SENT_SUFFIX}`);
    expect(exitCode()).toBe(0);
  });

  it('--sent without a date term: the same query as without it; the filter line still has the suffix', async () => {
    await mm('search', 'from:@shop.example');
    const plain = queries.map((q) => q.query);
    expect(filterLine()).toBe('Filter: from:@shop.example');

    queries = [];
    out = { stdout: '', stderr: '' };
    process.exitCode = undefined;
    await mm('search', 'from:@shop.example', '--sent');
    expect(queries.map((q) => q.query)).toEqual(plain);
    expect(filterLine()).toBe(`Filter: from:@shop.example${SENT_SUFFIX}`);
  });
});

describe('mm search — folders and the server', () => {
  it('a folder not found: its text, no search, search.finish failed folder-not-found, exit 1', async () => {
    await mm('search', 'older:1y', '--folder', 'Nope');
    expect(out.stderr).toContain(FOLDER_NOT_FOUND);
    expect(calls.some((c) => c.startsWith('search '))).toBe(false);
    expect(events('search.finish')).toEqual([
      expect.objectContaining({ acct: A_ID, outcome: 'failed', reason: 'folder-not-found' }),
    ]);
    expect(exitCode()).toBe(1);
  });

  it('Gmail with All Mail hidden and no --folder: its text, nothing searched, search.finish failed, exit 1', async () => {
    behaviour.caps = { 'X-GM-EXT-1': true };
    behaviour.folders = [
      { path: 'INBOX', mails: [mail({ size: 1 })] },
      { path: 'Work', mails: [mail({ size: 1 })] },
    ];
    await mm('search', 'older:1y');
    expect(out.stderr).toContain(GMAIL_HIDDEN);
    expect(calls.some((c) => c.startsWith('search '))).toBe(false);
    expect(events('search.finish')).toEqual([
      expect.objectContaining({ acct: A_ID, outcome: 'failed', reason: 'gmail-all-hidden' }),
    ]);
    expect(exitCode()).toBe(1);
  });

  it('every folder refused: the text of the first failed code, search.finish failed with zeros, exit 1', async () => {
    behaviour.searchFail = ['INBOX', 'Sent', 'Trash', 'Work'];
    await mm('search', 'older:1y');
    expect(out.stderr).toContain(SEARCH_FAILED);
    expect(out.stdout).not.toContain('FOLDER');
    expect(events('search.finish')).toEqual([
      expect.objectContaining({
        acct: A_ID,
        outcome: 'failed',
        reason: 'search-failed',
        count: 0,
        bytes: 0,
      }),
    ]);
    expect(exitCode()).toBe(1);
  });

  it('some folders refused: exit 0, the note, the "(couldn\'t be searched)" row, search.finish ok', async () => {
    behaviour.searchFail = ['Work'];
    await mm('search', 'older:1y');
    expect(out.stdout).toContain("1 folder couldn't be searched — the result may be incomplete.");
    const row = reportLines().find((l) => l.startsWith('Work')) ?? '';
    expect(row).toMatch(/^Work\s+—\s+—/);
    expect(row.endsWith(" (couldn't be searched)")).toBe(true);
    expect(events('search.finish')).toEqual([expect.objectContaining({ outcome: 'ok' })]);
    expect(exitCode()).toBe(0);
  });

  it('one folder with more than 500,000 candidates: the too-many text, exit 1', async () => {
    behaviour.searchBig = ['Work'];
    await mm('search', 'older:1y');
    expect(out.stderr).toContain(TOO_MANY);
    expect(events('search.finish')).toEqual([
      expect.objectContaining({ outcome: 'failed', reason: 'too-many-matches' }),
    ]);
    expect(exitCode()).toBe(1);
  }, 60_000);

  it('the connection drops during the search: the connection-lost text, no report, exit 1', async () => {
    behaviour.folders = [
      { path: 'INBOX', mails: [mail({ size: 1 }), mail({ size: 1 })] },
      { path: 'Work', drop: true, mails: [mail({ size: 1 })] },
    ];
    await mm('search', 'older:1y');
    expect(out.stderr).toContain(CONNECTION_LOST);
    expect(out.stdout).not.toContain('Found');
    expect(events('search.finish')).toEqual([
      expect.objectContaining({ acct: A_ID, outcome: 'failed', reason: 'connection-lost' }),
    ]);
    expect(exitCode()).toBe(1);
  });

  it('a scope with no folders: "No mails match.", exit 0', async () => {
    behaviour.folders = [];
    await mm('search', 'older:1y');
    expect(out.stdout).toContain('No mails match.');
    expect(exitCode()).toBe(0);
  });

  it('a failed login: the generic login text, search.finish failed auth-failed, exit 1', async () => {
    openSession.mockRejectedValue(new ImapSessionError('auth-failed'));
    await mm('search', 'older:1y');
    expect(out.stderr).toContain(imapErrorText('auth-failed', { kind: 'this-computer' }));
    expect(events('search.finish')).toEqual([
      expect.objectContaining({ acct: A_ID, outcome: 'failed', reason: 'auth-failed' }),
    ]);
    expect(exitCode()).toBe(1);
  });
});

describe('mm search — output', () => {
  it('--json: one versioned object on stdout, the mailbox line on stderr', async () => {
    setTTY(process.stderr, true);
    await mm('search', 'older:1y', '--json');
    const parsed = jsonOut();
    expect(parsed['v']).toBe(1);
    expect(parsed['account']).toBe(A_ID);
    expect(out.stderr).toContain('Mailbox:');
    expect(out.stdout).not.toContain('Mailbox:');
    expect(exitCode()).toBe(0);
  });

  it('hostile server strings and filter: no control or bidi character on the terminal or in the JSON', async () => {
    behaviour.folders = [
      {
        path: HOSTILE,
        mails: [
          mail({
            size: 99,
            date: JUN_2024,
            address: 'sender@hostile.example',
            name: 'Name\x1b[2J\u202eEvil',
            subject: 'Sub\x1b[31mject\u202e',
          }),
        ],
      },
    ];
    await mm('search', 'older:1y');
    expect(exitCode()).toBe(0);
    for (const line of out.stdout.split('\n')) expect(unsafeChars(line)).toEqual([]);
    expect(out.stdout).toContain('Evil[31mRedFolder');

    process.exitCode = undefined;
    out = { stdout: '', stderr: '' };
    await mm('search', 'older:1y', '--json');
    for (const s of strings(jsonOut())) expect(unsafeChars(s)).toEqual([]);
  });

  it('a control character in the filter is refused before any login', async () => {
    await mm('search', 'older:1y', 'hostile\x1b');
    expect(out.stderr).toContain(lineErrorText({ code: 'unsupported', token: '' }));
    for (const line of [...out.stdout.split('\n'), ...out.stderr.split('\n')]) {
      expect(unsafeChars(line)).toEqual([]);
    }
    expect(openSession).not.toHaveBeenCalled();
    expect(calls).not.toContain('login');
    expect(exitCode()).toBe(1);
  });

  it('--body without a filter: the text is echoed as body:"…" on the filter line', async () => {
    await mm('search', '--body', 'invoice');
    expect(out.stdout).toContain('body:"invoice"');
    expect(out.stdout).toContain(BODY_WARNING);
  });
});

describe('mm search — rows the server no longer has', () => {
  it('a folder whose UIDVALIDITY changed before the list was read: its rows are counted as gone, not shown', async () => {
    behaviour.reset = ['Work'];
    await mm('search', 'older:1y');
    expect(out.stdout).toMatch(/^NEWEST \d+ OF \d+$/m);
    expect(out.stdout).toContain(
      "2 mails of this list couldn't be shown — gone from the server or not readable now.",
    );
    expect(reportLines().filter((l) => l.endsWith('(Work)'))).toEqual([]);
    expect(exitCode()).toBe(0);
  });

  it('a mail expunged between the search and the list: counted as gone, not shown', async () => {
    behaviour.expunged = ['Work'];
    await mm('search', 'older:1y');
    expect(out.stdout).toContain(
      "2 mails of this list couldn't be shown — gone from the server or not readable now.",
    );
    expect(reportLines().filter((l) => l.endsWith('(Work)'))).toEqual([]);
    expect(exitCode()).toBe(0);
  });
});

describe('mm search — logging', () => {
  it('canary: no filter value, body text, folder name, sender, subject, address, host or password in any record', async () => {
    behaviour.folders = [
      {
        path: 'Secret-Folder',
        mails: [
          mail({
            size: 10,
            date: JUN_2024,
            address: 'canary-sender@canary-domain.example',
            name: 'Canary Person',
            subject: 'CANARY-SUBJECT-xyz',
          }),
        ],
      },
    ];
    await mm('search', 'from:@shop.example subject:geheim older:1y', '--body', 'tajne');
    expect(exitCode()).toBe(0);
    const text = JSON.stringify(log.records);
    expect(text).toContain('search.finish');
    for (const needle of [
      EMAIL,
      HOST,
      PASSWORD,
      'example-test-domain',
      'shop.example',
      'geheim',
      'tajne',
      'Secret-Folder',
      'canary-sender',
      'canary-domain',
      'Canary Person',
      'CANARY-SUBJECT',
    ]) {
      expect(text).not.toContain(needle);
    }
  });

  it('command.start lists only the option names given, never their values', async () => {
    await runCli({
      argv: ['node', 'mm', 'search', 'x', '--json', '--sent'],
      build: (options) => buildProgram({ ...options, exitOverride: true }),
      log,
      ctx: CTX,
      proc: new StubProc(),
      flush: () => Promise.resolve(),
    }).catch((err: unknown) => {
      if (!(err instanceof ProcExit)) throw err;
    });
    const start = events('command.start')[0];
    expect([...(start?.['opts'] as string[])].sort()).toEqual(['json', 'sent']);
  });
});

describe('mm search — help', () => {
  it('the getting-started help lists step 7, mm search', async () => {
    await expect(mm('--help')).rejects.toBeInstanceOf(CommanderError);
    expect(out.stdout).toContain('7. mm search');
  });
});
