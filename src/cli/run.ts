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
  /**
   * Output streams (stdout, stderr) whose 'error' events the run handles: a closed pipe
   * (`mm keygen | head -0`) must not look like a crash.
   */
  streams?: NodeJS.EventEmitter[];
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
      try {
        console.error('Unexpected error');
      } catch {
        // A broken stderr must not stop the log line or the exit.
      }
      safeEmit(log, () => unexpectedError(err, root));
    } finally {
      proc.exit(1);
    }
  };
  // Output stream errors never reach `crash` (no "Unexpected error" for a closed pipe):
  // - EPIPE: the reader went away (`| head`); not our failure, the exit code stays as the
  //   command set it. ERR_STREAM_DESTROYED only follows an earlier break, so it's the same.
  // - Anything else (EIO, ...): the output is lost, so the run must not exit 0. Nothing is
  //   printed: the stream is broken. An error arriving after command.finish was logged can
  //   make the real exit code 1 while the log says the earlier one; the log can't be rewritten.
  // A command may set `exitCode = 0` after the error arrived (e.g. after a network wait), so the
  // failure is remembered and applied again before the finish line and before the exit.
  let streamFailed = false;
  const applyStreamFailure = (): void => {
    if (streamFailed && normalizeExitCode(proc.exitCode) === 0) proc.exitCode = 1;
  };
  const onStreamError = (err: unknown): void => {
    const code = (err as { code?: unknown } | null | undefined)?.code;
    if (code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED') return;
    streamFailed = true;
    applyStreamFailure();
  };
  for (const stream of deps.streams ?? []) stream.on('error', onStreamError);
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
  applyStreamFailure();
  logger.finish(proc.exitCode);
  // A finished command must not linger: library timers (e.g. auth-js token-refresh
  // retries, up to ~30 s) would otherwise keep the process alive and print late noise.
  await deps.flush();
  applyStreamFailure();
  proc.exit();
}
