import { afterEach, describe, it, expect, vi } from 'vitest';
import { createApp } from '../../src/cli/app/controller.js';
import type { App, AppDeps, AppResult, MailboxSession } from '../../src/cli/app/controller.js';
import { reduceApp } from '../../src/cli/app/reduce.js';
import { renderApp } from '../../src/cli/app/render.js';
import { homeView, initialApp, mailboxView, pickView } from '../../src/cli/app/state.js';
import type { AppState, MailboxMode, MailboxRow } from '../../src/cli/app/state.js';
import { CHALLENGE_NOTICE } from '../../src/cli/browser/controller.js';
import type { Rendered } from '../../src/cli/browser/render.js';
import type { Keypress, Screen } from '../../src/cli/browser/state.js';
import type { Terminal } from '../../src/cli/browser/terminal.js';
import { AccountError, createLocalGuard, openAccountSession } from '../../src/core/accounts.js';
import type { AuthUser, LogoutResult } from '../../src/core/auth.js';
import { LocalCredentialProvider } from '../../src/core/credentials.js';
import type { MailAccount } from '../../src/core/db/repos.js';
import { ImapSessionError } from '../../src/core/imap/errors.js';
import type { ImapSession } from '../../src/core/imap/session.js';
import { MemoryEventLog } from '../../src/core/log/index.js';
import type { LogRecord } from '../../src/core/log/index.js';
import type { FolderInfo, FolderTree } from '../../src/core/mailbox/folders.js';
import type { PageResult, loadPage } from '../../src/core/mailbox/messages.js';
import { MemoryRememberedUsers } from '../../src/core/remembered-users.js';

// The order of mailbox logins in the app controller (M2d-3, follow-up of C-031): the logins of
// one saved mailbox run one after another, and one whose turn comes after its visit was left or
// after the app ended is not made. Every case runs twice: with a fake openSession, and with
// what `mm app` wires - the real login guard and openAccountSession around a fake mail server.
// Also the guard's wait: its notice gives way to "Connecting..." when the login starts, and
// every wait still pending ends with the app. A fake Terminal and a MemoryEventLog; no Supabase,
// no IMAP, no real terminal. Addresses and hosts are placeholders.

// --- fixtures -------------------------------------------------------------------------------

const SCREEN: Screen = { rows: 24, cols: 100 };
const ANNA: AuthUser = {
  email: 'anna@example-test-domain.eu',
  userId: '11111111-1111-4111-8111-111111111111',
};
const BOX_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOX_2_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BOX_EMAIL = 'one@example-test-domain.eu';
const BOX_2_EMAIL = 'two@example-test-domain.eu';
const HOST = 'imap.example-test-domain.eu';
const T0 = Date.UTC(2026, 9, 7, 9, 0, 0);
const HOME_ROW = '+ Add a mailbox';
/** Reads the saved passwords below: the real login decrypts them. */
const CREDENTIALS = new LocalCredentialProvider({
  masterKey: Buffer.alloc(32, 7),
  masterKeyVersion: 1,
});

const k = (name: string, extra: Keypress = {}): Keypress => ({ name, sequence: name, ...extra });
const ENTER = k('return', { sequence: '\r' });
const UP = k('up', { sequence: '\u001b[A' });
const DOWN = k('down', { sequence: '\u001b[B' });
const ESC = k('escape', { meta: true, sequence: '\u001b' });
const CTRL_C = k('c', { ctrl: true, sequence: '\u0003' });
const ch = (text: string): Keypress => ({ name: text.toLowerCase(), sequence: text });

/** A saved mailbox whose username is its address. */
function account(id: string, email: string): MailAccount {
  return {
    id,
    userId: ANNA.userId,
    label: null,
    email,
    provider: 'websupport',
    host: HOST,
    port: 993,
    username: email,
    authType: 'password',
    secret: CREDENTIALS.encryptPassword(
      { userId: ANNA.userId, accountId: id, host: HOST, port: 993, username: email },
      'pw-1',
    ),
    capabilities: null,
    createdAt: new Date(T0),
    updatedAt: new Date(T0),
    lastCheckedAt: null,
  };
}

const BOX = account(BOX_ID, BOX_EMAIL);
const BOX_2 = account(BOX_2_ID, BOX_2_EMAIL);

function folder(path: string): FolderInfo {
  return {
    path,
    name: path,
    parentPath: null,
    depth: 0,
    delimiter: '/',
    role: null,
    roleSource: null,
    selectable: true,
    subscribed: true,
    messages: 2,
    unseen: 0,
    bytes: 1000,
    sizeSource: 'server',
    overlapping: false,
  };
}

const TREE: FolderTree = {
  folders: [folder('INBOX'), folder('Sent')],
  totals: { messages: 4, unseen: 0, bytes: 2000, sizeSource: 'server' },
  quota: null,
  truncated: false,
  unreadable: 0,
  gmailAllHidden: false,
  fallbacks: new Set(),
};

/** Two mails in every folder. */
function pageOf(path: string): PageResult {
  const rows = [2, 1].map((seq) => ({
    seq,
    uid: 1000 + seq,
    received: new Date(T0),
    from: 'Sender',
    subject: `Subject ${String(seq)}`,
    bytes: 100,
    attachment: false,
  }));
  return { kind: 'page', snapshot: { path, uidValidity: '7', exists: 2 }, page: 0, rows };
}

// --- fakes ----------------------------------------------------------------------------------

interface FakeTerminal extends Terminal {
  readonly frames: Rendered[];
  failDraw: Error | null;
  key(key: Keypress): void;
}

function fakeTerminal(): FakeTerminal {
  let keyHandler: ((key: Keypress) => void) | null = null;
  const t: FakeTerminal = {
    frames: [],
    failDraw: null,
    size: () => SCREEN,
    draw: (frame) => {
      if (t.failDraw !== null) throw t.failDraw;
      t.frames.push(frame);
    },
    clear: () => undefined,
    onKey: (fn) => {
      keyHandler = fn;
    },
    onResize: () => undefined,
    restore: vi.fn(),
    close: vi.fn(),
    key: (key) => {
      if (keyHandler === null) throw new Error('no key handler registered');
      keyHandler(key);
    },
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

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function stillRunning(p: Promise<unknown>): Promise<boolean> {
  return Promise.race([p.then(() => false), settle().then(() => true)]);
}

type FakeSession = MailboxSession & {
  name: string;
  logout: ReturnType<typeof vi.fn<() => Promise<void>>>;
};
type ListFolders = NonNullable<AppDeps['listFolders']>;
/** What the mail server answers to one login of the mailbox `email`. */
type Answer = (email: string) => Promise<FakeSession>;

interface Harness {
  t: FakeTerminal;
  app: App;
  done: Promise<AppResult>;
  log: MemoryEventLog;
  /** In order: `login` (one that reached the mail server), `logout:<name>`. */
  calls: string[];
  /** A session of its own name, with a logout spy. */
  session(name: string): FakeSession;
  /** The next login that reaches the mail server gets this answer, once. */
  nextLogin(answer: Answer): void;
  /** Every other login: a new session at once (s1, s2, ...) unless a test sets its own. */
  answer: Answer;
  findAccount: ReturnType<typeof vi.fn<AppDeps['findAccount']>>;
  /** `deps.openSession`: the mail server itself, or the real guarded login around it. */
  openSession: ReturnType<typeof vi.fn<AppDeps['openSession']>>;
  /** The mail server: one call per login that was really made, with the mailbox's address. */
  server: ReturnType<typeof vi.fn<Answer>>;
  listFolders: ReturnType<typeof vi.fn<ListFolders>>;
  onUnexpected: ReturnType<typeof vi.fn<(err: unknown) => void>>;
}

interface Options {
  /** As `mm app`: one real login guard for the run, openAccountSession, the fake server below it. */
  guarded?: boolean;
}

/** Both ways a login is made in these tests. */
const KINDS: [string, Options][] = [
  ['fake logins', {}],
  ['the real login guard', { guarded: true }],
];

function makeHarness(o: Options = {}): Harness {
  const t = fakeTerminal();
  const calls: string[] = [];
  const answers: Answer[] = [];
  let made = 0;
  const session = (name: string): FakeSession =>
    ({
      name,
      client: {},
      features: {},
      closed: false,
      logout: vi.fn<() => Promise<void>>(() => {
        calls.push(`logout:${name}`);
        return Promise.resolve();
      }),
    }) as unknown as FakeSession;
  const log = new MemoryEventLog({
    run: '0123456789abcdef',
    ver: '0.9.0',
    now: () => T0,
    level: 'debug',
  });
  const server = vi.fn<Answer>((email) => {
    calls.push('login');
    return (answers.shift() ?? h.answer)(email);
  });
  const guard = createLocalGuard(undefined, log);
  const openSession = vi.fn<AppDeps['openSession']>((mailbox, onChallenge) =>
    o.guarded === true
      ? openAccountSession(
          {
            credentials: CREDENTIALS,
            guard,
            log,
            clientVersion: '0.9.0',
            onChallenge,
            open: async ({ settings }) =>
              (await server(settings.username)) as unknown as ImapSession,
          },
          mailbox,
        )
      : server(mailbox.email),
  );
  const findAccount = vi.fn<AppDeps['findAccount']>((id) => {
    const found = [BOX, BOX_2].find((m) => m.id === id);
    return found === undefined
      ? Promise.reject(new AccountError('not-found'))
      : Promise.resolve(found);
  });
  const listFolders = vi.fn<ListFolders>(() => Promise.resolve(TREE));
  const load = vi.fn<typeof loadPage>((_s, path) => Promise.resolve(pageOf(path)));
  const onUnexpected = vi.fn<(err: unknown) => void>();
  const app = createApp({
    terminal: t,
    version: '0.9.0',
    auth: {
      currentUser: () => Promise.resolve(ANNA),
      login: () => Promise.resolve(ANNA),
      logout: (): Promise<LogoutResult> => Promise.resolve('logged-out'),
    },
    listMailboxes: () => Promise.resolve([BOX, BOX_2]),
    remembered: new MemoryRememberedUsers([ANNA.email]),
    log,
    loginTarget: () => 'ab'.repeat(32),
    onUnexpected,
    findAccount,
    openSession,
    listFolders,
    load,
    readLogs: NO_LOGS,
    ...NO_ADD,
    autoStats: false,
  });
  const h: Harness = {
    t,
    app,
    done: app.run(),
    log,
    calls,
    session,
    nextLogin: (answer) => {
      answers.push(answer);
    },
    answer: () => {
      made += 1;
      return Promise.resolve(session(`s${String(made)}`));
    },
    findAccount,
    openSession,
    server,
    listFolders,
    onUnexpected,
  };
  return h;
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

async function shown(h: Harness, needle: string): Promise<void> {
  await vi.waitFor(() => {
    expect(last(h)).toContain(needle);
  });
}

function events(h: Harness, name: string): LogRecord[] {
  return h.log.records.filter((r) => r.event === name);
}

const count = (h: Harness, name: string): number => events(h, name).length;
/** What the app itself logged: everything but the guard's security lines. */
const appEvents = (h: Harness): string[] =>
  h.log.records.map((r) => r.event).filter((name) => !/^(imap\.login|login-guard\.)/.test(name));
const logouts = (h: Harness, name: string): number =>
  h.calls.filter((c) => c === `logout:${name}`).length;
/** How many `imap.login` lines `n` logins that worked leave: the fake logins write none. */
const loginLines = (o: Options, n: number): number => (o.guarded === true ? n : 0);

/** Ctrl+C (unless it has ended), then everything that was still under way. */
async function quit(h: Harness): Promise<void> {
  h.t.key(CTRL_C);
  await h.done.catch(() => undefined);
  await h.app.settled();
}

/** ANNA on Home with her two mailboxes listed, the cursor on the first. */
async function atHome(o: Options = {}): Promise<Harness> {
  const h = makeHarness(o);
  await settle();
  await shown(h, 'Sign in as another user');
  await press(h, ENTER);
  await shown(h, HOME_ROW);
  return h;
}

/**
 * A slow mail server and an impatient user: Enter / Esc four times on the first mailbox, then
 * Enter. The first login is under way (the test answers it), three visits were left while they
 * waited for their turn, the fifth is on screen.
 */
async function impatient(o: Options): Promise<{ h: Harness; first: Deferred<FakeSession> }> {
  const h = await atHome(o);
  const first = deferred<FakeSession>();
  h.nextLogin(() => first.promise);
  for (let i = 0; i < 4; i++) {
    await press(h, ENTER);
    expect(last(h)).toContain('Connecting...');
    await press(h, ESC);
    expect(last(h)).toContain(HOME_ROW);
  }
  await press(h, ENTER);
  expect(last(h)).toContain('Connecting...');
  return { h, first };
}

/** The next `deps.openSession` waits for the guard first, as a guarded login does. */
function challenged(h: Harness): void {
  h.openSession.mockImplementationOnce(async (mailbox, onChallenge) => {
    await onChallenge();
    return h.server(mailbox.email);
  });
}

afterEach(() => {
  vi.useRealTimers();
});

// --- one mailbox, opened again and again ----------------------------------------------------

describe.each(KINDS)('a mailbox opened again while its login is slow - %s', (_kind, o) => {
  it('Enter / Esc four times, then Enter: one login while the first is under way, then exactly one more', async () => {
    const { h, first } = await impatient(o);
    expect(h.findAccount).toHaveBeenCalledTimes(5);
    expect(h.openSession).toHaveBeenCalledTimes(1);
    expect(h.server.mock.calls).toEqual([[BOX_EMAIL]]);
    // Nothing starts by itself while the first login is under way.
    await settle();
    await settle();
    expect(h.openSession).toHaveBeenCalledTimes(1);

    first.resolve(h.session('late'));
    await shown(h, 'Total:');
    expect(h.openSession).toHaveBeenCalledTimes(2);
    expect(h.openSession.mock.calls.map(([mailbox]) => mailbox)).toEqual([BOX, BOX]);
    // The session nobody waits for is logged out as it arrives; then the visit on screen logs in.
    expect(h.calls).toEqual(['login', 'logout:late', 'login']);
    // Its folders are the only ones read, and the only thing logged.
    expect(h.listFolders.mock.calls.map(([s]) => (s as FakeSession).name)).toEqual(['s1']);
    expect(appEvents(h)).toEqual(['folders.list']);
    expect(events(h, 'folders.list')).toEqual([
      expect.objectContaining({ acct: BOX_ID, folders: 2, outcome: 'ok' }),
    ]);
    expect(count(h, 'imap.login')).toBe(loginLines(o, 2));
    expect(last(h)).toContain(`Mail Manager - ${BOX_EMAIL}`);

    await quit(h);
    expect(h.openSession).toHaveBeenCalledTimes(2);
    expect(h.server).toHaveBeenCalledTimes(2);
    expect(logouts(h, 'late')).toBe(1);
    expect(logouts(h, 's1')).toBe(1);
  });

  it("the first login fails in the end - even with an error that is not ours: still one more login, and it is nobody's failure", async () => {
    for (const err of [new ImapSessionError('timeout'), new TypeError('boom')]) {
      const { h, first } = await impatient(o);
      first.reject(err);
      await shown(h, 'Total:');
      expect(h.openSession).toHaveBeenCalledTimes(2);
      expect(h.server).toHaveBeenCalledTimes(2);
      expect(h.t.frames.some((frame) => text(frame).includes('r try again'))).toBe(false);
      expect(appEvents(h)).toEqual(['folders.list']);
      expect(events(h, 'folders.list')).toEqual([expect.objectContaining({ outcome: 'ok' })]);
      expect(h.onUnexpected).not.toHaveBeenCalled();
      expect(count(h, 'imap.login')).toBe(loginLines(o, 1));
      expect(await stillRunning(h.done)).toBe(true);
      await quit(h);
      expect(h.calls).toEqual(['login', 'login', 'logout:s1']);
    }
  });

  it.each([
    ['Ctrl+C', CTRL_C, 'interrupt'],
    ['q', ch('q'), 'quit'],
  ] as const)(
    '%s while the first is under way: no login is made after the end - not when the first answers, not after settled()',
    async (_n, key, end) => {
      const { h, first } = await impatient(o);
      h.t.key(key);
      await expect(h.done).resolves.toStrictEqual({ end });
      const settled = h.app.settled();
      expect(await stillRunning(settled)).toBe(true);
      first.resolve(h.session('late'));
      await settled;
      await settle();
      await settle();
      expect(h.openSession).toHaveBeenCalledTimes(1);
      expect(h.server).toHaveBeenCalledTimes(1);
      expect(h.calls).toEqual(['login', 'logout:late']);
      expect(h.listFolders).not.toHaveBeenCalled();
      expect(appEvents(h)).toEqual([]);
      expect(count(h, 'imap.login')).toBe(loginLines(o, 1));
    },
  );

  it('a first login that outlasts the 5 seconds of settled(): still nothing is made when it answers', async () => {
    const { h, first } = await impatient(o);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    h.t.key(CTRL_C);
    await h.done;
    let over = false;
    const settled = h.app.settled().then(() => {
      over = true;
    });
    await vi.advanceTimersByTimeAsync(4999);
    expect(over).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await settled;
    expect(vi.getTimerCount()).toBe(0);

    first.resolve(h.session('late'));
    await settle();
    await settle();
    expect(h.openSession).toHaveBeenCalledTimes(1);
    expect(h.calls).toEqual(['login', 'logout:late']);
  });

  it('the app ends on an error while the first is under way: no login after it either', async () => {
    const { h, first } = await impatient(o);
    h.t.failDraw = new Error('terminal gone');
    h.t.key(DOWN);
    await expect(h.done).rejects.toThrow('terminal gone');
    first.resolve(h.session('late'));
    await h.app.settled();
    await settle();
    expect(h.openSession).toHaveBeenCalledTimes(1);
    expect(h.calls).toEqual(['login', 'logout:late']);
    expect(appEvents(h)).toEqual([]);
  });

  it('every visit left before its turn: no further login - and the next open is made at once', async () => {
    const { h, first } = await impatient(o);
    await press(h, ESC);
    expect(last(h)).toContain(HOME_ROW);
    const frames = h.t.frames.length;
    first.resolve(h.session('late'));
    await vi.waitFor(() => {
      expect(logouts(h, 'late')).toBe(1);
    });
    await settle();
    await settle();
    expect(h.openSession).toHaveBeenCalledTimes(1);
    expect(h.t.frames.length).toBe(frames);
    expect(appEvents(h)).toEqual([]);

    // Nothing is left waiting: a new visit logs in right away.
    await press(h, ENTER);
    await shown(h, 'Total:');
    expect(h.openSession).toHaveBeenCalledTimes(2);
    expect(h.calls).toEqual(['login', 'logout:late', 'login']);
    await quit(h);
    expect(logouts(h, 's1')).toBe(1);
  });

  it('r on the failed screen waits for its turn too', async () => {
    const h = await atHome(o);
    const first = deferred<FakeSession>();
    h.nextLogin(() => first.promise);
    await press(h, ENTER);
    expect(last(h)).toContain('Connecting...');
    await press(h, ESC);
    // The second open fails before any login: the mailbox can't be looked up.
    h.findAccount.mockRejectedValueOnce(new AccountError('not-found'));
    await press(h, ENTER);
    await shown(h, 'r try again');
    expect(h.openSession).toHaveBeenCalledTimes(1);

    await press(h, ch('r'));
    expect(last(h)).toContain('Connecting...');
    await settle();
    expect(h.openSession).toHaveBeenCalledTimes(1);
    first.resolve(h.session('late'));
    await shown(h, 'Total:');
    expect(h.openSession).toHaveBeenCalledTimes(2);
    expect(h.calls).toEqual(['login', 'logout:late', 'login']);
    expect(events(h, 'folders.list').map((r) => r['outcome'])).toEqual(['failed', 'ok']);
    await quit(h);
  });

  it('another mailbox does not wait: the order is per mailbox', async () => {
    const h = await atHome(o);
    const first = deferred<FakeSession>();
    h.nextLogin(() => first.promise);
    await press(h, ENTER);
    expect(last(h)).toContain('Connecting...');
    await press(h, ESC, DOWN, ENTER);
    await shown(h, 'Total:');
    expect(last(h)).toContain(`Mail Manager - ${BOX_2_EMAIL}`);
    expect(h.server.mock.calls).toEqual([[BOX_EMAIL], [BOX_2_EMAIL]]);

    // Back to the first mailbox: behind its own slow login again.
    await press(h, ESC, UP, ENTER);
    expect(last(h)).toContain('Connecting...');
    expect(last(h)).toContain(`Mail Manager - ${BOX_EMAIL}`);
    await settle();
    expect(h.server).toHaveBeenCalledTimes(2);
    first.resolve(h.session('late'));
    await shown(h, 'Total:');
    expect(last(h)).toContain(`Mail Manager - ${BOX_EMAIL}`);
    expect(h.server.mock.calls).toEqual([[BOX_EMAIL], [BOX_2_EMAIL], [BOX_EMAIL]]);
    await quit(h);
    for (const name of ['s1', 'late', 's2']) expect(logouts(h, name)).toBe(1);
  });
});

// --- what the real guard counts -------------------------------------------------------------

describe('the real login guard sees only the logins that are made', () => {
  const wrong = (): Promise<FakeSession> => Promise.reject(new ImapSessionError('auth-failed'));

  it('a wrong saved password: the visits that were left are not tried, so they are not counted', async () => {
    const h = await atHome({ guarded: true });
    const first = deferred<FakeSession>();
    h.nextLogin(() => first.promise);
    h.nextLogin(wrong);
    for (let i = 0; i < 4; i++) await press(h, ENTER, ESC);
    await press(h, ENTER);
    first.reject(new ImapSessionError('auth-failed'));
    await shown(h, 'r try again');
    expect(h.server).toHaveBeenCalledTimes(2);
    // Two wrong passwords, as two logins were made: no wait and no lock for five.
    expect(count(h, 'imap.login-failed')).toBe(2);
    expect(count(h, 'login-guard.challenge')).toBe(0);
    expect(count(h, 'login-guard.block')).toBe(0);
    expect(appEvents(h)).toEqual(['folders.list']);
    expect(events(h, 'folders.list')).toEqual([
      expect.objectContaining({ outcome: 'failed', reason: 'auth-failed' }),
    ]);
    await quit(h);
  });

  it('after two wrong passwords the next open waits: the notice, then "Connecting...", then one login', async () => {
    const h = await atHome({ guarded: true });
    h.nextLogin(wrong);
    h.nextLogin(wrong);
    await press(h, ENTER);
    await shown(h, 'r try again');
    await press(h, ch('r'));
    await vi.waitFor(() => {
      expect(count(h, 'imap.login-failed')).toBe(2);
    });
    await shown(h, 'r try again');

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const login = deferred<FakeSession>();
    h.nextLogin(() => login.promise);
    await press(h, ch('r'));
    expect(last(h)).toContain(CHALLENGE_NOTICE);
    expect(last(h)).not.toContain('Connecting...');
    expect(count(h, 'login-guard.challenge')).toBe(1);
    await vi.advanceTimersByTimeAsync(4999);
    expect(last(h)).toContain(CHALLENGE_NOTICE);
    expect(h.server).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(last(h)).toContain('Connecting...');
    expect(last(h)).not.toContain(CHALLENGE_NOTICE);
    expect(h.server).toHaveBeenCalledTimes(3);
    login.resolve(h.session('s1'));
    await shown(h, 'Total:');
    expect(count(h, 'imap.login')).toBe(1);
    await quit(h);
    expect(logouts(h, 's1')).toBe(1);
  });
});

// --- the guard's wait -----------------------------------------------------------------------

describe("the guard's wait before a login", () => {
  it('its notice is replaced by "Connecting..." when the wait ends and the login starts', async () => {
    const h = await atHome();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const login = deferred<FakeSession>();
    challenged(h);
    h.nextLogin(() => login.promise);
    await press(h, ENTER);
    expect(last(h)).toContain(CHALLENGE_NOTICE);
    expect(last(h)).not.toContain('Connecting...');
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(4999);
    expect(last(h)).toContain(CHALLENGE_NOTICE);
    expect(h.server).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(last(h)).toContain('Connecting...');
    expect(last(h)).not.toContain(CHALLENGE_NOTICE);
    expect(h.server).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    login.resolve(h.session('s1'));
    await shown(h, 'Total:');
    await quit(h);
    expect(logouts(h, 's1')).toBe(1);
  });

  it('the screen fails as the wait ends: the app ends with it and the login is not made', async () => {
    const h = await atHome();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    challenged(h);
    await press(h, ENTER);
    expect(last(h)).toContain(CHALLENGE_NOTICE);
    h.t.failDraw = new Error('terminal gone');
    // Watched before the time passes: run() rejects the moment the frame fails.
    const crashed = expect(h.done).rejects.toThrow('terminal gone');
    await vi.advanceTimersByTimeAsync(5000);
    await crashed;
    await h.app.settled();
    await settle();
    expect(h.server).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(h.log.records).toEqual([]);
  });

  it('a wait that ends because the mailbox was left changes nothing on Home', async () => {
    const h = await atHome();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    challenged(h);
    await press(h, ENTER);
    expect(last(h)).toContain(CHALLENGE_NOTICE);
    await press(h, ESC);
    expect(last(h)).toContain(HOME_ROW);
    const frames = h.t.frames.length;
    await vi.advanceTimersByTimeAsync(5000);
    await settle();
    expect(vi.getTimerCount()).toBe(0);
    expect(h.t.frames.length).toBe(frames);
    expect(h.server).not.toHaveBeenCalled();
    await quit(h);
  });

  /** One `deps.openSession` that waits twice at once, as two logins that both must wait would. */
  function twoWaits(h: Harness): string[] {
    const ends: string[] = [];
    h.openSession.mockImplementationOnce(async (mailbox, onChallenge) => {
      const waits = [onChallenge(), onChallenge()].map((wait) =>
        wait.then(
          () => 'on',
          () => 'refused',
        ),
      );
      ends.push(...(await Promise.all(waits)));
      if (ends.includes('refused')) throw new Error('mailbox closed');
      return h.server(mailbox.email);
    });
    return ends;
  }

  it('two waits pending at once: Ctrl+C ends both at once, no login, no timer left', async () => {
    const h = await atHome();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const ends = twoWaits(h);
    await press(h, ENTER);
    expect(last(h)).toContain(CHALLENGE_NOTICE);
    expect(vi.getTimerCount()).toBe(2);
    const frames = h.t.frames.length;
    h.t.key(CTRL_C);
    await expect(h.done).resolves.toStrictEqual({ end: 'interrupt' });
    await settle();
    expect(ends).toEqual(['refused', 'refused']);
    expect(vi.getTimerCount()).toBe(0);
    await h.app.settled();
    expect(h.server).not.toHaveBeenCalled();
    expect(h.t.frames.length).toBe(frames);
    expect(h.log.records).toEqual([]);
  });

  it('two waits pending at once: leaving the mailbox ends both too', async () => {
    const h = await atHome();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const ends = twoWaits(h);
    await press(h, ENTER);
    expect(vi.getTimerCount()).toBe(2);
    await press(h, ESC);
    expect(last(h)).toContain(HOME_ROW);
    expect(ends).toEqual(['refused', 'refused']);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.server).not.toHaveBeenCalled();
    expect(await stillRunning(h.done)).toBe(true);
    await quit(h);
  });

  it('two waits pending at once: when their time is up both end and the login goes on', async () => {
    const h = await atHome();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const ends = twoWaits(h);
    await press(h, ENTER);
    expect(vi.getTimerCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(5000);
    await shown(h, 'Total:');
    expect(ends).toEqual(['on', 'on']);
    expect(h.server).toHaveBeenCalledTimes(1);
    await quit(h);
    expect(vi.getTimerCount()).toBe(0);
    expect(logouts(h, 's1')).toBe(1);
  });
});

// --- the reducer ----------------------------------------------------------------------------

describe('challenge-done in the reducer', () => {
  const ROW: MailboxRow = {
    id: BOX_ID,
    email: BOX_EMAIL,
    provider: 'websupport',
    lastCheckedAt: null,
  };
  const GENERATION = 7;

  /** The first mailbox being opened, in `mode`, with or without the guard's notice. */
  function opening(mode: MailboxMode, message: 'challenge' | null): AppState {
    const home = { ...homeView(), mailboxes: [ROW] };
    return {
      ...initialApp('0.9.0', SCREEN),
      generation: GENERATION,
      current: ANNA,
      view: { ...mailboxView(ROW, home, GENERATION), mode, message },
    };
  }

  const screenOf = (state: AppState): string => text(renderApp(state));

  it('connecting with the notice: the notice goes and "Connecting..." is back', () => {
    const state = opening('connecting', 'challenge');
    expect(screenOf(state)).toContain(CHALLENGE_NOTICE);
    expect(screenOf(state)).not.toContain('Connecting...');
    const out = reduceApp(state, { type: 'challenge-done', generation: GENERATION });
    expect(out.effects).toEqual([]);
    expect(out.state).toEqual({ ...state, view: { ...state.view, message: null } });
    expect(screenOf(out.state)).toContain('Connecting...');
    expect(screenOf(out.state)).not.toContain(CHALLENGE_NOTICE);
  });

  it('without the notice, in another mode, on another screen or for an older request: nothing changes', () => {
    const noticed = opening('connecting', 'challenge');
    const states: AppState[] = [
      opening('connecting', null),
      opening('reading', 'challenge'),
      opening('failed', 'challenge'),
      opening('ready', 'challenge'),
      { ...noticed, view: homeView() },
      { ...noticed, view: pickView() },
    ];
    for (const state of states) {
      const out = reduceApp(state, { type: 'challenge-done', generation: GENERATION });
      expect(out.state).toBe(state);
      expect(out.effects).toEqual([]);
    }
    for (const generation of [GENERATION - 1, GENERATION + 1]) {
      const out = reduceApp(noticed, { type: 'challenge-done', generation });
      expect(out.state).toBe(noticed);
      expect(out.effects).toEqual([]);
    }
  });
});

// --- any order ------------------------------------------------------------------------------

describe('any order of keys and answers', () => {
  const RUNS = 40;
  const STEPS = 40;

  // Deterministic PRNG so a failure is reproducible.
  function prng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x1_0000_0000;
    };
  }

  it.each(KINDS)(
    '%s: the logins of a mailbox never overlap, none is made for a visit that is over, every session is logged out once',
    async (_kind, o) => {
      const rand = prng(20261007);
      for (let run = 0; run < RUNS; run++) {
        const h = await atHome(o);
        /** Logins the mail server has not answered yet, oldest first. */
        const waiting: Deferred<FakeSession>[] = [];
        const sessions: FakeSession[] = [];
        const underWay = new Set<string>();
        const broken: string[] = [];
        let ended = false;
        h.answer = (email) => {
          const screen = last(h);
          if (ended) broken.push('a login after the app ended');
          if (underWay.has(email)) broken.push('two logins of one mailbox at once');
          if (!screen.includes(`Mail Manager - ${email}`) || !screen.includes('Connecting...')) {
            broken.push('a login for a mailbox that is not being opened');
          }
          const login = deferred<FakeSession>();
          const over = (): void => {
            underWay.delete(email);
          };
          underWay.add(email);
          login.promise.then(over, over);
          waiting.push(login);
          return login.promise;
        };
        const answerOldest = (ok: boolean): void => {
          const login = waiting.shift();
          if (login === undefined) return;
          if (!ok) {
            login.reject(new ImapSessionError('timeout'));
            return;
          }
          const made = h.session(`s${String(sessions.length + 1)}`);
          sessions.push(made);
          login.resolve(made);
        };

        for (let step = 0; step < STEPS; step++) {
          const view = h.app.state.view;
          const pick = rand();
          if (pick < 0.25) answerOldest(rand() < 0.75);
          else if (view.kind === 'home') {
            // Stays on the two mailbox rows: Enter opens one, the other key moves to the other.
            h.t.key(pick < 0.85 ? ENTER : view.cursor === 0 ? DOWN : UP);
          } else if (view.kind === 'mailbox') {
            h.t.key(pick < 0.6 ? ESC : pick < 0.85 ? ENTER : pick < 0.93 ? ch('r') : DOWN);
          }
          await settle();
        }
        h.t.key(CTRL_C);
        ended = true;
        await expect(h.done).resolves.toStrictEqual({ end: 'interrupt' });
        // Whatever is still under way arrives late.
        while (waiting.length > 0) {
          answerOldest(true);
          await settle();
        }
        await h.app.settled();
        await settle();

        const where = `run ${String(run)}`;
        expect(broken, where).toEqual([]);
        expect(waiting, where).toEqual([]);
        for (const made of sessions) {
          expect(logouts(h, made.name), `${where}, ${made.name}`).toBe(1);
        }
        expect(count(h, 'imap.login'), where).toBe(loginLines(o, sessions.length));
        expect(h.onUnexpected, where).not.toHaveBeenCalled();
      }
    },
    // Many runs, a frame drawn at every step: room for a busy machine.
    30_000,
  );
});
