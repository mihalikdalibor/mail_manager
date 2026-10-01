import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import {
  DEFAULT_MAX_RECORDS,
  DEFAULT_SINCE_MS,
  FileEventLog,
  MAX_LINE_BYTES,
  MAX_READ_FILE_BYTES,
  MAX_TRACKED_RUNS,
  SECURITY_PREFIX,
  authLogout,
  commandFinish,
  commandStart,
  doctorCheck,
  guardBlock,
  imapLogin,
  readLogs,
  renderEvent,
  toRecord,
  unexpectedError,
} from '../../src/core/log/index.js';
import type {
  LogEvent,
  ReadLogsOptions,
  ReadResult,
  RunContext,
} from '../../src/core/log/index.js';

// M1b-4c reader (spec): day files are untrusted input; only regular files in the window are
// read, line by line with a byte cap, validated, filtered and merged by time.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 8, 29, 12, 0, 0);
const TODAY = '2026-09-29';
const RT = { ver: '0.6.0', node: '22.13.0', os: 'linux' };
const IP = '203.0.113.7';
const TARGET = 'c3'.repeat(32);

const posixOnly = process.platform === 'win32' ? it.skip : it;
const posixNonRoot = process.platform === 'win32' || process.getuid?.() === 0 ? it.skip : it;

const RUN_A = 'aaaaaaaaaaaaaaaa';
const RUN_B = 'bbbbbbbbbbbbbbbb';
const RUN_C = 'cccccccccccccccc';
const OWN = '0000000000000000';

let root: string;
let dir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mm-logreader-'));
  dir = join(root, 'logs');
});

afterEach(() => {
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Not there or not ours.
  }
  rmSync(root, { recursive: true, force: true });
});

function ctx(run: string, at: number): RunContext {
  return { run, ver: '0.6.0', now: () => at, level: 'debug' };
}

/** Writes one event through the real writer; it lands in the file for the UTC date of `at`. */
function emit(run: string, at: number, event: LogEvent, target = dir): void {
  const log = new FileEventLog(target, ctx(run, at));
  log.emit(event);
  expect(log.failures + log.dropped).toBe(0);
}

function line(run: string, at: number, event: LogEvent): string {
  const rendered = renderEvent(event, ctx(run, at));
  if (rendered === null) throw new Error('not rendered');
  return rendered.line;
}

const start = (cmd = 'keygen'): LogEvent => commandStart(cmd, [], RT);
const finish = (cmd = 'keygen', exit = 0): LogEvent => commandFinish(cmd, exit, 5);
const logout: LogEvent = authLogout('logged-out');
const permanentBlock: LogEvent = guardBlock({
  kind: 'permanent',
  reason: 'auth-failed',
  ip: IP,
  addr: IP,
  attempts: 5,
  until: null,
  target: TARGET,
});

function read(opts: Partial<ReadLogsOptions> = {}, folder = dir): Promise<ReadResult> {
  return readLogs(folder, { now: NOW, ...opts });
}

function summary(r: ReadResult): string[] {
  return r.records.map((rec) => `${rec.run.slice(0, 1)}:${rec.event}@${rec.ts}`);
}

function expectEmpty(r: ReadResult): void {
  expect(r.records).toEqual([]);
  expect(r.runs.size).toBe(0);
  expect(r.interrupted).toEqual([]);
  expect(r.unreadable).toBe(0);
  expect(r.unknown).toBe(0);
  expect(r.omitted).toBe(0);
  expect(r.skippedFiles).toBe(0);
}

function appFile(date = TODAY): string {
  return join(dir, `app-${date}.log`);
}

function securityFile(date = TODAY): string {
  return join(dir, `security-${date}.log`);
}

describe('constants', () => {
  it('default window 24 h and cap 5000', () => {
    expect(DEFAULT_SINCE_MS).toBe(DAY);
    expect(DEFAULT_MAX_RECORDS).toBe(5000);
  });
});

describe('folder', () => {
  it('missing folder → empty result', async () => {
    expectEmpty(await read());
  });

  it('a regular file instead of the folder → empty result', async () => {
    writeFileSync(dir, line(RUN_A, NOW - HOUR, start()));
    expectEmpty(await read());
  });

  posixOnly('a symlinked folder → empty result (never followed)', async () => {
    const real = join(root, 'real-logs');
    emit(RUN_A, NOW - HOUR, start(), real);
    symlinkSync(real, dir);
    expectEmpty(await read());
  });

  it('an empty folder → empty result', async () => {
    mkdirSync(dir);
    expectEmpty(await read());
  });
});

describe('window and filters', () => {
  it('default 24 h: by name date and by ts', async () => {
    emit(RUN_A, NOW - HOUR, start());
    emit(RUN_A, NOW - HOUR + 1000, finish());
    emit(RUN_B, NOW - 23 * HOUR, start('doctor')); // yesterday 13:00, inside
    emit(RUN_B, NOW - 23 * HOUR + 1000, finish('doctor'));
    emit(RUN_C, NOW - 25 * HOUR, start('login')); // yesterday 11:00, outside
    emit(RUN_C, NOW - 25 * HOUR + 1000, finish('login'));
    emit(RUN_C, NOW - 3 * DAY, start('logout')); // file not in the window
    const r = await read();
    expect(summary(r)).toEqual([
      `b:command.start@${new Date(NOW - 23 * HOUR).toISOString()}`,
      `b:command.finish@${new Date(NOW - 23 * HOUR + 1000).toISOString()}`,
      `a:command.start@${new Date(NOW - HOUR).toISOString()}`,
      `a:command.finish@${new Date(NOW - HOUR + 1000).toISOString()}`,
    ]);
    expect(r.unreadable).toBe(0);
  });

  it('a record exactly at now - sinceMs is included', async () => {
    emit(RUN_A, NOW - 30 * 60_000, start());
    emit(RUN_A, NOW - 30 * 60_000 - 1, doctorCheck('node', 'ok'));
    const r = await read({ sinceMs: 30 * 60_000 });
    expect(r.records.map((x) => x.event)).toEqual(['command.start']);
  });

  it('sinceMs 7 days reads a week of files', async () => {
    for (let d = 0; d <= 8; d++) emit(RUN_A, NOW - d * DAY - HOUR, doctorCheck('node', 'ok'));
    const r = await read({ sinceMs: 7 * DAY });
    expect(r.records).toHaveLength(7);
    expect(r.records[0]?.ts).toBe(new Date(NOW - 6 * DAY - HOUR).toISOString());
  });

  it('files with an impossible date or another name are ignored', async () => {
    mkdirSync(dir, { mode: 0o700 });
    const valid = line(RUN_A, NOW - HOUR, start());
    writeFileSync(join(dir, 'app-2026-02-30.log'), `${valid}\n`);
    writeFileSync(join(dir, 'app-2026-13-45.log'), `${valid}\n`);
    writeFileSync(join(dir, 'notes.txt'), `${valid}\ngarbage\n`);
    writeFileSync(join(dir, `app-${TODAY}.log.bak`), `${valid}\n`);
    writeFileSync(join(dir, `audit-${TODAY}.log`), `${valid}\n`);
    const r = await read();
    expect(r.records).toEqual([]);
    expect(r.unreadable).toBe(0);
    expect(r.skippedFiles).toBe(0);
  });

  it('level filter: minimum level, default info', async () => {
    emit(RUN_A, NOW - 5 * HOUR, start('login'));
    emit(RUN_A, NOW - 4 * HOUR, logout);
    emit(RUN_A, NOW - 3 * HOUR, unexpectedError(new Error('x'), root));
    emit(RUN_A, NOW - 2 * HOUR, permanentBlock);
    emit(RUN_A, NOW - HOUR, finish('login', 1));
    const events = async (level?: ReadLogsOptions['level']): Promise<string[]> =>
      (await read(level === undefined ? {} : { level })).records.map((x) => x.event);
    const all = [
      'command.start',
      'auth.logout',
      'error.unexpected',
      'login-guard.block',
      'command.finish',
    ];
    expect(await events()).toEqual(all);
    expect(await events('debug')).toEqual(all);
    expect(await events('info')).toEqual(all);
    expect(await events('warn')).toEqual([
      'error.unexpected',
      'login-guard.block',
      'command.finish',
    ]);
    expect(await events('error')).toEqual(['error.unexpected', 'login-guard.block']);
  });

  it('securityOnly: only records from security files', async () => {
    emit(RUN_A, NOW - 3 * HOUR, start('logout'));
    emit(RUN_A, NOW - 2 * HOUR, logout);
    emit(RUN_A, NOW - HOUR, finish('logout'));
    const r = await read({ securityOnly: true });
    expect(r.records.map((x) => x.event)).toEqual(['auth.logout']);
    // Run info still comes from the app file.
    expect(r.runs.get(RUN_A)).toMatchObject({ cmd: 'logout', started: true, finished: true });
  });

  it('run filter: only that run', async () => {
    emit(RUN_A, NOW - 3 * HOUR, start());
    emit(RUN_B, NOW - 2 * HOUR, start('doctor'));
    emit(RUN_A, NOW - HOUR, finish());
    const r = await read({ run: RUN_A });
    expect(r.records.map((x) => [x.run, x.event])).toEqual([
      [RUN_A, 'command.start'],
      [RUN_A, 'command.finish'],
    ]);
  });

  it('run without sinceMs: all day files, no time filter', async () => {
    emit(RUN_A, NOW - 20 * DAY, start());
    emit(RUN_A, NOW - 20 * DAY + 1000, finish());
    emit(RUN_B, NOW - 20 * DAY + 2000, start('doctor'));
    emit(RUN_A, NOW - 2 * DAY, doctorCheck('node', 'ok'));
    const r = await read({ run: RUN_A });
    expect(r.records.map((x) => x.event)).toEqual([
      'command.start',
      'command.finish',
      'doctor.check',
    ]);
  });

  it('run with sinceMs keeps the time filter', async () => {
    emit(RUN_A, NOW - 20 * DAY, start());
    emit(RUN_A, NOW - HOUR, doctorCheck('node', 'ok'));
    const r = await read({ run: RUN_A, sinceMs: DAY });
    expect(r.records.map((x) => x.event)).toEqual(['doctor.check']);
  });

  it('ownRun is excluded from records, runs and interrupted', async () => {
    emit(OWN, NOW - 2 * HOUR, start('logs'));
    emit(OWN, NOW - 2 * HOUR + 1, logout);
    emit(RUN_A, NOW - HOUR, start());
    const r = await read({ ownRun: OWN });
    expect(r.records.map((x) => x.run)).toEqual([RUN_A]);
    expect(r.runs.has(OWN)).toBe(false);
    expect(r.interrupted.map((x) => x.run)).toEqual([RUN_A]);
    const byRun = await read({ ownRun: OWN, run: OWN });
    expect(byRun.records).toEqual([]);
    expect(byRun.interrupted).toEqual([]);
  });
});

describe('order and cap', () => {
  it('merges app and security by time; equal ts keeps app before security', async () => {
    const t = NOW - HOUR;
    emit(RUN_A, t + 3000, finish('logout'));
    emit(RUN_A, t, logout); // security first on disk…
    emit(RUN_A, t, start('logout')); // …app at the same ms
    emit(RUN_A, t + 2000, authLogout('not-logged-in'));
    emit(RUN_A, t + 1000, doctorCheck('node', 'ok'));
    const r = await read();
    expect(r.records.map((x) => x.event)).toEqual([
      'command.start',
      'auth.logout',
      'doctor.check',
      'auth.logout',
      'command.finish',
    ]);
  });

  it('merges across UTC days, oldest first', async () => {
    emit(RUN_A, NOW - HOUR, logout);
    emit(RUN_A, NOW - 2 * DAY, logout);
    emit(RUN_A, NOW - DAY, start());
    emit(RUN_A, NOW - 2 * DAY - HOUR, start());
    const r = await read({ sinceMs: 3 * DAY });
    const ts = r.records.map((x) => Date.parse(x.ts));
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
    expect(ts).toHaveLength(4);
  });

  it('maxRecords keeps the newest N; omitted counts the rest', async () => {
    for (let i = 0; i < 10; i++) emit(RUN_A, NOW - (10 - i) * 60_000, doctorCheck('node', 'ok'));
    const r = await read({ maxRecords: 3 });
    expect(r.records.map((x) => x.ts)).toEqual(
      [3, 2, 1].map((m) => new Date(NOW - m * 60_000).toISOString()),
    );
    expect(r.omitted).toBe(7);
    const all = await read();
    expect(all.records).toHaveLength(10);
    expect(all.omitted).toBe(0);
  });

  it('maxRecords counts only matching records', async () => {
    for (let i = 0; i < 5; i++) emit(RUN_A, NOW - (10 - i) * 60_000, doctorCheck('node', 'ok'));
    for (let i = 0; i < 5; i++) emit(RUN_A, NOW - (5 - i) * 60_000, doctorCheck('node', 'fail'));
    const r = await read({ maxRecords: 2, level: 'warn' });
    expect(r.records).toHaveLength(2);
    expect(r.omitted).toBe(3);
  });
});

describe('runs', () => {
  it('cmd, started, finished and lastTs per run', async () => {
    emit(RUN_A, NOW - 3 * HOUR, start('login'));
    emit(RUN_A, NOW - 2 * HOUR, logout);
    emit(RUN_A, NOW - HOUR, finish('login'));
    emit(RUN_B, NOW - 30 * 60_000, start('doctor'));
    const r = await read();
    expect(r.runs.get(RUN_A)).toEqual({
      cmd: 'login',
      started: true,
      finished: true,
      lastTs: new Date(NOW - HOUR).toISOString(),
      truncatedDay: false,
    });
    expect(r.runs.get(RUN_B)).toEqual({
      cmd: 'doctor',
      started: true,
      finished: false,
      lastTs: new Date(NOW - 30 * 60_000).toISOString(),
      truncatedDay: false,
    });
  });

  it('cmd from command.finish when the start was not scanned', async () => {
    emit(RUN_A, NOW - 3 * DAY, start('login'));
    emit(RUN_A, NOW - HOUR, finish('login'));
    const r = await read();
    expect(r.runs.get(RUN_A)).toMatchObject({ cmd: 'login', started: false, finished: true });
  });

  it('built before filtering: level, security and run filters keep run info', async () => {
    emit(RUN_A, NOW - 3 * HOUR, start('login'));
    emit(RUN_A, NOW - 2 * HOUR, finish('login'));
    emit(RUN_B, NOW - HOUR, start('doctor'));
    for (const opts of [{ level: 'error' as const }, { securityOnly: true }, { run: RUN_B }]) {
      const r = await read(opts);
      expect(r.runs.get(RUN_A)).toMatchObject({ cmd: 'login', started: true, finished: true });
      expect(r.runs.get(RUN_B)).toMatchObject({ cmd: 'doctor', started: true, finished: false });
    }
  });

  it('truncatedDay: a log.truncated record on the run’s last day (app file)', async () => {
    emit(RUN_A, NOW - 2 * HOUR, start());
    new FileEventLog(dir, ctx(RUN_C, NOW - HOUR)).appendRecord(
      'app',
      toRecord({ event: 'log.truncated' }, ctx(RUN_C, NOW - HOUR)),
    );
    emit(RUN_B, NOW - DAY - HOUR, start('doctor')); // other day, no marker
    const r = await read({ sinceMs: 2 * DAY });
    expect(r.runs.get(RUN_A)?.truncatedDay).toBe(true);
    expect(r.runs.get(RUN_B)?.truncatedDay).toBe(false);
    expect(r.interrupted.map((x) => x.run)).toEqual([RUN_B]);
    expect(r.records.some((x) => x.event === 'log.truncated')).toBe(true);
  });

  it('truncatedDay: a log.truncated record in the security file', async () => {
    emit(RUN_A, NOW - 2 * HOUR, start());
    new FileEventLog(dir, ctx(RUN_C, NOW - HOUR)).appendRecord(
      'security',
      toRecord({ event: 'log.truncated' }, ctx(RUN_C, NOW - HOUR)),
    );
    const r = await read();
    expect(r.unreadable).toBe(0);
    expect(r.runs.get(RUN_A)?.truncatedDay).toBe(true);
    expect(r.interrupted).toEqual([]);
  });
});

describe('interrupted', () => {
  it('started, not finished, inside the window → listed with its last ts, sorted', async () => {
    emit(RUN_A, NOW - 3 * HOUR, start('login'));
    emit(RUN_A, NOW - 2 * HOUR, logout);
    emit(RUN_B, NOW - 4 * HOUR, start('doctor'));
    emit(RUN_C, NOW - 5 * HOUR, start('keygen'));
    emit(RUN_C, NOW - 5 * HOUR + 1, finish('keygen'));
    const r = await read();
    expect(r.interrupted).toEqual([
      { run: RUN_B, cmd: 'doctor', ts: new Date(NOW - 4 * HOUR).toISOString() },
      { run: RUN_A, cmd: 'login', ts: new Date(NOW - 2 * HOUR).toISOString() },
    ]);
  });

  it('a finish with outcome interrupted (exit 130) is a record, not an interrupted entry', async () => {
    emit(RUN_A, NOW - 2 * HOUR, start('login'));
    emit(RUN_A, NOW - HOUR, finish('login', 130));
    const r = await read();
    expect(r.interrupted).toEqual([]);
    expect(r.records.at(-1)).toMatchObject({
      event: 'command.finish',
      outcome: 'interrupted',
      exit: 130,
    });
  });

  it('a start 25 h ago (scanned file, outside the window) is not listed', async () => {
    emit(RUN_A, NOW - 25 * HOUR, start('login'));
    const r = await read();
    expect(r.runs.get(RUN_A)).toMatchObject({ started: true, finished: false });
    expect(r.interrupted).toEqual([]);
  });

  it('only when securityOnly is off and the level threshold ≤ warn', async () => {
    emit(RUN_A, NOW - HOUR, start('login'));
    expect((await read({ securityOnly: true })).interrupted).toEqual([]);
    expect((await read({ level: 'error' })).interrupted).toEqual([]);
    expect((await read({ level: 'warn' })).interrupted).toHaveLength(1);
    expect((await read({ level: 'debug' })).interrupted).toHaveLength(1);
  });

  it('matches the run filter; with run and no sinceMs there is no window', async () => {
    emit(RUN_A, NOW - 10 * DAY, start('login'));
    emit(RUN_B, NOW - HOUR, start('doctor'));
    expect((await read({ run: RUN_B })).interrupted.map((x) => x.run)).toEqual([RUN_B]);
    expect((await read({ run: RUN_A })).interrupted).toEqual([
      { run: RUN_A, cmd: 'login', ts: new Date(NOW - 10 * DAY).toISOString() },
    ]);
    expect((await read()).interrupted.map((x) => x.run)).toEqual([RUN_B]);
    expect((await read({ run: RUN_A, sinceMs: DAY })).interrupted).toEqual([]);
  });
});

describe('file types', () => {
  posixOnly('a symlinked day file is skipped and counted', async () => {
    emit(RUN_A, NOW - HOUR, logout);
    const outside = join(root, 'outside.log');
    writeFileSync(outside, `${line(RUN_B, NOW - HOUR, start())}\n`);
    symlinkSync(outside, appFile());
    const r = await read();
    expect(r.records.map((x) => x.run)).toEqual([RUN_A]);
    expect(r.skippedFiles).toBe(1);
  });

  it('a directory named like a day file is skipped and counted', async () => {
    emit(RUN_A, NOW - HOUR, logout);
    mkdirSync(appFile());
    const r = await read();
    expect(r.records).toHaveLength(1);
    expect(r.skippedFiles).toBe(1);
  });

  posixOnly(
    'a FIFO named like a day file is skipped without hanging',
    async () => {
      emit(RUN_A, NOW - HOUR, start());
      const fifo = securityFile();
      const made = spawnSync('mkfifo', [fifo]);
      if (made.status !== 0) return; // mkfifo unavailable
      const r = await read();
      expect(r.records).toHaveLength(1);
      expect(r.skippedFiles).toBe(1);
    },
    10_000,
  );

  posixNonRoot('an unreadable day file is skipped and counted', async () => {
    emit(RUN_A, NOW - HOUR, logout);
    emit(RUN_A, NOW - HOUR, start());
    chmodSync(appFile(), 0o000);
    const r = await read();
    expect(r.records.map((x) => x.event)).toEqual(['auth.logout']);
    expect(r.skippedFiles).toBe(1);
  });
});

describe('line splitting', () => {
  function writeApp(content: string | Buffer): void {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(appFile(), content);
  }

  it('a 10 MB line is counted unreadable once; the lines around it are read', async () => {
    const before = line(RUN_A, NOW - 2 * HOUR, start());
    const after = line(RUN_A, NOW - HOUR, finish());
    writeApp(`${before}\n${'{'.repeat(10 * 1024 * 1024)}\n${after}\n`);
    const r = await read();
    expect(r.records.map((x) => x.event)).toEqual(['command.start', 'command.finish']);
    expect(r.unreadable).toBe(1);
  });

  it('lines over and at the byte cap are each counted unreadable once', async () => {
    const cap = MAX_LINE_BYTES + SECURITY_PREFIX.length + 1;
    const ok = line(RUN_A, NOW - HOUR, start());
    writeApp(`${'x'.repeat(cap + 1)}\n${ok}\n${'y'.repeat(cap)}\n`);
    const r = await read();
    expect(r.records).toHaveLength(1);
    expect(r.unreadable).toBe(2);
  });

  it('a 50 MB single line keeps memory bounded', async () => {
    const valid = line(RUN_A, NOW - HOUR, start());
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const chunk = Buffer.alloc(1024 * 1024, 0x61);
    writeFileSync(appFile(), `${valid}\n`);
    for (let i = 0; i < 50; i++) appendFileSync(appFile(), chunk);
    const base = process.memoryUsage().rss;
    let peak = base;
    const timer = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 2);
    let r: ReadResult;
    try {
      r = await read();
    } finally {
      clearInterval(timer);
    }
    peak = Math.max(peak, process.memoryUsage().rss);
    expect(r.records).toHaveLength(1);
    expect(r.unreadable).toBe(1);
    expect(peak - base).toBeLessThan(100 * 1024 * 1024);
  }, 30_000);

  it('CRLF line endings are accepted', async () => {
    const a = line(RUN_A, NOW - 2 * HOUR, start());
    const b = line(RUN_A, NOW - HOUR, finish());
    writeApp(`${a}\r\n${b}\r\n`);
    const r = await read();
    expect(r.records).toHaveLength(2);
    expect(r.unreadable).toBe(0);
  });

  it('a last line without \\n is read', async () => {
    const a = line(RUN_A, NOW - 2 * HOUR, start());
    const b = line(RUN_A, NOW - HOUR, finish());
    writeApp(`${a}\n${b}`);
    const r = await read();
    expect(r.records.map((x) => x.event)).toEqual(['command.start', 'command.finish']);
  });

  it('invalid UTF-8 is unreadable', async () => {
    const a = line(RUN_A, NOW - 2 * HOUR, start());
    const bad = Buffer.from(line(RUN_A, NOW - HOUR, finish()).replace('keygen', 'keyXen'));
    const at = bad.indexOf('X');
    bad[at] = 0xff;
    writeApp(Buffer.concat([Buffer.from(`${a}\n`), bad, Buffer.from('\n')]));
    const r = await read();
    expect(r.records.map((x) => x.event)).toEqual(['command.start']);
    expect(r.unreadable).toBe(1);
  });

  it('empty lines are ignored', async () => {
    const a = line(RUN_A, NOW - HOUR, start());
    writeApp(`\n\n${a}\n\n\r\n\n`);
    const r = await read();
    expect(r.records).toHaveLength(1);
    expect(r.unreadable).toBe(0);
    expect(r.unknown).toBe(0);
  });

  it('counts unreadable and unknown lines', async () => {
    const good = line(RUN_A, NOW - 3 * HOUR, start());
    const record = JSON.parse(line(RUN_A, NOW - 2 * HOUR, finish())) as Record<string, unknown>;
    const tampered = [
      'garbage',
      '\u001b]0;pwn\u0007{"ts":"x"}',
      JSON.stringify({ ...record, subject: 'CANARY-SUBJECT' }),
      JSON.stringify({ ...record, level: 'error' }),
      `${SECURITY_PREFIX}${JSON.stringify(record)}`, // wrong prefix for an app file
      JSON.stringify({ ...record, ts: '2026-09-28T10:00:00.000Z' }), // other day
      '\u0000',
    ];
    const unknown = [
      JSON.stringify({ ...record, v: 2 }),
      JSON.stringify({
        ts: new Date(NOW - HOUR).toISOString(),
        event: 'mailbox.frobnicate',
        level: 'info',
        run: RUN_A,
        v: 1,
      }),
    ];
    writeApp(`${[good, ...tampered, ...unknown].join('\n')}\n`);
    const r = await read();
    expect(r.records.map((x) => x.event)).toEqual(['command.start']);
    expect(r.unreadable).toBe(tampered.length);
    expect(r.unknown).toBe(2);
  });

  it('a security line in an app file and an app line in a security file are unreadable', async () => {
    emit(RUN_A, NOW - 3 * HOUR, start());
    appendFileSync(appFile(), `${line(RUN_A, NOW - 2 * HOUR, logout)}\n`);
    appendFileSync(securityFile(), `${line(RUN_A, NOW - HOUR, finish())}\n`);
    const r = await read();
    expect(r.records.map((x) => x.event)).toEqual(['command.start']);
    expect(r.unreadable).toBe(2);
  });
});

describe('imap.login round trip through the files', () => {
  it('security records keep all fields', async () => {
    const event = imapLogin({ provider: 'websupport', ip: IP, target: TARGET });
    emit(RUN_A, NOW - HOUR, event);
    const r = await read();
    const rendered = renderEvent(event, ctx(RUN_A, NOW - HOUR));
    expect(r.records).toEqual([rendered?.record]);
  });
});

describe('review follow-ups (M1b-4c)', () => {
  it('folder status: missing, ok, not-a-folder', async () => {
    expect((await read()).folder).toBe('missing');
    mkdirSync(dir);
    expect((await read()).folder).toBe('ok');
    rmSync(dir, { recursive: true });
    writeFileSync(dir, 'x');
    expect((await read()).folder).toBe('not-a-folder');
  });

  posixOnly('folder status: a symlinked folder is not-a-folder', async () => {
    const real = join(root, 'real-logs');
    mkdirSync(real);
    symlinkSync(real, dir);
    expect((await read()).folder).toBe('not-a-folder');
  });

  posixNonRoot('folder status: a folder without read access is unreadable', async () => {
    emit(RUN_A, NOW - HOUR, start());
    chmodSync(dir, 0o000);
    const r = await read();
    expect(r.folder).toBe('unreadable');
    expect(r.records).toEqual([]);
  });

  it('interrupted markers share the output cap with records', async () => {
    for (let i = 0; i < 6; i++) {
      emit(`${i}`.repeat(16), NOW - HOUR + i * 1000, start());
    }
    emit(RUN_A, NOW - 10 * 60_000, start());
    emit(RUN_A, NOW - 10 * 60_000 + 1000, finish());
    const r = await read({ maxRecords: 4 });
    expect(r.records.length + r.interrupted.length).toBe(4);
    // The newest four, oldest first: run 5's start and its marker (a marker sorts after the
    // record of the same instant), then RUN_A's start and finish.
    expect(r.records.map((rec) => `${rec.run.slice(0, 1)}:${rec.event}`)).toEqual([
      '5:command.start',
      'a:command.start',
      'a:command.finish',
    ]);
    expect(r.interrupted.map((m) => m.run)).toEqual(['5'.repeat(16)]);
    // 6 unfinished starts (records) went over the cap too: 8 records + 6 markers - 4 kept.
    expect(r.omitted).toBe(10);
  });
});

describe('security audit follow-ups (M1b-4c)', () => {
  it('a sparse day file far over the writer cap is skipped without reading it', async () => {
    emit(RUN_A, NOW - HOUR, start());
    const huge = securityFile();
    writeFileSync(huge, '');
    truncateSync(huge, MAX_READ_FILE_BYTES + 1);
    const began = Date.now();
    const r = await read();
    expect(Date.now() - began).toBeLessThan(2000);
    expect(r.skippedFiles).toBe(1);
    expect(r.records.map((rec) => rec.event)).toEqual(['command.start']);
  });

  it('runs are tracked only from start/finish lines and capped', async () => {
    mkdirSync(dir, { recursive: true });
    // Security lines with fresh run ids open no entries.
    const security = Array.from({ length: 50 }, (_, i) =>
      line(i.toString(16).padStart(16, 'e'), NOW - HOUR, logout),
    );
    writeFileSync(securityFile(), `${security.join('\n')}\n`);
    let r = await read();
    expect(r.runs.size).toBe(0);
    expect(r.records).toHaveLength(50);

    // One more distinct started run than the cap: tracking stops, interrupted isn't marked.
    const starts: string[] = [];
    for (let i = 0; i <= MAX_TRACKED_RUNS; i++) {
      starts.push(line(i.toString(16).padStart(16, '0'), NOW - HOUR, start()));
    }
    writeFileSync(appFile(), `${starts.join('\n')}\n`);
    r = await read({ maxRecords: 10 });
    expect(r.runs.size).toBe(MAX_TRACKED_RUNS);
    expect(r.runsCapped).toBe(true);
    expect(r.interrupted).toEqual([]);
  }, 60_000);
});
