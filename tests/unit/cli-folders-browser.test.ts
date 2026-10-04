import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { RECONNECT_FAILED_TEXT } from '../../src/cli/browser/controller.js';
import type { Rendered } from '../../src/cli/browser/render.js';
import type { Keypress } from '../../src/cli/browser/state.js';
import type { Terminal, TerminalOptions } from '../../src/cli/browser/terminal.js';
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

// M2b-2 `mm folders` in a terminal (spec): the M2a tree is printed, then the fullscreen browser
// runs on the same session. Supabase, the IMAP socket, env files and the terminal module are
// mocked; the controller, reducer, renderer, accounts core, login guard, listFolders, loadPage and
// the CLI texts are real. A fake Terminal records the frames and feeds the keys.

const PASSWORD = 'hunter2-ÄŠť';
const EMAIL = 'someone@example-test-domain.eu';
const HOST = 'imap.example-test-domain.eu';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const A_ID = '3f2a91c0-5d4a-4b6f-9e21-7a8c0d1e2f34';
const MASTER = Buffer.alloc(32, 7);
const RUN = '0123456789abcdef';
const T0 = Date.UTC(2026, 9, 1, 9, 0, 0);
const SENDER = 'Canary Sender';
const SENDER_ADDRESS = 'canary.sender@example-test-domain.eu';
const SUBJECT = 'Secret canary subject';

const GENERIC = imapErrorText('auth-failed', { kind: 'this-computer' });
const CLOSED = 'Folder browser closed — nothing was changed on the server.';

const { currentUser, createSupabaseServices, loadEnvFiles, openSession, openTerminal } = vi.hoisted(
  () => ({
    currentUser: vi.fn<() => Promise<{ email: string; userId: string } | null>>(),
    createSupabaseServices: vi.fn<(...args: unknown[]) => unknown>(),
    loadEnvFiles: vi.fn(),
    openSession: vi.fn<(o: OpenSessionOptions) => Promise<ImapSession>>(),
    openTerminal: vi.fn<(options?: TerminalOptions) => Terminal>(),
  }),
);

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
vi.mock('../../src/cli/browser/terminal.js', () => ({ openTerminal }));

const { buildProgram } = await import('../../src/cli/index.js');
const { runCli } = await import('../../src/cli/run.js');
const { MemoryEventLog } = await import('../../src/core/log/index.js');
type Log = InstanceType<typeof MemoryEventLog>;

// ---- fakes ----

const credentials = new LocalCredentialProvider({ masterKey: MASTER, masterKeyVersion: 1 });

function row(): MailAccount {
  return {
    id: A_ID,
    userId: USER_ID,
    label: null,
    email: EMAIL,
    provider: 'websupport',
    host: HOST,
    port: 993,
    username: EMAIL,
    authType: 'password',
    secret: credentials.encryptPassword(
      { userId: USER_ID, accountId: A_ID, host: HOST, port: 993, username: EMAIL },
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
  /** Sizes of the mails, sequence 1 first. */
  sizes: number[];
}

// One folder keeps the browser's first row (the cursor) on INBOX whatever order the tree sorts in.
const INBOX: FakeFolder = { path: 'INBOX', sizes: [100, 200, 300] };

interface Behaviour {
  folders: FakeFolder[];
  listError?: Error;
}

interface SessionState {
  id: number;
  closed: boolean;
  path: string | null;
}

let behaviour: Behaviour;
let calls: string[];
let sessions: SessionState[];
/** Ids of the sessions that served a page load (a FETCH of envelopes). */
let pageLoads: number[];

function fakeSession(): ImapSession {
  const state: SessionState = { id: sessions.length + 1, closed: false, path: null };
  sessions.push(state);
  const b = behaviour;
  let mailbox: { exists: number; uidValidity: bigint } | false = false;
  const folderOf = (path: string | null): FakeFolder | undefined =>
    b.folders.find((f) => f.path === path);
  const client: ImapClientLike = {
    options: {},
    capabilities: new Map(),
    enabled: new Set(),
    serverInfo: null,
    get usable() {
      return !state.closed;
    },
    get mailbox() {
      return mailbox;
    },
    connect: () => Promise.resolve(),
    logout: () => Promise.resolve(),
    noop: () => Promise.resolve(),
    close: () => undefined,
    on: () => undefined,
    list: () => {
      calls.push('list');
      if (b.listError) return Promise.reject(b.listError);
      return Promise.resolve(
        b.folders.map((f) => ({
          path: f.path,
          pathAsListed: f.path,
          name: f.path,
          delimiter: '/',
          parent: [],
          parentPath: '',
          flags: new Set<string>(),
          listed: true,
          subscribed: true,
        })),
      );
    },
    status: (path: string) => {
      const f = folderOf(path);
      return Promise.resolve(
        f === undefined ? false : { path, messages: f.sizes.length, unseen: 0 },
      );
    },
    getQuota: () => Promise.resolve(false),
    getMailboxLock: (path: string) => {
      state.path = path;
      mailbox = { exists: folderOf(path)?.sizes.length ?? 0, uidValidity: 7n };
      return Promise.resolve({ path, release: () => undefined });
    },
    fetch: (range: string, query: object) => {
      const [from, to] = range.split(':').map(Number);
      const sizes = folderOf(state.path)?.sizes ?? [];
      const full = 'envelope' in query;
      if (full) pageLoads.push(state.id);
      return (async function* () {
        await Promise.resolve();
        for (let seq = from ?? 1; seq <= (to ?? 0); seq++) {
          const size = sizes[seq - 1];
          if (size === undefined) continue;
          yield full
            ? {
                seq,
                uid: 1000 + seq,
                size,
                envelope: {
                  from: [{ name: SENDER, address: SENDER_ADDRESS }],
                  subject: SUBJECT,
                },
                internalDate: new Date(T0),
                bodyStructure: { type: 'text/plain' },
              }
            : { seq, size };
        }
      })();
    },
  } as unknown as ImapClientLike;
  const caps = sanitizeCapabilities({ IMAP4REV1: true });
  return {
    client,
    capabilities: caps,
    features: buildServerFeatures(caps, new Set()),
    get closed() {
      return state.closed;
    },
    logout: () => {
      calls.push(`logout ${String(state.id)}`);
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

interface FakeTerminal extends Terminal {
  readonly frames: Rendered[];
  /** The spy behind `close`. */
  readonly closeSpy: ReturnType<typeof vi.fn<() => void>>;
  failDraw: Error | null;
  key(key: Keypress): void;
  registered(): boolean;
}

function fakeTerminal(): FakeTerminal {
  let keyHandler: ((key: Keypress) => void) | null = null;
  const close = vi.fn<() => void>();
  const t: FakeTerminal = {
    frames: [],
    closeSpy: close,
    failDraw: null,
    size: () => ({ rows: 24, cols: 100 }),
    draw: (frame) => {
      if (t.failDraw !== null) throw t.failDraw;
      t.frames.push(frame);
    },
    clear: () => undefined,
    onKey: (fn) => {
      keyHandler = fn;
    },
    onResize: () => undefined,
    restore: vi.fn(),
    close,
    key: (key) => {
      if (keyHandler === null) throw new Error('no key handler registered');
      keyHandler(key);
    },
    registered: () => keyHandler !== null,
  };
  return t;
}

// ---- harness ----

let out = { stdout: '', stderr: '', all: '' };
let log: Log;
let term: FakeTerminal;
/** stdout / stderr at the moment `openTerminal` / `terminal.close` ran. */
let atOpen: { stdout: string; logins: number } | null;
let atClose: { stdout: string; stderr: string; all: string } | null;
let pending: Promise<void> | null;
const originalErrIsTTY = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
const originalInIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
const originalOutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
const originalMasterKey = process.env['MM_MASTER_KEY'];
const originalTerm = process.env['TERM'];

function chunkToString(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString('utf8');
  return String(chunk);
}

function setTTY(stream: NodeJS.ReadStream | NodeJS.WriteStream, value: boolean | undefined): void {
  Object.defineProperty(stream, 'isTTY', { value, configurable: true, writable: true });
}

function restoreTTY(
  stream: NodeJS.ReadStream | NodeJS.WriteStream,
  original: PropertyDescriptor | undefined,
): void {
  if (original) Object.defineProperty(stream, 'isTTY', original);
  else delete (stream as { isTTY?: boolean }).isTTY;
}

function ttys(stdin: boolean, stdout: boolean): void {
  setTTY(process.stdin, stdin);
  setTTY(process.stdout, stdout);
}

function resetCapture(): void {
  out = { stdout: '', stderr: '', all: '' };
}

beforeEach(() => {
  resetCapture();
  calls = [];
  sessions = [];
  pageLoads = [];
  atOpen = null;
  atClose = null;
  pending = null;
  process.exitCode = undefined;
  process.env['MM_MASTER_KEY'] = MASTER.toString('base64');
  process.env['TERM'] = 'xterm';
  log = new MemoryEventLog({ run: RUN, ver: '0.8.0', now: () => T0, level: 'debug' });
  behaviour = { folders: [INBOX] };
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    out.stdout += chunkToString(chunk);
    out.all += chunkToString(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    out.stderr += chunkToString(chunk);
    out.all += chunkToString(chunk);
    return true;
  });
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    const line = `${args.map(chunkToString).join(' ')}\n`;
    out.stdout += line;
    out.all += line;
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    const line = `${args.map(chunkToString).join(' ')}\n`;
    out.stderr += line;
    out.all += line;
  });
  currentUser.mockResolvedValue({ email: 'user@example-test-domain.eu', userId: USER_ID });
  createSupabaseServices.mockImplementation(() => ({
    auth: { currentUser },
    accounts: fakeRepo([row()]),
    audit,
  }));
  openSession.mockImplementation((o) => {
    calls.push('login');
    if (o.password !== PASSWORD) return Promise.reject(new ImapSessionError('auth-failed'));
    return Promise.resolve(fakeSession());
  });
  term = fakeTerminal();
  term.closeSpy.mockImplementation(() => {
    atClose = { ...out };
  });
  openTerminal.mockImplementation(() => {
    atOpen = { stdout: out.stdout, logins: calls.filter((c) => c === 'login').length };
    return term;
  });
  ttys(true, true);
  setTTY(process.stderr, false);
});

afterEach(async () => {
  // A test that failed half-way must not leave a browser running.
  if (term.registered()) term.key(CTRL_C);
  await pending?.catch(() => undefined);
  vi.restoreAllMocks();
  for (const fn of [currentUser, createSupabaseServices, loadEnvFiles, openSession, openTerminal]) {
    fn.mockReset();
  }
  process.exitCode = undefined;
  if (originalMasterKey === undefined) delete process.env['MM_MASTER_KEY'];
  else process.env['MM_MASTER_KEY'] = originalMasterKey;
  if (originalTerm === undefined) delete process.env['TERM'];
  else process.env['TERM'] = originalTerm;
  restoreTTY(process.stderr, originalErrIsTTY);
  restoreTTY(process.stdin, originalInIsTTY);
  restoreTTY(process.stdout, originalOutIsTTY);
});

async function mm(...args: string[]): Promise<void> {
  await buildProgram({ exitOverride: true, log, run: RUN }).parseAsync(['node', 'mm', ...args]);
}

const k = (name: string, extra: Keypress = {}): Keypress => ({ name, sequence: name, ...extra });
const ENTER = k('return', { sequence: '\r' });
const DOWN = k('down', { sequence: '\x1b[B' });
const SPACE = k('space', { sequence: ' ' });
const CTRL_C = k('c', { ctrl: true, sequence: '\x03' });

function screen(): string {
  return (term.frames.at(-1)?.lines ?? []).join('\n');
}

async function onScreen(needle: string): Promise<void> {
  await vi.waitFor(() => {
    expect(screen()).toContain(needle);
  });
}

async function press(...keys: Keypress[]): Promise<void> {
  for (const key of keys) {
    term.key(key);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** Starts `mm folders ...`, waits until the browser is up, runs the script, waits for the end. */
async function browse(args: string[], script: () => Promise<void> = () => Promise.resolve()) {
  pending = mm('folders', ...args);
  await vi.waitFor(() => {
    expect(term.registered()).toBe(true);
  });
  await script();
  await pending;
}

async function openInbox(): Promise<void> {
  await press(ENTER);
  await onScreen(SENDER);
}

function exitCode(): number {
  return typeof process.exitCode === 'number' ? process.exitCode : 0;
}

function events(name: string): Record<string, unknown>[] {
  return log.records.filter((r) => r.event === name);
}

function count(needle: string): number {
  return calls.filter((c) => c === needle).length;
}

// ---- tests ----

describe('mm folders in a terminal: the browser', () => {
  it('prints the tree, opens the browser on one login, q -> summary, exit 0, one browse.finish ok, one logout', async () => {
    await browse([], async () => {
      await openInbox();
      await press(k('q'));
    });
    // Tree first: everything of the M2a output is out before the terminal opens.
    expect(atOpen?.stdout).toContain(`Mailbox: ${EMAIL}`);
    expect(atOpen?.stdout).toContain('FOLDER');
    expect(atOpen?.stdout).toContain('Total: 3 messages');
    expect(atOpen?.stdout).toContain('Quota:');
    expect(atOpen?.stdout).not.toContain('Folder browser closed');
    expect(atOpen?.logins).toBe(1);
    // The browser reads on that session: no second login, one logout at the end.
    expect(count('login')).toBe(1);
    expect(pageLoads).toEqual([1]);
    expect(count('logout 1')).toBe(1);
    // The screen is restored first, then the summary line.
    expect(term.closeSpy).toHaveBeenCalledTimes(1);
    expect(atClose?.stdout).not.toContain('Folder browser closed');
    expect(out.stdout.indexOf('Total:')).toBeLessThan(out.stdout.indexOf(CLOSED));
    expect(out.stdout.trimEnd().endsWith(CLOSED)).toBe(true);
    expect(exitCode()).toBe(0);
    expect(events('folders.list')).toEqual([
      expect.objectContaining({ acct: A_ID, folders: 1, outcome: 'ok' }),
    ]);
    const finish = events('browse.finish');
    expect(finish).toHaveLength(1);
    expect(finish[0]).toMatchObject({
      acct: A_ID,
      folders: 1,
      mails: 3,
      marked: 0,
      bytes: 0,
      reconnects: 0,
      outcome: 'ok',
      level: 'info',
    });
    expect(finish[0]?.['reason']).toBeUndefined();
    expect(typeof finish[0]?.['ms']).toBe('number');
  });

  it('the browser shows the folder size column by default', async () => {
    await browse([], async () => {
      await onScreen('INBOX');
      expect(screen()).toMatch(/600 B/);
      await press(k('q'));
    });
  });

  it('--no-size: the M2a no-size tree first, and no size column in the browser', async () => {
    const noSizeTree = await baseline(['--no-size']);
    await browse(['--no-size'], async () => {
      await onScreen('INBOX');
      const line = term.frames.at(-1)?.lines.find((l) => l.includes('INBOX/')) ?? '';
      expect(line).not.toMatch(/\d B\b/);
      expect(line).toMatch(/\b3\b/);
      await press(k('q'));
    });
    expect(atOpen?.stdout).toBe(noSizeTree.stdout);
    expect(atOpen?.stdout).not.toContain('SIZE');
  });

  it('0 folders: the browser says "No folders"; q -> the summary', async () => {
    behaviour.folders = [];
    await browse([], async () => {
      await onScreen('No folders');
      await press(k('q'));
    });
    expect(out.stdout).toContain(CLOSED);
    expect(exitCode()).toBe(0);
  });

  it('marks: the summary names the count and the size; q asks, y quits with exit 0', async () => {
    await browse([], async () => {
      await openInbox();
      await press(SPACE, DOWN, SPACE, k('q'));
      await onScreen('Quit and drop 2 marks');
      await press(k('y'));
    });
    expect(out.stdout).toContain(
      'Folder browser closed — 2 marks (500 B) dropped, nothing was changed on the server.',
    );
    expect(exitCode()).toBe(0);
    expect(events('browse.finish')).toEqual([
      expect.objectContaining({ marked: 2, bytes: 500, outcome: 'ok' }),
    ]);
  });

  it('one mark: singular in the summary', async () => {
    await browse([], async () => {
      await openInbox();
      await press(SPACE, CTRL_C);
    });
    expect(out.stdout).toContain(
      'Folder browser closed — 1 mark (300 B) dropped, nothing was changed on the server.',
    );
  });

  it('Ctrl+C: summary, exit 130, browse.finish interrupted (info)', async () => {
    await browse([], async () => {
      await openInbox();
      await press(CTRL_C);
    });
    expect(out.stdout).toContain(CLOSED);
    expect(exitCode()).toBe(130);
    expect(term.closeSpy).toHaveBeenCalledTimes(1);
    expect(count('logout 1')).toBe(1);
    const finish = events('browse.finish');
    expect(finish).toHaveLength(1);
    expect(finish[0]).toMatchObject({ outcome: 'interrupted', level: 'info', mails: 3 });
    expect(finish[0]?.['reason']).toBeUndefined();
  });
});

describe('mm folders: no browser', () => {
  it.each([[['--plain']], [['--json']], [['--json', '--plain']], [['--plain', '--no-size']]])(
    '%j in a terminal: the M2a output byte for byte, the terminal never opened, no browse.finish',
    async (args) => {
      const expected = await baseline(args);
      await mm('folders', ...args);
      expect({ stdout: out.stdout, stderr: out.stderr }).toEqual(expected);
      expect(openTerminal).not.toHaveBeenCalled();
      expect(events('browse.finish')).toEqual([]);
      expect(out.stdout).not.toContain('Folder browser closed');
      expect(exitCode()).toBe(0);
    },
  );

  it.each([
    ['stdin not a terminal', false, true],
    ['stdout not a terminal', true, false],
    ['neither a terminal', false, false],
  ])('%s: the M2a output, no terminal, no browse.finish', async (_name, stdin, stdout) => {
    const expected = await baseline([]);
    ttys(stdin, stdout);
    await mm('folders');
    expect({ stdout: out.stdout, stderr: out.stderr }).toEqual(expected);
    expect(openTerminal).not.toHaveBeenCalled();
    expect(events('browse.finish')).toEqual([]);
  });

  it('TERM=dumb on a terminal: the M2a output, no terminal', async () => {
    const expected = await baseline([]);
    process.env['TERM'] = 'dumb';
    await mm('folders');
    expect({ stdout: out.stdout, stderr: out.stderr }).toEqual(expected);
    expect(openTerminal).not.toHaveBeenCalled();
    expect(events('browse.finish')).toEqual([]);
    expect(exitCode()).toBe(0);
  });

  it('the plain path logs out once, like before', async () => {
    await mm('folders', '--plain');
    expect(count('login')).toBe(1);
    expect(count('logout 1')).toBe(1);
  });
});

describe('mm folders in a terminal: failures before the browser', () => {
  it('a failed login: the generic login text, exit 1, folders.list failed, no terminal, no browse.finish', async () => {
    openSession.mockRejectedValue(new ImapSessionError('auth-failed'));
    await mm('folders');
    expect(out.stderr).toContain(GENERIC);
    expect(openTerminal).not.toHaveBeenCalled();
    expect(events('browse.finish')).toEqual([]);
    expect(events('folders.list')).toEqual([
      expect.objectContaining({ acct: A_ID, outcome: 'failed', reason: 'auth-failed' }),
    ]);
    expect(exitCode()).toBe(1);
  });

  it('a failed listing: its text, the session logged out, no terminal, no browse.finish', async () => {
    behaviour.listError = new Error('NO [SERVERBUG] secret-server-text');
    await mm('folders');
    expect(out.stderr).toContain('The mail server could not list the folders — try again later.');
    expect(out.stderr).not.toContain('secret-server-text');
    expect(count('logout 1')).toBe(1);
    expect(openTerminal).not.toHaveBeenCalled();
    expect(events('browse.finish')).toEqual([]);
    expect(events('folders.list')).toEqual([
      expect.objectContaining({ outcome: 'failed', reason: 'list-failed' }),
    ]);
    expect(exitCode()).toBe(1);
  });
});

describe('mm folders in a terminal: errors in the browser', () => {
  it('openTerminal throws: the error text, exit 1, session logged out, browse.finish failed/unexpected', async () => {
    openTerminal.mockImplementation(() => {
      throw new Error('raw mode refused');
    });
    await mm('folders');
    expect(out.stderr).toContain('Unexpected error');
    expect(out.stderr).not.toContain('raw mode refused');
    expect(out.stdout).not.toContain('Folder browser closed');
    expect(count('logout 1')).toBe(1);
    expect(exitCode()).toBe(1);
    expect(events('browse.finish')).toEqual([
      expect.objectContaining({ outcome: 'failed', reason: 'unexpected', level: 'warn' }),
    ]);
    expect(events('error.unexpected')).toHaveLength(1);
  });

  it('an error in the browser loop: the terminal is closed before the error text, no summary, exit 1', async () => {
    await browse([], async () => {
      await onScreen('INBOX');
      term.failDraw = new Error('terminal gone');
      await press(DOWN);
    });
    expect(term.closeSpy).toHaveBeenCalledTimes(1);
    expect(atClose?.stderr).not.toContain('Unexpected error');
    expect(out.stderr).toContain('Unexpected error');
    expect(out.stderr).not.toContain('terminal gone');
    expect(out.stdout).not.toContain('Folder browser closed');
    expect(count('logout 1')).toBe(1);
    expect(exitCode()).toBe(1);
    const finish = events('browse.finish');
    expect(finish).toHaveLength(1);
    expect(finish[0]).toMatchObject({ outcome: 'failed', reason: 'unexpected', level: 'warn' });
    expect(events('error.unexpected')).toHaveLength(1);
  });
});

describe('mm folders in a terminal: reconnect', () => {
  async function dropAndAsk(): Promise<void> {
    // The server closed the connection while the tree was shown (idle timeout).
    const first = sessions[0];
    if (first === undefined) throw new Error('no session yet');
    first.closed = true;
    await press(ENTER);
    await onScreen('Connection closed - reconnect? (y/N)');
  }

  it('y: the old session is logged out, one more guarded login, the page is read on the new session, both logged out at the end', async () => {
    await browse([], async () => {
      await dropAndAsk();
      await press(k('y'));
      await onScreen(SENDER);
      await press(k('q'));
    });
    expect(count('login')).toBe(2);
    expect(count('logout 1')).toBeGreaterThanOrEqual(1);
    expect(count('logout 2')).toBeGreaterThanOrEqual(1);
    // The old session is gone before the second login.
    expect(calls.indexOf('logout 1')).toBeLessThan(calls.lastIndexOf('login'));
    expect(pageLoads).toEqual([2]);
    expect(out.stderr).not.toContain('Reconnecting failed');
    expect(exitCode()).toBe(0);
    expect(events('browse.finish')).toEqual([
      expect.objectContaining({ reconnects: 1, outcome: 'ok' }),
    ]);
  });

  it('a failed reconnect: the notice in the browser, the full login text on stderr after the summary and after the screen is restored', async () => {
    await browse([], async () => {
      await dropAndAsk();
      openSession.mockRejectedValueOnce(new ImapSessionError('auth-failed'));
      await press(k('y'));
      await onScreen(RECONNECT_FAILED_TEXT);
      expect(out.stderr).not.toContain('Reconnecting failed');
      await press(k('q'));
    });
    expect(out.stdout).toContain(CLOSED);
    expect(out.stderr).toContain(`Reconnecting failed — ${GENERIC}`);
    expect(out.all.indexOf(CLOSED)).toBeLessThan(out.all.indexOf('Reconnecting failed'));
    expect(atClose?.all).not.toContain('Reconnecting failed');
    expect(count('logout 1')).toBeGreaterThanOrEqual(1);
    expect(count('logout 2')).toBe(0);
    expect(exitCode()).toBe(0);
    expect(events('error.unexpected')).toEqual([]);
    expect(events('browse.finish')).toEqual([
      expect.objectContaining({ reconnects: 0, outcome: 'ok' }),
    ]);
  });

  it('a reconnect error that is not user-facing: "Unexpected error" after the summary and error.unexpected', async () => {
    await browse([], async () => {
      await dropAndAsk();
      openSession.mockRejectedValueOnce(new Error('boom: secret detail'));
      await press(k('y'));
      await onScreen(RECONNECT_FAILED_TEXT);
      await press(k('q'));
    });
    expect(out.stderr).toContain('Reconnecting failed — Unexpected error');
    expect(out.stderr).not.toContain('secret detail');
    expect(events('error.unexpected')).toHaveLength(1);
    expect(exitCode()).toBe(0);
  });

  it('a failed reconnect followed by a successful one leaves nothing on stderr', async () => {
    await browse([], async () => {
      await dropAndAsk();
      openSession.mockRejectedValueOnce(new ImapSessionError('auth-failed'));
      await press(k('y'));
      await onScreen(RECONNECT_FAILED_TEXT);
      await press(k('r'));
      await onScreen(SENDER);
      await press(k('q'));
    });
    expect(out.stderr).not.toContain('Reconnecting failed');
    expect(events('browse.finish')).toEqual([expect.objectContaining({ reconnects: 1 })]);
    expect(count('logout 2')).toBeGreaterThanOrEqual(1);
  });
});

describe('mm folders in a terminal: the exit hook (signals, crashes)', () => {
  const hooks: [number, 'interrupted' | 'failed'][] = [
    [143, 'interrupted'],
    [129, 'interrupted'],
    [130, 'interrupted'],
    [1, 'failed'],
    [0, 'failed'],
    [2, 'failed'],
  ];

  it.each(hooks)('onExit(%i) -> browse.finish %s, never twice', async (code, outcome) => {
    await browse([], async () => {
      await onScreen('INBOX');
      const onExit = openTerminal.mock.calls[0]?.[0]?.onExit;
      expect(onExit).toBeTypeOf('function');
      onExit?.(code);
      const finish = events('browse.finish');
      expect(finish).toHaveLength(1);
      expect(finish[0]).toMatchObject({ acct: A_ID, outcome });
      if (outcome === 'failed') {
        expect(finish[0]).toMatchObject({ reason: 'unexpected', level: 'warn' });
      } else {
        expect(finish[0]?.['reason']).toBeUndefined();
        expect(finish[0]).toMatchObject({ level: 'info' });
      }
      // The run unwinds later on the test's terms: still just one line.
      await press(CTRL_C);
    });
    expect(events('browse.finish')).toHaveLength(1);
  });

  it('the exit hook does not log out (the process ends synchronously)', async () => {
    await browse([], async () => {
      await onScreen('INBOX');
      openTerminal.mock.calls[0]?.[0]?.onExit?.(143);
      expect(count('logout 1')).toBe(0);
      await press(CTRL_C);
    });
  });
});

describe('mm folders in a terminal through runCli', () => {
  type Handler = (arg?: unknown) => void;

  /** Like `process`, but exit() runs the 'exit' handlers and then returns. */
  class FakeProc {
    readonly handlers = new Map<string, Handler[]>();
    readonly exits: (number | undefined)[] = [];

    get exitCode(): number | string | null | undefined {
      return process.exitCode;
    }

    set exitCode(value: number | string | null | undefined) {
      process.exitCode = value;
    }

    on(event: string, fn: (arg: never) => void): void {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn as Handler]);
    }

    exit(code?: number): never {
      this.exits.push(code);
      const current = process.exitCode;
      const final = code ?? (typeof current === 'number' ? current : 0);
      for (const h of this.handlers.get('exit') ?? []) h(final);
      return undefined as never;
    }
  }

  const ctx: RunContext = { run: RUN, ver: '0.8.0', now: () => T0, level: 'debug' };

  function startRunCli(proc: FakeProc): void {
    pending = runCli({
      argv: ['node', 'mm', 'folders'],
      build: (o) => buildProgram({ ...o, exitOverride: true }),
      log,
      ctx,
      proc,
      flush: () => Promise.resolve(),
    });
  }

  async function started(): Promise<void> {
    await vi.waitFor(() => {
      expect(term.registered()).toBe(true);
    });
  }

  function names(): string[] {
    return log.records.map((r) => r.event);
  }

  it('q: browse.finish before command.finish; command.finish exit 0, ok', async () => {
    startRunCli(new FakeProc());
    await started();
    await openInbox();
    await press(k('q'));
    await pending;
    expect(names().indexOf('browse.finish')).toBeGreaterThan(-1);
    expect(names().indexOf('browse.finish')).toBeLessThan(names().indexOf('command.finish'));
    expect(events('command.finish')).toEqual([
      expect.objectContaining({ cmd: 'folders', exit: 0, outcome: 'ok' }),
    ]);
  });

  it('Ctrl+C: browse.finish interrupted before command.finish exit 130, interrupted', async () => {
    startRunCli(new FakeProc());
    await started();
    await press(CTRL_C);
    await pending;
    expect(names().indexOf('browse.finish')).toBeLessThan(names().indexOf('command.finish'));
    expect(events('browse.finish')).toEqual([expect.objectContaining({ outcome: 'interrupted' })]);
    expect(events('command.finish')).toEqual([
      expect.objectContaining({ exit: 130, outcome: 'interrupted' }),
    ]);
  });

  it('an error in the browser: browse.finish failed before command.finish exit 1', async () => {
    startRunCli(new FakeProc());
    await started();
    await onScreen('INBOX');
    term.failDraw = new Error('terminal gone');
    await press(DOWN);
    await pending;
    expect(out.stderr).toContain('Unexpected error');
    expect(events('browse.finish')).toEqual([
      expect.objectContaining({ outcome: 'failed', reason: 'unexpected' }),
    ]);
    expect(names().indexOf('browse.finish')).toBeLessThan(names().indexOf('command.finish'));
    expect(events('command.finish')).toEqual([
      expect.objectContaining({ exit: 1, outcome: 'failed' }),
    ]);
  });

  it('a signal: the exit hook finishes the browser line, then the process exit finishes the command (143)', async () => {
    const proc = new FakeProc();
    startRunCli(proc);
    await started();
    await onScreen('INBOX');
    // What the terminal does on SIGTERM: onExit(143) runs inside the process 'exit' event, before
    // runCli's own exit handler (which was registered first, but the terminal's is prepended).
    openTerminal.mock.calls[0]?.[0]?.onExit?.(143);
    proc.exit(143);
    expect(names().indexOf('browse.finish')).toBeLessThan(names().indexOf('command.finish'));
    expect(events('browse.finish')).toEqual([expect.objectContaining({ outcome: 'interrupted' })]);
    expect(events('command.finish')).toEqual([expect.objectContaining({ exit: 143 })]);
    await press(CTRL_C);
    await pending;
    expect(events('browse.finish')).toHaveLength(1);
    expect(events('command.finish')).toHaveLength(1);
  });
});

describe('mm folders in a terminal: nothing private in the logs', () => {
  it('no folder name, subject, sender, address, host or password in any log record', async () => {
    await browse([], async () => {
      await openInbox();
      await press(SPACE, DOWN, SPACE);
      await press(k('q'));
      await press(k('y'));
    });
    expect(events('browse.finish')).toHaveLength(1);
    const text = JSON.stringify(log.records) + log.lines.join('\n');
    for (const needle of [
      EMAIL,
      HOST,
      'example-test-domain',
      PASSWORD,
      SENDER,
      'Canary',
      SENDER_ADDRESS,
      SUBJECT,
      'Secret',
      'INBOX',
    ]) {
      expect(text).not.toContain(needle);
    }
  });

  it('also after a failure: the failed browse.finish carries no names or texts', async () => {
    await browse([], async () => {
      await openInbox();
      term.failDraw = new Error(`terminal gone ${SUBJECT} ${EMAIL}`);
      await press(DOWN);
    });
    const text = JSON.stringify(log.records) + log.lines.join('\n');
    for (const needle of [EMAIL, HOST, PASSWORD, SENDER, SUBJECT, 'terminal gone']) {
      expect(text).not.toContain(needle);
    }
  });
});

/** The output of `mm folders ...args` with neither end a terminal; the run's traces are cleared. */
async function baseline(args: string[]): Promise<{ stdout: string; stderr: string }> {
  ttys(false, false);
  const result = await plainOutput(args);
  ttys(true, true);
  resetCapture();
  calls = [];
  sessions = [];
  pageLoads = [];
  return result;
}

/** The stdout / stderr of `mm folders ...args` as it is now, then cleared. */
async function plainOutput(args: string[]): Promise<{ stdout: string; stderr: string }> {
  resetCapture();
  await mm('folders', ...args);
  return { stdout: out.stdout, stderr: out.stderr };
}
