import { describe, it, expect, vi } from 'vitest';
import { createApp } from '../../src/cli/app/controller.js';
import type { App, AppDeps, AppResult } from '../../src/cli/app/controller.js';
import type { Rendered } from '../../src/cli/browser/render.js';
import type { Keypress, Screen } from '../../src/cli/browser/state.js';
import type { Terminal } from '../../src/cli/browser/terminal.js';
import { AuthError } from '../../src/core/auth.js';
import type { AuthUser, LogoutResult } from '../../src/core/auth.js';
import type { MailAccount } from '../../src/core/db/repos.js';
import { MemoryEventLog } from '../../src/core/log/index.js';
import { MemoryRememberedUsers } from '../../src/core/remembered-users.js';

// M2d-1 app controller (spec AC6, AC7, AC11-AC13, AC18, AC19, AC21, AC24, AC25, AC26): keys ->
// reducer -> effects, driven with a fake Terminal, a fake AuthService, in-memory remembered users and
// a MemoryEventLog. No Supabase, no real terminal, no real clock.

// --- fixtures -------------------------------------------------------------------------------

const SCREEN: Screen = { rows: 24, cols: 100 };
const SMALL: Screen = { rows: 5, cols: 30 };
const ALICE: AuthUser = {
  email: 'alice@example.com',
  userId: '11111111-1111-4111-8111-111111111111',
};
const BOB = 'bob@example.com';
const CAROL = 'carol@example.com';
const RUN = '0123456789abcdef';
const T0 = Date.UTC(2026, 9, 1, 9, 0, 0);
const TARGET = 'ab'.repeat(32);

const k = (name: string, extra: Keypress = {}): Keypress => ({ name, sequence: name, ...extra });
const ENTER = k('return', { sequence: '\r' });
const DOWN = k('down', { sequence: '\x1b[B' });
const LEFT = k('left', { sequence: '\x1b[D' });
const BACKSPACE = k('backspace', { sequence: '\x7f' });
const TAB = k('tab', { sequence: '\t' });
const CTRL_C = k('c', { ctrl: true, sequence: '\x03' });
const ESC = k('escape', { meta: true, sequence: '\x1b' });

/** The keypress readline would deliver for one typed character. */
function charKey(c: string): Keypress {
  if (c === ' ') return { name: 'space', sequence: ' ' };
  return /^[a-z]$/.test(c) ? { name: c, sequence: c } : { sequence: c };
}

function account(
  id: string,
  email: string,
  provider = 'websupport',
  lastCheckedAt: Date | null = null,
): MailAccount {
  return {
    id,
    userId: ALICE.userId,
    label: null,
    email,
    provider,
    host: 'imap.example.com',
    port: 993,
    username: email,
    authType: 'password',
    secret: {} as unknown as MailAccount['secret'],
    capabilities: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    lastCheckedAt,
  };
}

// --- fakes ----------------------------------------------------------------------------------

interface FakeTerminal extends Terminal {
  readonly frames: Rendered[];
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
    screen,
    failDraw: null,
    size: () => t.screen,
    draw: (frame) => {
      if (t.failDraw !== null) throw t.failDraw;
      t.frames.push(frame);
    },
    clear: () => undefined,
    onKey: (fn) => {
      keyHandler = fn;
    },
    onResize: (fn) => {
      resizeHandler = fn;
    },
    restore: vi.fn(),
    close: vi.fn(),
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

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * The mailbox screen is M2d-2 and has its own tests: here a mailbox that is opened stays on
 * "Connecting..." (its lookup never answers), and no mailbox login is ever made.
 */
const NO_MAILBOX: Pick<AppDeps, 'findAccount' | 'openSession'> = {
  findAccount: () => new Promise<MailAccount>(() => undefined),
  openSession: () => Promise.reject(new Error('no mailbox login in these tests')),
};

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

async function stillRunning(p: Promise<unknown>): Promise<boolean> {
  return Promise.race([p.then(() => false), settle().then(() => true)]);
}

type CurrentUser = () => Promise<AuthUser | null>;
type Login = (email: string, password: string) => Promise<AuthUser>;
type Logout = () => Promise<LogoutResult>;

interface Harness {
  t: FakeTerminal;
  app: App;
  deps: AppDeps;
  auth: {
    currentUser: ReturnType<typeof vi.fn<CurrentUser>>;
    login: ReturnType<typeof vi.fn<Login>>;
    logout: ReturnType<typeof vi.fn<Logout>>;
  };
  listMailboxes: ReturnType<typeof vi.fn<() => Promise<readonly MailAccount[]>>>;
  loginTarget: ReturnType<typeof vi.fn<(email: string) => string>>;
  remembered: MemoryRememberedUsers;
  log: MemoryEventLog;
  done: Promise<AppResult>;
}

interface Options {
  user?: AuthUser | null;
  /** Replaces the session check (default: resolves with `user`). */
  currentUser?: CurrentUser;
  /** The first draw throws this. */
  failDraw?: Error;
  remembered?: string[];
  mailboxes?: MailAccount[];
  screen?: Screen;
}

function makeHarness(options: Options = {}): Harness {
  const user = options.user === undefined ? ALICE : options.user;
  const t = fakeTerminal(options.screen);
  if (options.failDraw !== undefined) t.failDraw = options.failDraw;
  const auth = {
    currentUser: vi.fn<CurrentUser>(options.currentUser ?? (() => Promise.resolve(user))),
    login: vi.fn<Login>(() => Promise.resolve(ALICE)),
    logout: vi.fn<Logout>(() => Promise.resolve('logged-out')),
  };
  const listMailboxes = vi.fn<() => Promise<readonly MailAccount[]>>(() =>
    Promise.resolve(options.mailboxes ?? []),
  );
  const loginTarget = vi.fn<(email: string) => string>((email) =>
    email.includes('@') ? TARGET : 'invalid',
  );
  const remembered = new MemoryRememberedUsers(options.remembered ?? []);
  const log = new MemoryEventLog({ run: RUN, ver: '0.9.0', now: () => T0, level: 'debug' });
  const deps: AppDeps = {
    terminal: t,
    version: '0.9.0',
    auth,
    listMailboxes,
    remembered,
    log,
    loginTarget,
    ...NO_MAILBOX,
    readLogs: NO_LOGS,
    ...NO_ADD,
  };
  const app = createApp(deps);
  return { t, app, deps, auth, listMailboxes, loginTarget, remembered, log, done: app.run() };
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
  await press(h, ...[...value].map(charKey));
}

async function ready(h: Harness, needle: string): Promise<void> {
  await vi.waitFor(() => {
    expect(last(h)).toContain(needle);
  });
}

async function end(h: Harness): Promise<void> {
  if (await stillRunning(h.done)) {
    h.t.key(CTRL_C);
    await h.done;
  }
}

function events(h: Harness, name: string): Record<string, unknown>[] {
  return h.log.records.filter((r) => r.event === name);
}

/** Signed-in ALICE on the sign-in list. */
async function atPick(over: Options = {}): Promise<Harness> {
  const h = makeHarness(over);
  await ready(h, 'Sign in as another user');
  return h;
}

/** Signed-in ALICE on Home with the mailbox list shown. */
async function atHome(over: Options = {}): Promise<Harness> {
  const h = await atPick({ mailboxes: [account('m1', 'one@example.com')], ...over });
  await press(h, ENTER);
  await ready(h, 'one@example.com');
  return h;
}

/** Nobody signed in, nothing remembered: the form is up. */
async function atForm(over: Options = {}): Promise<Harness> {
  const h = makeHarness({ user: null, remembered: [], ...over });
  await ready(h, NOTHING_SHOWN);
  return h;
}

const NOTHING_SHOWN = '(nothing is shown while you type)';

/** E-mail typed, Enter: on the password field. */
async function atPassword(email = 'user@example.com', over: Options = {}): Promise<Harness> {
  const h = await atForm(over);
  await typeText(h, email);
  await press(h, ENTER);
  return h;
}

// --- start ----------------------------------------------------------------------------------

describe('start', () => {
  it('createApp registers and draws nothing; run() registers both handlers first, then draws "Checking your sign-in..."', () => {
    const t = fakeTerminal();
    const draws: boolean[] = [];
    const draw = t.draw.bind(t);
    t.draw = (frame) => {
      draws.push(t.registered());
      draw(frame);
    };
    const auth = {
      currentUser: () => new Promise<AuthUser | null>(() => undefined),
      login: vi.fn(),
      logout: vi.fn(),
    };
    const app = createApp({
      terminal: t,
      version: '0.9.0',
      auth,
      listMailboxes: () => Promise.resolve([]),
      remembered: new MemoryRememberedUsers(),
      log: new MemoryEventLog({ run: RUN, ver: '0.9.0', now: () => T0, level: 'debug' }),
      loginTarget: () => TARGET,
      ...NO_MAILBOX,
      readLogs: NO_LOGS,
      ...NO_ADD,
    });
    expect(t.registered()).toBe(false);
    expect(t.frames).toHaveLength(0);
    const done = app.run();
    expect(t.registered()).toBe(true);
    expect(draws).toEqual([true]);
    expect(text(t.frames[0])).toContain('Checking your sign-in...');
    t.key(CTRL_C);
    return expect(done).resolves.toMatchObject({ end: 'interrupt' });
  });

  it('the first frame has exactly rows lines of cols columns', async () => {
    const h = makeHarness();
    expect(h.t.frames[0]?.lines).toHaveLength(SCREEN.rows);
    for (const line of h.t.frames[0]?.lines ?? []) expect(line).toHaveLength(SCREEN.cols);
    await end(h);
  });

  it('the app always starts on the sign-in page, even with a valid session', async () => {
    const h = makeHarness();
    expect(last(h)).toContain('Checking your sign-in...');
    expect(last(h)).not.toContain('Mail Manager - ');
    await ready(h, 'Sign in as another user');
    expect(h.listMailboxes).not.toHaveBeenCalled();
    await end(h);
  });
});

// --- AC6, AC7 -------------------------------------------------------------------------------

describe('AC6 the session check', () => {
  it('a valid session: the user first, tagged "signed in"; the remembered ones; "Sign in as another user" last', async () => {
    const h = await atPick({ remembered: [BOB, CAROL] });
    const lines = h.t.frames.at(-1)?.lines ?? [];
    const a = lines.findIndex((l) => l.includes(ALICE.email));
    const b = lines.findIndex((l) => l.includes(BOB));
    const c = lines.findIndex((l) => l.includes(CAROL));
    const o = lines.findIndex((l) => l.includes('Sign in as another user'));
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
    expect(c).toBeLessThan(o);
    expect(lines[a]).toContain('signed in');
    expect(lines[b]).not.toContain('signed in');
    await end(h);
  });

  it("the signed-in user's address is added to the remembered list at this check", async () => {
    const h = await atPick({ remembered: [BOB] });
    expect(h.remembered.list()).toEqual([ALICE.email, BOB]);
    await end(h);
  });

  it('the signed-in address already remembered in another letter case: one row', async () => {
    const h = await atPick({ remembered: ['ALICE@Example.COM', BOB] });
    const rows = (h.t.frames.at(-1)?.lines ?? []).filter((l) =>
      l.toLowerCase().includes(ALICE.email),
    );
    expect(rows).toHaveLength(1);
    await end(h);
  });

  it('a user without an e-mail is shown as "(no e-mail)" and never remembered', async () => {
    const h = makeHarness({ user: { email: '', userId: ALICE.userId }, remembered: [] });
    await ready(h, '(no e-mail)');
    expect(h.remembered.list()).toEqual([]);
    await end(h);
  });

  it('nobody signed in and nothing remembered: the form opens directly', async () => {
    const h = await atForm();
    expect(last(h)).not.toContain('Sign in as another user');
    expect(h.auth.login).not.toHaveBeenCalled();
    await end(h);
  });

  it('an expired or corrupt session (currentUser -> null): nobody is tagged "signed in"', async () => {
    const h = makeHarness({ user: null, remembered: [BOB] });
    await ready(h, BOB);
    expect(last(h)).not.toContain('signed in');
    await end(h);
  });

  it('Esc in the directly opened form shows the list with the single row "Sign in"', async () => {
    const h = await atForm();
    await press(h, ESC);
    const frame = h.t.frames.at(-1);
    expect(frame?.cursorLine).not.toBeNull();
    expect(frame?.lines[frame.cursorLine ?? 0]).toContain('Sign in');
    expect(last(h)).not.toContain('Sign in as another user');
    await end(h);
  });
});

describe('AC7 Enter on the signed-in row', () => {
  it('opens Home without a password question and without a login call; the mailboxes are loaded', async () => {
    const h = await atPick({ mailboxes: [account('m1', 'one@example.com')] });
    await press(h, ENTER);
    await ready(h, 'one@example.com');
    expect(last(h)).toContain(`Mail Manager - ${ALICE.email}`);
    expect(h.auth.login).not.toHaveBeenCalled();
    expect(h.listMailboxes).toHaveBeenCalledTimes(1);
    expect(events(h, 'auth.login')).toEqual([]);
    await end(h);
  });
});

// --- AC15 -----------------------------------------------------------------------------------

describe('AC15 the session check fails', () => {
  const UNREACHABLE = "Can't reach Mail Manager - check your internet connection and try again.";

  it('Mail Manager unreachable: the message with "r try again  q quit"; r checks again', async () => {
    // Fails once, then works: the same fake serves the retry.
    const calls: number[] = [];
    const h2 = makeHarness({
      remembered: [BOB],
      currentUser: () => {
        calls.push(1);
        return calls.length === 1
          ? Promise.reject(new AuthError('unreachable', 'down'))
          : Promise.resolve(ALICE);
      },
    });
    await ready(h2, 'r try again  q quit');
    expect(last(h2)).toContain(UNREACHABLE);
    await press(h2, k('r'));
    await ready(h2, 'Sign in as another user');
    expect(calls).toHaveLength(2);
    expect(last(h2)).toContain('signed in');
    await end(h2);
  });

  it('r that fails again shows the message again', async () => {
    const h = makeHarness({
      currentUser: () => Promise.reject(new AuthError('unreachable', 'down')),
    });
    await ready(h, 'r try again  q quit');
    await press(h, k('r'));
    await ready(h, 'r try again  q quit');
    expect(h.auth.currentUser).toHaveBeenCalledTimes(2);
    await end(h);
  });

  it('q quits from the failed check', async () => {
    const h = makeHarness({
      currentUser: () => Promise.reject(new AuthError('unreachable', 'down')),
    });
    await ready(h, 'r try again  q quit');
    h.t.key(k('q'));
    await expect(h.done).resolves.toMatchObject({ end: 'quit' });
  });
});

// --- AC8, AC9, AC10, AC11, AC12: sign in ----------------------------------------------------

describe('AC8 the form from the list', () => {
  it('a remembered row (nobody signed in): that e-mail is fixed, the password is asked', async () => {
    const h = makeHarness({ user: null, remembered: [BOB, CAROL] });
    await ready(h, BOB);
    await press(h, ENTER);
    await ready(h, NOTHING_SHOWN);
    expect(last(h)).toContain(BOB);
    await typeText(h, 'pw');
    await press(h, ENTER);
    expect(h.auth.login).toHaveBeenCalledWith(BOB, 'pw');
    await end(h);
  });

  it('the last row opens an empty e-mail field', async () => {
    const h = makeHarness({ user: null, remembered: [BOB] });
    await ready(h, 'Sign in as another user');
    await press(h, DOWN, ENTER);
    await ready(h, NOTHING_SHOWN);
    await typeText(h, 'new@example.com');
    await press(h, ENTER);
    await typeText(h, 'pw');
    await press(h, ENTER);
    expect(h.auth.login).toHaveBeenCalledWith('new@example.com', 'pw');
    await end(h);
  });
});

describe('AC9 / AC11 signing in', () => {
  it('the typed e-mail is trimmed; the password is sent as typed, spaces included', async () => {
    const h = await atForm();
    await typeText(h, '  user@example.com  ');
    await press(h, ENTER);
    await typeText(h, '  pw with spaces  ');
    await press(h, ENTER);
    expect(h.auth.login).toHaveBeenCalledTimes(1);
    expect(h.auth.login).toHaveBeenCalledWith('user@example.com', '  pw with spaces  ');
    await end(h);
  });

  it('Tab, Up and Down switch the field: the e-mail can be corrected before submitting', async () => {
    const h = await atForm();
    await typeText(h, 'wrong@example.com');
    await press(h, ENTER);
    await typeText(h, 'pw');
    await press(h, TAB);
    await press(h, k('u', { ctrl: true, sequence: '\x15' }));
    await typeText(h, 'right@example.com');
    await press(h, DOWN);
    await press(h, ENTER);
    expect(h.auth.login).toHaveBeenCalledWith('right@example.com', 'pw');
    await end(h);
  });

  it('empty e-mail: "Type your e-mail address first."; empty password: "Type your password."; no login call', async () => {
    const h = await atForm();
    await press(h, ENTER);
    expect(last(h)).toContain('Type your e-mail address first.');
    await typeText(h, 'user@example.com');
    await press(h, ENTER, ENTER);
    expect(last(h)).toContain('Type your password.');
    expect(h.auth.login).not.toHaveBeenCalled();
    await end(h);
  });

  it('a pasted line break acts as Enter (readline delivers "return")', async () => {
    const h = await atForm();
    await typeText(h, 'user@example.com');
    await press(h, k('return', { sequence: '\r' }));
    await typeText(h, 'pw');
    await press(h, k('return', { sequence: '\r' }));
    expect(h.auth.login).toHaveBeenCalledWith('user@example.com', 'pw');
    await end(h);
  });

  it('q is a letter in the form: it does not quit', async () => {
    const h = await atForm();
    await press(h, k('q'));
    expect(await stillRunning(h.done)).toBe(true);
    await end(h);
  });

  it('"Signing in..." is shown while the login is pending', async () => {
    const pending = deferred<AuthUser>();
    const h = await atPassword();
    h.auth.login.mockReturnValue(pending.promise);
    await typeText(h, 'pw');
    await press(h, ENTER);
    expect(last(h)).toContain('Signing in...');
    pending.resolve(ALICE);
    await ready(h, 'Mail Manager - ');
    await end(h);
  });

  it('success: auth.login event with the user id only, the e-mail remembered, Home opens', async () => {
    const h = await atPassword('Typed.User@Example.com', {
      mailboxes: [account('m1', 'one@example.com')],
    });
    await typeText(h, 'pw');
    await press(h, ENTER);
    await ready(h, `Mail Manager - ${ALICE.email}`);
    await ready(h, 'one@example.com');
    const logins = events(h, 'auth.login');
    expect(logins).toHaveLength(1);
    expect(logins[0]).toMatchObject({ event: 'auth.login', user: ALICE.userId });
    expect(JSON.stringify(logins[0])).not.toContain('example.com');
    expect(h.remembered.list()).toContain(ALICE.email);
    expect(events(h, 'auth.login-failed')).toEqual([]);
    await end(h);
  });

  it('success: the address that is remembered is the one the server returned for the user', async () => {
    const h = await atPassword('user@example.com');
    h.auth.login.mockResolvedValue({ email: 'real.user@example.com', userId: ALICE.userId });
    await typeText(h, 'pw');
    await press(h, ENTER);
    await ready(h, 'Mail Manager - real.user@example.com');
    expect(h.remembered.list()).toContain('real.user@example.com');
    await end(h);
  });

  it.each<[string, () => Error, string, string]>([
    [
      'invalid credentials',
      () => new AuthError('invalid_credentials', 'bad'),
      'invalid-credentials',
      'Wrong e-mail or password - try again.',
    ],
    [
      'unreachable',
      () => new AuthError('unreachable', 'down'),
      'unreachable',
      "Can't reach Mail Manager - check your internet connection and try again.",
    ],
    [
      'unknown',
      () => new AuthError('unknown', 'huh'),
      'unknown',
      "Signing in didn't work - try again later.",
    ],
  ])(
    'failure (%s): auth.login-failed, the form again with the message',
    async (_name, error, reason, message) => {
      const h = await atPassword('user@example.com');
      h.auth.login.mockRejectedValue(error());
      await typeText(h, 'PwCanary-First');
      await press(h, ENTER);
      await ready(h, message);
      const failed = events(h, 'auth.login-failed');
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({ reason, target: TARGET });
      expect(h.loginTarget).toHaveBeenCalledWith('user@example.com');
      expect(events(h, 'auth.login')).toEqual([]);
      // The form is shown again, e-mail kept, password field empty and active.
      expect(last(h)).toContain('user@example.com');
      expect(last(h)).toContain(NOTHING_SHOWN);
      expect(last(h)).not.toContain('PwCanary');
      expect(h.remembered.list()).toEqual([]);
      h.auth.login.mockResolvedValue(ALICE);
      await typeText(h, 'second');
      await press(h, ENTER);
      expect(h.auth.login).toHaveBeenLastCalledWith('user@example.com', 'second');
      await end(h);
    },
  );

  it('a typed e-mail that is not an address: the failed login is logged with target "invalid"', async () => {
    const h = await atPassword('not-an-address');
    h.auth.login.mockRejectedValue(new AuthError('invalid_credentials', 'bad'));
    await typeText(h, 'pw');
    await press(h, ENTER);
    await ready(h, 'Wrong e-mail or password - try again.');
    expect(events(h, 'auth.login-failed')[0]).toMatchObject({ target: 'invalid' });
    expect(JSON.stringify(h.log.records)).not.toContain('not-an-address');
    await end(h);
  });

  it('a fixed e-mail stays fixed after a failure; the password is typed again', async () => {
    const h = makeHarness({ user: null, remembered: [BOB] });
    await ready(h, BOB);
    await press(h, ENTER);
    h.auth.login.mockRejectedValueOnce(new AuthError('invalid_credentials', 'bad'));
    await typeText(h, 'wrong');
    await press(h, ENTER);
    await ready(h, 'Wrong e-mail or password - try again.');
    await typeText(h, 'right');
    await press(h, ENTER);
    expect(h.auth.login).toHaveBeenNthCalledWith(1, BOB, 'wrong');
    expect(h.auth.login).toHaveBeenNthCalledWith(2, BOB, 'right');
    await end(h);
  });

  it('Esc returns to the list and drops what was typed', async () => {
    const h = makeHarness({ user: null, remembered: [BOB] });
    await ready(h, BOB);
    await press(h, DOWN, ENTER);
    await typeText(h, 'drop.me@example.com');
    await press(h, ESC);
    await ready(h, 'Sign in as another user');
    expect(last(h)).not.toContain('drop.me');
    await end(h);
  });
});

describe('AC10 / AC12 the password', () => {
  // Upper-case letters, digits and symbols that no fixed UI text (words, 0.9.0, 40x8, (y/N)) has.
  const PW = 'QWZ7#JX!9~^QZ';

  it('no frame, at any moment of typing, submitting or failing, shows it or part of it', async () => {
    const h = await atPassword('user@example.com');
    h.auth.login.mockRejectedValue(new AuthError('invalid_credentials', 'bad'));
    // Precondition: the canary does not collide with any fixed text on screen.
    const before = last(h);
    for (let i = 0; i + 3 <= PW.length; i++) expect(before).not.toContain(PW.slice(i, i + 3));
    for (const c of PW) {
      await press(h, charKey(c));
    }
    await press(h, ENTER);
    await ready(h, 'Wrong e-mail or password');
    for (const frame of h.t.frames) {
      const all = text(frame);
      for (let i = 0; i + 3 <= PW.length; i++) expect(all).not.toContain(PW.slice(i, i + 3));
    }
    await end(h);
  });

  it('the frames while typing do not depend on how much was typed', async () => {
    const h = await atPassword('user@example.com');
    await press(h, charKey('a'));
    const one = h.t.frames.at(-1)?.lines.join('\n');
    await typeText(h, 'bcdefghijklmnop');
    expect(h.t.frames.at(-1)?.lines.join('\n')).toBe(one);
    await end(h);
  });

  it('AC12: after the submit, whatever the outcome, the password is in no state object', async () => {
    const pending = deferred<AuthUser>();
    const h = await atPassword('user@example.com');
    h.auth.login.mockReturnValue(pending.promise);
    await typeText(h, PW);
    await press(h, ENTER);
    expect(JSON.stringify(h.app.state)).not.toContain(PW);
    expect(JSON.stringify(h.app.state)).not.toContain('PwCanary');
    pending.reject(new AuthError('invalid_credentials', 'bad'));
    await ready(h, 'Wrong e-mail or password');
    expect(JSON.stringify(h.app.state)).not.toContain(PW);
    h.auth.login.mockResolvedValue(ALICE);
    await typeText(h, PW);
    await press(h, ENTER);
    await ready(h, 'Mail Manager - ');
    expect(JSON.stringify(h.app.state)).not.toContain(PW);
    await end(h);
  });

  it('Esc away from a filled form drops the password from the state', async () => {
    const h = await atPassword('user@example.com');
    await typeText(h, PW);
    await press(h, ESC);
    expect(JSON.stringify(h.app.state)).not.toContain(PW);
    await end(h);
  });
});

// --- AC13: switch user ----------------------------------------------------------------------

describe('AC13 switching user', () => {
  it('asks "Sign out <e-mail> first? (y/N)"; any other key goes back and sends nothing', async () => {
    const h = await atPick({ remembered: [BOB] });
    await press(h, DOWN, ENTER);
    expect(last(h)).toContain(`Sign out ${ALICE.email} first? (y/N)`);
    await press(h, k('n'));
    expect(last(h)).not.toContain('first? (y/N)');
    expect(last(h)).toContain('Sign in as another user');
    expect(h.auth.logout).not.toHaveBeenCalled();
    expect(events(h, 'auth.logout')).toEqual([]);
    await press(h, ENTER);
    await press(h, ENTER);
    expect(h.auth.logout).not.toHaveBeenCalled();
    await end(h);
  });

  it('y: auth.logout(), the auth.logout event, then the form for the chosen row', async () => {
    const h = await atPick({ remembered: [BOB, CAROL] });
    await press(h, DOWN, DOWN, ENTER);
    await press(h, k('y'));
    await ready(h, NOTHING_SHOWN);
    expect(h.auth.logout).toHaveBeenCalledTimes(1);
    expect(events(h, 'auth.logout')).toEqual([expect.objectContaining({ outcome: 'logged-out' })]);
    expect(last(h)).toContain(CAROL);
    h.auth.login.mockResolvedValue({ email: CAROL, userId: 'user-carol' });
    await typeText(h, 'pw');
    await press(h, ENTER);
    expect(h.auth.login).toHaveBeenCalledWith(CAROL, 'pw');
    await end(h);
  });

  it('"Signing out..." is shown while the sign-out is pending', async () => {
    const pending = deferred<LogoutResult>();
    const h = await atPick({ remembered: [BOB] });
    h.auth.logout.mockReturnValue(pending.promise);
    await press(h, DOWN, ENTER, k('y'));
    expect(last(h)).toContain('Signing out...');
    pending.resolve('logged-out');
    await ready(h, NOTHING_SHOWN);
    await end(h);
  });

  it('the last row after the sign-out: an empty e-mail field', async () => {
    const h = await atPick({ remembered: [BOB] });
    await press(h, DOWN, DOWN, ENTER, k('y'));
    await ready(h, NOTHING_SHOWN);
    await typeText(h, 'brand.new@example.com');
    await press(h, ENTER);
    await typeText(h, 'pw');
    await press(h, ENTER);
    expect(h.auth.login).toHaveBeenCalledWith('brand.new@example.com', 'pw');
    await end(h);
  });

  it('the sign-out worked, the new sign-in fails: nobody is signed in, the old user stays as a remembered row', async () => {
    const h = await atPick({ remembered: [BOB] });
    await press(h, DOWN, ENTER, k('y'));
    await ready(h, NOTHING_SHOWN);
    h.auth.login.mockRejectedValue(new AuthError('invalid_credentials', 'bad'));
    await typeText(h, 'wrong');
    await press(h, ENTER);
    await ready(h, 'Wrong e-mail or password - try again.');
    await press(h, ESC);
    await ready(h, 'Sign in as another user');
    expect(last(h)).not.toContain('signed in');
    expect(last(h)).toContain(ALICE.email);
    expect(last(h)).toContain(BOB);
    await end(h);
  });
});

// --- AC14: forget ---------------------------------------------------------------------------

describe('AC14 forgetting an address', () => {
  it('f asks "Forget <e-mail>? (y/N)"; y removes it from the store and from the list', async () => {
    const h = makeHarness({ user: null, remembered: [BOB, CAROL] });
    await ready(h, BOB);
    await press(h, k('f'));
    expect(last(h)).toContain(`Forget ${BOB}? (y/N)`);
    await press(h, k('y'));
    await vi.waitFor(() => {
      expect(last(h)).not.toContain(BOB);
    });
    expect(h.remembered.list()).toEqual([CAROL]);
    expect(last(h)).toContain(CAROL);
    await end(h);
  });

  it('any other key keeps the address', async () => {
    const h = makeHarness({ user: null, remembered: [BOB, CAROL] });
    await ready(h, BOB);
    await press(h, k('f'), k('n'));
    expect(h.remembered.list()).toEqual([BOB, CAROL]);
    expect(last(h)).toContain(BOB);
    await press(h, k('f'), ENTER);
    expect(h.remembered.list()).toEqual([BOB, CAROL]);
    await end(h);
  });

  it('on the signed-in row: "Log out first to forget this address."', async () => {
    const h = await atPick({ remembered: [BOB] });
    await press(h, k('f'));
    expect(last(h)).toContain('Log out first to forget this address.');
    expect(h.remembered.list()).toContain(ALICE.email);
    await end(h);
  });

  it('on the last row: nothing', async () => {
    const h = makeHarness({ user: null, remembered: [BOB] });
    await ready(h, BOB);
    await press(h, DOWN, k('f'));
    expect(last(h)).not.toContain('(y/N)');
    expect(h.remembered.list()).toEqual([BOB]);
    await end(h);
  });

  it('forgetting the only address leaves the list with the single row "Sign in"', async () => {
    const h = makeHarness({ user: null, remembered: [BOB] });
    await ready(h, BOB);
    await press(h, k('f'), k('y'));
    await vi.waitFor(() => {
      expect(last(h)).not.toContain(BOB);
    });
    expect(h.remembered.list()).toEqual([]);
    await end(h);
  });
});

// --- Home: AC16-AC20 ------------------------------------------------------------------------

describe('AC16 Home loads the mailboxes', () => {
  it('"Loading your mailboxes..." until the list arrives, then a row per mailbox and the actions', async () => {
    const pending = deferred<readonly MailAccount[]>();
    const h = await atPick();
    h.listMailboxes.mockReturnValue(pending.promise);
    await press(h, ENTER);
    expect(last(h)).toContain('Loading your mailboxes...');
    expect(last(h)).toContain(`Mail Manager - ${ALICE.email}`);
    pending.resolve([
      account('m1', 'one@example.com', 'websupport', new Date(2026, 8, 30, 14, 5)),
      account('m2', 'two@example.com'),
    ]);
    await ready(h, 'one@example.com');
    expect(last(h)).not.toContain('Loading your mailboxes...');
    expect(last(h)).toContain('two@example.com');
    expect(last(h)).toContain('checked 2026-09-30 14:05');
    expect(last(h)).toContain('checked never');
    expect(last(h)).toContain('+ Add a mailbox');
    expect(last(h)).toContain('Log out');
    await end(h);
  });

  it('no mailboxes: "No mailboxes yet - add your first one."', async () => {
    const h = await atPick({ mailboxes: [] });
    await press(h, ENTER);
    await ready(h, 'No mailboxes yet - add your first one.');
    await end(h);
  });
});

describe('AC17 Enter on a mailbox, Add or Logs', () => {
  it.each<[string, number, string]>([
    ['a mailbox', 0, 'Connecting...'],
    ['+ Add a mailbox', 1, 'Mail Manager - Add a mailbox'],
    ['Logs', 2, 'Mail Manager - Logs'],
  ])('%s', async (_name, downs, message) => {
    const h = await atHome();
    for (let i = 0; i < downs; i++) await press(h, DOWN);
    await press(h, ENTER);
    expect(last(h)).toContain(message);
    expect(h.auth.logout).not.toHaveBeenCalled();
    expect(h.listMailboxes).toHaveBeenCalledTimes(1);
    expect(await stillRunning(h.done)).toBe(true);
    await end(h);
  });
});

describe('AC18 Log out', () => {
  it('"Signing out...", then auth.logout(), the event, and the sign-in list with the e-mail no longer tagged', async () => {
    const pending = deferred<LogoutResult>();
    const h = await atHome({ remembered: [BOB] });
    h.auth.logout.mockReturnValue(pending.promise);
    await press(h, DOWN, DOWN, DOWN, ENTER);
    expect(last(h)).toContain('Signing out...');
    expect(h.auth.logout).toHaveBeenCalledTimes(1);
    pending.resolve('logged-out');
    await ready(h, 'Sign in as another user');
    expect(last(h)).toContain(ALICE.email);
    expect(last(h)).toContain(BOB);
    expect(last(h)).not.toContain('signed in');
    expect(events(h, 'auth.logout')).toEqual([expect.objectContaining({ outcome: 'logged-out' })]);
    await end(h);
  });

  it('after the log out, Enter on the address asks for the password (nobody is signed in)', async () => {
    const h = await atHome();
    await press(h, DOWN, DOWN, DOWN, ENTER);
    await ready(h, 'Sign in as another user');
    await press(h, ENTER);
    await ready(h, NOTHING_SHOWN);
    expect(last(h)).toContain(ALICE.email);
    await end(h);
  });

  it('the not-logged-in outcome of the service is written to the event', async () => {
    const h = await atHome();
    h.auth.logout.mockResolvedValue('not-logged-in');
    await press(h, DOWN, DOWN, DOWN, ENTER);
    await ready(h, 'Sign in as another user');
    expect(events(h, 'auth.logout')).toEqual([
      expect.objectContaining({ outcome: 'not-logged-in' }),
    ]);
    await end(h);
  });
});

describe('AC19 the mailbox list fails to load', () => {
  it('the session is gone: the sign-in list with "Your sign-in has ended - sign in again."', async () => {
    const h = await atPick({ remembered: [BOB] });
    h.listMailboxes.mockRejectedValue(new Error('jwt expired'));
    h.auth.currentUser.mockResolvedValue(null);
    await press(h, ENTER);
    await ready(h, 'Your sign-in has ended - sign in again.');
    expect(last(h)).toContain('Sign in as another user');
    expect(last(h)).not.toContain('signed in');
    await end(h);
  });

  it('otherwise: "Couldn\'t load your mailboxes - ..." and r loads again', async () => {
    const h = await atPick();
    h.listMailboxes
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue([account('m1', 'one@example.com')]);
    await press(h, ENTER);
    await ready(
      h,
      "Couldn't load your mailboxes - check your internet connection (r = try again).",
    );
    await press(h, k('r'));
    await ready(h, 'one@example.com');
    expect(h.listMailboxes).toHaveBeenCalledTimes(2);
    expect(last(h)).not.toContain("Couldn't load your mailboxes");
    await end(h);
  });
});

describe('AC20 leaving Home', () => {
  it.each<[string, Keypress]>([
    ['Esc', ESC],
    ['Left', LEFT],
    ['Backspace', BACKSPACE],
  ])('%s: the sign-in list, still signed in, no sign-out', async (_name, key) => {
    const h = await atHome();
    await press(h, key);
    await ready(h, 'Sign in as another user');
    expect(last(h)).toContain('signed in');
    expect(h.auth.logout).not.toHaveBeenCalled();
    expect(events(h, 'auth.logout')).toEqual([]);
    await end(h);
  });

  it('q quits with end "quit"', async () => {
    const h = await atHome();
    h.t.key(k('q'));
    await expect(h.done).resolves.toMatchObject({ end: 'quit' });
  });

  it('q quits from the sign-in list', async () => {
    const h = await atPick();
    h.t.key(k('q'));
    await expect(h.done).resolves.toMatchObject({ end: 'quit' });
  });

  it('Home again from the list: Enter on the signed-in row loads the mailboxes again, no login', async () => {
    const h = await atHome();
    await press(h, ESC);
    await ready(h, 'Sign in as another user');
    await press(h, ENTER);
    await ready(h, 'one@example.com');
    expect(h.listMailboxes).toHaveBeenCalledTimes(2);
    expect(h.auth.login).not.toHaveBeenCalled();
    await end(h);
  });
});

// --- AC21: Ctrl+C ---------------------------------------------------------------------------

describe('AC21 Ctrl+C ends at once in every mode', () => {
  it('while checking the session', async () => {
    const h = makeHarness();
    h.t.key(CTRL_C);
    await expect(h.done).resolves.toMatchObject({ end: 'interrupt' });
  });

  it('on the list, in the form, at a question', async () => {
    const list = await atPick({ remembered: [BOB] });
    list.t.key(CTRL_C);
    await expect(list.done).resolves.toMatchObject({ end: 'interrupt' });

    const form = await atForm();
    form.t.key(CTRL_C);
    await expect(form.done).resolves.toMatchObject({ end: 'interrupt' });

    const asked = await atPick({ remembered: [BOB] });
    await press(asked, DOWN, ENTER);
    expect(last(asked)).toContain('first? (y/N)');
    asked.t.key(CTRL_C);
    await expect(asked.done).resolves.toMatchObject({ end: 'interrupt' });
  });

  it('while signing in', async () => {
    const h = await atPassword();
    h.auth.login.mockReturnValue(new Promise<AuthUser>(() => undefined));
    await typeText(h, 'pw');
    await press(h, ENTER);
    expect(last(h)).toContain('Signing in...');
    h.t.key(CTRL_C);
    await expect(h.done).resolves.toMatchObject({ end: 'interrupt' });
  });

  it('while loading the mailboxes', async () => {
    const h = await atPick();
    h.listMailboxes.mockReturnValue(new Promise<readonly MailAccount[]>(() => undefined));
    await press(h, ENTER);
    expect(last(h)).toContain('Loading your mailboxes...');
    h.t.key(CTRL_C);
    await expect(h.done).resolves.toMatchObject({ end: 'interrupt' });
  });

  it('while too small', async () => {
    const h = makeHarness({ screen: SMALL });
    expect(last(h)).toMatch(/too small/i);
    h.t.key(CTRL_C);
    await expect(h.done).resolves.toMatchObject({ end: 'interrupt' });
  });

  it('while signing out: the app ends at once, but the sign-out is still finished (settled)', async () => {
    const pending = deferred<LogoutResult>();
    const h = await atHome();
    h.auth.logout.mockReturnValue(pending.promise);
    await press(h, DOWN, DOWN, DOWN, ENTER);
    expect(last(h)).toContain('Signing out...');
    h.t.key(CTRL_C);
    await expect(h.done).resolves.toMatchObject({ end: 'interrupt' });
    // Not finished yet: settled() waits for the sign-out.
    expect(await stillRunning(h.app.settled())).toBe(true);
    expect(events(h, 'auth.logout')).toEqual([]);
    pending.resolve('logged-out');
    await h.app.settled();
    expect(events(h, 'auth.logout')).toEqual([expect.objectContaining({ outcome: 'logged-out' })]);
  });

  it('while signing out for a user switch: settled() also waits for it', async () => {
    const pending = deferred<LogoutResult>();
    const h = await atPick({ remembered: [BOB] });
    h.auth.logout.mockReturnValue(pending.promise);
    await press(h, DOWN, ENTER, k('y'));
    expect(last(h)).toContain('Signing out...');
    h.t.key(CTRL_C);
    await h.done;
    expect(await stillRunning(h.app.settled())).toBe(true);
    pending.resolve('logged-out');
    await h.app.settled();
    expect(events(h, 'auth.logout')).toHaveLength(1);
  });

  it('settled() resolves at once when no sign-out was in flight', async () => {
    const h = await atPick();
    h.t.key(CTRL_C);
    await h.done;
    await expect(h.app.settled()).resolves.toBeUndefined();
  });

  it('settled() never rejects, even when the sign-out fails', async () => {
    const pending = deferred<LogoutResult>();
    const h = await atHome();
    h.auth.logout.mockReturnValue(pending.promise);
    await press(h, DOWN, DOWN, DOWN, ENTER);
    h.t.key(CTRL_C);
    await h.done;
    pending.reject(new Error('server down'));
    await expect(h.app.settled()).resolves.toBeUndefined();
  });

  it('after the end every key and resize is a no-op', async () => {
    const h = await atPick();
    h.t.key(CTRL_C);
    await h.done;
    const frames = h.t.frames.length;
    h.t.key(DOWN);
    h.t.key(ENTER);
    h.t.resize();
    await settle();
    expect(h.t.frames).toHaveLength(frames);
    expect(h.listMailboxes).not.toHaveBeenCalled();
  });
});

// --- AC22: frames ---------------------------------------------------------------------------

describe('AC22 resize', () => {
  it('a resize redraws at the new size', async () => {
    const h = await atPick();
    h.t.screen = { rows: 30, cols: 120 };
    h.t.resize();
    await settle();
    expect(h.t.frames.at(-1)?.lines).toHaveLength(30);
    for (const line of h.t.frames.at(-1)?.lines ?? []) expect(line).toHaveLength(120);
    await end(h);
  });

  it('below 40x8 only "Window too small" is shown; above again, the screen is back', async () => {
    const h = await atPick();
    h.t.screen = { rows: 7, cols: 39 };
    h.t.resize();
    await settle();
    expect(last(h)).toContain('Window too small - need at least 40x8');
    expect(last(h)).not.toContain(ALICE.email);
    h.t.screen = SCREEN;
    h.t.resize();
    await settle();
    expect(last(h)).toContain(ALICE.email);
    expect(last(h)).not.toMatch(/too small/i);
    await end(h);
  });

  it('while too small Enter does not open Home and nothing is typed into a form', async () => {
    const h = await atPick();
    h.t.screen = SMALL;
    h.t.resize();
    await settle();
    await press(h, ENTER, DOWN);
    expect(h.listMailboxes).not.toHaveBeenCalled();
    await end(h);

    const form = await atForm();
    form.t.screen = SMALL;
    form.t.resize();
    await settle();
    await typeText(form, 'hidden@example.com');
    form.t.screen = SCREEN;
    form.t.resize();
    await settle();
    expect(last(form)).not.toContain('hidden@example.com');
    await end(form);
  });

  it('while too small q still quits from a list', async () => {
    const h = await atPick();
    h.t.screen = SMALL;
    h.t.resize();
    await settle();
    h.t.key(k('q'));
    await expect(h.done).resolves.toMatchObject({ end: 'quit' });
  });

  it('while too small a pending question is shown and can be answered', async () => {
    const user: AuthUser = { email: 'a@b.co', userId: ALICE.userId };
    const h = await atPick({ user, remembered: ['c@d.co'] });
    await press(h, DOWN, ENTER);
    expect(last(h)).toContain('Sign out a@b.co first? (y/N)');
    h.t.screen = { rows: 7, cols: 39 };
    h.t.resize();
    await settle();
    expect(last(h)).toContain('Window too small - need at least 40x8');
    expect(last(h)).toContain('Sign out a@b.co first? (y/N)');
    await press(h, k('y'));
    expect(h.auth.logout).toHaveBeenCalledTimes(1);
    h.t.screen = SCREEN;
    h.t.resize();
    await ready(h, NOTHING_SHOWN);
    await end(h);
  });
});

// --- AC24: late results ---------------------------------------------------------------------

describe('AC24 results that arrive late change nothing', () => {
  it('a session check that resolves after the app ended: no draw', async () => {
    const pending = deferred<AuthUser | null>();
    const h = makeHarness({ currentUser: () => pending.promise });
    h.t.key(CTRL_C);
    await h.done;
    const frames = h.t.frames.length;
    pending.resolve(ALICE);
    await settle();
    expect(h.t.frames).toHaveLength(frames);
  });

  it('a login that resolves after the app ended: no draw', async () => {
    const pending = deferred<AuthUser>();
    const h = await atPassword();
    h.auth.login.mockReturnValue(pending.promise);
    await typeText(h, 'pw');
    await press(h, ENTER);
    h.t.key(CTRL_C);
    await h.done;
    const frames = h.t.frames.length;
    pending.resolve(ALICE);
    await settle();
    expect(h.t.frames).toHaveLength(frames);
  });

  it('a login that fails after the app ended: no draw', async () => {
    const pending = deferred<AuthUser>();
    const h = await atPassword();
    h.auth.login.mockReturnValue(pending.promise);
    await typeText(h, 'pw');
    await press(h, ENTER);
    h.t.key(CTRL_C);
    await h.done;
    const frames = h.t.frames.length;
    pending.reject(new AuthError('invalid_credentials', 'bad'));
    await settle();
    expect(h.t.frames).toHaveLength(frames);
  });

  it('a mailbox list that arrives after the app ended: no draw; one that fails after it: no draw', async () => {
    for (const fail of [false, true]) {
      const pending = deferred<readonly MailAccount[]>();
      const h = await atPick();
      h.listMailboxes.mockReturnValue(pending.promise);
      await press(h, ENTER);
      h.t.key(CTRL_C);
      await h.done;
      const frames = h.t.frames.length;
      if (fail) pending.reject(new Error('late'));
      else pending.resolve([account('m1', 'one@example.com')]);
      await settle();
      expect(h.t.frames).toHaveLength(frames);
    }
  });

  it('Esc while the mailboxes load: the late list is dropped, the sign-in list stays', async () => {
    const pending = deferred<readonly MailAccount[]>();
    const h = await atPick();
    h.listMailboxes.mockReturnValue(pending.promise);
    await press(h, ENTER);
    await press(h, ESC);
    await ready(h, 'Sign in as another user');
    pending.resolve([account('m1', 'late.mailbox@example.com')]);
    await settle();
    expect(last(h)).toContain('Sign in as another user');
    expect(last(h)).not.toContain('late.mailbox@example.com');
    expect(h.app.state.view.kind).toBe('sign-in');
    await end(h);
  });

  it('Esc while loading, then a late failure: no message, still the sign-in list', async () => {
    const pending = deferred<readonly MailAccount[]>();
    const h = await atPick();
    h.listMailboxes.mockReturnValue(pending.promise);
    await press(h, ENTER, ESC);
    await ready(h, 'Sign in as another user');
    pending.reject(new Error('late'));
    await settle();
    expect(last(h)).not.toContain("Couldn't load your mailboxes");
    expect(last(h)).not.toContain('Your sign-in has ended');
    await end(h);
  });
});

// --- AC25: errors ---------------------------------------------------------------------------

describe('AC25 an unexpected error', () => {
  it('a throwing draw rejects run() (the command restores the screen and reports it)', async () => {
    const h = await atPick();
    h.t.failDraw = new Error('terminal gone');
    h.t.key(DOWN);
    await expect(h.done).rejects.toThrow('terminal gone');
  });

  it('a draw that throws on the very first frame rejects run()', async () => {
    const h = makeHarness({ failDraw: new Error('terminal gone') });
    await expect(h.done).rejects.toThrow('terminal gone');
  });
});

// --- AC26: nothing private in the log -------------------------------------------------------

describe('AC26 the log', () => {
  const TYPED_EMAIL = 'typed.canary@example-test-domain.eu';
  const PW_1 = 'PwCanary-One-48151';
  const PW_2 = 'PwCanary-Two-62342';
  const REAL_EMAIL = 'real.canary@example-test-domain.eu';

  it('across a failed and a successful sign-in, a log out and a quit: only the auth events, no e-mail, no password', async () => {
    const h = await atForm({ mailboxes: [] });
    h.auth.login.mockRejectedValueOnce(new AuthError('invalid_credentials', 'bad'));
    h.auth.login.mockResolvedValue({ email: REAL_EMAIL, userId: ALICE.userId });
    await typeText(h, TYPED_EMAIL);
    await press(h, ENTER);
    await typeText(h, PW_1);
    await press(h, ENTER);
    await ready(h, 'Wrong e-mail or password - try again.');
    await typeText(h, PW_2);
    await press(h, ENTER);
    await ready(h, `Mail Manager - ${REAL_EMAIL}`);
    await ready(h, 'No mailboxes yet');
    await press(h, DOWN, DOWN, ENTER);
    await ready(h, 'Sign in as another user');
    h.t.key(k('q'));
    await expect(h.done).resolves.toMatchObject({ end: 'quit' });

    expect(h.log.records.map((r) => r.event)).toEqual([
      'auth.login-failed',
      'auth.login',
      'auth.logout',
    ]);
    const all = JSON.stringify(h.log.records) + h.log.lines.join('\n');
    for (const needle of [
      TYPED_EMAIL,
      'typed.canary',
      PW_1,
      PW_2,
      'PwCanary',
      REAL_EMAIL,
      'real.canary',
      'example-test-domain',
    ]) {
      expect(all).not.toContain(needle);
    }
    expect(JSON.stringify(h.app.state)).not.toContain('PwCanary');
  });
});
