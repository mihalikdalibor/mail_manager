import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import type { LogLevel } from '../../src/core/config.js';
import type { CheckResult } from '../../src/core/doctor.js';
import {
  FileEventLog,
  MAX_FILE_BYTES,
  MAX_SECURITY_FILE_BYTES,
  checkLogs,
  parseLogLine,
  toRecord,
  type LogEvent,
  type LogRecord,
  type RunContext,
} from '../../src/core/log/index.js';

// M1b-4b follow-ups: per-kind file caps, prune-once without writing, checkLogs ancestor walk
// and today's security file (spec).

const FIXED = Date.UTC(2026, 8, 23, 10, 0, 0);
const TODAY = '2026-09-23';
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

function ctx(level: LogLevel = 'info'): RunContext {
  return { run: '0123456789abcdef', ver: '0.5.0', now: () => FIXED, level };
}

const SEC: LogRecord = {
  ...toRecord({ event: 'auth.logout', outcome: 'logged-out' }, ctx()),
};

let root: string;
let dir: string;
let appFile: string;
let secFile: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mm-logcaps-'));
  dir = join(root, 'logs');
  appFile = join(dir, `app-${TODAY}.log`);
  secFile = join(dir, `security-${TODAY}.log`);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function size(file: string): number {
  return existsSync(file) ? statSync(file).size : 0;
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

function fillSecurity(log: FileEventLog, target: number): void {
  for (let i = 0; i < 1000 && size(secFile) < target; i++) log.appendRecord('security', SEC);
  expect(size(secFile)).toBeGreaterThanOrEqual(target);
}

function fillApp(log: FileEventLog, target: number): void {
  for (let i = 0; i < 1000 && size(appFile) < target; i++) log.emit(START);
  expect(size(appFile)).toBeGreaterThanOrEqual(target);
}

describe('FileEventLog: per-kind caps', () => {
  const APP_MAX = 2000;
  const SEC_MAX = 6000;

  it('security lines use maxSecurityFileBytes, not maxFileBytes', () => {
    const log = new FileEventLog(dir, ctx(), {
      maxFileBytes: APP_MAX,
      maxSecurityFileBytes: SEC_MAX,
    });
    fillSecurity(log, APP_MAX + 500);
    expect(events(secFile)).not.toContain('log.truncated');
    fillSecurity(log, SEC_MAX);
    const n = lines(secFile).length;
    for (let i = 0; i < 5; i++) log.appendRecord('security', SEC);
    expect(lines(secFile)).toHaveLength(n + 1);
    const last = lines(secFile).at(-1) ?? '';
    expect(last.startsWith('mm-security {')).toBe(true);
    expect(parseLogLine(last)).toMatchObject({
      kind: 'security',
      record: { event: 'log.truncated' },
    });
    expect(events(secFile).filter((e) => e === 'log.truncated')).toHaveLength(1);
    // The app file is untouched by the security cap.
    expect(existsSync(appFile)).toBe(false);
  });

  it('the security file is not capped at maxFileBytes by default', () => {
    const log = new FileEventLog(dir, ctx(), { maxFileBytes: APP_MAX });
    fillSecurity(log, APP_MAX * 3);
    expect(events(secFile)).not.toContain('log.truncated');
  });

  it('an app file at its cap does not stop security lines', () => {
    const log = new FileEventLog(dir, ctx(), {
      maxFileBytes: APP_MAX,
      maxSecurityFileBytes: SEC_MAX,
    });
    fillApp(log, APP_MAX);
    log.emit(START);
    expect(events(appFile).at(-1)).toBe('log.truncated');
    const appSize = size(appFile);

    log.emit({ event: 'auth.logout', outcome: 'logged-out' });
    log.appendRecord('security', SEC);
    expect(events(secFile)).toEqual(['auth.logout', 'auth.logout']);
    expect(size(appFile)).toBe(appSize);
    expect(events(appFile).filter((e) => e === 'log.truncated')).toHaveLength(1);
  });

  it('a security file at its cap does not stop app lines', () => {
    const log = new FileEventLog(dir, ctx(), {
      maxFileBytes: SEC_MAX,
      maxSecurityFileBytes: APP_MAX,
    });
    fillSecurity(log, APP_MAX);
    log.appendRecord('security', SEC);
    expect(events(secFile).at(-1)).toBe('log.truncated');
    log.emit(START);
    expect(events(appFile)).toEqual(['command.start']);
  });

  it('the 80 % debug drop uses each kind’s own cap', () => {
    const log = new FileEventLog(dir, ctx('debug'), {
      maxFileBytes: SEC_MAX,
      maxSecurityFileBytes: APP_MAX,
    });
    // Security file past 80 % of its (small) cap; app file empty.
    fillSecurity(log, APP_MAX * 0.8);
    expect(size(secFile)).toBeLessThan(APP_MAX);
    log.appendRecord('app', { ...toRecord(START, ctx()), level: 'debug' });
    expect(lines(appFile)).toHaveLength(1);

    const before = size(secFile);
    log.appendRecord('security', { ...SEC, level: 'debug' });
    expect(size(secFile)).toBe(before);
    log.appendRecord('security', SEC);
    expect(size(secFile)).toBeGreaterThan(before);
  });
});

describe('FileEventLog: prune once without writing', () => {
  function seed(names: string[]): void {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const n of names) writeFileSync(join(dir, n), '');
  }

  it('at level error a filtered emit prunes old files and writes nothing', () => {
    seed(['app-2020-01-01.log', 'security-2020-01-01.log', `app-2026-09-20.log`, 'notes.txt']);
    const log = new FileEventLog(dir, ctx('error'));
    log.emit(START);
    expect(readdirSync(dir).sort()).toEqual(['app-2026-09-20.log', 'notes.txt']);
    expect(existsSync(appFile)).toBe(false);
  });

  it('a filtered appendRecord (debug at info) prunes too', () => {
    seed(['app-2020-01-01.log']);
    const log = new FileEventLog(dir, ctx('info'));
    log.appendRecord('app', { ...toRecord(START, ctx()), level: 'debug' });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('prunes only on the first call, even when every call is filtered', () => {
    seed([]);
    const log = new FileEventLog(dir, ctx('error'));
    log.emit(START);
    writeFileSync(join(dir, 'app-2020-01-01.log'), '');
    log.emit(START);
    expect(existsSync(join(dir, 'app-2020-01-01.log'))).toBe(true);
  });

  it('a missing folder is not created just to prune', () => {
    const log = new FileEventLog(dir, ctx('error'));
    log.emit(START);
    log.appendRecord('app', { ...toRecord(START, ctx()), level: 'debug' });
    expect(existsSync(dir)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });

  it('a missing folder is still created by a line that passes the level', () => {
    const log = new FileEventLog(dir, ctx('error'));
    log.emit(START);
    log.emit({ event: 'auth.logout', outcome: 'not-logged-in' });
    expect(events(secFile)).toEqual(['auth.logout']);
  });

  posixOnly('does not prune through a symlinked folder', () => {
    const target = join(root, 'target');
    mkdirSync(target, { mode: 0o700 });
    writeFileSync(join(target, 'app-2020-01-01.log'), '');
    symlinkSync(target, dir);
    const log = new FileEventLog(dir, ctx('error'));
    log.emit(START);
    expect(readdirSync(target)).toEqual(['app-2020-01-01.log']);
  });

  it('a regular file where the folder should be is left alone', () => {
    writeFileSync(dir, 'x');
    const log = new FileEventLog(dir, ctx('error'));
    expect(() => log.emit(START)).not.toThrow();
    expect(readFileSync(dir, 'utf8')).toBe('x');
  });
});

describe('checkLogs: missing folder at warn/error walks up to an existing ancestor', () => {
  function check(logDir: string, env: Record<string, string>): CheckResult {
    const r = checkLogs(logDir, env, { now: () => FIXED, posix: process.platform !== 'win32' });
    expect(r.name).toBe('logs');
    expect(r.detail).not.toContain(root);
    return r;
  }

  it.each(['warn', 'error'])(
    'a fresh home (several missing levels) → ok "no logs yet" at %s',
    (level) => {
      const r = check(join(root, 'home', '.config', 'mail-manager', 'logs'), {
        MM_LOG_LEVEL: level,
      });
      expect(r.status).toBe('ok');
      expect(r.detail).toContain('no logs yet');
    },
  );

  it.each(['info', 'debug'])('the same missing folder still warns at %s', (level) => {
    const r = check(join(root, 'home', '.config', 'mail-manager', 'logs'), {
      MM_LOG_LEVEL: level,
    });
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('not being written');
  });

  it('a config dir under a regular file → warn', () => {
    writeFileSync(join(root, 'file'), 'x');
    const r = check(join(root, 'file', 'mm', 'logs'), { MM_LOG_LEVEL: 'warn' });
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('not being written');
  });

  it('the config dir itself is a regular file → warn', () => {
    writeFileSync(join(root, 'mm'), 'x');
    const r = check(join(root, 'mm', 'logs'), { MM_LOG_LEVEL: 'error' });
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('not being written');
  });

  posixNonRoot('under a read-only directory → warn', () => {
    const ro = join(root, 'ro');
    mkdirSync(ro);
    chmodSync(ro, 0o500);
    try {
      const r = check(join(ro, 'mm', 'logs'), { MM_LOG_LEVEL: 'warn' });
      expect(r.status).toBe('warn');
      expect(r.detail).toContain('not being written');
    } finally {
      chmodSync(ro, 0o700);
    }
  });

  posixOnly('a symlinked ancestor that points at a writable directory → ok', () => {
    const real = join(root, 'real-home');
    mkdirSync(real);
    symlinkSync(real, join(root, 'link-home'));
    const r = check(join(root, 'link-home', 'mail-manager', 'logs'), { MM_LOG_LEVEL: 'warn' });
    expect(r.status).toBe('ok');
    expect(r.detail).toContain('no logs yet');
  });
});

describe("checkLogs: today's security file", () => {
  function healthyDir(): void {
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o700);
  }

  function check(): CheckResult {
    return checkLogs(dir, {}, { now: () => FIXED, posix: process.platform !== 'win32' });
  }

  it('a normal security file is ok', () => {
    healthyDir();
    writeFileSync(secFile, '', { mode: 0o600 });
    chmodSync(secFile, 0o600);
    expect(check().status).toBe('ok');
  });

  it('a directory in its place → warn "not being written"', () => {
    healthyDir();
    mkdirSync(secFile);
    const r = check();
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('not being written');
  });

  posixOnly('a symlink in its place → warn "not being written"', () => {
    healthyDir();
    const target = join(root, 'elsewhere.log');
    writeFileSync(target, '');
    symlinkSync(target, secFile);
    const r = check();
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('not being written');
    expect(r.detail).not.toContain(root);
  });
});

describe('checkLogs: missing folder at warn/error — broken paths (review round 2)', () => {
  function check(logDir: string, level: string): CheckResult {
    const r = checkLogs(
      logDir,
      { MM_LOG_LEVEL: level },
      {
        now: () => FIXED,
        posix: process.platform !== 'win32',
      },
    );
    expect(r.name).toBe('logs');
    expect(r.detail).not.toContain(root);
    return r;
  }

  const LEVELS = ['warn', 'error'];

  it.each(LEVELS)('a fresh deep missing path → ok, detail exactly "no logs yet" (%s)', (level) => {
    const r = check(join(root, 'a', 'b', 'c', 'mail-manager', 'logs'), level);
    expect(r.status).toBe('ok');
    expect(r.detail).toBe('no logs yet');
  });

  posixOnly.each(LEVELS)('<logDir> is a dangling symlink → warn (%s)', (level) => {
    symlinkSync(join(root, 'missing-target'), dir);
    const r = check(dir, level);
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('not being written');
  });

  posixOnly.each(LEVELS)('an ancestor is a symlink loop → warn (%s)', (level) => {
    symlinkSync(join(root, 'b'), join(root, 'a'));
    symlinkSync(join(root, 'a'), join(root, 'b'));
    const r = check(join(root, 'a', 'mail-manager', 'logs'), level);
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('not being written');
  });

  posixOnly.each(LEVELS)('an ancestor is a dangling symlink → warn (%s)', (level) => {
    symlinkSync(join(root, 'nowhere'), join(root, 'home'));
    const r = check(join(root, 'home', 'mail-manager', 'logs'), level);
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('not being written');
  });
});

describe('FileEventLog: security cap default (review round 2)', () => {
  const FIVE_MIB = 5 * 1024 * 1024;

  it('MAX_SECURITY_FILE_BYTES is 150 MiB; MAX_FILE_BYTES stays 5 MiB', () => {
    expect(MAX_SECURITY_FILE_BYTES).toBe(150 * 1024 * 1024);
    expect(MAX_FILE_BYTES).toBe(FIVE_MIB);
  });

  function preexisting(file: string): void {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Newline-terminated filler, so appended lines start on their own line.
    const buf = Buffer.alloc(FIVE_MIB + 1, 0x78);
    buf[buf.length - 1] = 0x0a;
    writeFileSync(file, buf, { mode: 0o600 });
  }

  function lastLine(file: string): string {
    const text = readFileSync(file, 'utf8');
    const all = text.split('\n').filter((l) => l !== '');
    return all.at(-1) ?? '';
  }

  it('a 5 MiB + 1 security day file still gets the next security line', () => {
    preexisting(secFile);
    const log = new FileEventLog(dir, ctx());
    log.emit({ event: 'auth.logout', outcome: 'logged-out' });
    const last = lastLine(secFile);
    expect(last.startsWith('mm-security {')).toBe(true);
    expect(parseLogLine(last)?.record.event).toBe('auth.logout');
    expect(readFileSync(secFile, 'utf8')).not.toContain('log.truncated');
    expect(size(secFile)).toBeGreaterThan(FIVE_MIB + 1);
  });

  it('a 5 MiB + 1 app day file gets the log.truncated marker instead', () => {
    preexisting(appFile);
    const log = new FileEventLog(dir, ctx());
    log.emit(START);
    log.emit(START);
    const last = lastLine(appFile);
    expect(parseLogLine(last)?.record.event).toBe('log.truncated');
    expect(readFileSync(appFile, 'utf8')).not.toContain('command.start');
  });
});
