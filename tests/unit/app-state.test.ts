import { describe, it, expect } from 'vitest';
import { addView } from '../../src/cli/app/add.js';
import { reduceApp, startApp } from '../../src/cli/app/reduce.js';
import {
  HOME_ACTIONS,
  MAX_EMAIL_CHARS,
  MAX_PASSWORD_CHARS,
  appKeyOf,
  emit,
  erased,
  initialApp,
  knownUsers,
  tooSmall,
  typed,
  windowTop,
} from '../../src/cli/app/state.js';
import type {
  AppAction,
  AppEffect,
  AppKey,
  AppState,
  HomeView,
  MailboxRow,
  PendingEffect,
  SignInForm,
  SignInView,
} from '../../src/cli/app/state.js';
import type { Screen } from '../../src/cli/browser/state.js';
import type { AuthUser } from '../../src/core/auth.js';

// M2d-1 app state: keys, field helpers, the sign-in and Home reducers and reduceApp. States
// are built with initialApp + the reducers; addresses are placeholders; hostile and invisible
// characters are written as escapes.

// --- helpers --------------------------------------------------------------------------------

const ANNA: AuthUser = { email: 'anna@example-test-domain.eu', userId: 'user-anna' };
const DANA: AuthUser = { email: 'dana@example-test-domain.eu', userId: 'user-dana' };
const BEN = 'ben@example-test-domain.eu';
const CYRIL = 'cyril@example-test-domain.eu';
const SCREEN: Screen = { rows: 24, cols: 80 };
const TOO_SMALL: Screen = { rows: 7, cols: 80 };
/** Leading and trailing spaces belong to it. */
const PASSWORD = ' CANARY-s3cret pass ';

const EMPTY_FORM: SignInForm = { email: '', fixedEmail: false, password: '', field: 'email' };
const FRESH_HOME: HomeView = {
  kind: 'home',
  mode: 'list',
  mailboxes: null,
  loadFailed: false,
  cursor: 0,
  message: null,
  focusId: null,
  added: null,
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
    provider: 'custom',
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

/** The app right after its start: the session check is under way. */
function started(screen: Screen = SCREEN): AppState {
  return startApp(initialApp('1.2.3', screen)).state;
}

/** The session check answered: `user` is signed in (or nobody), `remembered` is listed. */
function checked(
  user: AuthUser | null,
  remembered: readonly string[],
  screen: Screen = SCREEN,
): AppState {
  const s = started(screen);
  return act(s, { type: 'session', generation: s.generation, user, remembered });
}

/** The empty form, opened from the last row with nobody signed in. */
function emptyForm(): AppState {
  return act(checked(null, [BEN]), key('down'), key('enter'));
}

/** The form with `email` typed and the password field active. */
function passwordField(email: string): AppState {
  return act(typeText(emptyForm(), email), key('enter'));
}

/** Submitted: "Signing in..." */
function submitting(email = BEN, password = PASSWORD): AppState {
  return act(typeText(passwordField(email), password), key('enter'));
}

/** Home of ANNA: loading, or with `rows` loaded. */
function atHome(rows?: readonly MailboxRow[], screen: Screen = SCREEN): AppState {
  const opened = act(checked(ANNA, [ANNA.email, BEN], screen), key('enter'));
  return rows === undefined
    ? opened
    : act(opened, { type: 'mailboxes', generation: opened.generation, rows });
}

function signIn(state: AppState): SignInView {
  if (state.view.kind !== 'sign-in') throw new Error('not on the sign-in page');
  return state.view;
}

function home(state: AppState): HomeView {
  if (state.view.kind !== 'home') throw new Error('not on Home');
  return state.view;
}

function form(state: AppState): SignInForm {
  const f = signIn(state).form;
  if (f === null) throw new Error('no form');
  return f;
}

// --- keys -----------------------------------------------------------------------------------

describe('appKeyOf', () => {
  it.each([
    ['up', '\u001b[A', 'up'],
    ['down', '\u001b[B', 'down'],
    ['pageup', '\u001b[5~', 'pageup'],
    ['pagedown', '\u001b[6~', 'pagedown'],
    ['return', '\r', 'enter'],
    ['enter', '\n', 'enter'],
    ['left', '\u001b[D', 'left'],
    ['backspace', '\u007f', 'backspace'],
    ['tab', '\t', 'tab'],
  ] as const)('the %s key', (name, sequence, type) => {
    expect(appKeyOf({ name, sequence })).toEqual({ type });
    expect(appKeyOf({ name, sequence, ctrl: false, meta: false, shift: true })).toEqual({ type });
  });

  it('a lone Esc, which readline reports with meta, is escape', () => {
    expect(appKeyOf({ name: 'escape', sequence: '\u001b', meta: true })).toEqual({
      type: 'escape',
    });
    expect(appKeyOf({ name: 'escape', sequence: '\u001b' })).toEqual({ type: 'escape' });
    expect(appKeyOf({ name: 'escape', sequence: '\u001b', ctrl: true })).toEqual({
      type: 'other',
    });
  });

  it('Ctrl+U empties a field', () => {
    expect(appKeyOf({ name: 'u', sequence: '\u0015', ctrl: true })).toEqual({ type: 'clear' });
    // Whatever else is held with it.
    expect(appKeyOf({ name: 'u', sequence: '\u001b\u0015', ctrl: true, meta: true })).toEqual({
      type: 'clear',
    });
  });

  it.each([
    ['Ctrl+C', { name: 'c', sequence: '\u0003', ctrl: true }],
    ['Ctrl+A', { name: 'a', sequence: '\u0001', ctrl: true }],
    ['Ctrl+Left', { name: 'left', sequence: '\u001b[1;5D', ctrl: true }],
    ['Ctrl+Enter', { name: 'return', sequence: '\r', ctrl: true }],
    ['Meta+B', { name: 'b', sequence: '\u001bb', meta: true }],
    ['Meta+U', { name: 'u', sequence: '\u001bu', meta: true }],
    ['Meta+Up', { name: 'up', sequence: '\u001b\u001b[A', meta: true }],
    ['Meta+Enter', { name: 'return', sequence: '\u001b\r', meta: true }],
  ])('%s is left to the shell', (_label, keypress) => {
    expect(appKeyOf(keypress)).toEqual({ type: 'other' });
  });

  it('letters are typed text and keep their case', () => {
    expect(appKeyOf({ name: 'q', sequence: 'q' })).toEqual({ type: 'char', text: 'q' });
    expect(appKeyOf({ name: 'q', sequence: 'Q', shift: true })).toEqual({
      type: 'char',
      text: 'Q',
    });
    expect(appKeyOf({ name: 'y', sequence: 'y' })).toEqual({ type: 'char', text: 'y' });
    expect(appKeyOf({ name: 'u', sequence: 'u' })).toEqual({ type: 'char', text: 'u' });
  });

  it('a space, digits and symbols are typed text', () => {
    expect(appKeyOf({ name: 'space', sequence: ' ' })).toEqual({ type: 'char', text: ' ' });
    expect(appKeyOf({ name: '1', sequence: '1' })).toEqual({ type: 'char', text: '1' });
    expect(appKeyOf({ sequence: '@' })).toEqual({ type: 'char', text: '@' });
    expect(appKeyOf({ name: undefined, sequence: '!' })).toEqual({ type: 'char', text: '!' });
  });

  it.each([
    ['an accented letter', 'é'],
    ['a CJK character', '日'],
    ['an emoji (two UTF-16 units)', '😀'],
    ['a family emoji (one grapheme, eight units)', '👨\u200D👩\u200D👧'],
    ['sixteen units', 'a'.repeat(16)],
  ])('%s is typed text', (_label, sequence) => {
    expect(appKeyOf({ sequence })).toEqual({ type: 'char', text: sequence });
  });

  it.each([
    ['a zero-width joiner', '\u200d'],
    ['a zero-width space', '\u200b'],
    ['a right-to-left override', '\u202e'],
    ['a soft hyphen', '\u00ad'],
  ])('%s passes: a password may contain it', (_label, sequence) => {
    expect(appKeyOf({ sequence })).toEqual({ type: 'char', text: sequence });
  });

  it.each([
    ['the Right arrow', { name: 'right', sequence: '\u001b[C' }],
    ['F1', { name: 'f1', sequence: '\u001bOP' }],
    ['Delete', { name: 'delete', sequence: '\u001b[3~' }],
    ['Home', { name: 'home', sequence: '\u001b[H' }],
    ['an unnamed escape sequence', { sequence: '\u001b[200~' }],
    ['NUL', { sequence: '\u0000' }],
    ['BEL', { sequence: '\u0007' }],
    ['DEL without a name', { sequence: '\u007f' }],
    ['a C1 control (NEL)', { sequence: '\u0085' }],
    ['a C1 control (CSI)', { sequence: '\u009b31m' }],
    ['text with a line break in it', { sequence: 'a\nb' }],
    ['text with an escape in it', { sequence: 'a\u001bb' }],
    ['an empty sequence', { name: 'x', sequence: '' }],
    ['no sequence', { name: 'x' }],
    ['nothing at all', {}],
    ['seventeen units', { sequence: 'a'.repeat(17) }],
  ])('%s is not typed text', (_label, keypress) => {
    expect(appKeyOf(keypress)).toEqual({ type: 'other' });
  });

  it('a name that is no key of its own never hides the typed character', () => {
    for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'UP', 'Enter']) {
      expect(appKeyOf({ name, sequence: 'x' })).toEqual({ type: 'char', text: 'x' });
    }
  });
});

// --- field helpers --------------------------------------------------------------------------

describe('typed', () => {
  it('appends while the result has at most `max` code points', () => {
    expect(typed('', 'a', 3)).toBe('a');
    expect(typed('ab', 'c', 3)).toBe('abc');
    expect(typed('abc', 'd', 3)).toBe('abc');
    expect(typed('abcd', 'e', 3)).toBe('abcd');
    expect(typed('', 'a', 0)).toBe('');
  });

  it('takes as much of a longer text as fits', () => {
    expect(typed('ab', 'cdefgh', 4)).toBe('abcd');
    expect(typed('', 'abc', 10)).toBe('abc');
  });

  it('counts code points, not UTF-16 units, and never splits one', () => {
    expect(typed('😀😀', '😀', 3)).toBe('😀😀😀');
    expect(typed('😀😀😀', '😀', 3)).toBe('😀😀😀');
    expect(typed('😀', '😀😀😀', 3)).toBe('😀😀😀');
    expect(typed('ab', '😀', 3)).toBe('ab😀');
    expect(typed('e', '\u0301', 2)).toBe('e\u0301');
    expect(typed('e\u0301', 'x', 2)).toBe('e\u0301');
  });

  it('the limits: an address of 254, a password of 1,024 code points', () => {
    expect(MAX_EMAIL_CHARS).toBe(254);
    expect(MAX_PASSWORD_CHARS).toBe(1024);
  });
});

describe('erased', () => {
  it('removes the last code point', () => {
    expect(erased('abc')).toBe('ab');
    expect(erased('a')).toBe('');
    expect(erased('')).toBe('');
    expect(erased('a😀')).toBe('a');
    expect(erased('😀😀')).toBe('😀');
    expect(erased('e\u0301')).toBe('e');
  });
});

// --- small helpers --------------------------------------------------------------------------

describe('knownUsers', () => {
  it('nobody signed in: the remembered addresses, in their order', () => {
    expect(knownUsers({ current: null, remembered: [BEN, CYRIL] })).toEqual([
      { email: BEN, signedIn: false },
      { email: CYRIL, signedIn: false },
    ]);
    expect(knownUsers({ current: null, remembered: [] })).toEqual([]);
  });

  it('the signed-in user comes first, as stored', () => {
    const current = { email: 'Anna@Example-Test-Domain.EU', userId: 'user-anna' };
    expect(knownUsers({ current, remembered: [BEN, CYRIL] })).toEqual([
      { email: 'Anna@Example-Test-Domain.EU', signedIn: true },
      { email: BEN, signedIn: false },
      { email: CYRIL, signedIn: false },
    ]);
    expect(knownUsers({ current, remembered: [] })).toEqual([
      { email: 'Anna@Example-Test-Domain.EU', signedIn: true },
    ]);
  });

  it('a remembered address that is the signed-in user in another letter case is one row', () => {
    const current = { email: 'Anna@Example-Test-Domain.EU', userId: 'user-anna' };
    expect(knownUsers({ current, remembered: [BEN, ANNA.email, CYRIL] })).toEqual([
      { email: 'Anna@Example-Test-Domain.EU', signedIn: true },
      { email: BEN, signedIn: false },
      { email: CYRIL, signedIn: false },
    ]);
  });

  it('a signed-in user without an e-mail is shown as (no e-mail)', () => {
    const current = { email: '', userId: 'user-none' };
    expect(knownUsers({ current, remembered: [BEN] })).toEqual([
      { email: '(no e-mail)', signedIn: true },
      { email: BEN, signedIn: false },
    ]);
  });

  it('an international domain: its Unicode and its stored xn-- form are one user', () => {
    const typed = { email: 'Jana@B\u00fccher.example', userId: 'user-jana' };
    expect(knownUsers({ current: typed, remembered: ['jana@xn--bcher-kva.example', BEN] })).toEqual(
      [
        // Shown as Mail Manager gave it.
        { email: 'Jana@B\u00fccher.example', signedIn: true },
        { email: BEN, signedIn: false },
      ],
    );
    const stored = { email: 'jana@xn--bcher-kva.example', userId: 'user-jana' };
    expect(knownUsers({ current: stored, remembered: ['JANA@b\u00fccher.example', BEN] })).toEqual([
      { email: 'jana@xn--bcher-kva.example', signedIn: true },
      { email: BEN, signedIn: false },
    ]);
  });

  it('another name at the same international domain is another user', () => {
    const current = { email: 'jana@b\u00fccher.example', userId: 'user-jana' };
    expect(knownUsers({ current, remembered: ['hana@xn--bcher-kva.example'] })).toEqual([
      { email: 'jana@b\u00fccher.example', signedIn: true },
      { email: 'hana@xn--bcher-kva.example', signedIn: false },
    ]);
  });

  it('spaces around an address do not make a second user', () => {
    const current = { email: ` ${ANNA.email} `, userId: 'user-anna' };
    expect(knownUsers({ current, remembered: [ANNA.email, BEN] })).toEqual([
      { email: ` ${ANNA.email} `, signedIn: true },
      { email: BEN, signedIn: false },
    ]);
  });

  it('text that is not an address is compared without letter case, as before', () => {
    const odd = { email: 'Local-User', userId: 'user-odd' };
    expect(knownUsers({ current: odd, remembered: ['local-user', 'LOCAL-USER', BEN] })).toEqual([
      { email: 'Local-User', signedIn: true },
      { email: BEN, signedIn: false },
    ]);
    expect(knownUsers({ current: odd, remembered: ['local-user2', ANNA.email] })).toEqual([
      { email: 'Local-User', signedIn: true },
      { email: 'local-user2', signedIn: false },
      { email: ANNA.email, signedIn: false },
    ]);
    const nameless = { email: '', userId: 'user-none' };
    expect(knownUsers({ current: nameless, remembered: [ANNA.email, BEN] })).toHaveLength(3);
  });

  it('the address the app remembers at the session check gives no second row', () => {
    const user = { email: 'jana@b\u00fccher.example', userId: 'user-jana' };
    const s = checked(user, ['jana@xn--bcher-kva.example']);
    expect(knownUsers(s)).toEqual([{ email: 'jana@b\u00fccher.example', signedIn: true }]);
    // Two rows: the user and "Sign in as another user". Enter on the first opens Home.
    expect(signIn(act(s, key('down'), key('down'))).cursor).toBe(1);
    expect(act(s, key('enter')).view.kind).toBe('home');
    // Nothing offers to sign the user out to sign in as the same user.
    expect(form(act(s, key('down'), key('enter')))).toEqual(EMPTY_FORM);
  });

  it('leaves its input alone', () => {
    const remembered = [BEN, ANNA.email];
    knownUsers({ current: ANNA, remembered });
    expect(remembered).toEqual([BEN, ANNA.email]);
  });
});

describe('emit, tooSmall, windowTop, initialApp, startApp', () => {
  it.each<PendingEffect>([
    { type: 'check-session' },
    { type: 'sign-in', email: BEN, password: PASSWORD },
    { type: 'sign-out' },
    { type: 'load-mailboxes' },
  ])('emit %o: generation + 1 on the state and on the effect', (effect) => {
    const state = { ...initialApp('1.2.3', SCREEN), generation: 6 };
    const out = emit(state, effect);
    expect(out.state).toEqual({ ...state, generation: 7 });
    expect(out.effects).toEqual([{ ...effect, generation: 7 }]);
    expect(state.generation).toBe(6);
  });

  it('tooSmall: below 40 columns or 8 rows', () => {
    expect(tooSmall({ rows: 8, cols: 40 })).toBe(false);
    expect(tooSmall({ rows: 24, cols: 80 })).toBe(false);
    expect(tooSmall({ rows: 7, cols: 40 })).toBe(true);
    expect(tooSmall({ rows: 8, cols: 39 })).toBe(true);
    expect(tooSmall({ rows: 0, cols: 0 })).toBe(true);
  });

  it('windowTop: the first row shown so the cursor stays on screen', () => {
    expect(windowTop(0, 5)).toBe(0);
    expect(windowTop(4, 5)).toBe(0);
    expect(windowTop(5, 5)).toBe(1);
    expect(windowTop(12, 5)).toBe(8);
    expect(windowTop(3, 1)).toBe(3);
  });

  it('initialApp: the sign-in page, checking, generation 0', () => {
    expect(initialApp('1.2.3', SCREEN)).toEqual({
      version: '1.2.3',
      screen: SCREEN,
      generation: 0,
      current: null,
      remembered: [],
      autoStats: false,
      addProblem: null,
      view: { kind: 'sign-in', mode: 'checking', cursor: 0, form: null, message: null },
    });
  });

  it('initialApp takes a size a terminal may report: whole, never negative', () => {
    expect(initialApp('1', { rows: 24.7, cols: Number.NaN }).screen).toEqual({ rows: 24, cols: 0 });
    expect(initialApp('1', { rows: -3, cols: 80 }).screen).toEqual({ rows: 0, cols: 80 });
  });

  it('startApp asks who is signed in', () => {
    const out = startApp(initialApp('1.2.3', SCREEN));
    expect(out.effects).toEqual([{ type: 'check-session', generation: 1 }]);
    expect(out.state).toEqual({ ...initialApp('1.2.3', SCREEN), generation: 1 });
  });
});

// --- reduceApp ------------------------------------------------------------------------------

describe('reduceApp: resize and stale results', () => {
  it('a resize changes the screen and nothing else', () => {
    for (const state of [started(), checked(ANNA, [BEN]), submitting(), atHome(MAILBOXES)]) {
      const out = reduceApp(state, { type: 'resize', screen: { rows: 30.9, cols: 100 } });
      expect(out.effects).toEqual([]);
      expect(out.state).toEqual({ ...state, screen: { rows: 30, cols: 100 } });
    }
  });

  it('a result for another generation changes nothing, on either page', () => {
    for (const state of [
      started(),
      submitting(),
      act(checked(ANNA, [BEN]), key('down'), key('enter'), ch('y')),
      atHome(),
      act(atHome(MAILBOXES), ...repeat(key('down'), 4), key('enter')),
    ]) {
      for (const generation of [state.generation - 1, state.generation + 1, 0]) {
        const late: AppAction[] = [
          { type: 'session', generation, user: DANA, remembered: [CYRIL] },
          { type: 'session-failed', generation, remembered: [CYRIL] },
          { type: 'signed-in', generation, user: DANA, remembered: [CYRIL] },
          { type: 'sign-in-failed', generation, reason: 'invalid-credentials' },
          { type: 'signed-out', generation, remembered: [CYRIL] },
          { type: 'mailboxes', generation, rows: MAILBOXES },
          { type: 'mailboxes-failed', generation },
          { type: 'session-ended', generation, remembered: [CYRIL] },
        ];
        for (const action of late) {
          const out = reduceApp(state, action);
          expect(out.state).toBe(state);
          expect(out.effects).toEqual([]);
        }
      }
    }
  });

  it('a result the page on screen does not wait for changes nothing', () => {
    const picking = checked(ANNA, [BEN]);
    const generation = picking.generation;
    for (const action of [
      { type: 'session', generation, user: DANA, remembered: [CYRIL] },
      { type: 'session-failed', generation, remembered: [CYRIL] },
      { type: 'signed-in', generation, user: DANA, remembered: [CYRIL] },
      { type: 'sign-in-failed', generation, reason: 'unknown' },
      { type: 'signed-out', generation, remembered: [CYRIL] },
      { type: 'mailboxes', generation, rows: MAILBOXES },
      { type: 'mailboxes-failed', generation },
      { type: 'session-ended', generation, remembered: [CYRIL] },
    ] satisfies AppAction[]) {
      const out = reduceApp(picking, action);
      expect(out.state).toBe(picking);
      expect(out.effects).toEqual([]);
    }
    const listed = atHome(MAILBOXES);
    for (const action of [
      { type: 'session', generation: listed.generation, user: DANA, remembered: [] },
      { type: 'signed-in', generation: listed.generation, user: DANA, remembered: [] },
      { type: 'sign-in-failed', generation: listed.generation, reason: 'unreachable' },
      { type: 'signed-out', generation: listed.generation, remembered: [] },
    ] satisfies AppAction[]) {
      const out = reduceApp(listed, action);
      expect(out.state).toBe(listed);
      expect(out.effects).toEqual([]);
    }
  });
});

// --- sign-in page ---------------------------------------------------------------------------

describe('sign-in: the session check (AC6, AC15)', () => {
  it('while checking, every key is ignored', () => {
    const s = started();
    for (const action of [key('enter'), key('escape'), key('down'), ch('q'), ch('r'), ch('y')]) {
      const out = reduceApp(s, action);
      expect(out.state).toBe(s);
      expect(out.effects).toEqual([]);
    }
  });

  it('a signed-in user and remembered addresses: the list, cursor on the first row', () => {
    const s = checked(ANNA, [BEN, ANNA.email, CYRIL]);
    expect(s.current).toEqual(ANNA);
    expect(s.remembered).toEqual([BEN, ANNA.email, CYRIL]);
    expect(signIn(s)).toEqual({
      kind: 'sign-in',
      mode: 'pick',
      cursor: 0,
      form: null,
      message: null,
    });
    expect(knownUsers(s).map((u) => u.email)).toEqual([ANNA.email, BEN, CYRIL]);
  });

  it('nobody signed in, some remembered: the list', () => {
    const s = checked(null, [BEN]);
    expect(s.current).toBeNull();
    expect(signIn(s).mode).toBe('pick');
    expect(signIn(s).cursor).toBe(0);
  });

  it('nobody signed in and nothing remembered: the form opens, e-mail field active', () => {
    const s = checked(null, []);
    expect(signIn(s).mode).toBe('form');
    expect(form(s)).toEqual(EMPTY_FORM);
  });

  it('Esc in that form shows the list with its single row', () => {
    const s = act(checked(null, []), key('escape'));
    expect(signIn(s)).toEqual({
      kind: 'sign-in',
      mode: 'pick',
      cursor: 0,
      form: null,
      message: null,
    });
    expect(knownUsers(s)).toEqual([]);
    // Enter on the only row opens the form again.
    expect(form(act(s, key('enter')))).toEqual(EMPTY_FORM);
  });

  it('Mail Manager unreachable: its message, nobody signed in, the remembered kept', () => {
    const s0 = started();
    const s = act(s0, { type: 'session-failed', generation: s0.generation, remembered: [BEN] });
    expect(signIn(s).mode).toBe('check-failed');
    expect(signIn(s).message).toBe('unreachable');
    expect(s.current).toBeNull();
    expect(s.remembered).toEqual([BEN]);
  });

  it('r checks again; q and Esc quit; nothing else acts', () => {
    const s0 = started();
    const failed = act(s0, { type: 'session-failed', generation: s0.generation, remembered: [] });
    for (const text of ['r', 'R']) {
      const out = reduceApp(failed, ch(text));
      expect(signIn(out.state).mode).toBe('checking');
      expect(signIn(out.state).message).toBeNull();
      expect(out.state.generation).toBe(failed.generation + 1);
      expect(out.effects).toEqual([{ type: 'check-session', generation: failed.generation + 1 }]);
    }
    for (const action of [ch('q'), ch('Q'), key('escape')]) {
      expect(reduceApp(failed, action).effects).toEqual([{ type: 'quit' }]);
    }
    for (const action of [key('enter'), key('down'), ch('y'), ch('f'), key('tab')]) {
      const out = reduceApp(failed, action);
      expect(out.state).toBe(failed);
      expect(out.effects).toEqual([]);
    }
  });

  it('the answer to the second check is taken, the first one no longer', () => {
    const s0 = started();
    const failed = act(s0, { type: 'session-failed', generation: s0.generation, remembered: [] });
    const again = act(failed, ch('r'));
    const late = act(again, {
      type: 'session',
      generation: s0.generation,
      user: ANNA,
      remembered: [],
    });
    expect(late).toBe(again);
    const answered = act(again, {
      type: 'session',
      generation: again.generation,
      user: ANNA,
      remembered: [ANNA.email],
    });
    expect(signIn(answered).mode).toBe('pick');
    expect(answered.current).toEqual(ANNA);
  });
});

describe('sign-in: the list', () => {
  it('Up and Down move by one row and stop at the ends', () => {
    let s = checked(ANNA, [BEN, CYRIL]);
    expect(signIn(act(s, key('up'))).cursor).toBe(0);
    s = act(s, key('down'));
    expect(signIn(s).cursor).toBe(1);
    s = act(s, key('down'), key('down'));
    // Three users and the last row: indexes 0..3.
    expect(signIn(s).cursor).toBe(3);
    expect(signIn(act(s, key('down'))).cursor).toBe(3);
    expect(signIn(act(s, key('up'))).cursor).toBe(2);
  });

  it('PgUp and PgDn move by the body height (rows - 3)', () => {
    const many = Array.from(
      { length: 30 },
      (_, i) => `user${String(i + 1)}@example-test-domain.eu`,
    );
    let s = checked(null, many);
    s = act(s, key('pagedown'));
    expect(signIn(s).cursor).toBe(21);
    s = act(s, key('pagedown'));
    expect(signIn(s).cursor).toBe(30);
    s = act(s, key('pageup'));
    expect(signIn(s).cursor).toBe(9);
    s = act(s, key('pageup'));
    expect(signIn(s).cursor).toBe(0);
  });

  it('q, Q and Esc quit', () => {
    const s = checked(ANNA, [BEN]);
    for (const action of [ch('q'), ch('Q'), key('escape')]) {
      const out = reduceApp(s, action);
      expect(out.effects).toEqual([{ type: 'quit' }]);
      expect(out.state).toEqual(s);
    }
  });

  it('keys that mean nothing here change nothing', () => {
    const s = checked(ANNA, [BEN]);
    for (const action of [key('left'), key('backspace'), key('tab'), key('clear'), key('other')]) {
      const out = reduceApp(s, action);
      expect(out.state).toEqual(s);
      expect(out.effects).toEqual([]);
    }
    for (const text of ['x', 'y', 'r', ' ', '1']) {
      const out = reduceApp(s, ch(text));
      expect(out.state).toEqual(s);
      expect(out.effects).toEqual([]);
    }
  });

  it('any key clears a message first', () => {
    const noted = act(checked(ANNA, [BEN]), ch('f'));
    expect(signIn(noted).message).toBe('forget-signed-in');
    for (const action of [key('down'), key('up'), key('left'), ch('x'), key('other')]) {
      expect(signIn(act(noted, action)).message).toBeNull();
    }
  });

  it('Enter on the signed-in row opens Home: no password, no sign-in (AC7)', () => {
    const s = checked(ANNA, [BEN]);
    const out = reduceApp(s, key('enter'));
    expect(out.state.view).toEqual(FRESH_HOME);
    expect(out.state.current).toEqual(ANNA);
    expect(out.state.generation).toBe(s.generation + 1);
    expect(out.effects).toEqual([{ type: 'load-mailboxes', generation: s.generation + 1 }]);
  });

  it('nobody signed in: Enter on a remembered row asks for the password only (AC8)', () => {
    const s = act(checked(null, [BEN, CYRIL]), key('down'));
    const out = reduceApp(s, key('enter'));
    expect(out.effects).toEqual([]);
    expect(signIn(out.state).mode).toBe('form');
    expect(form(out.state)).toEqual({
      email: CYRIL,
      fixedEmail: true,
      password: '',
      field: 'password',
    });
  });

  it('nobody signed in: Enter on the last row opens the empty form (AC8)', () => {
    const s = act(checked(null, [BEN, CYRIL]), key('down'), key('down'));
    const out = reduceApp(s, key('enter'));
    expect(out.effects).toEqual([]);
    expect(signIn(out.state).mode).toBe('form');
    expect(form(out.state)).toEqual(EMPTY_FORM);
  });
});

describe('sign-in: switching user (AC13)', () => {
  it('with a user signed in, Enter on another row asks first and sends nothing', () => {
    const onBen = act(checked(ANNA, [BEN]), key('down'));
    const asked = reduceApp(onBen, key('enter'));
    expect(asked.effects).toEqual([]);
    expect(signIn(asked.state).mode).toBe('confirm-switch');
    expect(signIn(asked.state).cursor).toBe(1);
    expect(form(asked.state)).toEqual({
      email: BEN,
      fixedEmail: true,
      password: '',
      field: 'password',
    });
    expect(asked.state.current).toEqual(ANNA);
    const lastRow = reduceApp(act(onBen, key('down')), key('enter'));
    expect(signIn(lastRow.state).mode).toBe('confirm-switch');
    expect(form(lastRow.state)).toEqual(EMPTY_FORM);
  });

  it('any key but y goes back to the list: still signed in, nothing sent', () => {
    const asked = act(checked(ANNA, [BEN]), key('down'), key('enter'));
    for (const action of [ch('n'), ch('N'), key('enter'), key('escape'), ch('q'), key('other')]) {
      const out = reduceApp(asked, action);
      expect(out.effects).toEqual([]);
      expect(signIn(out.state)).toEqual({
        kind: 'sign-in',
        mode: 'pick',
        cursor: 1,
        form: null,
        message: null,
      });
      expect(out.state.current).toEqual(ANNA);
      expect(out.state.generation).toBe(asked.generation);
    }
  });

  it('y signs out first: "Signing out...", one sign-out, keys ignored meanwhile', () => {
    const asked = act(checked(ANNA, [BEN]), key('down'), key('enter'));
    for (const text of ['y', 'Y']) {
      const out = reduceApp(asked, ch(text));
      expect(out.effects).toEqual([{ type: 'sign-out', generation: asked.generation + 1 }]);
      expect(signIn(out.state).mode).toBe('signing-out');
      expect(form(out.state).email).toBe(BEN);
      for (const action of [ch('y'), key('enter'), key('escape'), ch('q')]) {
        const during = reduceApp(out.state, action);
        expect(during.state).toBe(out.state);
        expect(during.effects).toEqual([]);
      }
    }
  });

  it('signed out: nobody is signed in and the form of the chosen row opens', () => {
    const leaving = act(checked(ANNA, [ANNA.email, BEN]), key('down'), key('enter'), ch('y'));
    const out = reduceApp(leaving, {
      type: 'signed-out',
      generation: leaving.generation,
      remembered: [ANNA.email, BEN],
    });
    expect(out.effects).toEqual([]);
    expect(out.state.current).toBeNull();
    expect(out.state.remembered).toEqual([ANNA.email, BEN]);
    expect(signIn(out.state).mode).toBe('form');
    expect(form(out.state)).toEqual({
      email: BEN,
      fixedEmail: true,
      password: '',
      field: 'password',
    });
    // The user who was signed out stays in the list, as a remembered row.
    expect(knownUsers(out.state)).toEqual([
      { email: ANNA.email, signedIn: false },
      { email: BEN, signedIn: false },
    ]);
  });

  it('signed out from the last row: the empty form; the cursor stays inside the new rows', () => {
    // ANNA is not in the remembered list here, so the list gets one row shorter.
    const leaving = act(checked(ANNA, [BEN]), key('down'), key('down'), key('enter'), ch('y'));
    expect(signIn(leaving).cursor).toBe(2);
    const out = act(leaving, {
      type: 'signed-out',
      generation: leaving.generation,
      remembered: [BEN],
    });
    expect(form(out)).toEqual(EMPTY_FORM);
    expect(signIn(out).cursor).toBe(1);
    expect(signIn(act(out, key('escape')))).toEqual({
      kind: 'sign-in',
      mode: 'pick',
      cursor: 1,
      form: null,
      message: null,
    });
  });
});

describe('sign-in: forgetting an address (AC14)', () => {
  it('f on a remembered row asks; y forgets that address', () => {
    const onCyril = act(checked(null, [BEN, CYRIL]), key('down'));
    for (const text of ['f', 'F']) {
      const asked = reduceApp(onCyril, ch(text));
      expect(asked.effects).toEqual([]);
      expect(signIn(asked.state).mode).toBe('confirm-forget');
      expect(signIn(asked.state).cursor).toBe(1);
      for (const yes of ['y', 'Y']) {
        const out = reduceApp(asked.state, ch(yes));
        expect(out.effects).toEqual([{ type: 'forget', email: CYRIL }]);
        expect(signIn(out.state).mode).toBe('pick');
        expect(out.state.generation).toBe(asked.state.generation);
      }
    }
  });

  it('any other key forgets nothing', () => {
    const asked = act(checked(null, [BEN, CYRIL]), ch('f'));
    for (const action of [ch('n'), key('enter'), key('escape'), ch('f'), ch('q')]) {
      const out = reduceApp(asked, action);
      expect(out.effects).toEqual([]);
      expect(signIn(out.state).mode).toBe('pick');
      expect(out.state.remembered).toEqual([BEN, CYRIL]);
    }
  });

  it('the new list arrives: the row is gone', () => {
    const forgotten = act(checked(null, [BEN, CYRIL]), key('down'), ch('f'), ch('y'));
    const s = act(forgotten, { type: 'remembered', emails: [BEN] });
    expect(s.remembered).toEqual([BEN]);
    expect(signIn(s).mode).toBe('pick');
    // Row 1 is now the last row, "Sign in as another user".
    expect(signIn(s).cursor).toBe(1);
    expect(knownUsers(s)).toEqual([{ email: BEN, signedIn: false }]);
  });

  it('a shorter list pulls the cursor back inside it', () => {
    const atEnd = act(checked(null, [BEN, CYRIL]), key('down'), key('down'));
    expect(signIn(atEnd).cursor).toBe(2);
    expect(signIn(act(atEnd, { type: 'remembered', emails: [] })).cursor).toBe(0);
    expect(signIn(act(atEnd, { type: 'remembered', emails: [BEN] })).cursor).toBe(1);
  });

  it('on the signed-in row: "Log out first", nothing asked', () => {
    const out = reduceApp(checked(ANNA, [BEN]), ch('f'));
    expect(out.effects).toEqual([]);
    expect(signIn(out.state).mode).toBe('pick');
    expect(signIn(out.state).message).toBe('forget-signed-in');
  });

  it('on the last row: nothing', () => {
    const lastRow = act(checked(ANNA, [BEN]), key('down'), key('down'));
    const out = reduceApp(lastRow, ch('f'));
    expect(out.state).toEqual(lastRow);
    expect(out.effects).toEqual([]);
  });
});

describe('sign-in: the form (AC9)', () => {
  it('typed characters go to the active field', () => {
    let s = typeText(emptyForm(), 'Ben@Example-Test-Domain.eu');
    expect(form(s)).toEqual({
      email: 'Ben@Example-Test-Domain.eu',
      fixedEmail: false,
      password: '',
      field: 'email',
    });
    s = typeText(act(s, key('enter')), 'pw 1');
    expect(form(s)).toEqual({
      email: 'Ben@Example-Test-Domain.eu',
      fixedEmail: false,
      password: 'pw 1',
      field: 'password',
    });
  });

  it('q, f, r and y are letters in a field', () => {
    const s = typeText(emptyForm(), 'qfryQFRY');
    expect(form(s).email).toBe('qfryQFRY');
    const out = reduceApp(s, ch('q'));
    expect(out.effects).toEqual([]);
    expect(form(typeText(act(s, key('enter')), 'qQ')).password).toBe('qQ');
  });

  it('the e-mail takes at most 254 code points, the password at most 1,024', () => {
    let s = typeText(emptyForm(), 'a'.repeat(260));
    expect(form(s).email).toBe('a'.repeat(254));
    s = typeText(act(s, key('enter')), '😀'.repeat(1030));
    expect([...form(s).password]).toHaveLength(1024);
    expect(form(s).password).toBe('😀'.repeat(1024));
  });

  it('Backspace removes the last code point of the active field', () => {
    let s = typeText(emptyForm(), 'ab😀');
    s = act(s, key('backspace'));
    expect(form(s).email).toBe('ab');
    s = act(s, key('backspace'), key('backspace'), key('backspace'));
    expect(form(s).email).toBe('');
    s = typeText(act(typeText(s, 'x'), key('enter')), 'pq');
    s = act(s, key('backspace'));
    expect(form(s)).toEqual({ email: 'x', fixedEmail: false, password: 'p', field: 'password' });
  });

  it('Ctrl+U empties the active field only', () => {
    let s = typeText(passwordField('x@example-test-domain.eu'), 'secret');
    s = act(s, key('clear'));
    expect(form(s).password).toBe('');
    expect(form(s).email).toBe('x@example-test-domain.eu');
    s = act(typeText(s, 'pw'), key('tab'), key('clear'));
    expect(form(s)).toEqual({ email: '', fixedEmail: false, password: 'pw', field: 'email' });
  });

  it('Tab, Up and Down switch field', () => {
    for (const action of [key('tab'), key('up'), key('down')]) {
      const there = act(emptyForm(), action);
      expect(form(there).field).toBe('password');
      expect(form(act(there, action)).field).toBe('email');
    }
  });

  it('a fixed e-mail is never entered or changed', () => {
    const s = act(checked(null, [BEN]), key('enter'));
    expect(form(s)).toEqual({ email: BEN, fixedEmail: true, password: '', field: 'password' });
    for (const action of [key('tab'), key('up'), key('down')]) {
      expect(form(act(s, action)).field).toBe('password');
    }
    // Even a form that somehow has the fixed field active takes nothing into it.
    const view = signIn(s);
    const forced: AppState = { ...s, view: { ...view, form: { ...form(s), field: 'email' } } };
    for (const action of [ch('x'), key('backspace'), key('clear')]) {
      expect(form(act(forced, action)).email).toBe(BEN);
    }
  });

  it('Enter on the e-mail field moves on, or asks for the e-mail', () => {
    for (const email of ['', '   ']) {
      const out = reduceApp(typeText(emptyForm(), email), key('enter'));
      expect(out.effects).toEqual([]);
      expect(signIn(out.state).mode).toBe('form');
      expect(signIn(out.state).message).toBe('email-required');
      expect(form(out.state).field).toBe('email');
    }
    const out = reduceApp(typeText(emptyForm(), 'b'), key('enter'));
    expect(out.effects).toEqual([]);
    expect(signIn(out.state).message).toBeNull();
    expect(form(out.state).field).toBe('password');
  });

  it('Enter on the password field without an e-mail goes back to the e-mail', () => {
    const s = typeText(act(emptyForm(), key('tab')), 'pw');
    const out = reduceApp(s, key('enter'));
    expect(out.effects).toEqual([]);
    expect(signIn(out.state).message).toBe('email-required');
    expect(form(out.state)).toEqual({
      email: '',
      fixedEmail: false,
      password: 'pw',
      field: 'email',
    });
  });

  it('Enter on an empty password asks for it', () => {
    const out = reduceApp(passwordField(BEN), key('enter'));
    expect(out.effects).toEqual([]);
    expect(signIn(out.state).mode).toBe('form');
    expect(signIn(out.state).message).toBe('password-required');
    expect(form(out.state).field).toBe('password');
  });

  it('any key clears a message first', () => {
    const asked = act(passwordField(BEN), key('enter'));
    expect(signIn(asked).message).toBe('password-required');
    for (const action of [ch('x'), key('backspace'), key('tab'), key('left'), key('other')]) {
      expect(signIn(act(asked, action)).message).toBeNull();
    }
  });

  it('Esc returns to the list and drops what was typed', () => {
    const typedIn = typeText(passwordField('someone@example-test-domain.eu'), PASSWORD);
    const out = reduceApp(typedIn, key('escape'));
    expect(out.effects).toEqual([]);
    expect(signIn(out.state)).toEqual({
      kind: 'sign-in',
      mode: 'pick',
      cursor: 1,
      form: null,
      message: null,
    });
    expect(JSON.stringify(out.state)).not.toContain('CANARY');
    expect(JSON.stringify(out.state)).not.toContain('someone@');
  });

  it('keys that mean nothing in a form change nothing', () => {
    const s = typeText(emptyForm(), 'ab');
    for (const action of [key('left'), key('pageup'), key('pagedown'), key('other')]) {
      const out = reduceApp(s, action);
      expect(out.state).toEqual(s);
      expect(out.effects).toEqual([]);
    }
  });

  it.each([
    ['a right-to-left override', '\u202e'],
    ['a zero-width space', '\u200b'],
    ['a zero-width joiner', '\u200d'],
    ['a soft hyphen', '\u00ad'],
    ['a byte order mark', '\ufeff'],
    ['a letter followed by an invisible character', 'a\u2060'],
  ])('the e-mail field ignores %s; the password field takes it', (_label, text) => {
    const email = typeText(emptyForm(), 'ab');
    expect(form(act(email, ch(text))).email).toBe('ab');
    const password = typeText(act(email, key('enter')), 'pw');
    expect(form(act(password, ch(text))).password).toBe(`pw${text}`);
  });
});

describe('sign-in: submitting (AC11, AC12)', () => {
  it('Enter on the password field signs in: e-mail trimmed, password as typed', () => {
    const ready = typeText(passwordField(`  ${BEN} `), PASSWORD);
    const out = reduceApp(ready, key('enter'));
    expect(out.effects).toEqual([
      { type: 'sign-in', generation: ready.generation + 1, email: BEN, password: PASSWORD },
    ]);
    expect(out.state.generation).toBe(ready.generation + 1);
    expect(signIn(out.state).mode).toBe('submitting');
    expect(signIn(out.state).message).toBeNull();
    // The e-mail stays as typed for the form; the password is gone from the state.
    expect(form(out.state)).toEqual({
      email: `  ${BEN} `,
      fixedEmail: false,
      password: '',
      field: 'password',
    });
  });

  it('a password of spaces only is sent as typed', () => {
    const out = reduceApp(typeText(passwordField(BEN), '   '), key('enter'));
    expect(out.effects).toEqual([
      { type: 'sign-in', generation: out.state.generation, email: BEN, password: '   ' },
    ]);
  });

  it('after the submit the password is in no part of the state (AC12)', () => {
    const s = submitting();
    expect(JSON.stringify(s)).not.toContain('CANARY');
    expect(JSON.stringify(s)).not.toContain(PASSWORD.trim());
    expect(form(s).password).toBe('');
  });

  it('while signing in, every key is ignored', () => {
    const s = submitting();
    for (const action of [key('enter'), key('escape'), ch('x'), key('backspace'), ch('q')]) {
      const out = reduceApp(s, action);
      expect(out.state).toBe(s);
      expect(out.effects).toEqual([]);
    }
  });

  it('signed in: Home opens for that user and the mailboxes are asked for', () => {
    const s = submitting();
    const out = reduceApp(s, {
      type: 'signed-in',
      generation: s.generation,
      user: DANA,
      remembered: [DANA.email, BEN],
    });
    expect(out.state.current).toEqual(DANA);
    expect(out.state.remembered).toEqual([DANA.email, BEN]);
    expect(out.state.view).toEqual(FRESH_HOME);
    expect(out.state.generation).toBe(s.generation + 1);
    expect(out.effects).toEqual([{ type: 'load-mailboxes', generation: s.generation + 1 }]);
    expect(JSON.stringify(out.state)).not.toContain('CANARY');
  });

  it.each([
    ['invalid-credentials', 'wrong-credentials'],
    ['unreachable', 'unreachable'],
    ['unknown', 'sign-in-failed'],
  ] as const)(
    'failed (%s): the form again, password empty and active, e-mail kept',
    (reason, message) => {
      const s = submitting('typed@example-test-domain.eu');
      const out = reduceApp(s, { type: 'sign-in-failed', generation: s.generation, reason });
      expect(out.effects).toEqual([]);
      expect(out.state.current).toBeNull();
      expect(signIn(out.state).mode).toBe('form');
      expect(signIn(out.state).message).toBe(message);
      expect(form(out.state)).toEqual({
        email: 'typed@example-test-domain.eu',
        fixedEmail: false,
        password: '',
        field: 'password',
      });
      expect(JSON.stringify(out.state)).not.toContain('CANARY');
    },
  );

  it('a second try goes out with the next generation; the first answer is then too late', () => {
    const first = submitting();
    const failed = act(first, {
      type: 'sign-in-failed',
      generation: first.generation,
      reason: 'invalid-credentials',
    });
    const second = reduceApp(typeText(failed, 'other pw'), key('enter'));
    expect(second.effects).toEqual([
      { type: 'sign-in', generation: first.generation + 1, email: BEN, password: 'other pw' },
    ]);
    const late = reduceApp(second.state, {
      type: 'signed-in',
      generation: first.generation,
      user: DANA,
      remembered: [],
    });
    expect(late.state).toBe(second.state);
    expect(late.effects).toEqual([]);
  });

  it('a remembered address signs in with its fixed e-mail', () => {
    const s = typeText(act(checked(null, [BEN]), key('enter')), 'pw');
    const out = reduceApp(s, key('enter'));
    expect(out.effects).toEqual([
      { type: 'sign-in', generation: s.generation + 1, email: BEN, password: 'pw' },
    ]);
    expect(form(out.state).fixedEmail).toBe(true);
  });
});

describe('sign-in: keys while the window is too small (AC22)', () => {
  it('on the list only q quits', () => {
    const s = resized(act(checked(ANNA, [BEN]), ch('f')), TOO_SMALL);
    for (const text of ['q', 'Q']) {
      expect(reduceApp(s, ch(text)).effects).toEqual([{ type: 'quit' }]);
    }
    for (const action of [key('enter'), key('down'), key('escape'), ch('f'), ch('y')]) {
      const out = reduceApp(s, action);
      expect(out.state).toBe(s);
      expect(out.effects).toEqual([]);
    }
  });

  it('after a failed check only q quits', () => {
    const s0 = started();
    const s = resized(
      act(s0, { type: 'session-failed', generation: s0.generation, remembered: [] }),
      TOO_SMALL,
    );
    expect(reduceApp(s, ch('q')).effects).toEqual([{ type: 'quit' }]);
    for (const action of [ch('r'), key('escape'), key('enter')]) {
      const out = reduceApp(s, action);
      expect(out.state).toBe(s);
      expect(out.effects).toEqual([]);
    }
  });

  it('nothing is typed into a form that is not shown, and nothing is submitted', () => {
    const s = resized(typeText(passwordField(BEN), 'pw'), TOO_SMALL);
    for (const action of [
      ch('x'),
      ch('q'),
      key('backspace'),
      key('clear'),
      key('tab'),
      key('enter'),
      key('escape'),
    ]) {
      const out = reduceApp(s, action);
      expect(out.state).toBe(s);
      expect(out.effects).toEqual([]);
    }
    // Back at a usable size the form is as it was.
    expect(form(resized(s, SCREEN))).toEqual({
      email: BEN,
      fixedEmail: false,
      password: 'pw',
      field: 'password',
    });
  });

  it('a pending question is still answered', () => {
    const switching = resized(act(checked(ANNA, [BEN]), key('down'), key('enter')), TOO_SMALL);
    expect(reduceApp(switching, ch('y')).effects).toEqual([
      { type: 'sign-out', generation: switching.generation + 1 },
    ]);
    expect(signIn(act(switching, ch('n'))).mode).toBe('pick');
    const forgetting = resized(act(checked(null, [BEN]), ch('f')), TOO_SMALL);
    expect(reduceApp(forgetting, ch('y')).effects).toEqual([{ type: 'forget', email: BEN }]);
    expect(reduceApp(forgetting, key('escape')).effects).toEqual([]);
    expect(signIn(act(forgetting, key('escape'))).mode).toBe('pick');
  });
});

// --- Home -----------------------------------------------------------------------------------

describe('Home: the list (AC16, AC17)', () => {
  it('the mailboxes arrive: listed, cursor on the first row', () => {
    const loading = act(atHome(), key('down'), key('down'));
    expect(home(loading).cursor).toBe(2);
    const out = reduceApp(loading, {
      type: 'mailboxes',
      generation: loading.generation,
      rows: MAILBOXES,
    });
    expect(out.effects).toEqual([]);
    expect(home(out.state)).toEqual({
      kind: 'home',
      mode: 'list',
      mailboxes: MAILBOXES,
      loadFailed: false,
      cursor: 0,
      message: null,
      focusId: null,
      added: null,
    });
  });

  it('no mailboxes: the cursor is on "+ Add a mailbox"', () => {
    const s = atHome([]);
    expect(home(s).mailboxes).toEqual([]);
    expect(home(s).cursor).toBe(0);
    expect(HOME_ACTIONS[home(s).cursor]).toBe('add');
    expect(act(s, key('enter')).view.kind).toBe('add');
  });

  it('Up and Down move over the mailboxes and the three actions', () => {
    let s = atHome(MAILBOXES);
    expect(home(act(s, key('up'))).cursor).toBe(0);
    s = act(s, ...repeat(key('down'), 4));
    expect(home(s).cursor).toBe(4);
    expect(home(act(s, key('down'))).cursor).toBe(4);
    expect(home(act(s, key('up'))).cursor).toBe(3);
  });

  it('while the list is loading only the three actions are rows', () => {
    const s = act(atHome(), ...repeat(key('down'), 5));
    expect(home(s).cursor).toBe(2);
  });

  it('PgUp and PgDn move by the body height', () => {
    const many: MailboxRow[] = Array.from({ length: 40 }, (_, i) => ({
      id: `id-${String(i)}`,
      email: `box${String(i)}@example-test-domain.eu`,
      provider: 'custom',
      lastCheckedAt: null,
    }));
    let s = act(atHome(many), key('pagedown'));
    expect(home(s).cursor).toBe(21);
    s = act(s, key('pagedown'));
    expect(home(s).cursor).toBe(42);
    s = act(s, key('pageup'));
    expect(home(s).cursor).toBe(21);
  });

  it.each([0, 1] as const)('Enter on mailbox row %i opens it: connecting, open-mailbox', (row) => {
    const s = act(atHome(MAILBOXES), ...repeat(key('down'), row));
    const out = reduceApp(s, key('enter'));
    expect(out.state.view).toMatchObject({
      kind: 'mailbox',
      mode: 'connecting',
      mailbox: MAILBOXES[row],
      home: home(s),
    });
    expect(out.effects).toEqual([
      { type: 'open-mailbox', generation: s.generation + 1, accountId: MAILBOXES[row]?.id },
    ]);
    expect(out.state.generation).toBe(s.generation + 1);
  });

  it('Enter on "+ Add a mailbox" opens the add screen at its address field', () => {
    const s = act(atHome(MAILBOXES), ...repeat(key('down'), 2));
    const out = reduceApp(s, key('enter'));
    expect(out.effects).toEqual([]);
    expect(out.state).toEqual({ ...s, view: addView(home(s), null) });
  });

  it('Enter on "Logs" opens the logs screen and reads the last 24 hours', () => {
    const s = act(atHome(MAILBOXES), ...repeat(key('down'), 3));
    const out = reduceApp(s, key('enter'));
    expect(out.state).toEqual({
      ...s,
      generation: s.generation + 1,
      view: {
        kind: 'logs',
        home: home(s),
        mode: 'reading',
        window: '24h',
        securityOnly: false,
        warnOnly: false,
        lines: [],
        failure: null,
        scroll: 0,
      },
    });
    expect(out.effects).toEqual([
      {
        type: 'read-logs',
        generation: s.generation + 1,
        window: '24h',
        securityOnly: false,
        warnOnly: false,
      },
    ]);
  });

  it('the next key clears "Added ..."', () => {
    const s = atHome(MAILBOXES);
    const said = { ...s, view: { ...home(s), added: 'new@example-test-domain.eu' } };
    expect(home(said).added).toBe('new@example-test-domain.eu');
    expect(home(act(said, key('down'))).added).toBeNull();
    expect(home(act(said, ch('x'))).added).toBeNull();
    expect(home(act(said, key('other'))).added).toBeNull();
  });

  it('keys that mean nothing on Home change nothing', () => {
    const s = atHome(MAILBOXES);
    for (const action of [
      key('tab'),
      key('clear'),
      key('other'),
      ch('x'),
      ch('f'),
      ch('y'),
      ch('r'),
    ]) {
      const out = reduceApp(s, action);
      expect(out.state).toEqual(s);
      expect(out.effects).toEqual([]);
    }
  });
});

describe('Home: log out, back and quit (AC18, AC20)', () => {
  it('Enter on "Log out": "Signing out...", one sign-out, keys ignored meanwhile', () => {
    const onLogOut = act(atHome(MAILBOXES), ...repeat(key('down'), 4));
    const out = reduceApp(onLogOut, key('enter'));
    expect(out.effects).toEqual([{ type: 'sign-out', generation: onLogOut.generation + 1 }]);
    expect(home(out.state).mode).toBe('signing-out');
    expect(out.state.current).toEqual(ANNA);
    for (const action of [key('enter'), key('escape'), key('up'), ch('q'), ch('r')]) {
      const during = reduceApp(out.state, action);
      expect(during.state).toBe(out.state);
      expect(during.effects).toEqual([]);
    }
  });

  it('signed out: the sign-in list, the address listed but nobody signed in', () => {
    const leaving = act(atHome(MAILBOXES), ...repeat(key('down'), 4), key('enter'));
    const out = reduceApp(leaving, {
      type: 'signed-out',
      generation: leaving.generation,
      remembered: [ANNA.email, BEN],
    });
    expect(out.effects).toEqual([]);
    expect(out.state.current).toBeNull();
    expect(out.state.view).toEqual({
      kind: 'sign-in',
      mode: 'pick',
      cursor: 0,
      form: null,
      message: null,
    });
    expect(knownUsers(out.state)).toEqual([
      { email: ANNA.email, signedIn: false },
      { email: BEN, signedIn: false },
    ]);
  });

  it.each(['escape', 'left', 'backspace'] as const)(
    '%s goes back to the sign-in list without signing out',
    (name) => {
      const s = act(atHome(MAILBOXES), key('down'));
      const out = reduceApp(s, key(name));
      expect(out.effects).toEqual([]);
      expect(out.state.current).toEqual(ANNA);
      expect(out.state.view).toEqual({
        kind: 'sign-in',
        mode: 'pick',
        cursor: 0,
        form: null,
        message: null,
      });
      expect(knownUsers(out.state)[0]).toEqual({ email: ANNA.email, signedIn: true });
    },
  );

  it('going back while the list loads drops the late list', () => {
    const loading = atHome();
    const back = act(loading, key('escape'));
    expect(back.generation).toBe(loading.generation + 1);
    const late = reduceApp(back, {
      type: 'mailboxes',
      generation: loading.generation,
      rows: MAILBOXES,
    });
    expect(late.state).toBe(back);
    // Enter on the signed-in row opens Home again and loads again.
    const again = reduceApp(back, key('enter'));
    expect(again.state.view).toEqual(FRESH_HOME);
    expect(again.effects).toEqual([{ type: 'load-mailboxes', generation: back.generation + 1 }]);
  });

  it('q and Q quit', () => {
    for (const s of [atHome(), atHome(MAILBOXES)]) {
      for (const text of ['q', 'Q']) {
        const out = reduceApp(s, ch(text));
        expect(out.effects).toEqual([{ type: 'quit' }]);
        expect(out.state).toEqual(s);
      }
    }
  });
});

describe('Home: the list could not be loaded (AC19)', () => {
  function failed(): AppState {
    const loading = atHome();
    return act(loading, { type: 'mailboxes-failed', generation: loading.generation });
  }

  it('its message is shown and stays while moving', () => {
    const s = failed();
    expect(home(s)).toEqual({
      kind: 'home',
      mode: 'list',
      mailboxes: null,
      loadFailed: true,
      cursor: 0,
      message: 'load-failed',
      focusId: null,
      added: null,
    });
    for (const action of [key('down'), key('up'), key('other'), ch('x')]) {
      expect(home(act(s, action)).message).toBe('load-failed');
    }
  });

  it('a mailbox can still be added, and the message is back afterwards', () => {
    const adding = act(failed(), key('enter'));
    expect(adding.view.kind).toBe('add');
    expect(home(act(adding, key('escape'))).message).toBe('load-failed');
  });

  it('r loads again', () => {
    const s = failed();
    for (const text of ['r', 'R']) {
      const out = reduceApp(s, ch(text));
      expect(out.effects).toEqual([{ type: 'load-mailboxes', generation: s.generation + 1 }]);
      expect(home(out.state)).toEqual({ ...FRESH_HOME, cursor: home(s).cursor });
    }
  });

  it('the second load answers: the list is shown and r does nothing any more', () => {
    const again = act(failed(), ch('r'));
    const s = act(again, { type: 'mailboxes', generation: again.generation, rows: MAILBOXES });
    expect(home(s).mailboxes).toEqual(MAILBOXES);
    expect(home(s).loadFailed).toBe(false);
    expect(home(s).message).toBeNull();
    expect(reduceApp(s, ch('r')).effects).toEqual([]);
  });

  it('log out, back and quit still work', () => {
    const s = failed();
    expect(reduceApp(s, ch('q')).effects).toEqual([{ type: 'quit' }]);
    expect(act(s, key('escape')).view.kind).toBe('sign-in');
    const out = reduceApp(act(s, key('down'), key('down')), key('enter'));
    expect(out.effects).toEqual([{ type: 'sign-out', generation: s.generation + 1 }]);
  });

  it('the sign-in has ended: back to the sign-in list with its message', () => {
    const loading = atHome();
    const out = reduceApp(loading, {
      type: 'session-ended',
      generation: loading.generation,
      remembered: [ANNA.email, BEN],
    });
    expect(out.effects).toEqual([]);
    expect(out.state.current).toBeNull();
    expect(out.state.remembered).toEqual([ANNA.email, BEN]);
    expect(out.state.view).toEqual({
      kind: 'sign-in',
      mode: 'pick',
      cursor: 0,
      form: null,
      message: 'session-ended',
    });
  });
});

describe('Home: keys while the window is too small (AC22)', () => {
  it('only q quits', () => {
    const moved = act(atHome(MAILBOXES), ...repeat(key('down'), 2));
    // Something a key would clear, were the screen large enough.
    const said = { ...moved, view: { ...home(moved), added: 'new@example-test-domain.eu' } };
    const s = resized(said, TOO_SMALL);
    for (const text of ['q', 'Q']) {
      expect(reduceApp(s, ch(text)).effects).toEqual([{ type: 'quit' }]);
    }
    for (const action of [key('enter'), key('down'), key('escape'), key('left'), ch('r')]) {
      const out = reduceApp(s, action);
      expect(out.state).toBe(s);
      expect(out.effects).toEqual([]);
    }
  });

  it('not even "Log out" acts', () => {
    const s = resized(act(atHome(MAILBOXES), ...repeat(key('down'), 4)), TOO_SMALL);
    const out = reduceApp(s, key('enter'));
    expect(out.state).toBe(s);
    expect(out.effects).toEqual([]);
  });
});

// --- a whole visit --------------------------------------------------------------------------

describe('a visit from start to log out', () => {
  it('every request carries a newer generation, and the password never stays', () => {
    const effects: AppEffect[] = [];
    let state = initialApp('1.2.3', SCREEN);
    const run = (out: { state: AppState; effects: AppEffect[] }): void => {
      state = out.state;
      effects.push(...out.effects);
    };
    const send = (action: AppAction): void => {
      run(reduceApp(state, action));
      if (action.type !== 'key' || state.view.kind !== 'sign-in' || state.view.mode !== 'form') {
        expect(JSON.stringify(state)).not.toContain('CANARY');
      }
    };
    run(startApp(state));
    send({ type: 'session', generation: state.generation, user: ANNA, remembered: [ANNA.email] });
    // Switch user: sign ANNA out, then a wrong and a right password for DANA.
    send(key('down'));
    send(key('enter'));
    send(ch('y'));
    send({ type: 'signed-out', generation: state.generation, remembered: [ANNA.email] });
    for (const c of DANA.email) send(ch(c));
    send(key('enter'));
    for (const c of 'wrong') send(ch(c));
    send(key('enter'));
    send({ type: 'sign-in-failed', generation: state.generation, reason: 'invalid-credentials' });
    for (const c of PASSWORD) send(ch(c));
    send(key('enter'));
    send({
      type: 'signed-in',
      generation: state.generation,
      user: DANA,
      remembered: [DANA.email, ANNA.email],
    });
    send({ type: 'mailboxes', generation: state.generation, rows: [] });
    send(key('down'));
    send(key('down'));
    send(key('enter'));
    send({
      type: 'signed-out',
      generation: state.generation,
      remembered: [DANA.email, ANNA.email],
    });
    send(ch('q'));

    expect(effects.map((e) => e.type)).toEqual([
      'check-session',
      'sign-out',
      'sign-in',
      'sign-in',
      'load-mailboxes',
      'sign-out',
      'quit',
    ]);
    const generations = effects.flatMap((e) => ('generation' in e ? [e.generation] : []));
    expect(generations).toEqual([1, 2, 3, 4, 5, 6]);
    expect(effects[3]).toEqual({
      type: 'sign-in',
      generation: 4,
      email: DANA.email,
      password: PASSWORD,
    });
    expect(state.current).toBeNull();
    expect(knownUsers(state)).toEqual([
      { email: DANA.email, signedIn: false },
      { email: ANNA.email, signedIn: false },
    ]);
  });
});
