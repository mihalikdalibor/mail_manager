import { describe, it, expect } from 'vitest';
import {
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
  AppMessage,
  AppReduced,
  AppState,
  HomeView,
  MailboxRow,
  PendingEffect,
  SignInView,
} from '../../src/cli/app/state.js';
import { reduceApp, startApp } from '../../src/cli/app/reduce.js';
import type { Keypress, Screen } from '../../src/cli/browser/state.js';
import type { AuthUser } from '../../src/core/auth.js';

// M2d-1 app state (spec AC6-AC9, AC11-AC20, AC22, AC24): the pure reducer, driven with actions
// and keys only. Cursor positions are taken from the documented row order, never from internals.

const SCREEN: Screen = { rows: 24, cols: 100 };
const SMALL: Screen = { rows: 5, cols: 30 };
const ALICE: AuthUser = { email: 'alice@example.com', userId: 'user-alice' };
const BOB = 'bob@example.com';
const CAROL = 'carol@example.com';

// --- helpers --------------------------------------------------------------------------------

const ch = (text: string): AppKey => ({ type: 'char', text });
const key = (type: Exclude<AppKey['type'], 'char'>): AppKey => ({ type });
const ENTER = key('enter');
const ESC = key('escape');
const UP = key('up');
const DOWN = key('down');
const TAB = key('tab');
const BACKSPACE = key('backspace');
const CLEAR = key('clear');
const LEFT = key('left');

function row(id: string, email: string, provider = 'websupport'): MailboxRow {
  return { id, email, provider, lastCheckedAt: null };
}

function effectTypes(r: AppReduced): string[] {
  return r.effects.map((e) => e.type);
}

/** Keys applied in order; the final state and every effect that came out on the way. */
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

function typeText(state: AppState, text: string): AppState {
  return press(state, ...[...text].map(ch)).state;
}

function started(screen: Screen = SCREEN): AppState {
  return startApp(initialApp('1.0.0', screen)).state;
}

/** The session check came back: `user` signed in (or nobody) and these remembered addresses. */
function checked(user: AuthUser | null, remembered: readonly string[]): AppState {
  const s = started();
  return act(s, { type: 'session', generation: s.generation, user, remembered }).state;
}

/** The sign-in page at the list, ALICE signed in, remembered [alice, bob, carol]. */
function signedInPick(): AppState {
  return checked(ALICE, [ALICE.email, BOB, CAROL]);
}

/** Nobody signed in, remembered [bob, carol]: rows bob, carol, "Sign in as another user". */
function nobodyPick(): AppState {
  return checked(null, [BOB, CAROL]);
}

/** Nobody signed in, nothing remembered: the form opened directly. */
function emptyForm(): AppState {
  return checked(null, []);
}

function signInView(s: AppState): SignInView {
  if (s.view.kind !== 'sign-in') throw new Error(`expected the sign-in page, got ${s.view.kind}`);
  return s.view;
}

function homeView(s: AppState): HomeView {
  if (s.view.kind !== 'home') throw new Error(`expected Home, got ${s.view.kind}`);
  return s.view;
}

function formOf(s: AppState): NonNullable<SignInView['form']> {
  const form = signInView(s).form;
  if (form === null) throw new Error('expected a form');
  return form;
}

/** Home for ALICE after Enter on the signed-in row; the mailbox list not yet there. */
function homeLoading(): AppState {
  return press(signedInPick(), ENTER).state;
}

/** Home with the given mailbox rows loaded. */
function home(
  rows: readonly MailboxRow[] = [row('m1', 'one@example.com'), row('m2', 'two@example.com')],
): AppState {
  const s = homeLoading();
  return act(s, { type: 'mailboxes', generation: s.generation, rows }).state;
}

/** Walks the cursor down `n` rows with Down. */
function down(s: AppState, n: number): AppState {
  return press(s, ...Array.from({ length: n }, () => DOWN)).state;
}

function lastEffect(r: AppReduced): AppEffect | undefined {
  return r.effects.at(-1);
}

// --- pure helpers ---------------------------------------------------------------------------

describe('appKeyOf', () => {
  const k = (name: string | undefined, extra: Keypress = {}): Keypress => ({
    name,
    sequence: name,
    ...extra,
  });

  it.each<[string, Keypress, AppKey['type']]>([
    ['up', k('up', { sequence: '\x1b[A' }), 'up'],
    ['down', k('down', { sequence: '\x1b[B' }), 'down'],
    ['pageup', k('pageup', { sequence: '\x1b[5~' }), 'pageup'],
    ['pagedown', k('pagedown', { sequence: '\x1b[6~' }), 'pagedown'],
    ['return', k('return', { sequence: '\r' }), 'enter'],
    ['left', k('left', { sequence: '\x1b[D' }), 'left'],
    ['backspace', k('backspace', { sequence: '\x7f' }), 'backspace'],
    ['tab', k('tab', { sequence: '\t' }), 'tab'],
    ['Esc as readline delivers it', k('escape', { meta: true, sequence: '\x1b' }), 'escape'],
    ['Ctrl+U', k('u', { ctrl: true, sequence: '\x15' }), 'clear'],
    ['F5', k('f5', { sequence: '\x1b[15~' }), 'other'],
  ])('%s -> %s', (_label, keypress, type) => {
    expect(appKeyOf(keypress).type).toBe(type);
  });

  it('a letter is a char with that text', () => {
    expect(appKeyOf(k('q'))).toEqual({ type: 'char', text: 'q' });
  });

  it('a shifted letter is the typed capital', () => {
    expect(appKeyOf(k('a', { shift: true, sequence: 'A' }))).toEqual({ type: 'char', text: 'A' });
  });

  it('punctuation without a key name is a char', () => {
    expect(appKeyOf({ sequence: '@' })).toEqual({ type: 'char', text: '@' });
    expect(appKeyOf({ name: undefined, sequence: '.' })).toEqual({ type: 'char', text: '.' });
  });

  it('a space is a char holding a space (passwords may contain it)', () => {
    expect(appKeyOf(k('space', { sequence: ' ' }))).toEqual({ type: 'char', text: ' ' });
  });

  it('a non-ASCII letter is a char', () => {
    expect(appKeyOf({ sequence: '\u00e9' })).toEqual({ type: 'char', text: '\u00e9' });
  });

  it('another Ctrl combination is not typed text', () => {
    expect(appKeyOf(k('a', { ctrl: true, sequence: '\x01' })).type).not.toBe('char');
  });
});

describe('typed / erased', () => {
  it('constants', () => {
    expect(MAX_EMAIL_CHARS).toBe(254);
    expect(MAX_PASSWORD_CHARS).toBe(1024);
  });

  it('typed appends text', () => {
    expect(typed('ab', 'cd', 10)).toBe('abcd');
    expect(typed('', 'x', 10)).toBe('x');
  });

  it('typed appends only the code points that still fit', () => {
    expect(typed('ab', 'cdef', 4)).toBe('abcd');
    expect(typed('abcd', 'e', 4)).toBe('abcd');
    expect(typed('abcd', '', 4)).toBe('abcd');
  });

  it('typed counts code points, not UTF-16 units: an astral character is one', () => {
    const face = '\u{1F600}';
    expect(typed('', face.repeat(3), 2)).toBe(face.repeat(2));
    expect(typed(face, face, 2)).toBe(face + face);
    expect(typed(face + face, face, 2)).toBe(face + face);
  });

  it('typed never splits an astral character', () => {
    const out = typed('a', '\u{1F600}\u{1F600}', 2);
    expect(out).toBe('a\u{1F600}');
  });

  it('erased removes the last code point', () => {
    expect(erased('abc')).toBe('ab');
    expect(erased('a')).toBe('');
  });

  it('erased of an empty value is empty', () => {
    expect(erased('')).toBe('');
  });

  it('erased removes a whole astral character, not half of it', () => {
    expect(erased('a\u{1F600}')).toBe('a');
    expect(erased('\u{1F600}')).toBe('');
  });
});

describe('tooSmall / windowTop', () => {
  it.each<[Screen, boolean]>([
    [{ rows: 8, cols: 40 }, false],
    [{ rows: 24, cols: 100 }, false],
    [{ rows: 7, cols: 40 }, true],
    [{ rows: 8, cols: 39 }, true],
    [{ rows: 1, cols: 1 }, true],
    [{ rows: 0, cols: 0 }, true],
  ])('tooSmall(%o) = %s', (screen, expected) => {
    expect(tooSmall(screen)).toBe(expected);
  });

  it.each<[number, number, number]>([
    [0, 5, 0],
    [4, 5, 0],
    [5, 5, 1],
    [6, 5, 2],
    [9, 5, 5],
    [0, 1, 0],
    [3, 1, 3],
  ])('windowTop(cursor %i, height %i) = %i', (cursor, height, expected) => {
    expect(windowTop(cursor, height)).toBe(expected);
  });
});

describe('initialApp / emit / startApp', () => {
  it('initialApp: the sign-in page while checking, generation 0, nobody known', () => {
    const s = initialApp('1.2.3', SCREEN);
    expect(s.version).toBe('1.2.3');
    expect(s.screen).toEqual(SCREEN);
    expect(s.generation).toBe(0);
    expect(s.current).toBeNull();
    expect(s.remembered).toEqual([]);
    expect(s.view).toEqual({
      kind: 'sign-in',
      mode: 'checking',
      cursor: 0,
      form: null,
      message: null,
    });
  });

  it.each<PendingEffect>([
    { type: 'check-session' },
    { type: 'sign-in', email: 'a@example.com', password: 'pw' },
    { type: 'sign-out' },
    { type: 'load-mailboxes' },
  ])('emit($type): generation + 1 on the state and on the effect', (effect) => {
    const s = { ...initialApp('1.0.0', SCREEN), generation: 3 };
    const r = emit(s, effect);
    expect(r.state.generation).toBe(4);
    expect(r.effects).toEqual([{ ...effect, generation: 4 }]);
    expect(s.generation).toBe(3);
  });

  it('emit leaves the rest of the state alone', () => {
    const s = { ...initialApp('1.0.0', SCREEN), generation: 3 };
    const r = emit(s, { type: 'sign-out' });
    expect({ ...r.state, generation: 3 }).toEqual(s);
  });

  it('startApp: generation 1 and one check-session effect carrying it', () => {
    const r = startApp(initialApp('1.0.0', SCREEN));
    expect(r.state.generation).toBe(1);
    expect(r.effects).toEqual([{ type: 'check-session', generation: 1 }]);
    expect(signInView(r.state).mode).toBe('checking');
  });
});

describe('knownUsers', () => {
  it('nobody signed in: the remembered addresses in order, none signed in', () => {
    expect(knownUsers({ current: null, remembered: [BOB, CAROL] })).toEqual([
      { email: BOB, signedIn: false },
      { email: CAROL, signedIn: false },
    ]);
  });

  it('nobody signed in, nothing remembered: no rows', () => {
    expect(knownUsers({ current: null, remembered: [] })).toEqual([]);
  });

  it('the signed-in user comes first, tagged; the others follow in order', () => {
    expect(knownUsers({ current: ALICE, remembered: [BOB, ALICE.email, CAROL] })).toEqual([
      { email: ALICE.email, signedIn: true },
      { email: BOB, signedIn: false },
      { email: CAROL, signedIn: false },
    ]);
  });

  it('the signed-in user missing from the remembered list is still shown first', () => {
    expect(knownUsers({ current: ALICE, remembered: [BOB] })).toEqual([
      { email: ALICE.email, signedIn: true },
      { email: BOB, signedIn: false },
    ]);
  });

  it('the signed-in address in another letter case is one row, not two', () => {
    const rows = knownUsers({ current: ALICE, remembered: ['ALICE@Example.COM', BOB] });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ signedIn: true });
    expect(rows[0]?.email.toLowerCase()).toBe(ALICE.email);
    expect(rows[1]).toEqual({ email: BOB, signedIn: false });
  });
});

// --- AC6, AC15: the session check -----------------------------------------------------------

describe('AC6 the session check result', () => {
  it('a valid session: the list, the user stored, the remembered list taken over', () => {
    const s = signedInPick();
    const v = signInView(s);
    expect(v.mode).toBe('pick');
    expect(v.cursor).toBe(0);
    expect(v.form).toBeNull();
    expect(s.current).toEqual(ALICE);
    expect(s.remembered).toEqual([ALICE.email, BOB, CAROL]);
    expect(knownUsers(s)[0]).toEqual({ email: ALICE.email, signedIn: true });
  });

  it('nobody signed in but some remembered: the list, not the form', () => {
    const s = nobodyPick();
    expect(signInView(s).mode).toBe('pick');
    expect(s.current).toBeNull();
    expect(knownUsers(s).map((u) => u.email)).toEqual([BOB, CAROL]);
  });

  it('nobody signed in and nothing remembered: the form opens directly, e-mail field active', () => {
    const s = emptyForm();
    expect(signInView(s).mode).toBe('form');
    expect(formOf(s)).toEqual({ email: '', fixedEmail: false, password: '', field: 'email' });
  });

  it('Esc in that form shows the list (one row: "Sign in"); what was typed is dropped', () => {
    const s = press(emptyForm(), ...[...'carol.typed@example.com'].map(ch), ESC).state;
    const v = signInView(s);
    expect(v.mode).toBe('pick');
    expect(v.cursor).toBe(0);
    expect(knownUsers(s)).toEqual([]);
    expect(JSON.stringify(s)).not.toContain('carol.typed');
  });

  it('a result for an older generation changes nothing', () => {
    const s = started();
    const r = act(s, {
      type: 'session',
      generation: s.generation - 1,
      user: ALICE,
      remembered: [ALICE.email],
    });
    expect(r.state).toEqual(s);
    expect(r.effects).toEqual([]);
  });
});

describe('AC15 the session check fails', () => {
  function failed(): AppState {
    const s = started();
    return act(s, { type: 'session-failed', generation: s.generation, remembered: [BOB] }).state;
  }

  it('shows the check-failed mode', () => {
    expect(signInView(failed()).mode).toBe('check-failed');
  });

  it('r checks again: a new generation, mode checking, one check-session effect', () => {
    const before = failed();
    const r = press(before, ch('r'));
    expect(signInView(r.state).mode).toBe('checking');
    expect(r.state.generation).toBeGreaterThan(before.generation);
    expect(r.effects).toEqual([{ type: 'check-session', generation: r.state.generation }]);
  });

  it('q quits', () => {
    const r = press(failed(), ch('q'));
    expect(r.effects).toEqual([{ type: 'quit' }]);
  });

  it('a stale session-failed changes nothing', () => {
    const s = started();
    const r = act(s, { type: 'session-failed', generation: 0, remembered: [] });
    expect(r.state).toEqual(s);
  });

  it('the result of the retry works like the first one', () => {
    const r = press(failed(), ch('r'));
    const g = r.state.generation;
    const s = act(r.state, {
      type: 'session',
      generation: g,
      user: ALICE,
      remembered: [ALICE.email],
    });
    expect(signInView(s.state).mode).toBe('pick');
    expect(s.state.current).toEqual(ALICE);
  });
});

// --- the list on the sign-in page -----------------------------------------------------------

describe('the sign-in list: moving', () => {
  it('Down / Up move the cursor one row', () => {
    const s0 = signedInPick();
    const s1 = press(s0, DOWN).state;
    expect(signInView(s1).cursor).toBe(1);
    const s2 = press(s1, DOWN).state;
    expect(signInView(s2).cursor).toBe(2);
    expect(signInView(press(s2, UP).state).cursor).toBe(1);
  });

  it('the cursor never leaves the rows (3 users + "Sign in as another user" = 4 rows)', () => {
    let s = signedInPick();
    for (let i = 0; i < 12; i++) {
      s = press(s, DOWN).state;
      const c = signInView(s).cursor;
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(3);
    }
    for (let i = 0; i < 12; i++) {
      s = press(s, UP).state;
      const c = signInView(s).cursor;
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(3);
    }
  });
});

describe('AC7 Enter on the signed-in row', () => {
  it('opens Home with no password and no login: a mailbox load, never a sign-in', () => {
    const r = press(signedInPick(), ENTER);
    expect(r.state.view.kind).toBe('home');
    expect(effectTypes(r)).toEqual(['load-mailboxes']);
    expect(r.effects).toEqual([{ type: 'load-mailboxes', generation: r.state.generation }]);
    expect(r.state.current).toEqual(ALICE);
  });

  it('Home starts loading: no mailbox list yet, nothing failed, cursor 0, no message', () => {
    const h = homeView(homeLoading());
    expect(h.mode).toBe('list');
    expect(h.mailboxes).toBeNull();
    expect(h.loadFailed).toBe(false);
    expect(h.cursor).toBe(0);
    expect(h.message).toBeNull();
  });
});

describe('AC8 Enter on a remembered row / the last row (nobody signed in)', () => {
  it('a remembered row opens the form with that e-mail fixed and the password field active', () => {
    const r = press(nobodyPick(), ENTER);
    expect(signInView(r.state).mode).toBe('form');
    expect(formOf(r.state)).toEqual({
      email: BOB,
      fixedEmail: true,
      password: '',
      field: 'password',
    });
    expect(r.effects).toEqual([]);
  });

  it('the second remembered row opens its own address', () => {
    const s = press(nobodyPick(), DOWN, ENTER).state;
    expect(formOf(s)).toMatchObject({ email: CAROL, fixedEmail: true, field: 'password' });
  });

  it('the last row ("Sign in as another user") opens the form with an empty e-mail field active', () => {
    const r = press(nobodyPick(), DOWN, DOWN, ENTER);
    expect(signInView(r.state).mode).toBe('form');
    expect(formOf(r.state)).toEqual({ email: '', fixedEmail: false, password: '', field: 'email' });
    expect(r.effects).toEqual([]);
  });
});

// --- AC9: the form --------------------------------------------------------------------------

describe('AC9 the sign-in form', () => {
  it('typed characters go to the e-mail field first', () => {
    const s = typeText(emptyForm(), 'a@b.co');
    expect(formOf(s)).toMatchObject({ email: 'a@b.co', password: '', field: 'email' });
  });

  it('Enter on the e-mail field moves to the password field', () => {
    const s = press(typeText(emptyForm(), 'a@b.co'), ENTER).state;
    expect(formOf(s)).toMatchObject({ email: 'a@b.co', field: 'password' });
  });

  it('Enter on an empty e-mail field says "Type your e-mail address first." and stays', () => {
    const r = press(emptyForm(), ENTER);
    expect(signInView(r.state).message).toBe<AppMessage>('email-required');
    expect(formOf(r.state).field).toBe('email');
    expect(r.effects).toEqual([]);
  });

  it('typed characters then go to the password field', () => {
    const s = typeText(press(typeText(emptyForm(), 'a@b.co'), ENTER).state, 'secret');
    expect(formOf(s)).toMatchObject({ email: 'a@b.co', password: 'secret', field: 'password' });
  });

  it('Tab, Up and Down switch between the fields', () => {
    const onEmail = typeText(emptyForm(), 'a@b.co');
    for (const k of [TAB, UP, DOWN]) {
      const onPassword = press(onEmail, k).state;
      expect(formOf(onPassword).field).toBe('password');
      expect(formOf(press(onPassword, k).state).field).toBe('email');
    }
  });

  it('with a fixed e-mail, Tab / Up / Down never move into it', () => {
    const fixed = press(nobodyPick(), ENTER).state;
    for (const k of [TAB, UP, DOWN]) {
      expect(formOf(press(fixed, k).state).field).toBe('password');
    }
  });

  it('with a fixed e-mail, typing goes to the password and the e-mail is unchanged', () => {
    const s = typeText(press(nobodyPick(), ENTER).state, 'xyz');
    expect(formOf(s)).toMatchObject({ email: BOB, password: 'xyz' });
  });

  it('the e-mail holds at most 254 code points (one key at a time, and in one chunk)', () => {
    const one = typeText(emptyForm(), 'e'.repeat(300));
    expect([...formOf(one).email]).toHaveLength(MAX_EMAIL_CHARS);
    const chunk = press(emptyForm(), ch('e'.repeat(300))).state;
    expect([...formOf(chunk).email]).toHaveLength(MAX_EMAIL_CHARS);
  });

  it('the password holds at most 1024 code points, counted as code points', () => {
    const onPassword = press(typeText(emptyForm(), 'a@b.co'), ENTER).state;
    const s = typeText(onPassword, '\u{1F600}'.repeat(1100));
    expect([...formOf(s).password]).toHaveLength(MAX_PASSWORD_CHARS);
    expect(formOf(s).password).toBe('\u{1F600}'.repeat(MAX_PASSWORD_CHARS));
  });

  it('Backspace removes the last code point of the active field only', () => {
    const onPassword = typeText(
      press(typeText(emptyForm(), 'ab@c.co'), ENTER).state,
      'pw\u{1F600}',
    );
    const s = press(onPassword, BACKSPACE).state;
    expect(formOf(s)).toMatchObject({ email: 'ab@c.co', password: 'pw' });
    expect(formOf(press(s, BACKSPACE, BACKSPACE, BACKSPACE).state)).toMatchObject({
      email: 'ab@c.co',
      password: '',
    });
  });

  it('Backspace on an empty field does nothing', () => {
    const r = press(emptyForm(), BACKSPACE);
    expect(formOf(r.state)).toEqual({ email: '', fixedEmail: false, password: '', field: 'email' });
    expect(r.effects).toEqual([]);
  });

  it('Ctrl+U empties the active field and leaves the other one', () => {
    const onPassword = typeText(press(typeText(emptyForm(), 'ab@c.co'), ENTER).state, 'secret');
    const s = press(onPassword, CLEAR).state;
    expect(formOf(s)).toMatchObject({ email: 'ab@c.co', password: '', field: 'password' });
    const e = press(typeText(emptyForm(), 'ab@c.co'), CLEAR).state;
    expect(formOf(e)).toMatchObject({ email: '', field: 'email' });
  });

  it('Esc returns to the list and drops what was typed (password included)', () => {
    const s0 = typeText(
      press(typeText(nobodyPickToOther(), 'new.person@example.com'), ENTER).state,
      'PwCanary-Esc',
    );
    const r = press(s0, ESC);
    expect(signInView(r.state).mode).toBe('pick');
    expect(signInView(r.state).form).toBeNull();
    expect(JSON.stringify(r.state)).not.toContain('PwCanary-Esc');
    expect(JSON.stringify(r.state)).not.toContain('new.person');
    expect(r.effects).toEqual([]);
  });

  it('q is a letter: typed into the field, never a quit', () => {
    const r = press(emptyForm(), ch('q'), ch('q'));
    expect(formOf(r.state).email).toBe('qq');
    expect(effectTypes(r)).not.toContain('quit');
    const onPassword = press(emptyForm(), ch('a'), ENTER, ch('q'));
    expect(formOf(onPassword.state).password).toBe('q');
    expect(effectTypes(onPassword)).not.toContain('quit');
  });

  it('Enter on an empty password says "Type your password." and sends nothing', () => {
    const r = press(typeText(emptyForm(), 'a@b.co'), ENTER, ENTER);
    expect(signInView(r.state).message).toBe<AppMessage>('password-required');
    expect(signInView(r.state).mode).toBe('form');
    expect(formOf(r.state).field).toBe('password');
    expect(r.effects).toEqual([]);
  });

  it('Enter on the password field submits: signing in, one sign-in effect with the new generation', () => {
    const before = typeText(press(typeText(emptyForm(), 'a@b.co'), ENTER).state, 'secret');
    const r = press(before, ENTER);
    expect(signInView(r.state).mode).toBe('submitting');
    expect(r.state.generation).toBe(before.generation + 1);
    expect(r.effects).toEqual([
      { type: 'sign-in', generation: r.state.generation, email: 'a@b.co', password: 'secret' },
    ]);
  });

  it('the e-mail is trimmed, the password is sent exactly as typed (spaces kept)', () => {
    const s = typeText(emptyForm(), '  a@b.co  ');
    const r = press(typeText(press(s, ENTER).state, '  pw with spaces  '), ENTER);
    expect(lastEffect(r)).toMatchObject({
      type: 'sign-in',
      email: 'a@b.co',
      password: '  pw with spaces  ',
    });
  });

  it('a fixed e-mail is sent as it is, with the typed password', () => {
    const r = press(typeText(press(nobodyPick(), ENTER).state, 'pw'), ENTER);
    expect(lastEffect(r)).toMatchObject({ type: 'sign-in', email: BOB, password: 'pw' });
  });

  it('AC12 after the submit the password is in no part of the state', () => {
    const PW = 'PwCanary-Submit-93';
    const r = press(typeText(press(typeText(emptyForm(), 'a@b.co'), ENTER).state, PW), ENTER);
    expect(JSON.stringify(r.state)).not.toContain(PW);
    expect(JSON.stringify(r.state)).not.toContain('PwCanary');
  });

  it('keys while signing in do nothing (no second submit)', () => {
    const submitted = press(
      typeText(press(typeText(emptyForm(), 'a@b.co'), ENTER).state, 'pw'),
      ENTER,
    ).state;
    for (const k of [ENTER, ch('x'), DOWN, TAB, BACKSPACE]) {
      const r = press(submitted, k);
      expect(r.effects).toEqual([]);
      expect(signInView(r.state).mode).toBe('submitting');
    }
  });
});

/** Nobody signed in, rows bob / carol: the form of "Sign in as another user". */
function nobodyPickToOther(): AppState {
  return press(nobodyPick(), DOWN, DOWN, ENTER).state;
}

// --- AC11: the sign-in result ---------------------------------------------------------------

describe('AC11 the sign-in result', () => {
  const PW = 'PwCanary-Result-17';

  function submitted(): AppState {
    return press(typeText(press(typeText(emptyForm(), 'user@example.com'), ENTER).state, PW), ENTER)
      .state;
  }

  it.each<['invalid-credentials' | 'unreachable' | 'unknown', AppMessage]>([
    ['invalid-credentials', 'wrong-credentials'],
    ['unreachable', 'unreachable'],
    ['unknown', 'sign-in-failed'],
  ])(
    'failure %s: the form again, e-mail kept, empty active password, message %s',
    (reason, message) => {
      const s = submitted();
      const r = act(s, { type: 'sign-in-failed', generation: s.generation, reason });
      expect(signInView(r.state).mode).toBe('form');
      expect(signInView(r.state).message).toBe(message);
      expect(formOf(r.state).email.trim()).toBe('user@example.com');
      expect(formOf(r.state).password).toBe('');
      expect(formOf(r.state).field).toBe('password');
      expect(r.effects).toEqual([]);
      expect(JSON.stringify(r.state)).not.toContain(PW);
    },
  );

  it('a fixed e-mail comes back as the same address with the password field active', () => {
    const s = press(typeText(press(nobodyPick(), ENTER).state, 'pw'), ENTER).state;
    const r = act(s, {
      type: 'sign-in-failed',
      generation: s.generation,
      reason: 'invalid-credentials',
    });
    expect(formOf(r.state)).toMatchObject({ email: BOB, password: '', field: 'password' });
  });

  it('the form can be submitted again after a failure', () => {
    const s = submitted();
    const failed = act(s, {
      type: 'sign-in-failed',
      generation: s.generation,
      reason: 'unknown',
    }).state;
    const r = press(typeText(failed, 'second'), ENTER);
    expect(lastEffect(r)).toMatchObject({ type: 'sign-in', password: 'second' });
    expect(lastEffect(r)).toMatchObject({ email: 'user@example.com' });
  });

  it('success: Home opens, the user is current, the remembered list is taken over, mailboxes load', () => {
    const s = submitted();
    const r = act(s, {
      type: 'signed-in',
      generation: s.generation,
      user: ALICE,
      remembered: [ALICE.email, BOB],
    });
    expect(r.state.view.kind).toBe('home');
    expect(r.state.current).toEqual(ALICE);
    expect(r.state.remembered).toEqual([ALICE.email, BOB]);
    expect(r.effects).toEqual([{ type: 'load-mailboxes', generation: r.state.generation }]);
    expect(JSON.stringify(r.state)).not.toContain(PW);
  });

  it('a result of an older generation changes nothing (failure and success)', () => {
    const s = submitted();
    const stale = s.generation - 1;
    const failure = act(s, { type: 'sign-in-failed', generation: stale, reason: 'unknown' });
    expect(failure.state).toEqual(s);
    expect(failure.effects).toEqual([]);
    const success = act(s, {
      type: 'signed-in',
      generation: stale,
      user: ALICE,
      remembered: [ALICE.email],
    });
    expect(success.state).toEqual(s);
    expect(success.effects).toEqual([]);
  });
});

// --- AC13: switching user -------------------------------------------------------------------

describe('AC13 switching user while signed in', () => {
  it('Enter on another row asks to sign out first; nothing is sent yet', () => {
    const r = press(signedInPick(), DOWN, ENTER);
    expect(signInView(r.state).mode).toBe('confirm-switch');
    expect(r.effects).toEqual([]);
    expect(r.state.current).toEqual(ALICE);
  });

  it('y signs out: mode signing-out, one sign-out effect with the new generation', () => {
    const asked = press(signedInPick(), DOWN, ENTER).state;
    const r = press(asked, ch('y'));
    expect(signInView(r.state).mode).toBe('signing-out');
    expect(r.state.generation).toBe(asked.generation + 1);
    expect(r.effects).toEqual([{ type: 'sign-out', generation: r.state.generation }]);
  });

  it.each<[string, AppKey]>([
    ['n', ch('n')],
    ['N', ch('N')],
    ['x', ch('x')],
    ['Enter', ENTER],
    ['Esc', ESC],
    ['Down', DOWN],
  ])('%s: back to the list, nothing sent, still signed in', (_label, k) => {
    const asked = press(signedInPick(), DOWN, ENTER).state;
    const r = press(asked, k);
    expect(signInView(r.state).mode).toBe('pick');
    expect(r.effects).toEqual([]);
    expect(r.state.current).toEqual(ALICE);
  });

  function signedOutFor(rowsDown: number): AppState {
    const signingOut = press(
      signedInPick(),
      ...Array.from({ length: rowsDown }, () => DOWN),
      ENTER,
      ch('y'),
    ).state;
    return act(signingOut, {
      type: 'signed-out',
      generation: signingOut.generation,
      remembered: [ALICE.email, BOB, CAROL],
    }).state;
  }

  it('after the sign-out, the form of the chosen remembered row: that e-mail fixed, password active', () => {
    const s = signedOutFor(1);
    expect(s.current).toBeNull();
    expect(signInView(s).mode).toBe('form');
    expect(formOf(s)).toEqual({ email: BOB, fixedEmail: true, password: '', field: 'password' });
  });

  it('the second remembered row is carried through the sign-out too', () => {
    expect(formOf(signedOutFor(2))).toMatchObject({ email: CAROL, fixedEmail: true });
  });

  it('after the sign-out, the last row ("Sign in as another user") gives an empty e-mail field', () => {
    const s = signedOutFor(3);
    expect(formOf(s)).toEqual({ email: '', fixedEmail: false, password: '', field: 'email' });
  });

  it('the old user stays in the list as a remembered row, no longer signed in', () => {
    const s = signedOutFor(1);
    expect(knownUsers(s)).toEqual([
      { email: ALICE.email, signedIn: false },
      { email: BOB, signedIn: false },
      { email: CAROL, signedIn: false },
    ]);
  });

  it('a stale signed-out changes nothing', () => {
    const signingOut = press(signedInPick(), DOWN, ENTER, ch('y')).state;
    const r = act(signingOut, {
      type: 'signed-out',
      generation: signingOut.generation - 1,
      remembered: [],
    });
    expect(r.state).toEqual(signingOut);
    expect(r.effects).toEqual([]);
  });

  it('keys while signing out do nothing', () => {
    const signingOut = press(signedInPick(), DOWN, ENTER, ch('y')).state;
    for (const k of [ENTER, ch('y'), DOWN, ESC]) {
      const r = press(signingOut, k);
      expect(r.effects).toEqual([]);
      expect(signInView(r.state).mode).toBe('signing-out');
    }
  });

  it('the sign-out worked, then the new sign-in fails: nobody is signed in, the old user is a remembered row', () => {
    const form = signedOutFor(1);
    const submit = press(typeText(form, 'wrong'), ENTER);
    expect(lastEffect(submit)).toMatchObject({ type: 'sign-in', email: BOB, password: 'wrong' });
    const failed = act(submit.state, {
      type: 'sign-in-failed',
      generation: submit.state.generation,
      reason: 'invalid-credentials',
    }).state;
    expect(failed.current).toBeNull();
    expect(knownUsers(failed).every((u) => !u.signedIn)).toBe(true);
    expect(knownUsers(failed).map((u) => u.email)).toContain(ALICE.email);
  });
});

// --- AC14: forgetting an address ------------------------------------------------------------

describe('AC14 forgetting an address', () => {
  it('f on a remembered row (nobody signed in) asks to forget it', () => {
    const r = press(nobodyPick(), ch('f'));
    expect(signInView(r.state).mode).toBe('confirm-forget');
    expect(r.effects).toEqual([]);
  });

  it('y forgets that address: one forget effect with the e-mail, nothing else', () => {
    const r = press(nobodyPick(), ch('f'), ch('y'));
    expect(r.effects).toEqual([{ type: 'forget', email: BOB }]);
  });

  it('f on the second row names that row', () => {
    const r = press(nobodyPick(), DOWN, ch('f'), ch('y'));
    expect(r.effects).toEqual([{ type: 'forget', email: CAROL }]);
  });

  it('after y, the list (as the controller reports it) no longer has the address', () => {
    const forgotten = press(nobodyPick(), ch('f'), ch('y')).state;
    const s = act(forgotten, { type: 'remembered', emails: [CAROL] }).state;
    expect(signInView(s).mode).toBe('pick');
    expect(knownUsers(s).map((u) => u.email)).toEqual([CAROL]);
    expect(s.remembered).toEqual([CAROL]);
  });

  it.each<[string, AppKey]>([
    ['n', ch('n')],
    ['x', ch('x')],
    ['Enter', ENTER],
    ['Esc', ESC],
  ])('%s at the question: back to the list, nothing forgotten', (_label, k) => {
    const asked = press(nobodyPick(), ch('f')).state;
    const r = press(asked, k);
    expect(signInView(r.state).mode).toBe('pick');
    expect(r.effects).toEqual([]);
    expect(r.state.remembered).toEqual([BOB, CAROL]);
  });

  it('f on the signed-in row: "Log out first to forget this address." and nothing else', () => {
    const r = press(signedInPick(), ch('f'));
    expect(signInView(r.state).mode).toBe('pick');
    expect(signInView(r.state).message).toBe<AppMessage>('forget-signed-in');
    expect(r.effects).toEqual([]);
    expect(r.state.remembered).toEqual([ALICE.email, BOB, CAROL]);
  });

  it('f on the last row does nothing at all', () => {
    const s = down(nobodyPick(), 2);
    const r = press(s, ch('f'));
    expect(r.state).toEqual(s);
    expect(r.effects).toEqual([]);
  });

  it('a remembered action replaces the remembered list', () => {
    const s = act(nobodyPick(), {
      type: 'remembered',
      emails: [CAROL, BOB, 'dave@example.com'],
    }).state;
    expect(s.remembered).toEqual([CAROL, BOB, 'dave@example.com']);
  });
});

// --- AC16-AC20: Home ------------------------------------------------------------------------

describe('AC16 Home: the list arrives', () => {
  it('the rows are kept, the load is not failed', () => {
    const rows = [row('m1', 'one@example.com'), row('m2', 'two@example.com')];
    const h = homeView(home(rows));
    expect(h.mailboxes).toEqual(rows);
    expect(h.loadFailed).toBe(false);
    expect(h.mode).toBe('list');
  });

  it('no mailboxes: an empty list, the cursor on "+ Add a mailbox" (row 0)', () => {
    const h = homeView(home([]));
    expect(h.mailboxes).toEqual([]);
    expect(h.cursor).toBe(0);
  });

  it('a result of an older generation changes nothing', () => {
    const s = homeLoading();
    const r = act(s, {
      type: 'mailboxes',
      generation: s.generation - 1,
      rows: [row('m1', 'one@example.com')],
    });
    expect(r.state).toEqual(s);
    expect(r.effects).toEqual([]);
  });
});

describe('AC17 Home: Enter on a mailbox / Add / Logs', () => {
  it.each<[string, number, string]>([
    ['a mailbox row', 0, 'm1'],
    ['the second mailbox row', 1, 'm2'],
  ])('%s -> its mailbox screen, connecting, one open-mailbox effect', (_label, downs, id) => {
    const s = down(home(), downs);
    const r = press(s, ENTER);
    expect(r.state.view).toMatchObject({ kind: 'mailbox', mode: 'connecting', home: s.view });
    expect(r.effects).toEqual([
      { type: 'open-mailbox', generation: r.state.generation, accountId: id },
    ]);
  });

  it('+ Add a mailbox -> the add screen at its address field, nothing else changes', () => {
    const s = down(home(), 2);
    const r = press(s, ENTER);
    expect(r.effects).toEqual([]);
    expect(r.state.view).toMatchObject({ kind: 'add', step: 'address', home: s.view });
    expect({ ...r.state, view: s.view }).toEqual(s);
  });

  it('Logs -> the logs screen, reading the last 24 hours, one read-logs effect', () => {
    const s = down(home(), 3);
    const r = press(s, ENTER);
    expect(r.state.view).toMatchObject({
      kind: 'logs',
      mode: 'reading',
      window: '24h',
      home: s.view,
    });
    expect(r.effects).toEqual([
      {
        type: 'read-logs',
        generation: r.state.generation,
        window: '24h',
        securityOnly: false,
        warnOnly: false,
      },
    ]);
  });

  it('with no mailboxes, Enter on the first row is "+ Add a mailbox"', () => {
    const r = press(home([]), ENTER);
    expect(r.state.view.kind).toBe('add');
    expect(r.effects).toEqual([]);
  });

  it('with no mailboxes, the next rows are Logs and Log out', () => {
    expect(press(home([]), DOWN, ENTER).state.view.kind).toBe('logs');
    const out = press(home([]), DOWN, DOWN, ENTER);
    expect(homeView(out.state).mode).toBe('signing-out');
  });
});

describe('AC18 Home: Log out', () => {
  function signingOut(): AppReduced {
    return press(home(), DOWN, DOWN, DOWN, DOWN, ENTER);
  }

  it('Enter on Log out: signing out, one sign-out effect', () => {
    const before = home();
    const r = signingOut();
    expect(homeView(r.state).mode).toBe('signing-out');
    expect(r.effects).toEqual([{ type: 'sign-out', generation: r.state.generation }]);
    expect(r.state.generation).toBe(before.generation + 1);
  });

  it('keys while signing out do nothing', () => {
    const s = signingOut().state;
    for (const k of [ENTER, DOWN, ESC, ch('q')]) {
      const r = press(s, k);
      expect(r.effects).toEqual([]);
      expect(homeView(r.state).mode).toBe('signing-out');
    }
  });

  it('signed-out: the sign-in list, the e-mail still listed but no longer signed in', () => {
    const s = signingOut().state;
    const r = act(s, {
      type: 'signed-out',
      generation: s.generation,
      remembered: [ALICE.email, BOB],
    });
    expect(r.state.current).toBeNull();
    expect(signInView(r.state).mode).toBe('pick');
    expect(knownUsers(r.state)).toEqual([
      { email: ALICE.email, signedIn: false },
      { email: BOB, signedIn: false },
    ]);
    expect(r.effects).toEqual([]);
  });

  it('a stale signed-out changes nothing', () => {
    const s = signingOut().state;
    const r = act(s, { type: 'signed-out', generation: s.generation - 1, remembered: [] });
    expect(r.state).toEqual(s);
  });
});

describe('AC19 Home: the list fails to load', () => {
  it('mailboxes-failed: the load failed, nothing else changes', () => {
    const s = homeLoading();
    const r = act(s, { type: 'mailboxes-failed', generation: s.generation });
    expect(homeView(r.state).loadFailed).toBe(true);
    expect(homeView(r.state).mailboxes).toBeNull();
    expect(r.effects).toEqual([]);
    expect(r.state.current).toEqual(ALICE);
  });

  it('r loads again: a new load-mailboxes, no longer failed', () => {
    const s = homeLoading();
    const failed = act(s, { type: 'mailboxes-failed', generation: s.generation }).state;
    const r = press(failed, ch('r'));
    expect(homeView(r.state).loadFailed).toBe(false);
    expect(r.state.generation).toBeGreaterThan(failed.generation);
    expect(r.effects).toEqual([{ type: 'load-mailboxes', generation: r.state.generation }]);
  });

  it('a stale mailboxes-failed changes nothing', () => {
    const s = homeLoading();
    const r = act(s, { type: 'mailboxes-failed', generation: s.generation - 1 });
    expect(r.state).toEqual(s);
  });

  it('session-ended: back on the sign-in list, nobody signed in, "Your sign-in has ended" message', () => {
    const s = homeLoading();
    const r = act(s, {
      type: 'session-ended',
      generation: s.generation,
      remembered: [ALICE.email, BOB],
    });
    expect(r.state.current).toBeNull();
    expect(signInView(r.state).mode).toBe('pick');
    expect(signInView(r.state).message).toBe<AppMessage>('session-ended');
    expect(knownUsers(r.state).every((u) => !u.signedIn)).toBe(true);
    expect(r.state.remembered).toEqual([ALICE.email, BOB]);
  });

  it('a stale session-ended changes nothing', () => {
    const s = homeLoading();
    const r = act(s, { type: 'session-ended', generation: s.generation - 1, remembered: [] });
    expect(r.state).toEqual(s);
  });
});

describe('AC20 Home: leaving', () => {
  it.each<[string, AppKey]>([
    ['Esc', ESC],
    ['Left', LEFT],
    ['Backspace', BACKSPACE],
  ])('%s: the sign-in list, still signed in, no sign-out', (_label, k) => {
    const r = press(home(), k);
    expect(signInView(r.state).mode).toBe('pick');
    expect(r.state.current).toEqual(ALICE);
    expect(knownUsers(r.state)[0]).toEqual({ email: ALICE.email, signedIn: true });
    expect(effectTypes(r)).not.toContain('sign-out');
    expect(r.effects).toEqual([]);
  });

  it('q quits', () => {
    expect(press(home(), ch('q')).effects).toEqual([{ type: 'quit' }]);
    expect(press(homeLoading(), ch('q')).effects).toEqual([{ type: 'quit' }]);
  });

  it('Esc while the mailboxes are loading: the late result is dropped (generation)', () => {
    const loading = homeLoading();
    const left = press(loading, ESC).state;
    const late = act(left, {
      type: 'mailboxes',
      generation: loading.generation,
      rows: [row('m1', 'one@example.com')],
    });
    expect(late.state).toEqual(left);
    expect(late.effects).toEqual([]);
    expect(late.state.view.kind).toBe('sign-in');
  });

  it('a late failure after Esc is dropped too', () => {
    const loading = homeLoading();
    const left = press(loading, ESC).state;
    const late = act(left, { type: 'mailboxes-failed', generation: loading.generation });
    expect(late.state).toEqual(left);
  });
});

describe('Home: moving', () => {
  it('Down / Up move over the mailboxes and the three actions, within the rows', () => {
    // 2 mailboxes + Add, Logs, Log out = 5 rows
    let s = home();
    for (let i = 0; i < 10; i++) {
      s = press(s, DOWN).state;
      expect(homeView(s).cursor).toBeLessThanOrEqual(4);
    }
    expect(homeView(s).cursor).toBe(4);
    s = press(s, UP).state;
    expect(homeView(s).cursor).toBe(3);
    for (let i = 0; i < 10; i++) {
      s = press(s, UP).state;
      expect(homeView(s).cursor).toBeGreaterThanOrEqual(0);
    }
    expect(homeView(s).cursor).toBe(0);
  });
});

// --- AC22: the frame, the resize, a window that is too small --------------------------------

describe('AC22 resize and a window that is too small', () => {
  it('a resize stores the new screen', () => {
    const r = act(signedInPick(), { type: 'resize', screen: { rows: 30, cols: 120 } });
    expect(r.state.screen).toEqual({ rows: 30, cols: 120 });
    expect(r.effects).toEqual([]);
    expect(signInView(r.state).mode).toBe('pick');
  });

  it('nothing can be typed into a form while too small; it is all there again afterwards', () => {
    const form = typeText(emptyForm(), 'ab');
    const small = act(form, { type: 'resize', screen: SMALL }).state;
    const r = press(small, ch('x'), BACKSPACE, TAB, ENTER, CLEAR);
    expect(r.effects).toEqual([]);
    expect(formOf(r.state)).toEqual(formOf(form));
    expect(signInView(r.state).mode).toBe('form');
    const back = act(r.state, { type: 'resize', screen: SCREEN }).state;
    expect(formOf(typeText(back, 'c')).email).toBe('abc');
  });

  it('q in a form is not a quit when too small either', () => {
    const small = act(emptyForm(), { type: 'resize', screen: SMALL }).state;
    const r = press(small, ch('q'));
    expect(r.effects).toEqual([]);
    expect(formOf(r.state).email).toBe('');
  });

  it('q quits from the list while too small', () => {
    const small = act(signedInPick(), { type: 'resize', screen: SMALL }).state;
    expect(press(small, ch('q')).effects).toEqual([{ type: 'quit' }]);
  });

  it('q quits from Home while too small', () => {
    const small = act(home(), { type: 'resize', screen: SMALL }).state;
    expect(press(small, ch('q')).effects).toEqual([{ type: 'quit' }]);
  });

  it('Enter, Down and f do nothing on the list while too small', () => {
    const small = act(signedInPick(), { type: 'resize', screen: SMALL }).state;
    const r = press(small, ENTER, DOWN, ch('f'), ESC);
    expect(r.effects).toEqual([]);
    expect(r.state).toEqual(small);
  });

  it('Enter and Log out do nothing on Home while too small', () => {
    const small = act(home(), { type: 'resize', screen: SMALL }).state;
    const r = press(small, DOWN, DOWN, DOWN, DOWN, ENTER, ESC);
    expect(r.effects).toEqual([]);
    expect(r.state).toEqual(small);
  });

  it('a pending y/N question can still be answered while too small', () => {
    const asked = press(signedInPick(), DOWN, ENTER).state;
    const small = act(asked, { type: 'resize', screen: SMALL }).state;
    expect(signInView(small).mode).toBe('confirm-switch');
    const r = press(small, ch('y'));
    expect(signInView(r.state).mode).toBe('signing-out');
    expect(r.effects).toEqual([{ type: 'sign-out', generation: r.state.generation }]);
  });

  it('a pending forget question can be declined while too small', () => {
    const asked = press(nobodyPick(), ch('f')).state;
    const small = act(asked, { type: 'resize', screen: SMALL }).state;
    const r = press(small, ch('n'));
    expect(signInView(r.state).mode).toBe('pick');
    expect(r.effects).toEqual([]);
  });

  it('a pending forget question can be confirmed while too small', () => {
    const asked = press(nobodyPick(), ch('f')).state;
    const small = act(asked, { type: 'resize', screen: SMALL }).state;
    expect(press(small, ch('y')).effects).toEqual([{ type: 'forget', email: BOB }]);
  });
});

// --- AC24: superseded results ---------------------------------------------------------------

describe('AC24 results of superseded requests', () => {
  it('each generation-carrying result is dropped when its generation is not the current one', () => {
    const s = home([row('m1', 'one@example.com')]);
    const g = s.generation;
    const stale: AppAction[] = [
      { type: 'session', generation: g - 1, user: null, remembered: [] },
      { type: 'session-failed', generation: g - 1, remembered: [] },
      { type: 'signed-in', generation: g - 1, user: ALICE, remembered: [] },
      { type: 'sign-in-failed', generation: g - 1, reason: 'unknown' },
      { type: 'signed-out', generation: g - 1, remembered: [] },
      { type: 'mailboxes', generation: g - 1, rows: [] },
      { type: 'mailboxes-failed', generation: g - 1 },
      { type: 'session-ended', generation: g - 1, remembered: [] },
    ];
    for (const action of stale) {
      const r = act(s, action);
      expect(r.state, action.type).toEqual(s);
      expect(r.effects, action.type).toEqual([]);
    }
  });

  it('a key that starts a request makes the earlier generation stale', () => {
    const loading = homeLoading();
    const retried = press(
      act(loading, { type: 'mailboxes-failed', generation: loading.generation }).state,
      ch('r'),
    ).state;
    const late = act(retried, {
      type: 'mailboxes',
      generation: loading.generation,
      rows: [row('x', 'x@example.com')],
    });
    expect(late.state).toEqual(retried);
    expect(homeView(late.state).mailboxes).toBeNull();
  });
});
