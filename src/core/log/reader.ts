import { constants } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import type { LogLevel } from '../config.js';
import { validateRecord } from './event-schemas.js';
import { LEVEL_ORDER, type LogKind } from './events.js';
import { MAX_SECURITY_FILE_BYTES, nameDateMs } from './file-event-log.js';
import { listDayFiles, type DayFile, type LogFolderStatus } from './files.js';
import { MAX_LINE_BYTES, SECURITY_PREFIX, type LogRecord } from './record.js';
import { parseLogLine } from './schema.js';

// Reads the local day files back for `mm logs`. The files are untrusted input: only regular
// files are opened (never through a symlink, never a FIFO), lines are split by bytes with a
// cap, so a huge or endless line can't exhaust memory, and every line must pass its event's
// strict schema. Core returns records; the CLI decides how to print them.

const DAY_MS = 86_400_000;
const CHUNK_BYTES = 64 * 1024;
/** Longest line the writer can produce: prefix + JSON cap + a `\r` from a CRLF editor. */
const MAX_READ_LINE_BYTES = MAX_LINE_BYTES + SECURITY_PREFIX.length + 1;
export const DEFAULT_SINCE_MS = DAY_MS;
export const DEFAULT_MAX_RECORDS = 5000;
/**
 * No real day file is larger than the writer's cap (150 MB security, 5 MB app) plus a line or
 * two: anything bigger (e.g. a sparse file of terabytes) is skipped instead of read for hours.
 */
export const MAX_READ_FILE_BYTES = MAX_SECURITY_FILE_BYTES + 1024 * 1024;
/**
 * Runs tracked for cmd lookup and interrupted detection. Real use is a few runs a day; a
 * forged file with a new run id per line would otherwise grow the map without bound.
 */
export const MAX_TRACKED_RUNS = 100_000;

export interface ReadLogsOptions {
  now: number;
  /** Window length; default 24 h. With `run` and no `sinceMs`, all retained files are read. */
  sinceMs?: number;
  /** Minimum level (default info). */
  level?: LogLevel;
  securityOnly?: boolean;
  /** Only this run's records. */
  run?: string;
  /** The reading run itself: excluded everywhere (records, runs, interrupted). */
  ownRun?: string;
  /** Keep only the newest N matching records (default 5,000). */
  maxRecords?: number;
}

export interface RunInfo {
  /** From `command.start` (or the finish, when the start is outside the scanned files). */
  cmd: string;
  started: boolean;
  finished: boolean;
  /** Timestamp of the run's last record. */
  lastTs: string;
  /** The day of its last record hit a file cap: a missing finish proves nothing. */
  truncatedDay: boolean;
}

export interface InterruptedRun {
  run: string;
  cmd: string;
  /** The run's last record: when it was last seen. */
  ts: string;
}

export interface ReadResult {
  /** Whether the log folder could be read (`missing`: no logs yet). */
  folder: LogFolderStatus;
  /** Matching records, oldest first. */
  records: LogRecord[];
  /** Every run of the scanned files, before filtering. */
  runs: Map<string, RunInfo>;
  /** Runs with a start and no finish, inside the window and the filters. */
  interrupted: InterruptedRun[];
  /** Lines that failed validation (tampered, broken, over-long, not UTF-8). */
  unreadable: number;
  /** Records of another schema version or an event this version doesn't know. */
  unknown: number;
  /** Older matching records (and interrupted markers) dropped by `maxRecords`. */
  omitted: number;
  /** Day-file names that aren't a readable regular file (symlink, FIFO, folder, no access, too large). */
  skippedFiles: number;
  /** More runs than MAX_TRACKED_RUNS: interrupted runs aren't marked. */
  runsCapped: boolean;
}

function emptyResult(folder: LogFolderStatus): ReadResult {
  return {
    folder,
    records: [],
    runs: new Map(),
    interrupted: [],
    unreadable: 0,
    unknown: 0,
    omitted: 0,
    skippedFiles: 0,
    runsCapped: false,
  };
}

/** Day files grouped by UTC date, oldest first (app before security within a day). */
function byDay(files: readonly DayFile[]): Map<string, DayFile[]> {
  const days = new Map<string, DayFile[]>();
  for (const file of files) days.set(file.date, [...(days.get(file.date) ?? []), file]);
  return days;
}

/** Opens a regular file without following a symlink or blocking on a FIFO; null otherwise. */
async function openRegular(path: string): Promise<FileHandle | null> {
  try {
    if (!(await lstat(path)).isFile()) return null;
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
    const handle = await open(path, flags);
    // Swapped for something else between lstat and open (e.g. a FIFO), or far too large.
    const st = await handle.stat();
    if (!st.isFile() || st.size > MAX_READ_FILE_BYTES) {
      await handle.close();
      return null;
    }
    return handle;
  } catch {
    return null;
  }
}

/** A read of the file itself failed (not a problem with its content). */
class ReadFailure extends Error {}

/**
 * Calls `onLine` for every line of the file, split on `\n` by bytes. A line longer than
 * `MAX_READ_LINE_BYTES` is dropped while it streams (memory stays at chunk + cap) and counted
 * once via `onOversized`.
 */
async function forEachLine(
  handle: FileHandle,
  onLine: (bytes: Buffer) => void,
  onOversized: () => void,
): Promise<void> {
  const chunk = Buffer.alloc(CHUNK_BYTES);
  let parts: Buffer[] = [];
  let pending = 0;
  let oversized = false;
  const take = (piece: Buffer): void => {
    if (oversized || piece.length === 0) return;
    if (pending + piece.length > MAX_READ_LINE_BYTES) {
      oversized = true;
      parts = [];
      pending = 0;
      onOversized();
      return;
    }
    parts.push(Buffer.from(piece)); // a copy: the chunk buffer is reused
    pending += piece.length;
  };
  const end = (): void => {
    if (!oversized && pending > 0) onLine(Buffer.concat(parts, pending));
    parts = [];
    pending = 0;
    oversized = false;
  };
  // Never more than MAX_READ_FILE_BYTES, even if the file grows while it is read.
  for (let total = 0; total < MAX_READ_FILE_BYTES;) {
    let bytesRead: number;
    try {
      ({ bytesRead } = await handle.read(chunk, 0, CHUNK_BYTES, null));
    } catch {
      throw new ReadFailure();
    }
    if (bytesRead === 0) break;
    total += bytesRead;
    const data = chunk.subarray(0, bytesRead);
    let start = 0;
    for (let nl = data.indexOf(10, start); nl !== -1; nl = data.indexOf(10, start)) {
      take(data.subarray(start, nl));
      end();
      start = nl + 1;
    }
    take(data.subarray(start));
  }
  end(); // a last line without `\n`
}

function dayOf(ts: string): string {
  return ts.slice(0, 10);
}

/**
 * Reads the day files in the window (by the UTC date in their names), one UTC day at a time:
 * that day's app and security records are merged and sorted by time, and only the newest
 * `maxRecords` matches are kept. Never throws for file content; a missing folder is empty.
 */
export async function readLogs(dir: string, opts: ReadLogsOptions): Promise<ReadResult> {
  const list = await listDayFiles(dir);
  const result = emptyResult(list.status);
  // App first: a run's start (its cmd) is known before its security lines are read.
  const days = byDay(list.files);

  const timeFiltered = opts.sinceMs !== undefined || opts.run === undefined;
  const sinceMs = opts.sinceMs ?? DEFAULT_SINCE_MS;
  const from = opts.now - sinceMs;
  const fromDay = Math.floor(from / DAY_MS) * DAY_MS;
  const toDay = Math.floor(opts.now / DAY_MS) * DAY_MS;
  const threshold = LEVEL_ORDER[opts.level ?? 'info'];
  const max = Math.max(1, opts.maxRecords ?? DEFAULT_MAX_RECORDS);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const truncatedDays = new Set<string>();
  const runs = result.runs;

  const inWindow = (ts: string): boolean => !timeFiltered || Date.parse(ts) >= from;
  const matches = (record: LogRecord, kind: LogKind): boolean =>
    inWindow(record.ts) &&
    LEVEL_ORDER[record.level] >= threshold &&
    (!opts.securityOnly || kind === 'security') &&
    (opts.run === undefined || record.run === opts.run);

  const noteRun = (record: LogRecord): void => {
    let info = runs.get(record.run);
    if (info === undefined) {
      // Only a start or a finish (app lines) opens an entry; other lines update known runs.
      if (record.event !== 'command.start' && record.event !== 'command.finish') return;
      if (runs.size >= MAX_TRACKED_RUNS) {
        result.runsCapped = true;
        return;
      }
      info = { cmd: '', started: false, finished: false, lastTs: record.ts, truncatedDay: false };
      runs.set(record.run, info);
    }
    if (record.event === 'command.start') {
      info.started = true;
      info.cmd = record['cmd'] as string;
    } else if (record.event === 'command.finish') {
      info.finished = true;
      if (!info.started) info.cmd = record['cmd'] as string;
    }
    if (Date.parse(record.ts) >= Date.parse(info.lastTs)) info.lastTs = record.ts;
  };

  for (const [date, files] of days) {
    const dayMs = nameDateMs(date) ?? 0;
    if (timeFiltered && (dayMs < fromDay || dayMs > toDay)) continue;
    let dayRecords: LogRecord[] = [];
    const trim = (keep: number): void => {
      sortByTime(dayRecords);
      const drop = dayRecords.length - keep;
      if (drop > 0) {
        result.omitted += drop;
        dayRecords = dayRecords.slice(drop);
      }
    };
    for (const file of files) {
      const handle = await openRegular(file.path);
      if (handle === null) {
        result.skippedFiles++;
        continue;
      }
      try {
        await forEachLine(
          handle,
          (bytes) => {
            let text: string;
            try {
              text = decoder.decode(bytes);
            } catch {
              result.unreadable++;
              return;
            }
            if (text.endsWith('\r')) text = text.slice(0, -1);
            if (text === '') return;
            const parsed = parseLogLine(text);
            if (parsed === null) {
              result.unreadable++;
              return;
            }
            const checked = validateRecord(parsed, file.kind, file.date);
            if ('skipped' in checked) {
              result[checked.skipped]++;
              return;
            }
            const record = checked.record;
            if (record.event === 'log.truncated') truncatedDays.add(date);
            if (record.run === opts.ownRun) return;
            noteRun(record);
            if (!matches(record, file.kind)) return;
            dayRecords.push(record);
            if (dayRecords.length >= 2 * max) trim(max);
          },
          () => {
            result.unreadable++;
          },
        );
      } catch (err) {
        if (!(err instanceof ReadFailure)) throw err;
        result.skippedFiles++; // a read error mid-file: what was read so far is kept
      } finally {
        await handle.close().catch(() => undefined);
      }
    }
    trim(max);
    result.records.push(...dayRecords);
    if (result.records.length > max) {
      const drop = result.records.length - max;
      result.omitted += drop;
      result.records = result.records.slice(drop);
    }
  }

  for (const info of runs.values()) info.truncatedDay = truncatedDays.has(dayOf(info.lastTs));
  const showInterrupted = !opts.securityOnly && threshold <= LEVEL_ORDER.warn && !result.runsCapped;
  if (showInterrupted) {
    for (const [run, info] of runs) {
      if (!info.started || info.finished || info.truncatedDay) continue;
      if (opts.run !== undefined && run !== opts.run) continue;
      if (!inWindow(info.lastTs)) continue;
      result.interrupted.push({ run, cmd: info.cmd, ts: info.lastTs });
    }
    result.interrupted.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  }
  capCombined(result, max);
  return result;
}

/**
 * Records and interrupted markers are printed together: keep only the newest `max` of both,
 * dropping the oldest of either list first (both are sorted oldest first).
 */
function capCombined(result: ReadResult, max: number): void {
  let drop = result.records.length + result.interrupted.length - max;
  if (drop <= 0) return;
  let r = 0;
  let i = 0;
  while (drop > 0) {
    const record = result.records[r];
    const marker = result.interrupted[i];
    if (marker === undefined || (record !== undefined && record.ts <= marker.ts)) r++;
    else i++;
    drop--;
  }
  result.omitted += r + i;
  result.records = result.records.slice(r);
  result.interrupted = result.interrupted.slice(i);
}

/** Stable sort by time (equal times keep file order: app before security). */
function sortByTime(records: LogRecord[]): void {
  records.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}
