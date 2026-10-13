import { describe, it, expect } from 'vitest';
import { logRows, logsView, reduceLogs } from '../../src/cli/app/logs.js';
import { reduceApp, startApp } from '../../src/cli/app/reduce.js';
import { initialApp } from '../../src/cli/app/state.js';
import type {
  AppAction,
  AppEffect,
  AppKey,
  AppReduced,
  AppState,
  HomeView,
  LogsView,
  LogsWindow,
  MailboxRow,
} from '../../src/cli/app/state.js';
import { bodyHeight } from '../../src/cli/browser/state.js';
import type { Screen } from '../../src/cli/browser/state.js';
import type { AuthUser } from '../../src/core/auth.js';

// M2d-5 logs screen, state: Enter on Home's "Logs", what a read reports, every key of the
// screen, the generation that drops the answer to an earlier read, the way back to Home as it
// was - through reduceApp - and the wrap rule of logRows on its own. Every step proves that the
// state it was given is untouched. Addresses are placeholders.

// --- fixtures -------------------------------------------------------------------------------

const ANNA: AuthUser = { email: 'anna@example-test-domain.eu', userId: 'user-anna' };
const SCREEN: Screen = { rows: 24, cols: 80 }; // 21 body lines
const SMALLEST: Screen = { rows: 8, cols: 40 }; // 5 body lines
const TOO_SMALL: Screen = { rows: 7, cols: 80 };
const MAILBOXES: MailboxRow[] = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'box@example-test-domain.eu',
    provider: 'websupport',
    lastCheckedAt: null,
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    email: 'second@example-test-domain.eu',
    provider: 'custom',
    lastCheckedAt: null,
  },
];

/** `n` lines as `mm logs` prints them, oldest first; each fits 40 columns. */
function linesOf(n: number): string[] {
  return Array.from(
    { length: n },
    (_, i) => `09:${String(i % 60).padStart(2, '0')}:00  app           Line ${String(i + 1)}`,
  );
}

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

const BACK_KEYS: [string, AppAction][] = [
  ['Esc', key('escape')],
  ['Left', key('left')],
  ['Backspace', key('backspace')],
];

/** One step, proving the state it was given wasn't changed. */
function step(state: AppState, action: AppAction): AppReduced {
  const before = structuredClone(state);
  const out = reduceApp(state, action);
  expect(state).toEqual(before);
  return out;
}

/** The actions in order: the last state and every effect on the way. */
function run(state: AppState, ...actions: AppAction[]): AppReduced {
  let s = state;
  const effects: AppEffect[] = [];
  for (const a of actions) {
    const out = step(s, a);
    s = out.state;
    effects.push(...out.effects);
  }
  return { state: s, effects };
}

function act(state: AppState, ...actions: AppAction[]): AppState {
  return run(state, ...actions).state;
}

function view(state: AppState): LogsView {
  if (state.view.kind !== 'logs') throw new Error(`not on the logs: ${state.view.kind}`);
  return state.view;
}

function home(state: AppState): HomeView {
  if (state.view.kind !== 'home') throw new Error(`not on Home: ${state.view.kind}`);
  return state.view;
}

interface Options {
  screen?: Screen;
  mailboxes?: MailboxRow[];
}

/** Home of ANNA, its list still loading. */
function loadingHome(o: Options = {}): AppState {
  const s0 = startApp(initialApp('1.2.3', o.screen ?? SCREEN)).state;
  return act(
    s0,
    { type: 'session', generation: s0.generation, user: ANNA, remembered: [ANNA.email] },
    key('enter'),
  );
}

/** Home of ANNA with her mailboxes, the cursor on "Logs". */
function atHome(o: Options = {}): AppState {
  const rows = o.mailboxes ?? MAILBOXES;
  const s = loadingHome(o);
  return act(
    s,
    { type: 'mailboxes', generation: s.generation, rows },
    ...repeat(key('down'), rows.length + 1),
  );
}

/** The logs screen as Enter opens it: the first read is under way. */
function opened(o: Options = {}): AppState {
  return act(atHome(o), key('enter'));
}

function arrived(state: AppState, lines: readonly string[]): AppAction {
  return { type: 'logs-read', generation: state.generation, lines };
}

function refused(state: AppState, text = "Can't read the log folder."): AppAction {
  return { type: 'logs-failed', generation: state.generation, text };
}

/** The logs screen showing `lines`. */
function shown(lines: readonly string[], o: Options = {}): AppState {
  const s = opened(o);
  return act(s, arrived(s, lines));
}

function failed(o: Options = {}): AppState {
  const s = opened(o);
  return act(s, refused(s));
}

type ReadLogs = Extract<AppEffect, { type: 'read-logs' }>;

function readEffect(
  generation: number,
  over: Partial<Pick<ReadLogs, 'window' | 'securityOnly' | 'warnOnly'>> = {},
): AppEffect {
  return {
    type: 'read-logs',
    generation,
    window: '24h',
    securityOnly: false,
    warnOnly: false,
    ...over,
  };
}

/** The logs screen in each of its modes, with 30 lines where it has lines. */
const MODES: [LogsView['mode'], () => AppState][] = [
  ['reading', () => opened()],
  ['shown', () => shown(linesOf(30))],
  ['failed', () => failed()],
];

// --- opening --------------------------------------------------------------------------------

describe('Enter on "Logs" (L1)', () => {
  it('logsView: the last 24 hours, no filter, nothing read yet', () => {
    const kept = home(atHome());
    expect(logsView(kept)).toEqual({
      kind: 'logs',
      home: kept,
      mode: 'reading',
      window: '24h',
      securityOnly: false,
      warnOnly: false,
      lines: [],
      failure: null,
      scroll: 0,
    });
    expect(logsView(kept).home).toBe(kept);
  });

  it('shows the logs screen and asks for one read, as a new request', () => {
    const s = atHome();
    expect(home(s).cursor).toBe(3);
    const out = step(s, key('enter'));
    expect(out.state).toEqual({
      ...s,
      generation: s.generation + 1,
      view: logsView(home(s)),
    });
    expect(out.effects).toEqual([readEffect(s.generation + 1)]);
  });

  it('with no mailboxes "Logs" is the second row', () => {
    const s = atHome({ mailboxes: [] });
    expect(home(s).cursor).toBe(1);
    const out = step(s, key('enter'));
    expect(view(out.state)).toEqual(logsView(home(s)));
    expect(out.effects).toEqual([readEffect(s.generation + 1)]);
  });

  it('"Added ..." on Home is not kept for the way back', () => {
    const s = atHome();
    const said: AppState = { ...s, view: { ...home(s), added: 'new@example-test-domain.eu' } };
    expect(view(act(said, key('enter'))).home).toEqual(home(s));
  });

  it('a list that could not be loaded stays that way on the kept Home', () => {
    const s0 = loadingHome();
    const s = act(s0, { type: 'mailboxes-failed', generation: s0.generation }, key('down'));
    expect(home(s)).toMatchObject({ mailboxes: null, loadFailed: true, message: 'load-failed' });
    const out = step(s, key('enter'));
    expect(view(out.state).home).toEqual(home(s));
    expect(out.effects).toEqual([readEffect(s.generation + 1)]);
  });

  it('too small: Enter does nothing', () => {
    const s = act(atHome(), { type: 'resize', screen: TOO_SMALL });
    expect(step(s, key('enter'))).toEqual({ state: s, effects: [] });
  });
});

// --- what a read reports --------------------------------------------------------------------

describe('what the read reports', () => {
  it('logs-read: the lines are shown, from the bottom', () => {
    const s = opened();
    const lines = linesOf(30);
    const out = step(s, arrived(s, lines));
    expect(out.effects).toEqual([]);
    expect(out.state).toEqual({
      ...s,
      view: { ...view(s), mode: 'shown', lines, scroll: 0 },
    });
  });

  it('logs-read with no line at all is a page too', () => {
    const s = opened();
    expect(view(act(s, arrived(s, [])))).toMatchObject({ mode: 'shown', lines: [] });
  });

  it('logs-failed: why the folder cannot be read, and no lines', () => {
    const s = opened();
    const out = step(s, refused(s, 'The log folder is a file.'));
    expect(out.effects).toEqual([]);
    expect(out.state).toEqual({
      ...s,
      view: { ...view(s), mode: 'failed', failure: 'The log folder is a file.' },
    });
  });

  it('logs-failed after lines were shown: the lines go, the reason is shown', () => {
    const s = act(shown(linesOf(30)), key('up'), ch('r'));
    expect(view(s)).toMatchObject({ mode: 'reading', lines: linesOf(30) });
    expect(view(act(s, refused(s)))).toEqual({
      ...view(s),
      mode: 'failed',
      lines: [],
      failure: "Can't read the log folder.",
      scroll: 0,
    });
  });

  it('the answer starts at the bottom, wherever the lines on screen were scrolled to', () => {
    const s = act(shown(linesOf(30)), ch('r'), key('pageup'));
    expect(view(s)).toMatchObject({ mode: 'reading', scroll: 9 });
    expect(view(act(s, arrived(s, linesOf(40))))).toEqual({
      ...view(s),
      mode: 'shown',
      lines: linesOf(40),
      scroll: 0,
    });
    expect(view(act(s, refused(s)))).toEqual({
      ...view(s),
      mode: 'failed',
      lines: [],
      failure: "Can't read the log folder.",
      scroll: 0,
    });
  });

  it('logs-read after a failure: the reason goes, the lines are shown', () => {
    const s = act(failed(), ch('r'));
    expect(view(act(s, arrived(s, linesOf(3))))).toEqual({
      ...view(s),
      mode: 'shown',
      lines: linesOf(3),
      failure: null,
      scroll: 0,
    });
  });

  it.each([
    ['shown', () => shown(linesOf(30))],
    ['failed', () => failed()],
  ] as const)('a second answer to the same request changes nothing (%s)', (_mode, make) => {
    const s = make();
    expect(step(s, arrived(s, ['another'])).state).toBe(s);
    expect(step(s, refused(s, 'another')).state).toBe(s);
  });

  it('a result still arrives while the window is too small', () => {
    const s = act(opened(), { type: 'resize', screen: TOO_SMALL });
    expect(view(act(s, arrived(s, linesOf(3))))).toMatchObject({
      mode: 'shown',
      lines: linesOf(3),
    });
  });
});

// --- superseded reads (L7) ------------------------------------------------------------------

describe('a result nobody waits for changes nothing (L7)', () => {
  it('the answer to an earlier read is dropped; the answer to the last one counts', () => {
    const first = opened();
    const second = act(first, ch('2'));
    expect(second.generation).toBe(first.generation + 1);
    const late = step(second, arrived(first, ['old']));
    expect(late).toEqual({ state: second, effects: [] });
    expect(late.state).toBe(second);
    expect(step(second, refused(first)).state).toBe(second);
    const done = act(second, arrived(second, ['new']));
    expect(view(done)).toMatchObject({ mode: 'shown', window: '7d', lines: ['new'] });
  });

  it('three reads asked for in a row: only the third is waited for', () => {
    const s0 = opened();
    const s1 = act(s0, ch('3'));
    const s2 = act(s1, ch('s'));
    for (const earlier of [s0, s1]) {
      expect(step(s2, arrived(earlier, ['old'])).state).toBe(s2);
      expect(step(s2, refused(earlier)).state).toBe(s2);
    }
    expect(view(act(s2, arrived(s2, ['new']))).lines).toEqual(['new']);
  });

  it.each(BACK_KEYS)('after %s the answer is dropped: Home stays as it is', (_name, back) => {
    const s = opened();
    const left = act(s, back);
    expect(left.view.kind).toBe('home');
    expect(step(left, arrived(s, ['late']))).toEqual({ state: left, effects: [] });
    expect(step(left, arrived(s, ['late'])).state).toBe(left);
    expect(step(left, refused(s)).state).toBe(left);
  });

  it('left and opened again: the first read is not the one waited for', () => {
    const first = opened();
    const again = act(first, key('escape'), key('enter'));
    expect(again.generation).toBe(first.generation + 2);
    expect(step(again, arrived(first, ['old'])).state).toBe(again);
    expect(view(act(again, arrived(again, ['new']))).lines).toEqual(['new']);
  });

  it('Home has no use for a logs result, whatever its generation', () => {
    const left = act(opened(), key('escape'));
    expect(step(left, arrived(left, ['forged'])).state).toBe(left);
    expect(step(left, refused(left)).state).toBe(left);
  });

  it('reduceLogs leaves a state that shows another view alone', () => {
    const s = atHome();
    for (const action of [key('up'), ch('2'), key('escape'), arrived(s, ['x']), refused(s)]) {
      expect(reduceLogs(s, action)).toEqual({ state: s, effects: [] });
    }
  });

  it('an action of another screen changes nothing on the logs', () => {
    const s = shown(linesOf(3));
    const others: AppAction[] = [
      { type: 'mailboxes', generation: s.generation, rows: [] },
      { type: 'mailboxes-failed', generation: s.generation },
      { type: 'signed-out', generation: s.generation, remembered: [] },
    ];
    for (const action of others) expect(step(s, action).state).toBe(s);
  });
});

// --- scrolling (L4) -------------------------------------------------------------------------

describe('scrolling (L4)', () => {
  it('30 lines on 21 body lines: 9 rows to scroll', () => {
    expect(bodyHeight(SCREEN)).toBe(21);
    const s = shown(linesOf(30));
    expect(view(s).scroll).toBe(0);
    const one = step(s, key('up'));
    expect(one).toEqual({ state: { ...s, view: { ...view(s), scroll: 1 } }, effects: [] });
    expect(view(act(s, ...repeat(key('up'), 8))).scroll).toBe(8);
    expect(view(act(s, ...repeat(key('up'), 9))).scroll).toBe(9);
    expect(view(act(s, ...repeat(key('up'), 40))).scroll).toBe(9);
  });

  it('Down goes back towards the newest line and stops there', () => {
    const top = act(shown(linesOf(30)), ...repeat(key('up'), 9));
    expect(view(act(top, key('down'))).scroll).toBe(8);
    expect(view(act(top, ...repeat(key('down'), 9))).scroll).toBe(0);
    expect(view(act(top, ...repeat(key('down'), 40))).scroll).toBe(0);
  });

  it('PgUp and PgDn move by one body', () => {
    const s = shown(linesOf(100)); // 79 rows to scroll
    expect(view(act(s, key('pageup'))).scroll).toBe(21);
    expect(view(act(s, key('pageup'), key('pageup'))).scroll).toBe(42);
    expect(view(act(s, ...repeat(key('pageup'), 4))).scroll).toBe(79);
    expect(view(act(s, ...repeat(key('pageup'), 9))).scroll).toBe(79);
    const top = act(s, ...repeat(key('pageup'), 4));
    expect(view(act(top, key('pagedown'))).scroll).toBe(58);
    expect(view(act(top, ...repeat(key('pagedown'), 4))).scroll).toBe(0);
    expect(view(act(top, ...repeat(key('pagedown'), 9))).scroll).toBe(0);
  });

  it('a key at either end changes nothing', () => {
    const s = shown(linesOf(30));
    expect(step(s, key('down')).state).toBe(s);
    expect(step(s, key('pagedown')).state).toBe(s);
    const top = act(s, key('pageup'));
    expect(view(top).scroll).toBe(9);
    expect(step(top, key('up')).state).toBe(top);
    expect(step(top, key('pageup')).state).toBe(top);
  });

  it.each([0, 1, 20, 21])('%i lines fit the body: nothing scrolls', (n) => {
    const s = shown(linesOf(n));
    for (const k of [key('up'), key('down'), key('pageup'), key('pagedown')]) {
      expect(step(s, k)).toEqual({ state: s, effects: [] });
      expect(step(s, k).state).toBe(s);
    }
  });

  it('one line more than the body: one row to scroll', () => {
    const s = shown(linesOf(22));
    expect(view(act(s, key('pageup'))).scroll).toBe(1);
    expect(view(act(s, key('up'), key('up'))).scroll).toBe(1);
  });

  it('the rows count, not the lines: a wrapped line takes more than one', () => {
    const long = `09:00:00  app           ${'word '.repeat(20).trim()}`; // 123 columns: 2 rows of 80
    const lines = Array.from({ length: 15 }, () => long);
    expect(logRows(lines, SCREEN.cols)).toHaveLength(30);
    const s = shown(lines);
    expect(view(act(s, ...repeat(key('up'), 40))).scroll).toBe(9);
  });

  it('a smaller window has more to scroll', () => {
    expect(bodyHeight(SMALLEST)).toBe(5);
    const s = shown(linesOf(30), { screen: SMALLEST });
    expect(view(act(s, key('pageup'))).scroll).toBe(5);
    expect(view(act(s, ...repeat(key('pageup'), 9))).scroll).toBe(25);
  });

  it('after a resize the next key brings the page back inside', () => {
    const small = act(shown(linesOf(30), { screen: SMALLEST }), ...repeat(key('pageup'), 9));
    expect(view(small).scroll).toBe(25);
    const large = act(small, { type: 'resize', screen: SCREEN });
    // The screen follows; the view is as it was.
    expect(large).toEqual({ ...small, screen: SCREEN });
    expect(view(act(large, key('up'))).scroll).toBe(9);
    expect(view(act(large, key('down'))).scroll).toBe(9);
    expect(view(act(large, key('pagedown'))).scroll).toBe(4);
  });

  it('while a new read is under way the lines on screen still scroll', () => {
    const s = act(shown(linesOf(30)), ch('r'));
    expect(view(s)).toMatchObject({ mode: 'reading', lines: linesOf(30), scroll: 0 });
    const out = step(s, key('pageup'));
    expect(out.effects).toEqual([]);
    expect(out.state).toEqual({ ...s, view: { ...view(s), scroll: 9 } });
  });

  it('a failure has nothing to scroll', () => {
    const s = failed();
    for (const k of [key('up'), key('down'), key('pageup'), key('pagedown')]) {
      expect(step(s, k).state).toBe(s);
    }
  });
});

// --- reading again (L4) ---------------------------------------------------------------------

describe('the keys that read again (L4)', () => {
  const WINDOWS: [string, LogsWindow][] = [
    ['1', '24h'],
    ['2', '7d'],
    ['3', '30d'],
  ];

  it.each(WINDOWS)('%s: the window %s, read from the bottom', (text, window) => {
    const s = act(shown(linesOf(30)), ...repeat(key('up'), 4));
    expect(view(s).scroll).toBe(4);
    const out = step(s, ch(text));
    expect(out.state).toEqual({
      ...s,
      generation: s.generation + 1,
      // The lines stay on screen until the new ones arrive.
      view: { ...view(s), mode: 'reading', window, scroll: 0 },
    });
    expect(out.effects).toEqual([readEffect(s.generation + 1, { window })]);
  });

  it('s: security events only, and back', () => {
    const s = shown(linesOf(30));
    const on = step(s, ch('s'));
    expect(on.state).toEqual({
      ...s,
      generation: s.generation + 1,
      view: { ...view(s), mode: 'reading', securityOnly: true },
    });
    expect(on.effects).toEqual([readEffect(s.generation + 1, { securityOnly: true })]);
    const off = step(on.state, ch('s'));
    expect(view(off.state)).toMatchObject({ mode: 'reading', securityOnly: false });
    expect(off.effects).toEqual([readEffect(s.generation + 2)]);
  });

  it('w: warnings and errors only, and back', () => {
    const s = shown(linesOf(30));
    const on = step(s, ch('w'));
    expect(on.state).toEqual({
      ...s,
      generation: s.generation + 1,
      view: { ...view(s), mode: 'reading', warnOnly: true },
    });
    expect(on.effects).toEqual([readEffect(s.generation + 1, { warnOnly: true })]);
    const off = step(on.state, ch('w'));
    expect(view(off.state)).toMatchObject({ mode: 'reading', warnOnly: false });
    expect(off.effects).toEqual([readEffect(s.generation + 2)]);
  });

  it('the window and both filters combine, in any order', () => {
    const s = shown(linesOf(3));
    const g = s.generation;
    const out = run(s, ch('3'), ch('w'), ch('s'));
    expect(view(out.state)).toMatchObject({
      mode: 'reading',
      window: '30d',
      securityOnly: true,
      warnOnly: true,
    });
    expect(out.effects).toEqual([
      readEffect(g + 1, { window: '30d' }),
      readEffect(g + 2, { window: '30d', warnOnly: true }),
      readEffect(g + 3, { window: '30d', warnOnly: true, securityOnly: true }),
    ]);
    const other = run(s, ch('s'), ch('w'), ch('2'));
    expect(other.effects.at(-1)).toEqual(
      readEffect(g + 3, { window: '7d', warnOnly: true, securityOnly: true }),
    );
    // One filter off again: the other and the window stay.
    const less = run(other.state, ch('s'));
    expect(less.effects).toEqual([readEffect(g + 4, { window: '7d', warnOnly: true })]);
  });

  it('r: the same request once more', () => {
    const s = act(shown(linesOf(30)), ch('2'), ch('w'));
    const read = act(s, arrived(s, linesOf(30)), ...repeat(key('up'), 3));
    const out = step(read, ch('r'));
    expect(out.state).toEqual({
      ...read,
      generation: read.generation + 1,
      view: { ...view(read), mode: 'reading', scroll: 0 },
    });
    expect(out.effects).toEqual([
      readEffect(read.generation + 1, { window: '7d', warnOnly: true }),
    ]);
  });

  it.each(['S', 'W', 'R'])('%s works in upper case too', (text) => {
    const s = shown(linesOf(3));
    const out = step(s, ch(text));
    expect(out.effects).toEqual(step(s, ch(text.toLowerCase())).effects);
    expect(out.effects).toHaveLength(1);
    expect(view(out.state).mode).toBe('reading');
  });

  it.each(['1', '2', '3', 's', 'w', 'r'])('%s after a failure: one more read', (text) => {
    const s = failed();
    const out = step(s, ch(text));
    expect(view(out.state)).toMatchObject({ mode: 'reading', failure: null, lines: [] });
    expect(out.state.generation).toBe(s.generation + 1);
    expect(out.effects).toHaveLength(1);
    expect(out.effects[0]).toMatchObject({ type: 'read-logs', generation: s.generation + 1 });
  });

  it.each(['1', '2', '3', 's', 'w', 'r'])('%s while a read is under way: a new request', (text) => {
    const s = opened();
    const out = step(s, ch(text));
    expect(view(out.state).mode).toBe('reading');
    expect(out.state.generation).toBe(s.generation + 1);
    expect(out.effects).toHaveLength(1);
    expect(out.effects[0]).toMatchObject({ type: 'read-logs', generation: s.generation + 1 });
  });
});

// --- leaving (L4) ---------------------------------------------------------------------------

describe('back to Home and quit (L4)', () => {
  describe.each(MODES)('mode %s', (_mode, make) => {
    it.each(BACK_KEYS)('%s: Home as it was, nothing loaded again', (_name, back) => {
      const s = make();
      const out = step(s, back);
      expect(out.effects).toEqual([]);
      expect(out.state).toEqual({ ...s, generation: s.generation + 1, view: view(s).home });
      expect(out.state.view).toBe(view(s).home);
      expect(home(out.state)).toMatchObject({
        mode: 'list',
        mailboxes: MAILBOXES,
        cursor: 3,
        message: null,
      });
    });

    it.each(['q', 'Q'])('%s quits', (text) => {
      const s = make();
      expect(step(s, ch(text))).toEqual({ state: s, effects: [{ type: 'quit' }] });
    });

    it('keys that mean nothing here change nothing', () => {
      const s = make();
      const keys = [
        key('enter'),
        key('tab'),
        key('clear'),
        key('other'),
        ch('x'),
        ch('o'),
        ch('0'),
        ch('4'),
        ch(' '),
        ch('12'),
      ];
      for (const k of keys) {
        expect(step(s, k)).toEqual({ state: s, effects: [] });
        expect(step(s, k).state).toBe(s);
      }
    });

    it('too small: only q acts', () => {
      const s = act(make(), { type: 'resize', screen: TOO_SMALL });
      const keys = [
        ...BACK_KEYS.map(([, back]) => back),
        key('up'),
        key('down'),
        key('pageup'),
        key('pagedown'),
        key('enter'),
        ch('1'),
        ch('2'),
        ch('3'),
        ch('s'),
        ch('w'),
        ch('r'),
      ];
      for (const k of keys) expect(step(s, k).state).toBe(s);
      for (const k of keys) expect(step(s, k).effects).toEqual([]);
      expect(step(s, ch('q'))).toEqual({ state: s, effects: [{ type: 'quit' }] });
    });
  });

  describe('opened while the mailbox list was still loading', () => {
    /** Home still loading, the cursor on "Logs", and the logs screen opened from there. */
    function behindTheList(): { loading: AppState; logs: AppState } {
      const loading = act(loadingHome(), key('down'));
      expect(home(loading)).toMatchObject({ mailboxes: null, loadFailed: false, cursor: 1 });
      return { loading, logs: act(loading, key('enter')) };
    }

    it('the list that arrives meanwhile is dropped: it answers an older request', () => {
      const { loading, logs } = behindTheList();
      const answers: AppAction[] = [
        { type: 'mailboxes', generation: loading.generation, rows: MAILBOXES },
        { type: 'mailboxes-failed', generation: loading.generation },
        { type: 'session-ended', generation: loading.generation, remembered: [] },
      ];
      for (const answer of answers) expect(step(logs, answer).state).toBe(logs);
    });

    it.each(BACK_KEYS)('%s: Home as it was, and the list is asked for again', (_name, back) => {
      const { loading, logs } = behindTheList();
      const s = act(logs, arrived(logs, linesOf(3)));
      const out = step(s, back);
      expect(out.state).toEqual({ ...s, generation: s.generation + 1, view: home(loading) });
      expect(out.effects).toEqual([{ type: 'load-mailboxes', generation: s.generation + 1 }]);
      // The new request is the one Home waits for.
      const listed = act(out.state, {
        type: 'mailboxes',
        generation: out.state.generation,
        rows: MAILBOXES,
      });
      expect(home(listed)).toMatchObject({ mailboxes: MAILBOXES, loadFailed: false });
      expect(
        step(out.state, { type: 'mailboxes', generation: loading.generation, rows: [] }).state,
      ).toBe(out.state);
    });

    it('the same while the logs are still being read, and after a folder problem', () => {
      const { logs } = behindTheList();
      for (const s of [logs, act(logs, refused(logs)), act(logs, ch('2'))]) {
        expect(step(s, key('escape')).effects).toEqual([
          { type: 'load-mailboxes', generation: s.generation + 1 },
        ]);
      }
    });

    it('too small: Esc does nothing, so nothing is asked for', () => {
      const { logs } = behindTheList();
      const s = act(logs, { type: 'resize', screen: TOO_SMALL });
      expect(step(s, key('escape'))).toEqual({ state: s, effects: [] });
    });
  });

  it('a list that could not be loaded comes back as it was: Home has its own key for that', () => {
    const s0 = loadingHome();
    const failedHome = act(
      s0,
      { type: 'mailboxes-failed', generation: s0.generation },
      key('down'),
    );
    const s = act(failedHome, key('enter'));
    const out = step(s, key('escape'));
    expect(out.effects).toEqual([]);
    expect(out.state).toEqual({ ...s, generation: s.generation + 1, view: home(failedHome) });
    expect(home(out.state)).toMatchObject({ loadFailed: true, message: 'load-failed' });
    // r on Home is the one more try.
    expect(step(out.state, ch('r')).effects).toEqual([
      { type: 'load-mailboxes', generation: out.state.generation + 1 },
    ]);
  });

  it('an empty list is a list: nothing is asked for again', () => {
    const s = shown(linesOf(3), { mailboxes: [] });
    expect(view(s).home.mailboxes).toEqual([]);
    expect(step(s, key('escape')).effects).toEqual([]);
  });

  it('the cursor and the list of Home survive the visit, wherever the page was', () => {
    const before = atHome();
    const s = act(before, key('enter'));
    const back = act(
      s,
      arrived(s, linesOf(100)),
      key('pageup'),
      ch('3'),
      ch('s'),
      key('up'),
      key('escape'),
    );
    expect(back.view).toEqual(before.view);
    // Three requests were made on the way, and leaving is one more step.
    expect(back).toEqual({ ...before, generation: before.generation + 4 });
  });

  it('opened again, the logs start afresh: 24 hours, no filter', () => {
    const s = act(shown(linesOf(30)), ch('3'), ch('s'), ch('w'), key('escape'), key('enter'));
    expect(view(s)).toEqual(logsView(view(s).home));
  });
});

// --- the wrap rule (L3) ---------------------------------------------------------------------

describe('logRows (L3)', () => {
  const INDENT = ' '.repeat(10);

  it('lines that fit are rows as they are', () => {
    expect(logRows([], 80)).toEqual([]);
    expect(logRows(['abc', '', 'def'], 80)).toEqual(['abc', '', 'def']);
    expect(logRows(linesOf(30), 40)).toEqual(linesOf(30));
  });

  it('a line of exactly the width is one row; one more character makes two', () => {
    expect(logRows(['x'.repeat(80)], 80)).toEqual(['x'.repeat(80)]);
    expect(logRows(['x'.repeat(81)], 80)).toEqual(['x'.repeat(80), `${INDENT}x`]);
  });

  it('a longer line is cut at the last space that fits and goes on indented 10 columns', () => {
    const line = '09:15:02  app           Signed in to Mail Manager as the user of this computer';
    expect(line.indexOf('Mail')).toBe(37);
    expect(logRows([line], 40)).toEqual([
      '09:15:02  app           Signed in to',
      `${INDENT}Mail Manager as the user of`,
      `${INDENT}this computer`,
    ]);
    // Wide enough: one row.
    expect(logRows([line], line.length)).toEqual([line]);
  });

  it('a space right after the last column is the place to cut', () => {
    // Spaces at 10 and 20.
    expect(logRows(['0123456789 123456789 tail'], 20)).toEqual([
      '0123456789 123456789',
      `${INDENT}tail`,
    ]);
  });

  it('a space one column further is too far: the one before it is used', () => {
    // Spaces at 10 and 21.
    expect(logRows(['0123456789 1234567890 tail'], 20)).toEqual([
      '0123456789',
      `${INDENT}1234567890`,
      `${INDENT}tail`,
    ]);
  });

  it('the first row loses the spaces at its end', () => {
    const line = `${'a'.repeat(12)}      ${'b'.repeat(20)}`;
    expect(logRows([line], 20)).toEqual([
      'a'.repeat(12),
      `${INDENT}${'b'.repeat(10)}`,
      `${INDENT}${'b'.repeat(10)}`,
    ]);
  });

  it('the only space that fits is before column 10: cut at the width instead', () => {
    const line = `09:15:02  ${'x'.repeat(50)}`;
    expect(logRows([line], 40)).toEqual([
      `09:15:02  ${'x'.repeat(30)}`,
      `${INDENT}${'x'.repeat(20)}`,
    ]);
  });

  it('column 10 is where a space starts to count', () => {
    const tens = [`${INDENT}${'x'.repeat(10)}`, `${INDENT}${'x'.repeat(10)}`];
    // The space at index 9: too early.
    expect(logRows([`012345678 ${'x'.repeat(30)}`], 20)).toEqual(['012345678 xxxxxxxxxx', ...tens]);
    // The space at index 10: used.
    expect(logRows([`0123456789 ${'x'.repeat(30)}`], 20)).toEqual([
      '0123456789',
      ...tens,
      `${INDENT}${'x'.repeat(10)}`,
    ]);
  });

  it('one very long word is cut at the width, then at the width less the indent', () => {
    expect(logRows(['w'.repeat(95)], 40)).toEqual([
      'w'.repeat(40),
      `${INDENT}${'w'.repeat(30)}`,
      `${INDENT}${'w'.repeat(25)}`,
    ]);
  });

  it('the rest wraps at spaces, and a word longer than a row is split', () => {
    const line = `09:15:02  app           start ${'y'.repeat(45)} end of it`;
    expect(logRows([line], 40)).toEqual([
      '09:15:02  app           start',
      `${INDENT}${'y'.repeat(30)}`,
      `${INDENT}${'y'.repeat(15)} end of it`,
    ]);
  });

  it('every line is wrapped on its own, in order', () => {
    const long = `09:15:02  app           ${'word '.repeat(8).trim()}`;
    expect(logRows(['first', long, 'last'], 40)).toEqual([
      'first',
      '09:15:02  app           word word word',
      `${INDENT}word word word word word`,
      'last',
    ]);
  });

  it('a line that only has spaces past the width is one row', () => {
    expect(logRows([`${'a'.repeat(15)}${' '.repeat(30)}`], 20)).toEqual(['a'.repeat(15)]);
  });

  it('narrower than the indent: the rows still fit', () => {
    for (let cols = 1; cols <= 10; cols++) {
      const rows = logRows(['09:15:02  app           Signed in to Mail Manager'], cols);
      expect(rows.length).toBeGreaterThan(1);
      for (const row of rows) expect(row.length).toBeLessThanOrEqual(cols);
      expect(rows.join('').replaceAll(' ', '')).toBe('09:15:02appSignedintoMailManager');
    }
  });

  it('seeded lines at every width: no row too long, nothing lost, the rest indented', () => {
    let seed = 20261008;
    const next = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let i = 0; i < 400; i++) {
      const words = Array.from({ length: 1 + next(25) }, () =>
        'abcdefghij'.charAt(next(10)).repeat(1 + next(next(8) === 0 ? 60 : 12)),
      );
      const line = words.map((word) => `${word}${' '.repeat(1 + next(3))}`).join('');
      const cols = 11 + next(110);
      const rows = logRows([line], cols);
      for (const row of rows)
        expect(row.length, `${String(cols)}: ${line}`).toBeLessThanOrEqual(cols);
      expect(rows.join('').replaceAll(' ', ''), `${String(cols)}: ${line}`).toBe(
        line.replaceAll(' ', ''),
      );
      const first = rows[0] ?? '';
      expect(line.startsWith(first), `${String(cols)}: ${line}`).toBe(true);
      for (const row of rows.slice(1)) {
        expect(row.startsWith(INDENT), `${String(cols)}: ${line}`).toBe(true);
        expect(row.charAt(10), `${String(cols)}: ${line}`).not.toBe(' ');
      }
      if (line.length <= cols) expect(rows).toEqual([line]);
    }
  });
});
