import { describe, it, expect } from 'vitest';
import { messageText, renderApp } from '../../src/cli/app/render.js';
import { reduceApp, startApp } from '../../src/cli/app/reduce.js';
import { initialApp } from '../../src/cli/app/state.js';
import type {
  AppAction,
  AppKey,
  AppMessage,
  AppState,
  MailboxRow,
} from '../../src/cli/app/state.js';
import type { Rendered } from '../../src/cli/browser/render.js';
import type { Screen } from '../../src/cli/browser/state.js';
import { displayWidth } from '../../src/cli/browser/width.js';
import type { AuthUser } from '../../src/core/auth.js';

// M2d-1 app renderer (spec AC10, AC16, AC22, AC23 and the texts quoted in the criteria). States are
// built through the reducer; assertions are on the drawn lines and on `cursorLine`.

const SCREEN: Screen = { rows: 24, cols: 100 };
const ALICE: AuthUser = { email: 'alice@example.com', userId: 'user-alice' };
const BOB = 'bob@example.com';
const CAROL = 'carol@example.com';
const NOTHING_SHOWN = '(nothing is shown while you type)';

const ch = (text: string): AppKey => ({ type: 'char', text });
const key = (type: Exclude<AppKey['type'], 'char'>): AppKey => ({ type });
const ENTER = key('enter');
const ESC = key('escape');
const DOWN = key('down');

// --- helpers --------------------------------------------------------------------------------

function press(state: AppState, ...keys: AppKey[]): AppState {
  let s = state;
  for (const k of keys) s = reduceApp(s, { type: 'key', key: k }).state;
  return s;
}

function act(state: AppState, action: AppAction): AppState {
  return reduceApp(state, action).state;
}

function typeText(state: AppState, text: string): AppState {
  return press(state, ...[...text].map(ch));
}

function started(screen: Screen = SCREEN): AppState {
  return startApp(initialApp('1.0.0', screen)).state;
}

function checked(user: AuthUser | null, remembered: readonly string[], screen = SCREEN): AppState {
  const s = started(screen);
  return act(s, { type: 'session', generation: s.generation, user, remembered });
}

const signedInPick = (): AppState => checked(ALICE, [ALICE.email, BOB, CAROL]);
const nobodyPick = (): AppState => checked(null, [BOB, CAROL]);
const emptyForm = (): AppState => checked(null, []);

function row(
  id: string,
  email: string,
  provider = 'websupport',
  lastCheckedAt: Date | null = null,
): MailboxRow {
  return { id, email, provider, lastCheckedAt };
}

function homeLoading(user: AuthUser = ALICE, screen: Screen = SCREEN): AppState {
  return press(checked(user, [user.email], screen), ENTER);
}

function home(
  rows: readonly MailboxRow[],
  user: AuthUser = ALICE,
  screen: Screen = SCREEN,
): AppState {
  const s = homeLoading(user, screen);
  return act(s, { type: 'mailboxes', generation: s.generation, rows });
}

function resized(s: AppState, screen: Screen): AppState {
  return act(s, { type: 'resize', screen });
}

function text(r: Rendered): string {
  return r.lines.join('\n');
}

function lineWith(r: Rendered, needle: string): string {
  const line = r.lines.find((l) => l.includes(needle));
  if (line === undefined) throw new Error(`no line with "${needle}" in:\n${text(r)}`);
  return line;
}

function indexOfLine(r: Rendered, needle: string): number {
  const i = r.lines.findIndex((l) => l.includes(needle));
  if (i < 0) throw new Error(`no line with "${needle}" in:\n${text(r)}`);
  return i;
}

function cursorRow(r: Rendered): string {
  if (r.cursorLine === null) throw new Error(`no cursor line in:\n${text(r)}`);
  return r.lines[r.cursorLine] ?? '';
}

function checkFrame(r: Rendered, screen: Screen): void {
  expect(r.lines).toHaveLength(screen.rows);
  for (const line of r.lines) expect(displayWidth(line)).toBe(screen.cols);
}

const render = (s: AppState): Rendered => renderApp(s);

// --- the texts the criteria quote -----------------------------------------------------------

describe('messageText', () => {
  it.each<[AppMessage, string]>([
    ['wrong-credentials', 'Wrong e-mail or password - try again.'],
    ['unreachable', "Can't reach Mail Manager - check your internet connection and try again."],
    ['sign-in-failed', "Signing in didn't work - try again later."],
    ['email-required', 'Type your e-mail address first.'],
    ['password-required', 'Type your password.'],
    ['forget-signed-in', 'Log out first to forget this address.'],
    ['session-ended', 'Your sign-in has ended - sign in again.'],
    [
      'load-failed',
      "Couldn't load your mailboxes - check your internet connection (r = try again).",
    ],
  ])('%s', (message, expected) => {
    expect(messageText(message)).toBe(expected);
  });

  it('every message is plain ASCII', () => {
    const all: AppMessage[] = [
      'wrong-credentials',
      'unreachable',
      'sign-in-failed',
      'email-required',
      'password-required',
      'forget-signed-in',
      'session-ended',
      'load-failed',
    ];
    for (const m of all) expect(messageText(m)).toMatch(/^[\x20-\x7e]+$/);
  });
});

// --- AC6: the sign-in page ------------------------------------------------------------------

describe('AC6 the sign-in page', () => {
  it('while the session is checked: "Checking your sign-in..."', () => {
    expect(text(render(started()))).toContain('Checking your sign-in...');
  });

  it('check failed: the unreachable text and "r try again  q quit"', () => {
    const s = started();
    const failed = act(s, { type: 'session-failed', generation: s.generation, remembered: [] });
    const out = render(failed);
    expect(text(out)).toContain(messageText('unreachable'));
    expect(text(out)).toContain('r try again  q quit');
  });

  it('signed in: first row the user tagged "signed in", then the remembered, last "Sign in as another user"', () => {
    const out = render(signedInPick());
    const a = indexOfLine(out, ALICE.email);
    const b = indexOfLine(out, BOB);
    const c = indexOfLine(out, CAROL);
    const last = indexOfLine(out, 'Sign in as another user');
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
    expect(c).toBeLessThan(last);
    expect(out.lines[a]).toContain('signed in');
    expect(out.lines[b]).not.toContain('signed in');
    expect(out.lines[c]).not.toContain('signed in');
    expect(out.lines[last]).not.toContain('signed in');
  });

  it('nobody signed in: remembered rows then "Sign in as another user", nothing tagged', () => {
    const out = render(nobodyPick());
    expect(indexOfLine(out, BOB)).toBeLessThan(indexOfLine(out, CAROL));
    expect(indexOfLine(out, CAROL)).toBeLessThan(indexOfLine(out, 'Sign in as another user'));
    expect(text(out)).not.toContain('signed in');
  });

  it('the signed-in address in another letter case is one row, not two', () => {
    const s = checked(ALICE, ['ALICE@Example.COM', BOB]);
    const out = render(s);
    const rows = out.lines.filter((l) => l.toLowerCase().includes(ALICE.email));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('signed in');
  });

  it('the cursor row follows the cursor: signed-in user, then the next rows', () => {
    const s0 = signedInPick();
    expect(cursorRow(render(s0))).toContain(ALICE.email);
    const s1 = press(s0, DOWN);
    expect(cursorRow(render(s1))).toContain(BOB);
    const s3 = press(s1, DOWN, DOWN);
    expect(cursorRow(render(s3))).toContain('Sign in as another user');
  });

  it('nothing signed in and nothing remembered: Esc from the form shows the single row "Sign in"', () => {
    const out = render(press(emptyForm(), ESC));
    expect(text(out)).not.toContain('Sign in as another user');
    expect(cursorRow(out)).toContain('Sign in');
    expect(cursorRow(out)).not.toContain('another');
  });

  it('a user without an e-mail is shown as "(no e-mail)"', () => {
    const s = checked({ email: '', userId: 'user-x' }, []);
    expect(text(render(s))).toContain('(no e-mail)');
  });

  it('a message is shown on the list (forget on the signed-in row)', () => {
    const out = render(press(signedInPick(), ch('f')));
    expect(text(out)).toContain(messageText('forget-signed-in'));
  });

  it('the question to sign out first: "Sign out <e-mail> first? (y/N)"', () => {
    const out = render(press(signedInPick(), DOWN, ENTER));
    expect(text(out)).toContain(`Sign out ${ALICE.email} first? (y/N)`);
  });

  it('the question to forget: "Forget <e-mail>? (y/N)"', () => {
    const out = render(press(nobodyPick(), ch('f')));
    expect(text(out)).toContain(`Forget ${BOB}? (y/N)`);
  });

  it('while signing out for a switch the screen says so', () => {
    const out = render(press(signedInPick(), DOWN, ENTER, ch('y')));
    expect(text(out)).toContain('Signing out...');
  });

  it('while signing in the screen says "Signing in..."', () => {
    const s = press(typeText(press(typeText(emptyForm(), 'a@b.co'), ENTER), 'pw'), ENTER);
    expect(text(render(s))).toContain('Signing in...');
  });

  it('the form: the typed e-mail is shown; a fixed e-mail is shown too', () => {
    expect(text(render(typeText(emptyForm(), 'typed.person@example.com')))).toContain(
      'typed.person@example.com',
    );
    expect(text(render(press(nobodyPick(), ENTER)))).toContain(BOB);
  });

  it('the form messages are shown (empty e-mail, empty password, wrong password)', () => {
    expect(text(render(press(emptyForm(), ENTER)))).toContain(messageText('email-required'));
    const atPassword = press(typeText(emptyForm(), 'a@b.co'), ENTER);
    expect(text(render(press(atPassword, ENTER)))).toContain(messageText('password-required'));
    const submitted = press(typeText(atPassword, 'pw'), ENTER);
    const failed = act(submitted, {
      type: 'sign-in-failed',
      generation: submitted.generation,
      reason: 'invalid-credentials',
    });
    expect(text(render(failed))).toContain(messageText('wrong-credentials'));
  });

  it('a very long e-mail in the form keeps its END visible', () => {
    const long = `${'long-local-part-'.repeat(10)}@example.com`;
    const s = typeText(emptyForm(), long);
    const out = renderApp(resized(s, { rows: 10, cols: 50 }));
    const line = lineWith(out, '@example.com');
    expect(displayWidth(line)).toBe(50);
  });

  it('a very long e-mail in a list is cut with "..."', () => {
    const long = `${'x'.repeat(80)}@example.com`;
    const s = checked(null, [long, BOB], { rows: 10, cols: 50 });
    const out = renderApp(s);
    checkFrame(out, { rows: 10, cols: 50 });
    const line = lineWith(out, 'xxxxxxxx');
    expect(line).toContain('...');
    expect(line).not.toContain('@example.com');
  });
});

// --- AC10: the password never shows ---------------------------------------------------------

describe('AC10 the password is never drawn', () => {
  // Upper-case letters, digits and symbols that no fixed UI text (words, 0.9.0, 40x8, (y/N)) has.
  const PW = 'QWZ7#JX!9~^QZ';

  function atPassword(): AppState {
    return press(typeText(emptyForm(), 'user@example.com'), ENTER);
  }

  it('no frame, while typing it character by character, contains it or any 3-character part of it', () => {
    let s = atPassword();
    // Precondition: the canary does not collide with any fixed text on screen.
    const before = text(render(s));
    for (let i = 0; i + 3 <= PW.length; i++) {
      expect(before).not.toContain(PW.slice(i, i + 3));
    }
    for (const c of PW) {
      s = press(s, ch(c));
      const all = text(render(s));
      expect(all).not.toContain(PW);
      for (let i = 0; i + 3 <= PW.length; i++) {
        expect(all).not.toContain(PW.slice(i, i + 3));
      }
    }
  });

  it('the password line always shows "(nothing is shown while you type)"', () => {
    expect(text(render(atPassword()))).toContain(NOTHING_SHOWN);
    expect(text(render(typeText(atPassword(), PW)))).toContain(NOTHING_SHOWN);
    // E-mail field active (password may be filled), and a fixed e-mail.
    const back = press(typeText(atPassword(), 'abc'), key('up'));
    expect(text(render(back))).toContain(NOTHING_SHOWN);
    expect(text(render(typeText(press(nobodyPick(), ENTER), 'abc')))).toContain(NOTHING_SHOWN);
    expect(text(render(emptyForm()))).toContain(NOTHING_SHOWN);
  });

  it('nothing in the frame depends on the length of the password (0, 1, 5, 40 characters)', () => {
    const frames = [0, 1, 5, 40].map((n) => render(typeText(atPassword(), 'p'.repeat(n))));
    for (const f of frames) expect(f).toEqual(frames[0]);
  });

  it('nor on its content', () => {
    const a = render(typeText(atPassword(), 'aaaaaaaa'));
    const b = render(typeText(atPassword(), 'QWZ7#JX!'));
    expect(a).toEqual(b);
  });

  it('a fixed-e-mail form shows no length either', () => {
    const base = press(nobodyPick(), ENTER);
    expect(render(typeText(base, 'x'))).toEqual(render(typeText(base, 'x'.repeat(30))));
  });

  it('after a failed sign-in the frame still holds no part of the password', () => {
    const submitted = press(typeText(atPassword(), PW), ENTER);
    const all = text(render(submitted));
    expect(all).not.toContain(PW);
    const failed = act(submitted, {
      type: 'sign-in-failed',
      generation: submitted.generation,
      reason: 'unknown',
    });
    const after = text(render(failed));
    expect(after).not.toContain('QWZ');
    expect(after).not.toContain('~^Q');
  });
});

// --- AC16: Home -----------------------------------------------------------------------------

describe('AC16 Home', () => {
  const checkedAt = new Date(2026, 8, 30, 14, 5);

  it('the header shows "Mail Manager - <e-mail>" and the number of mailboxes', () => {
    const out = render(
      home([
        row('m1', 'one@example.com'),
        row('m2', 'two@example.com'),
        row('m3', 'three@example.com'),
      ]),
    );
    expect(out.lines[0]).toContain(`Mail Manager - ${ALICE.email}`);
    expect(out.lines[0]).toMatch(/\b3\b/);
  });

  it('"Loading your mailboxes..." until the list arrives, then no longer', () => {
    const loading = render(homeLoading());
    expect(text(loading)).toContain('Loading your mailboxes...');
    expect(loading.lines[0]).toContain(`Mail Manager - ${ALICE.email}`);
    const loaded = render(home([row('m1', 'one@example.com')]));
    expect(text(loaded)).not.toContain('Loading your mailboxes...');
  });

  it('one row per mailbox (e-mail, provider name, checked date), then + Add a mailbox, Logs, Log out', () => {
    const out = render(
      home([
        row('m1', 'one@example.com', 'websupport', checkedAt),
        row('m2', 'two@example.com', 'websupport', null),
      ]),
    );
    const one = lineWith(out, 'one@example.com');
    expect(one).toMatch(/websupport/i);
    expect(one).toContain('checked 2026-09-30 14:05');
    const two = lineWith(out, 'two@example.com');
    expect(two).toMatch(/websupport/i);
    expect(two).toContain('checked never');
    const add = indexOfLine(out, '+ Add a mailbox');
    const logs = out.lines.findIndex((l, i) => i > add && l.includes('Logs'));
    const logOut = out.lines.findIndex((l, i) => i > add && l.includes('Log out'));
    expect(indexOfLine(out, 'one@example.com')).toBeLessThan(indexOfLine(out, 'two@example.com'));
    expect(indexOfLine(out, 'two@example.com')).toBeLessThan(add);
    expect(logs).toBeGreaterThan(add);
    expect(logOut).toBeGreaterThan(logs);
  });

  it('the cursor starts on the first mailbox', () => {
    expect(
      cursorRow(render(home([row('m1', 'one@example.com'), row('m2', 'two@example.com')]))),
    ).toContain('one@example.com');
  });

  it('formatChecked, when given, formats the checked cell of every row', () => {
    const s = home([
      row('m1', 'one@example.com', 'websupport', checkedAt),
      row('m2', 'two@example.com'),
    ]);
    const seen: (Date | null)[] = [];
    const out = renderApp(s, {
      formatChecked: (d) => {
        seen.push(d);
        return d === null ? 'MARK-NULL' : 'MARK-DATE';
      },
    });
    expect(lineWith(out, 'one@example.com')).toContain('MARK-DATE');
    expect(lineWith(out, 'two@example.com')).toContain('MARK-NULL');
    expect(seen).toHaveLength(2);
    expect(seen.some((d) => d !== null && d.getTime() === checkedAt.getTime())).toBe(true);
  });

  it('no mailboxes: "No mailboxes yet - add your first one." and the cursor on "+ Add a mailbox"', () => {
    const out = render(home([]));
    expect(text(out)).toContain('No mailboxes yet - add your first one.');
    expect(cursorRow(out)).toContain('+ Add a mailbox');
    expect(text(out)).toContain('Log out');
  });

  it('with mailboxes the "No mailboxes yet" line is not shown', () => {
    expect(text(render(home([row('m1', 'one@example.com')])))).not.toContain('No mailboxes yet');
  });

  it('Enter on "+ Add a mailbox" draws the add screen, not a message', () => {
    const s = press(home([row('m1', 'one@example.com')]), DOWN, ENTER);
    expect(text(render(s))).toContain('Mail Manager - Add a mailbox');
  });

  it('a failed load: "Couldn\'t load your mailboxes - check your internet connection (r = try again)."', () => {
    const s = homeLoading();
    const failed = act(s, { type: 'mailboxes-failed', generation: s.generation });
    const out = render(failed);
    expect(text(out)).toContain(messageText('load-failed'));
    expect(text(out)).not.toContain('Loading your mailboxes...');
  });

  it('signing out: "Signing out..."', () => {
    const s = press(home([]), DOWN, DOWN, ENTER);
    expect(text(render(s))).toContain('Signing out...');
  });

  it('Home of a user without an e-mail: "(no e-mail)" in the header', () => {
    const out = render(home([], { email: '', userId: 'user-x' }));
    expect(out.lines[0]).toContain('(no e-mail)');
  });

  describe('at 40x8', () => {
    const NARROW: Screen = { rows: 8, cols: 40 };
    const EMAIL24 = 'abcdefghijkl@example.com';

    it('the e-mail is 24 columns, the rows are exactly 40 columns', () => {
      expect(EMAIL24).toHaveLength(24);
    });

    it('a mailbox row still shows its e-mail (24 columns) uncut; "checked ..." is dropped', () => {
      const out = render(home([row('m1', EMAIL24, 'websupport', checkedAt)], ALICE, NARROW));
      checkFrame(out, NARROW);
      const line = lineWith(out, EMAIL24);
      expect(line).not.toContain('checked');
    });

    it.each([40, 41, 45, 50, 55, 60, 70, 80, 100])(
      'at %i columns: the e-mail is whole, and "checked" only ever appears together with the provider',
      (cols) => {
        const screen = { rows: 8, cols };
        const out = render(home([row('m1', EMAIL24, 'websupport', checkedAt)], ALICE, screen));
        checkFrame(out, screen);
        const line = lineWith(out, EMAIL24);
        if (line.includes('checked')) expect(line).toMatch(/websupport/i);
      },
    );

    it('with "checked never" the same order holds', () => {
      for (const cols of [40, 50, 60, 70]) {
        const screen = { rows: 8, cols };
        const out = render(home([row('m1', EMAIL24, 'websupport', null)], ALICE, screen));
        const line = lineWith(out, EMAIL24);
        if (line.includes('checked')) expect(line).toMatch(/websupport/i);
      }
    });

    it('wide enough, all three cells show', () => {
      const wide = { rows: 8, cols: 100 };
      const line = lineWith(
        render(home([row('m1', EMAIL24, 'websupport', checkedAt)], ALICE, wide)),
        EMAIL24,
      );
      expect(line).toMatch(/websupport/i);
      expect(line).toContain('checked 2026-09-30 14:05');
    });
  });
});

// --- AC22: the frame ------------------------------------------------------------------------

describe('AC22 every frame has exactly rows lines of exactly cols columns', () => {
  const SIZES: Screen[] = [
    { rows: 8, cols: 40 },
    { rows: 9, cols: 41 },
    { rows: 10, cols: 60 },
    { rows: 24, cols: 100 },
    { rows: 40, cols: 200 },
    { rows: 7, cols: 40 },
    { rows: 8, cols: 39 },
    { rows: 5, cols: 30 },
    { rows: 3, cols: 21 },
    { rows: 1, cols: 21 },
    { rows: 8, cols: 10 },
  ];

  function catalog(): [string, AppState][] {
    const submitted = press(
      typeText(press(typeText(emptyForm(), 'user@example.com'), ENTER), 'pw'),
      ENTER,
    );
    const gen = (s: AppState): number => s.generation;
    const sample = [
      row('m1', 'one@example.com', 'websupport', new Date(2026, 0, 2, 3, 4)),
      row('m2', 'two@example.com', 'websupport', null),
      row('m3', 'a-rather-long-address-for-a-narrow-window@example.com', 'websupport', null),
    ];
    const loading = homeLoading();
    return [
      ['checking', started()],
      [
        'check failed',
        act(started(), { type: 'session-failed', generation: gen(started()), remembered: [] }),
      ],
      ['pick signed in', signedInPick()],
      ['pick nobody', nobodyPick()],
      ['pick single Sign in', press(emptyForm(), ESC)],
      ['form empty', emptyForm()],
      ['form typed', typeText(emptyForm(), 'someone@example.com')],
      ['form fixed', press(nobodyPick(), ENTER)],
      ['form message', press(emptyForm(), ENTER)],
      ['submitting', submitted],
      ['confirm switch', press(signedInPick(), DOWN, ENTER)],
      ['signing out (switch)', press(signedInPick(), DOWN, ENTER, ch('y'))],
      ['confirm forget', press(nobodyPick(), ch('f'))],
      ['home loading', loading],
      ['home failed', act(loading, { type: 'mailboxes-failed', generation: gen(loading) })],
      ['home list', home(sample)],
      ['home empty', home([])],
      ['home message', press(home(sample), ENTER)],
      ['home signing out', press(home([]), DOWN, DOWN, ENTER)],
    ];
  }

  it.each(SIZES.map((s) => [`${String(s.rows)}x${String(s.cols)}`, s] as const))(
    '%s: every state of the app',
    (_name, screen) => {
      for (const [name, state] of catalog()) {
        const out = renderApp(resized(state, screen));
        expect(out.lines, name).toHaveLength(screen.rows);
        for (const line of out.lines) {
          expect(displayWidth(line), `${name}: "${line}"`).toBe(screen.cols);
        }
      }
    },
  );

  it('states built at the size itself (not resized) are exact too', () => {
    for (const screen of [SIZES[0], SIZES[3]]) {
      if (screen === undefined) continue;
      checkFrame(renderApp(checked(ALICE, [ALICE.email, BOB], screen)), screen);
      checkFrame(renderApp(started(screen)), screen);
    }
  });

  it('the cursor line, when there is one, is inside the frame', () => {
    for (const screen of SIZES) {
      for (const [name, state] of catalog()) {
        const out = renderApp(resized(state, screen));
        if (out.cursorLine !== null) {
          expect(out.cursorLine, name).toBeGreaterThanOrEqual(0);
          expect(out.cursorLine, name).toBeLessThan(screen.rows);
        }
      }
    }
  });

  it('a long list: the window follows the cursor (10 remembered users at 8 rows)', () => {
    const many = Array.from({ length: 10 }, (_, i) => `user${String(i + 1)}@example.com`);
    const screen = { rows: 8, cols: 40 };
    let s = checked(null, many, screen);
    for (let i = 0; i < 9; i++) s = press(s, DOWN);
    const out = renderApp(s);
    checkFrame(out, screen);
    expect(cursorRow(out)).toContain('user10@example.com');
    expect(text(out)).not.toContain('user1@example.com');
    // Down onto the last row ("Sign in as another user") follows too.
    const last = renderApp(press(s, DOWN));
    expect(cursorRow(last)).toContain('Sign in as another user');
  });

  it('a long Home list: the window follows the cursor', () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      row(`m${String(i)}`, `box${String(i + 1)}@example.com`),
    );
    const screen = { rows: 8, cols: 40 };
    let s = home(rows, ALICE, screen);
    for (let i = 0; i < 11; i++) s = press(s, DOWN);
    const out = renderApp(s);
    checkFrame(out, screen);
    expect(cursorRow(out)).toContain('box12@example.com');
    expect(text(out)).not.toContain('box1@example.com');
  });
});

describe('AC22 a window below 40x8', () => {
  it.each<[Screen]>([
    [{ rows: 7, cols: 40 }],
    [{ rows: 8, cols: 39 }],
    [{ rows: 24, cols: 20 }],
    [{ rows: 3, cols: 100 }],
  ])('%o: only "Window too small" (or the short form), nothing of the app', (screen) => {
    const out = renderApp(resized(signedInPick(), screen));
    checkFrame(out, screen);
    expect(out.cursorLine).toBeNull();
    const body = text(out);
    expect(body).toMatch(/too small/i);
    expect(body).not.toContain(ALICE.email);
    expect(body).not.toContain('Sign in as another user');
  });

  it('39 columns: the long text "Window too small - need at least 40x8"', () => {
    const out = renderApp(resized(signedInPick(), { rows: 8, cols: 39 }));
    expect(text(out)).toContain('Window too small - need at least 40x8');
  });

  it('30 columns: the short text "Too small - need 40x8"', () => {
    const out = renderApp(resized(signedInPick(), { rows: 8, cols: 30 }));
    expect(text(out)).toContain('Too small - need 40x8');
    expect(text(out)).not.toContain('Window');
  });

  it('a pending sign-out question stays visible: "Sign out <e-mail> first? (y/N)"', () => {
    const user: AuthUser = { email: 'a@b.co', userId: 'u1' };
    const s = press(checked(user, ['a@b.co', 'c@d.co']), DOWN, ENTER);
    const out = renderApp(resized(s, { rows: 7, cols: 39 }));
    checkFrame(out, { rows: 7, cols: 39 });
    expect(text(out)).toContain('Window too small - need at least 40x8');
    expect(text(out)).toContain('Sign out a@b.co first? (y/N)');
  });

  it('a pending forget question stays visible: "Forget <e-mail>? (y/N)"', () => {
    const s = press(checked(null, ['a@b.co']), ch('f'));
    const out = renderApp(resized(s, { rows: 7, cols: 39 }));
    expect(text(out)).toContain('Forget a@b.co? (y/N)');
  });

  it('no question pending: no question text', () => {
    const out = renderApp(resized(signedInPick(), { rows: 7, cols: 39 }));
    expect(text(out)).not.toContain('(y/N)');
  });

  it('above the minimum again the normal frame is back', () => {
    const small = resized(signedInPick(), { rows: 5, cols: 30 });
    const back = resized(small, SCREEN);
    expect(text(renderApp(back))).toContain(ALICE.email);
    expect(text(renderApp(back))).not.toMatch(/too small/i);
  });

  it('a form is not drawn while too small: no typed text on screen', () => {
    const s = typeText(emptyForm(), 'visible.when.large@example.com');
    const out = renderApp(resized(s, { rows: 5, cols: 30 }));
    expect(text(out)).not.toContain('visible.when');
  });
});

// --- AC23: outside strings go through sanitize ----------------------------------------------

describe('AC23 strings from outside are sanitized; the fixed text is ASCII', () => {
  const HOSTILE = [
    '\u0007',
    '\u001b',
    '\u0085',
    '\u009b',
    '\u200b',
    '\u200e',
    '\u202e',
    '\u2066',
    '\u2028',
    '\ufeff',
  ];
  const dirty = (name: string): string => `${name}\u202e\u0007\u001b[31m\u200b@example.com`;

  function expectClean(out: Rendered): void {
    const all = text(out);
    for (const h of HOSTILE)
      expect(all.includes(h), `U+${h.codePointAt(0)?.toString(16) ?? ''}`).toBe(false);
  }

  it('remembered e-mails from users.json (control and bidi characters) in the list', () => {
    const s = checked(null, [dirty('evil'), BOB]);
    const out = render(s);
    expectClean(out);
    expect(text(out)).toContain('evil');
    expect(text(out)).toContain(BOB);
  });

  it('the signed-in e-mail from Supabase in the list and in the Home header', () => {
    const user: AuthUser = { email: dirty('mallory'), userId: 'u-m' };
    const pick = render(checked(user, [user.email]));
    expectClean(pick);
    expect(text(pick)).toContain('mallory');
    const h = render(home([], user));
    expectClean(h);
    expect(h.lines[0]).toContain('mallory');
  });

  it('mailbox e-mails and provider ids in the Home rows', () => {
    const out = render(
      home([
        row('m1', dirty('boxowner'), `ev\u202eil\u0007-id`, new Date(2026, 0, 2, 3, 4)),
        row('m2', 'two@example.com', 'prov\u001bider'),
      ]),
    );
    expectClean(out);
    expect(text(out)).toContain('boxowner');
  });

  it('the typed e-mail in the form', () => {
    const s = typeText(emptyForm(), 'typed\u202e\u0007\u200b@example.com');
    const out = render(s);
    expectClean(out);
    expect(text(out)).toContain('typed');
  });

  it('the fixed e-mail of a remembered row in the form and in the questions', () => {
    const s = checked(null, [dirty('fixed')]);
    expectClean(render(press(s, ENTER)));
    expectClean(render(press(s, ch('f'))));
    const user: AuthUser = { email: dirty('current'), userId: 'u-c' };
    expectClean(render(press(checked(user, [user.email, dirty('other')]), DOWN, ENTER)));
  });

  it('while too small, with a question pending', () => {
    const user: AuthUser = { email: dirty('tiny'), userId: 'u-t' };
    const s = press(checked(user, [user.email, dirty('other')]), DOWN, ENTER);
    expectClean(renderApp(resized(s, { rows: 5, cols: 30 })));
  });

  it('with plain ASCII data every line of every state is plain ASCII (fixed UI text)', () => {
    const states: AppState[] = [
      started(),
      signedInPick(),
      nobodyPick(),
      press(emptyForm(), ESC),
      emptyForm(),
      press(emptyForm(), ENTER),
      press(nobodyPick(), ENTER),
      press(signedInPick(), DOWN, ENTER),
      press(nobodyPick(), ch('f')),
      press(signedInPick(), ch('f')),
      homeLoading(),
      home([]),
      home([
        row('m1', 'one@example.com', 'websupport', new Date(2026, 0, 2, 3, 4)),
        row('m2', 'two@example.com'),
      ]),
      press(home([row('m1', 'one@example.com')]), ENTER),
    ];
    for (const s of states) {
      for (const line of render(s).lines) expect(line).toMatch(/^[\x20-\x7e]*$/);
    }
  });
});
