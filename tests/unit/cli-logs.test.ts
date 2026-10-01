import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommanderError } from 'commander';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  EVENT_FIELDS,
  FileEventLog,
  SECURITY_PREFIX,
  authLogout,
  commandFinish,
  commandStart,
  doctorCheck,
  guardBlock,
  imapLoginFailed,
  renderEvent,
} from '../../src/core/log/index.js';
import type { LogEvent, LogEventName, LogRecord, RunContext } from '../../src/core/log/index.js';

// M1b-4c `mm logs` (spec): plain and --json output, option checks, path, clear. The log folder
// is <MM_CONFIG_DIR>/logs in a temp dir; env files and prompts are mocked.

const { loadEnvFiles, confirm } = vi.hoisted(() => ({
  loadEnvFiles: vi.fn(),
  confirm: vi.fn<(config: { message: string; default?: boolean }) => Promise<boolean>>(),
}));

vi.mock('../../src/core/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/config.js')>();
  return { ...actual, loadEnvFiles };
});
vi.mock('@inquirer/prompts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@inquirer/prompts')>();
  return { ...actual, confirm };
});

const { buildProgram } = await import('../../src/cli/index.js');

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 8, 29, 12, 0, 0);
const TODAY = '2026-09-29';
const RT = { ver: '0.6.0', node: '22.13.0', os: 'linux' };
const IP = '203.0.113.7';
const TARGET = 'e5'.repeat(32);

const OWN = '0000000000000000';
const RUN_A = 'aaaaaaaaaaaaaaaa';
const RUN_B = 'bbbbbbbbbbbbbbbb';
const RUN_C = 'cccccccccccccccc';

const posixOnly = process.platform === 'win32' ? it.skip : it;

const PARENT_REFUSAL = 'takes no --since/--level/--security/--run/--json';
const SINCE_ERROR = '--since must look like 30m, 24h or 7d (max 90d)';
const NO_TTY = 'mm logs clear needs a terminal to confirm, or --yes';

let tmp: string;
let dir: string;
let out = { stdout: '', stderr: '' };
const originalConfigDir = process.env['MM_CONFIG_DIR'];
const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
const originalOutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

function chunkToString(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString('utf8');
  return String(chunk);
}

type WriteCallback = (err?: Error | null) => void;

/** Captures a stream write and calls its callback, like a real stream would. */
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

function exitPrompt(): Error {
  const cancel = new Error('User force closed the prompt with SIGINT');
  cancel.name = 'ExitPromptError';
  return cancel;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mm-clilogs-'));
  dir = join(tmp, 'logs');
  process.env['MM_CONFIG_DIR'] = tmp;
  out = { stdout: '', stderr: '' };
  process.exitCode = undefined;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
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
  setTTY(false);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  loadEnvFiles.mockReset();
  confirm.mockReset();
  process.exitCode = undefined;
  if (originalConfigDir === undefined) delete process.env['MM_CONFIG_DIR'];
  else process.env['MM_CONFIG_DIR'] = originalConfigDir;
  if (originalIsTTY) Object.defineProperty(process.stdin, 'isTTY', originalIsTTY);
  else delete (process.stdin as { isTTY?: boolean }).isTTY;
  if (originalOutIsTTY) Object.defineProperty(process.stdout, 'isTTY', originalOutIsTTY);
  else delete (process.stdout as { isTTY?: boolean }).isTTY;
  rmSync(tmp, { recursive: true, force: true });
});

async function mm(...args: string[]): Promise<void> {
  await buildProgram({ exitOverride: true, run: OWN }).parseAsync(['node', 'mm', ...args]);
}

function ctx(run: string, at: number): RunContext {
  return { run, ver: '0.6.0', now: () => at, level: 'debug' };
}

/** Writes through the real writer and returns the record as written. */
function emit(run: string, at: number, event: LogEvent): LogRecord {
  const log = new FileEventLog(dir, ctx(run, at));
  log.emit(event);
  expect(log.failures + log.dropped).toBe(0);
  const rendered = renderEvent(event, ctx(run, at));
  if (rendered === null) throw new Error('not rendered');
  return rendered.record;
}

function rawLine(run: string, at: number, event: LogEvent): string {
  const rendered = renderEvent(event, ctx(run, at));
  if (rendered === null) throw new Error('not rendered');
  return rendered.line;
}

const start = (cmd = 'keygen'): LogEvent => commandStart(cmd, [], RT);
const finish = (cmd = 'keygen', exit = 0): LogEvent => commandFinish(cmd, exit, 5);

function jsonLines(): Record<string, unknown>[] {
  return out.stdout
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function canonicalKeys(record: Record<string, unknown>): string[] {
  const fields = (EVENT_FIELDS[record['event'] as LogEventName] as readonly string[]).filter((f) =>
    Object.hasOwn(record, f),
  );
  return ['ts', 'event', ...fields, 'level', 'run', 'v'];
}

function expectOk(): void {
  expect([undefined, 0]).toContain(process.exitCode);
}

/** A typical folder: two finished runs, one unfinished, a security line, the own run. */
function seed(): LogRecord[] {
  return [
    emit(RUN_A, NOW - 3 * HOUR, start('keygen')),
    emit(RUN_A, NOW - 3 * HOUR + 10, finish('keygen')),
    emit(RUN_B, NOW - 2 * HOUR, start('logout')),
    emit(RUN_B, NOW - 2 * HOUR + 10, authLogout('logged-out')),
    emit(RUN_B, NOW - 2 * HOUR + 20, finish('logout')),
    emit(RUN_C, NOW - HOUR, start('doctor')),
    emit(RUN_C, NOW - HOUR + 10, doctorCheck('master-key', 'fail')),
  ];
}

function seedOwn(): void {
  emit(OWN, NOW - 1000, start('logs'));
}

function dayFiles(): string[] {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

describe('mm logs (plain)', () => {
  it('missing folder → the empty message, exit 0', async () => {
    await mm('logs');
    expect(out.stdout).toContain('No log lines in the last 24 h.');
    expectOk();
    expect(existsSync(dir)).toBe(false);
  });

  it('empty folder → the empty message, exit 0', async () => {
    mkdirSync(dir, { mode: 0o700 });
    await mm('logs');
    expect(out.stdout).toContain('No log lines in the last 24 h.');
    expectOk();
  });

  it('lists the runs in plain words, marks the unfinished one, leaves the own run out', async () => {
    seed();
    seedOwn();
    await mm('logs');
    expectOk();
    const lines = out.stdout.split('\n').filter((l) => /^\d{2}:\d{2}:\d{2} {2}/.test(l));
    expect(lines).toHaveLength(8);
    expect(out.stdout).toContain('keygen');
    expect(out.stdout).toContain('started');
    expect(out.stdout).toContain('finished');
    expect(out.stdout).toContain('master-key');
    const interrupted = lines.filter((l) => l.includes('interrupted or still running'));
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0]).toContain('doctor');
    // The own run (cmd `logs`) never shows: neither its start nor as interrupted.
    expect(lines.filter((l) => l.slice(10, 22).trim() === 'logs')).toEqual([]);
    for (const id of [OWN, RUN_A, RUN_B, RUN_C, TARGET]) expect(out.stdout).not.toContain(id);
  });

  it('--since narrows the window', async () => {
    seed();
    await mm('logs', '--since', '90m');
    expect(out.stdout).toContain('doctor');
    expect(out.stdout).not.toContain('keygen');
    expectOk();
  });

  it('--since with nothing in the window → window-aware empty message', async () => {
    emit(RUN_A, NOW - 2 * HOUR, start());
    await mm('logs', '--since', '30m');
    expect(out.stdout).toContain('No log lines in the last 30 min.');
    expectOk();
  });

  it('--run with nothing found → run-aware empty message', async () => {
    seed();
    await mm('logs', '--run', 'dddddddddddddddd');
    expect(out.stdout).toContain('No log lines for run dddddddddddddddd.');
    expectOk();
  });
});

describe('mm logs --json', () => {
  it('one validated record per line, canonical keys, no other stdout text', async () => {
    const written = seed();
    seedOwn();
    appendFileSync(join(dir, `app-${TODAY}.log`), 'garbage\n');
    await mm('logs', '--json');
    expectOk();
    const records = jsonLines();
    expect(records).toEqual(written);
    for (const r of records) expect(Object.keys(r)).toEqual(canonicalKeys(r));
    expect(out.stdout).not.toContain('interrupted or still running');
    expect(out.stdout).not.toContain('unreadable');
    expect(records.some((r) => r['run'] === OWN)).toBe(false);
    expect(out.stderr).toContain('1 unreadable line skipped');
  });

  it('empty folder → empty stdout', async () => {
    await mm('logs', '--json');
    expectOk();
    expect(out.stdout.trim()).toBe('');
  });

  it('--security: security records only', async () => {
    seed();
    emit(
      RUN_C,
      NOW - HOUR + 20,
      imapLoginFailed({ provider: 'custom', ip: IP, target: TARGET }, 'auth-failed', true),
    );
    await mm('logs', '--json', '--security');
    expect(jsonLines().map((r) => r['event'])).toEqual(['auth.logout', 'imap.login-failed']);
  });

  it('--level: a minimum', async () => {
    seed();
    emit(
      RUN_C,
      NOW - HOUR + 20,
      guardBlock({
        kind: 'permanent',
        reason: 'auth-failed',
        ip: IP,
        addr: IP,
        attempts: 5,
        until: null,
        target: TARGET,
      }),
    );
    await mm('logs', '--json', '--level', 'warn');
    expect(jsonLines().map((r) => r['event'])).toEqual(['doctor.check', 'login-guard.block']);
    out.stdout = '';
    await mm('logs', '--json', '--level', 'error');
    expect(jsonLines().map((r) => r['event'])).toEqual(['login-guard.block']);
  });

  it('--run: that run only, all retained files without --since', async () => {
    seed();
    emit(RUN_A, NOW - 10 * DAY, doctorCheck('node', 'ok'));
    await mm('logs', '--json', '--run', RUN_A);
    const records = jsonLines();
    expect(records.map((r) => r['event'])).toEqual([
      'doctor.check',
      'command.start',
      'command.finish',
    ]);
    expect(new Set(records.map((r) => r['run']))).toEqual(new Set([RUN_A]));
  });

  it('the own run is left out even with --run <own id>', async () => {
    seedOwn();
    await mm('logs', '--json', '--run', OWN);
    expect(jsonLines()).toEqual([]);
  });
});

describe('tampered lines are never printed', () => {
  function tamper(): void {
    const record = JSON.parse(rawLine(RUN_A, NOW - 3 * HOUR + 20, finish())) as Record<
      string,
      unknown
    >;
    const app = join(dir, `app-${TODAY}.log`);
    appendFileSync(app, '\u001b]0;pwn\u0007{"ts":"x"}\n');
    appendFileSync(app, `${JSON.stringify({ ...record, cmd: 'key‮gen' })}\n`);
    appendFileSync(app, `${JSON.stringify({ ...record, ms: 1 })}\u0000\n`);
    appendFileSync(app, `${JSON.stringify({ ...record, subject: 'CANARY-SUBJECT Invoice' })}\n`);
    appendFileSync(
      join(dir, `security-${TODAY}.log`),
      `${SECURITY_PREFIX}${JSON.stringify({ ...record, cmd: '\u001b[2J' })}\n`,
    );
  }

  function expectClean(): void {
    const all = out.stdout + out.stderr;
    for (const bad of ['\u001b', '\u0007', '‮', '\u0000', 'CANARY-SUBJECT', 'pwn']) {
      expect(all).not.toContain(bad);
    }
  }

  it('plain: skipped and counted on stdout', async () => {
    seed();
    tamper();
    await mm('logs');
    expectClean();
    expect(out.stdout).toContain('5 unreadable lines skipped');
    expectOk();
  });

  it('--json: skipped, counted on stderr', async () => {
    seed();
    tamper();
    await mm('logs', '--json');
    expectClean();
    expect(out.stderr).toContain('5 unreadable lines skipped');
    for (const l of out.stdout.split('\n').filter((x) => x !== '')) {
      expect(() => {
        JSON.parse(l);
      }).not.toThrow();
    }
    expectOk();
  });
});

describe('option checks', () => {
  it.each(['1m', '30m', '24h', '7d', '90d', '2160h', '129600m'])(
    '--since %s is valid',
    async (v) => {
      await mm('logs', '--since', v);
      expectOk();
      expect(out.stderr).not.toContain(SINCE_ERROR);
    },
  );

  it.each(['0m', '0h', '91d', '100d', '2161h', '129601m', '24x', '-1h', '1.5h', '24', 'h', '1H'])(
    '--since %s is refused',
    async (v) => {
      await mm('logs', `--since=${v}`);
      expect(process.exitCode).toBe(1);
      expect(out.stderr).toContain(SINCE_ERROR);
    },
  );

  it.each(['verbose', 'INFO', 'warning', ''])('--level %j is refused', async (v) => {
    await mm('logs', `--level=${v}`);
    expect(process.exitCode).toBe(1);
    expect(out.stderr).toContain('--level');
  });

  it.each(['XYZ', 'ABCDEF0123456789', 'abc', '0123456789abcdef0', '0123456789abcdeg'])(
    '--run %s is refused',
    async (v) => {
      await mm('logs', `--run=${v}`);
      expect(process.exitCode).toBe(1);
      expect(out.stderr).toContain('--run');
    },
  );
});

describe('mm logs path', () => {
  it('prints the log folder', async () => {
    await mm('logs', 'path');
    expect(out.stdout.trim()).toBe(dir);
    expectOk();
  });
});

describe('mm logs clear', () => {
  function seedFiles(): void {
    emit(RUN_A, NOW - HOUR, start());
    emit(RUN_A, NOW - HOUR, authLogout('logged-out'));
    emit(RUN_A, NOW - 2 * DAY, start());
    writeFileSync(join(dir, 'notes.txt'), 'keep me');
    writeFileSync(join(dir, 'app-2026-13-45.log'), 'keep me too');
  }

  const others = ['app-2026-13-45.log', 'notes.txt'];

  it('missing folder → nothing to delete, exit 0', async () => {
    await mm('logs', 'clear', '--yes');
    expect(out.stdout).toContain('No log files to delete.');
    expectOk();
  });

  it('no day files → nothing to delete', async () => {
    mkdirSync(dir, { mode: 0o700 });
    writeFileSync(join(dir, 'notes.txt'), 'x');
    await mm('logs', 'clear', '--yes');
    expect(out.stdout).toContain('No log files to delete.');
    expectOk();
    expect(dayFiles()).toEqual(['notes.txt']);
  });

  it('without a TTY and without --yes → refused, nothing deleted', async () => {
    seedFiles();
    const before = dayFiles();
    await mm('logs', 'clear');
    expect(out.stderr).toContain(NO_TTY);
    expect(process.exitCode).toBe(1);
    expect(dayFiles()).toEqual(before);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('stdin a TTY but stdout not → still refused', async () => {
    seedFiles();
    setTTY(true, false);
    await mm('logs', 'clear');
    expect(out.stderr).toContain(NO_TTY);
    expect(process.exitCode).toBe(1);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('--yes without a TTY deletes only the day files', async () => {
    seedFiles();
    await mm('logs', 'clear', '--yes');
    expect(out.stdout).toContain('Deleted 3 log files.');
    expectOk();
    expect(dayFiles()).toEqual(others);
    expect(readFileSync(join(dir, 'notes.txt'), 'utf8')).toBe('keep me');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('one file → singular', async () => {
    emit(RUN_A, NOW - HOUR, start());
    await mm('logs', 'clear', '--yes');
    expect(out.stdout).toContain('Deleted 1 log file.');
    expect(dayFiles()).toEqual([]);
  });

  it('TTY: asks with default no; no → nothing deleted, exit 0', async () => {
    seedFiles();
    setTTY(true);
    confirm.mockResolvedValue(false);
    const before = dayFiles();
    await mm('logs', 'clear');
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]?.[0]).toMatchObject({
      message: "Delete 3 log files? This can't be undone.",
      default: false,
    });
    expect(out.stdout).toContain('Nothing deleted.');
    expectOk();
    expect(dayFiles()).toEqual(before);
  });

  it('TTY: yes → deleted', async () => {
    seedFiles();
    setTTY(true);
    confirm.mockResolvedValue(true);
    await mm('logs', 'clear');
    expect(out.stdout).toContain('Deleted 3 log files.');
    expect(dayFiles()).toEqual(others);
    expectOk();
  });

  it('TTY with --yes → no question', async () => {
    seedFiles();
    setTTY(true);
    await mm('logs', 'clear', '--yes');
    expect(confirm).not.toHaveBeenCalled();
    expect(out.stdout).toContain('Deleted 3 log files.');
  });

  it('Ctrl+C at the question → 130, nothing deleted', async () => {
    seedFiles();
    setTTY(true);
    confirm.mockRejectedValue(exitPrompt());
    const before = dayFiles();
    await mm('logs', 'clear');
    expect(process.exitCode).toBe(130);
    expect(dayFiles()).toEqual(before);
  });

  posixOnly('a symlinked folder → refused, target untouched', async () => {
    const real = join(tmp, 'real-logs');
    mkdirSync(real);
    writeFileSync(join(real, `app-${TODAY}.log`), 'x\n');
    symlinkSync(real, dir);
    await mm('logs', 'clear', '--yes');
    expect(process.exitCode).toBe(1);
    expect(readFileSync(join(real, `app-${TODAY}.log`), 'utf8')).toBe('x\n');
    expect(existsSync(dir)).toBe(true);
  });

  it('the folder is a regular file → refused, untouched', async () => {
    writeFileSync(dir, 'not a folder');
    await mm('logs', 'clear', '--yes');
    expect(process.exitCode).toBe(1);
    expect(readFileSync(dir, 'utf8')).toBe('not a folder');
  });

  posixOnly('a symlinked day file is not counted and its target survives', async () => {
    emit(RUN_A, NOW - HOUR, start());
    const outside = join(tmp, 'outside.log');
    writeFileSync(outside, 'precious');
    symlinkSync(outside, join(dir, `security-${TODAY}.log`));
    await mm('logs', 'clear', '--yes');
    expect(out.stdout).toContain('Deleted 1 log file.');
    expect(readFileSync(outside, 'utf8')).toBe('precious');
  });

  it('a directory named like a day file is not counted or deleted', async () => {
    emit(RUN_A, NOW - HOUR, start());
    mkdirSync(join(dir, `security-${TODAY}.log`));
    await mm('logs', 'clear', '--yes');
    expect(out.stdout).toContain('Deleted 1 log file.');
    expect(existsSync(join(dir, `security-${TODAY}.log`))).toBe(true);
  });

  it.each([
    [['logs', 'clear', '--since', '7d', '--yes']],
    [['logs', '--json', 'clear', '--yes']],
    [['logs', 'clear', '--yes', '--security']],
    [['logs', '--run', RUN_A, 'clear', '--yes']],
    [['logs', 'clear', '--level', 'warn', '--yes']],
  ])('parent options are refused: %j', async (args) => {
    seedFiles();
    const before = dayFiles();
    await mm(...args);
    expect(process.exitCode).toBe(1);
    expect(out.stderr).toContain(PARENT_REFUSAL);
    expect(dayFiles()).toEqual(before);
    expect(out.stdout).not.toContain('Deleted');
  });

  it('mm logs path --json is refused', async () => {
    await mm('logs', 'path', '--json');
    expect(process.exitCode).toBe(1);
    expect(out.stderr).toContain(PARENT_REFUSAL);
  });
});

describe('commander dispatch', () => {
  it('mm logs foo → too many arguments', async () => {
    const run = mm('logs', 'foo');
    await expect(run).rejects.toBeInstanceOf(CommanderError);
    await expect(run).rejects.toThrow(/too many arguments/);
  });

  it('logs, logs --json, logs path, logs clear --yes run their actions', async () => {
    await mm('logs');
    expect(out.stdout).toContain('No log lines');
    out.stdout = '';
    emit(RUN_A, NOW - HOUR, start());
    await mm('logs', '--json');
    expect(jsonLines()).toHaveLength(1);
    out.stdout = '';
    await mm('logs', 'path');
    expect(out.stdout.trim()).toBe(dir);
    out.stdout = '';
    await mm('logs', 'clear', '--yes');
    expect(out.stdout).toContain('Deleted 1 log file.');
    expectOk();
  });
});

describe('review follow-ups (M1b-4c)', () => {
  it('mm logs with a log folder that is a file → a plain message, exit 1, not "No log lines"', async () => {
    writeFileSync(dir, 'not a folder');
    await mm('logs');
    expect(process.exitCode).toBe(1);
    expect(out.stderr).toContain('not a folder');
    expect(out.stdout).not.toContain('No log lines');
  });

  it('mm logs with a missing folder is still the empty message, exit 0', async () => {
    await mm('logs');
    expect(process.exitCode ?? 0).toBe(0);
    expect(out.stdout).toContain('No log lines in the last 24 h.');
  });
});

describe('security audit follow-ups (M1b-4c)', () => {
  posixOnly(
    'clear: a folder swapped for a symlink after the listing is not deleted through',
    async () => {
      const { regularDayFiles, deleteDayFiles } = await import('../../src/core/log/index.js');
      mkdirSync(dir);
      writeFileSync(join(dir, `app-${TODAY}.log`), 'real\n');
      const list = await regularDayFiles(dir);
      expect(list.files).toHaveLength(1);
      const decoy = join(tmp, 'decoy');
      mkdirSync(decoy);
      writeFileSync(join(decoy, `app-${TODAY}.log`), 'decoy\n');
      rmSync(dir, { recursive: true });
      symlinkSync(decoy, dir);
      expect(await deleteDayFiles(dir, list)).toEqual({ deleted: 0, folderChanged: true });
      expect(readFileSync(join(decoy, `app-${TODAY}.log`), 'utf8')).toBe('decoy\n');
    },
  );

  it('clear: the same folder → every listed file deleted', async () => {
    const { regularDayFiles, deleteDayFiles } = await import('../../src/core/log/index.js');
    mkdirSync(dir);
    writeFileSync(join(dir, `app-${TODAY}.log`), 'a\n');
    writeFileSync(join(dir, `security-${TODAY}.log`), 'b\n');
    const list = await regularDayFiles(dir);
    expect(await deleteDayFiles(dir, list)).toEqual({ deleted: 2, folderChanged: false });
    expect(readdirSync(dir)).toEqual([]);
  });
});
