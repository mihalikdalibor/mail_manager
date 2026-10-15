import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { LocalCredentialProvider } from '../../src/core/credentials.js';
import { lineErrorText } from '../../src/cli/filter-text.js';
import type {
  AccountsRepo,
  AuditRepo,
  FiltersRepo,
  MailAccount,
  SavedFilter,
} from '../../src/core/db/repos.js';
import { parseFilterLine } from '../../src/core/filters/line.js';
import { parseFilter, type Filter } from '../../src/core/filters/schema.js';
import { ImapSessionError } from '../../src/core/imap/errors.js';
import { buildServerFeatures, sanitizeCapabilities } from '../../src/core/imap/features.js';
import type {
  FetchedMessage,
  ImapClientLike,
  ImapSession,
  OpenSessionOptions,
} from '../../src/core/imap/session.js';

// M3c `mm search --filter <name>` (spec). The saved filter is read from a fake `filters` repo in
// the services mock; Supabase, the IMAP socket and env files are mocked; the saved-filter core,
// the search core, the filter line and the CLI texts are real. The fake IMAP client answers LIST /
// EXAMINE, UID SEARCH and UID FETCH like imapflow, but it does not evaluate the criteria: what is
// asserted is the keys of the query it receives, the texts, the exit codes and the log.

const PASSWORD = 'hunter2-test-pw';
const EMAIL = 'someone@example-test-domain.eu';
const HOST = 'imap.example-test-domain.eu';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const A_ID = '3f2a91c0-5d4a-4b6f-9e21-7a8c0d1e2f34';
const MASTER = Buffer.alloc(32, 7);
const RUN = '0123456789abcdef';
const T0 = Date.UTC(2026, 9, 1, 9, 0, 0);
const SERVER_TEXT = 'NO [SERVERBUG] secret-server-text';

const FILTER_NAME_TEXT =
  'A filter name is 1–40 letters, digits, - or _, not starting with - (e.g. big-old).';
const BODY_WARNING =
  'Body search is done by the mail server — some servers are slow at it or search only part of a mail.';

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

/** The saved filters of the user: the search reads them by name. */
function fakeFilters(list: SavedFilter[]): FiltersRepo {
  return {
    create: () => Promise.reject(new Error('not used')),
    replace: () => Promise.reject(new Error('not used')),
    list: () => Promise.resolve({ filters: list, skipped: 0 }),
    getByName: (name: string) => Promise.resolve(list.find((f) => f.name === name) ?? null),
    remove: () => Promise.reject(new Error('not used')),
  };
}

/** A row as the repo maps it: the stored JSON through the schema, null when the schema refuses it. */
function storedRow(name: string, stored: unknown): SavedFilter {
  return savedRow(name, parseFilter(stored));
}

function savedRow(name: string, filter: Filter | null): SavedFilter {
  return {
    id: '5d0e7c1a-0000-4000-8000-000000000001',
    name,
    filter,
    createdAt: new Date(T0),
    updatedAt: new Date(T0),
  };
}

/** The filter of a line that must be read; fails the test when the line is refused. */
function filterOf(text: string): Filter {
  const result = parseFilterLine(text);
  if (!result.ok) throw new Error(`"${text}" was refused as ${result.error.code}`);
  return result.filter;
}

// ---- harness ----

let out = { stdout: '', stderr: '' };
let log: Log;
let rows: MailAccount[];
let saved: SavedFilter[];
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
  saved = [];
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
    filters: fakeFilters(saved),
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

/** Every key inside a query object, at any depth. */
function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => [k, ...keysOf(v)]);
  }
  return [];
}

// ---- tests ----

describe('mm search --filter — the saved filter', () => {
  it('saved alone: the query has larger, the Filter line names the filter and its line, criteria larger', async () => {
    saved = [savedRow('big-old', filterOf('larger:1mb'))];
    await mm('search', '--filter', 'big-old');
    expect(queries.length).toBeGreaterThan(0);
    for (const q of queries) expect(keysOf(q.query)).toContain('larger');
    expect(filterLine()).toBe('Filter: big-old (larger:1mb)');
    expect(events('search.finish')[0]?.['criteria']).toEqual(['larger']);
    expect(calls).toContain('login');
    expect(exitCode()).toBe(0);
  });

  it('combined: --filter with typed words and --body → the query has larger, from and body; the Filter line lists all', async () => {
    saved = [savedRow('big-old', filterOf('larger:1mb'))];
    await mm('search', '--filter', 'big-old', 'from:@shop.example', '--body', 'x');
    expect(queries.length).toBeGreaterThan(0);
    for (const q of queries) {
      expect(keysOf(q.query)).toEqual(expect.arrayContaining(['larger', 'from', 'body']));
    }
    expect(events('search.finish')[0]?.['criteria']).toEqual(
      expect.arrayContaining(['from', 'larger', 'body']),
    );
    expect(filterLine()).toBe('Filter: big-old (larger:1mb) from:@shop.example body:"x"');
    expect(exitCode()).toBe(0);
  });

  it('a saved filter with a body leaf: the body warning is printed', async () => {
    saved = [
      savedRow('big-old', {
        version: 1,
        where: { kind: 'all', of: [{ kind: 'body', value: 'x' }] },
      }),
    ];
    await mm('search', '--filter', 'big-old');
    expect(out.stdout).toContain(BODY_WARNING);
    expect(filterLine()).toBe('Filter: big-old (body:"x")');
    expect(exitCode()).toBe(0);
  });

  it('a saved filter that the line cannot print (any): usable, the Filter line says so', async () => {
    saved = [
      savedRow('either', {
        version: 1,
        where: {
          kind: 'all',
          of: [
            {
              kind: 'any',
              of: [
                { kind: 'word', value: 'a' },
                { kind: 'word', value: 'b' },
              ],
            },
          ],
        },
      }),
    ];
    await mm('search', '--filter', 'either');
    expect(filterLine()).toBe("Filter: either (can't be shown as a line)");
    expect(events('search.finish')).toEqual([expect.objectContaining({ outcome: 'ok' })]);
    expect(exitCode()).toBe(0);
  });

  it('a saved filter with no terms and no typed words: the no-terms text, no login, no search.finish, exit 1', async () => {
    saved = [savedRow('x', { version: 1, where: { kind: 'all', of: [] } })];
    await mm('search', '--filter', 'x');
    expect(out.stderr).toContain(
      'The saved filter "x" has no terms — save it again with --replace, or delete it.',
    );
    expect(calls).not.toContain('login');
    expect(events('search.finish')).toEqual([]);
    expect(exitCode()).toBe(1);
  });

  it('a saved filter that holds only an empty all node: the unreadable text, no login, exit 1', async () => {
    saved = [savedRow('x', { version: 1, where: { kind: 'all', of: [{ kind: 'all', of: [] }] } })];
    await mm('search', '--filter', 'x');
    expect(out.stderr).toContain(
      'The saved filter "x" can\'t be read — save it again with --replace, or delete it.',
    );
    expect(calls).not.toContain('login');
    expect(exitCode()).toBe(1);
  });

  it('a saved filter whose only body leaf is under not: the body warning is printed', async () => {
    saved = [
      savedRow('x', {
        version: 1,
        where: {
          kind: 'all',
          of: [
            { kind: 'larger', bytes: 1048576 },
            { kind: 'not', of: { kind: 'body', value: 'x' } },
          ],
        },
      }),
    ];
    await mm('search', '--filter', 'x');
    expect(out.stdout).toContain(BODY_WARNING);
    expect(exitCode()).toBe(0);
  });

  it('a stored any node holding an empty all: the unreadable text, no login, exit 1', async () => {
    saved = [
      storedRow('x', {
        version: 1,
        where: {
          kind: 'all',
          of: [
            {
              kind: 'any',
              of: [
                { kind: 'all', of: [] },
                { kind: 'larger', bytes: 5 },
              ],
            },
          ],
        },
      }),
    ];
    await mm('search', '--filter', 'x');
    expect(out.stderr).toContain(
      'The saved filter "x" can\'t be read — save it again with --replace, or delete it.',
    );
    expect(calls).not.toContain('login');
    expect(exitCode()).toBe(1);
  });

  it('a stored not of a not of an empty all: the unreadable text, no login, exit 1', async () => {
    saved = [
      storedRow('x', {
        version: 1,
        where: {
          kind: 'all',
          of: [{ kind: 'not', of: { kind: 'not', of: { kind: 'all', of: [] } } }],
        },
      }),
    ];
    await mm('search', '--filter', 'x');
    expect(out.stderr).toContain(
      'The saved filter "x" can\'t be read — save it again with --replace, or delete it.',
    );
    expect(calls).not.toContain('login');
    expect(exitCode()).toBe(1);
  });

  it('an empty saved filter with typed words: refused as a whole, the no-terms text, no login, exit 1', async () => {
    saved = [storedRow('x', { version: 1, where: { kind: 'all', of: [] } })];
    await mm('search', '--filter', 'x', 'from:@shop.example');
    expect(out.stderr).toContain(
      'The saved filter "x" has no terms — save it again with --replace, or delete it.',
    );
    expect(calls).not.toContain('login');
    expect(exitCode()).toBe(1);
  });

  it('a stored since with a future day: only a check, the search runs; exit 0, search.finish ok', async () => {
    saved = [
      storedRow('x', {
        version: 1,
        where: { kind: 'all', of: [{ kind: 'since', day: '2099-01-01' }] },
      }),
    ];
    await mm('search', '--filter', 'x');
    expect(calls).toContain('login');
    expect(events('search.finish')).toEqual([expect.objectContaining({ outcome: 'ok' })]);
    expect(exitCode()).toBe(0);
  });

  it('saved filter plus typed words over the 50-node limit: the unsupported text, no login, exit 1', async () => {
    saved = [
      savedRow('big-old', {
        version: 1,
        where: {
          kind: 'all',
          of: Array.from({ length: 45 }, (_v, i) => ({ kind: 'word' as const, value: `w${i}` })),
        },
      }),
    ];
    const typed = Array.from({ length: 10 }, (_v, i) => `t${i}`);
    await mm('search', '--filter', 'big-old', ...typed);
    expect(out.stderr).toContain(lineErrorText({ code: 'unsupported', token: '' }));
    expect(calls).not.toContain('login');
    expect(exitCode()).toBe(1);
  });
});

describe('mm search --filter — refusals before any login', () => {
  it('an unknown name: the not-found text, no IMAP login, no search.finish, exit 1', async () => {
    await mm('search', '--filter', 'nope');
    expect(out.stderr).toContain('No saved filter named "nope" — see `mm filter list`.');
    expect(openSession).not.toHaveBeenCalled();
    expect(calls).not.toContain('login');
    expect(events('search.finish')).toEqual([]);
    expect(exitCode()).toBe(1);
  });

  it('an unreadable row (filter null): the unreadable text, no login, exit 1', async () => {
    saved = [savedRow('broken', null)];
    await mm('search', '--filter', 'broken');
    expect(out.stderr).toContain(
      'The saved filter "broken" can\'t be read — save it again with --replace, or delete it.',
    );
    expect(calls).not.toContain('login');
    expect(exitCode()).toBe(1);
  });

  it('a bad name: the name text before the user lookup, exit 1', async () => {
    await mm('search', '--filter', 'a b');
    expect(out.stderr).toContain(FILTER_NAME_TEXT);
    expect(currentUser).not.toHaveBeenCalled();
    expect(createSupabaseServices).not.toHaveBeenCalled();
    expect(calls).not.toContain('login');
    expect(exitCode()).toBe(1);
  });
});

describe('mm search --filter — output', () => {
  it('--json: saved is the name; without --filter saved is null', async () => {
    saved = [savedRow('big-old', filterOf('larger:1mb'))];
    await mm('search', '--filter', 'big-old', '--json');
    expect(jsonOut()['v']).toBe(1);
    expect(jsonOut()['saved']).toBe('big-old');
    expect(exitCode()).toBe(0);

    process.exitCode = undefined;
    out = { stdout: '', stderr: '' };
    await mm('search', 'older:1y', '--json');
    expect(jsonOut()['v']).toBe(1);
    expect(jsonOut()['saved']).toBeNull();
    expect(exitCode()).toBe(0);
  });
});
