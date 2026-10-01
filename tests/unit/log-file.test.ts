import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import {
  FileEventLog,
  LOG_FILE_RE,
  MAX_FILE_BYTES,
  RETENTION_DAYS,
  nameDateMs,
  parseLogLine,
  readLogs,
  toRecord,
} from '../../src/core/log/index.js';
import type { LogLevel } from '../../src/core/config.js';
import type { LogEvent, RunContext } from '../../src/core/log/index.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIXED = Date.UTC(2026, 8, 23, 10, 0, 0);
const TODAY = '2026-09-23';
const DAY_MS = 86_400_000;

const posixOnly = process.platform === 'win32' ? it.skip : it;
const isRoot = process.getuid?.() === 0;
const posixNonRoot = process.platform === 'win32' || isRoot ? it.skip : it;

const START: LogEvent = {
  event: 'command.start',
  cmd: 'keygen',
  opts: [],
  ver: '0.5.0',
  node: '22.13.0',
  os: 'linux',
};
const FAILED: LogEvent = {
  event: 'command.finish',
  cmd: 'keygen',
  outcome: 'failed',
  exit: 1,
  ms: 3,
};
const UNEXPECTED: LogEvent = { event: 'error.unexpected', errClass: 'Error', stack: [] };

function ctx(level: LogLevel = 'info', now: () => number = () => FIXED): RunContext {
  return { run: '0123456789abcdef', ver: '0.5.0', now, level };
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

function lines(file: string): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l !== '');
}

function events(file: string): string[] {
  return lines(file).map((l) => parseLogLine(l)?.record.event ?? '<unparsable>');
}

function daysAgo(n: number): string {
  return new Date(FIXED - n * DAY_MS).toISOString().slice(0, 10);
}

let root: string;
let dir: string;
let appFile: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mm-logfile-'));
  dir = join(root, 'logs');
  appFile = join(dir, `app-${TODAY}.log`);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('constants and helpers', () => {
  it('pins retention and the file cap', () => {
    expect(RETENTION_DAYS).toEqual({ app: 30, security: 90 });
    expect(MAX_FILE_BYTES).toBe(5 * 1024 * 1024);
  });

  it.each(['app-2026-09-23.log', 'security-2026-09-23.log'])('LOG_FILE_RE matches %s', (name) => {
    expect(LOG_FILE_RE.test(name)).toBe(true);
  });

  it.each([
    'notes.txt',
    'app-foo.log',
    'audit-2026-09-23.log',
    'app-2026-09-23.log.bak',
    'xapp-2026-09-23.log',
    'app-2026-9-23.log',
  ])('LOG_FILE_RE rejects %s', (name) => {
    expect(LOG_FILE_RE.test(name)).toBe(false);
  });

  it('nameDateMs parses valid UTC dates and rejects invalid ones', () => {
    expect(nameDateMs('2026-09-23')).toBe(Date.UTC(2026, 8, 23));
    expect(nameDateMs('2024-02-29')).toBe(Date.UTC(2024, 1, 29));
    for (const bad of ['2026-02-30', '2026-13-01', '2026-00-10', '2025-02-29', 'foo', '']) {
      expect(nameDateMs(bad)).toBeNull();
    }
  });
});

describe('FileEventLog: writing', () => {
  it('does not create anything until the first emit', () => {
    new FileEventLog(dir, ctx());
    expect(existsSync(dir)).toBe(false);
  });

  it('appends one parseable JSON line per event to app-<UTC date>.log', () => {
    const log = new FileEventLog(dir, ctx());
    log.emit(START);
    log.emit(FAILED);
    const content = readFileSync(appFile, 'utf8');
    expect(content.endsWith('\n')).toBe(true);
    const parsed = lines(appFile).map((l) => parseLogLine(l));
    expect(parsed.map((p) => p?.kind)).toEqual(['app', 'app']);
    expect(parsed.map((p) => p?.record.event)).toEqual(['command.start', 'command.finish']);
    expect(parsed[0]?.record).toEqual(toRecord(START, ctx()));
    expect(log.failures).toBe(0);
    expect(log.dropped).toBe(0);
  });

  it('appends across instances instead of overwriting', () => {
    new FileEventLog(dir, ctx()).emit(START);
    new FileEventLog(dir, ctx()).emit(START);
    expect(lines(appFile)).toHaveLength(2);
  });

  it('names the file by the UTC date of each record', () => {
    let t = Date.UTC(2026, 8, 23, 23, 59, 59, 999);
    const log = new FileEventLog(
      dir,
      ctx('info', () => t),
    );
    log.emit(START);
    t = Date.UTC(2026, 8, 24, 0, 0, 0, 0);
    log.emit(START);
    expect(lines(join(dir, 'app-2026-09-23.log'))).toHaveLength(1);
    expect(lines(join(dir, 'app-2026-09-24.log'))).toHaveLength(1);
  });

  posixNonRoot('creates the dir with mode 700 and the file with mode 600', () => {
    new FileEventLog(dir, ctx()).emit(START);
    expect(mode(dir)).toBe(0o700);
    expect(mode(appFile)).toBe(0o600);
  });

  posixNonRoot('tightens an existing 644 log file to 600 and keeps its content', () => {
    mkdirSync(dir, { mode: 0o700 });
    writeFileSync(appFile, '{"old":1}\n');
    chmodSync(appFile, 0o644);
    new FileEventLog(dir, ctx()).emit(START);
    expect(mode(appFile)).toBe(0o600);
    expect(lines(appFile)).toHaveLength(2);
    expect(lines(appFile)[0]).toBe('{"old":1}');
  });

  posixNonRoot('tightens an existing 755 dir to 700', () => {
    mkdirSync(dir);
    chmodSync(dir, 0o755);
    new FileEventLog(dir, ctx()).emit(START);
    expect(mode(dir)).toBe(0o700);
  });
});

describe('FileEventLog: level threshold', () => {
  it('drops debug records at info', () => {
    const log = new FileEventLog(dir, ctx('info'));
    log.appendRecord('app', { ...toRecord(START, ctx()), level: 'debug' });
    expect(lines(appFile)).toEqual([]);
  });

  it('writes debug records at debug', () => {
    const log = new FileEventLog(dir, ctx('debug'));
    log.appendRecord('app', { ...toRecord(START, ctx()), level: 'debug' });
    expect(lines(appFile)).toHaveLength(1);
  });

  it('at warn drops command.start but writes a failed command.finish', () => {
    const log = new FileEventLog(dir, ctx('warn'));
    log.emit(START);
    log.emit(FAILED);
    expect(events(appFile)).toEqual(['command.finish']);
  });

  it.each(['debug', 'info', 'warn', 'error'] as const)(
    'writes security records at %s, prefixed, into security-<date>.log',
    (level) => {
      const log = new FileEventLog(dir, ctx(level));
      log.appendRecord('security', {
        ...toRecord(START, ctx()),
        event: 'auth.login',
        level: 'info',
      });
      const secLines = lines(join(dir, `security-${TODAY}.log`));
      expect(secLines).toHaveLength(1);
      const line = secLines[0] ?? '';
      expect(line.startsWith('mm-security {')).toBe(true);
      const parsed = JSON.parse(line.slice('mm-security '.length)) as { event: string };
      expect(parsed.event).toBe('auth.login');
      expect(existsSync(appFile)).toBe(false);
    },
  );
});

describe('FileEventLog: size cap', () => {
  const MAX = 2000;

  function size(file: string): number {
    return existsSync(file) ? statSync(file).size : 0;
  }

  /** Emits START until the file reaches `target` bytes (bounded, so a bug can't hang the test). */
  function fillTo(log: FileEventLog, target: number): void {
    for (let i = 0; i < 200 && size(appFile) < target; i++) log.emit(START);
    expect(size(appFile)).toBeGreaterThanOrEqual(target);
  }

  it('past 80 % drops debug lines but still writes info lines', () => {
    const log = new FileEventLog(dir, ctx('debug'), { maxFileBytes: MAX });
    fillTo(log, MAX * 0.8);
    const before = size(appFile);
    expect(before).toBeLessThan(MAX);
    log.appendRecord('app', { ...toRecord(START, ctx()), level: 'debug' });
    expect(size(appFile)).toBe(before);
    log.emit(START);
    expect(size(appFile)).toBeGreaterThan(before);
    expect(events(appFile)).not.toContain('log.truncated');
  });

  it('at the cap writes exactly one log.truncated marker and nothing else, across instances', () => {
    const log = new FileEventLog(dir, ctx('debug'), { maxFileBytes: MAX });
    fillTo(log, MAX);
    const n = lines(appFile).length;
    expect(events(appFile)).not.toContain('log.truncated');

    for (let i = 0; i < 5; i++) log.emit(START);
    log.emit(UNEXPECTED);
    expect(lines(appFile)).toHaveLength(n + 1);
    expect(events(appFile).at(-1)).toBe('log.truncated');

    const other = new FileEventLog(dir, ctx('debug'), { maxFileBytes: MAX });
    for (let i = 0; i < 3; i++) other.emit(START);
    other.emit(UNEXPECTED);
    expect(lines(appFile)).toHaveLength(n + 1);
    expect(events(appFile).filter((e) => e === 'log.truncated')).toHaveLength(1);
  });

  it('writes the marker even at level error', () => {
    fillTo(new FileEventLog(dir, ctx('debug'), { maxFileBytes: MAX }), MAX);
    const n = lines(appFile).length;
    const quiet = new FileEventLog(dir, ctx('error'), { maxFileBytes: MAX });
    quiet.emit(UNEXPECTED);
    expect(lines(appFile)).toHaveLength(n + 1);
    expect(events(appFile).at(-1)).toBe('log.truncated');
  });

  it('the marker takes the triggering record ts: across UTC midnight it stays in its own day', async () => {
    const lastMs = Date.UTC(2026, 8, 23, 23, 59, 59, 999);
    const afterMidnight = Date.UTC(2026, 8, 24, 0, 0, 0, 1);
    let clock = lastMs;
    const log = new FileEventLog(
      dir,
      ctx('debug', () => clock),
      { maxFileBytes: MAX },
    );
    fillTo(log, MAX);
    expect(events(appFile)).not.toContain('log.truncated');

    // The record is built at 23:59:59.999; the clock passes midnight before the marker is written.
    const record = toRecord(
      FAILED,
      ctx('debug', () => lastMs),
    );
    clock = afterMidnight;
    log.appendRecord('app', record);

    const marker = lines(appFile).at(-1) ?? '';
    const parsed = parseLogLine(marker);
    expect(parsed?.record.event).toBe('log.truncated');
    expect(parsed?.record.ts).toBe(record.ts);
    expect(parsed?.record.ts.slice(0, 10)).toBe(TODAY);
    // Nothing leaked into the next day's file.
    expect(existsSync(join(dir, 'app-2026-09-24.log'))).toBe(false);

    // The reader accepts it: no skipped line, and the day counts as truncated, so the run
    // that never got its finish isn't falsely reported as interrupted.
    const read = await readLogs(dir, { now: afterMidnight + 60_000, sinceMs: 2 * DAY_MS });
    expect(read.unreadable).toBe(0);
    expect(read.unknown).toBe(0);
    expect(read.records.at(-1)?.event).toBe('log.truncated');
    expect(read.interrupted).toEqual([]);
  });

  it('drops a single line over 4096 bytes and counts it', () => {
    const log = new FileEventLog(dir, ctx('debug'));
    log.appendRecord('app', { ...toRecord(START, ctx()), pad: 'x'.repeat(5000) });
    expect(lines(appFile)).toEqual([]);
    expect(log.dropped).toBe(1);
    log.emit(START);
    expect(lines(appFile)).toHaveLength(1);
  });
});

describe('FileEventLog: pruning', () => {
  const KEEP = [
    `app-${daysAgo(30)}.log`,
    `app-${TODAY}.log`,
    `security-${daysAgo(90)}.log`,
    `security-${daysAgo(31)}.log`,
    'app-2026-10-01.log',
    'security-2030-01-01.log',
    'notes.txt',
    'app-foo.log',
    'app-2026-02-30.log',
    'security-2026-13-01.log',
  ];
  const DELETE = [
    `app-${daysAgo(31)}.log`,
    'app-2020-01-01.log',
    `security-${daysAgo(91)}.log`,
    'security-2020-01-01.log',
  ];

  function seed(names: string[]): void {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const n of names) writeFileSync(join(dir, n), '');
  }

  it('deletes app files older than 30 days and security files older than 90 days', () => {
    seed([...KEEP, ...DELETE]);
    new FileEventLog(dir, ctx()).emit(START);
    const left = readdirSync(dir);
    for (const n of KEEP) expect(left).toContain(n);
    for (const n of DELETE) expect(left).not.toContain(n);
  });

  it('prunes only on the first write of an instance', () => {
    seed([]);
    const log = new FileEventLog(dir, ctx());
    log.emit(START);
    writeFileSync(join(dir, 'app-2020-01-01.log'), '');
    log.emit(START);
    expect(existsSync(join(dir, 'app-2020-01-01.log'))).toBe(true);
    new FileEventLog(dir, ctx()).emit(START);
    expect(existsSync(join(dir, 'app-2020-01-01.log'))).toBe(false);
  });

  it('prunes when records below the threshold came first', () => {
    seed(['app-2020-01-01.log']);
    const log = new FileEventLog(dir, ctx('error'));
    log.emit(START);
    log.emit(UNEXPECTED);
    expect(existsSync(join(dir, 'app-2020-01-01.log'))).toBe(false);
  });
});

describe('FileEventLog: failures never throw', () => {
  it('parent of dir is a regular file (ENOTDIR)', () => {
    writeFileSync(join(root, 'file'), 'x');
    const log = new FileEventLog(join(root, 'file', 'logs'), ctx());
    expect(() => {
      log.emit(START);
      log.emit(START);
    }).not.toThrow();
    expect(log.failures).toBeGreaterThan(0);
    expect(readFileSync(join(root, 'file'), 'utf8')).toBe('x');
  });

  it('dir itself is a regular file', () => {
    writeFileSync(dir, 'x');
    const log = new FileEventLog(dir, ctx());
    expect(() => log.emit(START)).not.toThrow();
    expect(() => log.appendRecord('security', toRecord(START, ctx()))).not.toThrow();
    expect(log.failures).toBeGreaterThan(0);
    expect(readFileSync(dir, 'utf8')).toBe('x');
  });

  posixOnly('does not follow a symlink where the day file would be', () => {
    mkdirSync(dir, { mode: 0o700 });
    const target = join(root, 'target.txt');
    writeFileSync(target, '');
    symlinkSync(target, appFile);
    const log = new FileEventLog(dir, ctx());
    expect(() => log.emit(START)).not.toThrow();
    expect(readFileSync(target, 'utf8')).toBe('');
    expect(log.failures).toBeGreaterThan(0);
  });

  it('an unknown event object does not throw', () => {
    const log = new FileEventLog(dir, ctx());
    expect(() => log.emit({ event: 'nope' } as unknown as LogEvent)).not.toThrow();
  });
});

describe('FileEventLog: concurrency', () => {
  function worker(tag: string, n: number): Promise<number | null> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', 'tests/support/log/append-worker.ts', dir, String(n), tag],
        { cwd: REPO_ROOT, stdio: 'ignore' },
      );
      child.on('error', reject);
      child.on('exit', (code) => resolve(code));
    });
  }

  it('two processes appending 500 lines each produce 1000 intact lines', async () => {
    const codes = await Promise.all([worker('worker-a', 500), worker('worker-b', 500)]);
    expect(codes).toEqual([0, 0]);
    // Workers use the real clock: a run across midnight UTC spreads over two files.
    const all = readdirSync(dir)
      .filter((n) => n.startsWith('app-'))
      .flatMap((n) => lines(join(dir, n)));
    expect(all).toHaveLength(1000);
    const parsed = all.map((l) => parseLogLine(l));
    expect(parsed.every((p) => p !== null)).toBe(true);
    const cmds = parsed.map((p) => p?.record['cmd']);
    expect(cmds.filter((c) => c === 'worker-a')).toHaveLength(500);
    expect(cmds.filter((c) => c === 'worker-b')).toHaveLength(500);
  }, 60_000);
});

describe('FileEventLog: review fixes', () => {
  const linuxOnly = process.platform === 'linux' ? it : it.skip;

  /** Every regular file below `base`, relative to it. */
  function filesUnder(base: string): string[] {
    return readdirSync(base, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => join(d.parentPath, d.name));
  }

  linuxOnly('gives up quickly on an uncreatable folder under /proc', () => {
    const log = new FileEventLog('/proc/self/nope/logs', ctx());
    const t0 = performance.now();
    log.emit(START);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(log.failures).toBeGreaterThan(0);
  });

  posixOnly('does not append to a hard-linked day file', () => {
    mkdirSync(dir, { mode: 0o700 });
    const outside = join(root, 'outside.txt');
    writeFileSync(outside, 'x');
    linkSync(outside, appFile);
    const log = new FileEventLog(dir, ctx());
    expect(() => log.appendRecord('app', toRecord(START, ctx()))).not.toThrow();
    expect(readFileSync(outside, 'utf8')).toBe('x');
    expect(log.failures).toBeGreaterThan(0);
  });

  it.each(['../../../x', '2026-13-45T10:00:00.000Z', 'not a date', ''])(
    'refuses a record whose ts is %j',
    (ts) => {
      const log = new FileEventLog(dir, ctx());
      expect(() => log.appendRecord('app', { ...toRecord(START, ctx()), ts })).not.toThrow();
      expect(filesUnder(root)).toEqual([]);
      expect(existsSync(join(root, '..', 'x'))).toBe(false);
      expect(log.failures).toBeGreaterThan(0);
    },
  );

  posixOnly('does not write through a symlinked logs folder', () => {
    const target = join(root, 'target');
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, dir);
    const log = new FileEventLog(dir, ctx());
    expect(() => log.emit(START)).not.toThrow();
    expect(readdirSync(target)).toEqual([]);
    expect(log.failures).toBeGreaterThan(0);
  });

  posixOnly('does not follow a folder swapped for a symlink after the first write', () => {
    const log = new FileEventLog(dir, ctx());
    log.emit(START);
    expect(lines(appFile)).toHaveLength(1);
    const target = join(root, 'target');
    mkdirSync(target, { mode: 0o700 });
    renameSync(dir, join(root, 'logs-old'));
    symlinkSync(target, dir);
    expect(() => {
      log.emit(START);
      log.emit(FAILED);
    }).not.toThrow();
    expect(readdirSync(target)).toEqual([]);
  });

  it('writes the log.truncated marker into a security file with the mm-security prefix', () => {
    // Security files have their own cap (M1b-4b).
    const log = new FileEventLog(dir, ctx(), { maxSecurityFileBytes: 2000 });
    const secFile = join(dir, `security-${TODAY}.log`);
    const rec = { ...toRecord(START, ctx()), event: 'auth.login' };
    for (let i = 0; i < 200 && (existsSync(secFile) ? statSync(secFile).size : 0) < 2000; i++) {
      log.appendRecord('security', rec);
    }
    expect(statSync(secFile).size).toBeGreaterThanOrEqual(2000);
    const n = lines(secFile).length;
    log.appendRecord('security', rec);
    const all = lines(secFile);
    expect(all).toHaveLength(n + 1);
    const last = all.at(-1) ?? '';
    expect(last.startsWith('mm-security {')).toBe(true);
    expect(parseLogLine(last)).toMatchObject({
      kind: 'security',
      record: { event: 'log.truncated' },
    });
  });

  posixNonRoot('makes a read-only (400) day file writable again and writes to it', () => {
    mkdirSync(dir, { mode: 0o700 });
    writeFileSync(appFile, '');
    chmodSync(appFile, 0o400);
    const log = new FileEventLog(dir, ctx());
    log.emit(START);
    expect(lines(appFile)).toHaveLength(1);
    expect(mode(appFile)).toBe(0o600);
    expect(log.failures).toBe(0);
  });
});
