import { accessSync, constants, existsSync, lstatSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { logLevel, validateLogLevel, type EnvSource } from '../config.js';
import type { CheckResult } from '../doctor.js';
import { LOG_FILE_RE } from './file-event-log.js';

export interface LogHealthDeps {
  now?: () => number;
  posix?: boolean;
}

const BROKEN = "logs are not being written — the log folder can't be created or written";

/**
 * Whether the missing log folder could be created, judged like the writer does: nothing may
 * already sit at the log path (a dangling symlink counts), the walk only climbs past truly
 * missing paths (ENOENT; a symlink loop or permission error means no), and the nearest
 * existing ancestor must be a directory we can write into. Ancestors are followed with
 * `stat` (a symlinked home or macOS /tmp is fine), but a dangling symlink is not.
 */
function creatable(dir: string): boolean {
  let current = resolve(dir);
  try {
    lstatSync(current);
    return false; // something is there, and it isn't a usable folder (else we wouldn't ask)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return false;
  }
  for (let depth = 0; depth < 64; depth++) {
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
    try {
      if (!statSync(current).isDirectory()) return false;
      accessSync(current, constants.W_OK | constants.X_OK);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return false;
      try {
        lstatSync(current);
        return false; // a dangling symlink: mkdir would fail here
      } catch {
        // Truly missing: keep climbing.
      }
    }
  }
  return false;
}

function mode(m: number): string {
  return (m & 0o777).toString(8);
}

/**
 * `mm doctor` logs check. Logging is optional (the app works without it), so problems are
 * warnings. The detail never names the folder: it sits in the home directory.
 */
export function checkLogs(dir: string, env: EnvSource, deps: LogHealthDeps = {}): CheckResult {
  const name = 'logs';
  const posix = deps.posix ?? process.platform !== 'win32';
  const issues: string[] = [];
  let summary = '';

  // At warn/error a normal run may write nothing (no app lines; security lines only on a
  // login), so a missing folder is fine — as long as it could be created.
  const level = logLevel(env);
  if ((level === 'warn' || level === 'error') && !existsSync(dir)) {
    return creatable(dir)
      ? { name, status: 'ok', detail: 'no logs yet' }
      : { name, status: 'warn', detail: BROKEN };
  }
  try {
    const st = lstatSync(dir);
    if (!st.isDirectory()) throw new Error('not a directory');
    accessSync(dir, constants.W_OK);
    const today = new Date((deps.now ?? Date.now)()).toISOString().slice(0, 10);
    let files = 0;
    let bytes = 0;
    let oldest: string | undefined;
    let wrongModes = 0;
    for (const file of readdirSync(dir)) {
      const match = LOG_FILE_RE.exec(file);
      if (match === null) continue;
      const path = join(dir, file);
      const fst = lstatSync(path);
      const todays = file === `app-${today}.log` || file === `security-${today}.log`;
      // A symlink or directory where a day file belongs: the logger refuses to write to it.
      if (!fst.isFile()) {
        if (todays) throw new Error('unwritable day file');
        continue;
      }
      files++;
      bytes += fst.size;
      const date = match[2] ?? '';
      if (oldest === undefined || date < oldest) oldest = date;
      if (posix && (fst.mode & 0o777) !== 0o600) wrongModes++;
      if (todays) accessSync(path, constants.W_OK);
    }
    if (posix && (st.mode & 0o777) !== 0o700) {
      issues.push(`log folder mode is ${mode(st.mode)} (should be 700)`);
    }
    if (wrongModes > 0) issues.push(`${wrongModes} log file(s) not mode 600`);
    const kb = Math.ceil(bytes / 1024);
    summary =
      files === 0
        ? '0 files'
        : `${files} file${files === 1 ? '' : 's'}, ${kb} KB, oldest ${oldest ?? '?'}`;
  } catch {
    issues.push(BROKEN);
  }

  if (!validateLogLevel(env).ok) {
    issues.push('MM_LOG_LEVEL must be debug, info, warn or error (using info)');
  }
  if (issues.length > 0) return { name, status: 'warn', detail: issues.join('; ') };
  return { name, status: 'ok', detail: summary };
}
