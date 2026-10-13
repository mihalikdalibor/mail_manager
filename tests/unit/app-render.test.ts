import { describe, it, expect } from 'vitest';
import { reduceApp, startApp } from '../../src/cli/app/reduce.js';
import { messageText, renderApp } from '../../src/cli/app/render.js';
import type { AppRenderOptions } from '../../src/cli/app/render.js';
import { initialApp } from '../../src/cli/app/state.js';
import type {
  AppAction,
  AppKey,
  AppMessage,
  AppState,
  MailboxRow,
} from '../../src/cli/app/state.js';
import { centred } from '../../src/cli/browser/layout.js';
import type { Rendered } from '../../src/cli/browser/render.js';
import type { Screen } from '../../src/cli/browser/state.js';
import { displayWidth } from '../../src/cli/browser/width.js';
import type { AuthUser } from '../../src/core/auth.js';

// M2d-1 app screens: the pure renderApp() over states built with initialApp + the reducers
// (a few are put together by hand to show what no key can reach). Addresses are placeholders;
// hostile and invisible characters are written as escapes.

// --- helpers --------------------------------------------------------------------------------

const ANNA: AuthUser = { email: 'anna@example-test-domain.eu', userId: 'user-anna' };
const BEN = 'ben@example-test-domain.eu';
const CYRIL = 'cyril@example-test-domain.eu';
const SCREEN: Screen = { rows: 24, cols: 100 };
const SMALLEST: Screen = { rows: 8, cols: 40 };
const ASCII = /^[\x20-\x7e]*$/;
const LONG = 'Window too small - need at least 40x8';
const SHORT = 'Too small - need 40x8';
const PASSWORD_LINE = '    Password:  (nothing is shown while you type)';
/** Shares no three characters in a row with anything the app draws. */
const CANARY = 'Zx9#Qw7$Lk2!vJ5^';

// Sixteen columns like the default YYYY-MM-DD HH:MM, but independent of the local time zone.
const FMT: AppRenderOptions = {
  formatChecked: (d) => (d === null ? 'never' : d.toISOString().slice(0, 16).replace('T', ' ')),
};

const MAILBOXES: readonly MailboxRow[] = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'anna@example-test-domain.eu',
    provider: 'websupport',
    lastCheckedAt: new Date(Date.UTC(2026, 9, 3, 18, 22)),
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    email: 'office@example-test-domain.eu',
    provider: 'something-unknown',
    lastCheckedAt: null,
  },
];

function act(state: AppState, ...actions: AppAction[]): AppState {
  let s = state;
  for (const a of actions) s = reduceApp(s, a).state;
  return s;
}

function key(type: Exclude<AppKey['type'], 'char'>): AppAction {
  return { type: 'key', key: { type } };
}

function ch(text: string): AppAction {
  return { type: 'key', key: { type: 'char', text } };
}

function typeText(state: AppState, text: string): AppState {
  return act(state, ...[...text].map(ch));
}

function repeat(action: AppAction, n: number): AppAction[] {
  return Array.from({ length: n }, () => action);
}

function resized(state: AppState, screen: Screen): AppState {
  return act(state, { type: 'resize', screen });
}

function started(screen: Screen = SCREEN): AppState {
  return startApp(initialApp('1.2.3', screen)).state;
}

function checked(
  user: AuthUser | null,
  remembered: readonly string[],
  screen: Screen = SCREEN,
): AppState {
  const s = started(screen);
  return act(s, { type: 'session', generation: s.generation, user, remembered });
}

function checkFailed(remembered: readonly string[], screen: Screen = SCREEN): AppState {
  const s = started(screen);
  return act(s, { type: 'session-failed', generation: s.generation, remembered });
}

/** The empty form, opened from the last row with nobody signed in. */
function emptyForm(screen: Screen = SCREEN): AppState {
  return act(checked(null, [BEN], screen), key('down'), key('enter'));
}

function passwordField(email: string, screen: Screen = SCREEN): AppState {
  return act(typeText(emptyForm(screen), email), key('enter'));
}

function atHome(rows?: readonly MailboxRow[], screen: Screen = SCREEN): AppState {
  const opened = act(checked(ANNA, [ANNA.email, BEN], screen), key('enter'));
  return rows === undefined
    ? opened
    : act(opened, { type: 'mailboxes', generation: opened.generation, rows });
}

function homeFailed(screen: Screen = SCREEN): AppState {
  const loading = atHome(undefined, screen);
  return act(loading, { type: 'mailboxes-failed', generation: loading.generation });
}

function boxes(n: number): MailboxRow[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `id-${String(i)}`,
    email: `box${String(i)}@example-test-domain.eu`,
    provider: 'azet',
    lastCheckedAt: null,
  }));
}

/** One state per mode of both pages, at `screen`. */
function everyMode(screen: Screen): [string, AppState][] {
  const list = checked(ANNA, [ANNA.email, BEN, CYRIL], screen);
  const submitted = act(typeText(passwordField(BEN, screen), 'pw'), key('enter'));
  return [
    ['checking', started(screen)],
    ['check failed', checkFailed([BEN], screen)],
    ['list', list],
    ['list with a message', act(list, ch('f'))],
    ['list, nobody known', act(checked(null, [], screen), key('escape'))],
    ['form, e-mail field', typeText(emptyForm(screen), 'ab')],
    ['form, password field', passwordField(BEN, screen)],
    ['form with a message', act(passwordField(BEN, screen), key('enter'))],
    ['form, fixed e-mail', act(checked(null, [BEN], screen), key('enter'))],
    ['signing in', submitted],
    ['switch question', act(list, key('down'), key('enter'))],
    ['signing out to switch', act(list, key('down'), key('enter'), ch('y'))],
    ['forget question', act(list, key('down'), ch('f'))],
    ['Home, loading', atHome(undefined, screen)],
    ['Home, mailboxes', atHome(MAILBOXES, screen)],
    ['Home, a hint', act(atHome(MAILBOXES, screen), key('enter'))],
    ['Home, no mailboxes', atHome([], screen)],
    ['Home, load failed', homeFailed(screen)],
    ['Home, signing out', act(atHome([], screen), key('down'), key('down'), key('enter'))],
  ];
}

function controlChars(line: string): string[] {
  return [...line].filter((c) => {
    const cp = c.codePointAt(0) ?? 0;
    return cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f);
  });
}

/** Exactly `rows` lines of exactly `cols` columns, nothing a terminal would act on. */
function checkFrame(out: Rendered, screen: Screen): void {
  expect(out.lines).toHaveLength(screen.rows);
  for (const line of out.lines) {
    expect(displayWidth(line)).toBe(screen.cols);
    expect(controlChars(line)).toEqual([]);
    expect(line).not.toMatch(/[\u00AD\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/u);
  }
}

function lineAt(out: Rendered, index: number): string {
  const line = out.lines[index];
  if (line === undefined) throw new Error(`no line ${String(index)}`);
  return line;
}

function body(out: Rendered): string[] {
  return out.lines.slice(1, -2);
}

function status(out: Rendered): string {
  return lineAt(out, out.lines.length - 2).trimEnd();
}

function help(out: Rendered): string {
  return lineAt(out, out.lines.length - 1).trimEnd();
}

function shown(lines: readonly string[]): string[] {
  return lines.map((l) => l.trimEnd()).filter((l) => l !== '');
}

// --- the frame ------------------------------------------------------------------------------

describe('every frame (AC22, AC23)', () => {
  const SIZES: Screen[] = [
    { rows: 8, cols: 40 },
    { rows: 9, cols: 41 },
    { rows: 24, cols: 80 },
    { rows: 50, cols: 132 },
    { rows: 8, cols: 250 },
    { rows: 60, cols: 40 },
  ];

  it.each(SIZES)('%o: rows lines of cols columns, plain ASCII, in every mode', (screen) => {
    for (const [name, state] of everyMode(screen)) {
      const out = renderApp(state, FMT);
      checkFrame(out, screen);
      for (const line of out.lines) expect(line, name).toMatch(ASCII);
      if (out.cursorLine !== null) {
        expect(out.cursorLine, name).toBeGreaterThanOrEqual(1);
        expect(out.cursorLine, name).toBeLessThanOrEqual(screen.rows - 3);
      }
    }
  });

  it('a resize draws the same page at the new size', () => {
    const wide = renderApp(atHome(MAILBOXES, { rows: 30, cols: 120 }), FMT);
    const narrowed = renderApp(resized(atHome(MAILBOXES, { rows: 30, cols: 120 }), SMALLEST), FMT);
    checkFrame(narrowed, SMALLEST);
    expect(narrowed).toEqual(renderApp(atHome(MAILBOXES, SMALLEST), FMT));
    expect(narrowed.lines).not.toEqual(wide.lines);
  });

  it('the default options draw the same frame, but for the time of the last check', () => {
    const state = atHome([], SCREEN);
    expect(renderApp(state)).toEqual(renderApp(state, FMT));
    expect(renderApp(checked(ANNA, [BEN]))).toEqual(renderApp(checked(ANNA, [BEN]), {}));
  });
});

describe('window too small (AC22)', () => {
  const TOO_SMALL: Screen[] = [
    { rows: 8, cols: 39 },
    { rows: 7, cols: 40 },
    { rows: 5, cols: 30 },
    { rows: 1, cols: 21 },
    { rows: 3, cols: 10 },
    { rows: 2, cols: 1 },
  ];
  const QUESTIONS = new Set(['switch question', 'forget question']);

  it.each(TOO_SMALL)('%o: only the too-small text, in every mode', (screen) => {
    for (const [name, state] of everyMode(SCREEN)) {
      const out = renderApp(resized(state, screen), FMT);
      checkFrame(out, screen);
      expect(out.cursorLine, name).toBeNull();
      for (const line of out.lines) expect(line, name).toMatch(ASCII);
      if (!QUESTIONS.has(name)) expect(shown(out.lines).length, name).toBeLessThanOrEqual(1);
      // Nothing of the page behind it.
      expect(out.lines.join('\n'), name).not.toContain('Mail Manager');
      expect(out.lines.join('\n'), name).not.toContain('Password');
    }
  });

  it('the long text from 37 columns, the short one below', () => {
    const state = atHome(MAILBOXES);
    expect(shown(renderApp(resized(state, { rows: 7, cols: 80 })).lines)).toEqual([
      centred(LONG, 80).trimEnd(),
    ]);
    expect(shown(renderApp(resized(state, { rows: 8, cols: 37 })).lines)).toEqual([LONG]);
    expect(shown(renderApp(resized(state, { rows: 8, cols: 36 })).lines)).toEqual([
      centred(SHORT, 36).trimEnd(),
    ]);
  });

  it('the switch question is shown below the text', () => {
    const asked = act(checked(ANNA, [BEN]), key('down'), key('enter'));
    const out = renderApp(resized(asked, { rows: 5, cols: 60 }));
    expect(lineAt(out, 2)).toBe(centred(LONG, 60));
    expect(lineAt(out, 3)).toBe(centred(`Sign out ${ANNA.email} first? (y/N)`, 60));
    expect(shown(out.lines)).toHaveLength(2);
  });

  it('the forget question is shown below the text', () => {
    const asked = act(checked(null, [BEN, CYRIL]), key('down'), ch('f'));
    const out = renderApp(resized(asked, { rows: 6, cols: 60 }));
    expect(lineAt(out, 2)).toBe(centred(LONG, 60));
    expect(lineAt(out, 3)).toBe(centred(`Forget ${CYRIL}? (y/N)`, 60));
  });

  it('one row: the question takes the place of the text', () => {
    const asked = act(checked(null, [BEN]), ch('f'));
    expect(renderApp(resized(asked, { rows: 1, cols: 60 })).lines).toEqual([
      centred(`Forget ${BEN}? (y/N)`, 60),
    ]);
  });

  it('no question while something is only loading or waiting', () => {
    const signingOut = act(checked(ANNA, [BEN]), key('down'), key('enter'), ch('y'));
    for (const state of [started(), signingOut, atHome(), homeFailed()]) {
      expect(shown(renderApp(resized(state, { rows: 5, cols: 60 })).lines)).toEqual([
        centred(LONG, 60).trimEnd(),
      ]);
    }
  });

  it('back above 40x8 the page is drawn again', () => {
    const state = atHome(MAILBOXES);
    const back = resized(resized(state, { rows: 3, cols: 20 }), SCREEN);
    expect(renderApp(back, FMT)).toEqual(renderApp(state, FMT));
  });
});

// --- sign-in page ---------------------------------------------------------------------------

describe('sign-in: checking and the list (AC6, AC15)', () => {
  it('while checking: header, an empty body, the status and how to leave', () => {
    const out = renderApp(started());
    expect(lineAt(out, 0).startsWith('Mail Manager 1.2.3 ')).toBe(true);
    expect(lineAt(out, 0).endsWith(' Sign in')).toBe(true);
    expect(shown(body(out))).toEqual([]);
    expect(status(out)).toBe('Checking your sign-in...');
    expect(help(out)).toBe('Ctrl+C quit');
    expect(out.cursorLine).toBeNull();
  });

  it('the signed-in user first, then the remembered, then "Sign in as another user"', () => {
    const out = renderApp(checked(ANNA, [BEN, ANNA.email, CYRIL], { rows: 12, cols: 60 }));
    expect(lineAt(out, 1)).toBe(`    ${ANNA.email}${' '.repeat(18)}signed in  `);
    expect(shown(body(out)).slice(1)).toEqual([
      `    ${BEN}`,
      `    ${CYRIL}`,
      '    Sign in as another user',
    ]);
    expect(out.cursorLine).toBe(1);
    expect(status(out)).toBe('');
    expect(help(out)).toBe('Up/Down move  Enter choose  f forget  q quit');
  });

  it('nobody signed in: no row is tagged', () => {
    const out = renderApp(checked(null, [BEN, CYRIL]));
    expect(shown(body(out))).toEqual([`    ${BEN}`, `    ${CYRIL}`, '    Sign in as another user']);
    expect(out.lines.join('\n')).not.toContain('signed in');
  });

  it('nobody known: the single row "Sign in"', () => {
    const out = renderApp(act(checked(null, []), key('escape')));
    expect(shown(body(out))).toEqual(['    Sign in']);
    expect(out.cursorLine).toBe(1);
  });

  it('the cursor line follows the cursor', () => {
    let state = checked(ANNA, [BEN, CYRIL]);
    for (const line of [1, 2, 3, 4, 4]) {
      expect(renderApp(state).cursorLine).toBe(line);
      state = act(state, key('down'));
    }
  });

  it('more rows than body lines: the window follows the cursor', () => {
    const many = Array.from({ length: 10 }, (_, i) => `user${String(i)}@example-test-domain.eu`);
    let state = checked(null, many, SMALLEST);
    // Five body lines at 8 rows.
    expect(shown(body(renderApp(state)))).toEqual(many.slice(0, 5).map((e) => `    ${e}`));
    state = act(state, ...repeat(key('down'), 4));
    expect(renderApp(state).cursorLine).toBe(5);
    expect(shown(body(renderApp(state)))).toEqual(many.slice(0, 5).map((e) => `    ${e}`));
    state = act(state, key('down'));
    expect(renderApp(state).cursorLine).toBe(5);
    expect(shown(body(renderApp(state)))).toEqual(many.slice(1, 6).map((e) => `    ${e}`));
    state = act(state, ...repeat(key('down'), 5));
    expect(renderApp(state).cursorLine).toBe(5);
    expect(shown(body(renderApp(state)))).toEqual([
      ...many.slice(6).map((e) => `    ${e}`),
      '    Sign in as another user',
    ]);
    state = act(state, ...repeat(key('up'), 10));
    expect(renderApp(state).cursorLine).toBe(1);
  });

  it('a long address is cut with "..." and keeps its tag', () => {
    const user = { email: `${'long.name.'.repeat(8)}@example-test-domain.eu`, userId: 'u' };
    const out = renderApp(checked(user, [], SMALLEST));
    checkFrame(out, SMALLEST);
    expect(lineAt(out, 1)).toBe('    long.name.long.name.l... signed in  ');
  });

  it('Mail Manager unreachable: the list without a cursor, its message, r and q', () => {
    const out = renderApp(checkFailed([BEN]));
    expect(shown(body(out))).toEqual([`    ${BEN}`, '    Sign in as another user']);
    expect(out.cursorLine).toBeNull();
    expect(status(out)).toBe(
      "Can't reach Mail Manager - check your internet connection and try again.",
    );
    expect(help(out)).toBe('r try again  q quit');
  });

  it('a message goes on the status line', () => {
    const out = renderApp(act(checked(ANNA, [BEN]), ch('f')));
    expect(status(out)).toBe('Log out first to forget this address.');
    expect(out.cursorLine).toBe(1);
  });
});

describe('sign-in: questions (AC13, AC14)', () => {
  it('switching user asks on the status line; the chosen row stays highlighted', () => {
    const out = renderApp(act(checked(ANNA, [BEN]), key('down'), key('enter')));
    expect(status(out)).toBe(`Sign out ${ANNA.email} first? (y/N)`);
    expect(help(out)).toBe('y yes  any other key no');
    expect(out.cursorLine).toBe(2);
    expect(shown(body(out))).toHaveLength(3);
  });

  it('"Signing out..." while that session is ended: no cursor', () => {
    const out = renderApp(act(checked(ANNA, [BEN]), key('down'), key('enter'), ch('y')));
    expect(status(out)).toBe('Signing out...');
    expect(help(out)).toBe('Ctrl+C quit');
    expect(out.cursorLine).toBeNull();
    expect(shown(body(out))).toHaveLength(3);
  });

  it('forgetting asks with the address of the row', () => {
    const out = renderApp(act(checked(null, [BEN, CYRIL]), key('down'), ch('f')));
    expect(status(out)).toBe(`Forget ${CYRIL}? (y/N)`);
    expect(help(out)).toBe('y yes  any other key no');
    expect(out.cursorLine).toBe(2);
  });

  it('a signed-in user without an e-mail is named (no e-mail)', () => {
    const nameless = { email: '', userId: 'user-none' };
    const list = renderApp(checked(nameless, [BEN], { rows: 10, cols: 50 }));
    expect(lineAt(list, 1)).toBe(`    (no e-mail)${' '.repeat(24)}signed in  `);
    const asked = renderApp(act(checked(nameless, [BEN]), key('down'), key('enter')));
    expect(status(asked)).toBe('Sign out (no e-mail) first? (y/N)');
  });
});

describe('sign-in: the form (AC9, AC10)', () => {
  it('the e-mail field while typed into: a mark at its end, the cursor on its line', () => {
    const out = renderApp(typeText(emptyForm(), 'ab'));
    expect(shown(body(out))).toEqual(['    E-mail:    ab_', PASSWORD_LINE]);
    expect(out.cursorLine).toBe(1);
    expect(help(out)).toBe('Enter next  Tab switch field  Esc back  Ctrl+C quit');
    expect(shown(body(renderApp(emptyForm())))).toEqual(['    E-mail:    _', PASSWORD_LINE]);
  });

  it('the password field active: no mark on the e-mail, the cursor on the password line', () => {
    const out = renderApp(passwordField(BEN));
    expect(shown(body(out))).toEqual([`    E-mail:    ${BEN}`, PASSWORD_LINE]);
    expect(out.cursorLine).toBe(2);
    expect(help(out)).toBe('Enter sign in  Tab switch field  Esc back  Ctrl+C quit');
  });

  it('a remembered address: shown fixed, the password line active', () => {
    const out = renderApp(act(checked(null, [BEN]), key('enter')));
    expect(shown(body(out))).toEqual([`    E-mail:    ${BEN}`, PASSWORD_LINE]);
    expect(out.cursorLine).toBe(2);
  });

  it('a fixed e-mail leaves one field: the help names no key to switch', () => {
    const fixed = act(checked(null, [BEN]), key('enter'));
    expect(help(renderApp(fixed))).toBe('Enter sign in  Esc back  Ctrl+C quit');
    expect(renderApp(fixed).lines.join('\n')).not.toContain('Tab');
    // The same form after a failed try.
    const sent = act(typeText(fixed, 'pw'), key('enter'));
    const failed = act(sent, {
      type: 'sign-in-failed',
      generation: sent.generation,
      reason: 'invalid-credentials',
    });
    expect(help(renderApp(failed))).toBe('Enter sign in  Esc back  Ctrl+C quit');
    // With an e-mail to type, the key is named on both fields.
    expect(help(renderApp(emptyForm()))).toBe(
      'Enter next  Tab switch field  Esc back  Ctrl+C quit',
    );
    expect(help(renderApp(passwordField(BEN)))).toBe(
      'Enter sign in  Tab switch field  Esc back  Ctrl+C quit',
    );
  });

  it('"Signing in...": the form without a cursor', () => {
    const out = renderApp(act(typeText(passwordField(BEN), 'pw'), key('enter')));
    expect(shown(body(out))).toEqual([`    E-mail:    ${BEN}`, PASSWORD_LINE]);
    expect(out.cursorLine).toBeNull();
    expect(status(out)).toBe('Signing in...');
    expect(help(out)).toBe('Ctrl+C quit');
  });

  it.each([
    ['invalid-credentials', 'Wrong e-mail or password - try again.'],
    ['unreachable', "Can't reach Mail Manager - check your internet connection and try again."],
    ['unknown', "Signing in didn't work - try again later."],
  ] as const)('a failed sign-in (%s) says so; the e-mail is still there', (reason, text) => {
    const sent = act(typeText(passwordField(BEN), 'pw'), key('enter'));
    const out = renderApp(
      act(sent, { type: 'sign-in-failed', generation: sent.generation, reason }),
    );
    expect(status(out)).toBe(text);
    expect(shown(body(out))).toEqual([`    E-mail:    ${BEN}`, PASSWORD_LINE]);
    expect(out.cursorLine).toBe(2);
  });

  it('what is missing is asked for on the status line', () => {
    expect(status(renderApp(act(emptyForm(), key('enter'))))).toBe(
      'Type your e-mail address first.',
    );
    expect(status(renderApp(act(passwordField(BEN), key('enter'))))).toBe('Type your password.');
  });

  it('a very long e-mail keeps its end visible', () => {
    const screen = { rows: 10, cols: 50 };
    const typedIn = typeText(emptyForm(screen), `${'long-local-part.'.repeat(6)}tail`);
    const out = renderApp(typedIn);
    checkFrame(out, screen);
    // 15 columns of label, 34 of field, one free column at the edge.
    expect(lineAt(out, 1)).toBe('    E-mail:    ...ocal-part.long-local-part.tail_ ');
    // With the password field active the mark is gone and one more character shows.
    expect(lineAt(renderApp(act(typedIn, key('enter'))), 1)).toBe(
      '    E-mail:    ...local-part.long-local-part.tail ',
    );
  });

  it('at 40 columns the password line is cut, never wrapped', () => {
    const out = renderApp(passwordField(BEN, SMALLEST));
    checkFrame(out, SMALLEST);
    expect(lineAt(out, 2)).toBe('    Password:  (nothing is shown whil...');
    expect(help(out)).toBe('Enter sign in  Esc back  Ctrl+C quit');
  });
});

describe('the password is never drawn (AC10)', () => {
  it('no frame changes while it is typed, whatever its length', () => {
    const empty = passwordField(BEN);
    const before = renderApp(empty);
    // The canary shares nothing with the text on screen, so finding a part of it means a leak.
    for (let i = 0; i + 3 <= CANARY.length; i++) {
      expect(before.lines.join('\n')).not.toContain(CANARY.slice(i, i + 3));
    }
    let state = empty;
    for (const c of CANARY) {
      state = act(state, ch(c));
      const out = renderApp(state);
      expect(out).toEqual(before);
      for (let i = 0; i + 3 <= CANARY.length; i++) {
        expect(out.lines.join('\n')).not.toContain(CANARY.slice(i, i + 3));
      }
    }
    expect(renderApp(typeText(empty, 'x'.repeat(1024)))).toEqual(before);
    expect(renderApp(typeText(empty, '日本語😀'))).toEqual(before);
  });

  it('nor after Backspace, Ctrl+U, a field switch or at another size', () => {
    const typedIn = typeText(passwordField(BEN), CANARY);
    for (const state of [
      act(typedIn, key('backspace')),
      act(typedIn, key('clear')),
      act(typedIn, key('tab')),
      act(typedIn, key('tab'), key('tab')),
      resized(typedIn, SMALLEST),
      resized(typedIn, { rows: 4, cols: 30 }),
      resized(typedIn, { rows: 40, cols: 200 }),
    ]) {
      const out = renderApp(state).lines.join('\n');
      for (let i = 0; i + 3 <= CANARY.length; i++)
        expect(out).not.toContain(CANARY.slice(i, i + 3));
    }
  });

  it('the password line is the same in every state of the form', () => {
    const states = [
      emptyForm(),
      passwordField(BEN),
      typeText(passwordField(BEN), CANARY),
      act(typeText(passwordField(BEN), CANARY), key('enter')),
    ];
    for (const state of states) expect(lineAt(renderApp(state), 2).trimEnd()).toBe(PASSWORD_LINE);
  });
});

// --- Home -----------------------------------------------------------------------------------

describe('Home (AC16)', () => {
  it('while loading: the user in the header, "Loading your mailboxes...", the three actions', () => {
    const out = renderApp(atHome());
    expect(lineAt(out, 0).trimEnd()).toBe(`Mail Manager - ${ANNA.email}`);
    expect(shown(body(out))).toEqual([
      '    Loading your mailboxes...',
      '    + Add a mailbox',
      '    Logs',
      '    Log out',
    ]);
    // The loading line is no row: the cursor is on the first action.
    expect(out.cursorLine).toBe(2);
    expect(status(out)).toBe('');
    expect(help(out)).toBe('Up/Down move  Enter open  Esc back  q quit');
  });

  it('the mailboxes: e-mail, provider and last check, then the three actions', () => {
    const screen = { rows: 12, cols: 80 };
    const out = renderApp(atHome(MAILBOXES, screen), FMT);
    checkFrame(out, screen);
    expect(lineAt(out, 0)).toBe(`Mail Manager - ${ANNA.email}${' '.repeat(27)}2 mailboxes`);
    expect(lineAt(out, 1)).toBe(
      `    ${ANNA.email}${' '.repeat(11)}Websupport  checked 2026-10-03 18:22  `,
    );
    // An unknown provider id is "Custom"; a shorter "checked" text is padded, so the columns line up.
    expect(lineAt(out, 2)).toBe(
      `    office@example-test-domain.eu${' '.repeat(9)}Custom      checked never${' '.repeat(13)}`,
    );
    expect(out.lines.slice(3, 6).map((l) => l.trimEnd())).toEqual([
      '    + Add a mailbox',
      '    Logs',
      '    Log out',
    ]);
    expect(out.cursorLine).toBe(1);
  });

  it('counts one mailbox in the singular', () => {
    const out = renderApp(atHome(MAILBOXES.slice(0, 1)), FMT);
    expect(lineAt(out, 0).trimEnd().endsWith(' 1 mailbox')).toBe(true);
  });

  it('by default the last check is the local date and time, or "never"', () => {
    const out = renderApp(atHome(MAILBOXES, { rows: 12, cols: 100 }));
    expect(lineAt(out, 1)).toMatch(/ Websupport {2}checked \d{4}-\d{2}-\d{2} \d{2}:\d{2} {2}$/);
    expect(lineAt(out, 2)).toMatch(/ Custom {6}checked never {13}$/);
  });

  it('no mailboxes: "No mailboxes yet", the cursor on "+ Add a mailbox"', () => {
    const out = renderApp(atHome([]));
    expect(lineAt(out, 0).trimEnd().endsWith(' 0 mailboxes')).toBe(true);
    expect(shown(body(out))).toEqual([
      '    No mailboxes yet - add your first one.',
      '    + Add a mailbox',
      '    Logs',
      '    Log out',
    ]);
    expect(out.cursorLine).toBe(2);
    expect(lineAt(out, 2).trimEnd()).toBe('    + Add a mailbox');
  });

  it('the cursor line follows the cursor, below an info line too', () => {
    let state = atHome(MAILBOXES);
    for (const line of [1, 2, 3, 4, 5, 5]) {
      expect(renderApp(state, FMT).cursorLine).toBe(line);
      state = act(state, key('down'));
    }
    let loading = atHome();
    for (const line of [2, 3, 4, 4]) {
      expect(renderApp(loading).cursorLine).toBe(line);
      loading = act(loading, key('down'));
    }
  });

  it('more rows than body lines: the window follows the cursor', () => {
    let state = atHome(boxes(30), SMALLEST);
    const row = (i: number): string => `    box${String(i)}@example-test-domain.eu`;
    expect(shown(body(renderApp(state, FMT)))).toEqual(
      [0, 1, 2, 3, 4].map((i) => `${row(i)}   Azet`),
    );
    state = act(state, ...repeat(key('down'), 29));
    let out = renderApp(state, FMT);
    expect(out.cursorLine).toBe(5);
    expect(lineAt(out, 5).startsWith(row(29))).toBe(true);
    expect(lineAt(out, 1).startsWith(row(25))).toBe(true);
    state = act(state, ...repeat(key('down'), 3));
    out = renderApp(state, FMT);
    expect(out.cursorLine).toBe(5);
    expect(shown(body(out)).slice(2)).toEqual(['    + Add a mailbox', '    Logs', '    Log out']);
    expect(lineAt(out, 1).startsWith(row(28))).toBe(true);
  });

  it('at 40x8 nothing is lost below an info line', () => {
    const out = renderApp(act(atHome([], SMALLEST), key('down'), key('down')));
    checkFrame(out, SMALLEST);
    expect(shown(body(out))).toEqual([
      '    No mailboxes yet - add your first...',
      '    + Add a mailbox',
      '    Logs',
      '    Log out',
    ]);
    expect(out.cursorLine).toBe(4);
  });

  it('the hints of the rows that come later (AC17)', () => {
    let state = atHome(MAILBOXES);
    const hints = ['Connecting...', 'Connecting...', '', 'Reading the logs...'];
    for (const hint of hints) {
      expect(status(renderApp(act(state, key('enter')), FMT))).toBe(hint);
      state = act(state, key('down'));
    }
  });

  it('"Signing out...": no cursor (AC18)', () => {
    const out = renderApp(act(atHome([]), key('down'), key('down'), key('enter')));
    expect(status(out)).toBe('Signing out...');
    expect(help(out)).toBe('Ctrl+C quit');
    expect(out.cursorLine).toBeNull();
    expect(shown(body(out))).toHaveLength(4);
  });

  it('the list could not be loaded: its message, r in the help, no "Loading" (AC19)', () => {
    const out = renderApp(homeFailed());
    expect(lineAt(out, 0).trimEnd()).toBe(`Mail Manager - ${ANNA.email}`);
    expect(shown(body(out))).toEqual(['    + Add a mailbox', '    Logs', '    Log out']);
    expect(out.cursorLine).toBe(1);
    expect(status(out)).toBe(
      "Couldn't load your mailboxes - check your internet connection (r = try again).",
    );
    expect(help(out)).toBe('Up/Down move  r try again  Enter open  Esc back  q quit');
    const again = renderApp(act(homeFailed(), ch('r')));
    expect(lineAt(again, 1).trimEnd()).toBe('    Loading your mailboxes...');
    expect(status(again)).toBe('');
  });

  it('a sign-in that ended: the sign-in list with its message', () => {
    const loading = atHome();
    const out = renderApp(
      act(loading, {
        type: 'session-ended',
        generation: loading.generation,
        remembered: [ANNA.email, BEN],
      }),
    );
    expect(status(out)).toBe('Your sign-in has ended - sign in again.');
    expect(lineAt(out, 0).endsWith(' Sign in')).toBe(true);
    expect(out.lines.join('\n')).not.toContain('signed in');
    expect(out.cursorLine).toBe(1);
  });

  it('a user without an e-mail is named (no e-mail) in the header', () => {
    const nameless = { email: '', userId: 'user-none' };
    const out = renderApp(act(checked(nameless, []), key('enter')));
    expect(lineAt(out, 0).trimEnd()).toBe('Mail Manager - (no e-mail)');
  });
});

describe('Home: the right cell gives way to the e-mail (AC16)', () => {
  // Widest e-mail 29 columns, so 4 + 24 columns are kept for it; the provider cell takes 12
  // columns ("Websupport" + 2), with the last check 38.
  const rows = (cols: number): string[] =>
    renderApp(atHome(MAILBOXES, { rows: 8, cols }), FMT).lines.slice(1, 3);

  it('from 67 columns: provider and last check', () => {
    for (const cols of [67, 80, 120]) {
      const [first, second] = rows(cols);
      expect(first).toContain('Websupport  checked 2026-10-03 18:22  ');
      expect(second).toContain('Custom      checked never');
      expect(first?.indexOf('Websupport')).toBe(second?.indexOf('Custom'));
      expect(first?.indexOf('checked')).toBe(second?.indexOf('checked'));
    }
  });

  it('from 41 to 66 columns: the provider only, on every row', () => {
    for (const cols of [41, 50, 66]) {
      const [first, second] = rows(cols);
      expect(first?.endsWith(' Websupport  ')).toBe(true);
      expect(second?.endsWith(' Custom      ')).toBe(true);
      expect(`${first ?? ''}${second ?? ''}`).not.toContain('checked');
    }
  });

  it('at 40 columns: the e-mail alone', () => {
    const [first, second] = rows(40);
    expect(first?.trimEnd()).toBe(`    ${ANNA.email}`);
    expect(second?.trimEnd()).toBe('    office@example-test-domain.eu');
  });

  it('a short provider name still fits at 40x8, the last check does not', () => {
    const mailbox: MailboxRow = {
      id: 'id-1',
      email: 'exactly24@example-xy.eu',
      provider: 'azet',
      lastCheckedAt: new Date(Date.UTC(2026, 0, 2, 3, 4)),
    };
    expect(displayWidth(mailbox.email)).toBe(23);
    const out = renderApp(atHome([mailbox], SMALLEST), FMT);
    checkFrame(out, SMALLEST);
    expect(lineAt(out, 1)).toBe(`    ${mailbox.email}${' '.repeat(7)}Azet  `);
  });

  it('the kind of cell is chosen for the whole frame, by the widest row', () => {
    const mixed: MailboxRow[] = [
      { id: 'id-1', email: 'a@example-test-domain.eu', provider: 'azet', lastCheckedAt: null },
      {
        id: 'id-2',
        email: 'b@example-test-domain.eu',
        provider: 'outlook',
        lastCheckedAt: null,
      },
    ];
    // "Outlook.com / Microsoft 365" needs 29 columns: too much at 40, so no row gets a cell.
    const narrow = renderApp(atHome(mixed, SMALLEST), FMT);
    expect(shown(narrow.lines.slice(1, 3))).toEqual([
      '    a@example-test-domain.eu',
      '    b@example-test-domain.eu',
    ]);
    const wide = renderApp(atHome(mixed, { rows: 8, cols: 90 }), FMT);
    expect(lineAt(wide, 1).trimEnd().endsWith('Azet                         checked never')).toBe(
      true,
    );
    expect(lineAt(wide, 2).trimEnd().endsWith('Outlook.com / Microsoft 365  checked never')).toBe(
      true,
    );
  });

  it('an e-mail of up to 24 columns is never cut, at any width from 40', () => {
    const mailbox: MailboxRow = {
      id: 'id-1',
      email: 'twenty-four@example-x.eu',
      provider: 'gmx-net',
      lastCheckedAt: null,
    };
    expect(displayWidth(mailbox.email)).toBe(24);
    for (let cols = 40; cols <= 100; cols++) {
      const out = renderApp(atHome([mailbox], { rows: 8, cols }), FMT);
      checkFrame(out, { rows: 8, cols });
      expect(lineAt(out, 1).startsWith(`    ${mailbox.email} `)).toBe(true);
    }
  });
});

// --- texts ----------------------------------------------------------------------------------

describe('messageText', () => {
  const TEXTS: Record<AppMessage, string> = {
    'wrong-credentials': 'Wrong e-mail or password - try again.',
    unreachable: "Can't reach Mail Manager - check your internet connection and try again.",
    'sign-in-failed': "Signing in didn't work - try again later.",
    'email-required': 'Type your e-mail address first.',
    'password-required': 'Type your password.',
    'forget-signed-in': 'Log out first to forget this address.',
    'session-ended': 'Your sign-in has ended - sign in again.',
    'load-failed': "Couldn't load your mailboxes - check your internet connection (r = try again).",
    'folder-unavailable': "Couldn't open that folder.",
    truncated: 'Only the first 5,000 folders are shown.',
    challenge: 'Several wrong passwords - waiting 5 seconds before trying again.',
  };

  it.each(Object.entries(TEXTS) as [AppMessage, string][])('%s', (message, text) => {
    expect(messageText(message)).toBe(text);
    expect(text).toMatch(ASCII);
  });
});

describe('a question keeps its end when the address is long', () => {
  // 100 columns: far wider than a 40-column line.
  const LONG_EMAIL = `${'a'.repeat(77)}@example-test-domain.eu`;
  const LONG_USER: AuthUser = { email: LONG_EMAIL, userId: 'user-long' };

  function switching(user: AuthUser, screen: Screen): AppState {
    return act(checked(user, [BEN], screen), key('down'), key('enter'));
  }

  function forgetting(email: string, screen: Screen): AppState {
    return act(checked(null, [email], screen), ch('f'));
  }

  it('a question that fits is drawn as it is', () => {
    // 9 + 27 + 13 = 49 columns.
    const exact = { rows: 8, cols: 49 };
    expect(lineAt(renderApp(switching(ANNA, exact)), 6)).toBe(
      `Sign out ${ANNA.email} first? (y/N)`,
    );
    // 7 + 26 + 7 = 40 columns: whole at the smallest size.
    expect(lineAt(renderApp(forgetting(BEN, SMALLEST)), 6)).toBe(`Forget ${BEN}? (y/N)`);
    expect(status(renderApp(switching(LONG_USER, { rows: 8, cols: 122 })))).toBe(
      `Sign out ${LONG_EMAIL} first? (y/N)`,
    );
  });

  it('40 columns, switching user: the address is shortened, " first? (y/N)" stays whole', () => {
    expect(displayWidth(ANNA.email)).toBe(27);
    expect(displayWidth(LONG_EMAIL)).toBe(100);
    const short = renderApp(switching(ANNA, SMALLEST));
    checkFrame(short, SMALLEST);
    expect(lineAt(short, 6)).toBe('Sign out anna@example-te... first? (y/N)');
    const long = renderApp(switching(LONG_USER, SMALLEST));
    checkFrame(long, SMALLEST);
    expect(lineAt(long, 6)).toBe(`Sign out ${'a'.repeat(15)}... first? (y/N)`);
    // One column less than the whole question is enough to shorten it.
    expect(lineAt(renderApp(switching(ANNA, { rows: 8, cols: 48 })), 6)).toBe(
      'Sign out anna@example-test-domai... first? (y/N)',
    );
  });

  it('40 columns, forgetting: the address is shortened, "? (y/N)" stays whole', () => {
    const short = renderApp(forgetting(ANNA.email, SMALLEST));
    checkFrame(short, SMALLEST);
    expect(lineAt(short, 6)).toBe('Forget anna@example-test-domai...? (y/N)');
    const long = renderApp(forgetting(LONG_EMAIL, SMALLEST));
    checkFrame(long, SMALLEST);
    expect(lineAt(long, 6)).toBe(`Forget ${'a'.repeat(23)}...? (y/N)`);
  });

  it('the too-small frame shows the question the same way', () => {
    const small = { rows: 5, cols: 30 };
    for (const [state, text] of [
      [switching(ANNA, SCREEN), 'Sign out anna@... first? (y/N)'],
      [switching(LONG_USER, SCREEN), 'Sign out aaaaa... first? (y/N)'],
      [forgetting(ANNA.email, SCREEN), 'Forget anna@example-...? (y/N)'],
      [forgetting(LONG_EMAIL, SCREEN), `Forget ${'a'.repeat(13)}...? (y/N)`],
    ] as const) {
      const out = renderApp(resized(state, small));
      checkFrame(out, small);
      expect(lineAt(out, 3)).toBe(text);
      expect(lineAt(out, 2)).toBe(centred(SHORT, 30));
    }
    // With room to spare it is centred like any question.
    const roomy = renderApp(resized(switching(LONG_USER, SCREEN), { rows: 5, cols: 39 }));
    expect(lineAt(roomy, 3)).toBe(`Sign out ${'a'.repeat(14)}... first? (y/N)`);
  });

  it('one character of the address and "..." is the least that is shown', () => {
    // "Sign out " + 4 + " first? (y/N)" = 26 columns; "Forget " + 4 + "? (y/N)" = 18.
    expect(renderApp(resized(switching(ANNA, SCREEN), { rows: 1, cols: 26 })).lines).toEqual([
      'Sign out a... first? (y/N)',
    ]);
    expect(renderApp(resized(forgetting(ANNA.email, SCREEN), { rows: 1, cols: 18 })).lines).toEqual(
      ['Forget a...? (y/N)'],
    );
  });

  it('narrower than that, the line is cut like any long text', () => {
    const switchLine = renderApp(resized(switching(ANNA, SCREEN), { rows: 1, cols: 25 })).lines;
    expect(switchLine).toEqual(['Sign out anna@example-...']);
    const forgetLine = renderApp(
      resized(forgetting(ANNA.email, SCREEN), { rows: 1, cols: 17 }),
    ).lines;
    expect(forgetLine).toEqual(['Forget anna@ex...']);
    for (const cols of [1, 5, 12]) {
      const screen = { rows: 2, cols };
      checkFrame(renderApp(resized(switching(LONG_USER, SCREEN), screen)), screen);
      checkFrame(renderApp(resized(forgetting(LONG_EMAIL, SCREEN), screen)), screen);
    }
  });

  it('a user without an e-mail: the question fits at every supported size', () => {
    const nameless = { email: '', userId: 'user-none' };
    expect(lineAt(renderApp(switching(nameless, SMALLEST)), 6)).toBe(
      'Sign out (no e-mail) first? (y/N)       ',
    );
  });

  it('wide characters in the address: the end still shows and the line keeps its width', () => {
    const user = { email: '日本語のユーザー名前@example-test-domain.eu', userId: 'user-x' };
    for (const cols of [40, 41, 42, 43, 60]) {
      const screen = { rows: 8, cols };
      const out = renderApp(switching(user, screen));
      checkFrame(out, screen);
      expect(status(out).endsWith(' first? (y/N)')).toBe(true);
      const asked = renderApp(forgetting(user.email, screen));
      checkFrame(asked, screen);
      expect(status(asked).endsWith('? (y/N)')).toBe(true);
    }
  });

  it('an address with hostile characters is cleaned before it is measured', () => {
    const user = { email: `${'a'.repeat(30)}\u202e\u200b@example-test-domain.eu`, userId: 'u' };
    const out = renderApp(switching(user, SMALLEST));
    checkFrame(out, SMALLEST);
    expect(lineAt(out, 6)).toBe(`Sign out ${'a'.repeat(15)}... first? (y/N)`);
  });

  it('hints and messages are still cut at the end', () => {
    const home = atHome(MAILBOXES, SMALLEST);
    if (home.view.kind !== 'home') throw new Error('not on Home');
    const added = `${'a'.repeat(40)}@example-test-domain.eu`;
    const hint = renderApp({ ...home, view: { ...home.view, added } }, FMT);
    expect(lineAt(hint, 6)).toBe(`Added ${'a'.repeat(31)}...`);
    expect(lineAt(renderApp(homeFailed(SMALLEST)), 6)).toBe(
      "Couldn't load your mailboxes - check ...",
    );
  });
});

describe('the key help when the line is narrow', () => {
  it('40 columns: the keys that matter most stay', () => {
    expect(help(renderApp(checked(ANNA, [BEN], SMALLEST)))).toBe(
      'Up/Down move  Enter choose  q quit',
    );
    expect(help(renderApp(typeText(emptyForm(SMALLEST), 'a')))).toBe(
      'Enter next  Esc back  Ctrl+C quit',
    );
    expect(help(renderApp(atHome([], SMALLEST)))).toBe('Up/Down move  Enter open  q quit');
    expect(help(renderApp(homeFailed(SMALLEST)))).toBe('Up/Down move  r try again  q quit');
    expect(help(renderApp(checkFailed([], SMALLEST)))).toBe('r try again  q quit');
  });

  it('a status text longer than the line is cut with "..."', () => {
    const home = atHome(MAILBOXES, SMALLEST);
    if (home.view.kind !== 'home') throw new Error('not on Home');
    const added = `${'a'.repeat(40)}@example-test-domain.eu`;
    const out = renderApp({ ...home, view: { ...home.view, added } }, FMT);
    expect(lineAt(out, 6)).toBe(`Added ${'a'.repeat(31)}...`);
  });
});

// --- strings from outside -------------------------------------------------------------------

describe('strings from outside are cleaned before they are drawn (AC23)', () => {
  const HOSTILE = 'ev\u001b[31mil\u202e@exa\u200bmple\u0000-test\u0007.eu';
  const CLEAN = 'ev[31mil@example-test.eu';
  const screen = { rows: 10, cols: 70 };

  it('the signed-in user, in the list, the question and the Home header', () => {
    const user = { email: HOSTILE, userId: 'user-x' };
    const list = renderApp(checked(user, [BEN], screen));
    checkFrame(list, screen);
    expect(lineAt(list, 1).startsWith(`    ${CLEAN} `)).toBe(true);
    const asked = renderApp(act(checked(user, [BEN], screen), key('down'), key('enter')));
    checkFrame(asked, screen);
    expect(status(asked)).toBe(`Sign out ${CLEAN} first? (y/N)`);
    const opened = renderApp(act(checked(user, [BEN], screen), key('enter')));
    checkFrame(opened, screen);
    expect(lineAt(opened, 0).trimEnd()).toBe(`Mail Manager - ${CLEAN}`);
    const small = renderApp(
      resized(act(checked(user, [BEN], screen), key('down'), key('enter')), { rows: 4, cols: 60 }),
    );
    checkFrame(small, { rows: 4, cols: 60 });
    expect(shown(small.lines.map((l) => l.trim()))).toContain(`Sign out ${CLEAN} first? (y/N)`);
  });

  it('an address that is nothing but invisible characters counts as none', () => {
    const user = { email: '\u200b\u202e\ufeff', userId: 'user-x' };
    const opened = renderApp(act(checked(user, [], screen), key('enter')));
    checkFrame(opened, screen);
    expect(lineAt(opened, 0).trimEnd()).toBe('Mail Manager - (no e-mail)');
  });

  it('remembered addresses (users.json can be edited by hand)', () => {
    const state = checked(null, [HOSTILE, BEN], screen);
    const list = renderApp(state);
    checkFrame(list, screen);
    expect(shown(body(list))[0]).toBe(`    ${CLEAN}`);
    const asked = renderApp(act(state, ch('f')));
    checkFrame(asked, screen);
    expect(status(asked)).toBe(`Forget ${CLEAN}? (y/N)`);
    const opened = renderApp(act(state, key('enter')));
    checkFrame(opened, screen);
    expect(lineAt(opened, 1).trimEnd()).toBe(`    E-mail:    ${CLEAN}`);
  });

  it('mailbox rows: e-mail, provider id and the formatted time', () => {
    const rows: MailboxRow[] = [
      {
        id: 'id-1',
        email: HOSTILE,
        provider: 'gm\u001b[2Jail\u202e',
        lastCheckedAt: null,
      },
      { id: 'id-2', email: BEN, provider: 'websupport', lastCheckedAt: null },
    ];
    const wide = { rows: 10, cols: 90 };
    const out = renderApp(atHome(rows, wide), {
      formatChecked: () => 'ne\u001b[1mver\u202e\u200f',
    });
    checkFrame(out, wide);
    expect(lineAt(out, 1).startsWith(`    ${CLEAN} `)).toBe(true);
    // A provider id that is no preset is "Custom", whatever it holds.
    expect(lineAt(out, 1).trimEnd().endsWith('Custom      checked ne[1mver')).toBe(true);
    expect(lineAt(out, 2).trimEnd().endsWith('Websupport  checked ne[1mver')).toBe(true);
  });

  it('the version', () => {
    const state = startApp(initialApp('1.2\u001b[5m.3\u202e', screen)).state;
    const out = renderApp(state);
    checkFrame(out, screen);
    expect(lineAt(out, 0).startsWith('Mail Manager 1.2[5m.3 ')).toBe(true);
  });

  it('a typed e-mail, even one no key could have produced', () => {
    const typedIn = typeText(emptyForm(screen), 'ab');
    if (typedIn.view.kind !== 'sign-in' || typedIn.view.form === null) throw new Error('no form');
    const forged: AppState = {
      ...typedIn,
      view: { ...typedIn.view, form: { ...typedIn.view.form, email: HOSTILE } },
    };
    const out = renderApp(forged);
    checkFrame(out, screen);
    expect(lineAt(out, 1).trimEnd()).toBe(`    E-mail:    ${CLEAN}_`);
  });

  it('wide characters are measured: the frame keeps its width', () => {
    const user = { email: '日本語のユーザー😀@example-test-domain.eu', userId: 'user-x' };
    const rows: MailboxRow[] = [
      {
        id: 'id-1',
        email: '日本語のメール箱@example-test-domain.eu',
        provider: 'azet',
        lastCheckedAt: null,
      },
    ];
    for (const size of [SMALLEST, screen, { rows: 9, cols: 47 }]) {
      checkFrame(renderApp(checked(user, [user.email, BEN], size)), size);
      const signedIn = act(checked(user, [], size), key('enter'));
      checkFrame(renderApp(signedIn), size);
      checkFrame(
        renderApp(act(signedIn, { type: 'mailboxes', generation: signedIn.generation, rows }), FMT),
        size,
      );
      checkFrame(
        renderApp(typeText(emptyForm(size), '日本語日本語日本語日本語日本語日本語日本語')),
        size,
      );
    }
  });
});
