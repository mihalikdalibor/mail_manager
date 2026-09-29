import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { isUserFacing } from '../../src/cli/error-text.js';
import { buildProgram } from '../../src/cli/index.js';
import type { BuildOptions } from '../../src/cli/index.js';
import { reportError } from '../../src/cli/report-error.js';
import { createRunLog, runCli, RunLogger } from '../../src/cli/run.js';
import type { ProcLike } from '../../src/cli/run.js';
import { ConfigError } from '../../src/core/config.js';
import type { EnvSource } from '../../src/core/config.js';
import { MemoryEventLog, NullEventLog } from '../../src/core/log/index.js';
import { validateMasterKey } from '../../src/core/master-key.js';
import type { EventLog, LogRecord, RunContext } from '../../src/core/log/index.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CTX: RunContext = {
  run: 'abcdef0123456789',
  ver: '0.5.0',
  now: () => Date.UTC(2026, 8, 23, 10, 0, 0),
  level: 'debug',
};
const ADDRESS = 'canary@secret-domain.example';
const PASSWORD = 'hunter2-ÄŠť';

type Handler = (arg?: unknown) => void;
type Action = () => void | Promise<void>;

/**
 * Stand-in for `process`. Like the real one, exit() runs the 'exit' handlers — but then it
 * returns instead of ending the test run. exitCode is the real process.exitCode, so commands
 * that set process.exitCode and a runner that reads proc.exitCode see the same value.
 */
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

  fire(event: string, arg?: unknown): void {
    for (const h of this.handlers.get(event) ?? []) h(arg);
  }

  exit(code?: number): never {
    this.exits.push(code);
    const current = process.exitCode;
    this.fire('exit', code ?? (typeof current === 'number' ? current : 0));
    return undefined as never;
  }
}

class ThrowingLog implements EventLog {
  emit(): void {
    throw new Error('disk full');
  }
}

function chunkToString(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString('utf8');
  return String(chunk);
}

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
  // Safety net: nothing under test may end the test process.
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`real process.exit(${String(code)}) called`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

interface Leaf {
  path: string;
  cmd: Command;
}

function leaves(cmd: Command, prefix: string[] = []): Leaf[] {
  return cmd.commands.flatMap((c) => {
    const path = [...prefix, c.name()];
    return c.commands.length > 0 ? leaves(c, path) : [{ path: path.join(' '), cmd: c }];
  });
}

/** buildProgram with every command's action replaced; commander throws instead of exiting. */
function stubbed(action: Action = () => undefined): (o: BuildOptions) => Command {
  return (o) => {
    const program = buildProgram({ ...o, exitOverride: true });
    for (const leaf of leaves(program)) leaf.cmd.action(action);
    return program;
  };
}

/** Dummy values for required arguments and mandatory options. */
function dummyArgs(cmd: Command): string[] {
  const args = cmd.registeredArguments.filter((a) => a.required).map(() => 'x@example.com');
  const opts = cmd.options.filter((o) => o.mandatory).flatMap((o) => [o.long ?? '', 'x']);
  return [...args, ...opts];
}

async function run(
  argv: string[],
  options: { build?: (o: BuildOptions) => Command; log?: EventLog; proc?: FakeProc } = {},
): Promise<{ log: EventLog; proc: FakeProc }> {
  const log = options.log ?? new MemoryEventLog(CTX);
  const proc = options.proc ?? new FakeProc();
  await runCli({
    argv: ['node', 'mm', ...argv],
    build: options.build ?? stubbed(),
    log,
    ctx: CTX,
    proc,
    flush: () => Promise.resolve(),
    root: REPO_ROOT,
  });
  return { log, proc };
}

function mem(log: EventLog): MemoryEventLog {
  if (!(log instanceof MemoryEventLog)) throw new Error('expected a MemoryEventLog');
  return log;
}

function records(log: EventLog): LogRecord[] {
  return mem(log).records;
}

function eventNames(log: EventLog): string[] {
  return records(log).map((r) => r.event);
}

function finishes(log: EventLog): LogRecord[] {
  return records(log).filter((r) => r.event === 'command.finish');
}

describe('runCli: every command logs start and finish', () => {
  const all = leaves(buildProgram({ exitOverride: true }));

  it('finds the known commands', () => {
    expect(all.map((l) => l.path)).toEqual(
      expect.arrayContaining(['login', 'logout', 'whoami', 'keygen', 'doctor', 'discover']),
    );
  });

  it.each(all.map((l) => [l.path, l] as const))('%s', async (path, leaf) => {
    const { log } = await run([...path.split(' '), ...dummyArgs(leaf.cmd)]);
    const recs = records(log);
    expect(recs.map((r) => r.event)).toEqual(['command.start', 'command.finish']);
    expect(recs[0]).toMatchObject({ cmd: path, run: CTX.run });
    expect(recs[1]).toMatchObject({ cmd: path, outcome: 'ok', exit: 0, run: CTX.run });
  });
});

describe('runCli: option names, never values', () => {
  it('login --email logs the option name only', async () => {
    const { log } = await run(['login', '--email', ADDRESS]);
    expect(records(log)[0]).toMatchObject({ event: 'command.start', opts: ['email'] });
    for (const line of mem(log).lines) {
      expect(line).not.toContain(ADDRESS);
      expect(line).not.toContain('secret-domain');
    }
  });

  it('a command with no options given logs opts []', async () => {
    const { log } = await run(['login']);
    expect(records(log)[0]).toMatchObject({ opts: [] });
  });
});

describe('buildProgram onCommandStart', () => {
  async function started(argv: string[]): Promise<[string, string[]][]> {
    const seen: [string, string[]][] = [];
    const program = buildProgram({
      exitOverride: true,
      onCommandStart: (cmd, opts) => seen.push([cmd, opts]),
    });
    program
      .command('probe')
      .option('--color')
      .option('--no-color')
      .option('-v, --verbose')
      .option('--level <n>', 'level', '5')
      .option('--name <value>')
      .action(() => undefined);
    program
      .command('account')
      .command('add')
      .action(() => undefined);
    await program.parseAsync(argv, { from: 'user' });
    return seen;
  }

  it('passes the names of options given on the command line, deduped', async () => {
    const seen = await started(['probe', '--color', '--no-color', '-v', '--name', ADDRESS]);
    expect(seen).toHaveLength(1);
    const [cmd, opts] = seen[0] ?? ['', []];
    expect(cmd).toBe('probe');
    expect([...opts].sort()).toEqual(['color', 'name', 'verbose']);
    expect(JSON.stringify(seen)).not.toContain(ADDRESS);
  });

  it('omits options that only have a default value', async () => {
    const seen = await started(['probe']);
    expect(seen).toEqual([['probe', []]]);
  });

  it('a throwing onCommandStart does not stop the command', async () => {
    const action = vi.fn();
    const program = buildProgram({
      exitOverride: true,
      onCommandStart: () => {
        throw new Error('x');
      },
    });
    program.command('probe').action(action);
    await program.parseAsync(['probe'], { from: 'user' });
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('a throwing onCommandStart does not stop a real command (keygen)', async () => {
    const program = buildProgram({
      exitOverride: true,
      onCommandStart: () => {
        throw new Error('x');
      },
    });
    await program.parseAsync(['keygen'], { from: 'user' });
    expect(out.stdout.trim().split('\n')).toHaveLength(1);
    expect(validateMasterKey(out.stdout.trim()).ok).toBe(true);
  });

  it('passes the command path without the root, space-joined', async () => {
    const seen = await started(['account', 'add']);
    expect(seen).toEqual([['account add', []]]);
  });
});

describe('runCli: outcomes', () => {
  it('process.exitCode 130 → interrupted', async () => {
    const { log } = await run(['keygen'], {
      build: stubbed(() => {
        process.exitCode = 130;
      }),
    });
    expect(finishes(log)).toHaveLength(1);
    expect(finishes(log)[0]).toMatchObject({ outcome: 'interrupted', exit: 130 });
  });

  it('process.exitCode 1 → failed', async () => {
    const { log } = await run(['keygen'], {
      build: stubbed(() => {
        process.exitCode = 1;
      }),
    });
    expect(finishes(log)[0]).toMatchObject({ outcome: 'failed', exit: 1 });
  });

  it('SIGINT → finish interrupted once and exit(130), even when fired twice', async () => {
    const proc = new FakeProc();
    const { log } = await run(['keygen'], {
      proc,
      build: stubbed(() => {
        proc.fire('SIGINT');
        proc.fire('SIGINT');
      }),
    });
    expect(finishes(log)).toHaveLength(1);
    expect(finishes(log)[0]).toMatchObject({ outcome: 'interrupted', exit: 130 });
    expect(proc.exits[0]).toBe(130);
  });

  it('a direct exit(2) during a command is recorded by the exit handler, once', async () => {
    const proc = new FakeProc();
    const { log } = await run(['keygen'], {
      proc,
      build: stubbed(() => {
        proc.fire('exit', 2);
      }),
    });
    expect(finishes(log)).toHaveLength(1);
    expect(finishes(log)[0]).toMatchObject({ outcome: 'failed', exit: 2 });
  });

  it('the exit handler after a normal finish does not write a second finish', async () => {
    const proc = new FakeProc();
    const { log } = await run(['keygen'], { proc });
    proc.fire('exit', 0);
    proc.fire('exit', 1);
    expect(finishes(log)).toHaveLength(1);
  });
});

describe('runCli: commander exits write nothing', () => {
  it.each([
    ['--help', ['--help']],
    ['--version', ['--version']],
    ['an unknown command', ['nosuchcmd']],
    ['a missing argument', ['discover']],
    ['an unknown option', ['login', '--bogus']],
  ])('%s', async (_label, argv) => {
    const { log } = await run(argv);
    expect(records(log)).toEqual([]);
    expect(out.stderr).not.toContain('Unexpected error');
  });

  it('--help still prints the help', async () => {
    await run(['--help']);
    expect(out.stdout).toContain('keygen');
  });
});

describe('runCli: errors thrown by a command', () => {
  it('an unexpected error prints "Unexpected error" and logs error.unexpected without the message', async () => {
    const { log } = await run(['keygen'], {
      build: stubbed(() => {
        throw new Error(`boom ${PASSWORD}`);
      }),
    });
    expect(out.stderr).toContain('Unexpected error');
    expect(out.stderr).not.toContain('boom');
    expect(out.stderr).not.toContain('hunter2');
    expect(eventNames(log)).toEqual(['command.start', 'error.unexpected', 'command.finish']);
    expect(finishes(log)[0]).toMatchObject({ outcome: 'failed', exit: 1 });
    for (const line of mem(log).lines) {
      expect(line).not.toContain('boom');
      expect(line).not.toContain('hunter2');
    }
  });

  it('a user-facing error prints its message and logs no error.unexpected', async () => {
    const err = new ConfigError([{ variable: 'X_TEST_VAR', problem: 'is missing' }]);
    const { log } = await run(['keygen'], {
      build: stubbed(() => {
        throw err;
      }),
    });
    expect(out.stderr).toContain(err.message);
    expect(out.stderr).not.toContain('Unexpected error');
    expect(eventNames(log)).not.toContain('error.unexpected');
    expect(finishes(log)[0]).toMatchObject({ outcome: 'failed', exit: 1 });
  });

  it('ExitPromptError (Ctrl+C in a prompt) → exit 130, interrupted, no error.unexpected', async () => {
    const { log } = await run(['keygen'], {
      build: stubbed(() => {
        const e = new Error('User force closed the prompt');
        e.name = 'ExitPromptError';
        throw e;
      }),
    });
    expect(eventNames(log)).not.toContain('error.unexpected');
    expect(finishes(log)).toHaveLength(1);
    expect(finishes(log)[0]).toMatchObject({ outcome: 'interrupted', exit: 130 });
    expect(out.stderr).not.toContain('Unexpected error');
  });

  it('an async action that rejects is handled like a throw', async () => {
    const { log } = await run(['keygen'], {
      build: stubbed(() => Promise.reject(new Error(`async ${PASSWORD}`))),
    });
    expect(out.stderr).toContain('Unexpected error');
    expect(eventNames(log)).toEqual(['command.start', 'error.unexpected', 'command.finish']);
  });
});

describe('runCli: process-level handlers', () => {
  it.each(['uncaughtException', 'unhandledRejection'])(
    '%s during a command → Unexpected error, error.unexpected, exit(1)',
    async (event) => {
      const proc = new FakeProc();
      const { log } = await run(['keygen'], {
        proc,
        build: stubbed(() => {
          proc.fire(event, new Error(`kaboom ${PASSWORD}`));
        }),
      });
      expect(out.stderr).toContain('Unexpected error');
      expect(out.stderr).not.toContain('kaboom');
      expect(eventNames(log)).toContain('error.unexpected');
      expect(proc.exits).toContain(1);
      expect(finishes(log)).toHaveLength(1);
      expect(finishes(log)[0]).toMatchObject({ outcome: 'failed', exit: 1 });
      for (const line of mem(log).lines) expect(line).not.toContain('kaboom');
    },
  );

  it.each(['uncaughtException', 'unhandledRejection'])(
    '%s after the command finished → Unexpected error, error.unexpected, exit(1)',
    async (event) => {
      const proc = new FakeProc();
      const { log } = await run(['keygen'], { proc });
      out.stderr = '';
      proc.fire(event, 'not an error');
      expect(out.stderr).toContain('Unexpected error');
      expect(eventNames(log)).toContain('error.unexpected');
      expect(proc.exits.at(-1)).toBe(1);
      expect(finishes(log)).toHaveLength(1);
    },
  );
});

describe('runCli: a broken log never changes the command', () => {
  async function observe(log: EventLog, action: Action, argv = ['keygen']) {
    out = { stdout: '', stderr: '' };
    process.exitCode = undefined;
    const proc = new FakeProc();
    await run(argv, { log, proc, build: stubbed(action) });
    return { ...out, exits: proc.exits, exitCode: process.exitCode };
  }

  it.each<[string, Action]>([
    [
      'output and an exit code',
      (): void => {
        console.log('hello');
        console.error('warning');
        process.exitCode = 3;
      },
    ],
    [
      'a thrown error',
      (): void => {
        throw new Error('boom');
      },
    ],
    ['nothing', (): void => undefined],
  ])('with %s', async (_label, action) => {
    const broken = await observe(new ThrowingLog(), action);
    const nothing = await observe(new NullEventLog(), action);
    expect(broken).toEqual(nothing);
  });

  it('with a commander exit', async () => {
    const broken = await observe(new ThrowingLog(), () => undefined, ['--version']);
    const nothing = await observe(new NullEventLog(), () => undefined, ['--version']);
    expect(broken).toEqual(nothing);
  });
});

describe('RunLogger', () => {
  it.each([
    ['2', 2, 'failed'],
    [2, 2, 'failed'],
    [130, 130, 'interrupted'],
    [0, 0, 'ok'],
    [undefined, 0, 'ok'],
    [null, 0, 'ok'],
    ['x', 0, 'ok'],
  ] as const)('finish(%j) → exit %i, %s', (code, exit, outcome) => {
    const log = new MemoryEventLog(CTX);
    const logger = new RunLogger(log, CTX);
    logger.start('keygen', []);
    logger.finish(code);
    expect(log.records.map((r) => r.event)).toEqual(['command.start', 'command.finish']);
    expect(log.records[1]).toMatchObject({ cmd: 'keygen', exit, outcome });
  });

  it('finish without start writes nothing', () => {
    const log = new MemoryEventLog(CTX);
    new RunLogger(log, CTX).finish(1);
    expect(log.records).toEqual([]);
  });

  it('finish is written once', () => {
    const log = new MemoryEventLog(CTX);
    const logger = new RunLogger(log, CTX);
    logger.start('keygen', ['x']);
    logger.finish(0);
    logger.finish(1);
    expect(log.records.filter((r) => r.event === 'command.finish')).toHaveLength(1);
  });

  it('never throws with a broken log', () => {
    const logger = new RunLogger(new ThrowingLog(), CTX);
    expect(() => {
      logger.start('keygen', []);
      logger.finish(0);
    }).not.toThrow();
  });
});

describe('createRunLog', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'mm-runlog-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function memoryLog(dirs: string[]) {
    return (dir: string, ctx: RunContext): EventLog => {
      dirs.push(dir);
      return new MemoryEventLog(ctx);
    };
  }

  it('loads the env files before reading MM_CONFIG_DIR', () => {
    const env: EnvSource = {};
    const dirs: string[] = [];
    const { ctx } = createRunLog({
      env,
      loadEnv: () => {
        env['MM_CONFIG_DIR'] = tmp;
      },
      now: () => 5,
      ver: '9.9.9',
      makeLog: memoryLog(dirs),
    });
    expect(dirs).toEqual([join(tmp, 'logs')]);
    expect(ctx.run).toMatch(/^[0-9a-f]{16}$/);
    expect(ctx.ver).toBe('9.9.9');
    expect(ctx.now()).toBe(5);
    expect(ctx.level).toBe('info');
  });

  it('loads the env files before reading MM_LOG_LEVEL', () => {
    const env: EnvSource = { MM_CONFIG_DIR: tmp };
    const { ctx } = createRunLog({
      env,
      loadEnv: () => {
        env['MM_LOG_LEVEL'] = 'warn';
      },
      now: () => 5,
      ver: '9.9.9',
      makeLog: memoryLog([]),
    });
    expect(ctx.level).toBe('warn');
  });

  it('ignores a throwing loadEnv', () => {
    const dirs: string[] = [];
    let result: ReturnType<typeof createRunLog> | undefined;
    expect(() => {
      result = createRunLog({
        env: { MM_CONFIG_DIR: tmp },
        loadEnv: () => {
          throw new ConfigError([{ variable: '.env.local', problem: 'cannot be read' }]);
        },
        now: () => 5,
        ver: '9.9.9',
        makeLog: memoryLog(dirs),
      });
    }).not.toThrow();
    expect(result?.ctx.run).toMatch(/^[0-9a-f]{16}$/);
    expect(dirs).toEqual([join(tmp, 'logs')]);
  });

  it('falls back to a NullEventLog when makeLog throws', () => {
    const { log } = createRunLog({
      env: { MM_CONFIG_DIR: tmp },
      loadEnv: () => undefined,
      now: () => 5,
      ver: '9.9.9',
      makeLog: () => {
        throw new Error('cannot create');
      },
    });
    expect(log).toBeInstanceOf(NullEventLog);
    expect(() =>
      log.emit({ event: 'command.start', cmd: 'x', opts: [], ver: '1', node: '22', os: 'linux' }),
    ).not.toThrow();
  });

  it('writes to <config dir>/logs by default', () => {
    const { log } = createRunLog({
      env: { MM_CONFIG_DIR: tmp },
      loadEnv: () => undefined,
      now: () => Date.now(),
      ver: '9.9.9',
    });
    log.emit({ event: 'command.start', cmd: 'x', opts: [], ver: '1', node: '22', os: 'linux' });
    expect(readdirSync(join(tmp, 'logs')).filter((n) => n.startsWith('app-'))).toHaveLength(1);
  });
});

describe('reportError', () => {
  it('an unexpected error → "Unexpected error" and one error.unexpected', () => {
    const log = new MemoryEventLog(CTX);
    reportError(new Error(`boom ${PASSWORD}`), log);
    expect(out.stderr).toBe('Unexpected error\n');
    expect(log.records.map((r) => r.event)).toEqual(['error.unexpected']);
    expect(log.lines.join('\n')).not.toContain('boom');
  });

  it('a user-facing error → its message, nothing logged', () => {
    const log = new MemoryEventLog(CTX);
    const err = new ConfigError([{ variable: 'X_TEST_VAR', problem: 'is missing' }]);
    reportError(err, log);
    expect(out.stderr).toBe(`${err.message}\n`);
    expect(log.records).toEqual([]);
  });

  it('uses a custom text function for the printed text', () => {
    const log = new MemoryEventLog(CTX);
    reportError(new Error('boom'), log, () => 'custom text', REPO_ROOT);
    expect(out.stderr).toBe('custom text\n');
    expect(log.records.map((r) => r.event)).toEqual(['error.unexpected']);
  });

  it('still prints with a broken log', () => {
    expect(() => reportError(new Error('boom'), new ThrowingLog())).not.toThrow();
    expect(out.stderr).toBe('Unexpected error\n');
  });
});

describe('isUserFacing', () => {
  it('is true for core errors written for users', () => {
    expect(isUserFacing(new ConfigError([{ variable: 'X', problem: 'is missing' }]))).toBe(true);
  });

  it.each([
    ['an Error', new Error('x')],
    ['a TypeError', new TypeError('x')],
    ['a string', 'x'],
    ['null', null],
  ])('is false for %s', (_label, err) => {
    expect(isUserFacing(err)).toBe(false);
  });
});
