import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import type { Rendered } from '../../src/cli/browser/render.js';
import type { Keypress } from '../../src/cli/browser/state.js';
import type { Terminal, TerminalOptions } from '../../src/cli/browser/terminal.js';
import type { BuildOptions } from '../../src/cli/index.js';
import type { ProcLike } from '../../src/cli/run.js';
import { accountErrorText } from '../../src/cli/account-text.js';
import { imapErrorText } from '../../src/cli/imap-errors.js';
import { AuthError } from '../../src/core/auth.js';
import type { AuthUser, LogoutResult } from '../../src/core/auth.js';
import type { MailAccount, NewMailAccount } from '../../src/core/db/repos.js';
import { ImapSessionError } from '../../src/core/imap/errors.js';
import type { LogEvent, RunContext } from '../../src/core/log/index.js';
import { MailboxError } from '../../src/core/mailbox/errors.js';
import type { FolderTree } from '../../src/core/mailbox/folders.js';
import type { PageResult } from '../../src/core/mailbox/messages.js';
import type { MailboxStats } from '../../src/core/mailbox/stats.js';
import { parseEmail } from '../../src/core/providers/email.js';

// M2d-1 `mm app` and plain `mm` in a terminal: the real runCli, buildProgram, command,
// controller, reducers, renderer and remembered-users file (in a temp config dir). Supabase,
// the env files and the terminal module are mocked; a fake Terminal records the frames and
// feeds the keys. Nothing here types into a real terminal. For the mailbox screen (M2d-2) the
// mailbox login, the folder read and the page read of the core are mocked too - only its last
// describe uses them. So is the stats read (M2d-3): the login it makes right after the folders
// arrived goes to a mock of its own (`statsLogin`), so `openAccountSession` still counts the
// mailbox's own logins, and unless a test says otherwise the read runs until its session is
// logged out. The logs screen (M2d-5) reads the real log files of the temp config dir with the
// real reader. Adding a mailbox (M2d-4) runs the core's own addAccount over the fake accounts
// repo: only the lookup of the settings and the connection to the mail server are mocked, so no
// test can reach the network.

const USER_ID = '22222222-2222-4222-8222-222222222222';
const A_ID = '3f2a91c0-5d4a-4b6f-9e21-7a8c0d1e2f34';
/** As typed, and as Mail Manager stores it. */
const TYPED_EMAIL = 'Typed.Canary@Example-Test-Domain.eu';
const USER_EMAIL = 'typed.canary@example-test-domain.eu';
const PASSWORD = 'Zx9#Qw7$Lk2!vJ5^';
const WRONG_PASSWORD = 'Wr0ng-Kq8&Yt3';
const MAILBOX_EMAIL = 'box.canary@example-test-domain.eu';
const MASTER = Buffer.alloc(32, 7);
const T0 = Date.UTC(2026, 9, 4, 9, 0, 0);
const CTX: RunContext = { run: '0123456789abcdef', ver: '0.9.0', now: () => T0, level: 'debug' };

const NO_TERMINAL =
  'mm app needs a terminal — run it in a terminal window, or use the commands in `mm --help`.';
const NOTHING_SHOWN = '(nothing is shown while you type)';

const {
  createSupabaseServices,
  loadEnvFiles,
  openTerminal,
  paths,
  openAccountSession,
  listFolders,
  loadPage,
  statsLogin,
  collectStats,
  statsRead,
  discover,
  imapOpen,
  addDeps,
} = vi.hoisted(() => ({
  createSupabaseServices: vi.fn<(...args: unknown[]) => unknown>(),
  loadEnvFiles: vi.fn(),
  openTerminal: vi.fn<(options?: TerminalOptions) => Terminal>(),
  paths: { dir: '' },
  openAccountSession:
    vi.fn<(deps: Record<string, unknown>, account: unknown) => Promise<unknown>>(),
  listFolders: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  loadPage: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  /** The login of a stats read: the one made right after the folders of a mailbox arrived. */
  statsLogin: vi.fn<(deps: Record<string, unknown>, account: unknown) => Promise<unknown>>(),
  collectStats:
    vi.fn<
      (session: unknown, tree: unknown, options: Record<string, unknown>) => Promise<unknown>
    >(),
  /** `due`: the folders just arrived, so the next mailbox login is the one of the stats read. */
  statsRead: { due: false },
  /** The lookup of a mailbox's settings: never the network. */
  discover: vi.fn<(address: string, deps: Record<string, unknown>) => Promise<unknown>>(),
  /** The connection `addAccount` logs in on: never a real one. */
  imapOpen: vi.fn<(options: Record<string, unknown>) => Promise<unknown>>(),
  /** What each `addAccount` of the app was given, in order. */
  addDeps: [] as Record<string, unknown>[],
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
  configDir: vi.fn(() => paths.dir),
  logDir: vi.fn(() => join(paths.dir, 'logs')),
}));
vi.mock('../../src/cli/browser/terminal.js', () => ({ openTerminal }));
vi.mock('../../src/core/accounts.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/accounts.js')>();
  return {
    ...actual,
    openAccountSession: (deps: Record<string, unknown>, account: unknown) => {
      if (!statsRead.due) return openAccountSession(deps, account);
      statsRead.due = false;
      return statsLogin(deps, account);
    },
    // The core's own add; only what it was given is kept, for the guard it shares.
    addAccount: (...args: Parameters<typeof actual.addAccount>) => {
      addDeps.push(args[0] as unknown as Record<string, unknown>);
      return actual.addAccount(...args);
    },
  };
});
vi.mock('../../src/core/providers/discover.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/providers/discover.js')>();
  return { ...actual, discover };
});
vi.mock('../../src/core/imap/session.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/imap/session.js')>();
  return { ...actual, openSession: imapOpen };
});
vi.mock('../../src/core/mailbox/folders.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/mailbox/folders.js')>();
  return {
    ...actual,
    listFolders: async (...args: unknown[]) => {
      const tree = await listFolders(...args);
      // The app reads the stats of every mailbox whose folders it could list - but Gmail's
      // with All Mail hidden.
      statsRead.due = (tree as FolderTree | undefined)?.gmailAllHidden === false;
      return tree;
    },
  };
});
vi.mock('../../src/core/mailbox/stats.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/mailbox/stats.js')>();
  return { ...actual, collectStats };
});
vi.mock('../../src/core/mailbox/messages.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/mailbox/messages.js')>();
  return { ...actual, loadPage };
});

const { buildProgram } = await import('../../src/cli/index.js');
const { AccountError } = await import('../../src/core/accounts.js');
const { runCli } = await import('../../src/cli/run.js');
const { ConfigError } = await import('../../src/core/config.js');
const { FileEventLog, MemoryEventLog, commandFinish, commandStart } =
  await import('../../src/core/log/index.js');
type Log = InstanceType<typeof MemoryEventLog>;

// ---- fakes ----

type Handler = (arg?: unknown) => void;

/** Stand-in for `process`: exit() runs the 'exit' handlers, then returns. */
class FakeProc implements ProcLike {
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
    for (const h of this.handlers.get('exit') ?? []) {
      h(code ?? (typeof current === 'number' ? current : 0));
    }
    return undefined as never;
  }
}

/** A Mail Manager that knows one user; the session survives like session.json would. */
interface FakeServer {
  session: AuthUser | null;
  calls: string[];
  logins: [string, string][];
  /** When set, logout() waits for it. */
  logoutGate: Promise<void> | null;
  listError: Error | null;
  /** The mailboxes saved in this test, after the one that is always there. */
  added: MailAccount[];
  /** The audit rows written in this test. */
  audits: Record<string, unknown>[];
}

let server: FakeServer;

function services(): unknown {
  return {
    auth: {
      currentUser: () => {
        server.calls.push('currentUser');
        return Promise.resolve(server.session);
      },
      login: (email: string, password: string) => {
        server.calls.push('login');
        server.logins.push([email, password]);
        if (email.toLowerCase() !== USER_EMAIL || password !== PASSWORD) {
          return Promise.reject(new AuthError('invalid_credentials', 'Invalid login credentials'));
        }
        server.session = { email: USER_EMAIL, userId: USER_ID };
        return Promise.resolve(server.session);
      },
      logout: async (): Promise<LogoutResult> => {
        server.calls.push('logout');
        if (server.logoutGate !== null) await server.logoutGate;
        const had = server.session !== null;
        server.session = null;
        server.calls.push('logged-out');
        return had ? 'logged-out' : 'not-logged-in';
      },
    },
    accounts: {
      list: () => {
        server.calls.push('list');
        return server.listError === null
          ? Promise.resolve([mailbox(), ...server.added])
          : Promise.reject(server.listError);
      },
      get: (id: string) => Promise.resolve(id === A_ID ? mailbox() : null),
      findByEmail: (email: string) =>
        Promise.resolve([mailbox(), ...server.added].filter((a) => a.email === email)),
      create: (a: NewMailAccount) => {
        const row: MailAccount = {
          ...mailbox(),
          id: a.id,
          email: a.email,
          provider: a.provider,
          host: a.host,
          username: a.username,
          secret: a.secret,
        };
        server.added.push(row);
        return Promise.resolve(row);
      },
      recordCheck: () => Promise.resolve(true),
    },
    audit: {
      write: (entry: Record<string, unknown>) => {
        server.audits.push(entry);
        return Promise.resolve();
      },
    },
  };
}

function mailbox(): MailAccount {
  return {
    id: A_ID,
    userId: USER_ID,
    label: null,
    email: MAILBOX_EMAIL,
    provider: 'websupport',
    host: 'imap.canary-host.example-test-domain.eu',
    port: 993,
    username: MAILBOX_EMAIL,
    authType: 'password',
    secret: { ciphertext: 'CANARY-CIPHERTEXT', iv: 'iv', tag: 'tag', keyVersion: 1 },
    capabilities: null,
    createdAt: new Date(T0),
    updatedAt: new Date(T0),
    lastCheckedAt: null,
  };
}

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
let proc: FakeProc;
let term: FakeTerminal;
/** What was printed at the moment `terminal.close` ran. */
let atClose: { all: string; calls: string[] } | null;
let pending: Promise<void> | null;
/** The sessions the stats reads of this test logged in on, in order. */
let statsSessions: { logout: ReturnType<typeof vi.fn<() => Promise<void>>> }[];
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

beforeEach(() => {
  out = { stdout: '', stderr: '', all: '' };
  atClose = null;
  pending = null;
  paths.dir = join(mkdtempSync(join(tmpdir(), 'mm-app-')), 'cfg');
  server = {
    session: null,
    calls: [],
    logins: [],
    logoutGate: null,
    listError: null,
    added: [],
    audits: [],
  };
  addDeps.length = 0;
  process.exitCode = undefined;
  process.env['MM_MASTER_KEY'] = MASTER.toString('base64');
  process.env['TERM'] = 'xterm';
  log = new MemoryEventLog(CTX);
  proc = new FakeProc();
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
  // Safety net: nothing under test may end the test process.
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`real process.exit(${String(code)}) called`);
  });
  createSupabaseServices.mockImplementation(services);
  statsSessions = [];
  statsRead.due = false;
  statsLogin.mockImplementation(() => {
    const session = {
      ...{ client: {}, features: {}, closed: false },
      logout: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    };
    statsSessions.push(session);
    return Promise.resolve(session);
  });
  // As a read of a big mailbox: under way until its session is logged out, which ends it.
  collectStats.mockImplementation((session) => {
    const reading = session as { logout: () => Promise<void> };
    const logout = reading.logout;
    return new Promise((_resolve, reject) => {
      reading.logout = () => {
        reject(new MailboxError('connection-lost'));
        return logout();
      };
    });
  });
  term = fakeTerminal();
  term.closeSpy.mockImplementation(() => {
    atClose = { all: out.all, calls: [...server.calls] };
  });
  openTerminal.mockImplementation(() => term);
  ttys(true, true);
});

afterEach(async () => {
  // A test that failed half-way must not leave an app running.
  if (term.registered()) term.key(CTRL_C);
  await pending?.catch(() => undefined);
  vi.restoreAllMocks();
  for (const fn of [
    createSupabaseServices,
    loadEnvFiles,
    openTerminal,
    openAccountSession,
    listFolders,
    loadPage,
    statsLogin,
    collectStats,
    discover,
    imapOpen,
  ]) {
    fn.mockReset();
  }
  process.exitCode = undefined;
  if (originalMasterKey === undefined) delete process.env['MM_MASTER_KEY'];
  else process.env['MM_MASTER_KEY'] = originalMasterKey;
  if (originalTerm === undefined) delete process.env['TERM'];
  else process.env['TERM'] = originalTerm;
  restoreTTY(process.stdin, originalInIsTTY);
  restoreTTY(process.stdout, originalOutIsTTY);
  rmSync(join(paths.dir, '..'), { recursive: true, force: true });
});

/** One `mm ...` run through the real runCli; `interactive` is what bin.ts would pass. */
function mm(args: string[], interactive: boolean): Promise<void> {
  return runCli({
    argv: ['node', 'mm', ...args],
    build: (o: BuildOptions) => buildProgram({ ...o, exitOverride: true }),
    log,
    ctx: CTX,
    proc,
    flush: () => Promise.resolve(),
    interactive,
  });
}

const k = (name: string, extra: Keypress = {}): Keypress => ({ name, sequence: name, ...extra });
const ENTER = k('return', { sequence: '\r' });
const DOWN = k('down', { sequence: '\u001b[B' });
const CTRL_C = k('c', { ctrl: true, sequence: '\u0003' });
// Ctrl+C within readline's escape timeout after Esc: one keypress, no name, both bytes.
const ESC_CTRL_C: Keypress = {
  sequence: '\u001b\u0003',
  ctrl: false,
  meta: true,
  shift: false,
};
const ch = (text: string): Keypress => ({ name: text.toLowerCase(), sequence: text });

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

async function typeText(text: string): Promise<void> {
  await press(...[...text].map(ch));
}

/** Starts the run, waits until the app is up, runs the script, waits for the end. */
async function app(args: string[], script: () => Promise<void>, interactive = true): Promise<void> {
  pending = mm(args, interactive);
  await vi.waitFor(() => {
    expect(term.registered()).toBe(true);
  });
  await script();
  await pending;
}

function exitCode(): number {
  return typeof process.exitCode === 'number' ? process.exitCode : 0;
}

function names(): string[] {
  return log.records.map((r) => r.event);
}

function events(name: string): Record<string, unknown>[] {
  return log.records.filter((r) => r.event === name);
}

function usersFile(): string {
  return join(paths.dir, 'users.json');
}

function expectNothingPrivateLogged(): void {
  expect(log.lines.length).toBeGreaterThan(0);
  for (const line of log.lines) {
    const lower = line.toLowerCase();
    for (const secret of [USER_EMAIL, 'canary', 'example-test-domain', PASSWORD, WRONG_PASSWORD]) {
      expect(lower).not.toContain(secret.toLowerCase());
    }
  }
}

// ---- tests ----

describe('plain mm (AC1)', () => {
  it('in a terminal it opens the app; q ends it with exit code 0', async () => {
    await app([], async () => {
      await onScreen(NOTHING_SHOWN);
      await press(k('escape', { meta: true, sequence: '\u001b' }));
      await onScreen('Sign in');
      await press(ch('q'));
    });
    expect(openTerminal).toHaveBeenCalledTimes(1);
    expect(term.closeSpy).toHaveBeenCalledTimes(1);
    expect(exitCode()).toBe(0);
    expect(names()).toEqual(['command.start', 'command.finish']);
    expect(events('command.start')[0]).toMatchObject({ cmd: 'app', opts: [] });
    expect(events('command.finish')[0]).toMatchObject({ cmd: 'app', outcome: 'ok', exit: 0 });
    // Nothing is printed around the app.
    expect(out.all).toBe('');
    expect(proc.exits).toHaveLength(1);
  });

  it('without a terminal it prints the help as before: exit 1, nothing logged, no app', async () => {
    await mm([], false);
    expect(out.all).toContain('Usage: mm');
    expect(out.all).toContain('Getting started:');
    expect(exitCode()).toBe(1);
    expect(log.records).toEqual([]);
    expect(openTerminal).not.toHaveBeenCalled();
    expect(createSupabaseServices).not.toHaveBeenCalled();
  });

  it.each([
    [['nosuchcmd'], "unknown command 'nosuchcmd'"],
    [['--help'], 'Usage: mm'],
    [['app', 'extra'], 'too many arguments'],
  ])('with arguments (%j) nothing changes, terminal or not', async (args, text) => {
    for (const interactive of [true, false]) {
      out = { stdout: '', stderr: '', all: '' };
      await mm(args, interactive);
      expect(out.all).toContain(text);
      expect(openTerminal).not.toHaveBeenCalled();
      expect(log.records).toEqual([]);
    }
  });

  it('`mm app` opens the app whatever was detected for plain mm', async () => {
    await app(
      ['app'],
      async () => {
        await onScreen(NOTHING_SHOWN);
        term.key(CTRL_C);
        await Promise.resolve();
      },
      false,
    );
    expect(openTerminal).toHaveBeenCalledTimes(1);
    expect(exitCode()).toBe(130);
  });
});

describe('mm app without a terminal (AC2)', () => {
  it.each([
    ['stdin is not a terminal', false, true, 'xterm'],
    ['stdout is not a terminal', true, false, 'xterm'],
    ['neither is', false, false, 'xterm'],
    ['TERM is dumb', true, true, 'dumb'],
  ] as const)(
    '%s: its message, exit 1, nothing opened or asked',
    async (_label, stdin, stdout, termName) => {
      ttys(stdin, stdout);
      process.env['TERM'] = termName;
      await mm(['app'], false);
      expect(out.stderr).toBe(`${NO_TERMINAL}\n`);
      expect(out.stdout).toBe('');
      expect(exitCode()).toBe(1);
      expect(openTerminal).not.toHaveBeenCalled();
      expect(createSupabaseServices).not.toHaveBeenCalled();
      expect(existsSync(paths.dir)).toBe(false);
      expect(names()).toEqual(['command.start', 'command.finish']);
      expect(events('command.start')[0]).toMatchObject({ cmd: 'app' });
      expect(events('command.finish')[0]).toMatchObject({ cmd: 'app', outcome: 'failed', exit: 1 });
    },
  );
});

describe('a broken config (AC3)', () => {
  it('the services cannot be made: the config text, exit 1, the terminal never opened', async () => {
    createSupabaseServices.mockImplementation(() => {
      throw new ConfigError([{ variable: 'SUPABASE_URL', problem: 'is missing' }]);
    });
    await mm([], true);
    expect(out.stderr).toContain('SUPABASE_URL is missing');
    expect(out.stderr).not.toContain('Unexpected error');
    expect(exitCode()).toBe(1);
    expect(openTerminal).not.toHaveBeenCalled();
    expect(names()).toEqual(['command.start', 'command.finish']);
    expect(events('command.finish')[0]).toMatchObject({ cmd: 'app', outcome: 'failed' });
  });

  it('the env files cannot be read: the same', async () => {
    loadEnvFiles.mockImplementation(() => {
      throw new ConfigError([{ variable: 'MM_MASTER_KEY', problem: 'is not valid base64' }]);
    });
    await mm(['app'], true);
    expect(out.stderr).toContain('MM_MASTER_KEY is not valid base64');
    expect(exitCode()).toBe(1);
    expect(openTerminal).not.toHaveBeenCalled();
    expect(createSupabaseServices).not.toHaveBeenCalled();
  });
});

describe('a whole visit (AC11, AC18, AC26)', () => {
  it('failed sign-in, sign-in, Home, log out, quit: exit 0 and only the auth events', async () => {
    await app([], async () => {
      await onScreen(NOTHING_SHOWN);
      await typeText(TYPED_EMAIL);
      await press(ENTER);
      await typeText(WRONG_PASSWORD);
      await press(ENTER);
      await onScreen('Wrong e-mail or password - try again.');
      expect(screen()).toContain(`E-mail:    ${TYPED_EMAIL}`);
      await typeText(PASSWORD);
      await press(ENTER);
      await onScreen(MAILBOX_EMAIL);
      expect(screen()).toContain(`Mail Manager - ${USER_EMAIL}`);
      expect(screen()).toContain('Websupport');
      await press(DOWN, DOWN, DOWN, ENTER);
      await onScreen('Sign in as another user');
      // Still listed, no longer signed in.
      expect(screen()).toContain(USER_EMAIL);
      expect(screen()).not.toContain('signed in');
      await press(ch('q'));
    });
    expect(exitCode()).toBe(0);
    expect(server.logins).toEqual([
      [TYPED_EMAIL, WRONG_PASSWORD],
      [TYPED_EMAIL, PASSWORD],
    ]);
    expect(server.session).toBeNull();
    expect(names()).toEqual([
      'command.start',
      'auth.login-failed',
      'auth.login',
      'auth.logout',
      'command.finish',
    ]);
    expect(events('auth.login-failed')[0]).toMatchObject({ reason: 'invalid-credentials' });
    expect(events('auth.login-failed')[0]?.['target']).toMatch(/^[0-9a-f]{64}$/);
    expect(events('auth.login')[0]).toMatchObject({ user: USER_ID });
    expect(events('auth.logout')[0]).toMatchObject({ outcome: 'logged-out' });
    expect(events('command.finish')[0]).toMatchObject({ cmd: 'app', outcome: 'ok', exit: 0 });
    expectNothingPrivateLogged();
    // Neither password was ever on screen, and nothing was printed around the app.
    for (const frame of term.frames) {
      const text = frame.lines.join('\n');
      for (const secret of [PASSWORD, WRONG_PASSWORD]) {
        for (let i = 0; i + 4 <= secret.length; i++) {
          expect(text).not.toContain(secret.slice(i, i + 4));
        }
      }
      expect(text).not.toContain('CANARY-CIPHERTEXT');
      expect(text).not.toContain('canary-host');
    }
    expect(out.all).toBe('');
    expect(term.closeSpy).toHaveBeenCalledTimes(1);
  });

  it('the address is remembered in users.json: mode 600, addresses only', async () => {
    await app([], async () => {
      await onScreen(NOTHING_SHOWN);
      await typeText(TYPED_EMAIL);
      await press(ENTER);
      await typeText(PASSWORD);
      await press(ENTER);
      await onScreen(MAILBOX_EMAIL);
      await press(ch('q'));
    });
    expect(readFileSync(usersFile(), 'utf8')).toBe(JSON.stringify({ v: 1, emails: [USER_EMAIL] }));
    if (process.platform !== 'win32') {
      expect(statSync(usersFile()).mode & 0o777).toBe(0o600);
      expect(statSync(paths.dir).mode & 0o777).toBe(0o700);
    }
    // Quit without logging out: the session stays, as after `mm login`.
    expect(server.session).toEqual({ email: USER_EMAIL, userId: USER_ID });
    expect(names()).toEqual(['command.start', 'auth.login', 'command.finish']);
  });

  it('a wrong password leaves nothing in users.json', async () => {
    await app([], async () => {
      await onScreen(NOTHING_SHOWN);
      await typeText(TYPED_EMAIL);
      await press(ENTER);
      await typeText(WRONG_PASSWORD);
      await press(ENTER);
      await onScreen('Wrong e-mail or password');
      await press(ch('x'));
      term.key(CTRL_C);
    });
    expect(existsSync(usersFile())).toBe(false);
    expect(exitCode()).toBe(130);
  });

  it('a user who was signed in already (mm login, no users.json) is still listed after Log out', async () => {
    server.session = { email: USER_EMAIL, userId: USER_ID };
    await app([], async () => {
      await onScreen('signed in');
      expect(screen()).toContain(USER_EMAIL);
      await press(ENTER);
      await onScreen(MAILBOX_EMAIL);
      await press(DOWN, DOWN, DOWN, ENTER);
      await onScreen('Sign in as another user');
      expect(screen()).toContain(USER_EMAIL);
      expect(screen()).not.toContain('signed in');
      await press(ch('q'));
    });
    expect(server.logins).toEqual([]);
    expect(readFileSync(usersFile(), 'utf8')).toBe(JSON.stringify({ v: 1, emails: [USER_EMAIL] }));
    expect(names()).toEqual(['command.start', 'auth.logout', 'command.finish']);
    expectNothingPrivateLogged();
    expect(exitCode()).toBe(0);
  });

  it('without MM_MASTER_KEY two failed sign-ins of one run still get one target', async () => {
    delete process.env['MM_MASTER_KEY'];
    await app([], async () => {
      await onScreen(NOTHING_SHOWN);
      await typeText(TYPED_EMAIL);
      await press(ENTER);
      for (const wrong of ['first-wrong', 'second-wrong']) {
        await typeText(wrong);
        await press(ENTER);
        await vi.waitFor(() => {
          expect(screen()).toContain('Wrong e-mail or password');
        });
      }
      await vi.waitFor(() => {
        expect(events('auth.login-failed')).toHaveLength(2);
      });
      await press(ch('x'));
      term.key(CTRL_C);
    });
    const [first, second] = events('auth.login-failed');
    expect(first?.['target']).toMatch(/^[0-9a-f]{64}$/);
    expect(second?.['target']).toBe(first?.['target']);
  });
});

describe('Ctrl+C (AC21)', () => {
  it('ends at once: the screen closed, exit 130, command.finish interrupted', async () => {
    server.session = { email: USER_EMAIL, userId: USER_ID };
    await app([], async () => {
      await onScreen('signed in');
      term.key(CTRL_C);
      await Promise.resolve();
    });
    expect(term.closeSpy).toHaveBeenCalledTimes(1);
    expect(exitCode()).toBe(130);
    expect(names()).toEqual(['command.start', 'command.finish']);
    expect(events('command.finish')[0]).toMatchObject({
      cmd: 'app',
      outcome: 'interrupted',
      exit: 130,
    });
    expect(out.all).toBe('');
    // Not signed out by leaving.
    expect(server.session).not.toBeNull();
  });

  it('Ctrl+C right after Esc, joined into one keypress by readline, ends it the same way', async () => {
    await app([], async () => {
      await onScreen(NOTHING_SHOWN);
      await typeText(TYPED_EMAIL);
      await press(ENTER);
      await typeText(WRONG_PASSWORD);
      term.key(ESC_CTRL_C);
      await Promise.resolve();
    });
    expect(term.closeSpy).toHaveBeenCalledTimes(1);
    expect(exitCode()).toBe(130);
    expect(names()).toEqual(['command.start', 'command.finish']);
    expect(events('command.finish')[0]).toMatchObject({
      cmd: 'app',
      outcome: 'interrupted',
      exit: 130,
    });
    expect(server.logins).toEqual([]);
    expect(out.all).toBe('');
  });

  it('during "Signing out...": the sign-out is finished and logged before the process ends', async () => {
    server.session = { email: USER_EMAIL, userId: USER_ID };
    let release: () => void = () => undefined;
    server.logoutGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    pending = mm([], true);
    await vi.waitFor(() => {
      expect(term.registered()).toBe(true);
    });
    await onScreen('signed in');
    await press(ENTER);
    await onScreen(MAILBOX_EMAIL);
    await press(DOWN, DOWN, DOWN, ENTER);
    await onScreen('Signing out...');
    term.key(CTRL_C);
    await new Promise<void>((resolve) => setImmediate(resolve));
    // The screen is given back at once; the process waits for the sign-out.
    expect(term.closeSpy).toHaveBeenCalledTimes(1);
    expect(atClose?.calls).not.toContain('logged-out');
    expect(proc.exits).toEqual([]);
    expect(names()).toEqual(['command.start']);
    release();
    await pending;
    expect(server.session).toBeNull();
    expect(names()).toEqual(['command.start', 'auth.logout', 'command.finish']);
    expect(events('command.finish')[0]).toMatchObject({ outcome: 'interrupted', exit: 130 });
    expect(exitCode()).toBe(130);
    expect(proc.exits).toHaveLength(1);
  });
});

describe('errors (AC19, AC25)', () => {
  it('a terminal that fails to draw: the screen is closed first, then "Unexpected error", exit 1', async () => {
    server.session = { email: USER_EMAIL, userId: USER_ID };
    await app([], async () => {
      await onScreen('signed in');
      term.failDraw = new Error('terminal gone: raw text');
      term.key(DOWN);
      await Promise.resolve();
    });
    expect(term.closeSpy).toHaveBeenCalledTimes(1);
    expect(atClose?.all).toBe('');
    expect(out.stderr).toBe('Unexpected error\n');
    expect(out.all).not.toContain('raw text');
    expect(exitCode()).toBe(1);
    expect(names()).toEqual(['command.start', 'error.unexpected', 'command.finish']);
    expect(events('command.finish')[0]).toMatchObject({ cmd: 'app', outcome: 'failed', exit: 1 });
  });

  it('a terminal that cannot be opened: "Unexpected error", exit 1', async () => {
    openTerminal.mockImplementation(() => {
      throw new Error('raw mode refused');
    });
    await mm([], true);
    expect(out.stderr).toBe('Unexpected error\n');
    expect(exitCode()).toBe(1);
    expect(names()).toEqual(['command.start', 'error.unexpected', 'command.finish']);
  });

  it('a mailbox list that fails for a reason of its own is logged, and the app goes on', async () => {
    server.session = { email: USER_EMAIL, userId: USER_ID };
    server.listError = new TypeError('cannot read properties of undefined');
    await app([], async () => {
      await onScreen('signed in');
      await press(ENTER);
      await onScreen(
        "Couldn't load your mailboxes - check your internet connection (r = try again).",
      );
      expect(screen()).not.toContain('cannot read');
      server.listError = null;
      await press(ch('r'));
      await onScreen(MAILBOX_EMAIL);
      await press(ch('q'));
    });
    expect(exitCode()).toBe(0);
    expect(names()).toEqual(['command.start', 'error.unexpected', 'command.finish']);
    for (const line of log.lines) expect(line).not.toContain('cannot read');
    expect(out.all).toBe('');
  });

  it('the sign-in ended meanwhile: the sign-in page says so', async () => {
    server.session = { email: USER_EMAIL, userId: USER_ID };
    await app([], async () => {
      await onScreen('signed in');
      // The session is revoked elsewhere, then the list is refused.
      server.listError = new AuthError('unknown', 'jwt expired');
      server.session = null;
      await press(ENTER);
      await onScreen('Your sign-in has ended - sign in again.');
      expect(screen()).toContain(USER_EMAIL);
      expect(screen()).not.toContain('signed in  ');
      await press(ch('q'));
    });
    expect(exitCode()).toBe(0);
    expect(names()).toEqual(['command.start', 'command.finish']);
  });
});

describe('a mailbox (M2d-2)', () => {
  const TREE: FolderTree = {
    folders: [
      {
        path: 'INBOX',
        name: 'INBOX',
        parentPath: null,
        depth: 0,
        delimiter: '/',
        role: 'inbox',
        roleSource: 'path',
        selectable: true,
        subscribed: true,
        messages: 2,
        unseen: 0,
        bytes: 2048,
        sizeSource: 'server',
        overlapping: false,
      },
    ],
    totals: { messages: 2, unseen: 0, bytes: 2048, sizeSource: 'server' },
    quota: null,
    truncated: false,
    unreadable: 0,
    gmailAllHidden: false,
    fallbacks: new Set(),
  };
  const PAGE: PageResult = {
    kind: 'page',
    snapshot: { path: 'INBOX', uidValidity: '7', exists: 2 },
    page: 0,
    rows: [2, 1].map((seq) => ({
      seq,
      uid: 1000 + seq,
      received: new Date(T0),
      from: 'canary.sender@example-test-domain.eu',
      subject: `Canary subject ${String(seq)}`,
      bytes: 100,
      attachment: false,
    })),
  };

  function session(): { logout: ReturnType<typeof vi.fn<() => Promise<void>>> } {
    return {
      ...{ client: {}, features: {}, closed: false },
      logout: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    };
  }

  /** How a line names the mailbox: address, provider, short id. */
  const MAILBOX_LABEL = `${MAILBOX_EMAIL} (Websupport, id 3f2a91c0)`;

  /** Signed in, Home, Enter on the mailbox. */
  async function openMailbox(): Promise<void> {
    await onScreen('signed in');
    await press(ENTER);
    await onScreen(MAILBOX_EMAIL);
    await press(ENTER);
  }

  it('one login per open with one guard for the run; the exit hook logs the visit, Ctrl+C logs out', async () => {
    server.session = { email: USER_EMAIL, userId: USER_ID };
    const first = session();
    const second = session();
    openAccountSession.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    listFolders.mockResolvedValue(TREE);
    loadPage.mockResolvedValue(PAGE);
    await app([], async () => {
      await openMailbox();
      await onScreen('Total: 2 messages, 0 unread, 2.0 KB');
      await press(k('escape', { meta: true, sequence: '\u001b' }));
      await onScreen('+ Add a mailbox');
      expect(first.logout).toHaveBeenCalledTimes(1);
      await press(ENTER);
      await onScreen('Total:');
      await press(ENTER);
      await onScreen('Canary subject 2');
      // What a SIGTERM does: the terminal gives the screen back and calls its exit hook.
      openTerminal.mock.calls[0]?.[0]?.onExit?.(143);
      expect(events('browse.finish')).toEqual([
        expect.objectContaining({ acct: A_ID, folders: 1, mails: 2, outcome: 'interrupted' }),
      ]);
      expect(second.logout).not.toHaveBeenCalled();
      term.key(CTRL_C);
      await Promise.resolve();
    });
    expect(second.logout).toHaveBeenCalledTimes(1);
    expect(first.logout).toHaveBeenCalledTimes(1);
    expect(exitCode()).toBe(130);
    expect(names()).toEqual([
      'command.start',
      'folders.list',
      'folders.list',
      'browse.finish',
      'command.finish',
    ]);
    // The mailbox that Home showed, found again by its id, and what a login needs.
    expect(openAccountSession).toHaveBeenCalledTimes(2);
    const [deps, account] = openAccountSession.mock.calls[0] ?? [];
    expect(account).toEqual(mailbox());
    expect(Object.keys(deps ?? {}).sort()).toEqual([
      'clientVersion',
      'credentials',
      'guard',
      'log',
      'onChallenge',
    ]);
    expect(deps?.['guard']).toBeDefined();
    expect(openAccountSession.mock.calls[1]?.[0]['guard']).toBe(deps?.['guard']);
    expect(out.all).toBe('');
    expectNothingPrivateLogged();
  });

  it('a mailbox login that fails for a reason of its own: "Unexpected error", exit 1, logged once', async () => {
    server.session = { email: USER_EMAIL, userId: USER_ID };
    openAccountSession.mockRejectedValue(new TypeError('cannot read properties of undefined'));
    await app([], async () => {
      await onScreen('signed in');
      await press(ENTER);
      await onScreen(MAILBOX_EMAIL);
      term.key(ENTER);
      await Promise.resolve();
    });
    expect(term.closeSpy).toHaveBeenCalledTimes(1);
    expect(atClose?.all).toBe('');
    expect(out.stderr).toBe('Unexpected error\n');
    expect(out.stdout).toBe('');
    expect(exitCode()).toBe(1);
    expect(names()).toEqual([
      'command.start',
      'folders.list',
      'error.unexpected',
      'command.finish',
    ]);
    expect(events('folders.list')[0]).toMatchObject({ outcome: 'failed', reason: 'unexpected' });
    expect(events('command.finish')[0]).toMatchObject({ cmd: 'app', outcome: 'failed', exit: 1 });
    for (const line of log.lines) expect(line).not.toContain('cannot read');
  });

  it('a reconnect that failed is explained on stderr once the screen is given back', async () => {
    server.session = { email: USER_EMAIL, userId: USER_ID };
    const first = session();
    // A failure whose text names the mailbox it is about.
    const failure = new AccountError('secret-unreadable');
    openAccountSession.mockResolvedValueOnce(first).mockRejectedValueOnce(failure);
    listFolders.mockResolvedValue(TREE);
    loadPage.mockRejectedValue(new MailboxError('connection-lost'));
    await app([], async () => {
      await openMailbox();
      await onScreen('Total:');
      await press(ENTER);
      await onScreen('Connection closed - reconnect? (y/N)');
      await press(ch('y'));
      await onScreen("Couldn't reconnect - showing what is loaded.");
      await press(ch('q'));
    });
    expect(atClose?.all).toBe('');
    expect(out.stdout).toBe('');
    expect(out.stderr).toBe(
      `Reconnecting to ${MAILBOX_LABEL} failed \u2014 ${accountErrorText(failure, mailbox())}\n`,
    );
    // The text is about this mailbox: its short id, not the placeholder.
    expect(out.stderr).toContain('`mm account remove 3f2a91c0`');
    expect(out.stderr).not.toContain('<id>');
    expect(exitCode()).toBe(0);
    expect(first.logout).toHaveBeenCalledTimes(1);
    expect(names()).toEqual(['command.start', 'folders.list', 'browse.finish', 'command.finish']);
    expectNothingPrivateLogged();
  });

  it('the line names the mailbox, also for an ordinary login failure and after the mailbox was left', async () => {
    server.session = { email: USER_EMAIL, userId: USER_ID };
    const first = session();
    openAccountSession
      .mockResolvedValueOnce(first)
      .mockRejectedValueOnce(new ImapSessionError('auth-failed'));
    listFolders.mockResolvedValue(TREE);
    loadPage.mockRejectedValue(new MailboxError('connection-lost'));
    await app([], async () => {
      await openMailbox();
      await onScreen('Total:');
      await press(ENTER);
      await onScreen('Connection closed - reconnect? (y/N)');
      await press(ch('y'));
      await onScreen("Couldn't reconnect - showing what is loaded.");
      // Back to the bars, back to Home: the failure is still to be explained.
      const esc = k('escape', { meta: true, sequence: '\u001b' });
      await press(esc, esc);
      await onScreen('+ Add a mailbox');
      await press(ch('q'));
    });
    expect(atClose?.all).toBe('');
    expect(out.stdout).toBe('');
    // The login text is the same for every mailbox: only the label says which one it was.
    expect(out.stderr).toBe(
      `Reconnecting to ${MAILBOX_LABEL} failed \u2014 ${imapErrorText('auth-failed', { kind: 'this-computer' })}\n`,
    );
    expect(exitCode()).toBe(0);
    expect(names()).toEqual(['command.start', 'folders.list', 'browse.finish', 'command.finish']);
    expectNothingPrivateLogged();
  });

  it('the stats (M2d-3): one more login with the same guard, read on that session, logged as counts', async () => {
    server.session = { email: USER_EMAIL, userId: USER_ID };
    const own = session();
    openAccountSession.mockResolvedValueOnce(own);
    listFolders.mockResolvedValue(TREE);
    const sender = { key: 'canary.sender@example-test-domain.eu', messages: 2, bytes: 2048 };
    const domain = { key: 'example-test-domain.eu', messages: 2, bytes: 2048 };
    const stats: MailboxStats = {
      folders: [{ path: 'INBOX', messages: 2, bytes: 2048, partial: false }],
      notScanned: 0,
      totals: { messages: 2, bytes: 2048 },
      years: [{ year: '2026', messages: 2, bytes: 2048 }],
      senders: { byCount: [sender], bySize: [sender], others: { messages: 0, bytes: 0 } },
      domains: { byCount: [domain], bySize: [domain], others: { messages: 0, bytes: 0 } },
      largest: [
        {
          folder: 'INBOX',
          received: new Date(T0),
          from: 'canary.sender@example-test-domain.eu',
          subject: 'Canary subject 2',
          bytes: 1024,
        },
      ],
      approximate: false,
      unreadable: 0,
      partial: 0,
    };
    collectStats.mockResolvedValueOnce(stats);
    await app([], async () => {
      await openMailbox();
      await onScreen('Stats ready - press s');
      await press(ch('s'));
      await onScreen('Scanned 1 folder, 2 messages, 2.0 KB (approx.)');
      await press(ch('4'));
      await onScreen('Canary subject 2');
      await press(ch('q'));
    });
    expect(exitCode()).toBe(0);
    expect(out.all).toBe('');
    // The mailbox's own login, and one more for the stats: the same account, the same guard.
    expect(openAccountSession).toHaveBeenCalledTimes(1);
    expect(statsLogin).toHaveBeenCalledTimes(1);
    const [deps, account] = statsLogin.mock.calls[0] ?? [];
    expect(account).toEqual(mailbox());
    expect(Object.keys(deps ?? {}).sort()).toEqual(
      Object.keys(openAccountSession.mock.calls[0]?.[0] ?? {}).sort(),
    );
    expect(deps?.['guard']).toBeDefined();
    expect(deps?.['guard']).toBe(openAccountSession.mock.calls[0]?.[0]['guard']);
    // The read: on the stats session, over the folders of the bars, in a time zone.
    expect(collectStats).toHaveBeenCalledTimes(1);
    const [readOn, tree, options] = collectStats.mock.calls[0] ?? [];
    expect(readOn).toBe(statsSessions[0]);
    expect(tree).toBe(TREE);
    expect(typeof options?.['timeZone']).toBe('string');
    expect(typeof options?.['onProgress']).toBe('function');
    // Each session logged out once: the stats one when its read ended, the mailbox's on quit.
    expect(statsSessions).toHaveLength(1);
    expect(statsSessions[0]?.logout).toHaveBeenCalledTimes(1);
    expect(own.logout).toHaveBeenCalledTimes(1);
    expect(names()).toEqual(['command.start', 'folders.list', 'stats.finish', 'command.finish']);
    const finish = events('stats.finish')[0] ?? {};
    expect(finish).toMatchObject({
      acct: A_ID,
      folders: 1,
      messages: 2,
      bytes: 2048,
      outcome: 'ok',
    });
    expect(Object.keys(finish).sort()).toEqual(
      [
        'acct',
        'bytes',
        'event',
        'folders',
        'level',
        'messages',
        'ms',
        'outcome',
        'run',
        'ts',
        'v',
      ].sort(),
    );
    expectNothingPrivateLogged();
  });
});

describe('the logs (M2d-5)', () => {
  const DAY = 86_400_000;
  const MINUTE = 60_000;
  const RT = { ver: '0.9.0', node: '22.13.0', os: 'linux' };
  const READING = 'Reading the logs...';

  /** One line in the log folder of this test, written `ago` ms ago by the run `run`. */
  function seed(run: string, ago: number, event: LogEvent): void {
    const at = Date.now() - ago;
    new FileEventLog(join(paths.dir, 'logs'), {
      run,
      ver: '0.9.0',
      now: () => at,
      level: 'debug',
    }).emit(event);
  }

  function logFiles(): Record<string, string> {
    const dir = join(paths.dir, 'logs');
    return Object.fromEntries(
      readdirSync(dir)
        .sort()
        .map((name) => [name, readFileSync(join(dir, name), 'utf8')]),
    );
  }

  function rows(): string[] {
    return (term.frames.at(-1)?.lines ?? []).map((line) => line.trimEnd());
  }

  /** The read has answered and `check` holds. */
  async function shown(check: () => void): Promise<void> {
    await vi.waitFor(() => {
      expect(screen()).not.toContain(READING);
      check();
    });
  }

  it('the Logs row shows the log folder as `mm logs` reads it, this run included, and writes nothing', async () => {
    // Three days ago a `mm doctor` that finished; minutes ago a `mm stats` that never did, and
    // the start of this run - which has no finish yet either.
    seed('dddddddddddddddd', 3 * DAY, commandStart('doctor', [], RT));
    seed('dddddddddddddddd', 3 * DAY - 1000, commandFinish('doctor', 0, 1000));
    seed('eeeeeeeeeeeeeeee', 2 * MINUTE, commandStart('stats', [], RT));
    seed(CTX.run, MINUTE, commandStart('app', [], RT));
    const before = logFiles();
    expect(Object.keys(before).length).toBeGreaterThan(0);
    server.session = { email: USER_EMAIL, userId: USER_ID };
    await app([], async () => {
      await onScreen('signed in');
      await press(ENTER);
      await onScreen(MAILBOX_EMAIL);
      await press(DOWN, DOWN, ENTER);
      await onScreen('Mail Manager - Logs');
      // The last 24 hours: this run's own line, the other run with its marker - and no marker
      // for this run, which is the one still running.
      await shown(() => {
        expect(screen()).toContain('started');
      });
      expect(rows()[0]).toMatch(/^Mail Manager - Logs +24 h$/);
      expect(rows().filter((l) => /^\d\d:\d\d:\d\d {2}app {11}started$/.test(l))).toHaveLength(1);
      expect(rows().filter((l) => /^\d\d:\d\d:\d\d {2}stats {9}started$/.test(l))).toHaveLength(1);
      const markers = rows().filter((l) => l.endsWith('interrupted or still running'));
      expect(markers).toHaveLength(1);
      expect(markers[0]).toMatch(/^\d\d:\d\d:\d\d {2}stats {9}interrupted or still running$/);
      expect(screen()).not.toContain('doctor');
      // 7 days: the older run too.
      await press(ch('2'));
      await shown(() => {
        expect(screen()).toContain('doctor');
      });
      expect(rows()[0]).toMatch(/^Mail Manager - Logs +7 days$/);
      expect(rows().filter((l) => /doctor {8}(started|finished in 1\.0 s)$/.test(l))).toHaveLength(
        2,
      );
      expect(rows().filter((l) => / {2}app {11}started$/.test(l))).toHaveLength(1);
      // Warnings and errors only: of these lines only the marker of the interrupted run is one.
      await press(ch('w'));
      await shown(() => {
        expect(screen()).not.toContain('started');
      });
      expect(rows().filter((l) => l.endsWith('interrupted or still running'))).toHaveLength(1);
      // Security events only on top of that: there are none.
      await press(ch('s'));
      await shown(() => {
        expect(screen()).toContain('No matching log lines in the last 7 days.');
      });
      expect(rows()[0]).toMatch(/^Mail Manager - Logs +7 days - security - warnings$/);
      await press(ch('q'));
    });
    // Nothing was logged for looking, and the folder is as it was.
    expect(names()).toEqual(['command.start', 'command.finish']);
    expect(logFiles()).toEqual(before);
    expect(out.all).toBe('');
    expect(exitCode()).toBe(0);
  });

  it('no log folder yet: the screen says there are no lines', async () => {
    server.session = { email: USER_EMAIL, userId: USER_ID };
    await app([], async () => {
      await onScreen('signed in');
      await press(ENTER);
      await onScreen(MAILBOX_EMAIL);
      await press(DOWN, DOWN, ENTER);
      await onScreen('No log lines in the last 24 h.');
      await press(k('escape', { meta: true, sequence: '\u001b' }));
      await onScreen(MAILBOX_EMAIL);
      await press(ch('q'));
    });
    expect(existsSync(join(paths.dir, 'logs'))).toBe(false);
    expect(names()).toEqual(['command.start', 'command.finish']);
    expect(exitCode()).toBe(0);
  });
});

describe('adding a mailbox (M2d-4)', () => {
  const ADD_EMAIL = 'new.canary@example-test-domain.eu';
  const ADD_HOST = 'imap.canary-add.example-test-domain.eu';
  const UP = k('up', { sequence: '\u001b[A' });
  const ESC = k('escape', { meta: true, sequence: '\u001b' });
  const FIELD = 'E-mail of the mailbox:';

  /** The screen as one line of words: wrapped text reads as it was written. */
  function words(): string {
    return screen().replace(/\s+/g, ' ');
  }

  /** Signed in, Home, Enter on "+ Add a mailbox". */
  async function openAdd(): Promise<void> {
    await onScreen('signed in');
    await press(ENTER);
    await onScreen(MAILBOX_EMAIL);
    await press(DOWN, ENTER);
  }

  it('without MM_MASTER_KEY the app still opens, and the add screen says why no mailbox can be added', async () => {
    delete process.env['MM_MASTER_KEY'];
    server.session = { email: USER_EMAIL, userId: USER_ID };
    await app([], async () => {
      await openAdd();
      await onScreen('MM_MASTER_KEY');
      expect(words()).toContain('MM_MASTER_KEY is not set - run `mm keygen`');
      expect(screen()).not.toContain(FIELD);
      // Nothing is asked, whatever is pressed.
      await typeText('a@b.eu');
      await press(ENTER, ch('y'), ch('c'), ch('m'));
      expect(screen()).toContain('MM_MASTER_KEY');
      expect(screen()).not.toContain(FIELD);
      await press(ESC);
      await onScreen(MAILBOX_EMAIL);
      await press(ch('q'));
    });
    expect(discover).not.toHaveBeenCalled();
    expect(imapOpen).not.toHaveBeenCalled();
    expect(addDeps).toHaveLength(0);
    expect(server.added).toEqual([]);
    expect(names()).toEqual(['command.start', 'command.finish']);
    expect(out.all).toBe('');
    expect(exitCode()).toBe(0);
  });

  it('an address and server that are saved already: the core says so before any password is asked', async () => {
    server.session = { email: USER_EMAIL, userId: USER_ID };
    const saved = mailbox();
    discover.mockImplementation((address) =>
      Promise.resolve({
        email: parseEmail(address),
        notices: [],
        tried: [],
        status: 'found',
        source: 'ispdb',
        via: 'canary-host.example-test-domain.eu',
        imap: { host: saved.host, port: 993, username: saved.email },
        altHosts: [],
      }),
    );
    await app([], async () => {
      await openAdd();
      await onScreen(FIELD);
      await typeText(saved.email);
      await press(ENTER);
      await onScreen('Found via:');
      await press(ENTER);
      await onScreen('This mailbox is already saved (id 3f2a91c0).');
      expect(screen()).not.toContain('Password:');
      await press(ESC);
      await onScreen('Log out');
      await press(ch('q'));
    });
    expect(imapOpen).not.toHaveBeenCalled();
    expect(addDeps).toHaveLength(0);
    expect(server.added).toEqual([]);
    // Logged and audited by the core, as the same refusal of `mm account add` is.
    expect(names()).toEqual(['command.start', 'account.add', 'command.finish']);
    expect(events('account.add')).toEqual([
      expect.objectContaining({ outcome: 'failed', reason: 'duplicate', provider: 'custom' }),
    ]);
    expect(server.audits).toEqual([
      expect.objectContaining({
        action: 'account.add',
        result: 'failed',
        reason: 'duplicate',
        runId: CTX.run,
      }),
    ]);
    expectNothingPrivateLogged();
    expect(exitCode()).toBe(0);
  });

  it("a wrong password, then the right one: the core tests the login through the run's one guard, saves, and Home shows it", async () => {
    server.session = { email: USER_EMAIL, userId: USER_ID };
    discover.mockImplementation((address) =>
      Promise.resolve({
        email: parseEmail(address),
        notices: [],
        tried: [],
        status: 'found',
        source: 'ispdb',
        via: 'canary-add.example-test-domain.eu',
        imap: { host: ADD_HOST, port: 993, username: ADD_EMAIL },
        altHosts: [],
      }),
    );
    const logout = vi.fn<() => Promise<void>>(() => Promise.resolve());
    imapOpen
      .mockRejectedValueOnce(new ImapSessionError('auth-failed'))
      .mockResolvedValueOnce({ capabilities: {}, features: {}, logout });
    // The mailbox that was there before is opened afterwards: its login gets the same guard.
    openAccountSession.mockRejectedValue(new ImapSessionError('timeout'));
    await app([], async () => {
      await openAdd();
      await onScreen(FIELD);
      await typeText(` ${ADD_EMAIL} `);
      await press(ENTER);
      await onScreen('Found via:');
      expect(words()).toContain(`Server: ${ADD_HOST}:993 (TLS)`);
      await press(ENTER);
      await onScreen(NOTHING_SHOWN);
      await typeText(WRONG_PASSWORD);
      await press(ENTER);
      await vi.waitFor(() => {
        expect(imapOpen).toHaveBeenCalledTimes(1);
        expect(words()).toContain('app password');
        expect(screen()).toContain(NOTHING_SHOWN);
      });
      expect(server.added).toEqual([]);
      await typeText(PASSWORD);
      await press(ENTER);
      await onScreen(`Added ${ADD_EMAIL}.`);
      await onScreen('2 mailboxes');
      // The cursor is on the new mailbox; the one above it is opened.
      const frame = term.frames.at(-1);
      expect(frame?.lines[frame.cursorLine ?? 0]).toContain(ADD_EMAIL);
      await press(UP, ENTER);
      await onScreen('r try again');
      await press(ch('q'));
    });

    // The lookup: the typed address without its spaces, 5 seconds per source, with progress.
    expect(discover).toHaveBeenCalledTimes(1);
    expect(discover.mock.calls[0]?.[0]).toBe(ADD_EMAIL);
    expect(discover.mock.calls[0]?.[1]).toMatchObject({ timeoutMs: 5000 });
    expect(typeof discover.mock.calls[0]?.[1]?.['onProgress']).toBe('function');

    // The two logins of the add went to the server that was found, with what was typed.
    expect(imapOpen.mock.calls.map(([o]) => [o['settings'], o['password']])).toEqual([
      [{ host: ADD_HOST, port: 993, username: ADD_EMAIL }, WRONG_PASSWORD],
      [{ host: ADD_HOST, port: 993, username: ADD_EMAIL }, PASSWORD],
    ]);
    expect(logout).toHaveBeenCalledTimes(1);

    // One guard for the whole run: both adds, and the login of the saved mailbox.
    expect(addDeps).toHaveLength(2);
    expect(openAccountSession).toHaveBeenCalledTimes(1);
    const guard = openAccountSession.mock.calls[0]?.[0]?.['guard'];
    expect(guard).toBeDefined();
    expect(addDeps[0]?.['guard']).toBe(guard);
    expect(addDeps[1]?.['guard']).toBe(guard);

    // Saved once, encrypted: the row holds the server and the address, never the password.
    expect(server.added).toHaveLength(1);
    expect(server.added[0]).toMatchObject({
      userId: USER_ID,
      email: ADD_EMAIL,
      provider: 'custom',
      host: ADD_HOST,
      port: 993,
      username: ADD_EMAIL,
      authType: 'password',
    });
    expect(JSON.stringify(server.added)).not.toContain(PASSWORD);
    expect(server.added[0]?.secret.ciphertext).not.toBe('CANARY-CIPHERTEXT');

    // The log: what `mm account add` writes - and no `discover.finish`.
    expect(names()).toEqual([
      'command.start',
      'imap.login-failed',
      'account.add',
      'imap.login',
      'account.add',
      'folders.list',
      'command.finish',
    ]);
    expect(events('account.add')).toEqual([
      expect.objectContaining({ outcome: 'failed', reason: 'auth-failed', provider: 'custom' }),
      expect.objectContaining({ outcome: 'ok', provider: 'custom', acct: server.added[0]?.id }),
    ]);
    expect(server.audits).toEqual([
      expect.objectContaining({ action: 'account.add', result: 'failed', reason: 'auth-failed' }),
      expect.objectContaining({
        action: 'account.add',
        result: 'ok',
        accountId: server.added[0]?.id,
        runId: CTX.run,
      }),
    ]);
    expect(JSON.stringify(server.audits)).not.toContain('example-test-domain');
    expectNothingPrivateLogged();
    for (const frame of term.frames) {
      const text = frame.lines.join('\n');
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain(WRONG_PASSWORD);
    }
    expect(out.all).toBe('');
    expect(exitCode()).toBe(0);
  });
});
