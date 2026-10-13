import { afterEach, describe, it, expect, vi } from 'vitest';
import { createApp } from '../../src/cli/app/controller.js';
import type { App, AppDeps, AppResult } from '../../src/cli/app/controller.js';
import { asciiText } from '../../src/cli/app/state.js';
import type { Rendered } from '../../src/cli/browser/render.js';
import type { Keypress, Screen } from '../../src/cli/browser/state.js';
import type { Terminal } from '../../src/cli/browser/terminal.js';
import { LOG_FOLDER_PROBLEM, formatReport, reportFooters } from '../../src/cli/log-text.js';
import type { AuthUser, LogoutResult } from '../../src/core/auth.js';
import type { MailAccount } from '../../src/core/db/repos.js';
import {
  MemoryEventLog,
  commandFinish,
  commandStart,
  renderEvent,
} from '../../src/core/log/index.js';
import type {
  LogEvent,
  LogRecord,
  ReadResult,
  RunContext,
  RunInfo,
} from '../../src/core/log/index.js';
import { MemoryRememberedUsers } from '../../src/core/remembered-users.js';

// M2d-5 logs in the app controller (spec L1, L2, L3, L5, L6, L7 and the logs edge cases): keys ->
// reducers -> effects, driven with a fake Terminal, a fake log reader (deferred where order
// matters) and a MemoryEventLog. The page is compared with formatReport of the same result -
// "the same lines as mm logs". No Supabase, no IMAP, no log files, no real clock.

// --- fixtures -------------------------------------------------------------------------------

const SCREEN: Screen = { rows: 24, cols: 120 };
const ALICE: AuthUser = {
  email: 'alice@example.com',
  userId: '11111111-1111-4111-8111-111111111111',
};
const ID = '22222222-2222-4222-8222-222222222222';
const MAIL = 'one@example.com';
const RUN = '0123456789abcdef';
const OWN = 'aaaaaaaaaaaaaaaa';
const OTHER = 'bbbbbbbbbbbbbbbb';
const OTHER2 = 'cccccccccccccccc';
const T0 = Date.UTC(2026, 9, 1, 9, 0, 0);
const NOW = Date.UTC(2026, 9, 7, 9, 0, 0);
const TARGET = 'ab'.repeat(32);
const RT = { ver: '0.9.0', node: '22.13.0', os: 'linux' };
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const k = (name: string, extra: Keypress = {}): Keypress => ({ name, sequence: name, ...extra });
const ENTER = k('return', { sequence: '\r' });
const DOWN = k('down', { sequence: '\x1b[B' });
const UP = k('up', { sequence: '\x1b[A' });
const LEFT = k('left', { sequence: '\x1b[D' });
const BACKSPACE = k('backspace', { sequence: '\x7f' });
const CTRL_C = k('c', { ctrl: true, sequence: '\x03' });
const ESC = k('escape', { meta: true, sequence: '\x1b' });

function charKey(c: string): Keypress {
  return /^[a-z0-9]$/.test(c) ? { name: c, sequence: c } : { sequence: c };
}

function account(): MailAccount {
  return {
    id: ID,
    userId: ALICE.userId,
    label: null,
    email: MAIL,
    provider: 'websupport',
    host: 'imap.example.com',
    port: 993,
    username: MAIL,
    authType: 'password',
    secret: {} as unknown as MailAccount['secret'],
    capabilities: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    lastCheckedAt: null,
  };
}

function ctx(at: number, run: string): RunContext {
  return { run, ver: '0.9.0', now: () => at, level: 'debug' };
}

function rec(event: LogEvent, at: number, run: string): LogRecord {
  const rendered = renderEvent(event, ctx(at, run));
  if (rendered === null) throw new Error('not rendered');
  return rendered.record;
}

function runInfo(cmd: string, lastTs: string): RunInfo {
  return { cmd, started: true, finished: true, lastTs, truncatedDay: false };
}

function readResult(over: Partial<ReadResult> = {}): ReadResult {
  return {
    folder: 'ok',
    records: [],
    runs: new Map<string, RunInfo>(),
    interrupted: [],
    unreadable: 0,
    unknown: 0,
    omitted: 0,
    skippedFiles: 0,
    runsCapped: false,
    ...over,
  };
}

/** Records over two days, an interrupted run of another run and one of this run. */
function twoDays(): ReadResult {
  const d1 = Date.UTC(2026, 9, 6, 22, 0, 0);
  const d2 = Date.UTC(2026, 9, 7, 8, 0, 0);
  return readResult({
    records: [
      rec(commandStart('folders', [], RT), d1, OTHER),
      rec(commandFinish('folders', 0, 120), d1 + 1000, OTHER),
      rec(commandStart('app', [], RT), d2, OWN),
    ],
    runs: new Map<string, RunInfo>([
      [OTHER, runInfo('folders', new Date(d1 + 1000).toISOString())],
      [OWN, runInfo('app', new Date(d2).toISOString())],
    ]),
    interrupted: [
      { run: OTHER2, cmd: 'stats', ts: new Date(d2 + 30 * MIN).toISOString() },
      { run: OWN, cmd: 'app', ts: new Date(d2).toISOString() },
    ],
  });
}

/** What `mm logs` would print for `result` (this run's interrupted marker left out). */
function expectedLines(
  result: ReadResult,
  sinceMs = DAY,
  extra: { level?: 'info' | 'warn'; securityOnly?: boolean } = {},
): string[] {
  const own = { ...result, interrupted: result.interrupted.filter((i) => i.run !== OWN) };
  return formatReport(own, {
    now: NOW,
    sinceMs,
    level: extra.level ?? 'info',
    ...(extra.securityOnly === true && { securityOnly: true }),
    timeZone: 'UTC',
    narrowWith: 'keys',
  }).map(asciiText);
}

// --- fakes ----------------------------------------------------------------------------------

interface FakeTerminal extends Terminal {
  readonly frames: Rendered[];
  key(key: Keypress): void;
}

function fakeTerminal(screen: Screen = SCREEN): FakeTerminal {
  let keyHandler: ((key: Keypress) => void) | null = null;
  const t: FakeTerminal = {
    frames: [],
    size: () => screen,
    draw: (frame) => {
      t.frames.push(frame);
    },
    clear: () => undefined,
    onKey: (fn) => {
      keyHandler = fn;
    },
    onResize: () => undefined,
    restore: vi.fn(),
    close: vi.fn(),
    key: (key) => {
      if (keyHandler === null) throw new Error('no key handler registered');
      keyHandler(key);
    },
  };
  return t;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(err: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function stillRunning(p: Promise<unknown>): Promise<boolean> {
  return Promise.race([p.then(() => false), settle().then(() => true)]);
}

type ReadLogs = AppDeps['readLogs'];

interface Harness {
  t: FakeTerminal;
  app: App;
  done: Promise<AppResult>;
  log: MemoryEventLog;
  readLogs: ReturnType<typeof vi.fn<ReadLogs>>;
  listMailboxes: ReturnType<typeof vi.fn<AppDeps['listMailboxes']>>;
  openSession: ReturnType<typeof vi.fn<AppDeps['openSession']>>;
}

function makeHarness(read: ReadLogs = () => Promise.resolve(readResult())): Harness {
  const acct = account();
  const t = fakeTerminal();
  const auth = {
    currentUser: vi.fn<() => Promise<AuthUser | null>>(() => Promise.resolve(ALICE)),
    login: vi.fn<(email: string, password: string) => Promise<AuthUser>>(() =>
      Promise.resolve(ALICE),
    ),
    logout: vi.fn<() => Promise<LogoutResult>>(() => Promise.resolve('logged-out')),
  };
  const log = new MemoryEventLog({ run: RUN, ver: '0.9.0', now: () => T0, level: 'debug' });
  const readLogs = vi.fn<ReadLogs>(read);
  const listMailboxes = vi.fn<AppDeps['listMailboxes']>(() => Promise.resolve([acct]));
  const openSession = vi.fn<AppDeps['openSession']>(() => Promise.reject(new Error('not used')));
  const deps: AppDeps = {
    terminal: t,
    version: '0.9.0',
    auth,
    listMailboxes,
    remembered: new MemoryRememberedUsers([ALICE.email]),
    log,
    loginTarget: () => TARGET,
    onUnexpected: vi.fn<(err: unknown) => void>(),
    findAccount: vi.fn<AppDeps['findAccount']>(() => Promise.resolve(acct)),
    openSession,
    collectStats: vi.fn<NonNullable<AppDeps['collectStats']>>(() =>
      Promise.reject(new Error('not used')),
    ),
    timeZone: 'UTC',
    autoStats: false,
    readLogs,
    ownRun: OWN,
    now: () => NOW,
    discover: vi.fn<AppDeps['discover']>(() => Promise.reject(new Error('not used'))),
    assertNotSaved: vi.fn<AppDeps['assertNotSaved']>(() => Promise.resolve()),
    addMailbox: vi.fn<AppDeps['addMailbox']>(() => Promise.reject(new Error('not used'))),
  };
  const app = createApp(deps);
  return { t, app, done: app.run(), log, readLogs, listMailboxes, openSession };
}

const text = (frame: Rendered | undefined): string => (frame?.lines ?? []).join('\n');
const last = (h: Harness): string => text(h.t.frames.at(-1));
const collapsed = (s: string): string => s.replace(/\s+/g, ' ');

async function press(h: Harness, ...keys: Keypress[]): Promise<void> {
  for (const key of keys) {
    h.t.key(key);
    await settle();
  }
}

async function waitFor(h: Harness, needle: string): Promise<void> {
  await vi.waitFor(() => {
    expect(last(h)).toContain(needle);
  });
}

async function end(h: Harness): Promise<void> {
  if (await stillRunning(h.done)) {
    h.t.key(CTRL_C);
    await h.done;
  }
  await h.app.settled();
}

afterEach(() => {
  vi.useRealTimers();
});

async function atHome(read?: ReadLogs): Promise<Harness> {
  const h = makeHarness(read);
  await waitFor(h, 'Sign in as another user');
  await press(h, ENTER);
  await waitFor(h, MAIL);
  return h;
}

/** Home rows: the mailbox, Add, Logs, Log out. Enter on Logs. */
async function openLogs(read?: ReadLogs): Promise<Harness> {
  const h = await atHome(read);
  await press(h, DOWN, DOWN, ENTER);
  await waitFor(h, 'Mail Manager - Logs');
  return h;
}

/** The page rows of the last frame: between the header and the status line, trailing blanks off. */
function pageOf(h: Harness): string[] {
  const lines = h.t.frames.at(-1)?.lines ?? [];
  return lines.slice(1, lines.length - 2).map((l) => l.trimEnd());
}

// --- L1: opening and the read ---------------------------------------------------------------

describe("L1 Enter on Home's Logs row", () => {
  it('shows "Reading the logs..." while the read runs, with the 24 h header', async () => {
    const pending = deferred<ReadResult>();
    const h = await openLogs(() => pending.promise);
    expect(last(h)).toContain('Reading the logs...');
    expect(h.t.frames.at(-1)?.lines[0]).toMatch(/Mail Manager - Logs\s+24 h\s*$/);
    pending.resolve(readResult());
    await waitFor(h, 'No log lines in the last 24 h.');
    expect(last(h)).not.toContain('Reading the logs...');
    await end(h);
  });

  it('reads the last 24 h with level info and no filter, exactly once', async () => {
    const h = await openLogs();
    await waitFor(h, 'No log lines');
    expect(h.readLogs).toHaveBeenCalledTimes(1);
    expect(h.readLogs).toHaveBeenCalledWith({ sinceMs: DAY, securityOnly: false, level: 'info' });
    await end(h);
  });

  it('1 / 2 / 3 read 24 h / 7 days / 30 days', async () => {
    const h = await openLogs();
    await waitFor(h, 'No log lines');
    await press(h, charKey('2'));
    await vi.waitFor(() => {
      expect(h.readLogs).toHaveBeenLastCalledWith({
        sinceMs: 7 * DAY,
        securityOnly: false,
        level: 'info',
      });
    });
    expect(h.t.frames.at(-1)?.lines[0]).toMatch(/7 days\s*$/);
    await press(h, charKey('3'));
    await vi.waitFor(() => {
      expect(h.readLogs).toHaveBeenLastCalledWith({
        sinceMs: 30 * DAY,
        securityOnly: false,
        level: 'info',
      });
    });
    await press(h, charKey('1'));
    await vi.waitFor(() => {
      expect(h.readLogs).toHaveBeenLastCalledWith({
        sinceMs: DAY,
        securityOnly: false,
        level: 'info',
      });
    });
    expect(h.readLogs).toHaveBeenCalledTimes(4);
    await end(h);
  });

  it('s reads security only, w reads level warn, both combine, r repeats the same read', async () => {
    const h = await openLogs();
    await waitFor(h, 'No log lines');
    await press(h, charKey('s'));
    await vi.waitFor(() => {
      expect(h.readLogs).toHaveBeenLastCalledWith({
        sinceMs: DAY,
        securityOnly: true,
        level: 'info',
      });
    });
    expect(h.t.frames.at(-1)?.lines[0]).toMatch(/24 h - security\s*$/);
    await press(h, charKey('w'));
    await vi.waitFor(() => {
      expect(h.readLogs).toHaveBeenLastCalledWith({
        sinceMs: DAY,
        securityOnly: true,
        level: 'warn',
      });
    });
    expect(h.t.frames.at(-1)?.lines[0]).toMatch(/24 h - security - warnings\s*$/);
    await press(h, charKey('2'), charKey('r'));
    await vi.waitFor(() => {
      expect(h.readLogs).toHaveBeenCalledTimes(5);
    });
    expect(h.readLogs).toHaveBeenLastCalledWith({
      sinceMs: 7 * DAY,
      securityOnly: true,
      level: 'warn',
    });
    await press(h, charKey('s'), charKey('w'));
    await vi.waitFor(() => {
      expect(h.readLogs).toHaveBeenLastCalledWith({
        sinceMs: 7 * DAY,
        securityOnly: false,
        level: 'info',
      });
    });
    await end(h);
  });
});

// --- L2, L3: the page -----------------------------------------------------------------------

describe('L2 the page is the report of the result', () => {
  it("the same lines as mm logs: date headers, times, commands, the other run's interrupted marker", async () => {
    const result = twoDays();
    const expected = expectedLines(result);
    expect(expected.some((l) => l.startsWith('--- 2026-10-06 ---'))).toBe(true);
    expect(expected.some((l) => l.startsWith('--- 2026-10-07 ---'))).toBe(true);
    const h = await openLogs(() => Promise.resolve(result));
    await waitFor(h, '--- 2026-10-07 ---');
    expect(pageOf(h).slice(0, expected.length)).toEqual(expected.map((l) => l.trimEnd()));
    await end(h);
  });

  it('the records of this app run are shown', async () => {
    const h = await openLogs(() => Promise.resolve(twoDays()));
    await waitFor(h, '--- 2026-10-07 ---');
    const page = pageOf(h);
    expect(page.some((l) => /\bapp\b/.test(l) && l.includes('started'))).toBe(true);
    await end(h);
  });

  it('an interrupted marker is shown for another run but not for this one', async () => {
    const h = await openLogs(() => Promise.resolve(twoDays()));
    await waitFor(h, 'interrupted or still running');
    const marked = pageOf(h).filter((l) => l.includes('interrupted or still running'));
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain('stats');
    expect(marked[0]).not.toMatch(/\bapp\b/);
    await end(h);
  });

  it('every line is ASCII', async () => {
    const result = readResult({
      records: [rec(commandStart('folders', [], RT), NOW - MIN, OTHER)],
      omitted: 3,
      unreadable: 2,
    });
    const h = await openLogs(() => Promise.resolve(result));
    await waitFor(h, 'unreadable lines skipped');
    for (const line of h.t.frames.at(-1)?.lines ?? []) expect(line).toMatch(/^[\x20-\x7E]*$/);
    await end(h);
  });

  it('the footers come after the lines', async () => {
    const result = readResult({
      records: [rec(commandStart('folders', [], RT), NOW - MIN, OTHER)],
      unreadable: 2,
      unknown: 1,
      skippedFiles: 1,
    });
    const h = await openLogs(() => Promise.resolve(result));
    await waitFor(h, 'unreadable lines skipped');
    const page = pageOf(h).filter((l) => l !== '');
    expect(page[0]).toContain('folders');
    expect(page.at(-1)).toContain('log file skipped');
    expect(page.some((l) => l.includes('2 unreadable lines skipped'))).toBe(true);
    expect(page.some((l) => l.includes('1 unknown event skipped'))).toBe(true);
    await end(h);
  });

  it('the filters and the window are passed on to the wording of an empty result', async () => {
    const h = await openLogs(() => Promise.resolve(readResult()));
    await waitFor(h, 'No log lines in the last 24 h.');
    await press(h, charKey('2'));
    await waitFor(h, 'No log lines in the last 7 days.');
    await press(h, charKey('w'));
    await waitFor(h, 'No matching log lines in the last 7 days.');
    await end(h);
  });
});

describe('L3 the page opens at the bottom', () => {
  it('many lines: the newest are in view, the last one on the last body line', async () => {
    const base = Date.UTC(2026, 9, 7, 6, 0, 0);
    const records = Array.from({ length: 80 }, (_, i) =>
      rec(commandFinish('stats', 0, i + 1), base + i * MIN, OTHER),
    );
    const result = readResult({
      records,
      runs: new Map([[OTHER, runInfo('stats', new Date(base).toISOString())]]),
    });
    const expected = expectedLines(result);
    const h = await openLogs(() => Promise.resolve(result));
    await vi.waitFor(() => {
      expect(last(h)).toContain(expected.at(-1)?.trimEnd() ?? 'missing');
    });
    const lines = h.t.frames.at(-1)?.lines ?? [];
    expect(lines[lines.length - 3]?.trimEnd()).toBe(expected.at(-1)?.trimEnd());
    expect(lines[lines.length - 4]?.trimEnd()).toBe(expected.at(-2)?.trimEnd());
    expect(last(h)).not.toContain(expected[0]?.trimEnd() ?? 'missing');
    await end(h);
  });

  it('Up shows older lines; a new read starts at the bottom again', async () => {
    const base = Date.UTC(2026, 9, 7, 6, 0, 0);
    const records = Array.from({ length: 80 }, (_, i) =>
      rec(commandFinish('stats', 0, i + 1), base + i * MIN, OTHER),
    );
    const result = readResult({
      records,
      runs: new Map([[OTHER, runInfo('stats', new Date(base).toISOString())]]),
    });
    const expected = expectedLines(result);
    const h = await openLogs(() => Promise.resolve(result));
    await vi.waitFor(() => {
      expect(last(h)).toContain(expected.at(-1)?.trimEnd() ?? 'missing');
    });
    await press(h, UP, UP, UP);
    const lines = h.t.frames.at(-1)?.lines ?? [];
    expect(lines[lines.length - 3]?.trimEnd()).toBe(expected.at(-4)?.trimEnd());
    await press(h, charKey('r'));
    await vi.waitFor(() => {
      const now = h.t.frames.at(-1)?.lines ?? [];
      expect(now[now.length - 3]?.trimEnd()).toBe(expected.at(-1)?.trimEnd());
    });
    await end(h);
  });
});

// --- L5: the footer names keys --------------------------------------------------------------

describe('L5 "older lines not shown" names keys, not flags', () => {
  const OMITTED = readResult({ omitted: 12 });

  it('in the app: "N older lines not shown - choose a shorter time or a filter (s, w)"', async () => {
    const h = await openLogs(() => Promise.resolve(OMITTED));
    await waitFor(h, 'older lines not shown');
    expect(collapsed(last(h))).toContain(
      '12 older lines not shown - choose a shorter time or a filter (s, w)',
    );
    expect(last(h)).not.toContain('--');
    await end(h);
  });

  it('reportFooters with narrowWith "keys" says so, with no flag name', () => {
    const [line] = reportFooters(OMITTED, { now: NOW, narrowWith: 'keys' });
    expect(asciiText(line ?? '')).toBe(
      '12 older lines not shown - choose a shorter time or a filter (s, w)',
    );
  });

  it('by default and with "flags" the footer is the one of mm logs, naming the flags', () => {
    const plain = reportFooters(OMITTED, { now: NOW });
    expect(plain[0]).toContain('12 older lines not shown');
    expect(plain[0]).toContain('--since');
    expect(plain[0]).toContain('--security');
    expect(plain[0]).not.toContain('(s, w)');
    expect(reportFooters(OMITTED, { now: NOW, narrowWith: 'flags' })).toEqual(plain);
  });

  it('one older line is singular', () => {
    const [line] = reportFooters(readResult({ omitted: 1 }), { now: NOW, narrowWith: 'keys' });
    expect(line).toContain('1 older line not shown');
    expect(line).toContain('(s, w)');
    expect(line).not.toContain('1 older lines');
  });

  it('the other footers are unchanged by narrowWith', () => {
    const r = readResult({ unreadable: 2, unknown: 1, skippedFiles: 1, runsCapped: true });
    expect(reportFooters(r, { now: NOW, narrowWith: 'keys' })).toEqual(
      reportFooters(r, { now: NOW }),
    );
  });
});

// --- L6: a log folder that can't be read ----------------------------------------------------

describe("L6 a log folder that can't be read", () => {
  it.each(['not-a-folder', 'unreadable'] as const)(
    "%s: that problem's text in the body",
    async (folder) => {
      const problem = LOG_FOLDER_PROBLEM[folder];
      expect(problem).toBeDefined();
      const h = await openLogs(() => Promise.resolve(readResult({ folder })));
      await waitFor(h, 'Mail Manager - Logs');
      await vi.waitFor(() => {
        expect(collapsed(last(h))).toContain(collapsed(asciiText(problem ?? 'missing')));
      });
      expect(last(h)).not.toContain('No log lines');
      expect(last(h)).not.toContain('Reading the logs...');
      for (const line of h.t.frames.at(-1)?.lines ?? []) expect(line).toMatch(/^[\x20-\x7E]*$/);
      expect(await stillRunning(h.done)).toBe(true);
      await end(h);
    },
  );

  it('missing folder (no logs yet): "No log lines in the last 24 h."', async () => {
    const h = await openLogs(() => Promise.resolve(readResult({ folder: 'missing' })));
    await waitFor(h, 'No log lines in the last 24 h.');
    await end(h);
  });

  it('no matching line: the same sentence', async () => {
    const h = await openLogs(() => Promise.resolve(readResult()));
    await waitFor(h, 'No log lines in the last 24 h.');
    await end(h);
  });

  it('a reader that rejects ends the app through the crash path', async () => {
    const err = new Error('boom');
    const h = await atHome(() => Promise.reject(err));
    h.t.key(DOWN);
    await settle();
    h.t.key(DOWN);
    await settle();
    h.t.key(ENTER);
    await expect(h.done).rejects.toBe(err);
  });
});

// --- L4, L7: leaving, stale reads, no side effects ------------------------------------------

describe('L4 leaving the logs', () => {
  it.each([
    ['Esc', ESC],
    ['Left', LEFT],
    ['Backspace', BACKSPACE],
  ])('%s: Home as it was - the same frame, the same cursor, no reload', async (_n, key) => {
    const h = await atHome(() => Promise.resolve(twoDays()));
    await press(h, DOWN, DOWN);
    const before = h.t.frames.at(-1)?.lines;
    await press(h, ENTER);
    await waitFor(h, '--- 2026-10-07 ---');
    await press(h, key);
    expect(h.t.frames.at(-1)?.lines).toEqual(before);
    await settle();
    expect(h.listMailboxes).toHaveBeenCalledTimes(1);
    expect(await stillRunning(h.done)).toBe(true);
    await end(h);
  });

  it('Home works as before after the logs: Enter on Logs opens them again, clean', async () => {
    const h = await openLogs();
    await waitFor(h, 'No log lines');
    await press(h, charKey('3'), charKey('s'));
    await press(h, ESC);
    expect(last(h)).toContain('Add a mailbox');
    await press(h, ENTER);
    await waitFor(h, 'Mail Manager - Logs');
    expect(h.t.frames.at(-1)?.lines[0]).toMatch(/24 h\s*$/);
    expect(h.readLogs).toHaveBeenLastCalledWith({
      sinceMs: DAY,
      securityOnly: false,
      level: 'info',
    });
    await end(h);
  });

  it('q quits the app', async () => {
    const h = await openLogs();
    await waitFor(h, 'No log lines');
    h.t.key(charKey('q'));
    await expect(h.done).resolves.toMatchObject({ end: 'quit' });
    await h.app.settled();
  });

  it('Ctrl+C ends the app at once, also while the read is pending', async () => {
    const pending = deferred<ReadResult>();
    const h = await openLogs(() => pending.promise);
    h.t.key(CTRL_C);
    await expect(h.done).resolves.toMatchObject({ end: 'interrupt' });
    pending.resolve(readResult());
    await h.app.settled();
  });
});

describe('L7 stale reads and side effects', () => {
  it('the result of a superseded read changes nothing; the newer one is shown', async () => {
    const first = deferred<ReadResult>();
    const second = deferred<ReadResult>();
    let n = 0;
    const h = await openLogs(() => (++n === 1 ? first.promise : second.promise));
    await press(h, charKey('2'));
    expect(h.readLogs).toHaveBeenCalledTimes(2);
    first.resolve(
      readResult({ records: [rec(commandStart('stale-cmd', [], RT), NOW - MIN, OTHER)] }),
    );
    await settle();
    await settle();
    expect(last(h)).not.toContain('stale-cmd');
    expect(last(h)).toContain('Reading the logs...');
    second.resolve(
      readResult({ records: [rec(commandStart('fresh-cmd', [], RT), NOW - MIN, OTHER)] }),
    );
    await waitFor(h, 'fresh-cmd');
    expect(last(h)).not.toContain('stale-cmd');
    await end(h);
  });

  it('a result that arrives after Esc changes nothing: Home stays', async () => {
    const pending = deferred<ReadResult>();
    const h = await openLogs(() => pending.promise);
    await press(h, ESC);
    expect(last(h)).toContain('Add a mailbox');
    pending.resolve(
      readResult({ records: [rec(commandStart('late-cmd', [], RT), NOW - MIN, OTHER)] }),
    );
    await settle();
    await settle();
    expect(last(h)).toContain('Add a mailbox');
    expect(last(h)).not.toContain('late-cmd');
    expect(last(h)).not.toContain('Mail Manager - Logs');
    expect(await stillRunning(h.done)).toBe(true);
    await end(h);
  });

  it('a late failure after Esc is not shown either', async () => {
    const pending = deferred<ReadResult>();
    const h = await openLogs(() => pending.promise);
    await press(h, ESC);
    pending.resolve(readResult({ folder: 'unreadable' }));
    await settle();
    await settle();
    expect(last(h)).toContain('Add a mailbox');
    expect(last(h)).not.toContain('log folder');
    await end(h);
  });

  it('viewing writes no log line and uses no mailbox login', async () => {
    const h = await atHome(() => Promise.resolve(twoDays()));
    const before = h.log.records.length;
    const linesBefore = h.log.lines.length;
    await press(h, DOWN, DOWN, ENTER);
    await waitFor(h, '--- 2026-10-07 ---');
    await press(h, UP, charKey('2'), charKey('s'), charKey('w'), charKey('r'), charKey('3'));
    await vi.waitFor(() => {
      expect(h.readLogs.mock.calls.length).toBeGreaterThanOrEqual(6);
    });
    await press(h, ESC);
    expect(h.log.records.length).toBe(before);
    expect(h.log.lines).toHaveLength(linesBefore);
    expect(h.openSession).not.toHaveBeenCalled();
    await end(h);
  });
});
