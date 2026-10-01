import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { EventLog } from './event-log.js';
import { passesLevel } from './event-log.js';
import type { LogEvent, LogKind } from './events.js';
import { formatLine, lineBytes, MAX_LINE_BYTES, renderEvent, toRecord } from './record.js';
import type { LogRecord, RunContext } from './record.js';

const DAY_MS = 86_400_000;
const POSIX = process.platform !== 'win32';
const TRUNCATED_MARK = '"event":"log.truncated"';

/** `app-2026-09-28.log` / `security-2026-09-28.log` (UTC dates). */
export const LOG_FILE_RE = /^(app|security)-(\d{4}-\d{2}-\d{2})\.log$/;

export const RETENTION_DAYS: Record<LogKind, number> = { app: 30, security: 90 };
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
/**
 * Security day files get a much higher cap: dropping security lines would hide a login flood
 * exactly when it matters. Local logs are per OS user and machine; normal use writes a few
 * lines per login, so only a script loop or a bug gets near this (decided 2026-09-28).
 */
export const MAX_SECURITY_FILE_BYTES = 150 * 1024 * 1024;

/**
 * Creates the missing folders one level at a time (700). Node's `mkdirSync(…, { recursive })`
 * loops forever under /proc, which would hang every command.
 */
function makeDirs(dir: string): void {
  const missing: string[] = [];
  let current = resolve(dir);
  for (let depth = 0; depth < 64 && !existsSync(current); depth++) {
    missing.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const path of missing.reverse()) {
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (err) {
      // Another mm run may have created it meanwhile.
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
}

export interface FileEventLogOptions {
  /** Per-file cap (default 5 MB); debug lines are dropped from 80 % of it. */
  maxFileBytes?: number;
  /** Per-file cap for security-*.log (default 150 MB). */
  maxSecurityFileBytes?: number;
}

/** UTC midnight of a `YYYY-MM-DD` name date, or null when it isn't a real date. */
export function nameDateMs(date: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const ms = Date.parse(`${date}T00:00:00.000Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== date) return null;
  return ms;
}

/**
 * Local log files: `<dir>/<kind>-<UTC date>.log`, dir 700, files 600, one synchronous write
 * per line (bin.ts ends every run with process.exit, which would drop buffered writes).
 * Never throws; `failures` counts what couldn't be written.
 */
export class FileEventLog implements EventLog {
  failures = 0;
  /** Lines not written because they exceeded MAX_LINE_BYTES. */
  dropped = 0;
  private prepared = false;
  private readonly chmodded = new Set<string>();
  private pruned = false;
  private readonly caps: Record<LogKind, number>;

  // No filesystem access here: `mm --help` must not create a folder.
  constructor(
    readonly dir: string,
    private readonly ctx: RunContext,
    options: FileEventLogOptions = {},
  ) {
    this.caps = {
      app: options.maxFileBytes ?? MAX_FILE_BYTES,
      security: options.maxSecurityFileBytes ?? MAX_SECURITY_FILE_BYTES,
    };
  }

  emit(event: LogEvent): void {
    try {
      const rendered = renderEvent(event, this.ctx);
      if (rendered === null) {
        this.dropped++;
        return;
      }
      this.appendRecord(rendered.kind, rendered.record);
    } catch {
      this.failures++;
    }
  }

  /** Writes one record to its day file (public so tests can write security/debug lines). */
  appendRecord(kind: LogKind, record: LogRecord): void {
    try {
      // Retention holds even when nothing passes the level threshold (e.g. MM_LOG_LEVEL=error).
      this.pruneOnce();
      if (!passesLevel(kind, record.level, this.ctx.level)) return;
      const line = formatLine(record, kind);
      if (lineBytes(line) > MAX_LINE_BYTES) {
        this.dropped++;
        return;
      }
      // The file name comes from the record: only a real YYYY-MM-DD date may form it.
      const date = typeof record.ts === 'string' ? record.ts.slice(0, 10) : '';
      if (nameDateMs(date) === null || !this.prepare()) {
        this.failures++;
        return;
      }
      const file = join(this.dir, `${kind}-${date}.log`);
      const size = this.fileSize(file);
      if (size === null) {
        this.failures++;
        return;
      }
      const cap = this.caps[kind];
      if (size >= cap) {
        this.writeTruncatedMarker(file, kind, record.ts);
        return;
      }
      if (record.level === 'debug' && size >= cap * 0.8) return;
      this.append(file, line);
    } catch {
      this.failures++;
    }
  }

  /**
   * Creates the folder (700) and prunes old files once per process; on every later write it
   * re-checks that the folder is still a real directory (not swapped for a symlink).
   */
  private prepare(): boolean {
    if (this.prepared) return lstatSync(this.dir).isDirectory();
    makeDirs(this.dir);
    const st = lstatSync(this.dir);
    if (!st.isDirectory()) return false; // a symlink or a file: never follow it
    if (POSIX && (st.mode & 0o777) !== 0o700) chmodSync(this.dir, 0o700);
    this.prepared = true;
    this.pruneOnce();
    return true;
  }

  /** Prunes once per process, only in an existing real folder (never creates it for this). */
  private pruneOnce(): void {
    if (this.pruned) return;
    try {
      if (!lstatSync(this.dir).isDirectory()) return;
    } catch {
      return; // no folder yet: nothing to prune
    }
    this.pruned = true;
    this.prune();
  }

  /** Deletes day files older than their retention (by the date in the name). */
  private prune(): void {
    const t = this.ctx.now();
    const today = Math.floor((Number.isFinite(t) ? t : Date.now()) / DAY_MS) * DAY_MS;
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      const match = LOG_FILE_RE.exec(name);
      if (match === null) continue;
      const date = nameDateMs(match[2] ?? '');
      if (date === null) continue;
      const kind = match[1] as LogKind;
      if ((today - date) / DAY_MS > RETENTION_DAYS[kind]) {
        try {
          rmSync(join(this.dir, name), { force: true });
        } catch {
          // A directory with a log-like name, a permission problem: leave it.
        }
      }
    }
  }

  /** Size of an existing regular file, 0 when missing, null when it's anything else. */
  private fileSize(file: string): number | null {
    try {
      const st = lstatSync(file);
      return st.isFile() ? st.size : null;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 0 : null;
    }
  }

  /**
   * `ts` is the triggering record's: the file was picked from its date, so a fresh clock
   * reading (which may be past UTC midnight) could put a marker with the wrong day in it.
   */
  private writeTruncatedMarker(file: string, kind: LogKind, ts: string): void {
    if (this.tailHasMarker(file)) return;
    // The marker bypasses the level threshold and takes the prefix of the file it goes into.
    const record = { ...toRecord({ event: 'log.truncated' }, this.ctx), ts };
    this.append(file, formatLine(record, kind));
  }

  private tailHasMarker(file: string): boolean {
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const size = fstatSync(fd).size;
      const length = Math.min(size, MAX_LINE_BYTES);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      return buffer.toString('utf8').includes(TRUNCATED_MARK);
    } finally {
      closeSync(fd);
    }
  }

  /** Opens a day file; our own read-only (e.g. 400) regular file is put back to 600 once. */
  private open(file: string, flags: number): number {
    try {
      return openSync(file, flags, 0o600);
    } catch (err) {
      if (!POSIX || (err as NodeJS.ErrnoException).code !== 'EACCES') throw err;
      if (!lstatSync(file).isFile()) throw err;
      chmodSync(file, 0o600);
      return openSync(file, flags, 0o600);
    }
  }

  /** One write per line with O_APPEND; never follows a symlink; file mode 600. */
  private append(file: string, line: string): void {
    const flags =
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0);
    const fd = this.open(file, flags);
    try {
      if (POSIX) {
        // A hard link to another file, or a file of another user: never write to it.
        const st = fstatSync(fd);
        if (st.nlink !== 1 || st.uid !== process.getuid?.()) throw new Error('foreign day file');
      }
      if (POSIX && !this.chmodded.has(file)) {
        if ((fstatSync(fd).mode & 0o777) !== 0o600) fchmodSync(fd, 0o600);
        this.chmodded.add(file);
      }
      writeSync(fd, `${line}\n`);
    } finally {
      closeSync(fd);
    }
  }
}
