import { describe, it, expect } from 'vitest';
import { initialApp } from '../../src/cli/app/state.js';
import type {
  AppAction,
  AppEffect,
  AppKey,
  AppReduced,
  AppState,
  HomeView,
  LogsView,
  MailboxRow,
} from '../../src/cli/app/state.js';
import { reduceApp, startApp } from '../../src/cli/app/reduce.js';
import { logRows, logsView, reduceLogs } from '../../src/cli/app/logs.js';
import { bodyHeight } from '../../src/cli/browser/state.js';
import type { Screen } from '../../src/cli/browser/state.js';
import type { AuthUser } from '../../src/core/auth.js';

// M2d-5 logs state (spec L1, L3, L4, L7 and the logs edge cases): the pure reducer reached the
// way a user does - Enter on Home's Logs row - then the result actions the controller would
// send. logRows (the wrap rule of L3) is tested on its own.

const SCREEN: Screen = { rows: 24, cols: 100 };
const SMALL: Screen = { rows: 5, cols: 30 };
const ALICE: AuthUser = { email: 'alice@example.com', userId: 'user-alice' };

const ch = (text: string): AppKey => ({ type: 'char', text });
const key = (type: Exclude<AppKey['type'], 'char'>): AppKey => ({ type });
const ENTER = key('enter');
const ESC = key('escape');
const LEFT = key('left');
const BACKSPACE = key('backspace');
const UP = key('up');
const DOWN = key('down');
const PGUP = key('pageup');
const PGDN = key('pagedown');

function row(id: string, email: string): MailboxRow {
  return { id, email, provider: 'websupport', lastCheckedAt: null };
}

function press(state: AppState, ...keys: AppKey[]): AppReduced {
  let current = state;
  const effects: AppEffect[] = [];
  for (const k of keys) {
    const r = reduceApp(current, { type: 'key', key: k });
    current = r.state;
    effects.push(...r.effects);
  }
  return { state: current, effects };
}

function act(state: AppState, action: AppAction): AppReduced {
  return reduceApp(state, action);
}

function types(r: AppReduced): string[] {
  return r.effects.map((e) => e.type);
}

type ReadLogs = Extract<AppEffect, { type: 'read-logs' }>;

function readLogsOf(r: AppReduced): ReadLogs {
  const effect = r.effects.find((e): e is ReadLogs => e.type === 'read-logs');
  if (effect === undefined) throw new Error('no read-logs effect');
  return effect;
}

function logs(s: AppState): LogsView {
  if (s.view.kind !== 'logs') throw new Error(`expected the logs view, got ${s.view.kind}`);
  return s.view;
}

function homeView(s: AppState): HomeView {
  if (s.view.kind !== 'home') throw new Error(`expected Home, got ${s.view.kind}`);
  return s.view;
}

// --- Home -> logs ---------------------------------------------------------------------------

/** Signed-in ALICE on Home with two mailboxes: rows are mailbox, mailbox, Add, Logs, Log out. */
function home(screen: Screen = SCREEN): AppState {
  const s0 = startApp(initialApp('1.0.0', screen)).state;
  const s1 = act(s0, {
    type: 'session',
    generation: s0.generation,
    user: ALICE,
    remembered: [ALICE.email],
  }).state;
  const s2 = press(s1, ENTER).state;
  return act(s2, {
    type: 'mailboxes',
    generation: s2.generation,
    rows: [row('m1', 'one@example.com'), row('m2', 'two@example.com')],
  }).state;
}

const AT_LOGS = [DOWN, DOWN, DOWN, ENTER];

function opening(screen: Screen = SCREEN): AppReduced {
  return press(home(screen), ...AT_LOGS);
}

/** The logs screen with `lines` shown (the read of the first generation arrived). */
function shown(lines: readonly string[], screen: Screen = SCREEN): AppState {
  const r = opening(screen);
  return act(r.state, { type: 'logs-read', generation: r.state.generation, lines }).state;
}

function numbered(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `line ${String(i + 1).padStart(3, '0')}`);
}

// --- L1: opening ----------------------------------------------------------------------------

describe('L1 Enter on the Logs row', () => {
  it('shows the logs screen in "reading": 24 h, no filters, nothing yet, at the bottom', () => {
    const r = opening();
    const v = logs(r.state);
    expect(v.mode).toBe('reading');
    expect(v.window).toBe('24h');
    expect(v.securityOnly).toBe(false);
    expect(v.warnOnly).toBe(false);
    expect(v.lines).toEqual([]);
    expect(v.failure).toBeNull();
    expect(v.scroll).toBe(0);
  });

  it('gives one read-logs effect for the last 24 h, no filters, with the new generation', () => {
    const before = home();
    const r = press(before, ...AT_LOGS);
    expect(r.effects).toEqual([
      {
        type: 'read-logs',
        generation: r.state.generation,
        window: '24h',
        securityOnly: false,
        warnOnly: false,
      },
    ]);
    expect(r.state.generation).toBe(before.generation + 1);
  });

  it('keeps Home as it was (list, cursor, mailboxes) for Esc to restore', () => {
    const before = home();
    const atLogsRow = press(before, DOWN, DOWN, DOWN).state;
    const v = logs(press(atLogsRow, ENTER).state);
    expect(v.home).toEqual(homeView(atLogsRow));
    expect(v.home.cursor).toBe(3);
  });

  it('no longer answers with a "coming in a next step" message', () => {
    const r = opening();
    expect(JSON.stringify(r.state.view)).not.toContain('coming-logs');
  });

  it('logsView(home) is the fresh view of that Home', () => {
    const h = homeView(home());
    const v = logsView(h);
    expect(v.kind).toBe('logs');
    expect(v.home).toBe(h);
    expect(v.mode).toBe('reading');
    expect(v.window).toBe('24h');
    expect(v.securityOnly).toBe(false);
    expect(v.warnOnly).toBe(false);
    expect(v.lines).toEqual([]);
    expect(v.scroll).toBe(0);
  });
});

describe('the result actions', () => {
  it('logs-read: shown, with the lines', () => {
    const r = opening();
    const lines = ['a', 'b'];
    const done = act(r.state, { type: 'logs-read', generation: r.state.generation, lines });
    expect(logs(done.state).mode).toBe('shown');
    expect(logs(done.state).lines).toEqual(lines);
    expect(logs(done.state).scroll).toBe(0);
    expect(done.effects).toEqual([]);
  });

  it('logs-failed: failed, with the text', () => {
    const r = opening();
    const done = act(r.state, {
      type: 'logs-failed',
      generation: r.state.generation,
      text: 'The log folder is broken.',
    });
    expect(logs(done.state).mode).toBe('failed');
    expect(logs(done.state).failure).toBe('The log folder is broken.');
    expect(done.effects).toEqual([]);
  });

  it('L7 a result of an older generation changes nothing', () => {
    const r = opening();
    const older = r.state.generation - 1;
    for (const action of [
      { type: 'logs-read', generation: older, lines: ['late'] },
      { type: 'logs-failed', generation: older, text: 'late' },
    ] satisfies AppAction[]) {
      const done = act(r.state, action);
      expect(done.state).toEqual(r.state);
      expect(done.effects).toEqual([]);
    }
  });

  it('L7 the result of a superseded read (a newer read was asked for) changes nothing', () => {
    const first = opening();
    const second = press(first.state, ch('2'));
    const late = act(second.state, {
      type: 'logs-read',
      generation: first.state.generation,
      lines: ['stale'],
    });
    expect(late.state).toEqual(second.state);
    const fresh = act(second.state, {
      type: 'logs-read',
      generation: readLogsOf(second).generation,
      lines: ['fresh'],
    });
    expect(logs(fresh.state).lines).toEqual(['fresh']);
  });

  it('L7 a result after Esc changes nothing: still Home', () => {
    const r = opening();
    const back = press(r.state, ESC).state;
    const late = act(back, { type: 'logs-read', generation: r.state.generation, lines: ['x'] });
    expect(late.state).toEqual(back);
    expect(late.state.view.kind).toBe('home');
    expect(late.effects).toEqual([]);
  });

  it('logs results arriving on Home (no logs view) are ignored', () => {
    const h = home();
    const r = act(h, { type: 'logs-read', generation: h.generation, lines: ['x'] });
    expect(r.state).toEqual(h);
    expect(r.effects).toEqual([]);
  });
});

// --- L4: keys -------------------------------------------------------------------------------

describe('L4 scrolling', () => {
  const MANY = numbered(100);
  const maxScroll = (lines: readonly string[], screen: Screen): number =>
    Math.max(0, logRows(lines, screen.cols).length - bodyHeight(screen));

  it('Up scrolls towards older lines one row at a time, clamped at the oldest', () => {
    let s = shown(MANY);
    s = press(s, UP).state;
    expect(logs(s).scroll).toBe(1);
    s = press(s, UP, UP).state;
    expect(logs(s).scroll).toBe(3);
    s = press(s, ...Array.from({ length: 500 }, () => UP)).state;
    expect(logs(s).scroll).toBe(maxScroll(MANY, SCREEN));
    expect(maxScroll(MANY, SCREEN)).toBe(100 - bodyHeight(SCREEN));
  });

  it('Down comes back, clamped at the newest', () => {
    let s = press(shown(MANY), DOWN).state;
    expect(logs(s).scroll).toBe(0);
    s = press(s, UP, UP, UP, DOWN).state;
    expect(logs(s).scroll).toBe(2);
    s = press(s, ...Array.from({ length: 50 }, () => DOWN)).state;
    expect(logs(s).scroll).toBe(0);
  });

  it('PgUp / PgDn move by a page and are clamped at both ends', () => {
    let s = shown(MANY);
    const one = logs(press(s, UP).state).scroll;
    s = press(s, PGUP).state;
    expect(logs(s).scroll).toBeGreaterThan(one);
    s = press(s, ...Array.from({ length: 50 }, () => PGUP)).state;
    expect(logs(s).scroll).toBe(maxScroll(MANY, SCREEN));
    s = press(s, ...Array.from({ length: 50 }, () => PGDN)).state;
    expect(logs(s).scroll).toBe(0);
  });

  it('fewer rows than the body: nothing to scroll', () => {
    const s = press(shown(numbered(5)), UP, PGUP, UP).state;
    expect(logs(s).scroll).toBe(0);
  });

  it('the limit counts wrapped rows, not lines', () => {
    const long = Array.from({ length: 30 }, (_, i) => `entry ${String(i)} ${'word '.repeat(60)}`);
    const rows = logRows(long, SCREEN.cols).length;
    expect(rows).toBeGreaterThan(long.length);
    const s = press(shown(long), ...Array.from({ length: 2000 }, () => UP)).state;
    expect(logs(s).scroll).toBe(rows - bodyHeight(SCREEN));
  });

  it('a resize to a taller window clamps the scroll at the next key', () => {
    const small = { rows: 12, cols: 100 };
    let s = press(shown(numbered(30), small), ...Array.from({ length: 100 }, () => UP)).state;
    expect(logs(s).scroll).toBe(30 - bodyHeight(small));
    s = act(s, { type: 'resize', screen: { rows: 60, cols: 100 } }).state;
    s = press(s, UP).state;
    expect(logs(s).scroll).toBe(0);
  });

  it('reduceLogs gives what reduceApp gives for the same key', () => {
    const s = shown(MANY);
    const viaApp = press(s, UP);
    const viaLogs = reduceLogs(s, { type: 'key', key: UP });
    expect(viaLogs.state).toEqual(viaApp.state);
    expect(viaLogs.effects).toEqual(viaApp.effects);
  });
});

describe('L4 the window, the filters and r read again', () => {
  it.each([
    ['1', '24h'],
    ['2', '7d'],
    ['3', '30d'],
  ] as const)('%s sets the window %s and reads again at the bottom', (k, window) => {
    const s = press(shown(numbered(100)), UP, UP, UP).state;
    expect(logs(s).scroll).toBe(3);
    const r = press(s, ch(k));
    expect(logs(r.state).window).toBe(window);
    expect(logs(r.state).mode).toBe('reading');
    expect(logs(r.state).scroll).toBe(0);
    expect(r.effects).toEqual([
      {
        type: 'read-logs',
        generation: r.state.generation,
        window,
        securityOnly: false,
        warnOnly: false,
      },
    ]);
    expect(r.state.generation).toBe(s.generation + 1);
  });

  it('the lines stay on screen until the new ones arrive', () => {
    const lines = ['old one', 'old two'];
    const r = press(shown(lines), ch('2'));
    expect(logs(r.state).lines).toEqual(lines);
    const done = act(r.state, {
      type: 'logs-read',
      generation: readLogsOf(r).generation,
      lines: ['new'],
    });
    expect(logs(done.state).lines).toEqual(['new']);
    expect(logs(done.state).mode).toBe('shown');
  });

  it('s switches "security only" on and off, each time reading again', () => {
    const on = press(shown(['x']), ch('s'));
    expect(logs(on.state).securityOnly).toBe(true);
    expect(readLogsOf(on)).toMatchObject({ securityOnly: true, warnOnly: false, window: '24h' });
    const off = press(on.state, ch('s'));
    expect(logs(off.state).securityOnly).toBe(false);
    expect(readLogsOf(off)).toMatchObject({ securityOnly: false });
  });

  it('w switches "warnings and errors only" on and off, each time reading again', () => {
    const on = press(shown(['x']), ch('w'));
    expect(logs(on.state).warnOnly).toBe(true);
    expect(readLogsOf(on)).toMatchObject({ securityOnly: false, warnOnly: true });
    const off = press(on.state, ch('w'));
    expect(logs(off.state).warnOnly).toBe(false);
    expect(readLogsOf(off)).toMatchObject({ warnOnly: false });
  });

  it('the filters combine with each other and with the window', () => {
    const r = press(shown(['x']), ch('3'), ch('s'), ch('w'));
    expect(logs(r.state)).toMatchObject({ window: '30d', securityOnly: true, warnOnly: true });
    expect(r.effects.at(-1)).toMatchObject({
      type: 'read-logs',
      window: '30d',
      securityOnly: true,
      warnOnly: true,
    });
    const again = press(r.state, ch('2'));
    expect(readLogsOf(again)).toMatchObject({ window: '7d', securityOnly: true, warnOnly: true });
  });

  it('r reads again with the same window and filters, at the bottom', () => {
    const s = press(shown(numbered(100)), ch('2'), ch('s')).state;
    const settled = act(s, {
      type: 'logs-read',
      generation: s.generation,
      lines: numbered(100),
    }).state;
    const scrolled = press(settled, UP, UP).state;
    const r = press(scrolled, ch('r'));
    expect(logs(r.state).scroll).toBe(0);
    expect(logs(r.state).mode).toBe('reading');
    expect(r.effects).toEqual([
      {
        type: 'read-logs',
        generation: r.state.generation,
        window: '7d',
        securityOnly: true,
        warnOnly: false,
      },
    ]);
  });

  it('keys also work after a failed read: r tries again', () => {
    const first = opening();
    const failed = act(first.state, {
      type: 'logs-failed',
      generation: first.state.generation,
      text: 'No.',
    }).state;
    const r = press(failed, ch('r'));
    expect(logs(r.state).mode).toBe('reading');
    expect(types(r)).toEqual(['read-logs']);
  });

  it('keys that mean nothing change nothing', () => {
    const s = shown(['x']);
    const r = press(s, ch('x'), ch('4'), ch('0'), key('other'), key('tab'), ENTER);
    expect(r.state).toEqual(s);
    expect(r.effects).toEqual([]);
  });
});

describe('L4 leaving', () => {
  it.each([
    ['Esc', ESC],
    ['Left', LEFT],
    ['Backspace', BACKSPACE],
  ])('%s goes back to Home as it was: same view, no reload', (_n, k) => {
    for (const make of [() => opening().state, () => shown(['a', 'b'])]) {
      const s = make();
      const homeBefore = logs(s).home;
      const r = press(s, k);
      expect(r.state.view).toEqual(homeBefore);
      expect(r.state.view.kind).toBe('home');
      expect(r.effects).toEqual([]);
      expect(r.state.generation).toBe(s.generation + 1);
    }
  });

  it('Home comes back with its cursor on the Logs row and the same mailboxes', () => {
    const r = press(shown(['x']), ESC);
    const v = homeView(r.state);
    expect(v.cursor).toBe(3);
    expect(v.mailboxes).toHaveLength(2);
    expect(v.loadFailed).toBe(false);
  });

  it('Esc also leaves a failed screen', () => {
    const o = opening();
    const failed = act(o.state, {
      type: 'logs-failed',
      generation: o.state.generation,
      text: 'x',
    }).state;
    expect(press(failed, ESC).state.view.kind).toBe('home');
  });

  it('q quits, in every mode', () => {
    const o = opening();
    const failed = act(o.state, {
      type: 'logs-failed',
      generation: o.state.generation,
      text: 'x',
    }).state;
    for (const s of [o.state, shown(['x']), failed]) {
      expect(press(s, ch('q')).effects).toEqual([{ type: 'quit' }]);
    }
  });

  it('opening Logs again after Esc starts clean (24 h, no filters)', () => {
    const configured = press(shown(['x']), ch('3'), ch('s'), ch('w')).state;
    const home2 = press(configured, ESC).state;
    const again = press(home2, ENTER);
    const v = logs(again.state);
    expect(v.window).toBe('24h');
    expect(v.securityOnly).toBe(false);
    expect(v.warnOnly).toBe(false);
    expect(readLogsOf(again)).toMatchObject({
      window: '24h',
      securityOnly: false,
      warnOnly: false,
    });
  });
});

describe('window too small', () => {
  function small(make: () => AppState): AppState {
    return act(make(), { type: 'resize', screen: SMALL }).state;
  }

  it('only q acts: no scrolling, no window, no filter, no read, no leaving', () => {
    const s = small(() => shown(numbered(50)));
    const r = press(
      s,
      UP,
      DOWN,
      PGUP,
      PGDN,
      ch('1'),
      ch('2'),
      ch('3'),
      ch('s'),
      ch('w'),
      ch('r'),
      ESC,
      LEFT,
      BACKSPACE,
      ENTER,
    );
    expect(r.state).toEqual(s);
    expect(r.effects).toEqual([]);
  });

  it('q quits from the too-small screen', () => {
    expect(
      press(
        small(() => shown(['x'])),
        ch('q'),
      ).effects,
    ).toEqual([{ type: 'quit' }]);
  });

  it('growing the window again brings the keys back', () => {
    const s = small(() => shown(numbered(50)));
    const big = act(s, { type: 'resize', screen: SCREEN }).state;
    expect(logs(press(big, UP).state).scroll).toBe(1);
  });
});

// --- L3: logRows ----------------------------------------------------------------------------

describe('L3 logRows: the wrap rule', () => {
  it('a line of at most cols characters is one row', () => {
    expect(logRows(['short'], 20)).toEqual(['short']);
    expect(logRows(['x'.repeat(20)], 20)).toEqual(['x'.repeat(20)]);
  });

  it('no lines, no rows; every line is at least one row, in order', () => {
    expect(logRows([], 20)).toEqual([]);
    expect(logRows(['a', 'b', 'c'], 20)).toEqual(['a', 'b', 'c']);
  });

  it('a longer line is cut at the last space that fits; the rest continues indented 10 columns', () => {
    const rows = logRows(['one two three four five six seven'], 20);
    expect(rows[0]).toBe('one two three four');
    expect(rows.length).toBeGreaterThan(1);
    for (const r of rows.slice(1)) expect(r.startsWith(' '.repeat(10))).toBe(true);
    for (const r of rows) expect(r.length).toBeLessThanOrEqual(20);
    expect(
      rows
        .slice(1)
        .map((r) => r.trim())
        .join(' '),
    ).toBe('five six seven');
  });

  it('a space exactly at the width is a place to cut', () => {
    const rows = logRows([`${'a'.repeat(20)} bbb`], 20);
    expect(rows).toEqual(['a'.repeat(20), `${' '.repeat(10)}bbb`]);
  });

  it('one space before the width: the row ends before it', () => {
    const rows = logRows([`${'a'.repeat(19)} b`], 20);
    expect(rows).toEqual(['a'.repeat(19), `${' '.repeat(10)}b`]);
  });

  it('a space before column 10 is no good: a hard cut at the width', () => {
    const rows = logRows([`ab ${'x'.repeat(40)}`], 20);
    expect(rows[0]).toBe(`ab ${'x'.repeat(17)}`);
    for (const r of rows.slice(1)) {
      expect(r.startsWith(' '.repeat(10))).toBe(true);
      expect(r.length).toBeLessThanOrEqual(20);
    }
    expect(
      rows
        .slice(1)
        .map((r) => r.trim())
        .join(''),
    ).toBe('x'.repeat(23));
  });

  it('a line of one very long word is cut at the width, nothing lost', () => {
    const word = 'w'.repeat(75);
    const rows = logRows([word], 20);
    expect(rows[0]).toBe('w'.repeat(20));
    for (const r of rows) expect(r.length).toBeLessThanOrEqual(20);
    expect(rows.map((r) => r.trim()).join('')).toBe(word);
  });

  it('every row of a wrapped line fits the width, at any width of the app', () => {
    const line = Array.from({ length: 40 }, (_, i) => `token${String(i)}`).join(' ');
    for (const cols of [40, 41, 55, 80, 100, 200]) {
      const rows = logRows([line], cols);
      for (const r of rows) expect(r.length, `${String(cols)} columns`).toBeLessThanOrEqual(cols);
      expect(rows.map((r) => r.trim()).join(' ')).toBe(line);
    }
  });

  it('the rows of the lines come one after another', () => {
    const rows = logRows(['first', `${'long '.repeat(10)}end`, 'last'], 20);
    expect(rows[0]).toBe('first');
    expect(rows.at(-1)).toBe('last');
    expect(rows.length).toBeGreaterThan(3);
  });
});
