import { describe, it, expect, vi } from 'vitest';
import { createApp } from '../../src/cli/app/controller.js';
import type { App, AppDeps, AppResult } from '../../src/cli/app/controller.js';
import type { Rendered } from '../../src/cli/browser/render.js';
import type { Keypress, Screen } from '../../src/cli/browser/state.js';
import type { Terminal } from '../../src/cli/browser/terminal.js';
import { LOG_FOLDER_PROBLEM } from '../../src/cli/log-text.js';
import type { AuthUser, LogoutResult } from '../../src/core/auth.js';
import type { MailAccount } from '../../src/core/db/repos.js';
import {
  MemoryEventLog,
  authLogin,
  capabilityFallback,
  commandFinish,
  commandStart,
  imapLoginFailed,
  renderEvent,
} from '../../src/core/log/index.js';
import type { LogEvent, LogRecord, ReadResult, RunInfo } from '../../src/core/log/index.js';
import { MemoryRememberedUsers } from '../../src/core/remembered-users.js';

// M2d-5 logs screen, controller: Enter on Home's "Logs" reads through `deps.readLogs` and shows
// what `mm logs` would print - driven with a fake Terminal and a fake reader whose answers the
// test gives one by one. The records are real ones (made by the event builders), so the page is
// the real report. No log folder, no Mail Manager server. Addresses are placeholders.

// --- fixtures -------------------------------------------------------------------------------

const ANNA: AuthUser = {
  email: 'anna@example-test-domain.eu',
  userId: '11111111-1111-4111-8111-111111111111',
};
const SCREEN: Screen = { rows: 24, cols: 100 }; // 21 body lines
const DAY = 86_400_000;
/** 2026-10-04 12:00 UTC. */
const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);
/** This run of the app, a `mm stats` that never finished and a `mm folders` that did. */
const OWN = '0123456789abcdef';
const OTHER = 'fedcba9876543210';
const DONE = 'aaaaaaaaaaaaaaaa';
const RT = { ver: '0.9.0', node: '22.13.0', os: 'linux' };
const TITLE = 'Mail Manager - Logs';
const READING = 'Reading the logs...';
const NONE_24H = 'No log lines in the last 24 h.';
const ASCII = /^[\x20-\x7e]*$/;

const BOX: MailAccount = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  userId: ANNA.userId,
  label: null,
  email: 'box@example-test-domain.eu',
  provider: 'websupport',
  host: 'imap.example-test-domain.eu',
  port: 993,
  username: 'box',
  authType: 'password',
  secret: { ciphertext: 'CIPHERTEXT', iv: 'IV', tag: 'TAG', keyVersion: 1 },
  capabilities: null,
  createdAt: new Date(NOW),
  updatedAt: new Date(NOW),
  lastCheckedAt: null,
};

function at(day: number, hours: number, minutes: number, seconds: number): number {
  return Date.UTC(2026, 9, day, hours, minutes, seconds);
}

function rec(event: LogEvent, when: number, run: string): LogRecord {
  const rendered = renderEvent(event, { run, ver: '0.9.0', now: () => when, level: 'debug' });
  if (rendered === null) throw new Error('not rendered');
  return rendered.record;
}

function resultOf(over: Partial<ReadResult> = {}): ReadResult {
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

function runInfo(cmd: string, last: LogRecord, finished: boolean): RunInfo {
  return { cmd, started: true, finished, lastTs: last.ts, truncatedDay: false };
}

/**
 * Two days as the reader returns them: yesterday a `mm folders` that finished and a `mm stats`
 * that didn't, today this run of the app - which has no finish either, so the reader marks it
 * too.
 */
function twoDays(): ReadResult {
  const foldersStart = rec(commandStart('folders', [], RT), at(3, 19, 0, 0), DONE);
  const fallback = rec(capabilityFallback('status-size'), at(3, 19, 0, 3), DONE);
  const foldersEnd = rec(commandFinish('folders', 0, 10_000), at(3, 19, 0, 10), DONE);
  const statsStart = rec(commandStart('stats', [], RT), at(3, 20, 0, 0), OTHER);
  const appStart = rec(commandStart('app', [], RT), at(4, 11, 50, 0), OWN);
  const signedIn = rec(authLogin(ANNA.userId), at(4, 11, 50, 5), OWN);
  return resultOf({
    records: [foldersStart, fallback, foldersEnd, statsStart, appStart, signedIn],
    runs: new Map([
      [DONE, runInfo('folders', foldersEnd, true)],
      [OTHER, runInfo('stats', statsStart, false)],
      [OWN, runInfo('app', signedIn, false)],
    ]),
    interrupted: [
      { run: OTHER, cmd: 'stats', ts: statsStart.ts },
      { run: OWN, cmd: 'app', ts: signedIn.ts },
    ],
  });
}

/** The page of twoDays() in UTC: the marker of the other run, none for this one. */
const TWO_DAYS_PAGE = [
  '--- 2026-10-03 ---',
  '19:00:00  folders       started',
  '19:00:03  folders       server reports no folder sizes - summed message sizes instead',
  '19:00:10  folders       finished in 10.0 s',
  '20:00:00  stats         started',
  '20:00:00  stats         interrupted or still running',
  '--- 2026-10-04 ---',
  '11:50:00  app           started',
  '11:50:05  app           Mail Manager login',
];
const OWN_MARKER = '11:50:05  app           interrupted or still running';

/** `n` runs of `mm keygen` today, one line each: `HH:MM:00  keygen  started`. */
function today(n: number): ReadResult {
  const records = Array.from({ length: n }, (_, i) =>
    rec(commandStart('keygen', [], RT), at(4, Math.floor(i / 60), i % 60, 0), DONE),
  );
  const last = records.at(-1);
  return resultOf({
    records,
    runs: new Map(last === undefined ? [] : [[DONE, runInfo('keygen', last, true)]]),
  });
}

function todayLine(i: number): string {
  const hh = String(Math.floor(i / 60)).padStart(2, '0');
  const mm = String(i % 60).padStart(2, '0');
  return `${hh}:${mm}:00  keygen        started`;
}

const k = (name: string, extra: Keypress = {}): Keypress => ({ name, sequence: name, ...extra });
const ENTER = k('return', { sequence: '\r' });
const UP = k('up', { sequence: '\u001b[A' });
const DOWN = k('down', { sequence: '\u001b[B' });
const PAGE_UP = k('pageup', { sequence: '\u001b[5~' });
const PAGE_DOWN = k('pagedown', { sequence: '\u001b[6~' });
const LEFT = k('left', { sequence: '\u001b[D' });
const BACKSPACE = k('backspace', { sequence: '\u007f' });
const ESC = k('escape', { meta: true, sequence: '\u001b' });
const CTRL_C = k('c', { ctrl: true, sequence: '\u0003' });
const ch = (text: string): Keypress => ({ name: text.toLowerCase(), sequence: text });

// --- fakes ----------------------------------------------------------------------------------

interface FakeTerminal extends Terminal {
  readonly frames: Rendered[];
  screen: Screen;
  key(key: Keypress): void;
  resize(): void;
}

function fakeTerminal(screen: Screen): FakeTerminal {
  let keyHandler: ((key: Keypress) => void) | null = null;
  let resizeHandler: (() => void) | null = null;
  const t: FakeTerminal = {
    frames: [],
    screen,
    size: () => t.screen,
    draw: (frame) => {
      t.frames.push(frame);
    },
    clear: () => undefined,
    onKey: (fn) => {
      keyHandler = fn;
    },
    onResize: (fn) => {
      resizeHandler = fn;
    },
    restore: vi.fn<() => void>(),
    close: vi.fn<() => void>(),
    key: (key) => {
      if (keyHandler === null) throw new Error('no key handler registered');
      keyHandler(key);
    },
    resize: () => {
      if (resizeHandler === null) throw new Error('no resize handler registered');
      resizeHandler();
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

/** Lets every pending microtask and the I/O queue run. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function stillRunning(p: Promise<unknown>): Promise<boolean> {
  return Promise.race([p.then(() => false), settle().then(() => true)]);
}

/** The add screen has its own tests: here nothing is looked up, checked or added. */
const NO_ADD: Pick<AppDeps, 'discover' | 'assertNotSaved' | 'addMailbox'> = {
  discover: () => Promise.reject(new Error('no lookup in these tests')),
  assertNotSaved: () => Promise.reject(new Error('no duplicate check in these tests')),
  addMailbox: () => Promise.reject(new Error('no mailbox is added in these tests')),
};

type ReadLogs = AppDeps['readLogs'];
type Asked = Parameters<ReadLogs>[0];

/** One call of the reader: what it was asked for, and its answer for the test to give. */
interface Read extends Deferred<ReadResult> {
  asked: Asked;
}

interface Harness {
  t: FakeTerminal;
  app: App;
  done: Promise<AppResult>;
  log: MemoryEventLog;
  listMailboxes: ReturnType<typeof vi.fn<AppDeps['listMailboxes']>>;
  onUnexpected: ReturnType<typeof vi.fn<(err: unknown) => void>>;
  /** Every read asked for, in order; none answers until the test says so. */
  reads: Read[];
  /** The clock of the app: the tests move it. */
  clock: { now: number };
}

interface Options {
  screen?: Screen;
  mailboxes?: readonly MailAccount[];
  /** The mailbox list instead of `mailboxes`. */
  listMailboxes?: AppDeps['listMailboxes'];
  timeZone?: string;
  /** null: the app is not told which run it is. */
  ownRun?: string | null;
  /** The reader throws this instead of returning a promise. */
  throws?: Error;
}

function makeHarness(o: Options = {}): Harness {
  const t = fakeTerminal(o.screen ?? SCREEN);
  const log = new MemoryEventLog({ run: OWN, ver: '0.9.0', now: () => NOW, level: 'debug' });
  const reads: Read[] = [];
  const clock = { now: NOW };
  const readLogs: ReadLogs = (asked) => {
    if (o.throws !== undefined) throw o.throws;
    const read: Read = { asked, ...deferred<ReadResult>() };
    reads.push(read);
    return read.promise;
  };
  const listMailboxes = vi.fn<AppDeps['listMailboxes']>(
    o.listMailboxes ?? (() => Promise.resolve(o.mailboxes ?? [BOX])),
  );
  const onUnexpected = vi.fn<(err: unknown) => void>();
  const ownRun = o.ownRun === undefined ? OWN : o.ownRun;
  const app = createApp({
    terminal: t,
    version: '0.9.0',
    auth: {
      currentUser: () => Promise.resolve(ANNA),
      login: () => Promise.resolve(ANNA),
      logout: (): Promise<LogoutResult> => Promise.resolve('logged-out'),
    },
    listMailboxes,
    remembered: new MemoryRememberedUsers([ANNA.email]),
    log,
    loginTarget: () => 'ab'.repeat(32),
    onUnexpected,
    findAccount: () => new Promise<MailAccount>(() => undefined),
    openSession: () => Promise.reject(new Error('no mailbox login in these tests')),
    readLogs,
    ...NO_ADD,
    now: () => clock.now,
    timeZone: o.timeZone ?? 'UTC',
    autoStats: false,
    ...(ownRun !== null && { ownRun }),
  });
  return { t, app, done: app.run(), log, listMailboxes, onUnexpected, reads, clock };
}

// --- the driver -----------------------------------------------------------------------------

function lastFrame(h: Harness): Rendered {
  const frame = h.t.frames.at(-1);
  if (frame === undefined) throw new Error('nothing drawn yet');
  return frame;
}

/** The last frame, proven exact: `rows` lines of `cols` plain ASCII columns. */
function lines(h: Harness): string[] {
  const frame = lastFrame(h);
  expect(frame.lines).toHaveLength(h.t.screen.rows);
  for (const line of frame.lines) {
    expect(line).toHaveLength(h.t.screen.cols);
    expect(line).toMatch(ASCII);
  }
  return frame.lines.map((l) => l.trimEnd());
}

const last = (h: Harness): string => lastFrame(h).lines.join('\n');
const header = (h: Harness): string => lines(h)[0] ?? '';
const status = (h: Harness): string => lines(h).at(-2) ?? '';

/** The body without the blank lines below the page. */
function page(h: Harness): string[] {
  const body = lines(h).slice(1, -2);
  while (body.at(-1) === '') body.pop();
  return body;
}

/** The whole body: every line between the header and the status line. */
function body(h: Harness): string[] {
  return lines(h).slice(1, -2);
}

function headerOf(right: string, cols = SCREEN.cols): string {
  return `${TITLE.padEnd(cols - right.length)}${right}`;
}

async function press(h: Harness, ...keys: Keypress[]): Promise<void> {
  for (const key of keys) {
    h.t.key(key);
    await settle();
  }
}

async function ready(h: Harness, needle: string): Promise<void> {
  await vi.waitFor(() => {
    expect(last(h)).toContain(needle);
  });
}

/** ANNA on Home, her mailboxes listed. */
async function atHome(o: Options = {}): Promise<Harness> {
  const h = makeHarness(o);
  await ready(h, 'Sign in as another user');
  await press(h, ENTER);
  await ready(h, 'Log out');
  if (o.listMailboxes === undefined) {
    await ready(h, (o.mailboxes ?? [BOX])[0]?.email ?? 'No mailboxes yet');
  }
  return h;
}

/** The logs screen with its first read under way. */
async function atLogs(o: Options = {}): Promise<Harness> {
  const h = await atHome(o);
  const rows = (o.mailboxes ?? [BOX]).length;
  await press(h, ...Array.from({ length: rows + 1 }, () => DOWN), ENTER);
  expect(header(h)).toContain(TITLE);
  return h;
}

function read(h: Harness, i: number): Read {
  const found = h.reads[i];
  if (found === undefined) throw new Error(`read ${String(i)} was not asked for`);
  return found;
}

/** The read asked for last answers. */
async function answer(h: Harness, result: ReadResult): Promise<void> {
  read(h, h.reads.length - 1).resolve(result);
  await settle();
}

/** The logs screen showing `result`. */
async function showing(result: ReadResult, o: Options = {}): Promise<Harness> {
  const h = await atLogs(o);
  await answer(h, result);
  return h;
}

async function quit(h: Harness): Promise<void> {
  await press(h, ch('q'));
  await expect(h.done).resolves.toEqual({ end: 'quit' });
  await h.app.settled();
}

// --- opening (L1) ---------------------------------------------------------------------------

describe('Enter on "Logs" (L1)', () => {
  it('shows the logs screen and reads the last 24 hours, every level', async () => {
    const h = await atLogs();
    expect(h.reads.map((r) => r.asked)).toEqual([
      { sinceMs: DAY, securityOnly: false, level: 'info' },
    ]);
    expect(header(h)).toBe(headerOf('24 h'));
    expect(status(h)).toBe(READING);
    expect(page(h)).toEqual([]);
    await quit(h);
  });

  it('then the page: what `mm logs` prints, oldest first', async () => {
    const h = await atLogs();
    const result = twoDays();
    const before = structuredClone(result);
    await answer(h, result);
    expect(page(h)).toEqual(TWO_DAYS_PAGE);
    expect(header(h)).toBe(headerOf('24 h'));
    expect(status(h)).toBe('');
    // What the reader returned is its own: read, never changed.
    expect(result).toEqual(before);
    expect(h.reads).toHaveLength(1);
    await quit(h);
  });

  it('with no mailbox "Logs" is the second row', async () => {
    const h = await atLogs({ mailboxes: [] });
    expect(h.reads).toHaveLength(1);
    await answer(h, twoDays());
    expect(page(h)).toEqual(TWO_DAYS_PAGE);
    await quit(h);
  });
});

// --- the page (L2) --------------------------------------------------------------------------

describe('the page (L2)', () => {
  it('the lines of this run are shown; its "still running" marker is not', async () => {
    const h = await showing(twoDays());
    expect(page(h)).toContain('11:50:00  app           started');
    expect(page(h)).toContain('11:50:05  app           Mail Manager login');
    expect(page(h)).toContain('20:00:00  stats         interrupted or still running');
    expect(last(h)).not.toContain(OWN_MARKER);
    await quit(h);
  });

  it('an app that is not told its run shows every marker the reader found', async () => {
    const h = await showing(twoDays(), { ownRun: null });
    expect(page(h)).toEqual([...TWO_DAYS_PAGE, OWN_MARKER]);
    await quit(h);
  });

  it('only this run interrupted: no marker at all', async () => {
    const start = rec(commandStart('app', [], RT), at(4, 11, 50, 0), OWN);
    const h = await showing(
      resultOf({
        records: [start],
        runs: new Map([[OWN, runInfo('app', start, false)]]),
        interrupted: [{ run: OWN, cmd: 'app', ts: start.ts }],
      }),
    );
    expect(page(h)).toEqual(['11:50:00  app           started']);
    await quit(h);
  });

  it('everything from today: no date line', async () => {
    const h = await showing(today(3));
    expect(page(h)).toEqual([todayLine(0), todayLine(1), todayLine(2)]);
    await quit(h);
  });

  it('"today" is the day of `deps.now` when the lines arrive', async () => {
    const h = await atLogs();
    h.clock.now = NOW + DAY;
    await answer(h, today(2));
    expect(page(h)).toEqual(['--- 2026-10-04 ---', todayLine(0), todayLine(1)]);
    await quit(h);
  });

  it('times and days are those of `deps.timeZone`', async () => {
    // 02:30 UTC on the 4th is 22:30 on the 3rd in New York.
    const late = rec(commandStart('keygen', [], RT), at(4, 2, 30, 0), DONE);
    const h = await showing(
      resultOf({ records: [late], runs: new Map([[DONE, runInfo('keygen', late, true)]]) }),
      { timeZone: 'America/New_York' },
    );
    expect(page(h)).toEqual(['--- 2026-10-03 ---', '22:30:00  keygen        started']);
    await quit(h);
  });

  it('every footer, with the keys of this screen instead of the flags of `mm logs` (L5)', async () => {
    const h = await showing({
      ...today(1),
      unreadable: 2,
      unknown: 1,
      omitted: 4,
      skippedFiles: 3,
      runsCapped: true,
    });
    expect(page(h)).toEqual([
      todayLine(0),
      '2 unreadable lines skipped',
      '1 unknown event skipped (newer Mail Manager?)',
      '4 older lines not shown - choose a shorter time or a filter (s, w)',
      '3 log files skipped (not a regular file, not readable or too large)',
      'Too many runs in these files - interrupted runs are not marked',
    ]);
    expect(last(h)).not.toContain('--since');
    await quit(h);
  });

  it('one older line: the singular', async () => {
    const h = await showing({ ...today(1), omitted: 1 });
    expect(page(h)).toEqual([
      todayLine(0),
      '1 older line not shown - choose a shorter time or a filter (s, w)',
    ]);
    await quit(h);
  });

  it('a dash of the report is drawn in ASCII, and so is everything else', async () => {
    const counted = rec(
      imapLoginFailed(
        { provider: 'websupport', ip: '203.0.113.7', target: 'd4'.repeat(32) },
        'auth-failed',
        true,
      ),
      at(4, 9, 0, 0),
      DONE,
    );
    const h = await showing(
      resultOf({ records: [counted], runs: new Map([[DONE, runInfo('folders', counted, true)]]) }),
    );
    expect(page(h)).toEqual([
      '09:00:00  folders       mailbox login failed (websupport): auth failed - counted by the login guard',
    ]);
    await quit(h);
  });

  it('a command name with hostile characters is drawn safe', async () => {
    const cp = (...codes: number[]): string => String.fromCodePoint(...codes);
    const start = rec(commandStart('keygen', [], RT), at(4, 9, 0, 0), DONE);
    const cmd = `ev${cp(0x1b)}[31mil${cp(0x202e)}${cp(0x4e2d)}${cp(0x2014)}`;
    const h = await showing(
      resultOf({
        records: [rec(authLogin(ANNA.userId), at(4, 9, 0, 1), DONE)],
        runs: new Map([[DONE, runInfo(cmd, start, true)]]),
      }),
    );
    // The escape and the override are gone; what is left is ASCII.
    expect(page(h)).toEqual(['09:00:01  ev[31mil?-    Mail Manager login']);
    await quit(h);
  });

  it('a line is made ASCII before it is wrapped: what is drawn is what was measured', async () => {
    // 32 arrows are 64 columns once they are "->": the line no longer fits 80 columns.
    const arrows = String.fromCodePoint(0x2192).repeat(32);
    const start = rec(commandStart('keygen', [], RT), at(4, 9, 0, 0), DONE);
    const h = await showing(
      resultOf({
        records: [rec(authLogin(ANNA.userId), at(4, 9, 0, 1), DONE)],
        runs: new Map([[DONE, runInfo(arrows, start, true)]]),
      }),
      { screen: { rows: 24, cols: 80 } },
    );
    expect(page(h)).toEqual([`09:00:01  ${'->'.repeat(32)}  Mail`, '          Manager login']);
    await quit(h);
  });

  it('a long line wraps at the width, the rest under the command', async () => {
    const h = await showing(twoDays(), { screen: { rows: 24, cols: 60 } });
    expect(page(h).slice(1, 5)).toEqual([
      '19:00:00  folders       started',
      '19:00:03  folders       server reports no folder sizes -',
      '          summed message sizes instead',
      '19:00:10  folders       finished in 10.0 s',
    ]);
    await quit(h);
  });
});

// --- nothing to show, nothing to read (L6) --------------------------------------------------

describe('no lines, and a log folder that cannot be read (L6)', () => {
  it('no log folder yet: "No log lines in the last 24 h."', async () => {
    const h = await showing(resultOf({ folder: 'missing' }));
    expect(page(h)).toEqual([NONE_24H]);
    expect(status(h)).toBe('');
    await quit(h);
  });

  it('a folder with nothing in the window: the same line', async () => {
    const h = await showing(resultOf());
    expect(page(h)).toEqual([NONE_24H]);
    await quit(h);
  });

  it.each<[string, string, string]>([
    ['2', '7 days', 'No log lines in the last 7 days.'],
    ['3', '30 days', 'No log lines in the last 30 days.'],
    ['s', '24 h - security', 'No matching log lines in the last 24 h.'],
    ['w', '24 h - warnings', 'No matching log lines in the last 24 h.'],
  ])('after %s the empty page names what was asked for', async (key, right, text) => {
    const h = await showing(resultOf());
    await press(h, ch(key));
    await answer(h, resultOf());
    expect(header(h)).toBe(headerOf(right));
    expect(page(h)).toEqual([text]);
    await quit(h);
  });

  it('a filter and a longer window: "No matching log lines in the last 30 days."', async () => {
    const h = await showing(resultOf());
    await press(h, ch('3'), ch('w'), ch('s'));
    await answer(h, resultOf());
    expect(header(h)).toBe(headerOf('30 days - security - warnings'));
    expect(page(h)).toEqual(['No matching log lines in the last 30 days.']);
    await quit(h);
  });

  it('not a folder: the text of `mm logs`, in the body', async () => {
    const h = await showing(resultOf({ folder: 'not-a-folder' }));
    expect(page(h)).toEqual([
      '    The log folder is a link or a file, not a folder, so nothing is logged or read. Check it with',
      "    'mm logs path' and 'mm doctor'.",
    ]);
    expect(page(h).join(' ').replace(/\s+/g, ' ').trim()).toBe(LOG_FOLDER_PROBLEM['not-a-folder']);
    expect(header(h)).toBe(headerOf('24 h'));
    expect(status(h)).toBe('');
    await quit(h);
  });

  it('unreadable: its text, the dash in ASCII', async () => {
    const h = await showing(resultOf({ folder: 'unreadable' }));
    expect(page(h)).toEqual([
      "    Can't read the log folder - check its permissions ('mm logs path' shows where it is).",
    ]);
    await quit(h);
  });

  it('a folder problem hides whatever else the result holds', async () => {
    const h = await showing({ ...twoDays(), folder: 'unreadable', unreadable: 3 });
    expect(page(h)).toHaveLength(1);
    expect(last(h)).not.toContain('folders');
    expect(last(h)).not.toContain('skipped');
    await quit(h);
  });

  it('r after the problem is gone: the page', async () => {
    const h = await showing(resultOf({ folder: 'unreadable' }));
    await press(h, ch('r'));
    expect(h.reads).toHaveLength(2);
    expect(read(h, 1).asked).toEqual(read(h, 0).asked);
    expect(status(h)).toBe(READING);
    expect(page(h)).toEqual([]);
    await answer(h, twoDays());
    expect(page(h)).toEqual(TWO_DAYS_PAGE);
    await quit(h);
  });

  it('a page, then the folder becomes unreadable: only the reason is left', async () => {
    const h = await showing(twoDays());
    await press(h, ch('r'));
    // Until the answer the page stays.
    expect(page(h)).toEqual(TWO_DAYS_PAGE);
    await answer(h, resultOf({ folder: 'not-a-folder' }));
    expect(last(h)).not.toContain('folders       started');
    expect(page(h)[0]).toContain('The log folder is a link or a file');
    await quit(h);
  });
});

// --- the keys (L1, L4) ----------------------------------------------------------------------

describe('the keys that read again (L1, L4)', () => {
  it.each<[string, number, string]>([
    ['1', DAY, '24 h'],
    ['2', 7 * DAY, '7 days'],
    ['3', 30 * DAY, '30 days'],
  ])('%s reads %i ms back', async (key, sinceMs, right) => {
    const h = await showing(twoDays());
    await press(h, ch(key));
    expect(h.reads).toHaveLength(2);
    expect(read(h, 1).asked).toEqual({ sinceMs, securityOnly: false, level: 'info' });
    expect(header(h)).toBe(headerOf(right));
    expect(status(h)).toBe(READING);
    // The lines stay until the new ones are there.
    expect(page(h)).toEqual(TWO_DAYS_PAGE);
    await answer(h, today(2));
    expect(page(h)).toEqual([todayLine(0), todayLine(1)]);
    expect(status(h)).toBe('');
    await quit(h);
  });

  it('s asks for the security events only, w for warnings and errors; they combine', async () => {
    const h = await showing(twoDays());
    await press(h, ch('s'));
    expect(read(h, 1).asked).toEqual({ sinceMs: DAY, securityOnly: true, level: 'info' });
    expect(header(h)).toBe(headerOf('24 h - security'));
    await press(h, ch('w'));
    expect(read(h, 2).asked).toEqual({ sinceMs: DAY, securityOnly: true, level: 'warn' });
    expect(header(h)).toBe(headerOf('24 h - security - warnings'));
    await press(h, ch('2'));
    expect(read(h, 3).asked).toEqual({ sinceMs: 7 * DAY, securityOnly: true, level: 'warn' });
    expect(header(h)).toBe(headerOf('7 days - security - warnings'));
    await press(h, ch('s'));
    expect(read(h, 4).asked).toEqual({ sinceMs: 7 * DAY, securityOnly: false, level: 'warn' });
    expect(header(h)).toBe(headerOf('7 days - warnings'));
    await press(h, ch('w'));
    expect(read(h, 5).asked).toEqual({ sinceMs: 7 * DAY, securityOnly: false, level: 'info' });
    expect(header(h)).toBe(headerOf('7 days'));
    expect(h.reads).toHaveLength(6);
    await quit(h);
  });

  it('r asks for the same once more', async () => {
    const h = await showing(twoDays());
    await press(h, ch('3'), ch('w'));
    await answer(h, twoDays());
    await press(h, ch('r'));
    expect(h.reads).toHaveLength(4);
    expect(read(h, 3).asked).toEqual({ sinceMs: 30 * DAY, securityOnly: false, level: 'warn' });
    expect(read(h, 3).asked).toEqual(read(h, 2).asked);
    await quit(h);
  });

  it('upper case works too', async () => {
    const h = await showing(twoDays());
    await press(h, ch('S'), ch('W'), ch('R'));
    expect(h.reads.map((r) => r.asked)).toEqual([
      { sinceMs: DAY, securityOnly: false, level: 'info' },
      { sinceMs: DAY, securityOnly: true, level: 'info' },
      { sinceMs: DAY, securityOnly: true, level: 'warn' },
      { sinceMs: DAY, securityOnly: true, level: 'warn' },
    ]);
    await quit(h);
  });

  it('keys that mean nothing here read nothing and change nothing', async () => {
    const h = await showing(twoDays());
    const before = last(h);
    await press(h, ENTER, ch('x'), ch('4'), ch('0'), ch('o'), k('tab'), k('f5'));
    expect(h.reads).toHaveLength(1);
    expect(last(h)).toBe(before);
    await quit(h);
  });
});

describe('scrolling (L3, L4)', () => {
  it('opens at the newest line: the last row on the last body line', async () => {
    const h = await showing(today(50));
    expect(body(h)).toEqual(Array.from({ length: 21 }, (_, i) => todayLine(29 + i)));
    await quit(h);
  });

  it('Up and PgUp go to older lines, Down and PgDn back; both ends hold', async () => {
    const h = await showing(today(50));
    await press(h, UP);
    expect(body(h)[0]).toBe(todayLine(28));
    expect(body(h)[20]).toBe(todayLine(48));
    await press(h, PAGE_UP);
    expect(body(h)[0]).toBe(todayLine(7));
    await press(h, PAGE_UP, PAGE_UP, UP);
    expect(body(h)).toEqual(Array.from({ length: 21 }, (_, i) => todayLine(i)));
    await press(h, DOWN);
    expect(body(h)[0]).toBe(todayLine(1));
    await press(h, PAGE_DOWN);
    expect(body(h)[0]).toBe(todayLine(22));
    await press(h, PAGE_DOWN, PAGE_DOWN, DOWN);
    expect(body(h)[20]).toBe(todayLine(49));
    expect(h.reads).toHaveLength(1);
    await quit(h);
  });

  it('a new read starts at the bottom again', async () => {
    const h = await showing(today(50));
    await press(h, PAGE_UP);
    expect(body(h)[20]).toBe(todayLine(28));
    await press(h, ch('r'));
    expect(body(h)[20]).toBe(todayLine(49));
    await answer(h, today(60));
    expect(body(h)[20]).toBe(todayLine(59));
    await quit(h);
  });

  it('a resize draws the page for the new size', async () => {
    const h = await showing(today(50));
    h.t.screen = { rows: 10, cols: 40 };
    h.t.resize();
    await settle();
    expect(body(h)).toEqual(Array.from({ length: 7 }, (_, i) => todayLine(43 + i)));
    expect(header(h)).toBe(headerOf('24 h', 40));
    await quit(h);
  });

  it('too small: only "window too small", and only q acts', async () => {
    const h = await showing(today(50));
    h.t.screen = { rows: 6, cols: 100 };
    h.t.resize();
    await settle();
    expect(last(h)).toContain('Window too small');
    expect(last(h)).not.toContain('keygen');
    await press(h, ch('2'), ch('s'), ch('w'), ch('r'), UP, PAGE_UP, ESC, LEFT, BACKSPACE, ENTER);
    expect(h.reads).toHaveLength(1);
    expect(last(h)).toContain('Window too small');
    expect(last(h)).not.toContain('Log out');
    // Large again: the page is where it was.
    h.t.screen = SCREEN;
    h.t.resize();
    await settle();
    expect(body(h)[20]).toBe(todayLine(49));
    h.t.screen = { rows: 6, cols: 100 };
    h.t.resize();
    await settle();
    await quit(h);
  });
});

// --- leaving (L4) ---------------------------------------------------------------------------

describe('back to Home and out (L4)', () => {
  it.each<[string, Keypress]>([
    ['Esc', ESC],
    ['Left', LEFT],
    ['Backspace', BACKSPACE],
  ])(
    '%s: Home as it was - the same list, the cursor on "Logs", nothing loaded again',
    async (_name, back) => {
      const h = await atHome();
      await press(h, DOWN, DOWN);
      const home = lastFrame(h);
      await press(h, ENTER);
      await answer(h, twoDays());
      await press(h, PAGE_UP, ch('2'), back);
      expect(lastFrame(h)).toEqual(home);
      expect(h.listMailboxes).toHaveBeenCalledTimes(1);
      expect(h.reads).toHaveLength(2);
      // Enter is on "Logs" again: a fresh visit, 24 hours.
      await press(h, ENTER);
      expect(header(h)).toBe(headerOf('24 h'));
      expect(read(h, 2).asked).toEqual({ sinceMs: DAY, securityOnly: false, level: 'info' });
      expect(page(h)).toEqual([]);
      await quit(h);
    },
  );

  it('opened while the mailbox list was still loading: back on Home the list is asked for again', async () => {
    const first = deferred<readonly MailAccount[]>();
    const lists = [first.promise];
    const h = await atHome({ listMailboxes: () => lists.shift() ?? Promise.resolve([BOX]) });
    expect(last(h)).toContain('Loading your mailboxes...');
    // No mailbox rows yet: "Logs" is the second row.
    await press(h, DOWN, ENTER);
    expect(header(h)).toBe(headerOf('24 h'));
    // The list arrives behind the logs: the answer to an older request, dropped.
    first.resolve([BOX]);
    await settle();
    await answer(h, twoDays());
    expect(page(h)).toEqual(TWO_DAYS_PAGE);
    expect(h.listMailboxes).toHaveBeenCalledTimes(1);
    await press(h, ESC);
    expect(h.listMailboxes).toHaveBeenCalledTimes(2);
    await ready(h, BOX.email);
    expect(last(h)).not.toContain('Loading your mailboxes...');
    expect(h.log.records).toEqual([]);
    await quit(h);
  });

  it('a list still on its way at Esc: its late answer is dropped, the new one is shown', async () => {
    const first = deferred<readonly MailAccount[]>();
    const second = deferred<readonly MailAccount[]>();
    const lists = [first.promise, second.promise];
    const h = await atHome({ listMailboxes: () => lists.shift() ?? Promise.resolve([]) });
    await press(h, DOWN, ENTER, ESC);
    expect(h.listMailboxes).toHaveBeenCalledTimes(2);
    expect(last(h)).toContain('Loading your mailboxes...');
    first.resolve([]);
    await settle();
    expect(last(h)).toContain('Loading your mailboxes...');
    expect(last(h)).not.toContain('No mailboxes yet');
    second.resolve([BOX]);
    await ready(h, BOX.email);
    // In and out once more: the list is there now, nothing is asked for again.
    await press(h, DOWN, DOWN, ENTER, ESC);
    expect(h.listMailboxes).toHaveBeenCalledTimes(2);
    expect(last(h)).toContain(BOX.email);
    await quit(h);
  });

  it('q quits from the page, from a read under way and from a folder problem', async () => {
    const shown = await showing(twoDays());
    await quit(shown);
    const reading = await atLogs();
    await quit(reading);
    const failed = await showing(resultOf({ folder: 'unreadable' }));
    await quit(failed);
  });

  it('Ctrl+C ends the app as everywhere', async () => {
    const h = await showing(twoDays());
    await press(h, CTRL_C);
    await expect(h.done).resolves.toEqual({ end: 'interrupt' });
    await h.app.settled();
  });
});

// --- results nobody waits for (L7) ----------------------------------------------------------

describe('a result nobody waits for changes nothing (L7)', () => {
  it('the answer to an earlier read is dropped, whenever it comes', async () => {
    const h = await atLogs();
    await press(h, ch('2'));
    expect(h.reads).toHaveLength(2);
    const frames = h.t.frames.length;
    const waiting = lastFrame(h);
    read(h, 0).resolve(twoDays());
    await settle();
    // Not a line of it, and nothing was drawn for it.
    expect(h.t.frames).toHaveLength(frames);
    expect(lastFrame(h)).toEqual(waiting);
    expect(status(h)).toBe(READING);
    expect(page(h)).toEqual([]);
    read(h, 1).resolve(today(2));
    await settle();
    expect(page(h)).toEqual([todayLine(0), todayLine(1)]);
    expect(header(h)).toBe(headerOf('7 days'));
    await quit(h);
  });

  it('the earlier read answers after the later one: the later one stays', async () => {
    const h = await atLogs();
    await press(h, ch('s'));
    read(h, 1).resolve(today(2));
    await settle();
    const frames = h.t.frames.length;
    read(h, 0).resolve(twoDays());
    await settle();
    expect(h.t.frames).toHaveLength(frames);
    expect(page(h)).toEqual([todayLine(0), todayLine(1)]);
    await quit(h);
  });

  it('a folder problem of an earlier read is dropped too', async () => {
    const h = await showing(twoDays());
    await press(h, ch('r'), ch('r'));
    read(h, 1).resolve(resultOf({ folder: 'unreadable' }));
    await settle();
    expect(page(h)).toEqual(TWO_DAYS_PAGE);
    expect(status(h)).toBe(READING);
    read(h, 2).resolve(today(1));
    await settle();
    expect(page(h)).toEqual([todayLine(0)]);
    await quit(h);
  });

  it('five keys in a row: five reads, and only the last one is shown', async () => {
    const h = await atLogs();
    await press(h, ch('2'), ch('3'), ch('s'), ch('w'), ch('1'));
    expect(h.reads).toHaveLength(6);
    for (const [i, r] of h.reads.entries()) r.resolve(today(i + 1));
    await settle();
    expect(page(h)).toEqual(Array.from({ length: 6 }, (_, i) => todayLine(i)));
    expect(read(h, 5).asked).toEqual({ sinceMs: DAY, securityOnly: true, level: 'warn' });
    await quit(h);
  });

  it('after Esc the answer changes nothing: Home stays, nothing is drawn', async () => {
    const h = await atLogs();
    await press(h, ESC);
    const home = lastFrame(h);
    const frames = h.t.frames.length;
    read(h, 0).resolve(twoDays());
    await settle();
    expect(h.t.frames).toHaveLength(frames);
    expect(lastFrame(h)).toEqual(home);
    expect(last(h)).toContain('Log out');
    expect(last(h)).not.toContain(TITLE);
    expect(await stillRunning(h.done)).toBe(true);
    await quit(h);
  });

  it('left and opened again: the first read is not the one shown', async () => {
    const h = await atLogs();
    await press(h, ESC, ENTER);
    expect(h.reads).toHaveLength(2);
    read(h, 0).resolve(twoDays());
    await settle();
    expect(page(h)).toEqual([]);
    expect(status(h)).toBe(READING);
    read(h, 1).resolve(today(1));
    await settle();
    expect(page(h)).toEqual([todayLine(0)]);
    await quit(h);
  });

  it('an answer after the app has ended draws nothing', async () => {
    const h = await atLogs();
    await quit(h);
    const frames = h.t.frames.length;
    read(h, 0).resolve(twoDays());
    await settle();
    expect(h.t.frames).toHaveLength(frames);
  });

  it('looking at the logs writes no log line', async () => {
    const h = await atLogs();
    await answer(h, twoDays());
    await press(h, ch('2'), ch('s'), ch('w'), ch('r'), UP, PAGE_UP, ESC, ENTER);
    await answer(h, resultOf({ folder: 'unreadable' }));
    await press(h, ch('r'));
    await answer(h, resultOf({ folder: 'missing' }));
    await press(h, ESC);
    expect(h.log.records).toEqual([]);
    expect(h.log.lines).toEqual([]);
    expect(h.onUnexpected).not.toHaveBeenCalled();
    await quit(h);
    expect(h.log.records).toEqual([]);
  });
});

// --- a reader that fails --------------------------------------------------------------------

describe('a reader that fails', () => {
  it('a rejection ends the app with that error', async () => {
    const h = await atLogs();
    const boom = new Error('reader broke');
    read(h, 0).reject(boom);
    await expect(h.done).rejects.toBe(boom);
    await h.app.settled();
    expect(h.log.records).toEqual([]);
  });

  it('a reader that throws ends the app the same way', async () => {
    const boom = new Error('reader threw');
    const h = await atHome({ throws: boom });
    const crashed = expect(h.done).rejects.toBe(boom);
    await press(h, DOWN, DOWN, ENTER);
    await crashed;
    await h.app.settled();
  });

  it('a rejection of an earlier read ends the app too: it is never expected', async () => {
    const h = await atLogs();
    await press(h, ch('2'));
    const boom = new Error('reader broke');
    read(h, 0).reject(boom);
    await expect(h.done).rejects.toBe(boom);
    await h.app.settled();
  });

  it('after the app has ended a rejection is nobody to tell', async () => {
    const h = await atLogs();
    await quit(h);
    read(h, 0).reject(new Error('too late'));
    await settle();
    await expect(h.done).resolves.toEqual({ end: 'quit' });
  });
});
