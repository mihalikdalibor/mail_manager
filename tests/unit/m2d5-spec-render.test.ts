import { describe, it, expect } from 'vitest';
import { renderApp } from '../../src/cli/app/render.js';
import { reduceApp, startApp } from '../../src/cli/app/reduce.js';
import { initialApp } from '../../src/cli/app/state.js';
import type { AppAction, AppKey, AppState, LogsView, MailboxRow } from '../../src/cli/app/state.js';
import type { Rendered } from '../../src/cli/browser/render.js';
import type { Screen } from '../../src/cli/browser/state.js';
import { displayWidth } from '../../src/cli/browser/width.js';
import type { AuthUser } from '../../src/core/auth.js';

// M2d-5 logs renderer (spec L1, L3, L6 and the Frame rule): the header with the window and the
// filters, the bottom-anchored page, wrapped lines, the failed text, the key help, exact frames
// at 40x8, 80x24 and 200x50 and sanitised outside strings. States are built through the reducer.

const SCREEN: Screen = { rows: 24, cols: 100 };
const S40: Screen = { rows: 8, cols: 40 };
const S80: Screen = { rows: 24, cols: 80 };
const S200: Screen = { rows: 50, cols: 200 };
const ALICE: AuthUser = { email: 'alice@example.com', userId: 'user-alice' };

const ch = (text: string): AppKey => ({ type: 'char', text });
const key = (type: Exclude<AppKey['type'], 'char'>): AppKey => ({ type });
const ENTER = key('enter');
const DOWN = key('down');
const UP = key('up');

function press(state: AppState, ...keys: AppKey[]): AppState {
  let s = state;
  for (const k of keys) s = reduceApp(s, { type: 'key', key: k }).state;
  return s;
}

function act(state: AppState, action: AppAction): AppState {
  return reduceApp(state, action).state;
}

function home(screen: Screen): AppState {
  const rows: MailboxRow[] = [
    { id: 'm1', email: 'one@example.com', provider: 'websupport', lastCheckedAt: null },
  ];
  const s0 = startApp(initialApp('1.0.0', screen)).state;
  const s1 = act(s0, {
    type: 'session',
    generation: s0.generation,
    user: ALICE,
    remembered: [ALICE.email],
  });
  const s2 = press(s1, ENTER);
  return act(s2, { type: 'mailboxes', generation: s2.generation, rows });
}

/** Enter on the Logs row (one mailbox: rows are mailbox, Add, Logs, Log out). */
function reading(screen: Screen = SCREEN): AppState {
  const s = press(home(screen), DOWN, DOWN, ENTER);
  // A bug in a fixture is loud: this must be the logs screen.
  if (s.view.kind !== 'logs') throw new Error(`expected the logs view, got ${s.view.kind}`);
  return s;
}

function shown(lines: readonly string[], screen: Screen = SCREEN): AppState {
  const s = reading(screen);
  const done = act(s, { type: 'logs-read', generation: s.generation, lines });
  if (done.view.kind !== 'logs' || done.view.mode !== 'shown') throw new Error('not shown');
  return done;
}

function failed(text: string, screen: Screen = SCREEN): AppState {
  const s = reading(screen);
  const done = act(s, { type: 'logs-failed', generation: s.generation, text });
  if (done.view.kind !== 'logs' || done.view.mode !== 'failed') throw new Error('not failed');
  return done;
}

function logs(s: AppState): LogsView {
  if (s.view.kind !== 'logs') throw new Error(`expected the logs view, got ${s.view.kind}`);
  return s.view;
}

const text = (r: Rendered): string => r.lines.join('\n');
const statusLine = (r: Rendered): string => r.lines[r.lines.length - 2] ?? '';
const helpLine = (r: Rendered): string => r.lines[r.lines.length - 1] ?? '';
const collapsed = (r: Rendered): string => text(r).replace(/\s+/g, ' ');

function checkFrame(r: Rendered, screen: Screen): void {
  expect(r.lines).toHaveLength(screen.rows);
  for (const line of r.lines) expect(displayWidth(line)).toBe(screen.cols);
}

function numbered(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `entry ${String(i + 1).padStart(3, '0')} here`);
}

// --- the frame is always exact --------------------------------------------------------------

describe('Frame rule: every frame has exactly rows lines of exactly cols columns', () => {
  const SCREENS: [string, Screen][] = [
    ['40x8', S40],
    ['80x24', S80],
    ['200x50', S200],
  ];
  const HOSTILE = [
    'plain line',
    'Evil\u202Eline\u0007with\u0000ctrl',
    '\u4E2D\u6587\u884C\u975E\u5E38\u957F\u7684\u540D\u5B57'.repeat(12),
    `Emoji \u{1F600}\u{1F4E7} ${'x'.repeat(300)}`,
    'zero\u200Bwidth\u00ADsoft',
    'long '.repeat(80),
  ];
  const MODES: [string, (s: Screen) => AppState][] = [
    ['reading', (s) => reading(s)],
    ['shown, nothing', (s) => shown([], s)],
    ['shown, a few lines', (s) => shown(numbered(3), s)],
    ['shown, many lines', (s) => shown(numbered(300), s)],
    ['shown, many lines, scrolled up', (s) => press(shown(numbered(300), s), UP, UP, UP)],
    ['shown, hostile lines', (s) => shown(HOSTILE, s)],
    ['shown, one very long word', (s) => shown(['w'.repeat(500)], s)],
    ['failed', (s) => failed('The log folder is broken. '.repeat(30), s)],
    ['reading with every filter', (s) => press(reading(s), ch('3'), ch('s'), ch('w'))],
  ];
  for (const [screenName, screen] of SCREENS) {
    for (const [modeName, make] of MODES) {
      it(`${modeName} at ${screenName}`, () => {
        checkFrame(renderApp(make(screen)), screen);
      });
    }
  }

  it('hostile lines leave no control, bidi or invisible character in the frame', () => {
    for (const screen of [S40, S80, S200]) {
      const out = text(renderApp(shown(HOSTILE, screen)));
      expect(out).not.toContain('\u202E');
      expect(out).not.toContain('\u200B');
      expect(out).not.toContain('\u00AD');
      expect(out.replace(/\n/g, '')).not.toMatch(/\p{Cc}/u);
    }
  });

  it('the app text (header, status, help) is plain ASCII', () => {
    for (const screen of [S40, S80, SCREEN, S200]) {
      for (const s of [
        reading(screen),
        shown(numbered(5), screen),
        failed('Something broke.', screen),
        press(reading(screen), ch('2'), ch('s'), ch('w')),
      ]) {
        for (const line of renderApp(s).lines) expect(line).toMatch(/^[\x20-\x7E]*$/);
      }
    }
  });

  it('a window below 40x8 shows only "Window too small"', () => {
    for (const screen of [
      { rows: 8, cols: 39 },
      { rows: 7, cols: 40 },
      { rows: 5, cols: 30 },
    ]) {
      const r = renderApp(act(shown(numbered(5)), { type: 'resize', screen }));
      checkFrame(r, screen);
      expect(text(r)).toMatch(/too small/i);
      expect(text(r)).not.toContain('entry');
      expect(text(r)).not.toContain('Logs');
    }
  });

  it('exactly 40x8 is big enough', () => {
    expect(text(renderApp(shown(numbered(3), S40)))).not.toMatch(/too small/i);
  });
});

// --- L1: header and status ------------------------------------------------------------------

describe('L1 the header and the status line', () => {
  it('header: Mail Manager - Logs, naming the window', () => {
    const r = renderApp(reading());
    expect(r.lines[0]).toContain('Mail Manager - Logs');
    expect(r.lines[0]).toMatch(/24 h\s*$/);
  });

  it.each([
    ['1', /24 h\s*$/],
    ['2', /7 days\s*$/],
    ['3', /30 days\s*$/],
  ])('window key %s names its window on the right', (k, expected) => {
    expect(renderApp(press(reading(), ch(k))).lines[0]).toMatch(expected);
  });

  it('the filters follow the window: " - security" and " - warnings" when on', () => {
    const base = shown(['x']);
    expect(renderApp(press(base, ch('s'))).lines[0]).toMatch(/24 h - security\s*$/);
    expect(renderApp(press(base, ch('w'))).lines[0]).toMatch(/24 h - warnings\s*$/);
    expect(renderApp(press(base, ch('2'), ch('s'), ch('w'))).lines[0]).toMatch(
      /7 days - security - warnings\s*$/,
    );
    expect(renderApp(press(base, ch('3'), ch('s'), ch('w'))).lines[0]).toMatch(
      /30 days - security - warnings\s*$/,
    );
  });

  it('a filter switched off again leaves the header', () => {
    const r = renderApp(press(shown(['x']), ch('s'), ch('s')));
    expect(r.lines[0]).not.toContain('security');
    expect(r.lines[0]).toMatch(/24 h\s*$/);
  });

  it('reading: "Reading the logs..." on the status line', () => {
    expect(statusLine(renderApp(reading()))).toContain('Reading the logs...');
  });

  it('a new read shows "Reading the logs..." again, with the old lines still there', () => {
    const r = renderApp(press(shown(['kept line']), ch('r')));
    expect(statusLine(r)).toContain('Reading the logs...');
    expect(text(r)).toContain('kept line');
  });

  it('shown: no "Reading the logs..." any more', () => {
    expect(text(renderApp(shown(['x'])))).not.toContain('Reading the logs');
  });

  it('there is no cursor line', () => {
    expect(renderApp(shown(numbered(5))).cursorLine ?? null).toBeNull();
    expect(renderApp(reading()).cursorLine ?? null).toBeNull();
  });
});

// --- L3: the page ---------------------------------------------------------------------------

describe('L3 the page is anchored at the bottom', () => {
  it('more lines than the body: the newest is on the last body line', () => {
    const lines = numbered(50);
    const r = renderApp(shown(lines));
    expect(r.lines[r.lines.length - 3]).toContain('entry 050 here');
    expect(r.lines[r.lines.length - 4]).toContain('entry 049 here');
    expect(text(r)).not.toContain('entry 001');
    // The body is exactly the newest rows: 24 rows - header - status - help.
    expect(r.lines[1]).toContain('entry 030 here');
  });

  it('fewer lines than the body: they start at the top, in order', () => {
    const r = renderApp(shown(['first line', 'second line', 'third line']));
    expect(r.lines[1]).toContain('first line');
    expect(r.lines[2]).toContain('second line');
    expect(r.lines[3]).toContain('third line');
    expect(r.lines[4]?.trim()).toBe('');
  });

  it('exactly as many lines as the body fills it', () => {
    const body = SCREEN.rows - 3;
    const r = renderApp(shown(numbered(body)));
    expect(r.lines[1]).toContain('entry 001');
    expect(r.lines[body]).toContain(`entry ${String(body).padStart(3, '0')}`);
  });

  it('scrolling up moves the window towards older lines, row by row', () => {
    const lines = numbered(50);
    const r1 = renderApp(press(shown(lines), UP));
    expect(r1.lines[r1.lines.length - 3]).toContain('entry 049 here');
    const r3 = renderApp(press(shown(lines), UP, UP, UP));
    expect(r3.lines[r3.lines.length - 3]).toContain('entry 047 here');
    expect(r3.lines[1]).toContain('entry 027 here');
  });

  it('scrolled to the oldest: the first line is on the first body line', () => {
    const lines = numbered(50);
    const s = press(shown(lines), ...Array.from({ length: 200 }, () => UP));
    const r = renderApp(s);
    expect(r.lines[1]).toContain('entry 001 here');
    expect(text(r)).not.toContain('entry 050');
  });

  it('at 40x8 the body is five rows: the newest five lines', () => {
    const r = renderApp(shown(numbered(30), S40));
    checkFrame(r, S40);
    const body = r.lines.slice(1, 6).join('\n');
    expect(body).toContain('entry 030');
    expect(body).toContain('entry 026');
    expect(body).not.toContain('entry 025');
  });

  it('a line longer than the width wraps: the first row is cut at a space, the rest indented 10', () => {
    const words = Array.from({ length: 40 }, (_, i) => `w${String(i).padStart(2, '0')}`);
    const line = words.join(' ');
    const r = renderApp(shown([line], S80));
    checkFrame(r, S80);
    const rows = r.lines.slice(1, 1 + 4).map((l) => l.trimEnd());
    expect(rows[0]).toMatch(/^w00 w01 /);
    expect(rows[0]?.length).toBeLessThanOrEqual(80);
    expect(rows[1]?.startsWith(`${' '.repeat(10)}w`)).toBe(true);
    expect(collapsed(r)).toContain(line);
  });

  it('a line of one very long word is cut at the width, nothing is lost', () => {
    const word = 'w'.repeat(150);
    const r = renderApp(shown([word], S80));
    checkFrame(r, S80);
    expect(r.lines[1]?.trimEnd()).toBe('w'.repeat(80));
    const joined = r.lines
      .slice(1, 5)
      .map((l) => l.trim())
      .join('');
    expect(joined).toBe(word);
  });

  it('a long line keeps its place at the bottom: the last row of the newest line is the last body row', () => {
    const newest = `${'tail '.repeat(60)}END`;
    const r = renderApp(shown([...numbered(40), newest], S80));
    expect(r.lines[r.lines.length - 3]).toContain('END');
  });
});

// --- L6: a log folder that can't be read ----------------------------------------------------

describe('L6 the failed screen', () => {
  const WORDS = Array.from({ length: 30 }, (_, i) => `word${String(i)}x`).join(' ');

  it('shows the text in the body, not on the status line', () => {
    const r = renderApp(failed('The log folder is a link.'));
    const i = r.lines.findIndex((l) => l.includes('The log folder is a link.'));
    expect(i).toBeGreaterThanOrEqual(1);
    expect(i).toBeLessThanOrEqual(r.lines.length - 3);
    expect(statusLine(r)).not.toContain('log folder');
    expect(statusLine(r)).not.toContain('Reading the logs');
  });

  it('wraps a long text to the width without breaking words', () => {
    for (const screen of [S80, { rows: 24, cols: 40 }, SCREEN]) {
      const r = renderApp(failed(WORDS, screen));
      checkFrame(r, screen);
      expect(collapsed(r)).toContain(WORDS);
      expect(r.lines.slice(1, -2).filter((l) => l.includes('word')).length).toBeGreaterThan(1);
    }
  });

  it('hostile characters of the text never reach the frame', () => {
    const r = renderApp(failed('Bad \u202E\u0007text\u0000 here'));
    checkFrame(r, SCREEN);
    expect(text(r)).not.toContain('\u202E');
    expect(text(r).replace(/\n/g, '')).not.toMatch(/\p{Cc}/u);
    expect(text(r)).toContain('here');
  });

  it('the header still names the window and r reads again', () => {
    const s = press(failed('x'), ch('2'));
    expect(renderApp(s).lines[0]).toMatch(/7 days\s*$/);
    expect(logs(s).mode).toBe('reading');
  });
});

// --- the key help ---------------------------------------------------------------------------

describe('the key help', () => {
  it('wide: every key of the screen is named', () => {
    const help = helpLine(renderApp(shown(numbered(3), S200)));
    for (const item of [
      'Up/Down scroll',
      '1 24 h',
      '2 7 days',
      '3 30 days',
      's security',
      'w warnings',
      'r read again',
      'Esc back',
      'q quit',
    ]) {
      expect(help).toContain(item);
    }
  });

  it('Esc back and q quit survive at 40 columns, in every mode', () => {
    for (const s of [reading(S40), shown(numbered(3), S40), failed('x', S40)]) {
      const help = helpLine(renderApp(s));
      expect(help).toContain('Esc back');
      expect(help).toContain('q quit');
    }
  });

  it('the help is one line of the frame width', () => {
    for (const screen of [S40, S80, SCREEN, S200]) {
      expect(displayWidth(helpLine(renderApp(shown(numbered(3), screen))))).toBe(screen.cols);
    }
  });
});
