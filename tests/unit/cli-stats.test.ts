import { CommanderError } from 'commander';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { formatBytes } from '../../src/cli/folders-text.js';
import { imapErrorText } from '../../src/cli/imap-errors.js';
import { sanitize } from '../../src/cli/log-text.js';
import { LocalCredentialProvider } from '../../src/core/credentials.js';
import type { AccountsRepo, AuditRepo, MailAccount } from '../../src/core/db/repos.js';
import { ImapSessionError } from '../../src/core/imap/errors.js';
import { buildServerFeatures, sanitizeCapabilities } from '../../src/core/imap/features.js';
import type {
  FetchedMessage,
  ImapClientLike,
  ImapSession,
  OpenSessionOptions,
} from '../../src/core/imap/session.js';

// M2c-1 `mm stats [id] [--folder <path>] [--json]` (spec). Supabase, the IMAP socket and env
// files are mocked; the accounts core, login guard, listFolders, collectStats, credential
// decryption and the CLI texts are real. The fake IMAP client answers LIST / EXAMINE + FETCH like
// imapflow. Dates sit at noon in mid-June so the year and day don't depend on the machine's zone.

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
const BOOM = new Error('boom in the aggregator path');

const NOT_LOGGED_IN = 'Not logged in — run `mm login`';
const ID_FORMAT = 'A mailbox id is 4–36 characters 0-9, a-f (from `mm account list`).';
const GENERIC = imapErrorText('auth-failed', { kind: 'this-computer' });
const FOLDER_NOT_FOUND =
  'There is no folder with that path in this mailbox — use the full path from `mm folders --json` (e.g. "INBOX.Sent" or "[Gmail]/Sent Mail").';
const GMAIL_HIDDEN =
  'Gmail hides "All Mail" from IMAP for this account, so the totals can\'t be counted without double counting labels. Turn on "Show in IMAP" for All Mail in Gmail\'s settings (Labels), or pick one folder with --folder.';
const CONNECTION_LOST = 'The connection to the mail server was lost';

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
  /** EXAMINE is refused. */
  lockThrows?: boolean;
  /** The FETCH fails (a tagged NO) after this many messages of the folder. */
  failAfter?: number;
  /** The connection drops during the FETCH of this folder. */
  drop?: boolean;
  /** Messages from this sequence number on are not yielded at all (no error: a silent short read). */
  skipFrom?: number;
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
const DEFAULT_MESSAGES = 7;
const DEFAULT_BYTES = 1_048_576 + 524_288 + 2048 + 1024 + 1024 + 100 + 50;

interface Behaviour {
  folders: FakeFolder[];
  caps: Record<string, true>;
  listError?: Error;
  quota?: { usage: number; limit: number };
}

let behaviour: Behaviour;
let calls: string[];

function fakeSession(): ImapSession {
  const state = { closed: false };
  const b = behaviour;
  let selected = '';
  let yielded = 0;
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
            subscribed: true,
          };
        }),
      );
    },
    status: (path) => {
      calls.push(`status ${path}`);
      return Promise.resolve(false);
    },
    getQuota: () => {
      calls.push('quota');
      return Promise.resolve(
        b.quota === undefined ? false : { storage: { usage: b.quota.usage, limit: b.quota.limit } },
      );
    },
    getMailboxLock: (path, opts) => {
      calls.push(`examine ${path} ${opts?.readOnly === true ? 'ro' : 'RW'}`);
      const f = b.folders.find((x) => x.path === path);
      if (f === undefined || f.lockThrows === true) return Promise.reject(new Error(SERVER_TEXT));
      selected = path;
      yielded = 0;
      (client as { mailbox: { exists: number } | false }).mailbox = {
        exists: f.mails?.length ?? 0,
      };
      return Promise.resolve({ path, release: () => calls.push(`release ${path}`) });
    },
    fetch: (range, query) => {
      calls.push(`fetch ${range} ${Object.keys(query).sort().join(',')}`);
      const f = b.folders.find((x) => x.path === selected);
      const [a, z] = range.split(':').map(Number);
      return (async function* () {
        await Promise.resolve();
        for (let seq = a ?? 1; seq <= (z ?? 0); seq++) {
          const m = f?.mails?.[seq - 1];
          if (m === undefined) continue;
          if (f?.skipFrom !== undefined && seq >= f.skipFrom) continue;
          if (f?.failAfter !== undefined && yielded >= f.failAfter) {
            throw new Error(SERVER_TEXT);
          }
          if (f?.drop === true) {
            state.closed = true;
            throw new Error(SERVER_TEXT);
          }
          yielded++;
          yield { ...m, seq };
        }
      })();
    },
  };
  const caps = sanitizeCapabilities({
    IMAP4REV1: true,
    ...(b.quota !== undefined && { QUOTA: true as const }),
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

/** The day (YYYY-MM-DD) of a date in the zone the CLI reads from the machine. */
function localDay(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function esc(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The text report: stdout without the `Mailbox:` line, split into blank-line separated blocks. */
function blocks(): string[] {
  return out.stdout
    .split('\n')
    .filter((l) => !l.startsWith('Mailbox:'))
    .join('\n')
    .split(/\n[ \t]*\n/)
    .map((b) => b.trim())
    .filter((b) => b !== '');
}

function block(heading: string): string {
  const found = blocks().find((b) => (b.split('\n')[0] ?? '').startsWith(heading));
  if (found === undefined) throw new Error(`no section "${heading}" in:\n${out.stdout}`);
  return found;
}

/** A table row: key, a count and a size, separated by spaces. */
function rowRe(key: string, n: string, size: string): RegExp {
  return new RegExp(`^\\s*${esc(key)}\\s+${esc(n)}\\s+${esc(size)}\\s*$`, 'm');
}

function folderRows(count: number, messages = 0): FakeFolder[] {
  return Array.from({ length: count }, (_v, i) => ({
    path: `F${i}`,
    mails: Array.from({ length: messages }, () => mail({ size: 1 })),
  }));
}

/** Control characters and the bidi override: what a terminal must never receive. */
function unsafeChars(text: string): string[] {
  return [...text].filter((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f || code === 0x202e;
  });
}

function jsonOut(): Record<string, unknown> {
  return JSON.parse(out.stdout) as Record<string, unknown>;
}

// ---- tests ----

describe('mm stats — which mailbox', () => {
  it('no id + exactly one saved mailbox: uses it and names it', async () => {
    await mm('stats');
    expect(out.stdout).toContain(`Mailbox: ${EMAIL} (Websupport, id ${short(A_ID)})`);
    expect(calls).toContain('login');
    expect(exitCode()).toBe(0);
  });

  it('no id + no saved mailbox: "No mailboxes yet", no login, no stats.finish, exit 1', async () => {
    rows = [];
    await mm('stats');
    expect(out.stderr).toContain('No mailboxes yet — run `mm account add <email>`.');
    expect(calls).not.toContain('login');
    expect(events('stats.finish')).toEqual([]);
    expect(exitCode()).toBe(1);
  });

  it('no id + several saved mailboxes: asks for an id (mm stats <id>), no login, exit 1', async () => {
    rows = [row(A_ID), row(B_ID)];
    await mm('stats');
    expect(out.stderr).toContain('Several mailboxes saved — run `mm stats <id>`');
    expect(calls).not.toContain('login');
    expect(exitCode()).toBe(1);
  });

  it('an id picks that mailbox among several', async () => {
    rows = [row(A_ID), row(B_ID)];
    await mm('stats', short(B_ID));
    expect(out.stdout).toContain(`id ${short(B_ID)}`);
    expect(exitCode()).toBe(0);
  });

  it('an invalid id: the id format text before anything else, exit 1', async () => {
    await mm('stats', 'not-an-id!');
    expect(out.stderr).toContain(ID_FORMAT);
    expect(currentUser).not.toHaveBeenCalled();
    expect(exitCode()).toBe(1);
  });

  it('an unknown id: "No mailbox with id …", exit 1', async () => {
    await mm('stats', 'abcd');
    expect(out.stderr).toContain('No mailbox with id abcd');
    expect(exitCode()).toBe(1);
  });

  it('not logged in → the login hint, no login to the mail server, exit 1', async () => {
    currentUser.mockResolvedValue(null);
    await mm('stats');
    expect(out.stderr).toContain(NOT_LOGGED_IN);
    expect(calls).not.toContain('login');
    expect(exitCode()).toBe(1);
  });
});

describe('mm stats — help', () => {
  it('the getting-started help lists step 6, mm stats', async () => {
    await expect(mm('--help')).rejects.toBeInstanceOf(CommanderError);
    expect(out.stdout).toContain('6. mm stats [id]');
    expect(out.stdout).toContain('where the space goes: senders, years, largest mails');
  });

  it('mm stats --help names --folder and --json', async () => {
    await expect(mm('stats', '--help')).rejects.toBeInstanceOf(CommanderError);
    expect(out.stdout).toContain('--folder');
    expect(out.stdout).toContain('--json');
  });
});

describe('mm stats — what it asks the server', () => {
  it('read-only only: LIST without STATUS, EXAMINE read-only + released, FETCH of the stats fields', async () => {
    await mm('stats');
    expect(calls.filter((c) => c.startsWith('status '))).toEqual([]);
    expect(calls).toContain('list');
    expect(calls).not.toContain('list +status');
    const examines = calls.filter((c) => c.startsWith('examine '));
    expect(examines).toEqual([
      'examine INBOX ro',
      'examine Sent ro',
      'examine Trash ro',
      'examine Work ro',
    ]);
    expect(calls.filter((c) => c.startsWith('release ')).length).toBe(examines.length);
    const fetches = calls.filter((c) => c.startsWith('fetch '));
    expect(fetches.length).toBeGreaterThan(0);
    for (const f of fetches) expect(f.endsWith(' envelope,internalDate,size')).toBe(true);
    expect(calls.at(-1)).toBe('logout');
  });

  it('one login only', async () => {
    await mm('stats');
    expect(calls.filter((c) => c === 'login')).toHaveLength(1);
  });
});

describe('mm stats — text report', () => {
  it('first section: scanned folders, messages, total size and the "approx." note', async () => {
    await mm('stats');
    expect(blocks()[0]).toContain(
      `Scanned 4 folders, ${DEFAULT_MESSAGES} messages, ${formatBytes(DEFAULT_BYTES)} — sizes are approx. (message sizes, not the quota)`,
    );
    expect(exitCode()).toBe(0);
  });

  it('sections come in order: scanned line, folder table, per year, senders, domains, largest', async () => {
    await mm('stats');
    const firsts = blocks().map((b) => b.split('\n')[0] ?? '');
    const order = [
      /^Scanned /,
      /^FOLDER\s+MESSAGES\s+SIZE$/,
      /^PER YEAR$/,
      /^TOP SENDERS BY MESSAGES$/,
      /^TOP SENDERS BY SIZE$/,
      /^TOP DOMAINS BY MESSAGES$/,
      /^TOP DOMAINS BY SIZE$/,
      /^LARGEST MAILS$/,
    ];
    const at = order.map((re) => firsts.findIndex((l) => re.test(l)));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it('the folder table lists every scanned folder, in order, with messages and size', async () => {
    await mm('stats');
    const table = block('FOLDER');
    expect(table).toMatch(rowRe('INBOX', '3', formatBytes(1_048_576 + 524_288 + 2048)));
    expect(table).toMatch(rowRe('Work', '2', formatBytes(2048)));
    expect(table).toMatch(rowRe('Sent', '1', formatBytes(100)));
    expect(table).toMatch(rowRe('Trash', '1', formatBytes(50)));
    const names = table
      .split('\n')
      .slice(1)
      .map((l) => l.trim().split(/\s+/)[0]);
    // Tree order: INBOX, then special-use folders, then the rest by path.
    expect(names).toEqual(['INBOX', 'Sent', 'Trash', 'Work']);
  });

  it('PER YEAR: one row per year (ascending) plus "unknown" last', async () => {
    await mm('stats');
    const per = block('PER YEAR');
    expect(per).toMatch(rowRe('2023', '2', formatBytes(524_288 + 100)));
    expect(per).toMatch(rowRe('2024', '4', formatBytes(1_048_576 + 1024 + 1024 + 50)));
    expect(per).toMatch(rowRe('unknown', '1', formatBytes(2048)));
    const years = per
      .split('\n')
      .slice(1)
      .map((l) => l.trim().split(/\s+/)[0]);
    expect(years).toEqual(['2023', '2024', 'unknown']);
  });

  it('top senders by messages and by size; one key for upper-case variants; "(no address)"', async () => {
    await mm('stats');
    const byCount = block('TOP SENDERS BY MESSAGES');
    expect(byCount).toMatch(
      rowRe('alice@example-sender.test', '2', formatBytes(1_048_576 + 524_288)),
    );
    expect(byCount).toMatch(rowRe('bob@shop.example', '2', formatBytes(2048)));
    expect(byCount).toMatch(rowRe('(no address)', '1', formatBytes(2048)));
    const bySize = block('TOP SENDERS BY SIZE');
    const first = bySize.split('\n')[1] ?? '';
    expect(first).toContain('alice@example-sender.test');
    expect(bySize).toContain('(no address)');
  });

  it('top domains by messages and by size', async () => {
    await mm('stats');
    expect(block('TOP DOMAINS BY MESSAGES')).toMatch(
      rowRe('example-sender.test', '2', formatBytes(1_048_576 + 524_288)),
    );
    expect(block('TOP DOMAINS BY MESSAGES')).toMatch(rowRe('shop.example', '2', formatBytes(2048)));
    const bySize = block('TOP DOMAINS BY SIZE');
    expect(bySize.split('\n')[1] ?? '').toContain('example-sender.test');
  });

  it('LARGEST MAILS: date, size, from, subject and (folder), the largest first', async () => {
    await mm('stats');
    const largest = block('LARGEST MAILS');
    const lines = largest.split('\n').slice(1);
    expect(lines[0]).toMatch(
      new RegExp(
        `^\\s*${localDay(JUN_2024)}\\s+1\\.0 MB\\s+Alice A\\s+Quarterly report\\s+\\(INBOX\\)\\s*$`,
      ),
    );
    expect(lines).toHaveLength(DEFAULT_MESSAGES);
    expect(lines[1]).toMatch(
      new RegExp(
        `^\\s*${localDay(JUN_2023)}\\s+512\\.0 KB\\s+ALICE@example-sender\\.test\\s+Old\\s+\\(INBOX\\)\\s*$`,
      ),
    );
  });

  it("LARGEST dates and PER YEAR use the machine's time zone, not UTC (Pacific/Kiritimati, UTC+14)", async () => {
    const originalTZ = process.env['TZ'];
    process.env['TZ'] = 'Pacific/Kiritimati';
    try {
      // The runtime must really have switched, or this test would prove nothing.
      expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('Pacific/Kiritimati');
      behaviour.folders = [
        {
          path: 'INBOX',
          mails: [
            mail({ size: 300, date: JUN_2024, address: 'a@x.example', subject: 'June' }),
            mail({
              size: 200,
              date: new Date('2023-12-31T12:00:00Z'),
              address: 'b@x.example',
              subject: 'New Year',
            }),
          ],
        },
      ];
      await mm('stats');
    } finally {
      if (originalTZ === undefined) delete process.env['TZ'];
      else process.env['TZ'] = originalTZ;
    }
    const largest = block('LARGEST MAILS').split('\n').slice(1);
    // 2024-06-15T12:00Z is already the 16th, 02:00 in Kiritimati; 2023-12-31T12:00Z is 2024-01-01.
    expect(largest[0]).toMatch(/^\s*2024-06-16\s+300 B\s/);
    expect(largest[1]).toMatch(/^\s*2024-01-01\s+200 B\s/);
    const per = block('PER YEAR');
    expect(per).toMatch(rowRe('2024', '2', '500 B'));
    expect(per).not.toContain('2023');
  });

  it('a mail without a date shows "-" in LARGEST MAILS', async () => {
    await mm('stats');
    const line = block('LARGEST MAILS')
      .split('\n')
      .find((l) => l.includes('No sender, no date'));
    expect(line).toMatch(/^\s*-\s+2\.0 KB\s/);
  });

  it('counts have thousands separators', async () => {
    behaviour.folders = [
      {
        path: 'INBOX',
        mails: Array.from({ length: 1234 }, () => mail({ size: 10, date: JUN_2024 })),
      },
    ];
    await mm('stats');
    expect(blocks()[0]).toContain('1,234 messages');
    expect(block('FOLDER')).toMatch(/^INBOX\s+1,234\s/m);
    expect(block('PER YEAR')).toMatch(/^\s*2024\s+1,234\s/m);
  });

  it('the quota line closes the report on a whole-mailbox run', async () => {
    await mm('stats');
    expect(out.stdout).toContain('Quota: not available from the mail server');
    expect(out.stdout.trimEnd().split('\n').at(-1)).toBe(
      'Quota: not available from the mail server',
    );
  });

  it('a reported quota is shown like in mm folders', async () => {
    behaviour.quota = { usage: 5120, limit: 10_240 };
    await mm('stats');
    expect(out.stdout).toContain('Quota: 5.0 KB of 10.0 KB used (50%)');
  });

  it('an empty mailbox: every section prints its heading and "(none)"', async () => {
    behaviour.folders = [{ path: 'INBOX', mails: [] }];
    await mm('stats');
    expect(blocks()[0]).toContain('Scanned 1 folder, 0 messages, 0 B');
    for (const heading of [
      'PER YEAR',
      'TOP SENDERS BY MESSAGES',
      'TOP SENDERS BY SIZE',
      'TOP DOMAINS BY MESSAGES',
      'TOP DOMAINS BY SIZE',
      'LARGEST MAILS',
    ]) {
      expect(block(heading)).toMatch(/\n\s*\(none\)\s*$/);
    }
    expect(block('FOLDER')).toMatch(rowRe('INBOX', '0', '0 B'));
    expect(exitCode()).toBe(0);
  });

  it('past 50,000 distinct senders: an "others" row and "(approximate)" headings', async () => {
    behaviour.folders = [
      {
        path: 'INBOX',
        mails: Array.from({ length: 50_001 }, (_v, i) =>
          mail({ size: 100, date: JUN_2024, address: `u${i}@d${i}.example` }),
        ),
      },
    ];
    await mm('stats');
    for (const heading of [
      'TOP SENDERS BY MESSAGES (approximate)',
      'TOP SENDERS BY SIZE (approximate)',
      'TOP DOMAINS BY MESSAGES (approximate)',
      'TOP DOMAINS BY SIZE (approximate)',
    ]) {
      const section = block(heading);
      expect(section.split('\n').at(-1)).toMatch(rowRe('others', '1', '100 B'));
    }
    expect(exitCode()).toBe(0);
  }, 60_000);

  it('without a cap overflow the headings carry no "(approximate)"', async () => {
    await mm('stats');
    expect(out.stdout).not.toContain('(approximate)');
    expect(out.stdout).not.toContain('others');
  });
});

describe('mm stats — folders that could not be read fully', () => {
  it('a refused EXAMINE: row "—", the note on the first line, the scan goes on, exit 0', async () => {
    behaviour.folders = [
      { path: 'INBOX', mails: [mail({ size: 10, date: JUN_2024 })] },
      { path: 'Broken', lockThrows: true },
      { path: 'Broken2', lockThrows: true },
    ];
    await mm('stats');
    expect(blocks()[0]).toContain("; 2 folders couldn't be read");
    expect(block('FOLDER')).toMatch(/^Broken\s+—\s+—\s*$/m);
    expect(block('FOLDER')).toMatch(rowRe('INBOX', '1', '10 B'));
    expect(out.stderr).not.toContain('secret-server-text');
    expect(exitCode()).toBe(0);
  });

  it('a failure after some messages: "(partial)" after the size, counts kept, the note, exit 0', async () => {
    behaviour.folders = [
      {
        path: 'Cut',
        failAfter: 1,
        mails: [mail({ size: 10, date: JUN_2024 }), mail({ size: 20, date: JUN_2024 })],
      },
      { path: 'Fine', mails: [mail({ size: 5, date: JUN_2024 })] },
    ];
    await mm('stats');
    expect(blocks()[0]).toContain('; 1 folder read only partly');
    expect(block('FOLDER')).toMatch(/^Cut\s+1\s+10 B \(partial\)\s*$/m);
    expect(block('FOLDER')).toMatch(rowRe('Fine', '1', '5 B'));
    expect(blocks()[0]).toContain('2 messages');
    expect(exitCode()).toBe(0);
  });

  it('both notes, in order: could not be read, then read only partly', async () => {
    behaviour.folders = [
      { path: 'Broken', lockThrows: true },
      { path: 'Cut', failAfter: 1, mails: [mail({ size: 10 }), mail({ size: 10 })] },
    ];
    await mm('stats');
    const first = blocks()[0] ?? '';
    const a = first.indexOf("1 folder couldn't be read");
    const b = first.indexOf('1 folder read only partly');
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
  });
});

describe('mm stats — "Not scanned"', () => {
  const NOTE = '(Gmail labels or virtual folders; their mail is counted in the folders above)';

  it('Gmail: only All Mail, Trash and Spam are scanned; labels are counted as not scanned', async () => {
    behaviour.caps = { 'X-GM-EXT-1': true };
    behaviour.folders = [
      { path: 'INBOX', mails: [mail({ size: 1 }), mail({ size: 1 })] },
      { path: '[Gmail]', flags: ['\\Noselect'] },
      {
        path: '[Gmail]/All Mail',
        specialUse: '\\All',
        mails: Array.from({ length: 3 }, () => mail({ size: 10 })),
      },
      { path: '[Gmail]/Spam', specialUse: '\\Junk', mails: [mail({ size: 10 })] },
      { path: '[Gmail]/Trash', specialUse: '\\Trash', mails: [mail({ size: 10 })] },
      { path: 'Work', mails: [mail({ size: 1 })] },
    ];
    await mm('stats');
    expect(
      calls.filter((c) => c.startsWith('examine ')).map((c) => c.split(' ').slice(1, -1).join(' ')),
    ).toEqual(['[Gmail]/All Mail', '[Gmail]/Spam', '[Gmail]/Trash']);
    const first = blocks()[0] ?? '';
    expect(first).toContain('Scanned 3 folders, 5 messages');
    expect(first).toContain(`Not scanned: 2 folders ${NOTE}`);
    expect(exitCode()).toBe(0);
  });

  it('a virtual \\All folder on another server is skipped and counted', async () => {
    behaviour.folders = [
      { path: 'INBOX', mails: [mail({ size: 1 })] },
      { path: 'Everything', specialUse: '\\All', mails: [mail({ size: 1 }), mail({ size: 1 })] },
    ];
    await mm('stats');
    expect(calls).not.toContain('examine Everything ro');
    expect(blocks()[0]).toContain(`Not scanned: 1 folder ${NOTE}`);
    expect(blocks()[0]).toContain('Scanned 1 folder, 1 message');
  });

  it('nothing skipped: no "Not scanned" line', async () => {
    await mm('stats');
    expect(out.stdout).not.toContain('Not scanned');
  });
});

describe('mm stats — hostile server strings', () => {
  const EVIL_SUBJECT = `Sub\x1b[31mject‮${'x'.repeat(10_000)}`;
  const EVIL_NAME = 'Name\x1b[2J‮Evil😀';

  beforeEach(() => {
    behaviour.folders = [
      {
        path: HOSTILE,
        mails: [
          mail({
            size: 99,
            date: JUN_2024,
            address: 'sender@hostile.example',
            name: EVIL_NAME,
            subject: EVIL_SUBJECT,
          }),
        ],
      },
    ];
  });

  it('text: no control or bidi characters, long subjects cut', async () => {
    await mm('stats');
    expect(out.stdout).not.toContain('\x1b');
    expect(out.stdout).not.toContain('‮');
    expect(out.stdout).toContain('Evil[31mRedFolder');
    expect(out.stdout).toContain('😀');
    expect(out.stdout).not.toContain('x'.repeat(501));
    expect(exitCode()).toBe(0);
  });

  it('JSON: strings sanitised and cut too', async () => {
    await mm('stats', '--json');
    const parsed = jsonOut() as {
      folders: { path: string }[];
      largest: { folder: string; from: string; subject: string }[];
    };
    expect(parsed.folders[0]?.path).toBe('Evil[31mRedFolder');
    const top = parsed.largest[0];
    expect(top?.folder).toBe('Evil[31mRedFolder');
    expect(unsafeChars(top?.from ?? '')).toEqual([]);
    expect(unsafeChars(top?.subject ?? '')).toEqual([]);
    expect([...(top?.subject ?? '')].length).toBeLessThanOrEqual(500);
  });
});

describe('mm stats --json', () => {
  it('one versioned object on stdout (jq-parsable), the mailbox line on stderr', async () => {
    setTTY(process.stderr, true);
    await mm('stats', '--json');
    const parsed = jsonOut();
    expect(parsed['v']).toBe(1);
    expect(parsed['account']).toBe(A_ID);
    expect(Object.keys(parsed).sort()).toEqual(
      [
        'account',
        'folders',
        'notScanned',
        'totals',
        'years',
        'senders',
        'domains',
        'largest',
        'approximate',
        'unreadable',
        'partial',
        'truncated',
        'quota',
        'scope',
        'v',
      ].sort(),
    );
    expect(out.stderr).toContain('Mailbox:');
    expect(out.stdout).not.toContain('Mailbox:');
    expect(out.stderr).not.toContain('Reading folder');
    expect(exitCode()).toBe(0);
  });

  it('carries the totals, folder rows, years, ranked rows and largest mails', async () => {
    await mm('stats', '--json');
    const j = jsonOut() as Record<string, unknown> & {
      scope: unknown;
      folders: unknown[];
      senders: {
        byCount: { key: string | null; messages: number; bytes: number }[];
        others: unknown;
      };
      domains: { bySize: { key: string | null }[] };
      largest: {
        folder: string;
        received: string | null;
        from: string | null;
        subject: string | null;
        bytes: number;
      }[];
    };
    expect(j.scope).toEqual({ folder: null, gmail: false });
    expect(j['totals']).toEqual({ messages: DEFAULT_MESSAGES, bytes: DEFAULT_BYTES });
    expect(j.folders).toEqual([
      { path: 'INBOX', messages: 3, bytes: 1_048_576 + 524_288 + 2048, partial: false },
      { path: 'Sent', messages: 1, bytes: 100, partial: false },
      { path: 'Trash', messages: 1, bytes: 50, partial: false },
      { path: 'Work', messages: 2, bytes: 2048, partial: false },
    ]);
    expect(j['years']).toEqual([
      { year: '2023', messages: 2, bytes: 524_288 + 100 },
      { year: '2024', messages: 4, bytes: 1_048_576 + 2048 + 50 },
      { year: 'unknown', messages: 1, bytes: 2048 },
    ]);
    expect(j.senders.byCount).toContainEqual({
      key: 'alice@example-sender.test',
      messages: 2,
      bytes: 1_048_576 + 524_288,
    });
    expect(j.senders.byCount).toContainEqual({ key: null, messages: 1, bytes: 2048 });
    expect(j.senders.others).toEqual({ messages: 0, bytes: 0 });
    expect(j.domains.bySize[0]?.key).toBe('example-sender.test');
    expect(j['notScanned']).toBe(0);
    expect(j['approximate']).toBe(false);
    expect(j['unreadable']).toBe(0);
    expect(j['partial']).toBe(0);
    expect(j['truncated']).toBe(false);
    expect(j.largest[0]).toEqual({
      folder: 'INBOX',
      received: '2024-06-15T12:00:00.000Z',
      from: 'Alice A',
      subject: 'Quarterly report',
      bytes: 1_048_576,
    });
    expect(j.largest).toHaveLength(DEFAULT_MESSAGES);
    expect(j.largest.find((l) => l.subject === 'No sender, no date')?.received).toBeNull();
  });

  it('unreadable and partial rows: null counts / partial flag, and the counters', async () => {
    behaviour.folders = [
      { path: 'Broken', lockThrows: true },
      { path: 'Cut', failAfter: 1, mails: [mail({ size: 10 }), mail({ size: 20 })] },
    ];
    await mm('stats', '--json');
    const j = jsonOut() as { folders: unknown[]; unreadable: number; partial: number };
    expect(j.folders).toEqual([
      { path: 'Broken', messages: null, bytes: null, partial: false },
      { path: 'Cut', messages: 1, bytes: 10, partial: true },
    ]);
    expect(j.unreadable).toBe(1);
    expect(j.partial).toBe(1);
  });

  it('whole mailbox: the reported quota is in the JSON', async () => {
    behaviour.quota = { usage: 5120, limit: 10_240 };
    await mm('stats', '--json');
    expect(jsonOut()['quota']).toEqual({ usedBytes: 5120, limitBytes: 10_240 });
  });

  it('Gmail: scope.gmail is true and notScanned counts the labels', async () => {
    behaviour.caps = { 'X-GM-EXT-1': true };
    behaviour.folders = [
      { path: '[Gmail]/All Mail', specialUse: '\\All', mails: [mail({ size: 10 })] },
      { path: 'Work', mails: [mail({ size: 1 })] },
    ];
    await mm('stats', '--json');
    const j = jsonOut();
    expect(j['scope']).toEqual({ folder: null, gmail: true });
    expect(j['notScanned']).toBe(1);
  });

  it('a failure prints nothing on stdout (no half JSON)', async () => {
    behaviour.folders = [{ path: 'INBOX', drop: true, mails: [mail({ size: 1 })] }];
    await mm('stats', '--json');
    expect(out.stdout).toBe('');
    expect(out.stderr).toContain(CONNECTION_LOST);
    expect(exitCode()).toBe(1);
  });
});

describe('mm stats --folder', () => {
  it('reads just that folder; no quota line, no "Not scanned"', async () => {
    await mm('stats', '--folder', 'Work');
    expect(calls.filter((c) => c.startsWith('examine '))).toEqual(['examine Work ro']);
    expect(blocks()[0]).toContain('Scanned 1 folder, 2 messages');
    expect(block('FOLDER')).toMatch(rowRe('Work', '2', formatBytes(2048)));
    expect(out.stdout).not.toContain('Quota:');
    expect(out.stdout).not.toContain('Not scanned');
    expect(exitCode()).toBe(0);
  });

  it('INBOX is matched case-insensitively', async () => {
    await mm('stats', '--folder', 'inbox');
    expect(calls.filter((c) => c.startsWith('examine '))).toEqual(['examine INBOX ro']);
    expect(exitCode()).toBe(0);
  });

  it('--json --folder: scope.folder is the path and quota is null even when the server reports one', async () => {
    behaviour.quota = { usage: 5120, limit: 10_240 };
    await mm('stats', '--folder', 'Work', '--json');
    const j = jsonOut();
    expect(j['scope']).toEqual({ folder: 'Work', gmail: false });
    expect(j['quota']).toBeNull();
    expect(j['totals']).toEqual({ messages: 2, bytes: 2048 });
  });

  it('Gmail: a label can be asked for and scans just that label', async () => {
    behaviour.caps = { 'X-GM-EXT-1': true };
    behaviour.folders = [
      { path: '[Gmail]/All Mail', specialUse: '\\All', mails: [mail({ size: 10 })] },
      { path: 'Work', mails: [mail({ size: 1 }), mail({ size: 1 })] },
    ];
    await mm('stats', '--folder', 'Work');
    expect(calls.filter((c) => c.startsWith('examine '))).toEqual(['examine Work ro']);
    expect(blocks()[0]).toContain('Scanned 1 folder, 2 messages');
  });

  it.each([
    ['an unknown path', 'Nowhere'],
    ['a made-up sub-path', 'Sent/Sub'],
    ['a different case (only INBOX is case-insensitive)', 'work'],
  ])('%s → the folder-not-found text, no EXAMINE, exit 1', async (_name, folder) => {
    await mm('stats', '--folder', folder);
    expect(out.stderr).toContain(FOLDER_NOT_FOUND);
    expect(out.stdout).not.toContain('FOLDER');
    expect(calls.some((c) => c.startsWith('examine '))).toBe(false);
    expect(calls.at(-1)).toBe('logout');
    expect(events('stats.finish')).toEqual([
      expect.objectContaining({ acct: A_ID, outcome: 'failed', reason: 'folder-not-found' }),
    ]);
    expect(exitCode()).toBe(1);
  });

  it('a short name that is the last segment of a longer path → folder-not-found', async () => {
    behaviour.folders = [
      { path: 'INBOX', mails: [] },
      { path: 'INBOX/Sent', mails: [mail({ size: 1 })] },
    ];
    await mm('stats', '--folder', 'Sent');
    expect(out.stderr).toContain(FOLDER_NOT_FOUND);
    expect(exitCode()).toBe(1);
  });

  it('a folder that cannot be selected (\\Noselect) → folder-not-found', async () => {
    behaviour.folders = [
      { path: 'INBOX', mails: [] },
      { path: 'Container', flags: ['\\Noselect'] },
    ];
    await mm('stats', '--folder', 'Container');
    expect(out.stderr).toContain(FOLDER_NOT_FOUND);
    expect(calls.some((c) => c.startsWith('examine '))).toBe(false);
    expect(exitCode()).toBe(1);
  });

  it('--folder "" → the "Unexpected options" text, no login, exit 1', async () => {
    await mm('stats', '--folder', '');
    expect(out.stderr).toContain('Unexpected options');
    expect(calls).not.toContain('login');
    expect(exitCode()).toBe(1);
  });
});

describe('mm stats — the folder cap (5,000 folders)', () => {
  it('more folders than that: the first 5,000 only, said on the first line', async () => {
    behaviour.folders = folderRows(5001);
    await mm('stats');
    expect(blocks()[0]).toContain('Scanned 5,000 folders, 0 messages');
    expect(blocks()[0]).toContain('; first 5,000 folders only');
    expect(exitCode()).toBe(0);
  }, 60_000);

  it('--folder for a folder past the cap → folder-not-found', async () => {
    behaviour.folders = folderRows(5001);
    await mm('stats', '--folder', 'F5000');
    expect(out.stderr).toContain(FOLDER_NOT_FOUND);
    expect(exitCode()).toBe(1);
  }, 60_000);

  it('--json says truncated: true', async () => {
    behaviour.folders = folderRows(5001);
    await mm('stats', '--json');
    expect(jsonOut()['truncated']).toBe(true);
    expect((jsonOut()['folders'] as unknown[]).length).toBe(5000);
  }, 60_000);
});

describe('mm stats — progress', () => {
  it('on a stderr terminal: "Reading folder i/n … done/total messages" on stderr, cleared after', async () => {
    behaviour.folders = [
      { path: 'A', mails: [mail({ size: 1 }), mail({ size: 1 }), mail({ size: 1 })] },
      { path: 'B', mails: [mail({ size: 1 }), mail({ size: 1 }), mail({ size: 1 })] },
    ];
    setTTY(process.stderr, true);
    await mm('stats');
    expect(out.stderr).toContain('Reading folder 1/2 … 3/3 messages');
    expect(out.stderr).toContain('Reading folder 2/2 … 3/3 messages');
    expect(out.stdout).not.toContain('Reading folder');
    expect(out.stderr.endsWith('\r\x1b[K')).toBe(true);
  });

  it('stderr not a terminal: no progress output at all', async () => {
    setTTY(process.stderr, false);
    await mm('stats');
    expect(out.stderr).not.toContain('Reading folder');
    expect(out.stderr).not.toContain('\x1b');
  });

  it('--json: no progress even on a terminal', async () => {
    setTTY(process.stderr, true);
    await mm('stats', '--json');
    expect(out.stderr).not.toContain('Reading folder');
    expect(out.stdout).not.toContain('Reading folder');
  });
});

describe('mm stats — errors', () => {
  it('a failed login: the generic login text, stats.finish failed (auth-failed) with zero counts', async () => {
    openSession.mockRejectedValue(new ImapSessionError('auth-failed'));
    await mm('stats');
    expect(out.stderr).toContain(GENERIC);
    expect(events('stats.finish')).toEqual([
      expect.objectContaining({
        acct: A_ID,
        folders: 0,
        messages: 0,
        bytes: 0,
        outcome: 'failed',
        reason: 'auth-failed',
      }),
    ]);
    expect(exitCode()).toBe(1);
  });

  it('LIST fails: its own text (not the login text, no server text), logout, exit 1', async () => {
    behaviour.listError = new Error(SERVER_TEXT);
    await mm('stats');
    expect(out.stderr).toContain('The mail server could not list the folders — try again later.');
    expect(out.stderr).not.toContain(GENERIC);
    expect(out.stderr).not.toContain('secret-server-text');
    expect(calls.at(-1)).toBe('logout');
    expect(events('stats.finish')).toEqual([
      expect.objectContaining({ outcome: 'failed', reason: 'list-failed' }),
    ]);
    expect(events('error.unexpected')).toEqual([]);
    expect(exitCode()).toBe(1);
  });

  it('Gmail with All Mail hidden: its own text, nothing scanned, stats.finish failed, exit 1', async () => {
    behaviour.caps = { 'X-GM-EXT-1': true };
    behaviour.folders = [
      { path: 'INBOX', mails: [mail({ size: 1 })] },
      { path: 'Work', mails: [mail({ size: 1 })] },
    ];
    await mm('stats');
    expect(out.stderr).toContain(GMAIL_HIDDEN);
    expect(out.stdout).not.toContain('FOLDER');
    expect(calls.some((c) => c.startsWith('examine '))).toBe(false);
    expect(events('stats.finish')).toEqual([
      expect.objectContaining({ acct: A_ID, outcome: 'failed', reason: 'gmail-all-hidden' }),
    ]);
    expect(exitCode()).toBe(1);
  });

  it('Gmail with All Mail hidden: --folder still works', async () => {
    behaviour.caps = { 'X-GM-EXT-1': true };
    behaviour.folders = [{ path: 'Work', mails: [mail({ size: 1 })] }];
    await mm('stats', '--folder', 'Work');
    expect(out.stderr).not.toContain(GMAIL_HIDDEN);
    expect(exitCode()).toBe(0);
  });

  it('the connection drops mid-scan: connection-lost text, no report, zero counts in the log, exit 1', async () => {
    behaviour.folders = [
      { path: 'INBOX', mails: [mail({ size: 1 }), mail({ size: 1 })] },
      { path: 'Work', drop: true, mails: [mail({ size: 1 })] },
    ];
    await mm('stats');
    expect(out.stderr).toContain(CONNECTION_LOST);
    expect(out.stderr).not.toContain(GENERIC);
    expect(out.stderr).not.toContain('secret-server-text');
    expect(out.stdout).not.toContain('FOLDER');
    expect(calls.at(-1)).toBe('logout');
    expect(events('stats.finish')).toEqual([
      expect.objectContaining({
        acct: A_ID,
        folders: 0,
        messages: 0,
        bytes: 0,
        outcome: 'failed',
        reason: 'connection-lost',
      }),
    ]);
    expect(exitCode()).toBe(1);
  });

  it('a bug in the aggregation is "Unexpected error", never an unreadable folder', async () => {
    class BoomDate extends Date {
      override getTime(): number {
        throw BOOM;
      }
      override valueOf(): number {
        throw BOOM;
      }
      override [Symbol.toPrimitive](): never {
        throw BOOM;
      }
    }
    behaviour.folders = [
      {
        path: 'INBOX',
        mails: [{ ...mail({ size: 1, address: 'a@x.example' }), internalDate: new BoomDate() }],
      },
      { path: 'Work', mails: [mail({ size: 1 })] },
    ];
    await mm('stats');
    expect(out.stderr).toContain('Unexpected error');
    expect(out.stderr).not.toContain('boom');
    expect(out.stdout).not.toContain('FOLDER');
    expect(out.stdout).not.toContain('—');
    expect(events('error.unexpected')).toHaveLength(1);
    expect(events('stats.finish')).toEqual([
      expect.objectContaining({ outcome: 'failed', reason: 'unexpected', messages: 0 }),
    ]);
    expect(calls.at(-1)).toBe('logout');
    expect(exitCode()).toBe(1);
  });
});

describe('mm stats — logging', () => {
  it('stats.finish ok: account id, folders, messages, bytes, ms; no reason; level info', async () => {
    await mm('stats');
    const finish = events('stats.finish');
    expect(finish).toEqual([
      expect.objectContaining({
        acct: A_ID,
        folders: 4,
        messages: DEFAULT_MESSAGES,
        bytes: DEFAULT_BYTES,
        outcome: 'ok',
        level: 'info',
      }),
    ]);
    expect(finish[0]).not.toHaveProperty('reason');
    expect(typeof finish[0]?.['ms']).toBe('number');
    expect(Number(finish[0]?.['ms'])).toBeGreaterThanOrEqual(0);
  });

  it('stats.finish failed is a warning and carries the reason', async () => {
    openSession.mockRejectedValue(new ImapSessionError('auth-failed'));
    await mm('stats');
    expect(events('stats.finish')[0]).toMatchObject({ level: 'warn', reason: 'auth-failed' });
  });

  it('--json logs the same stats.finish', async () => {
    await mm('stats', '--json');
    expect(events('stats.finish')).toEqual([
      expect.objectContaining({ folders: 4, messages: DEFAULT_MESSAGES, outcome: 'ok' }),
    ]);
  });

  it('--folder: stats.finish counts only the folder that was read', async () => {
    await mm('stats', '--folder', 'Work');
    expect(events('stats.finish')).toEqual([
      expect.objectContaining({ folders: 1, messages: 2, bytes: 2048, outcome: 'ok' }),
    ]);
  });

  it('no imap.capability-fallback is logged by mm stats (its listing skips STATUS)', async () => {
    await mm('stats');
    expect(events('imap.capability-fallback')).toEqual([]);
  });

  it('canary: no folder name, sender, domain, subject, address, host or password in any record (ok run)', async () => {
    behaviour.folders = [
      {
        path: 'Tajný priečinok',
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
      { path: HOSTILE, mails: [mail({ size: 1 })] },
    ];
    await mm('stats');
    expect(exitCode()).toBe(0);
    const text = JSON.stringify(log.records);
    expect(text).toContain('stats.finish');
    for (const needle of [
      EMAIL,
      HOST,
      PASSWORD,
      'example-test-domain',
      'Tajn',
      'priečinok',
      'Evil',
      'RedFolder',
      'canary-sender',
      'canary-domain',
      'Canary Person',
      'CANARY-SUBJECT',
    ]) {
      expect(text).not.toContain(needle);
    }
  });

  it('canary: nothing private in the records of a failed run either', async () => {
    behaviour.folders = [
      {
        path: 'Tajný priečinok',
        mails: [
          mail({
            size: 10,
            address: 'canary-sender@canary-domain.example',
            subject: 'CANARY-SUBJECT-xyz',
          }),
        ],
      },
      { path: 'Second', drop: true, mails: [mail({ size: 1 })] },
    ];
    await mm('stats');
    expect(exitCode()).toBe(1);
    const text = JSON.stringify(log.records);
    expect(text).toContain('stats.finish');
    for (const needle of [
      EMAIL,
      HOST,
      PASSWORD,
      'Tajn',
      'Second',
      'canary-sender',
      'canary-domain',
      'CANARY-SUBJECT',
      'secret-server-text',
      'SERVERBUG',
    ]) {
      expect(text).not.toContain(needle);
    }
  });
});

// ---- M2-fix: short reads without an error, --folder with the path as printed ----

describe('mm stats — a folder the server silently returned too few messages for', () => {
  it('some messages missing: "(partial)" with the counts kept, the note, exit 0, stats.finish ok', async () => {
    behaviour.folders = [
      {
        path: 'Short',
        skipFrom: 3,
        mails: [
          mail({ size: 10, date: JUN_2024 }),
          mail({ size: 20, date: JUN_2024 }),
          mail({ size: 40, date: JUN_2024 }),
        ],
      },
      { path: 'Fine', mails: [mail({ size: 5, date: JUN_2024 })] },
    ];
    await mm('stats');
    expect(blocks()[0]).toContain('; 1 folder read only partly');
    expect(blocks()[0]).not.toContain("couldn't be read");
    expect(block('FOLDER')).toMatch(/^Short\s+2\s+30 B \(partial\)\s*$/m);
    expect(block('FOLDER')).toMatch(rowRe('Fine', '1', '5 B'));
    expect(blocks()[0]).toContain('3 messages');
    expect(out.stderr).toBe('');
    expect(exitCode()).toBe(0);
    expect(events('stats.finish')).toEqual([
      expect.objectContaining({ folders: 2, messages: 3, bytes: 35, outcome: 'ok' }),
    ]);
    expect(events('stats.finish')[0]).not.toHaveProperty('reason');
  });

  it('nothing counted: the row shows "—", the note says it could not be read, exit 0, ok', async () => {
    behaviour.folders = [
      { path: 'Gone', skipFrom: 1, mails: [mail({ size: 10 }), mail({ size: 20 })] },
      { path: 'Fine', mails: [mail({ size: 5, date: JUN_2024 })] },
    ];
    await mm('stats');
    expect(blocks()[0]).toContain("; 1 folder couldn't be read");
    expect(blocks()[0]).not.toContain('read only partly');
    expect(block('FOLDER')).toMatch(/^Gone\s+—\s+—\s*$/m);
    expect(block('FOLDER')).not.toContain('(partial)');
    expect(block('FOLDER')).toMatch(rowRe('Fine', '1', '5 B'));
    expect(exitCode()).toBe(0);
    expect(events('stats.finish')).toEqual([
      expect.objectContaining({ messages: 1, bytes: 5, outcome: 'ok' }),
    ]);
  });

  it('--json: the short folder is a partial row, the unreadable one a null row, with the counters', async () => {
    behaviour.folders = [
      { path: 'Gone', skipFrom: 1, mails: [mail({ size: 10 })] },
      { path: 'Short', skipFrom: 2, mails: [mail({ size: 10 }), mail({ size: 20 })] },
    ];
    await mm('stats', '--json');
    const j = jsonOut() as { folders: unknown[]; unreadable: number; partial: number };
    expect(j.folders).toEqual([
      { path: 'Gone', messages: null, bytes: null, partial: false },
      { path: 'Short', messages: 1, bytes: 10, partial: true },
    ]);
    expect(j.unreadable).toBe(1);
    expect(j.partial).toBe(1);
    expect(exitCode()).toBe(0);
  });

  it('a fully read mailbox shows neither note nor mark', async () => {
    await mm('stats');
    expect(out.stdout).not.toContain('(partial)');
    expect(out.stdout).not.toContain('read only partly');
    expect(out.stdout).not.toContain("couldn't be read");
  });
});

describe('mm stats --folder — the path as `mm folders --json` prints it', () => {
  const SOFT = 'Caf\u00ade';
  const PERSIAN = '\u0646\u0627\u0645\u0647\u200c\u0647\u0627';
  const FAMILY = 'Family \u{1F468}\u200d\u{1F469}\u200d\u{1F467}';

  it.each<[string, string]>([
    ['a soft hyphen', SOFT],
    ['a ZWNJ', PERSIAN],
    ['a ZWJ emoji sequence', FAMILY],
  ])(
    'a folder name with %s is scanned when given without the invisible characters',
    async (_name, raw) => {
      const printed = sanitize(raw);
      expect(printed).not.toBe(raw);
      behaviour.folders = [
        { path: 'INBOX', mails: [mail({ size: 1 })] },
        {
          path: raw,
          mails: [mail({ size: 7, date: JUN_2024 }), mail({ size: 8, date: JUN_2024 })],
        },
      ];
      await mm('stats', '--folder', printed);
      expect(calls.filter((c) => c.startsWith('examine '))).toEqual([`examine ${raw} ro`]);
      expect(blocks()[0]).toMatch(/Scanned 1 folder, 2 messages/);
      expect(out.stderr).toBe('');
      expect(exitCode()).toBe(0);
      expect(events('stats.finish')).toEqual([
        expect.objectContaining({ folders: 1, messages: 2, bytes: 15, outcome: 'ok' }),
      ]);
    },
  );

  it.each<[string, string]>([
    ['a soft hyphen', SOFT],
    ['a ZWNJ', PERSIAN],
    ['a ZWJ emoji sequence', FAMILY],
  ])('--json: scope.folder is the printed path (%s)', async (_name, raw) => {
    const printed = sanitize(raw);
    behaviour.folders = [{ path: raw, mails: [mail({ size: 7, date: JUN_2024 })] }];
    await mm('stats', '--folder', printed, '--json');
    const j = jsonOut() as { scope: unknown; folders: { path: string }[]; totals: unknown };
    expect(j.scope).toEqual({ folder: printed, gmail: false });
    expect(j.folders.map((f) => f.path)).toEqual([printed]);
    expect(j.totals).toEqual({ messages: 1, bytes: 7 });
    expect(exitCode()).toBe(0);
  });

  it('the exact raw path still works', async () => {
    behaviour.folders = [{ path: SOFT, mails: [mail({ size: 7 })] }];
    await mm('stats', '--folder', SOFT);
    expect(calls.filter((c) => c.startsWith('examine '))).toEqual([`examine ${SOFT} ro`]);
    expect(exitCode()).toBe(0);
  });

  it('two folders that print the same and neither equals the value → the folder-not-found text, exit 1', async () => {
    behaviour.folders = [
      { path: 'INBOX', mails: [] },
      { path: 'Caf\u00ade', mails: [mail({ size: 1 })] },
      { path: 'Caf\u200ce', mails: [mail({ size: 2 })] },
    ];
    await mm('stats', '--folder', 'Cafe');
    expect(out.stderr).toContain(FOLDER_NOT_FOUND);
    expect(out.stdout).not.toContain('FOLDER');
    expect(calls.some((c) => c.startsWith('examine '))).toBe(false);
    expect(events('stats.finish')).toEqual([
      expect.objectContaining({ outcome: 'failed', reason: 'folder-not-found' }),
    ]);
    expect(exitCode()).toBe(1);
  });

  it('one of the twins equals the value exactly → that one is scanned', async () => {
    behaviour.folders = [
      { path: 'INBOX', mails: [] },
      { path: 'Caf\u00ade', mails: [mail({ size: 1 })] },
      { path: 'Cafe', mails: [mail({ size: 2 }), mail({ size: 3 })] },
    ];
    await mm('stats', '--folder', 'Cafe');
    expect(calls.filter((c) => c.startsWith('examine '))).toEqual(['examine Cafe ro']);
    expect(blocks()[0]).toMatch(/Scanned 1 folder, 2 messages/);
    expect(exitCode()).toBe(0);
  });

  it('a printed path that no folder prints → the folder-not-found text, exit 1', async () => {
    behaviour.folders = [
      { path: 'INBOX', mails: [] },
      { path: SOFT, mails: [mail({ size: 1 })] },
    ];
    await mm('stats', '--folder', 'Cafes');
    expect(out.stderr).toContain(FOLDER_NOT_FOUND);
    expect(exitCode()).toBe(1);
  });

  it('a printed path that only a \\Noselect folder prints → the folder-not-found text, exit 1', async () => {
    behaviour.folders = [
      { path: 'INBOX', mails: [] },
      { path: SOFT, flags: ['\\Noselect'] },
    ];
    await mm('stats', '--folder', 'Cafe');
    expect(out.stderr).toContain(FOLDER_NOT_FOUND);
    expect(calls.some((c) => c.startsWith('examine '))).toBe(false);
    expect(exitCode()).toBe(1);
  });
});
