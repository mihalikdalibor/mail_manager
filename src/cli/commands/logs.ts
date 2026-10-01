import { confirm } from '@inquirer/prompts';
import type { Command } from 'commander';
import { z } from 'zod';
import { LOG_LEVELS, loadEnvFiles, type LogLevel } from '../../core/config.js';
import {
  deleteDayFiles,
  readLogs,
  regularDayFiles,
  RUN_RE,
  type LogFolderStatus,
} from '../../core/log/index.js';
import { logDir } from '../../core/paths.js';
import type { CliContext } from '../index.js';
import { formatReport, reportFooters, sanitizeRecord } from '../log-text.js';

const MINUTE_MS = 60_000;
const DAY_MS = 1440 * MINUTE_MS;
const UNIT_MS: Record<string, number> = { m: MINUTE_MS, h: 60 * MINUTE_MS, d: DAY_MS };
const MAX_SINCE_MS = 90 * DAY_MS;
const PARENT_OPTIONS = ['since', 'level', 'security', 'run', 'json'] as const;

const sinceSchema = z
  .string()
  .regex(/^\d{1,6}(m|h|d)$/)
  .transform((value) => Number(value.slice(0, -1)) * (UNIT_MS[value.slice(-1)] ?? 0))
  .refine((ms) => ms >= MINUTE_MS && ms <= MAX_SINCE_MS);
const levelSchema = z.enum(LOG_LEVELS);
const runSchema = z.string().regex(RUN_RE);

interface LogsOptions {
  since?: string;
  level?: string;
  security?: boolean;
  run?: string;
  json?: boolean;
}

interface Parsed {
  sinceMs?: number;
  level?: LogLevel;
  run?: string;
}

/** Validated options, or null after printing what's wrong. */
function parseOptions(opts: LogsOptions): Parsed | null {
  const parsed: Parsed = {};
  if (opts.since !== undefined) {
    const since = sinceSchema.safeParse(opts.since);
    if (!since.success) return fail('--since must look like 30m, 24h or 7d (max 90d)');
    parsed.sinceMs = since.data;
  }
  if (opts.level !== undefined) {
    const level = levelSchema.safeParse(opts.level);
    if (!level.success) return fail('--level must be one of debug, info, warn, error');
    parsed.level = level.data;
  }
  if (opts.run !== undefined) {
    const run = runSchema.safeParse(opts.run);
    if (!run.success) {
      return fail('--run must be a run id: 16 characters 0-9 and a-f (see mm logs --json)');
    }
    parsed.run = run.data;
  }
  return parsed;
}

function fail(message: string): null {
  console.error(message);
  process.exitCode = 1;
  return null;
}

const broken = new Set<NodeJS.WriteStream>();
const guarded = new Set<NodeJS.WriteStream>();

/**
 * `mm logs | head` (or `2>&1 | head`) closes the pipe early: that's not an error. `runCli`
 * now ignores EPIPE for every command; this guard stays because it also stops further writes
 * after a break (`broken`). Other write errors → exit 1, quietly.
 */
function guard(stream: NodeJS.WriteStream): void {
  if (guarded.has(stream)) return;
  guarded.add(stream);
  stream.on('error', (err: NodeJS.ErrnoException) => {
    broken.add(stream);
    if (err.code !== 'EPIPE') process.exitCode = 1;
  });
}

function writeLines(stream: NodeJS.WriteStream, lines: string[]): void {
  if (lines.length === 0 || broken.has(stream)) return;
  stream.write(`${lines.join('\n')}\n`);
}

const FOLDER_PROBLEM: Partial<Record<LogFolderStatus, string>> = {
  'not-a-folder':
    "The log folder is a link or a file, not a folder, so nothing is logged or read. Check it with 'mm logs path' and 'mm doctor'.",
  unreadable:
    "Can't read the log folder — check its permissions ('mm logs path' shows where it is).",
};

async function showLogs(opts: LogsOptions, ctx: CliContext): Promise<void> {
  const parsed = parseOptions(opts);
  if (parsed === null) return;
  loadEnvFiles();
  guard(process.stdout);
  guard(process.stderr);
  const now = Date.now();
  const result = await readLogs(logDir(process.env), {
    now,
    ...parsed,
    ...(opts.security === true && { securityOnly: true }),
    // --json prints records only, so interrupted markers must not use up its cap.
    ...(opts.json === true && { interrupted: false }),
    ...(ctx.run !== undefined && { ownRun: ctx.run }),
  });
  const problem = FOLDER_PROBLEM[result.folder];
  if (problem !== undefined) {
    // Not "no log lines": the user should know nothing could be read.
    fail(problem);
    return;
  }
  const report = { now, ...parsed, ...(opts.security === true && { securityOnly: true }) };
  if (opts.json === true) {
    // Validated records re-serialized — never the raw lines. Footers stay off stdout.
    writeLines(
      process.stdout,
      result.records.map((record) => JSON.stringify(sanitizeRecord(record))),
    );
    writeLines(process.stderr, reportFooters(result, report));
    return;
  }
  writeLines(process.stdout, formatReport(result, report));
}

/** commander hands `logs` options to the parent even after `clear`: refuse them there. */
function refuseParentOptions(logs: Command, sub: string): boolean {
  if (!PARENT_OPTIONS.some((name) => logs.getOptionValueSource(name) === 'cli')) return false;
  fail(`mm logs ${sub} takes no --since/--level/--security/--run/--json`);
  return true;
}

function files(n: number): string {
  return `${n} log ${n === 1 ? 'file' : 'files'}`;
}

async function clearLogs(yes: boolean): Promise<void> {
  loadEnvFiles();
  const dir = logDir(process.env);
  const list = await regularDayFiles(dir);
  const found = list.files;
  const problem = FOLDER_PROBLEM[list.status];
  if (problem !== undefined) {
    fail(`${problem} Nothing deleted.`);
    return;
  }
  if (found.length === 0) {
    console.log('No log files to delete.');
    return;
  }
  if (!yes) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      fail('mm logs clear needs a terminal to confirm, or --yes');
      return;
    }
    let ok: boolean;
    try {
      ok = await confirm({
        message: `Delete ${files(found.length)}? This can't be undone.`,
        default: false,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'ExitPromptError') {
        process.exitCode = 130;
        return;
      }
      throw err;
    }
    if (!ok) {
      console.log('Nothing deleted.');
      return;
    }
  }
  const { deleted, folderChanged } = await deleteDayFiles(dir, list);
  if (folderChanged) {
    fail(
      `The log folder changed while waiting, so Mail Manager stopped. Deleted ${files(deleted)}. Check it with 'mm logs path'.`,
    );
    return;
  }
  console.log(`Deleted ${files(deleted)}.`);
}

export function registerLogs(program: Command, ctx: CliContext): void {
  const logs = program
    .command('logs')
    .description('Show the local logs of this computer (last 24 h by default)')
    .option('--since <duration>', 'how far back: 30m, 24h, 7d … (max 90d)')
    .option('--level <level>', 'minimum level: debug, info, warn, error (default info)')
    .option('--security', 'security events only (logins, login guard)')
    .option('--run <id>', "one run's lines (all retained days unless --since is given)")
    .option('--json', 'validated records as JSON lines, safe to share with support')
    .action(async (opts: LogsOptions) => {
      await showLogs(opts, ctx);
    });

  logs
    .command('path')
    .description('Print the log folder')
    .action(() => {
      if (refuseParentOptions(logs, 'path')) return;
      loadEnvFiles();
      console.log(logDir(process.env));
    });

  logs
    .command('clear')
    .description('Delete the local log files (asks first)')
    .option('--yes', 'delete without asking')
    .action(async (opts: { yes?: boolean }) => {
      if (refuseParentOptions(logs, 'clear')) return;
      await clearLogs(opts.yes === true);
    });
}
