import { CommanderError, type Command } from 'commander';
import { logLevel, projectRoot, type EnvSource } from '../core/config.js';
import {
  commandFinish,
  commandStart,
  FileEventLog,
  newRunId,
  NullEventLog,
  safeEmit,
  unexpectedError,
  type EventLog,
  type RunContext,
  type Runtime,
} from '../core/log/index.js';
import { logDir } from '../core/paths.js';
import { errorText } from './error-text.js';
import type { BuildOptions } from './index.js';
import { reportError } from './report-error.js';

// One `mm` run: command.start (from commander's preAction hook) → command → command.finish,
// also when a command calls process.exit, on Ctrl+C and on crashes. Logging never changes
// what the user sees or the exit code.

/** The parts of `process` a run needs (tests pass a fake). */
export interface ProcLike {
  on(event: 'exit', fn: (code: number) => void): void;
  on(event: 'SIGINT', fn: () => void): void;
  on(event: 'uncaughtException' | 'unhandledRejection', fn: (err: unknown) => void): void;
  exit(code?: number): never;
  exitCode: number | string | null | undefined;
}

export interface RunCliDeps {
  argv: string[];
  build: (options: BuildOptions) => Command;
  log: EventLog;
  ctx: RunContext;
  proc: ProcLike;
  /** Flushes stdout + stderr before exiting. */
  flush: () => Promise<void>;
  /** Package root for relative stack frames. */
  root?: string;
}

/** number → itself; numeric string → number; anything else → 0 (Node's default). */
function normalizeExitCode(code: unknown): number {
  if (typeof code === 'number' && Number.isInteger(code)) return code;
  if (typeof code === 'string' && /^\d{1,3}$/.test(code)) return Number(code);
  return 0;
}

function safeNow(ctx: RunContext): number {
  try {
    return ctx.now();
  } catch {
    return Number.NaN;
  }
}

export class RunLogger {
  private cmd: string | undefined;
  private startedAt = Number.NaN;
  private finished = false;

  constructor(
    private readonly log: EventLog,
    private readonly ctx: RunContext,
    private readonly runtime: Runtime = {
      ver: ctx.ver,
      node: process.versions.node,
      os: process.platform,
    },
  ) {}

  start(cmd: string, opts: string[]): void {
    if (this.cmd !== undefined) return;
    this.cmd = cmd;
    this.startedAt = safeNow(this.ctx);
    safeEmit(this.log, () => commandStart(cmd, opts, this.runtime));
  }

  /** Once per run, and only after a start (--help, --version, parse errors log nothing). */
  finish(exitCode: unknown): void {
    const cmd = this.cmd;
    if (cmd === undefined || this.finished) return;
    this.finished = true;
    safeEmit(this.log, () =>
      commandFinish(cmd, normalizeExitCode(exitCode), safeNow(this.ctx) - this.startedAt),
    );
  }
}

/**
 * Log sink + run context for this process. Env files are loaded first so a MM_CONFIG_DIR or
 * MM_LOG_LEVEL in .env.local applies (logs then sit next to session.json). Nothing here can
 * fail the run: problems fall back to defaults or to no logging.
 */
export function createRunLog(o: {
  env: EnvSource;
  loadEnv: () => void;
  now: () => number;
  ver: string;
  makeLog?: (dir: string, ctx: RunContext) => EventLog;
}): { log: EventLog; ctx: RunContext } {
  try {
    o.loadEnv();
  } catch {
    // The command loads the env files again and reports the problem itself.
  }
  let level: RunContext['level'] = 'info';
  try {
    level = logLevel(o.env);
  } catch {
    // Keep info.
  }
  const ctx: RunContext = { run: newRunId(), ver: o.ver, now: o.now, level };
  const makeLog = o.makeLog ?? ((dir: string, c: RunContext) => new FileEventLog(dir, c));
  try {
    return { log: makeLog(logDir(o.env), ctx), ctx };
  } catch {
    return { log: new NullEventLog(), ctx };
  }
}

function isExitPrompt(err: unknown): boolean {
  return err instanceof Error && err.name === 'ExitPromptError';
}

export async function runCli(deps: RunCliDeps): Promise<void> {
  const { proc, log } = deps;
  const root = deps.root ?? projectRoot();
  const logger = new RunLogger(log, deps.ctx);

  // A command that calls process.exit itself still gets its finish line.
  proc.on('exit', (code) => {
    logger.finish(code);
  });
  let interrupted = false;
  proc.on('SIGINT', () => {
    if (interrupted) return;
    interrupted = true;
    // Replaces Node's default Ctrl+C handling, so it must always end the process.
    try {
      logger.finish(130);
    } finally {
      proc.exit(130);
    }
  });
  const crash = (err: unknown): void => {
    try {
      console.error('Unexpected error');
      safeEmit(log, () => unexpectedError(err, root));
    } finally {
      proc.exit(1);
    }
  };
  proc.on('uncaughtException', crash);
  proc.on('unhandledRejection', crash);

  try {
    await deps
      .build({ log, run: deps.ctx.run, onCommandStart: (cmd, opts) => logger.start(cmd, opts) })
      .parseAsync(deps.argv);
  } catch (err) {
    if (err instanceof CommanderError) {
      // Only with exitOverride: commander already printed its own message.
      proc.exitCode = err.exitCode;
    } else if (isExitPrompt(err)) {
      proc.exitCode = 130;
    } else {
      // Only messages written for users; raw library/server text never reaches the terminal.
      reportError(err, log, errorText, root);
      proc.exitCode = 1;
    }
  }
  logger.finish(proc.exitCode);
  // A finished command must not linger: library timers (e.g. auth-js token-refresh
  // retries, up to ~30 s) would otherwise keep the process alive and print late noise.
  await deps.flush();
  proc.exit();
}
