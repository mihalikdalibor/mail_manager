import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { domainToASCII, fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { accountErrorText } from '../../src/cli/account-text.js';
import { offDomainWarning } from '../../src/cli/discovery-text.js';
import { buildProgram } from '../../src/cli/index.js';
import type { BuildOptions } from '../../src/cli/index.js';
import { formatReport, reportFooters } from '../../src/cli/log-text.js';
import type { ReportOptions } from '../../src/cli/log-text.js';
import { runCli } from '../../src/cli/run.js';
import type { ProcLike } from '../../src/cli/run.js';
import {
  AccountError,
  addAccount,
  assertSecretReadable,
  createLocalGuard,
  removeAccount,
  updatePassword,
} from '../../src/core/accounts.js';
import type { AccountDeps, StoreDeps } from '../../src/core/accounts.js';
import { auditEntrySchema, isValidAuditEntry } from '../../src/core/audit.js';
import { LocalCredentialProvider } from '../../src/core/credentials.js';
import type { AccountsRepo, AuditEntry, AuditRepo, MailAccount } from '../../src/core/db/repos.js';
import { buildServerFeatures, sanitizeCapabilities } from '../../src/core/imap/features.js';
import type { ImapSession, OpenSessionOptions } from '../../src/core/imap/session.js';
import {
  FileEventLog,
  MemoryEventLog,
  authLogout,
  commandStart,
  parseLogLine,
  readLogs,
  renderEvent,
  toRecord,
} from '../../src/core/log/index.js';
import type {
  EventLog,
  LogEvent,
  LogRecord,
  ReadResult,
  RunContext,
} from '../../src/core/log/index.js';
import { ISPDB_URL, discover } from '../../src/core/providers/discover.js';
import type { DiscoveryDeps, DiscoveryResult } from '../../src/core/providers/discover.js';
import { DiscoveryInputError, parseEmail } from '../../src/core/providers/email.js';
import { PRESETS } from '../../src/core/providers/presets.js';
import type { ImapSettings } from '../../src/core/providers/settings.js';

// M1c-2 hardening, pinned from the spec only (not from the implementation): stream errors on
// exit, `mm login` with a local session, the log reader/text/writer follow-ups, the SRV
// off-domain flag, address length, secret-readable check, audit details and privacy.

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CTX: RunContext = {
  run: 'abcdef0123456789',
  ver: '0.7.0',
  now: () => Date.UTC(2026, 9, 1, 10, 0, 0),
  level: 'debug',
};

function chunkToString(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString('utf8');
  return String(chunk);
}

/** Control, bidi or invisible characters that must never reach the terminal. */
function hasUnsafe(text: string): boolean {
  return [...text].some((ch) => {
    const c = ch.codePointAt(0) ?? 0;
    return (
      c <= 0x1f ||
      (c >= 0x7f && c <= 0x9f) ||
      (c >= 0x200b && c <= 0x200f) ||
      (c >= 0x202a && c <= 0x202e) ||
      (c >= 0x2060 && c <= 0x2069)
    );
  });
}

// ---------------------------------------------------------------------------------------------
// Mocks for the `mm login` section: real session file, fake Supabase services and prompts.
// ---------------------------------------------------------------------------------------------

const { fakeAuth, createSupabaseServices, loadEnvFiles, input, password } = vi.hoisted(() => ({
  fakeAuth: {
    login: vi.fn<(email: string, password: string) => Promise<{ email: string; userId: string }>>(),
    logout: vi.fn<() => Promise<unknown>>(),
    currentUser: vi.fn<() => Promise<{ email: string; userId: string } | null>>(),
  },
  createSupabaseServices: vi.fn<(...args: unknown[]) => unknown>(),
  loadEnvFiles: vi.fn(),
  input: vi.fn<(...args: unknown[]) => Promise<string>>(),
  password: vi.fn<(...args: unknown[]) => Promise<string>>(),
}));

vi.mock('../../src/core/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/config.js')>();
  return { ...actual, loadEnvFiles };
});
vi.mock('../../src/core/db/supabase/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/db/supabase/index.js')>();
  return { ...actual, createSupabaseServices };
});
vi.mock('@inquirer/prompts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@inquirer/prompts')>();
  return { ...actual, input, password };
});

let out = { stdout: '', stderr: '' };

beforeEach(() => {
  out = { stdout: '', stderr: '' };
  process.exitCode = undefined;
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
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`real process.exit(${String(code)}) called`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  fakeAuth.login.mockReset();
  createSupabaseServices.mockReset();
  loadEnvFiles.mockReset();
  input.mockReset();
  password.mockReset();
});

// ---------------------------------------------------------------------------------------------
// runCli: stream errors, flush order
// ---------------------------------------------------------------------------------------------

type Handler = (arg?: unknown) => void;

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

/** The real program with the `keygen` action replaced (it has no subcommands). */
function withKeygenAction(action: () => void | Promise<void>): (o: BuildOptions) => Command {
  return (o) => {
    const program = buildProgram({ ...o, exitOverride: true });
    const keygen = program.commands.find((c) => c.name() === 'keygen');
    if (keygen === undefined) throw new Error('keygen command missing');
    keygen.action(action);
    return program;
  };
}

function streamError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`write ${code}`), { code });
}

function eventNames(log: MemoryEventLog): string[] {
  return log.records.map((r) => r.event);
}

describe('runCli: output stream errors', () => {
  async function runWith(
    act: (streams: EventEmitter[]) => void,
    flush: () => Promise<void> = () => Promise.resolve(),
    log = new MemoryEventLog(CTX),
  ) {
    const streams = [new EventEmitter(), new EventEmitter()];
    const proc = new FakeProc();
    await runCli({
      argv: ['node', 'mm', 'keygen'],
      build: withKeygenAction(() => act(streams)),
      log,
      ctx: CTX,
      proc,
      flush,
      streams,
      root: REPO_ROOT,
    });
    return { streams, log, proc };
  }

  it('EPIPE then more EPIPE/destroyed errors: ignored, nothing printed, exit code as set', async () => {
    const { log, proc } = await runWith(([a, b]) => {
      process.exitCode = 2;
      a?.emit('error', streamError('EPIPE'));
      a?.emit('error', streamError('EPIPE'));
      b?.emit('error', streamError('ERR_STREAM_DESTROYED'));
      b?.emit('error', streamError('EPIPE'));
    });
    expect(process.exitCode).toBe(2);
    expect(out).toEqual({ stdout: '', stderr: '' });
    expect(eventNames(log)).toEqual(['command.start', 'command.finish']);
    expect(proc.exits).toHaveLength(1);
  });

  it('EIO after EPIPE: the EIO still turns a 0 exit code into 1, quietly', async () => {
    const { log } = await runWith(([a, b]) => {
      a?.emit('error', streamError('EPIPE'));
      expect(process.exitCode).toBeUndefined();
      b?.emit('error', streamError('EIO'));
    });
    expect(process.exitCode).toBe(1);
    expect(out).toEqual({ stdout: '', stderr: '' });
    expect(eventNames(log)).not.toContain('error.unexpected');
  });

  it('EPIPE after EIO does not undo the exit code 1', async () => {
    await runWith(([a, b]) => {
      a?.emit('error', streamError('EIO'));
      b?.emit('error', streamError('EPIPE'));
    });
    expect(process.exitCode).toBe(1);
  });

  it('EIO never lowers a non-zero exit code (130 stays 130)', async () => {
    await runWith(([a]) => {
      process.exitCode = 130;
      a?.emit('error', streamError('EIO'));
    });
    expect(process.exitCode).toBe(130);
  });

  it('an EPIPE-ridden run still logs finish before flush and flushes once before exit', async () => {
    const log = new MemoryEventLog(CTX);
    const finishedAtFlush: boolean[] = [];
    const flush = vi.fn(() => {
      finishedAtFlush.push(eventNames(log).at(-1) === 'command.finish');
      return Promise.resolve();
    });
    const result = await runWith(([a]) => a?.emit('error', streamError('EPIPE')), flush, log);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(finishedAtFlush).toEqual([true]);
    expect(eventNames(result.log).filter((e) => e === 'command.finish')).toHaveLength(1);
    expect(result.proc.exits).toHaveLength(1);
  });

  it('exit waits for a slow flush', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const proc = new FakeProc();
    const log = new MemoryEventLog(CTX);
    const finishedAtFlush: boolean[] = [];
    const done = runCli({
      argv: ['node', 'mm', 'keygen'],
      build: withKeygenAction(() => undefined),
      log,
      ctx: CTX,
      proc,
      flush: async () => {
        finishedAtFlush.push(eventNames(log).includes('command.finish'));
        await gate;
      },
      streams: [new EventEmitter()],
      root: REPO_ROOT,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(finishedAtFlush).toEqual([true]);
    expect(proc.exits).toEqual([]);
    release();
    await done;
    expect(proc.exits).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// mm login with a stored local session (real FileSessionStorage on a temp config dir)
// ---------------------------------------------------------------------------------------------

describe('mm login: stored local session', () => {
  const REFUSAL = "You're already logged in — run `mm logout` first, then `mm login`.";
  const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  let dir: string;

  function setTTY(value: boolean | undefined): void {
    Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true, writable: true });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mm-m1c2-login-'));
    vi.stubEnv('MM_CONFIG_DIR', dir);
    setTTY(true);
    createSupabaseServices.mockReturnValue({ auth: fakeAuth, accounts: {} });
    password.mockResolvedValue('pw-for-login-test');
    fakeAuth.login.mockResolvedValue({ email: 'a@x.sk', userId: 'u1' });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (originalIsTTY) Object.defineProperty(process.stdin, 'isTTY', originalIsTTY);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
    rmSync(dir, { recursive: true, force: true });
  });

  function login(log?: EventLog): Promise<Command> {
    return buildProgram({ exitOverride: true, ...(log ? { log } : {}) }).parseAsync(
      ['login', '--email', 'a@x.sk'],
      { from: 'user' },
    );
  }

  it('a non-empty session file: one-line refusal, exit 1, no network, no prompt, no auth event', async () => {
    writeFileSync(
      join(dir, 'session.json'),
      JSON.stringify({ 'sb-token': '{"access_token":"x"}' }),
      { mode: 0o600 },
    );
    const log = new MemoryEventLog(CTX);
    await login(log);
    expect(out.stderr).toBe(`${REFUSAL}\n`);
    expect(out.stdout).toBe('');
    expect(process.exitCode).toBe(1);
    expect(createSupabaseServices).not.toHaveBeenCalled();
    expect(fakeAuth.login).not.toHaveBeenCalled();
    expect(input).not.toHaveBeenCalled();
    expect(password).not.toHaveBeenCalled();
    expect(log.records.filter((r) => r.event.startsWith('auth.'))).toEqual([]);
    // The session is left alone.
    expect(readFileSync(join(dir, 'session.json'), 'utf8')).toContain('access_token');
  });

  it('the session message wins over "needs an interactive terminal"', async () => {
    writeFileSync(join(dir, 'session.json'), JSON.stringify({ k: 'v' }), { mode: 0o600 });
    setTTY(undefined);
    await login();
    expect(out.stderr).toBe(`${REFUSAL}\n`);
    expect(out.stderr).not.toContain('interactive terminal');
  });

  it.each<[string, (file: string) => void]>([
    ['a missing file', () => undefined],
    ['an empty object', (file) => writeFileSync(file, '{}', { mode: 0o600 })],
    ['a corrupt file', (file) => writeFileSync(file, '{not json', { mode: 0o600 })],
  ])('%s: login proceeds as before', async (_label, prepare) => {
    prepare(join(dir, 'session.json'));
    await login();
    expect(out.stderr).not.toContain('already logged in');
    expect(fakeAuth.login).toHaveBeenCalledWith('a@x.sk', 'pw-for-login-test');
    expect(out.stdout).toContain('Logged in as a@x.sk');
    expect(process.exitCode).toBeUndefined();
  });

  it('with no session and no terminal the old message is unchanged', async () => {
    setTTY(undefined);
    await login();
    expect(out.stderr).toContain('interactive terminal');
    expect(out.stderr).not.toContain('already logged in');
    expect(process.exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// readLogs: interrupted: false
// ---------------------------------------------------------------------------------------------

describe('readLogs: interrupted option', () => {
  let root: string;
  let logDir: string;
  const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);
  const RT = { ver: '0.7.0', node: '22.13.0', os: 'linux' };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mm-m1c2-reader-'));
    logDir = join(root, 'logs');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function emitAt(run: string, at: number, event: LogEvent): void {
    new FileEventLog(logDir, { run, ver: '0.7.0', now: () => at, level: 'debug' }).emit(event);
  }

  it('false: no markers even when runs never finished; cap counts records only', async () => {
    // Two started-and-never-finished runs plus three records of a third, finished run.
    emitAt('1'.repeat(16), NOW - 50 * 60_000, commandStart('keygen', [], RT));
    emitAt('2'.repeat(16), NOW - 40 * 60_000, commandStart('doctor', [], RT));
    emitAt('3'.repeat(16), NOW - 30 * 60_000, commandStart('whoami', [], RT));
    emitAt('3'.repeat(16), NOW - 29 * 60_000, authLogout('logged-out'));
    emitAt('3'.repeat(16), NOW - 28 * 60_000, authLogout('not-logged-in'));

    const off = await readLogs(logDir, { now: NOW, maxRecords: 2, interrupted: false });
    expect(off.interrupted).toEqual([]);
    expect(off.records).toHaveLength(2);
    expect(off.records.map((r) => r.run)).toEqual(['3'.repeat(16), '3'.repeat(16)]);
    expect(off.omitted).toBe(3); // 5 records - 2 kept

    const on = await readLogs(logDir, { now: NOW, maxRecords: 2 });
    // Default (true): the markers share the cap, so fewer records fit.
    expect(on.records.length + on.interrupted.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------
// Log text
// ---------------------------------------------------------------------------------------------

describe('log text: hint, empty message, column width', () => {
  const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);
  const RUN = '0123456789abcdef';
  const RT = { ver: '0.7.0', node: '22.13.0', os: 'linux' };
  const base: ReportOptions = { now: NOW, timeZone: 'UTC' };

  function rec(event: LogEvent, at = NOW - 3_600_000, run = RUN): LogRecord {
    const rendered = renderEvent(event, { run, ver: '0.7.0', now: () => at, level: 'debug' });
    if (rendered === null) throw new Error('not rendered');
    return rendered.record;
  }

  function result(records: LogRecord[], extra: Partial<ReadResult> = {}): ReadResult {
    return {
      folder: 'ok',
      runsCapped: false,
      records,
      runs: new Map(),
      interrupted: [],
      unreadable: 0,
      unknown: 0,
      omitted: 0,
      skippedFiles: 0,
      ...extra,
    };
  }

  it.each<[Partial<ReportOptions>, string]>([
    [{}, '--since, --level, --security or --run'],
    [{ run: RUN }, '--since, --level or --security'],
    [{ securityOnly: true }, '--since, --level or --run'],
    [{ level: 'error' }, '--since, --security or --run'],
    [{ level: 'warn' }, '--since, --level, --security or --run'],
    [{ run: RUN, securityOnly: true, level: 'error' }, '--since'],
  ])('omitted hint with %j', (opts, flags) => {
    const r = result([rec(authLogout('logged-out'))], { omitted: 7 });
    expect(reportFooters(r, { ...base, ...opts })).toEqual([
      `7 older lines not shown — narrow with ${flags}`,
    ]);
  });

  it.each<[Partial<ReportOptions>, string]>([
    [{ level: 'warn' }, 'No matching log lines in the last 24 h.'],
    [{ level: 'error' }, 'No matching log lines in the last 24 h.'],
    [{ securityOnly: true }, 'No matching log lines in the last 24 h.'],
    [{ run: RUN, sinceMs: 2 * 3_600_000 }, 'No matching log lines in the last 2 h.'],
    [{ level: 'debug' }, 'No log lines in the last 24 h.'],
    [{ level: 'info' }, 'No log lines in the last 24 h.'],
    [{ sinceMs: 7 * 24 * 3_600_000 }, 'No log lines in the last 7 days.'],
    [{ run: RUN }, `No log lines for run ${RUN}.`],
  ])('empty result with %j', (opts, text) => {
    expect(formatReport(result([]), { ...base, ...opts })).toEqual([text]);
  });

  /** Where the event text starts: after "HH:MM:SS  " and the padded command column. */
  const TIME_WIDTH = 10;

  it('width follows the longest printed command: 20 chars → both lines aligned at 20', () => {
    const a = rec(commandStart('account update-pw', [], RT), NOW - 3_000_000, 'a'.repeat(16));
    const b = rec(authLogout('logged-out'), NOW - 2_000_000, 'b'.repeat(16));
    const lines = formatReport(
      result([a, b], {
        runs: new Map([
          [
            'b'.repeat(16),
            { cmd: 'logout', started: true, finished: true, lastTs: b.ts, truncatedDay: false },
          ],
        ]),
      }),
      base,
    );
    expect(lines).toHaveLength(2);
    const width = 'account update-pw'.length;
    expect(lines[0]?.indexOf('started')).toBe(TIME_WIDTH + width + 2);
    expect(lines[1]?.indexOf('Mail Manager logout')).toBe(TIME_WIDTH + width + 2);
  });

  it('a hostile 1,000-char command is sanitized, printed in full, and pads others to 32 only', () => {
    const hostile = `evil\u001b[2J‮${'x'.repeat(1000)}`;
    const bad = { ...rec(commandStart('keygen', [], RT), NOW - 3_000_000), cmd: hostile };
    const good = rec(authLogout('logged-out'), NOW - 2_000_000, 'b'.repeat(16));
    const lines = formatReport(
      result([bad, good], {
        runs: new Map([
          [
            'b'.repeat(16),
            { cmd: 'logout', started: true, finished: true, lastTs: good.ts, truncatedDay: false },
          ],
        ]),
      }),
      base,
    );
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(hasUnsafe(l)).toBe(false);
    // Longer than 32: not padded and not cut.
    expect(lines[0]).toContain(`evil[2J${'x'.repeat(1000)}  started`);
    // The other line is padded to the 32 cap, not to 1,000+.
    expect(lines[1]?.indexOf('Mail Manager logout')).toBe(TIME_WIDTH + 32 + 2);
  });
});

// ---------------------------------------------------------------------------------------------
// FileEventLog: log.truncated marker
// ---------------------------------------------------------------------------------------------

describe('FileEventLog: size-cap marker', () => {
  const MAX = 2000;
  const DAY_MS = 86_400_000;
  const LAST_MS = Date.UTC(2026, 8, 30, 23, 59, 59, 999);
  const AFTER_MIDNIGHT = Date.UTC(2026, 9, 1, 0, 0, 0, 5);
  const FAILED: LogEvent = {
    event: 'command.finish',
    cmd: 'keygen',
    outcome: 'failed',
    exit: 1,
    ms: 3,
  };
  let root: string;
  let dir: string;
  let file: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mm-m1c2-trunc-'));
    dir = join(root, 'logs');
    file = join(dir, 'app-2026-09-30.log');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function ctxAt(now: () => number): RunContext {
    return { run: RUN, ver: '0.7.0', now, level: 'debug' };
  }
  const RUN = '0123456789abcdef';

  function fileLines(): string[] {
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l !== '');
  }

  function fill(log: FileEventLog, now: () => number): void {
    for (let i = 0; i < 200 && (!existsSync(file) || fileLines().join('\n').length < MAX); i++) {
      log.appendRecord(
        'app',
        toRecord(commandStart('keygen', [], { ver: '0.7.0', node: '22', os: 'l' }), ctxAt(now)),
      );
    }
  }

  it('the marker carries the triggering record ts, not a fresh clock reading', () => {
    let clock = Date.UTC(2026, 8, 30, 10, 0, 0);
    const log = new FileEventLog(
      dir,
      ctxAt(() => clock),
      { maxFileBytes: MAX },
    );
    fill(log, () => clock);
    const triggering = toRecord(
      FAILED,
      ctxAt(() => clock),
    );
    clock += 5 * 60_000; // five minutes pass before the marker is written
    log.appendRecord('app', triggering);
    const marker = parseLogLine(fileLines().at(-1) ?? '');
    expect(marker?.record.event).toBe('log.truncated');
    expect(marker?.record.ts).toBe(triggering.ts);
  });

  it('across UTC midnight the marker stays in its own day file and the reader accepts it', async () => {
    let clock = LAST_MS;
    const log = new FileEventLog(
      dir,
      ctxAt(() => clock),
      { maxFileBytes: MAX },
    );
    fill(log, () => LAST_MS);
    const triggering = toRecord(
      FAILED,
      ctxAt(() => LAST_MS),
    );
    clock = AFTER_MIDNIGHT;
    log.appendRecord('app', triggering);

    const marker = parseLogLine(fileLines().at(-1) ?? '');
    expect(marker?.record.event).toBe('log.truncated');
    expect(marker?.record.ts.slice(0, 10)).toBe('2026-09-30'); // equals the file's date
    expect(existsSync(join(dir, 'app-2026-10-01.log'))).toBe(false);

    const read = await readLogs(dir, { now: AFTER_MIDNIGHT + 60_000, sinceMs: 2 * DAY_MS });
    expect(read.unreadable).toBe(0);
    expect(read.unknown).toBe(0);
    // The run that started in the capped file has no finish, but the cap explains it.
    expect(read.interrupted).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Discovery: SRV off-domain flag, address length, warning text
// ---------------------------------------------------------------------------------------------

type SrvRecord = { name: string; port: number; priority: number; weight: number };

function dnsError(code: string): Error {
  return Object.assign(new Error(`query ${code}`), { code });
}

function discoveryDeps(srv: SrvRecord[] | Error, routes: Record<string, () => Response> = {}) {
  const deps: DiscoveryDeps = {
    resolveMx: () => Promise.reject(dnsError('ENODATA')),
    resolveSrv: () => (srv instanceof Error ? Promise.reject(srv) : Promise.resolve(srv)),
    fetch: (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const route = routes[url];
      if (!route) return Promise.reject(new TypeError('fetch failed'));
      return Promise.resolve(route());
    },
    timeoutMs: 50,
  };
  return deps;
}

async function srvFound(host: string, email: string): Promise<DiscoveryResult> {
  const r = await discover(
    email,
    discoveryDeps([{ name: host, port: 993, priority: 0, weight: 0 }]),
  );
  expect(r.status).toBe('found');
  expect(r).toMatchObject({ source: 'srv' });
  return r;
}

function isOffDomain(r: DiscoveryResult): boolean {
  return r.status === 'found' && r.offDomain === true;
}

describe('discover: SRV off-domain flag', () => {
  const DOMAIN = 'example-test-domain.eu';
  const EMAIL = `someone@${DOMAIN}`;

  it.each([
    ['the domain itself', DOMAIN],
    ['a subdomain', `imap.${DOMAIN}`],
    ['a deeper subdomain', `a.b.${DOMAIN}`],
    ['an upper-case host', `IMAP.${DOMAIN.toUpperCase()}`],
    ['a trailing dot', `imap.${DOMAIN}.`],
    ['upper-case with a trailing dot', `MAIL.${DOMAIN.toUpperCase()}.`],
  ])('does not flag %s', async (_label, host) => {
    const r = await srvFound(host, EMAIL);
    expect(isOffDomain(r)).toBe(false);
    expect('offDomain' in r).toBe(false);
  });

  it.each([
    ['a lookalike without the label boundary', `evil${DOMAIN}`],
    ['the domain as a prefix of another', `${DOMAIN}.attacker.example`],
    ['a parent domain', 'test-domain.eu'],
    ['an unrelated host', 'imap.attacker.example'],
  ])('flags %s', async (_label, host) => {
    expect(isOffDomain(await srvFound(host, EMAIL))).toBe(true);
  });

  it('does not flag a preset IMAP host or any of its alt hosts, however they are spelled', async () => {
    const preset = PRESETS.find((p) => p.altHosts.length > 0 && p.imap !== undefined);
    if (preset?.imap == null) throw new Error('fixture preset missing');
    const hosts = [preset.imap.host, ...preset.altHosts];
    for (const host of hosts) {
      expect(isOffDomain(await srvFound(host, EMAIL))).toBe(false);
      expect(isOffDomain(await srvFound(`${host.toUpperCase()}.`, EMAIL))).toBe(false);
    }
  });

  it('compares an IDN domain in its ASCII form', async () => {
    const unicode = 'bücher-test.example';
    const ascii = domainToASCII(unicode);
    expect(ascii).not.toBe(unicode);
    const email = `someone@${unicode}`;
    expect(isOffDomain(await srvFound(`imap.${ascii}`, email))).toBe(false);
    expect(isOffDomain(await srvFound(ascii, email))).toBe(false);
    expect(isOffDomain(await srvFound(`evil${ascii}`, email))).toBe(true);
    expect(isOffDomain(await srvFound(`imap.${ascii}.attacker.example`, email))).toBe(true);
  });

  it('is never set for ISPDB, autoconfig or preset results, even for a foreign host', async () => {
    const xml = (host: string): string =>
      `<?xml version="1.0"?><clientConfig version="1.1"><emailProvider id="x"><incomingServer type="imap"><hostname>${host}</hostname><port>993</port><socketType>SSL</socketType><username>%EMAILADDRESS%</username></incomingServer></emailProvider></clientConfig>`;
    const respond = (body: string) => () =>
      new Response(body, { status: 200, headers: { 'content-type': 'text/xml' } });

    const viaIspdb = await discover(
      EMAIL,
      discoveryDeps(dnsError('ENOTFOUND'), {
        [`${ISPDB_URL}${DOMAIN}`]: respond(xml('imap.somewhere-else.example')),
      }),
    );
    expect(viaIspdb).toMatchObject({ status: 'found', source: 'ispdb' });
    expect('offDomain' in viaIspdb).toBe(false);

    const viaAutoconfig = await discover(
      EMAIL,
      discoveryDeps(dnsError('ENOTFOUND'), {
        [`https://autoconfig.${DOMAIN}/mail/config-v1.1.xml`]: respond(
          xml('imap.somewhere-else.example'),
        ),
      }),
    );
    expect(viaAutoconfig).toMatchObject({ status: 'found', source: 'autoconfig' });
    expect('offDomain' in viaAutoconfig).toBe(false);

    const viaPreset = await discover('someone@gmail.com', discoveryDeps(dnsError('ENOTFOUND')));
    expect(viaPreset.status).toBe('found');
    expect('offDomain' in viaPreset).toBe(false);
  });
});

describe('parseEmail: stored address length', () => {
  const unicode = 'münchen-büro.example';
  const ascii = domainToASCII(unicode);

  it('the punycode form is longer than what was typed (fixture sanity)', () => {
    expect(ascii.length).toBeGreaterThan(unicode.length);
  });

  it('rejects when the stored address exceeds 254 although the typed input is ≤ 254', () => {
    const local = 'a'.repeat(254 - unicode.length - 1);
    const typed = `${local}@${unicode}`;
    expect(typed).toHaveLength(254);
    expect(() => parseEmail(typed)).toThrow(DiscoveryInputError);
    expect(() => parseEmail(typed)).toThrow('Email address is too long');
  });

  it('accepts exactly 254 stored characters, rejects 255', () => {
    const exact = `${'a'.repeat(254 - ascii.length - 1)}@${unicode}`;
    const parsed = parseEmail(exact);
    expect(parsed.address).toHaveLength(254);
    expect(parsed.address.endsWith(`@${ascii}`)).toBe(true);
    const over = `${'a'.repeat(254 - ascii.length)}@${unicode}`;
    expect(() => parseEmail(over)).toThrow('Email address is too long');
  });
});

describe('offDomainWarning', () => {
  function found(host: string, extra: { offDomain?: true } = {}): DiscoveryResult {
    return {
      email: parseEmail('someone@example.eu'),
      notices: [],
      tried: [],
      status: 'found',
      source: 'srv',
      imap: { host, port: 993, username: 'someone@example.eu' },
      altHosts: [],
      ...extra,
    };
  }

  it('is the documented text for a found, off-domain result', () => {
    expect(offDomainWarning(found('imap.attacker.example', { offDomain: true }))).toBe(
      'Warning: this server is not under example.eu and comes from an unsigned DNS record, which someone on your network could fake. Only continue if you know your provider uses imap.attacker.example.',
    );
  });

  it('is undefined without the flag and for non-found results', () => {
    expect(offDomainWarning(found('imap.example.eu'))).toBeUndefined();
    const manual: DiscoveryResult = {
      email: parseEmail('someone@example.eu'),
      notices: [],
      tried: [],
      status: 'manual',
    };
    expect(offDomainWarning(manual)).toBeUndefined();
  });

  it('prints no control, bidi or invisible characters from a hostile host or domain', () => {
    const base = found('imap.evil\u001b[2J‮\u0007.example', { offDomain: true });
    if (base.status !== 'found') throw new Error('unreachable');
    const hostile: DiscoveryResult = {
      ...base,
      email: {
        ...base.email,
        domain: 'exa\u001b]0;pwn\u0007mple.eu',
        displayDomain: 'exa\u001b]0;pwn\u0007mple.eu',
      },
    };
    const text = offDomainWarning(hostile) ?? '';
    expect(text).not.toBe('');
    expect(hasUnsafe(text)).toBe(false);
    expect(text).toContain('Only continue if you know your provider uses imap.evil');
  });
});

// ---------------------------------------------------------------------------------------------
// Accounts: secret readable, audit details, privacy
// ---------------------------------------------------------------------------------------------

const T0 = Date.UTC(2026, 9, 1, 9, 0, 0);
const USER_ID = '22222222-2222-4222-8222-222222222222';
const ACCOUNT_ID = '3f2a91c0-5d4a-4b6f-9e21-7a8c0d1e2f34';
const HOST = 'imap.example-test-domain.eu';
const EMAIL = 'someone@example-test-domain.eu';
const PASSWORD = 'correct-pw-4c1a';
const NEW_PASSWORD = 'new-pw-7e2b';
const SETTINGS: ImapSettings = { host: HOST, port: 993, username: EMAIL };
const CAPS = sanitizeCapabilities({ IMAP4REV1: true, UIDPLUS: true, MOVE: true, IDLE: true });
const FEATURES = buildServerFeatures(CAPS, new Set());
const RUN_ID = '0123456789abcdef';

function newProvider(key: Buffer = randomBytes(32)): LocalCredentialProvider {
  return new LocalCredentialProvider({ masterKey: key, masterKeyVersion: 1 });
}

function accountRows(initial: MailAccount[] = []) {
  const rows = new Map<string, MailAccount>(initial.map((a) => [a.id, a]));
  const repo: AccountsRepo = {
    create: (a) => {
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
    },
    list: () => Promise.resolve([...rows.values()]),
    get: (id) => Promise.resolve(rows.get(id) ?? null),
    findByEmail: (email) =>
      Promise.resolve([...rows.values()].filter((r) => r.email === email.toLowerCase())),
    updateSecret: (id, secret) => {
      const row = rows.get(id);
      if (row === undefined) return Promise.resolve(false);
      rows.set(id, { ...row, secret });
      return Promise.resolve(true);
    },
    recordCheck: (id) => Promise.resolve(rows.has(id)),
    remove: (id) => Promise.resolve(rows.delete(id)),
  };
  return { rows, repo };
}

function auditSink() {
  const entries: AuditEntry[] = [];
  const audit: AuditRepo = {
    write: (e) => {
      entries.push(e);
      return Promise.resolve();
    },
    listRecent: () => Promise.resolve({ records: [], skipped: 0 }),
  };
  return { entries, audit };
}

function stored(credentials: LocalCredentialProvider, over: Partial<MailAccount> = {}) {
  const secret = credentials.encryptPassword(
    { userId: USER_ID, accountId: ACCOUNT_ID, host: HOST, port: 993, username: EMAIL },
    PASSWORD,
  );
  const account: MailAccount = {
    id: ACCOUNT_ID,
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
  return account;
}

function setup(credentials = newProvider(), accounts: MailAccount[] = []) {
  const log = new MemoryEventLog({ run: RUN_ID, ver: '0.7.0', now: () => T0, level: 'debug' });
  const { repo } = accountRows(accounts);
  const { entries, audit } = auditSink();
  const logout = vi.fn(() => Promise.resolve());
  const session = { capabilities: CAPS, features: FEATURES, logout } as unknown as ImapSession;
  const open = vi.fn<(o: OpenSessionOptions) => Promise<ImapSession>>(() =>
    Promise.resolve(session),
  );
  const deps: AccountDeps = {
    guard: createLocalGuard(randomBytes(32), log),
    log,
    clientVersion: '9.9.9',
    onChallenge: () => Promise.resolve(),
    open,
    repo,
    audit,
    credentials,
    runId: RUN_ID,
    now: () => T0,
    newId: () => ACCOUNT_ID,
  };
  return { deps, log, entries, open, credentials };
}

function accountEvents(log: MemoryEventLog): LogRecord[] {
  return log.records.filter((r) => r.event.startsWith('account.'));
}

function expectNoLeak(...parts: unknown[]): void {
  const text = JSON.stringify(parts);
  for (const secret of [EMAIL, 'example-test-domain', HOST, PASSWORD, NEW_PASSWORD]) {
    expect(text).not.toContain(secret);
  }
}

describe('assertSecretReadable', () => {
  it('readable secret: silent, no event, no audit row, no IMAP open', () => {
    const credentials = newProvider();
    const account = stored(credentials);
    const h = setup(credentials, [account]);
    expect(() => assertSecretReadable(h.deps, account)).not.toThrow();
    expect(h.log.records).toEqual([]);
    expect(h.entries).toEqual([]);
    expect(h.open).not.toHaveBeenCalled();
  });

  it.each<[string, (a: MailAccount) => MailAccount, () => LocalCredentialProvider | undefined]>([
    ['another host than bound', (a) => ({ ...a, host: 'imap.attacker.example' }), () => undefined],
    [
      'another username than bound',
      (a) => ({ ...a, username: 'x@example.invalid' }),
      () => undefined,
    ],
    ['another port than bound', (a) => ({ ...a, port: 143 }), () => undefined],
    ['another master key', (a) => a, () => newProvider()],
  ])(
    'unreadable (%s): failed account.password-update event + AccountError, nothing else',
    (_l, change, otherKey) => {
      const credentials = newProvider();
      const account = change(stored(credentials));
      const h = setup(otherKey() ?? credentials, [account]);
      let thrown: unknown;
      try {
        assertSecretReadable(h.deps, account);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(AccountError);
      expect(thrown).toMatchObject({ code: 'secret-unreadable' });
      expect(accountEvents(h.log)).toEqual([
        expect.objectContaining({
          event: 'account.password-update',
          acct: ACCOUNT_ID,
          provider: 'websupport',
          outcome: 'failed',
          reason: 'secret-unreadable',
        }),
      ]);
      expect(h.log.records).toHaveLength(1);
      expect(h.entries).toEqual([]);
      expect(h.open).not.toHaveBeenCalled();
      expectNoLeak(h.log.records);
      expect(JSON.stringify(h.log.records)).not.toContain('attacker');
    },
  );
});

describe('audit details of account actions', () => {
  it('add (ok): details carry provider and the account uuid; no address, host or password', async () => {
    const h = setup();
    await addAccount(h.deps, {
      userId: USER_ID,
      email: EMAIL,
      settings: SETTINGS,
      provider: 'websupport',
      password: PASSWORD,
    });
    expect(h.entries).toHaveLength(1);
    expect(h.entries[0]).toMatchObject({ action: 'account.add', result: 'ok' });
    expect(h.entries[0]?.details).toStrictEqual({ provider: 'websupport', account: ACCOUNT_ID });
    expect(isValidAuditEntry(h.entries[0])).toBe(true);
    expectNoLeak(h.entries, accountEvents(h.log));
  });

  it('add (failed): details carry the provider only, and no account id on the row', async () => {
    const h = setup();
    h.open.mockRejectedValue(new Error(`login failed for ${EMAIL} ${PASSWORD}`));
    await expect(
      addAccount(h.deps, {
        userId: USER_ID,
        email: EMAIL,
        settings: SETTINGS,
        provider: 'websupport',
        password: PASSWORD,
      }),
    ).rejects.toBeDefined();
    expect(h.entries).toHaveLength(1);
    expect(h.entries[0]).toMatchObject({ action: 'account.add', result: 'failed' });
    expect(h.entries[0]?.details).toStrictEqual({ provider: 'websupport' });
    expect(h.entries[0]?.accountId).toBeUndefined();
    expectNoLeak(h.entries, accountEvents(h.log));
  });

  it('password-update (ok): details carry provider and the account uuid', async () => {
    const credentials = newProvider();
    const account = stored(credentials);
    const h = setup(credentials, [account]);
    await updatePassword(h.deps, account, NEW_PASSWORD);
    expect(h.entries).toHaveLength(1);
    expect(h.entries[0]).toMatchObject({
      action: 'account.password-update',
      result: 'ok',
      accountId: ACCOUNT_ID,
    });
    expect(h.entries[0]?.details).toStrictEqual({ provider: 'websupport', account: ACCOUNT_ID });
    expectNoLeak(h.entries, accountEvents(h.log));
  });

  it('remove: account_id is null (no accountId) but details.account links the history', async () => {
    const credentials = newProvider();
    const account = stored(credentials);
    const { repo } = accountRows([account]);
    const { entries, audit } = auditSink();
    const log = new MemoryEventLog({ run: RUN_ID, ver: '0.7.0', now: () => T0, level: 'debug' });
    const store: StoreDeps = { repo, audit, log, runId: RUN_ID };
    await removeAccount(store, account);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ action: 'account.remove', result: 'ok' });
    expect(entries[0]?.accountId).toBeUndefined();
    expect(entries[0]?.details).toStrictEqual({ provider: 'websupport', account: ACCOUNT_ID });
    expect(isValidAuditEntry(entries[0])).toBe(true);
    expectNoLeak(entries, accountEvents(log));
  });
});

describe('audit schema: details of account actions', () => {
  const entry = (action: string, details: unknown): unknown => ({ action, result: 'ok', details });

  function valid(e: unknown): boolean {
    const byGuard = isValidAuditEntry(e);
    expect(auditEntrySchema.safeParse(e).success).toBe(byGuard);
    return byGuard;
  }

  it.each(['account.add', 'account.password-update', 'account.remove'])(
    '%s accepts { provider, account: uuid }',
    (action) => {
      expect(valid(entry(action, { provider: 'gmail', account: ACCOUNT_ID }))).toBe(true);
    },
  );

  it.each<[string, unknown]>([
    ['a non-uuid account', { provider: 'gmail', account: 'not-a-uuid' }],
    ['an email as account', { provider: 'gmail', account: EMAIL }],
    ['an extra key', { provider: 'gmail', account: ACCOUNT_ID, host: HOST }],
    ['an extra key without account', { provider: 'gmail', host: HOST }],
  ])('rejects %s', (_label, details) => {
    expect(valid(entry('account.add', details))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Duplicate-add text
// ---------------------------------------------------------------------------------------------

describe('accountErrorText: duplicate', () => {
  it('mentions both ways out: update-password and remove', () => {
    const text = accountErrorText(new AccountError('duplicate', ACCOUNT_ID));
    expect(text).toContain('mm account update-password');
    expect(text).toContain('mm account remove');
  });
});
