import { describe, it, expect } from 'vitest';
import { logsBody, logsBusy, logsHeader, logsHelp } from '../../src/cli/app/logs-render.js';
import { logRows } from '../../src/cli/app/logs.js';
import { reduceApp, startApp } from '../../src/cli/app/reduce.js';
import { renderApp } from '../../src/cli/app/render.js';
import { initialApp } from '../../src/cli/app/state.js';
import type {
  AppAction,
  AppKey,
  AppState,
  HomeView,
  LogsView,
  LogsWindow,
  MailboxRow,
} from '../../src/cli/app/state.js';
import { helpLine } from '../../src/cli/browser/layout.js';
import type { Rendered } from '../../src/cli/browser/render.js';
import { bodyHeight } from '../../src/cli/browser/state.js';
import type { Screen } from '../../src/cli/browser/state.js';
import type { AuthUser } from '../../src/core/auth.js';

// M2d-5 logs screen, drawn: renderApp over states built with the reducers - the header with
// the window and the filters, the page with its end on the last body line, wrapped lines, the
// reason a log folder can't be read, the status line and the key help - and the pieces of
// logs-render.ts on their own. Every frame is proven exact in size and plain ASCII. Addresses
// are placeholders; hostile characters are made from their code points.

// --- fixtures -------------------------------------------------------------------------------

const ANNA: AuthUser = { email: 'anna@example-test-domain.eu', userId: 'user-anna' };
const SMALLEST: Screen = { rows: 8, cols: 40 }; // 5 body lines
const SCREEN: Screen = { rows: 24, cols: 80 }; // 21 body lines
const WIDE: Screen = { rows: 50, cols: 200 }; // 47 body lines
const SCREENS: Screen[] = [SMALLEST, SCREEN, WIDE];
const ASCII = /^[\x20-\x7e]*$/;
const TITLE = 'Mail Manager - Logs';
const READING = 'Reading the logs...';
const HELP_ALL =
  'Up/Down scroll  1 24 h  2 7 days  3 30 days  s security  w warnings  r read again  Esc back  q quit';
const MAILBOX: MailboxRow = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'box@example-test-domain.eu',
  provider: 'websupport',
  lastCheckedAt: null,
};

/** A page of `mm logs` over two days; the third line is 56 columns wide. */
const REPORT = [
  '--- 2026-10-03 ---',
  '09:15:02  app           Signed in',
  '09:15:40  app           Opened a mailbox with 12 folders',
  '--- 2026-10-04 ---',
  '08:30:11  account add   Added a mailbox',
  '2 unreadable lines skipped',
];
/** REPORT in rows of 40 columns. */
const REPORT_40 = [
  '--- 2026-10-03 ---',
  '09:15:02  app           Signed in',
  '09:15:40  app           Opened a mailbox',
  '          with 12 folders',
  '--- 2026-10-04 ---',
  '08:30:11  account add   Added a mailbox',
  '2 unreadable lines skipped',
];
const FAILURE = 'The log folder cannot be read - check its permissions.';

/** `n` numbered lines, each fits 40 columns. */
function linesOf(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `10:00:00  app           Line ${String(i + 1)}`);
}

const cp = (...codes: number[]): string => String.fromCodePoint(...codes);
/**
 * An escape sequence, a bidi override, wide and combining characters, an emoji, a NUL, a tab and
 * line breaks, half a surrogate pair.
 */
const HOSTILE = [
  `10:00:00  app           red${cp(0x1b)}[31m alert${cp(0x07)}`,
  `10:00:01  app           ${cp(0x202e)}reversed${cp(0x202c)} text`,
  `10:00:02  app           wide ${cp(0x4e2d, 0x6587).repeat(30)} end`,
  `10:00:03  app           mail ${cp(0x1f4e7)} e${cp(0x0301)} zero${cp(0x200b)}width`,
  `10:00:04  app           n${cp(0)}u${cp(9)}l${cp(0x0a)}s${cp(0x0d)}`,
  `10:00:05  app           half ${cp(0xd83d)} pair, dash ${cp(0x2014)} arrow ${cp(0x2192)}`,
];

// --- the driver -----------------------------------------------------------------------------

function key(type: Exclude<AppKey['type'], 'char'>): AppAction {
  return { type: 'key', key: { type } };
}

function ch(text: string): AppAction {
  return { type: 'key', key: { type: 'char', text } };
}

function repeat(action: AppAction, n: number): AppAction[] {
  return Array.from({ length: n }, () => action);
}

function act(state: AppState, ...actions: AppAction[]): AppState {
  let s = state;
  for (const a of actions) s = reduceApp(s, a).state;
  return s;
}

function view(state: AppState): LogsView {
  if (state.view.kind !== 'logs') throw new Error(`not on the logs: ${state.view.kind}`);
  return state.view;
}

/** The logs screen as Enter on Home's "Logs" opens it: the first read is under way. */
function opened(screen: Screen = SCREEN): AppState {
  const s0 = startApp(initialApp('1.2.3', screen)).state;
  const s1 = act(
    s0,
    { type: 'session', generation: s0.generation, user: ANNA, remembered: [ANNA.email] },
    key('enter'),
  );
  return act(
    s1,
    { type: 'mailboxes', generation: s1.generation, rows: [MAILBOX] },
    key('down'),
    key('down'),
    key('enter'),
  );
}

function arrived(state: AppState, lines: readonly string[]): AppState {
  return act(state, { type: 'logs-read', generation: state.generation, lines });
}

function refused(state: AppState, text: string = FAILURE): AppState {
  return act(state, { type: 'logs-failed', generation: state.generation, text });
}

/** The logs screen showing `lines`. */
function shown(lines: readonly string[], screen: Screen = SCREEN): AppState {
  return arrived(opened(screen), lines);
}

const HOME: HomeView = {
  kind: 'home',
  mode: 'list',
  mailboxes: [MAILBOX],
  loadFailed: false,
  cursor: 2,
  message: null,
  focusId: null,
  added: null,
};

/** A logs view made by hand: for what no reducer would put there. */
function viewOf(over: Partial<LogsView> = {}): LogsView {
  return {
    kind: 'logs',
    home: HOME,
    mode: 'shown',
    window: '24h',
    securityOnly: false,
    warnOnly: false,
    lines: [],
    failure: null,
    scroll: 0,
    ...over,
  };
}

function stateOf(over: Partial<LogsView>, screen: Screen = SCREEN): AppState {
  return { ...initialApp('1.2.3', screen), current: ANNA, view: viewOf(over) };
}

// --- reading a frame ------------------------------------------------------------------------

/** The frame of `state`, proven exact: `rows` lines of `cols` plain ASCII columns, no cursor. */
function frame(state: AppState): Rendered {
  const out = renderApp(state);
  expect(out.lines).toHaveLength(state.screen.rows);
  for (const line of out.lines) {
    expect(line).toHaveLength(state.screen.cols);
    expect(line).toMatch(ASCII);
  }
  expect(out.cursorLine).toBeNull();
  return out;
}

function trimmed(out: Rendered): string[] {
  return out.lines.map((l) => l.trimEnd());
}

function lineAt(out: Rendered, i: number): string {
  return (out.lines[i] ?? '').trimEnd();
}

function status(out: Rendered): string {
  return lineAt(out, out.lines.length - 2);
}

function help(out: Rendered): string {
  return lineAt(out, out.lines.length - 1);
}

/** The body: every line between the header and the status line. */
function body(out: Rendered): string[] {
  return trimmed(out).slice(1, -2);
}

/** The header as it is drawn: the title on the left, `right` at the right edge. */
function header(right: string, cols = 80): string {
  return `${TITLE.padEnd(cols - right.length)}${right}`;
}

function blank(n: number): string[] {
  return Array.from({ length: n }, () => '');
}

// --- whole frames ---------------------------------------------------------------------------

describe('the logs screen: whole frames (L1, L3)', () => {
  it('40x8: the newest rows, the last one on the last body line', () => {
    expect(logRows(REPORT, 40)).toEqual(REPORT_40);
    expect(trimmed(frame(shown(REPORT, SMALLEST)))).toEqual([
      'Mail Manager - Logs                 24 h',
      '09:15:40  app           Opened a mailbox',
      '          with 12 folders',
      '--- 2026-10-04 ---',
      '08:30:11  account add   Added a mailbox',
      '2 unreadable lines skipped',
      '',
      '1 24 h  2 7 days  Esc back  q quit',
    ]);
  });

  it('80x24: fewer rows than the body start at the top', () => {
    expect(trimmed(frame(shown(REPORT, SCREEN)))).toEqual([
      header('24 h'),
      ...REPORT,
      ...blank(15),
      '',
      '1 24 h  2 7 days  3 30 days  s security  w warnings  Esc back  q quit',
    ]);
  });

  it('200x50: every key in the help', () => {
    expect(trimmed(frame(shown(REPORT, WIDE)))).toEqual([
      header('24 h', 200),
      ...REPORT,
      ...blank(41),
      '',
      HELP_ALL,
    ]);
  });

  it.each(SCREENS)('$rows x $cols while the first read is under way: an empty page', (screen) => {
    const out = frame(opened(screen));
    expect(lineAt(out, 0)).toBe(header('24 h', screen.cols));
    expect(body(out)).toEqual(blank(screen.rows - 3));
    expect(status(out)).toBe(READING);
  });

  it.each(SCREENS)('$rows x $cols with no line at all', (screen) => {
    const out = frame(shown([], screen));
    expect(body(out)).toEqual(blank(screen.rows - 3));
    expect(status(out)).toBe('');
  });
});

// --- the header (L1) ------------------------------------------------------------------------

describe('the header (L1)', () => {
  const WINDOWS: [string, string][] = [
    ['1', '24 h'],
    ['2', '7 days'],
    ['3', '30 days'],
  ];

  it.each(WINDOWS)('key %s: %s', (text, right) => {
    const s = act(shown(REPORT), ch(text));
    expect(lineAt(frame(s), 0)).toBe(header(right));
    // It names what was asked for, also once the lines are there.
    expect(lineAt(frame(arrived(s, REPORT)), 0)).toBe(header(right));
  });

  it.each([
    [['s'], '24 h - security'],
    [['w'], '24 h - warnings'],
    [['s', 'w'], '24 h - security - warnings'],
    [['w', 's'], '24 h - security - warnings'],
    [['2', 's'], '7 days - security'],
    [['3', 'w'], '30 days - warnings'],
    [['3', 'w', 's'], '30 days - security - warnings'],
    [['s', 's'], '24 h'],
    [['s', 'w', 'w'], '24 h - security'],
  ] as const)('keys %j: %s', (keys, right) => {
    const s = act(shown(REPORT), ...keys.map(ch));
    expect(lineAt(frame(s), 0)).toBe(header(right));
  });

  it('at 40 columns the title gives way to what is shown', () => {
    const s = shown(REPORT, SMALLEST);
    expect(lineAt(frame(act(s, ch('s'))), 0)).toBe('Mail Manager - Logs      24 h - security');
    expect(lineAt(frame(act(s, ch('s'), ch('w'))), 0)).toBe(
      'Mail Manag... 24 h - security - warnings',
    );
    expect(lineAt(frame(act(s, ch('3'), ch('s'), ch('w'))), 0)).toBe(
      'Mail Ma... 30 days - security - warnings',
    );
  });

  it('after a failure the header still names the request', () => {
    const s = act(shown(REPORT), ch('2'), ch('w'));
    expect(lineAt(frame(refused(s)), 0)).toBe(header('7 days - warnings'));
  });
});

// --- the page (L3) --------------------------------------------------------------------------

describe('the page (L3)', () => {
  it('more rows than the body: the last 21 of 30, the newest on the last body line', () => {
    const lines = linesOf(30);
    const out = frame(shown(lines));
    expect(body(out)).toEqual(lines.slice(9));
    expect(lineAt(out, 21)).toBe('10:00:00  app           Line 30');
  });

  it('exactly as many rows as the body', () => {
    expect(body(frame(shown(linesOf(21))))).toEqual(linesOf(21));
  });

  it('one row fewer than the body: from the top, one blank line below', () => {
    expect(body(frame(shown(linesOf(20))))).toEqual([...linesOf(20), '']);
  });

  it('Up shows older rows, one more for each press', () => {
    const lines = linesOf(30);
    const s = shown(lines);
    expect(body(frame(act(s, key('up'))))).toEqual(lines.slice(8, 29));
    expect(body(frame(act(s, ...repeat(key('up'), 5))))).toEqual(lines.slice(4, 25));
    expect(body(frame(act(s, ...repeat(key('up'), 9))))).toEqual(lines.slice(0, 21));
    expect(body(frame(act(s, ...repeat(key('up'), 30))))).toEqual(lines.slice(0, 21));
  });

  it('PgUp and PgDn show the page before and after', () => {
    const lines = linesOf(100);
    const s = shown(lines);
    expect(body(frame(act(s, key('pageup'))))).toEqual(lines.slice(58, 79));
    expect(body(frame(act(s, key('pageup'), key('pageup'))))).toEqual(lines.slice(37, 58));
    expect(body(frame(act(s, key('pageup'), key('pagedown'))))).toEqual(lines.slice(79));
  });

  it('a wrapped line scrolls row by row', () => {
    const s = shown(REPORT, SMALLEST);
    expect(body(frame(s))).toEqual(REPORT_40.slice(2));
    expect(body(frame(act(s, key('up'))))).toEqual(REPORT_40.slice(1, 6));
    expect(body(frame(act(s, key('up'), key('up'))))).toEqual(REPORT_40.slice(0, 5));
    expect(body(frame(act(s, ...repeat(key('up'), 9))))).toEqual(REPORT_40.slice(0, 5));
  });

  it('a scroll position past the page is drawn as its top (after a resize)', () => {
    const small = act(shown(linesOf(30), SMALLEST), ...repeat(key('pageup'), 9));
    expect(view(small).scroll).toBe(25);
    expect(body(frame(small))).toEqual(linesOf(30).slice(0, 5));
    const large = act(small, { type: 'resize', screen: SCREEN });
    expect(view(large).scroll).toBe(25);
    expect(body(frame(large))).toEqual(linesOf(30).slice(0, 21));
    // Wide enough for every row: all of them, from the top.
    const wide = act(small, { type: 'resize', screen: WIDE });
    expect(body(frame(wide))).toEqual([...linesOf(30), ...blank(17)]);
  });

  it('a resize wraps the lines for the new width', () => {
    const s = shown(REPORT, WIDE);
    expect(body(frame(s)).slice(0, 6)).toEqual(REPORT);
    const narrow = act(s, { type: 'resize', screen: SMALLEST });
    expect(body(frame(narrow))).toEqual(REPORT_40.slice(2));
  });

  it('a line of one very long word is cut at the width', () => {
    const out = frame(shown([`10:00:00  ${'w'.repeat(90)}`], SMALLEST));
    expect(body(out)).toEqual([
      `10:00:00  ${'w'.repeat(30)}`,
      `          ${'w'.repeat(30)}`,
      `          ${'w'.repeat(30)}`,
      '',
      '',
    ]);
  });

  it('while a new read is under way the lines stay, and the status says so', () => {
    const s = act(shown(linesOf(30)), key('up'), ch('r'));
    const out = frame(s);
    expect(status(out)).toBe(READING);
    // The new request starts at the bottom of the page.
    expect(body(out)).toEqual(linesOf(30).slice(9));
    expect(status(frame(arrived(s, REPORT)))).toBe('');
    expect(body(frame(arrived(s, REPORT))).slice(0, 6)).toEqual(REPORT);
  });
});

// --- a log folder that can't be read (L6) ---------------------------------------------------

describe("a log folder that can't be read (L6)", () => {
  it('the reason is in the body, wrapped and indented; nothing else', () => {
    const out = frame(refused(opened(SMALLEST)));
    expect(body(out)).toEqual([
      '    The log folder cannot be read -',
      '    check its permissions.',
      '',
      '',
      '',
    ]);
    expect(status(out)).toBe('');
  });

  it('wide enough: one line', () => {
    expect(body(frame(refused(opened())))).toEqual([`    ${FAILURE}`, ...blank(20)]);
  });

  it('the lines of an earlier read are gone', () => {
    const s = refused(act(shown(linesOf(30)), ch('r')));
    expect(body(frame(s))).toEqual([`    ${FAILURE}`, ...blank(20)]);
  });

  it('a reason longer than the body ends in "..."', () => {
    const long = Array.from({ length: 40 }, (_, i) => `word${String(i)}`).join(' ');
    const out = frame(refused(opened(SMALLEST), long));
    const lines = body(out);
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe('    word0 word1 word2 word3 word4 word5');
    expect(lines[4]?.endsWith('...')).toBe(true);
  });

  it('reading again: the reason stays out, the status says "Reading the logs..."', () => {
    const out = frame(act(refused(opened()), ch('r')));
    expect(body(out)).toEqual(blank(21));
    expect(status(out)).toBe(READING);
  });
});

// --- the key help ---------------------------------------------------------------------------

describe('the key help', () => {
  it.each<[number, string]>([
    [40, '1 24 h  2 7 days  Esc back  q quit'],
    [44, '1 24 h  2 7 days  Esc back  q quit'],
    [45, '1 24 h  2 7 days  3 30 days  Esc back  q quit'],
    [57, '1 24 h  2 7 days  3 30 days  s security  Esc back  q quit'],
    [69, '1 24 h  2 7 days  3 30 days  s security  w warnings  Esc back  q quit'],
    [82, '1 24 h  2 7 days  3 30 days  s security  w warnings  Esc back  q quit'],
    // 83 and 84 columns have room for the shorter of the two that are left.
    [83, '1 24 h  2 7 days  3 30 days  s security  w warnings  r read again  Esc back  q quit'],
    [84, '1 24 h  2 7 days  3 30 days  s security  w warnings  r read again  Esc back  q quit'],
    [85, 'Up/Down scroll  1 24 h  2 7 days  3 30 days  s security  w warnings  Esc back  q quit'],
    [98, 'Up/Down scroll  1 24 h  2 7 days  3 30 days  s security  w warnings  Esc back  q quit'],
    [99, HELP_ALL],
    [200, HELP_ALL],
  ])('%i columns', (cols, expected) => {
    const s = shown(REPORT, { rows: 24, cols });
    expect(help(frame(s))).toBe(expected);
    // The same while a read is under way.
    expect(help(frame(act(s, ch('r'))))).toBe(expected);
    expect(help(frame(opened({ rows: 24, cols })))).toBe(expected);
  });

  it.each<[number, string]>([
    [40, '1 24 h  r read again  Esc back  q quit'],
    [48, '1 24 h  2 7 days  r read again  Esc back  q quit'],
    [59, '1 24 h  2 7 days  3 30 days  r read again  Esc back  q quit'],
    [80, '1 24 h  2 7 days  3 30 days  s security  r read again  Esc back  q quit'],
    [83, '1 24 h  2 7 days  3 30 days  s security  w warnings  r read again  Esc back  q quit'],
    [200, '1 24 h  2 7 days  3 30 days  s security  w warnings  r read again  Esc back  q quit'],
  ])('%i columns after a failure: read again first, nothing to scroll', (cols, expected) => {
    expect(help(frame(refused(opened({ rows: 24, cols }))))).toBe(expected);
  });

  it('"Esc back" and "q quit" are the last to go', () => {
    for (const make of [() => viewOf(), () => viewOf({ mode: 'failed', failure: FAILURE })]) {
      expect(helpLine(logsHelp(make()), 16).trimEnd()).toBe('Esc back  q quit');
      expect(helpLine(logsHelp(make()), 15).trimEnd()).toBe('Esc back');
    }
  });
});

// --- too small ------------------------------------------------------------------------------

describe('a window too small', () => {
  it.each<Screen>([
    { rows: 7, cols: 80 },
    { rows: 24, cols: 39 },
    { rows: 3, cols: 20 },
  ])('$rows x $cols: only the "too small" text', (screen) => {
    for (const s of [opened(), shown(REPORT), refused(opened())]) {
      const out = renderApp(act(s, { type: 'resize', screen }));
      expect(out.lines).toHaveLength(screen.rows);
      for (const line of out.lines) expect(line).toHaveLength(screen.cols);
      const text = out.lines.join('\n');
      expect(text).toMatch(/[Tt]oo small - need/);
      expect(text).not.toContain('Logs');
      expect(text).not.toContain('09:15');
      expect(text).not.toContain(READING);
      expect(text).not.toContain('cannot be read');
      expect(out.cursorLine).toBeNull();
    }
  });
});

// --- what a log file holds is drawn safe ----------------------------------------------------

describe('whatever the lines hold, the frame is exact and plain ASCII', () => {
  it.each(SCREENS)('$rows x $cols: hostile lines', (screen) => {
    frame(stateOf({ lines: HOSTILE }, screen));
    // One line at a time: each is on screen whatever the height.
    const text = HOSTILE.flatMap((line) => body(frame(stateOf({ lines: [line] }, screen)))).join(
      '\n',
    );
    expect(text).toContain('red[31m alert');
    expect(text).toContain('reversed text');
    expect(text).toContain('zerowidth');
    expect(text).toContain('10:00:04  app           nuls');
    expect(text).toContain('dash - arrow ->');
  });

  it.each(SCREENS)('$rows x $cols: a hostile reason', (screen) => {
    const failure = `Cannot read ${cp(0x1b)}[2J${cp(0x202e)}the folder ${cp(0x2014)} ${cp(0x4e2d)}`;
    const out = frame(stateOf({ mode: 'failed', failure }, screen));
    expect(body(out)[0]).toBe('    Cannot read [2Jthe folder - ?');
  });

  it('seeded lines, windows and scroll positions', () => {
    let seed = 20261008;
    const next = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const pieces = ['a', 'Zq', '7', '-', '.', cp(0x1b), cp(0x202e), cp(0x4e2d), cp(0x1f4e7), cp(0)];
    const word = (): string =>
      Array.from({ length: 1 + next(14) }, () => pieces[next(pieces.length)] ?? '').join('');
    for (let i = 0; i < 300; i++) {
      const lines = Array.from({ length: next(60) }, () =>
        Array.from({ length: 1 + next(20) }, word).join(' '),
      );
      const screen: Screen = { rows: 8 + next(40), cols: 40 + next(170) };
      const modes: LogsView['mode'][] = ['reading', 'shown', 'failed'];
      const mode = modes[next(3)] ?? 'shown';
      const windows: LogsWindow[] = ['24h', '7d', '30d'];
      const out = frame(
        stateOf(
          {
            mode,
            lines,
            failure: mode === 'failed' ? lines.join('\n') : null,
            scroll: next(80),
            window: windows[next(3)] ?? '24h',
            securityOnly: next(2) === 0,
            warnOnly: next(2) === 0,
          },
          screen,
        ),
      );
      expect(status(out)).toBe(mode === 'reading' ? READING : '');
    }
  }, 30_000);

  it('plain lines: what is drawn is a run of the rows, ending with the newest at scroll 0', () => {
    let seed = 4;
    const next = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let i = 0; i < 200; i++) {
      const lines = Array.from({ length: next(70) }, (_, n) =>
        `10:00:00  app           ${String(n)} ${'word '.repeat(next(30))}`.trimEnd(),
      );
      const screen: Screen = { rows: 8 + next(30), cols: 40 + next(100) };
      const height = bodyHeight(screen);
      const rows = logRows(lines, screen.cols);
      const scroll = next(2) === 0 ? 0 : next(90);
      const drawn = body(frame(stateOf({ lines, scroll }, screen)));
      const last = Math.max(0, rows.length - height);
      const top = Math.max(0, last - scroll);
      expect(drawn).toEqual([
        ...rows.slice(top, top + height),
        ...blank(Math.max(0, height - rows.length)),
      ]);
      if (scroll === 0 && rows.length > 0) {
        expect(drawn[Math.min(height, rows.length) - 1]).toBe(rows.at(-1));
      }
    }
  }, 30_000);
});

// --- the pieces -----------------------------------------------------------------------------

describe('the pieces of logs-render.ts', () => {
  it('logsHeader: exactly the width, the right cell dropped when it cannot fit', () => {
    for (const cols of [20, 40, 80, 200]) {
      for (const over of [{}, { window: '30d' as const, securityOnly: true, warnOnly: true }]) {
        expect(logsHeader(viewOf(over), cols)).toHaveLength(cols);
      }
    }
    expect(logsHeader(viewOf(), 80)).toBe(header('24 h'));
    expect(logsHeader(viewOf({ window: '7d' }), 80)).toBe(header('7 days'));
    expect(logsHeader(viewOf({ window: '30d', warnOnly: true }), 80)).toBe(
      header('30 days - warnings'),
    );
    // 29 columns of filters and no room for a title: the title alone.
    expect(
      logsHeader(viewOf({ window: '30d', securityOnly: true, warnOnly: true }), 30).trimEnd(),
    ).toBe(TITLE);
  });

  it('logsBody: `height` lines of `cols` columns, no cursor', () => {
    for (const over of [
      { lines: linesOf(3) },
      { lines: linesOf(50) },
      { lines: linesOf(50), scroll: 7 },
      { lines: HOSTILE },
      { mode: 'reading' as const },
      { mode: 'failed' as const, failure: FAILURE },
      { mode: 'failed' as const },
    ]) {
      for (const [height, cols] of [
        [0, 40],
        [1, 40],
        [5, 40],
        [21, 80],
        [47, 200],
      ] as const) {
        const out = logsBody(viewOf(over), height, cols);
        expect(out.cursorLine).toBeNull();
        expect(out.lines).toHaveLength(height);
        for (const line of out.lines) {
          expect(line).toHaveLength(cols);
          expect(line).toMatch(ASCII);
        }
      }
    }
  });

  it('logsBody: one body line shows the newest row', () => {
    const out = logsBody(viewOf({ lines: linesOf(9) }), 1, 40);
    expect(out.lines.map((l) => l.trimEnd())).toEqual(['10:00:00  app           Line 9']);
  });

  it('logsBody: a negative scroll position is the bottom', () => {
    const out = logsBody(viewOf({ lines: linesOf(9), scroll: -3 }), 2, 40);
    expect(out.lines.map((l) => l.trimEnd())).toEqual(linesOf(9).slice(7));
  });

  it('logsBusy: only while a read is under way', () => {
    expect(logsBusy(viewOf({ mode: 'reading' }))).toBe(READING);
    expect(logsBusy(viewOf({ mode: 'reading', lines: linesOf(3) }))).toBe(READING);
    expect(logsBusy(viewOf({ mode: 'shown' }))).toBeNull();
    expect(logsBusy(viewOf({ mode: 'failed', failure: FAILURE }))).toBeNull();
  });

  it('logsHelp: the nine keys; after a failure the eight that still act', () => {
    const texts = (v: LogsView): string[] => logsHelp(v).map((item) => item.text);
    const keys = [
      '1 24 h',
      '2 7 days',
      '3 30 days',
      's security',
      'w warnings',
      'r read again',
      'Esc back',
      'q quit',
    ];
    expect(texts(viewOf())).toEqual(['Up/Down scroll', ...keys]);
    expect(texts(viewOf({ mode: 'reading' }))).toEqual(['Up/Down scroll', ...keys]);
    expect(texts(viewOf({ mode: 'failed', failure: FAILURE }))).toEqual(keys);
    for (const v of [viewOf(), viewOf({ mode: 'failed' })]) {
      const ranks = logsHelp(v).map((item) => item.rank);
      expect(new Set(ranks).size).toBe(ranks.length);
      for (const item of logsHelp(v)) expect(item.text).toMatch(ASCII);
    }
  });
});
