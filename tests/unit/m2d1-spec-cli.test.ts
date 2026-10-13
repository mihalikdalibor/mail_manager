import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import type { Rendered } from '../../src/cli/browser/render.js';
import type { Keypress } from '../../src/cli/browser/state.js';
import type { Terminal, TerminalOptions } from '../../src/cli/browser/terminal.js';
import type { ProcLike } from '../../src/cli/run.js';
import { AuthError } from '../../src/core/auth.js';
import type { AuthUser, LogoutResult } from '../../src/core/auth.js';
import { ConfigError } from '../../src/core/config.js';
import type { AccountsRepo, AuditRepo, MailAccount } from '../../src/core/db/repos.js';
import type { RunContext } from '../../src/core/log/index.js';

// M2d-1 entry (spec AC1-AC4, AC21, AC25, AC26): plain `mm` in a terminal opens the app, `mm app`
// needs a terminal, config errors stop before the screen, --help names the app. Supabase, env files,
// the config dir and the terminal module are mocked; runCli, buildProgram, the app controller,
// reducer and renderer are real. A fake Terminal records the frames and feeds the keys.

const NO_TERMINAL =
  'mm app needs a terminal \u2014 run it in a terminal window, or use the commands in `mm --help`.';
const MASTER = Buffer.alloc(32, 7);
const RUN = '0123456789abcdef';
const T0 = Date.UTC(2026, 9, 1, 9, 0, 0);
const ALICE: AuthUser = {
  email: 'alice@example.com',
  userId: '11111111-1111-4111-8111-111111111111',
};
const NOTHING_SHOWN = '(nothing is shown while you type)';

const { currentUser, login, logout, createSupabaseServices, loadEnvFiles, openTerminal, paths } =
  vi.hoisted(() => ({
    currentUser: vi.fn<() => Promise<{ email: string; userId: string } | null>>(),
    login: vi.fn<(email: string, password: string) => Promise<{ email: string; userId: string }>>(),
    logout: vi.fn<() => Promise<LogoutResult>>(),
    createSupabaseServices: vi.fn<(...args: unknown[]) => unknown>(),
    loadEnvFiles: vi.fn(),
    openTerminal: vi.fn<(options?: TerminalOptions) => Terminal>(),
    paths: { dir: '' },
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
    clear(): void {}
    isEmpty(): boolean {
      return true;
    }
  },
}));
vi.mock('../../src/core/paths.js', () => ({
  configDir: vi.fn(() => paths.dir),
  logDir: vi.fn(() => join(paths.dir, 'logs')),
}));
vi.mock('../../src/cli/browser/terminal.js', () => ({ openTerminal }));

const { buildProgram } = await import('../../src/cli/index.js');
const { DEFAULT_COMMAND, runCli, withDefaultCommand } = await import('../../src/cli/run.js');
const { MemoryEventLog } = await import('../../src/core/log/index.js');
type Log = InstanceType<typeof MemoryEventLog>;

// ---- fakes ----

function fakeRepo(rows: MailAccount[]): AccountsRepo {
  return {
    create: vi.fn(() => Promise.reject(new Error('not used'))),
    list: vi.fn(() => Promise.resolve(rows)),
    get: vi.fn(() => Promise.resolve(null)),
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

type Handler = (arg?: unknown) => void;

/** Like `process`, but exit() runs the 'exit' handlers and then returns. */
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
    const final = code ?? (typeof current === 'number' ? current : 0);
    for (const h of this.handlers.get('exit') ?? []) h(final);
    return undefined as never;
  }
}

// ---- harness ----

let out = { stdout: '', stderr: '', all: '' };
let log: Log;
let term: FakeTerminal;
let configRoot: string;
let atClose: { stdout: string; stderr: string; all: string } | null;
let pending: Promise<void> | null;
const originalErrIsTTY = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
const originalInIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
const originalOutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
const originalMasterKey = process.env['MM_MASTER_KEY'];
const originalTerm = process.env['TERM'];

const ctx: RunContext = { run: RUN, ver: '0.9.0', now: () => T0, level: 'debug' };

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
  configRoot = mkdtempSync(join(tmpdir(), 'mm-m2d1-cli-'));
  paths.dir = join(configRoot, 'config');
  process.exitCode = undefined;
  process.env['MM_MASTER_KEY'] = MASTER.toString('base64');
  process.env['TERM'] = 'xterm';
  log = new MemoryEventLog(ctx);
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
  currentUser.mockResolvedValue(ALICE);
  login.mockResolvedValue(ALICE);
  logout.mockResolvedValue('logged-out');
  createSupabaseServices.mockImplementation(() => ({
    auth: { currentUser, login, logout },
    accounts: fakeRepo([]),
    audit,
  }));
  term = fakeTerminal();
  term.closeSpy.mockImplementation(() => {
    atClose = { ...out };
  });
  openTerminal.mockImplementation(() => term);
  ttys(true, true);
  setTTY(process.stderr, false);
});

afterEach(async () => {
  // A test that failed half-way must not leave the app running.
  if (term.registered()) term.key(CTRL_C);
  await pending?.catch(() => undefined);
  vi.restoreAllMocks();
  for (const fn of [
    currentUser,
    login,
    logout,
    createSupabaseServices,
    loadEnvFiles,
    openTerminal,
  ]) {
    fn.mockReset();
  }
  process.exitCode = undefined;
  rmSync(configRoot, { recursive: true, force: true });
  if (originalMasterKey === undefined) delete process.env['MM_MASTER_KEY'];
  else process.env['MM_MASTER_KEY'] = originalMasterKey;
  if (originalTerm === undefined) delete process.env['TERM'];
  else process.env['TERM'] = originalTerm;
  restoreTTY(process.stderr, originalErrIsTTY);
  restoreTTY(process.stdin, originalInIsTTY);
  restoreTTY(process.stdout, originalOutIsTTY);
});

const k = (name: string, extra: Keypress = {}): Keypress => ({ name, sequence: name, ...extra });
const ENTER = k('return', { sequence: '\r' });
const DOWN = k('down', { sequence: '\x1b[B' });
const CTRL_C = k('c', { ctrl: true, sequence: '\x03' });

function charKey(c: string): Keypress {
  if (c === ' ') return { name: 'space', sequence: ' ' };
  return /^[a-z]$/.test(c) ? { name: c, sequence: c } : { sequence: c };
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function stillRunning(p: Promise<unknown>): Promise<boolean> {
  return Promise.race([p.then(() => false), settle().then(() => true)]);
}

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
    await settle();
  }
}

async function typeText(value: string): Promise<void> {
  await press(...[...value].map(charKey));
}

function exitCode(): number {
  return typeof process.exitCode === 'number' ? process.exitCode : 0;
}

function events(name: string): Record<string, unknown>[] {
  return log.records.filter((r) => r.event === name);
}

function names(): string[] {
  return log.records.map((r) => r.event);
}

interface RunOptions {
  interactive?: boolean;
  proc?: FakeProc;
}

/** One `mm ...args` through runCli; resolves when runCli is done. */
function startRun(argv: string[], options: RunOptions = {}): Promise<void> {
  pending = runCli({
    argv: ['node', 'mm', ...argv],
    build: (o) => buildProgram({ ...o, exitOverride: true }),
    log,
    ctx,
    proc: options.proc ?? new FakeProc(),
    flush: () => Promise.resolve(),
    ...(options.interactive !== undefined && { interactive: options.interactive }),
  });
  return pending;
}

async function appUp(
  argv: string[] = [],
  options: RunOptions = { interactive: true },
): Promise<void> {
  void startRun(argv, options);
  await vi.waitFor(() => {
    expect(term.registered()).toBe(true);
  });
}

// ---- tests ----

describe('DEFAULT_COMMAND / withDefaultCommand', () => {
  it('the default command is "app"', () => {
    expect(DEFAULT_COMMAND).toBe('app');
  });

  it('interactive and nothing after the program name: "app" is appended', () => {
    expect(withDefaultCommand(['node', 'mm'], true)).toEqual(['node', 'mm', 'app']);
  });

  it('not interactive: the argv is untouched', () => {
    expect(withDefaultCommand(['node', 'mm'], false)).toEqual(['node', 'mm']);
  });

  it.each([
    [['node', 'mm', 'nosuchcmd']],
    [['node', 'mm', '--help']],
    [['node', 'mm', '-h']],
    [['node', 'mm', '--version']],
    [['node', 'mm', '-V']],
    [['node', 'mm', 'folders']],
    [['node', 'mm', 'account', 'list']],
    [['node', 'mm', 'login', '--email', 'a@example.com']],
    [['node', 'mm', 'app']],
  ])('arguments given (%j): never changed, interactive or not', (argv) => {
    expect(withDefaultCommand(argv, true)).toEqual(argv);
    expect(withDefaultCommand(argv, false)).toEqual(argv);
  });

  it('the input array is not modified', () => {
    const argv = ['node', 'mm'];
    withDefaultCommand(argv, true);
    expect(argv).toEqual(['node', 'mm']);
  });
});

describe('AC1 plain `mm` through runCli', () => {
  it('interactive and no arguments: the app opens (command "app"), q ends it with exit 0', async () => {
    await appUp([]);
    await onScreen('Checking your sign-in...');
    await onScreen('Sign in as another user');
    expect(openTerminal).toHaveBeenCalledTimes(1);
    await press(k('q'));
    await pending;
    expect(exitCode()).toBe(0);
    expect(term.closeSpy).toHaveBeenCalledTimes(1);
    expect(names()).toEqual(['command.start', 'command.finish']);
    expect(events('command.start')[0]).toMatchObject({ cmd: 'app' });
    expect(events('command.finish')[0]).toMatchObject({ cmd: 'app', outcome: 'ok', exit: 0 });
  });

  it.each<[string, boolean | undefined]>([
    ['interactive false', false],
    ['interactive missing', undefined],
  ])(
    '%s and no arguments: the help, exit 1, no log line, no terminal, no service',
    async (_name, interactive) => {
      await startRun([], interactive === undefined ? {} : { interactive });
      expect(out.all).toContain('Usage');
      expect(out.all).toContain('Getting started:');
      expect(exitCode()).toBe(1);
      expect(log.records).toEqual([]);
      expect(openTerminal).not.toHaveBeenCalled();
      expect(createSupabaseServices).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['an unknown command', ['nosuchcmd']],
    ['--help', ['--help']],
    ['--version', ['--version']],
  ])('%s with interactive: true: no app, no terminal, no log line', async (_name, argv) => {
    await startRun(argv, { interactive: true });
    expect(openTerminal).not.toHaveBeenCalled();
    expect(createSupabaseServices).not.toHaveBeenCalled();
    expect(log.records).toEqual([]);
  });

  it('an unknown command with interactive: true still fails with exit 1', async () => {
    await startRun(['nosuchcmd'], { interactive: true });
    expect(exitCode()).toBe(1);
  });

  it('another command with interactive: true runs as itself, not the app', async () => {
    await startRun(['whoami'], { interactive: true });
    expect(openTerminal).not.toHaveBeenCalled();
    expect(events('command.start')[0]).toMatchObject({ cmd: 'whoami' });
    expect(out.stdout).toContain(ALICE.email);
  });

  it('`mm app` runs the app whatever `interactive` says', async () => {
    await appUp(['app'], {});
    await onScreen('Sign in as another user');
    await press(k('q'));
    await pending;
    expect(events('command.start')[0]).toMatchObject({ cmd: 'app' });
    expect(exitCode()).toBe(0);
  });
});

describe('AC2 `mm app` without a terminal', () => {
  it.each<[string, boolean, boolean, string | undefined]>([
    ['stdin not a terminal', false, true, undefined],
    ['stdout not a terminal', true, false, undefined],
    ['neither a terminal', false, false, undefined],
    ['TERM=dumb', true, true, 'dumb'],
  ])(
    '%s: the message on stderr, exit 1, nothing opened',
    async (_name, stdin, stdout, termValue) => {
      ttys(stdin, stdout);
      if (termValue !== undefined) process.env['TERM'] = termValue;
      await startRun(['app'], { interactive: false });
      expect(out.stderr).toContain(NO_TERMINAL);
      expect(out.stdout).not.toContain('needs a terminal');
      expect(exitCode()).toBe(1);
      expect(openTerminal).not.toHaveBeenCalled();
      expect(createSupabaseServices).not.toHaveBeenCalled();
    },
  );

  it('command.start and command.finish (cmd app, failed) are logged', async () => {
    ttys(false, false);
    await startRun(['app']);
    expect(names()).toEqual(['command.start', 'command.finish']);
    expect(events('command.start')[0]).toMatchObject({ cmd: 'app' });
    expect(events('command.finish')[0]).toMatchObject({ cmd: 'app', outcome: 'failed', exit: 1 });
  });
});

describe('AC3 a config error', () => {
  it('createSupabaseServices throwing a ConfigError: its text, exit 1, the terminal never opened', async () => {
    createSupabaseServices.mockImplementation(() => {
      throw new ConfigError([{ variable: 'SUPABASE_URL', problem: 'is missing' }]);
    });
    await startRun([], { interactive: true });
    expect(out.stderr).toContain('SUPABASE_URL');
    expect(out.stderr).toContain('is missing');
    expect(out.stderr).not.toContain('Unexpected error');
    expect(exitCode()).toBe(1);
    expect(openTerminal).not.toHaveBeenCalled();
    expect(events('command.finish')[0]).toMatchObject({ cmd: 'app', outcome: 'failed', exit: 1 });
    expect(events('error.unexpected')).toEqual([]);
  });

  it('the env files failing with a ConfigError: the same', async () => {
    loadEnvFiles.mockImplementation(() => {
      throw new ConfigError([{ variable: 'SUPABASE_URL', problem: 'is missing' }]);
    });
    await startRun(['app']);
    expect(out.stderr).toContain('SUPABASE_URL');
    expect(exitCode()).toBe(1);
    expect(openTerminal).not.toHaveBeenCalled();
  });
});

describe('AC4 mm --help', () => {
  it.each([[true], [false]])(
    'lists `app`, says plain `mm` opens it, keeps "Getting started:" (interactive %s)',
    async (interactive) => {
      await startRun(['--help'], { interactive });
      expect(out.all).toMatch(/^\s+app\b/m);
      expect(out.all).toMatch(/\bmm\b[^\n]*\bopens?\b|\bopens?\b[^\n]*\bmm\b/i);
      expect(out.all).toContain('Getting started:');
      expect(out.all).toContain('mm login');
    },
  );
});

describe('AC21 Ctrl+C and AC25 errors through runCli', () => {
  it('Ctrl+C: the screen is closed, exit 130, command.finish interrupted', async () => {
    await appUp();
    await onScreen('Sign in as another user');
    await press(CTRL_C);
    await pending;
    expect(term.closeSpy).toHaveBeenCalledTimes(1);
    expect(exitCode()).toBe(130);
    expect(events('command.finish')).toEqual([
      expect.objectContaining({ cmd: 'app', exit: 130, outcome: 'interrupted' }),
    ]);
  });

  it('Ctrl+C while the session is checked', async () => {
    currentUser.mockReturnValue(new Promise<AuthUser | null>(() => undefined));
    await appUp();
    await onScreen('Checking your sign-in...');
    await press(CTRL_C);
    await pending;
    expect(exitCode()).toBe(130);
    expect(term.closeSpy).toHaveBeenCalledTimes(1);
  });

  it('Ctrl+C during a sign-out: the process end waits for the sign-out, then the event is written', async () => {
    let finishLogout!: (r: LogoutResult) => void;
    logout.mockReturnValue(
      new Promise<LogoutResult>((resolve) => {
        finishLogout = resolve;
      }),
    );
    await appUp();
    await onScreen('Sign in as another user');
    await press(ENTER);
    await onScreen('+ Add a mailbox');
    await press(DOWN, DOWN, ENTER);
    await onScreen('Signing out...');
    await press(CTRL_C);
    expect(logout).toHaveBeenCalledTimes(1);
    // The screen is restored at once, but the command is not finished until the sign-out is.
    expect(term.closeSpy).toHaveBeenCalledTimes(1);
    if (pending === null) throw new Error('not started');
    expect(await stillRunning(pending)).toBe(true);
    expect(events('auth.logout')).toEqual([]);
    finishLogout('logged-out');
    await pending;
    expect(events('auth.logout')).toEqual([expect.objectContaining({ outcome: 'logged-out' })]);
    expect(names().indexOf('auth.logout')).toBeLessThan(names().indexOf('command.finish'));
    expect(exitCode()).toBe(130);
    expect(events('command.finish')[0]).toMatchObject({ outcome: 'interrupted' });
  });

  it('an error in the app loop: the screen is restored first, then "Unexpected error", exit 1, error.unexpected', async () => {
    term.failDraw = new Error('terminal gone');
    await startRun([], { interactive: true });
    expect(term.closeSpy).toHaveBeenCalledTimes(1);
    expect(atClose?.stderr).not.toContain('Unexpected error');
    expect(out.stderr).toContain('Unexpected error');
    expect(out.stderr).not.toContain('terminal gone');
    expect(exitCode()).toBe(1);
    expect(events('error.unexpected')).toHaveLength(1);
    expect(events('command.finish')[0]).toMatchObject({ outcome: 'failed', exit: 1 });
  });

  it('openTerminal throwing: "Unexpected error", exit 1, no raw text', async () => {
    openTerminal.mockImplementation(() => {
      throw new Error('raw mode refused');
    });
    await startRun([], { interactive: true });
    expect(out.stderr).toContain('Unexpected error');
    expect(out.stderr).not.toContain('raw mode refused');
    expect(exitCode()).toBe(1);
    expect(events('error.unexpected')).toHaveLength(1);
  });
});

describe('AC26 nothing private in the log through runCli', () => {
  const TYPED_EMAIL = 'typed.canary@example-test-domain.eu';
  const REAL_EMAIL = 'real.canary@example-test-domain.eu';
  const PW_1 = 'PwCanary-One-48151';
  const PW_2 = 'PwCanary-Two-62342';

  it('a failed and a successful sign-in, a log out and a quit: only the auth events between start and finish', async () => {
    currentUser.mockResolvedValue(null);
    login.mockRejectedValueOnce(new AuthError('invalid_credentials', 'bad'));
    login.mockResolvedValue({ email: REAL_EMAIL, userId: ALICE.userId });
    await appUp();
    // Nobody signed in, nothing remembered: the form opens directly.
    await onScreen(NOTHING_SHOWN);
    await typeText(TYPED_EMAIL);
    await press(ENTER);
    await typeText(PW_1);
    await press(ENTER);
    await onScreen('Wrong e-mail or password - try again.');
    await typeText(PW_2);
    await press(ENTER);
    await onScreen(`Mail Manager - ${REAL_EMAIL}`);
    await onScreen('No mailboxes yet');
    expect(login).toHaveBeenNthCalledWith(1, TYPED_EMAIL, PW_1);
    expect(login).toHaveBeenNthCalledWith(2, TYPED_EMAIL, PW_2);
    await press(DOWN, DOWN, ENTER);
    await onScreen('Sign in as another user');
    await press(k('q'));
    await pending;

    expect(names()).toEqual([
      'command.start',
      'auth.login-failed',
      'auth.login',
      'auth.logout',
      'command.finish',
    ]);
    expect(events('auth.login-failed')[0]).toMatchObject({ reason: 'invalid-credentials' });
    expect(events('auth.login')[0]).toMatchObject({ user: ALICE.userId });
    const all = JSON.stringify(log.records) + log.lines.join('\n');
    for (const needle of [
      TYPED_EMAIL,
      'typed.canary',
      REAL_EMAIL,
      'real.canary',
      'example-test-domain',
      PW_1,
      PW_2,
      'PwCanary',
    ]) {
      expect(all).not.toContain(needle);
    }
    // Nor on the terminal after the screen was restored.
    expect(out.all).not.toContain('PwCanary');
    expect(exitCode()).toBe(0);
  });
});
