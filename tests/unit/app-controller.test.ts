import { describe, it, expect, vi } from 'vitest';
import { createApp } from '../../src/cli/app/controller.js';
import type { App, AppDeps, AppResult } from '../../src/cli/app/controller.js';
import type { Rendered } from '../../src/cli/browser/render.js';
import type { Keypress, Screen } from '../../src/cli/browser/state.js';
import type { Terminal } from '../../src/cli/browser/terminal.js';
import { AuthError } from '../../src/core/auth.js';
import type { AuthUser, LogoutResult } from '../../src/core/auth.js';
import { AccountError } from '../../src/core/accounts.js';
import { RepoError } from '../../src/core/db/repos.js';
import type { MailAccount } from '../../src/core/db/repos.js';
import { MemoryEventLog } from '../../src/core/log/index.js';
import type { LogRecord } from '../../src/core/log/index.js';
import { MemoryRememberedUsers } from '../../src/core/remembered-users.js';
import type { RememberedUsers } from '../../src/core/remembered-users.js';
import { authEmailTarget } from '../../src/core/security/events.js';

// M2d-1 app controller: keys -> reducer -> effects, driven with a fake Terminal (records the
// frames, exposes the key/resize handlers), a fake AuthService and mailbox list, the in-memory
// remembered users and an in-memory log. No Mail Manager server, no real terminal.

// --- fixtures -------------------------------------------------------------------------------

const ANNA: AuthUser = {
  email: 'anna@example-test-domain.eu',
  userId: '11111111-1111-4111-8111-111111111111',
};
const DANA: AuthUser = {
  email: 'dana@example-test-domain.eu',
  userId: '22222222-2222-4222-8222-222222222222',
};
const BEN = 'ben@example-test-domain.eu';
const CYRIL = 'cyril@example-test-domain.eu';
/** Typed into the form: in no log line, and as a password in no frame and no state. */
const TYPED_EMAIL = 'typed.canary@example-test-domain.eu';
const PASSWORD = ' Zx9#Qw7$Lk2!vJ5^ ';
const HOST = 'imap.canary-host.example-test-domain.eu';
const USERNAME = 'canary-username';
const CIPHERTEXT = 'CANARY-CIPHERTEXT';
const SCREEN: Screen = { rows: 24, cols: 100 };
const T0 = Date.UTC(2026, 9, 4, 9, 0, 0);
const TARGET_KEY = Buffer.alloc(32, 9);

const NOTHING_SHOWN = '(nothing is shown while you type)';
const ANOTHER_USER = 'Sign in as another user';

function account(id: string, email: string, over: Partial<MailAccount> = {}): MailAccount {
  return {
    id,
    userId: ANNA.userId,
    label: null,
    email,
    provider: 'websupport',
    host: HOST,
    port: 993,
    username: USERNAME,
    authType: 'password',
    secret: { ciphertext: CIPHERTEXT, iv: 'CANARY-IV', tag: 'CANARY-TAG', keyVersion: 1 },
    capabilities: null,
    createdAt: new Date(T0),
    updatedAt: new Date(T0),
    lastCheckedAt: null,
    ...over,
  };
}

const BOX_1 = account('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'one@example-test-domain.eu', {
  lastCheckedAt: new Date(T0),
});
const BOX_2 = account('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'two@example-test-domain.eu');

const k = (name: string, extra: Keypress = {}): Keypress => ({ name, sequence: name, ...extra });
const ENTER = k('return', { sequence: '\r' });
const DOWN = k('down', { sequence: '\u001b[B' });
const CTRL_C = k('c', { ctrl: true, sequence: '\u0003' });
// How readline delivers a lone Esc.
const ESC = k('escape', { meta: true, sequence: '\u001b' });
// Ctrl+C within readline's escape timeout after Esc: one keypress, no name, both bytes.
const ESC_CTRL_C: Keypress = {
  sequence: '\u001b\u0003',
  ctrl: false,
  meta: true,
  shift: false,
};
// The same after two quick Escs.
const ESC_ESC_CTRL_C: Keypress = { ...ESC_CTRL_C, sequence: '\u001b\u001b\u0003' };
const ch = (text: string): Keypress => ({ name: text.toLowerCase(), sequence: text });

// --- fakes ----------------------------------------------------------------------------------

interface FakeTerminal extends Terminal {
  readonly frames: Rendered[];
  /** onKey / onResize / draw / clear, in order. */
  readonly events: string[];
  screen: Screen;
  failDraw: Error | null;
  key(key: Keypress): void;
  resize(): void;
  registered(): boolean;
}

function fakeTerminal(screen: Screen = SCREEN): FakeTerminal {
  let keyHandler: ((key: Keypress) => void) | null = null;
  let resizeHandler: (() => void) | null = null;
  const t: FakeTerminal = {
    frames: [],
    events: [],
    screen,
    failDraw: null,
    size: () => t.screen,
    draw: (frame) => {
      if (t.failDraw !== null) throw t.failDraw;
      t.events.push('draw');
      t.frames.push(frame);
    },
    clear: () => {
      t.events.push('clear');
    },
    onKey: (fn) => {
      t.events.push('onKey');
      keyHandler = fn;
    },
    onResize: (fn) => {
      t.events.push('onResize');
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
    registered: () => keyHandler !== null && resizeHandler !== null,
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

/** The logs screen has its own tests: here the log folder is always empty. */
const NO_LOGS: AppDeps['readLogs'] = () =>
  Promise.resolve({
    folder: 'missing',
    records: [],
    runs: new Map(),
    interrupted: [],
    unreadable: 0,
    unknown: 0,
    omitted: 0,
    skippedFiles: 0,
    runsCapped: false,
  });

/** The add screen has its own tests: here nothing is looked up, checked or added. */
const NO_ADD: Pick<AppDeps, 'discover' | 'assertNotSaved' | 'addMailbox'> = {
  discover: () => Promise.reject(new Error('no lookup in these tests')),
  assertNotSaved: () => Promise.reject(new Error('no duplicate check in these tests')),
  addMailbox: () => Promise.reject(new Error('no mailbox is added in these tests')),
};

/** Lets every pending microtask and the I/O queue run. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * The mailbox screen has its own tests (app-mailbox-controller.test.ts). Here a mailbox that is
 * opened stays on "Connecting..." for two turns of the event loop and then turns out to be
 * gone: long enough for a test to see it and leave, and nothing is in flight when it quits.
 */
function mailboxGoneSoon(): Promise<MailAccount> {
  return new Promise<MailAccount>((_resolve, reject) => {
    setImmediate(() => {
      setImmediate(() => {
        reject(new AccountError('not-found'));
      });
    });
  });
}

async function stillRunning(p: Promise<unknown>): Promise<boolean> {
  return Promise.race([p.then(() => false), settle().then(() => true)]);
}

interface Options {
  /** Who `currentUser()` reports; default ANNA. */
  user?: AuthUser | null;
  /** `currentUser()` itself, instead of `user`. */
  currentUser?: () => Promise<AuthUser | null>;
  remembered?: readonly string[];
  mailboxes?: readonly MailAccount[];
  store?: RememberedUsers;
  /** The terminal refuses to draw from the first frame on. */
  failDraw?: Error;
}

interface Parts {
  t: FakeTerminal;
  deps: AppDeps;
  auth: {
    currentUser: ReturnType<typeof vi.fn<() => Promise<AuthUser | null>>>;
    login: ReturnType<typeof vi.fn<(email: string, password: string) => Promise<AuthUser>>>;
    logout: ReturnType<typeof vi.fn<() => Promise<LogoutResult>>>;
  };
  listMailboxes: ReturnType<typeof vi.fn<() => Promise<readonly MailAccount[]>>>;
  remembered: RememberedUsers;
  log: MemoryEventLog;
  loginTarget: ReturnType<typeof vi.fn<(email: string) => string>>;
  onUnexpected: ReturnType<typeof vi.fn<(err: unknown) => void>>;
}

interface Harness extends Parts {
  app: App;
  done: Promise<AppResult>;
}

/** Everything createApp needs, nothing started yet. */
function makeParts(o: Options = {}): Parts {
  const t = fakeTerminal();
  if (o.failDraw !== undefined) t.failDraw = o.failDraw;
  const user = o.user === undefined ? ANNA : o.user;
  const auth: Parts['auth'] = {
    currentUser: vi.fn<() => Promise<AuthUser | null>>(
      o.currentUser ?? (() => Promise.resolve(user)),
    ),
    login: vi.fn<(email: string, password: string) => Promise<AuthUser>>(() =>
      Promise.resolve(DANA),
    ),
    logout: vi.fn<() => Promise<LogoutResult>>(() => Promise.resolve('logged-out')),
  };
  const listMailboxes = vi.fn<() => Promise<readonly MailAccount[]>>(() =>
    Promise.resolve(o.mailboxes ?? [BOX_1, BOX_2]),
  );
  const remembered = o.store ?? new MemoryRememberedUsers(o.remembered ?? []);
  const log = new MemoryEventLog({
    run: '0123456789abcdef',
    ver: '0.9.0',
    now: () => T0,
    level: 'debug',
  });
  const loginTarget = vi.fn<(email: string) => string>((email) =>
    authEmailTarget(TARGET_KEY, email),
  );
  const onUnexpected = vi.fn<(err: unknown) => void>();
  const deps: AppDeps = {
    terminal: t,
    version: '0.9.0',
    auth,
    listMailboxes,
    remembered,
    log,
    loginTarget,
    onUnexpected,
    findAccount: mailboxGoneSoon,
    openSession: () => Promise.reject(new Error('no mailbox login in these tests')),
    readLogs: NO_LOGS,
    ...NO_ADD,
  };
  return { t, deps, auth, listMailboxes, remembered, log, loginTarget, onUnexpected };
}

/** The app, running. */
function makeHarness(o: Options = {}): Harness {
  const parts = makeParts(o);
  const app = createApp(parts.deps);
  return { ...parts, app, done: app.run() };
}

function text(frame: Rendered | undefined): string {
  return (frame?.lines ?? []).join('\n');
}

const last = (h: Harness): string => text(h.t.frames.at(-1));

async function press(h: Harness, ...keys: Keypress[]): Promise<void> {
  for (const key of keys) {
    h.t.key(key);
    await settle();
  }
}

async function typeText(h: Harness, value: string): Promise<void> {
  await press(h, ...[...value].map(ch));
}

async function ready(h: Harness, needle: string): Promise<void> {
  await vi.waitFor(() => {
    expect(last(h)).toContain(needle);
  });
}

/** The session check answered: the list is up (ANNA signed in unless told otherwise). */
async function atList(o: Options = {}): Promise<Harness> {
  const h = makeHarness(o);
  await ready(h, ANOTHER_USER);
  return h;
}

/** Nobody signed in, nothing remembered: the form is up. */
async function atForm(o: Options = {}): Promise<Harness> {
  const h = makeHarness({ user: null, remembered: [], ...o });
  await ready(h, NOTHING_SHOWN);
  return h;
}

/** `email` typed, Enter: the password field is active. */
async function atPassword(email = TYPED_EMAIL, o: Options = {}): Promise<Harness> {
  const h = await atForm(o);
  await typeText(h, email);
  await press(h, ENTER);
  return h;
}

/** ANNA on Home with her two mailboxes listed. */
async function atHome(o: Options = {}): Promise<Harness> {
  const h = await atList(o);
  await press(h, ENTER);
  await ready(h, o.mailboxes === undefined ? BOX_1.email : '+ Add a mailbox');
  return h;
}

async function quit(h: Harness): Promise<void> {
  h.t.key(CTRL_C);
  await h.done.catch(() => undefined);
  await h.app.settled();
}

function events(h: Harness, name: string): LogRecord[] {
  return h.log.records.filter((r) => r.event === name);
}

function eventNames(h: Harness): string[] {
  return h.log.records.map((r) => r.event);
}

function expectNothingPrivateLogged(h: Harness): void {
  for (const line of h.log.lines) {
    for (const secret of [
      TYPED_EMAIL,
      'typed.canary',
      PASSWORD.trim(),
      ANNA.email,
      DANA.email,
      BEN,
    ]) {
      expect(line).not.toContain(secret);
    }
    expect(line).not.toContain('example-test-domain');
  }
}

// --- start ----------------------------------------------------------------------------------

describe('start', () => {
  it('createApp registers and draws nothing; run() registers both handlers, then draws', async () => {
    const pending = deferred<AuthUser | null>();
    const { t, deps, auth } = makeParts({ currentUser: () => pending.promise });
    const app = createApp(deps);
    expect(t.events).toEqual([]);
    expect(t.registered()).toBe(false);
    expect(auth.currentUser).not.toHaveBeenCalled();
    expect(app.state.view).toMatchObject({ kind: 'sign-in', mode: 'checking' });
    expect(app.state.screen).toEqual(SCREEN);

    const done = app.run();
    // Synchronously: both handlers registered before the first frame, then the session check.
    expect(t.events).toEqual(['onKey', 'onResize', 'draw']);
    expect(text(t.frames[0])).toContain('Checking your sign-in...');
    await settle();
    expect(auth.currentUser).toHaveBeenCalledTimes(1);
    expect(app.state.generation).toBe(1);
    // A second run() is the same run.
    expect(app.run()).toBe(done);
    expect(t.events).toEqual(['onKey', 'onResize', 'draw']);
    t.key(CTRL_C);
    await expect(done).resolves.toEqual({ end: 'interrupt' });
  });
});

// --- the session check ----------------------------------------------------------------------

describe('check-session (AC6, AC15)', () => {
  it('a signed-in user: the list with that user tagged, and remembered from now on', async () => {
    const h = await atList({ remembered: [BEN] });
    expect(last(h)).toContain(ANNA.email);
    expect(last(h)).toContain('signed in');
    expect(last(h)).toContain(BEN);
    expect(h.app.state.current).toEqual(ANNA);
    // Added at the check, so a user who signed in with `mm login` is listed after Log out.
    expect(h.remembered.list()).toEqual([ANNA.email, BEN]);
    expect(h.app.state.remembered).toEqual([ANNA.email, BEN]);
    expect(h.auth.login).not.toHaveBeenCalled();
    expect(h.log.records).toEqual([]);
    await quit(h);
  });

  it('a user without an e-mail is shown as (no e-mail) and not remembered', async () => {
    const h = await atList({ user: { email: '', userId: ANNA.userId }, remembered: [BEN] });
    expect(last(h)).toContain('(no e-mail)');
    expect(h.remembered.list()).toEqual([BEN]);
    await quit(h);
  });

  it('nobody signed in: the remembered addresses, nobody tagged, nothing added', async () => {
    const h = await atList({ user: null, remembered: [BEN, CYRIL] });
    expect(last(h)).not.toContain('signed in');
    expect(h.remembered.list()).toEqual([BEN, CYRIL]);
    expect(h.app.state.current).toBeNull();
    await quit(h);
  });

  it('nobody signed in and nothing remembered: the form', async () => {
    const h = await atForm();
    expect(last(h)).toContain('E-mail:');
    expect(h.app.state.view).toMatchObject({ kind: 'sign-in', mode: 'form' });
    await quit(h);
  });

  it('Mail Manager unreachable: its message; r checks again', async () => {
    const currentUser = vi
      .fn<() => Promise<AuthUser | null>>()
      .mockRejectedValueOnce(new AuthError('unreachable', 'offline'))
      .mockResolvedValue(ANNA);
    const h = makeHarness({ currentUser, remembered: [BEN] });
    await ready(h, "Can't reach Mail Manager - check your internet connection and try again.");
    expect(last(h)).toContain('r try again  q quit');
    expect(last(h)).toContain(BEN);
    expect(last(h)).not.toContain('offline');
    expect(h.remembered.list()).toEqual([BEN]);
    h.t.key(ch('r'));
    expect(last(h)).toContain('Checking your sign-in...');
    await ready(h, 'signed in');
    expect(currentUser).toHaveBeenCalledTimes(2);
    expect(h.remembered.list()).toEqual([ANNA.email, BEN]);
    expect(h.log.records).toEqual([]);
    h.t.key(ch('q'));
    await expect(h.done).resolves.toEqual({ end: 'quit' });
  });

  it.each([
    ['another auth error', new AuthError('unknown', 'boom')],
    ['an unexpected error', new TypeError('boom')],
  ])('%s ends the app with that error (AC25)', async (_label, err) => {
    const h = makeHarness({ currentUser: () => Promise.reject(err) });
    await expect(h.done).rejects.toBe(err);
    await expect(h.app.settled()).resolves.toBeUndefined();
    expect(h.remembered.list()).toEqual([]);
  });

  it('a check that throws at once is the same as one that rejects', async () => {
    const err = new Error('no client');
    const h = makeHarness({
      currentUser: () => {
        throw err;
      },
    });
    await expect(h.done).rejects.toBe(err);
  });
});

// --- sign-in --------------------------------------------------------------------------------

describe('sign-in (AC11, AC12)', () => {
  it('success: one login call, auth.login with the user id only, remembered, Home', async () => {
    const h = await atPassword(`  ${TYPED_EMAIL} `);
    await typeText(h, PASSWORD);
    await press(h, ENTER);
    await ready(h, BOX_1.email);
    // The e-mail trimmed, the password exactly as typed.
    expect(h.auth.login.mock.calls).toEqual([[TYPED_EMAIL, PASSWORD]]);
    expect(h.log.records).toHaveLength(1);
    expect(events(h, 'auth.login')[0]).toMatchObject({ event: 'auth.login', user: DANA.userId });
    expect(h.remembered.list()).toEqual([DANA.email]);
    expect(h.app.state.current).toEqual(DANA);
    expect(last(h)).toContain(`Mail Manager - ${DANA.email}`);
    expect(h.listMailboxes).toHaveBeenCalledTimes(1);
    expect(h.loginTarget).not.toHaveBeenCalled();
    expectNothingPrivateLogged(h);
    await quit(h);
  });

  it('"Signing in..." is shown while the call runs', async () => {
    const pending = deferred<AuthUser>();
    const h = await atPassword();
    h.auth.login.mockReturnValue(pending.promise);
    await typeText(h, PASSWORD);
    await press(h, ENTER);
    expect(last(h)).toContain('Signing in...');
    expect(h.log.records).toEqual([]);
    pending.resolve(DANA);
    await ready(h, 'Mail Manager - ');
    await quit(h);
  });

  it.each([
    ['invalid_credentials', 'invalid-credentials', 'Wrong e-mail or password - try again.'],
    [
      'unreachable',
      'unreachable',
      "Can't reach Mail Manager - check your internet connection and try again.",
    ],
    ['unknown', 'unknown', "Signing in didn't work - try again later."],
  ] as const)(
    'failure (%s): auth.login-failed, the message, nothing remembered',
    async (code, reason, message) => {
      const h = await atPassword();
      h.auth.login.mockRejectedValue(new AuthError(code, 'server said no'));
      await typeText(h, PASSWORD);
      await press(h, ENTER);
      await ready(h, message);
      expect(eventNames(h)).toEqual(['auth.login-failed']);
      expect(events(h, 'auth.login-failed')[0]).toMatchObject({
        reason,
        target: authEmailTarget(TARGET_KEY, TYPED_EMAIL),
      });
      expect(h.loginTarget.mock.calls).toEqual([[TYPED_EMAIL]]);
      expect(h.remembered.list()).toEqual([]);
      expect(h.app.state.current).toBeNull();
      // The form again: the e-mail kept, the password field active and empty.
      expect(last(h)).toContain(`E-mail:    ${TYPED_EMAIL}`);
      expect(h.app.state.view).toMatchObject({
        mode: 'form',
        form: { email: TYPED_EMAIL, password: '', field: 'password' },
      });
      expect(last(h)).not.toContain('server said no');
      expectNothingPrivateLogged(h);
      await quit(h);
    },
  );

  it('what was typed as the e-mail is not an address: the target is "invalid"', async () => {
    // People type their password into the e-mail field.
    const h = await atPassword('Zx9#Qw7$Lk2!vJ5^');
    h.auth.login.mockRejectedValue(new AuthError('invalid_credentials', 'no'));
    await typeText(h, 'x');
    await press(h, ENTER);
    await ready(h, 'Wrong e-mail or password');
    expect(events(h, 'auth.login-failed')[0]).toMatchObject({ target: 'invalid' });
    for (const line of h.log.lines) expect(line).not.toContain('Zx9#');
    await quit(h);
  });

  it('two failed sign-ins of one run with the same e-mail get the same target', async () => {
    const h = await atPassword();
    h.auth.login.mockRejectedValue(new AuthError('invalid_credentials', 'no'));
    await typeText(h, 'first');
    await press(h, ENTER);
    await ready(h, 'Wrong e-mail or password');
    await typeText(h, 'second');
    await press(h, ENTER);
    await vi.waitFor(() => {
      expect(events(h, 'auth.login-failed')).toHaveLength(2);
    });
    const [first, second] = events(h, 'auth.login-failed');
    expect(first?.['target']).toMatch(/^[0-9a-f]{64}$/);
    expect(second?.['target']).toBe(first?.['target']);
    expect(h.auth.login.mock.calls).toEqual([
      [TYPED_EMAIL, 'first'],
      [TYPED_EMAIL, 'second'],
    ]);
    await quit(h);
  });

  it('a failure that is no AuthError is logged as unexpected and ends the app (AC25)', async () => {
    const err = new TypeError('fetch exploded');
    const h = await atPassword();
    h.auth.login.mockRejectedValue(err);
    await typeText(h, PASSWORD);
    h.t.key(ENTER);
    await expect(h.done).rejects.toBe(err);
    expect(events(h, 'auth.login-failed')[0]).toMatchObject({ reason: 'unexpected' });
    expectNothingPrivateLogged(h);
  });

  it('the password is in no state, no frame and no log line, before or after the answer', async () => {
    const pending = deferred<AuthUser>();
    const h = await atPassword();
    h.auth.login.mockReturnValue(pending.promise);
    await typeText(h, PASSWORD);
    const typedFrame = last(h);
    await press(h, ENTER);
    // Submitted: gone from the state while the call is still running.
    expect(JSON.stringify(h.app.state)).not.toContain(PASSWORD.trim());
    pending.reject(new AuthError('invalid_credentials', 'no'));
    await ready(h, 'Wrong e-mail or password');
    expect(JSON.stringify(h.app.state)).not.toContain(PASSWORD.trim());
    for (const frame of h.t.frames) {
      for (let i = 0; i + 3 <= PASSWORD.trim().length; i++) {
        expect(text(frame)).not.toContain(PASSWORD.trim().slice(i, i + 3));
      }
    }
    // Typing changed nothing on screen.
    expect(typedFrame).toContain(NOTHING_SHOWN);
    expectNothingPrivateLogged(h);
    await quit(h);
  });

  it('a remembered address: only the password is typed', async () => {
    const h = await atList({ user: null, remembered: [BEN] });
    await press(h, ENTER);
    await ready(h, NOTHING_SHOWN);
    h.auth.login.mockResolvedValue({ email: BEN, userId: DANA.userId });
    await typeText(h, 'pw');
    await press(h, ENTER);
    await ready(h, 'Mail Manager - ');
    expect(h.auth.login.mock.calls).toEqual([[BEN, 'pw']]);
    expect(h.remembered.list()).toEqual([BEN]);
    await quit(h);
  });
});

// --- switch user, forget --------------------------------------------------------------------

describe('switching user (AC13)', () => {
  it('any key but y sends nothing', async () => {
    const h = await atList({ remembered: [BEN] });
    await press(h, DOWN, ENTER);
    expect(last(h)).toContain(`Sign out ${ANNA.email} first? (y/N)`);
    await press(h, ch('n'));
    expect(last(h)).not.toContain('first? (y/N)');
    expect(h.auth.logout).not.toHaveBeenCalled();
    expect(h.log.records).toEqual([]);
    expect(h.app.state.current).toEqual(ANNA);
    await quit(h);
  });

  it('y: the session is ended first (auth.logout), then the form of the chosen row', async () => {
    const pending = deferred<LogoutResult>();
    const h = await atList({ remembered: [BEN] });
    h.auth.logout.mockReturnValue(pending.promise);
    await press(h, DOWN, ENTER, ch('y'));
    expect(last(h)).toContain('Signing out...');
    expect(h.auth.logout).toHaveBeenCalledTimes(1);
    expect(h.log.records).toEqual([]);
    pending.resolve('logged-out');
    await ready(h, NOTHING_SHOWN);
    expect(eventNames(h)).toEqual(['auth.logout']);
    expect(events(h, 'auth.logout')[0]).toMatchObject({ outcome: 'logged-out' });
    expect(last(h)).toContain(`E-mail:    ${BEN}`);
    expect(h.app.state.current).toBeNull();
    expect(h.auth.login).not.toHaveBeenCalled();
    // The new sign-in runs on the same service, after the sign-out.
    await typeText(h, 'pw');
    await press(h, ENTER);
    await ready(h, 'Mail Manager - ');
    expect(h.auth.login.mock.calls).toEqual([[BEN, 'pw']]);
    expect(eventNames(h)).toEqual(['auth.logout', 'auth.login']);
    expectNothingPrivateLogged(h);
    await quit(h);
  });

  it('the new sign-in fails: nobody is signed in, the old user is a remembered row', async () => {
    const h = await atList({ remembered: [BEN] });
    h.auth.login.mockRejectedValue(new AuthError('invalid_credentials', 'no'));
    await press(h, DOWN, ENTER, ch('y'));
    await ready(h, NOTHING_SHOWN);
    await typeText(h, 'pw');
    await press(h, ENTER);
    await ready(h, 'Wrong e-mail or password');
    await press(h, ESC);
    expect(last(h)).toContain(ANNA.email);
    expect(last(h)).not.toContain('signed in');
    expect(h.app.state.current).toBeNull();
    await quit(h);
  });
});

describe('forgetting an address (AC14)', () => {
  it('y removes it from the store and from the list', async () => {
    const h = await atList({ remembered: [BEN, CYRIL] });
    await press(h, DOWN, ch('f'));
    expect(last(h)).toContain(`Forget ${BEN}? (y/N)`);
    await press(h, ch('y'));
    expect(h.remembered.list()).toEqual([ANNA.email, CYRIL]);
    expect(h.app.state.remembered).toEqual([ANNA.email, CYRIL]);
    expect(last(h)).not.toContain(BEN);
    expect(last(h)).toContain(CYRIL);
    expect(h.log.records).toEqual([]);
    await quit(h);
  });

  it('any other key keeps it', async () => {
    const h = await atList({ remembered: [BEN] });
    await press(h, DOWN, ch('f'), ch('n'));
    expect(h.remembered.list()).toEqual([ANNA.email, BEN]);
    expect(last(h)).toContain(BEN);
    await quit(h);
  });

  it('the signed-in address is not forgotten', async () => {
    const h = await atList({ remembered: [BEN] });
    await press(h, ch('f'));
    expect(last(h)).toContain('Log out first to forget this address.');
    await press(h, ch('y'));
    expect(h.remembered.list()).toEqual([ANNA.email, BEN]);
    await quit(h);
  });

  it('a store that throws ends the app with that error (AC25)', async () => {
    const err = new Error('store broke');
    const store: RememberedUsers = {
      list: () => [BEN],
      add: () => undefined,
      remove: () => {
        throw err;
      },
    };
    const h = await atList({ user: null, store });
    h.t.key(ch('f'));
    h.t.key(ch('y'));
    await expect(h.done).rejects.toBe(err);
  });
});

// --- Home -----------------------------------------------------------------------------------

describe('Home (AC16-AC20)', () => {
  it('Enter on the signed-in row: no login, the mailboxes are loaded and shown', async () => {
    const pending = deferred<readonly MailAccount[]>();
    const h = await atList();
    h.listMailboxes.mockReturnValue(pending.promise);
    await press(h, ENTER);
    expect(last(h)).toContain('Loading your mailboxes...');
    expect(last(h)).toContain(`Mail Manager - ${ANNA.email}`);
    pending.resolve([BOX_1, BOX_2]);
    await ready(h, BOX_2.email);
    expect(last(h)).toContain('2 mailboxes');
    expect(last(h)).toContain('Websupport');
    expect(h.auth.login).not.toHaveBeenCalled();
    expect(h.listMailboxes).toHaveBeenCalledTimes(1);
    expect(h.log.records).toEqual([]);
    await quit(h);
  });

  it('the rows hold id, e-mail, provider and last check - nothing else of a mailbox', async () => {
    const h = await atHome();
    const view = h.app.state.view;
    if (view.kind !== 'home') throw new Error('not on Home');
    expect(view.mailboxes).toEqual([
      { id: BOX_1.id, email: BOX_1.email, provider: 'websupport', lastCheckedAt: new Date(T0) },
      { id: BOX_2.id, email: BOX_2.email, provider: 'websupport', lastCheckedAt: null },
    ]);
    for (const row of view.mailboxes ?? []) {
      expect(Object.keys(row).sort()).toEqual(['email', 'id', 'lastCheckedAt', 'provider']);
    }
    const state = JSON.stringify(h.app.state);
    for (const secret of [HOST, USERNAME, CIPHERTEXT, 'CANARY-IV', 'CANARY-TAG']) {
      expect(state).not.toContain(secret);
      for (const frame of h.t.frames) expect(text(frame)).not.toContain(secret);
    }
    await quit(h);
  });

  it('no mailboxes: the hint to add one', async () => {
    const h = await atHome({ mailboxes: [] });
    expect(last(h)).toContain('No mailboxes yet - add your first one.');
    await quit(h);
  });

  it('the rows of later steps only say which command to run', async () => {
    const h = await atHome();
    await press(h, ENTER);
    expect(last(h)).toContain('Connecting...');
    await press(h, ESC);
    await press(h, DOWN, DOWN, ENTER);
    expect(last(h)).toContain('Mail Manager - Add a mailbox');
    await press(h, ESC);
    await press(h, DOWN, ENTER);
    expect(last(h)).toContain('Mail Manager - Logs');
    expect(h.listMailboxes).toHaveBeenCalledTimes(1);
    expect(h.log.records).toEqual([]);
    await quit(h);
  });

  it('Log out: auth.logout() and its event, then the list - the address listed, not tagged', async () => {
    const pending = deferred<LogoutResult>();
    const h = await atHome();
    h.auth.logout.mockReturnValue(pending.promise);
    await press(h, DOWN, DOWN, DOWN, DOWN, ENTER);
    expect(last(h)).toContain('Signing out...');
    expect(h.log.records).toEqual([]);
    pending.resolve('logged-out');
    await ready(h, ANOTHER_USER);
    expect(h.auth.logout).toHaveBeenCalledTimes(1);
    expect(eventNames(h)).toEqual(['auth.logout']);
    expect(last(h)).toContain(ANNA.email);
    expect(last(h)).not.toContain('signed in');
    expect(h.app.state.current).toBeNull();
    expect(h.remembered.list()).toEqual([ANNA.email]);
    expectNothingPrivateLogged(h);
    await quit(h);
  });

  it('a sign-out that fails ends the app with that error', async () => {
    const err = new Error('logout broke');
    const h = await atHome({ mailboxes: [] });
    h.auth.logout.mockRejectedValue(err);
    await press(h, DOWN, DOWN);
    h.t.key(ENTER);
    await expect(h.done).rejects.toBe(err);
    await expect(h.app.settled()).resolves.toBeUndefined();
    expect(h.log.records).toEqual([]);
  });

  it('Esc goes back to the list without signing out; Enter opens Home again', async () => {
    const h = await atHome();
    await press(h, ESC);
    expect(last(h)).toContain('signed in');
    expect(h.auth.logout).not.toHaveBeenCalled();
    await press(h, ENTER);
    await ready(h, BOX_1.email);
    expect(h.listMailboxes).toHaveBeenCalledTimes(2);
    await quit(h);
  });

  it('q quits', async () => {
    const h = await atHome();
    h.t.key(ch('q'));
    await expect(h.done).resolves.toEqual({ end: 'quit' });
    await expect(h.app.settled()).resolves.toBeUndefined();
    expect(h.auth.logout).not.toHaveBeenCalled();
  });
});

describe('the mailbox list cannot be loaded (AC19)', () => {
  it('still signed in: "Couldn\'t load", r loads again', async () => {
    const h = await atList();
    h.listMailboxes.mockRejectedValueOnce(new RepoError('unavailable', 'db down'));
    await press(h, ENTER);
    await ready(
      h,
      "Couldn't load your mailboxes - check your internet connection (r = try again).",
    );
    // currentUser: once at the start, once to see whether the sign-in is still there.
    expect(h.auth.currentUser).toHaveBeenCalledTimes(2);
    expect(h.onUnexpected).not.toHaveBeenCalled();
    expect(last(h)).not.toContain('db down');
    await press(h, ch('r'));
    await ready(h, BOX_1.email);
    expect(h.listMailboxes).toHaveBeenCalledTimes(2);
    expect(h.log.records).toEqual([]);
    await quit(h);
  });

  it('the sign-in is gone: back to the sign-in page with its message', async () => {
    const h = await atList({ remembered: [BEN] });
    h.listMailboxes.mockRejectedValueOnce(new RepoError('forbidden', 'jwt expired'));
    h.auth.currentUser.mockResolvedValue(null);
    await press(h, ENTER);
    await ready(h, 'Your sign-in has ended - sign in again.');
    expect(last(h)).toContain(ANNA.email);
    expect(last(h)).not.toContain('signed in');
    expect(h.app.state.current).toBeNull();
    expect(h.app.state.remembered).toEqual([ANNA.email, BEN]);
    await quit(h);
  });

  it('Mail Manager cannot be asked either: "Couldn\'t load"', async () => {
    const h = await atList();
    h.listMailboxes.mockRejectedValueOnce(new RepoError('unavailable', 'db down'));
    h.auth.currentUser.mockRejectedValue(new AuthError('unreachable', 'offline'));
    await press(h, ENTER);
    await ready(h, "Couldn't load your mailboxes");
    expect(h.app.state.current).toEqual(ANNA);
    await quit(h);
  });

  it('an error that is none of ours is handed to onUnexpected, and the app goes on', async () => {
    const err = new TypeError('cannot read properties of undefined');
    const h = await atList();
    h.listMailboxes.mockRejectedValueOnce(err);
    await press(h, ENTER);
    await ready(h, "Couldn't load your mailboxes");
    expect(h.onUnexpected.mock.calls).toEqual([[err]]);
    expect(last(h)).not.toContain('cannot read');
    expect(await stillRunning(h.done)).toBe(true);
    await quit(h);
  });

  it('a list that throws at once is handled like one that rejects', async () => {
    const h = await atList();
    h.listMailboxes.mockImplementationOnce(() => {
      throw new RepoError('unavailable', 'no client');
    });
    await press(h, ENTER);
    await ready(h, "Couldn't load your mailboxes");
    await quit(h);
  });
});

// --- Ctrl+C, late and stale results ---------------------------------------------------------

describe('Ctrl+C ends at once in every mode (AC21)', () => {
  it('while the session is checked: nothing of the late answer is taken', async () => {
    const pending = deferred<AuthUser | null>();
    const h = makeHarness({ currentUser: () => pending.promise });
    h.t.key(CTRL_C);
    await expect(h.done).resolves.toEqual({ end: 'interrupt' });
    const state = h.app.state;
    const frames = h.t.frames.length;
    pending.resolve(ANNA);
    await settle();
    expect(h.app.state).toBe(state);
    expect(h.t.frames).toHaveLength(frames);
    expect(h.remembered.list()).toEqual([]);
  });

  it('on the list, in the form, at a question and on Home', async () => {
    const onList = await atList({ remembered: [BEN] });
    onList.t.key(CTRL_C);
    await expect(onList.done).resolves.toEqual({ end: 'interrupt' });

    const inForm = await atPassword();
    await typeText(inForm, 'pw');
    inForm.t.key(CTRL_C);
    await expect(inForm.done).resolves.toEqual({ end: 'interrupt' });
    expect(inForm.auth.login).not.toHaveBeenCalled();

    const asked = await atList({ remembered: [BEN] });
    await press(asked, DOWN, ENTER);
    asked.t.key(CTRL_C);
    await expect(asked.done).resolves.toEqual({ end: 'interrupt' });
    expect(asked.auth.logout).not.toHaveBeenCalled();

    const home = await atHome();
    home.t.key(CTRL_C);
    await expect(home.done).resolves.toEqual({ end: 'interrupt' });
    expect(home.auth.logout).not.toHaveBeenCalled();
  });

  it('while signing in: the late answer changes nothing and writes nothing', async () => {
    for (const answer of ['resolve', 'reject'] as const) {
      const pending = deferred<AuthUser>();
      const h = await atPassword();
      h.auth.login.mockReturnValue(pending.promise);
      await typeText(h, PASSWORD);
      await press(h, ENTER);
      h.t.key(CTRL_C);
      await expect(h.done).resolves.toEqual({ end: 'interrupt' });
      const state = h.app.state;
      const frames = h.t.frames.length;
      if (answer === 'resolve') pending.resolve(DANA);
      else pending.reject(new AuthError('invalid_credentials', 'no'));
      await settle();
      expect(h.app.state).toBe(state);
      expect(h.t.frames).toHaveLength(frames);
      expect(h.log.records).toEqual([]);
      expect(h.remembered.list()).toEqual([]);
      expect(h.listMailboxes).not.toHaveBeenCalled();
    }
  });

  it('while the mailboxes load: the late list and a late failure change nothing', async () => {
    for (const answer of ['resolve', 'reject'] as const) {
      const pending = deferred<readonly MailAccount[]>();
      const h = await atList();
      h.listMailboxes.mockReturnValue(pending.promise);
      await press(h, ENTER);
      h.t.key(CTRL_C);
      await expect(h.done).resolves.toEqual({ end: 'interrupt' });
      const state = h.app.state;
      const frames = h.t.frames.length;
      if (answer === 'resolve') pending.resolve([BOX_1]);
      else pending.reject(new TypeError('late'));
      await settle();
      expect(h.app.state).toBe(state);
      expect(h.t.frames).toHaveLength(frames);
      expect(h.onUnexpected).not.toHaveBeenCalled();
      expect(h.auth.currentUser).toHaveBeenCalledTimes(1);
    }
  });

  it('while signing out: the sign-out is still finished and auth.logout written', async () => {
    const pending = deferred<LogoutResult>();
    const h = await atHome({ mailboxes: [] });
    h.auth.logout.mockReturnValue(pending.promise);
    await press(h, DOWN, DOWN, ENTER);
    expect(last(h)).toContain('Signing out...');
    h.t.key(CTRL_C);
    await expect(h.done).resolves.toEqual({ end: 'interrupt' });
    // The app has ended, the sign-out has not: settled() waits for it.
    const settled = h.app.settled();
    expect(await stillRunning(settled)).toBe(true);
    expect(h.log.records).toEqual([]);
    const state = h.app.state;
    const frames = h.t.frames.length;
    pending.resolve('logged-out');
    await expect(settled).resolves.toBeUndefined();
    expect(eventNames(h)).toEqual(['auth.logout']);
    expect(events(h, 'auth.logout')[0]).toMatchObject({ outcome: 'logged-out' });
    // Only the screen no longer follows.
    expect(h.app.state).toBe(state);
    expect(h.t.frames).toHaveLength(frames);
    expect(h.auth.logout).toHaveBeenCalledTimes(1);
  });

  it('the same when the sign-out was started to switch user', async () => {
    const pending = deferred<LogoutResult>();
    const h = await atList({ remembered: [BEN] });
    h.auth.logout.mockReturnValue(pending.promise);
    await press(h, DOWN, ENTER, ch('y'));
    h.t.key(CTRL_C);
    await expect(h.done).resolves.toEqual({ end: 'interrupt' });
    const settled = h.app.settled();
    expect(await stillRunning(settled)).toBe(true);
    pending.resolve('logged-out');
    await expect(settled).resolves.toBeUndefined();
    expect(eventNames(h)).toEqual(['auth.logout']);
    expect(h.auth.login).not.toHaveBeenCalled();
  });

  it('settled() never rejects, also when that sign-out fails after the end', async () => {
    const pending = deferred<LogoutResult>();
    const h = await atHome({ mailboxes: [] });
    h.auth.logout.mockReturnValue(pending.promise);
    await press(h, DOWN, DOWN, ENTER);
    h.t.key(CTRL_C);
    await expect(h.done).resolves.toEqual({ end: 'interrupt' });
    const settled = h.app.settled();
    pending.reject(new Error('network gone'));
    await expect(settled).resolves.toBeUndefined();
    expect(h.log.records).toEqual([]);
  });

  it('Ctrl+C right after Esc (one joined keypress) ends a waiting app', async () => {
    for (const key of [ESC_CTRL_C, ESC_ESC_CTRL_C]) {
      const checking = makeHarness({ currentUser: () => new Promise(() => undefined) });
      checking.t.key(key);
      await expect(checking.done).resolves.toEqual({ end: 'interrupt' });

      const pending = deferred<AuthUser>();
      const signingIn = await atPassword();
      signingIn.auth.login.mockReturnValue(pending.promise);
      await typeText(signingIn, PASSWORD);
      await press(signingIn, ENTER);
      expect(last(signingIn)).toContain('Signing in...');
      signingIn.t.key(key);
      await expect(signingIn.done).resolves.toEqual({ end: 'interrupt' });

      const loading = await atList();
      loading.listMailboxes.mockReturnValue(new Promise(() => undefined));
      await press(loading, ENTER);
      expect(last(loading)).toContain('Loading your mailboxes...');
      loading.t.key(key);
      await expect(loading.done).resolves.toEqual({ end: 'interrupt' });
    }
  });

  it('the same in the form, on the list, at a question and on Home: it ends, nothing else acts', async () => {
    const inForm = await atPassword();
    await typeText(inForm, 'pw');
    const typed = inForm.app.state;
    const frames = inForm.t.frames.length;
    inForm.t.key(ESC_CTRL_C);
    await expect(inForm.done).resolves.toEqual({ end: 'interrupt' });
    // Neither typed into the field nor taken as Esc (back to the list): the state is as it was.
    expect(inForm.app.state).toBe(typed);
    expect(inForm.t.frames).toHaveLength(frames);
    expect(inForm.auth.login).not.toHaveBeenCalled();

    const emailField = await atForm();
    await typeText(emailField, 'ab');
    emailField.t.key(ESC_CTRL_C);
    await expect(emailField.done).resolves.toEqual({ end: 'interrupt' });
    expect(emailField.app.state.view).toMatchObject({ mode: 'form', form: { email: 'ab' } });

    const onList = await atList({ remembered: [BEN] });
    onList.t.key(ESC_CTRL_C);
    await expect(onList.done).resolves.toEqual({ end: 'interrupt' });

    const asked = await atList({ remembered: [BEN] });
    await press(asked, DOWN, ENTER);
    asked.t.key(ESC_CTRL_C);
    await expect(asked.done).resolves.toEqual({ end: 'interrupt' });
    expect(asked.auth.logout).not.toHaveBeenCalled();

    const home = await atHome();
    home.t.key(ESC_CTRL_C);
    await expect(home.done).resolves.toEqual({ end: 'interrupt' });
    expect(home.app.state.view.kind).toBe('home');
  });

  it('during "Signing out..." it ends too, and the sign-out is still finished', async () => {
    const pending = deferred<LogoutResult>();
    const h = await atHome({ mailboxes: [] });
    h.auth.logout.mockReturnValue(pending.promise);
    await press(h, DOWN, DOWN, ENTER);
    h.t.key(ESC_CTRL_C);
    await expect(h.done).resolves.toEqual({ end: 'interrupt' });
    const settled = h.app.settled();
    expect(await stillRunning(settled)).toBe(true);
    pending.resolve('logged-out');
    await expect(settled).resolves.toBeUndefined();
    expect(eventNames(h)).toEqual(['auth.logout']);
  });

  it('while the window is too small it ends as well', async () => {
    const h = await atPassword();
    h.t.screen = { rows: 5, cols: 30 };
    h.t.resize();
    h.t.key(ESC_CTRL_C);
    await expect(h.done).resolves.toEqual({ end: 'interrupt' });
  });

  it('other Meta keypresses and a lone Esc are not Ctrl+C', async () => {
    const h = await atHome();
    // Alt+C, Alt+X, an unnamed Esc + symbol pair.
    await press(
      h,
      k('c', { meta: true, sequence: '\u001bc' }),
      k('x', { meta: true, sequence: '\u001bx' }),
      { sequence: '\u001b!', ctrl: false, meta: true, shift: false },
    );
    expect(await stillRunning(h.done)).toBe(true);
    expect(h.app.state.view.kind).toBe('home');
    await press(h, ESC);
    expect(h.app.state.view.kind).toBe('sign-in');
    expect(await stillRunning(h.done)).toBe(true);
    await quit(h);
  });

  it('settled() resolves at once when no sign-out ran', async () => {
    const h = await atList();
    await expect(h.app.settled()).resolves.toBeUndefined();
    h.t.key(CTRL_C);
    await h.done;
    await expect(h.app.settled()).resolves.toBeUndefined();
  });

  it('keys and resizes after the end do nothing', async () => {
    const h = await atList({ remembered: [BEN] });
    h.t.key(CTRL_C);
    await h.done;
    const state = h.app.state;
    const drawn = h.t.events.length;
    h.t.key(DOWN);
    h.t.key(ENTER);
    h.t.key(ch('q'));
    h.t.resize();
    await settle();
    expect(h.app.state).toBe(state);
    expect(h.t.events).toHaveLength(drawn);
  });
});

describe('a result that was superseded changes nothing (AC24)', () => {
  it('Esc on Home while the mailboxes load: the late list is dropped', async () => {
    const pending = deferred<readonly MailAccount[]>();
    const h = await atList();
    h.listMailboxes.mockReturnValueOnce(pending.promise);
    await press(h, ENTER);
    expect(last(h)).toContain('Loading your mailboxes...');
    await press(h, ESC);
    expect(last(h)).toContain(ANOTHER_USER);
    const state = h.app.state;
    pending.resolve([BOX_1]);
    await settle();
    expect(h.app.state).toEqual(state);
    expect(last(h)).toContain(ANOTHER_USER);
    expect(last(h)).not.toContain(BOX_1.email);
    await quit(h);
  });

  it('a late failure of that load does not show its message on the sign-in page', async () => {
    const pending = deferred<readonly MailAccount[]>();
    const h = await atList();
    h.listMailboxes.mockReturnValueOnce(pending.promise);
    await press(h, ENTER, ESC);
    pending.reject(new RepoError('unavailable', 'db down'));
    await settle();
    await settle();
    expect(last(h)).toContain(ANOTHER_USER);
    expect(last(h)).not.toContain("Couldn't load");
    expect(h.app.state.view).toMatchObject({ kind: 'sign-in', mode: 'pick', message: null });
    await quit(h);
  });
});

// --- frame ----------------------------------------------------------------------------------

describe('the frame', () => {
  it('a resize clears and redraws at the new size', async () => {
    const h = await atList({ remembered: [BEN] });
    const before = h.t.events.length;
    h.t.screen = { rows: 10, cols: 50 };
    h.t.resize();
    expect(h.t.events.slice(before)).toEqual(['clear', 'draw']);
    expect(h.t.frames.at(-1)?.lines).toHaveLength(10);
    expect(h.app.state.screen).toEqual({ rows: 10, cols: 50 });
    await quit(h);
  });

  it('below 40x8 only "Window too small" is drawn; q still quits', async () => {
    const h = await atList({ remembered: [BEN] });
    h.t.screen = { rows: 7, cols: 80 };
    h.t.resize();
    expect(last(h)).toContain('Window too small - need at least 40x8');
    expect(last(h)).not.toContain(ANNA.email);
    await press(h, ENTER, DOWN);
    expect(h.app.state.view).toMatchObject({ kind: 'sign-in', mode: 'pick', cursor: 0 });
    h.t.key(ch('q'));
    await expect(h.done).resolves.toEqual({ end: 'quit' });
  });

  it('every key gives exactly one frame', async () => {
    const h = await atList({ remembered: [BEN] });
    const before = h.t.frames.length;
    await press(h, DOWN, DOWN, k('up', { sequence: '\u001b[A' }));
    expect(h.t.frames).toHaveLength(before + 3);
    await quit(h);
  });

  it('a terminal that fails to draw ends the app with that error (AC25)', async () => {
    const err = new Error('terminal gone');
    const h = await atList();
    h.t.failDraw = err;
    h.t.key(DOWN);
    await expect(h.done).rejects.toBe(err);
    // Nothing more is tried.
    h.t.failDraw = null;
    const frames = h.t.frames.length;
    h.t.key(DOWN);
    expect(h.t.frames).toHaveLength(frames);
  });

  it('a first frame that cannot be drawn: run() rejects and no session check starts', async () => {
    const err = new Error('no terminal');
    const h = makeHarness({ failDraw: err });
    await expect(h.done).rejects.toBe(err);
    await settle();
    expect(h.auth.currentUser).not.toHaveBeenCalled();
  });
});
