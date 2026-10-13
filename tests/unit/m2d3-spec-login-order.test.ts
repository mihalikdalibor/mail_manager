import { randomBytes } from 'node:crypto';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { createApp } from '../../src/cli/app/controller.js';
import type { App, AppDeps, AppResult, MailboxSession } from '../../src/cli/app/controller.js';
import { createLocalGuard, openAccountSession } from '../../src/core/accounts.js';
import { CHALLENGE_NOTICE } from '../../src/cli/browser/controller.js';
import type { Rendered } from '../../src/cli/browser/render.js';
import type { Keypress, Screen } from '../../src/cli/browser/state.js';
import type { Terminal } from '../../src/cli/browser/terminal.js';
import type { AuthUser, LogoutResult } from '../../src/core/auth.js';
import { LocalCredentialProvider } from '../../src/core/credentials.js';
import type { MailAccount } from '../../src/core/db/repos.js';
import { ImapSessionError } from '../../src/core/imap/errors.js';
import { buildServerFeatures, sanitizeCapabilities } from '../../src/core/imap/features.js';
import type { ImapSession, OpenSessionOptions } from '../../src/core/imap/session.js';
import { MemoryEventLog } from '../../src/core/log/index.js';
import { MailboxError } from '../../src/core/mailbox/errors.js';
import type { FolderInfo, FolderTree } from '../../src/core/mailbox/folders.js';
import type { PageResult, loadPage } from '../../src/core/mailbox/messages.js';
import type { MailboxStats } from '../../src/core/mailbox/stats.js';
import { MemoryRememberedUsers } from '../../src/core/remembered-users.js';

// M2d-3 login order (spec F1-F5, follow-up of C-031): the logins of one saved mailbox run one
// after another, and when a login's turn comes the visit that asked for it must still be open
// and the app not ended - otherwise deps.openSession is not called. Driven with a fake
// Terminal, deferred logins, logout spies and (F3) the real login guard around a fake `open`.

// --- fixtures -------------------------------------------------------------------------------

const SCREEN: Screen = { rows: 24, cols: 120 };
const ALICE: AuthUser = {
  email: 'alice@example.com',
  userId: '11111111-1111-4111-8111-111111111111',
};
const ID = '22222222-2222-4222-8222-222222222222';
const MAIL = 'one@example.com';
const HOST = 'imap.example.com';
const PASSWORD = 'saved-password-4c1a';
const RUN = '0123456789abcdef';
const T0 = Date.UTC(2026, 9, 1, 9, 0, 0);
const TARGET = 'ab'.repeat(32);

const k = (name: string, extra: Keypress = {}): Keypress => ({ name, sequence: name, ...extra });
const ENTER = k('return', { sequence: '\r' });
const CTRL_C = k('c', { ctrl: true, sequence: '\x03' });
const ESC = k('escape', { meta: true, sequence: '\x1b' });

function charKey(c: string): Keypress {
  return /^[a-z]$/.test(c) ? { name: c, sequence: c } : { sequence: c };
}

function account(over: Partial<MailAccount> = {}): MailAccount {
  return {
    id: ID,
    userId: ALICE.userId,
    label: null,
    email: MAIL,
    provider: 'websupport',
    host: HOST,
    port: 993,
    username: MAIL,
    authType: 'password',
    secret: {} as unknown as MailAccount['secret'],
    capabilities: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    lastCheckedAt: null,
    ...over,
  };
}

function folder(path: string, over: Partial<FolderInfo> = {}): FolderInfo {
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
    messages: 3,
    unseen: 1,
    bytes: 1000,
    sizeSource: 'server',
    overlapping: false,
    ...over,
  };
}

const TREE: FolderTree = {
  folders: [folder('INBOX', { role: 'inbox', roleSource: 'path' }), folder('Sent')],
  totals: { messages: 345, unseen: 7, bytes: 10_000, sizeSource: 'server' },
  quota: null,
  truncated: false,
  unreadable: 0,
  gmailAllHidden: false,
  fallbacks: new Set(),
};

function pageFor(path: string): PageResult {
  const rows =
    path === 'INBOX'
      ? [3, 2, 1].map((seq) => ({
          seq,
          uid: 1000 + seq,
          received: new Date(Date.UTC(2026, 0, 1)),
          from: `Sender ${String(seq)}`,
          subject: `Subject ${String(seq)}`,
          bytes: seq,
          attachment: false,
        }))
      : [];
  return {
    kind: 'page',
    snapshot: { path, uidValidity: '7', exists: rows.length },
    page: 0,
    rows,
  };
}

// --- fakes ----------------------------------------------------------------------------------

interface FakeTerminal extends Terminal {
  readonly frames: Rendered[];
  key(key: Keypress): void;
}

function fakeTerminal(screen: Screen = SCREEN): FakeTerminal {
  let keyHandler: ((key: Keypress) => void) | null = null;
  const t: FakeTerminal = {
    frames: [],
    size: () => screen,
    draw: (frame) => {
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

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await settle();
}

async function stillRunning(p: Promise<unknown>): Promise<boolean> {
  return Promise.race([p.then(() => false), settle().then(() => true)]);
}

type FakeSession = MailboxSession & { name: string };
type OpenSession = AppDeps['openSession'];
type ListFolders = NonNullable<AppDeps['listFolders']>;
type CollectStats = NonNullable<AppDeps['collectStats']>;
type Login = ((onChallenge: () => Promise<void>) => Promise<MailboxSession>) | null;

interface Harness {
  t: FakeTerminal;
  app: App;
  done: Promise<AppResult>;
  log: MemoryEventLog;
  sessions: FakeSession[];
  logouts: Map<string, ReturnType<typeof vi.fn<() => Promise<void>>>>;
  findAccount: ReturnType<typeof vi.fn<AppDeps['findAccount']>>;
  openSession: ReturnType<typeof vi.fn<OpenSession>>;
  listFolders: ReturnType<typeof vi.fn<ListFolders>>;
  load: ReturnType<typeof vi.fn<typeof loadPage>>;
  collectStats: ReturnType<typeof vi.fn<CollectStats>>;
  /** The next login (in call order): null = the default one (a new session at once). */
  queue(login: Login): void;
  newSession(): FakeSession;
}

interface Options {
  account?: MailAccount;
  autoStats?: boolean;
  challengeDelayMs?: number;
  log?: MemoryEventLog;
  openSession?: OpenSession;
}

function makeHarness(options: Options = {}): Harness {
  const acct = options.account ?? account();
  const sessions: FakeSession[] = [];
  const logouts = new Map<string, ReturnType<typeof vi.fn<() => Promise<void>>>>();
  const loginQueue: Login[] = [];
  const newSession = (): FakeSession => {
    const name = `s${String(sessions.length + 1)}`;
    const logout = vi.fn<() => Promise<void>>(() => Promise.resolve());
    logouts.set(name, logout);
    const session = {
      name,
      client: {},
      features: {},
      closed: false,
      logout,
    } as unknown as FakeSession;
    sessions.push(session);
    return session;
  };
  const t = fakeTerminal();
  const auth = {
    currentUser: vi.fn<() => Promise<AuthUser | null>>(() => Promise.resolve(ALICE)),
    login: vi.fn<(email: string, password: string) => Promise<AuthUser>>(() =>
      Promise.resolve(ALICE),
    ),
    logout: vi.fn<() => Promise<LogoutResult>>(() => Promise.resolve('logged-out')),
  };
  const log =
    options.log ?? new MemoryEventLog({ run: RUN, ver: '0.9.0', now: () => T0, level: 'debug' });
  const findAccount = vi.fn<AppDeps['findAccount']>(() => Promise.resolve(acct));
  const defaultOpen: OpenSession = (_account, onChallenge) => {
    const next = loginQueue.shift();
    return next === undefined || next === null ? Promise.resolve(newSession()) : next(onChallenge);
  };
  const openSession = vi.fn<OpenSession>(options.openSession ?? defaultOpen);
  const listFolders = vi.fn<ListFolders>(() => Promise.resolve(TREE));
  const load = vi.fn<typeof loadPage>((_session, path) => Promise.resolve(pageFor(path)));
  const collectStats = vi.fn<CollectStats>((session) => {
    const done = deferred<MailboxStats>();
    const spy = logouts.get((session as FakeSession).name);
    const before = spy?.getMockImplementation();
    spy?.mockImplementation(() => {
      done.reject(new MailboxError('connection-lost'));
      return before?.() ?? Promise.resolve();
    });
    return done.promise;
  });
  const deps: AppDeps = {
    terminal: t,
    version: '0.9.0',
    auth,
    listMailboxes: vi.fn<AppDeps['listMailboxes']>(() => Promise.resolve([acct])),
    remembered: new MemoryRememberedUsers([ALICE.email]),
    log,
    loginTarget: () => TARGET,
    onUnexpected: vi.fn<(err: unknown) => void>(),
    findAccount,
    openSession,
    listFolders,
    load,
    collectStats,
    timeZone: 'UTC',
    autoStats: options.autoStats ?? false,
    readLogs: vi.fn<AppDeps['readLogs']>(() => Promise.reject(new Error('not used here'))),
    discover: vi.fn<AppDeps['discover']>(() => Promise.reject(new Error('not used here'))),
    assertNotSaved: vi.fn<AppDeps['assertNotSaved']>(() => Promise.resolve()),
    addMailbox: vi.fn<AppDeps['addMailbox']>(() => Promise.reject(new Error('not used here'))),
    ...(options.challengeDelayMs !== undefined && { challengeDelayMs: options.challengeDelayMs }),
  };
  const app = createApp(deps);
  return {
    t,
    app,
    done: app.run(),
    log,
    sessions,
    logouts,
    findAccount,
    openSession,
    listFolders,
    load,
    collectStats,
    queue: (login) => {
      loginQueue.push(login);
    },
    newSession,
  };
}

const text = (frame: Rendered | undefined): string => (frame?.lines ?? []).join('\n');
const last = (h: Harness): string => text(h.t.frames.at(-1));

async function press(h: Harness, ...keys: Keypress[]): Promise<void> {
  for (const key of keys) {
    h.t.key(key);
    await settle();
  }
}

async function waitFor(h: Harness, needle: string): Promise<void> {
  await vi.waitFor(() => {
    expect(last(h)).toContain(needle);
  });
}

const events = (h: Harness, name: string): Record<string, unknown>[] =>
  h.log.records.filter((r) => r.event === name);

function logoutCount(h: Harness, name: string): number {
  return h.logouts.get(name)?.mock.calls.length ?? 0;
}

async function end(h: Harness): Promise<void> {
  if (await stillRunning(h.done)) {
    h.t.key(CTRL_C);
    await h.done;
  }
  await h.app.settled();
}

afterEach(() => {
  vi.useRealTimers();
});

async function atHome(options: Options = {}): Promise<Harness> {
  const h = makeHarness(options);
  await waitFor(h, 'Sign in as another user');
  await press(h, ENTER);
  await waitFor(h, MAIL);
  return h;
}

/** Enter, Esc four times on the one mailbox - the first login never answers - then Enter. */
async function enterEscFourTimesThenEnter(h: Harness): Promise<void> {
  for (let i = 0; i < 4; i++) await press(h, ENTER, ESC);
  await press(h, ENTER);
}

// --- F1, F2: abandoned visits ---------------------------------------------------------------

describe('F2 Enter / Esc four times on a slow server, then Enter', () => {
  it('one login while the first is pending; after it settles exactly one more (the live visit)', async () => {
    const h = await atHome();
    const first = deferred<MailboxSession>();
    h.queue(() => first.promise);
    await enterEscFourTimesThenEnter(h);
    await flush();
    expect(h.openSession).toHaveBeenCalledTimes(1);
    expect(last(h)).toContain('Connecting...');

    const firstSession = h.newSession();
    first.resolve(firstSession);
    await waitFor(h, 'Total:');
    expect(h.openSession).toHaveBeenCalledTimes(2);
    await flush();
    expect(h.openSession).toHaveBeenCalledTimes(2);
    // The live visit read the folders on its own session, never on the abandoned one.
    expect(h.listFolders).toHaveBeenCalledTimes(1);
    expect(h.listFolders.mock.calls[0]?.[0]).toBe(h.sessions[1]);
    // The abandoned login's session was logged out as soon as it arrived (F5), once.
    expect(logoutCount(h, firstSession.name)).toBe(1);
    expect(logoutCount(h, 's2')).toBe(0);
    await end(h);
    expect(logoutCount(h, 's1')).toBe(1);
    expect(logoutCount(h, 's2')).toBe(1);
  });

  it('every one of the abandoned visits is skipped: not one extra login, however long we wait', async () => {
    const h = await atHome();
    const first = deferred<MailboxSession>();
    h.queue(() => first.promise);
    for (let i = 0; i < 6; i++) await press(h, ENTER, ESC);
    await flush();
    expect(h.openSession).toHaveBeenCalledTimes(1);
    first.resolve(h.newSession());
    await flush();
    // Home again at the end, no live visit: nothing else was logged in.
    expect(last(h)).toContain('Add a mailbox');
    expect(h.openSession).toHaveBeenCalledTimes(1);
    expect(h.listFolders).not.toHaveBeenCalled();
    expect(logoutCount(h, 's1')).toBe(1);
    await end(h);
  });

  it('Ctrl+C while the first is pending: exactly one login in total, also after settled()', async () => {
    const h = await atHome();
    const first = deferred<MailboxSession>();
    h.queue(() => first.promise);
    await press(h, ENTER, ESC, ENTER, ESC, ENTER);
    expect(h.openSession).toHaveBeenCalledTimes(1);
    h.t.key(CTRL_C);
    await expect(h.done).resolves.toMatchObject({ end: 'interrupt' });
    const settled = h.app.settled();
    expect(await stillRunning(settled)).toBe(true);
    const late = h.newSession();
    first.resolve(late);
    await settled;
    await flush();
    expect(h.openSession).toHaveBeenCalledTimes(1);
    expect(logoutCount(h, late.name)).toBe(1);
    expect(h.listFolders).not.toHaveBeenCalled();
    expect(events(h, 'folders.list')).toHaveLength(0);
  });

  it('the live visit waits for the login before it, however it was asked for', async () => {
    const h = await atHome();
    const first = deferred<MailboxSession>();
    h.queue(() => first.promise);
    await press(h, ENTER, ESC, ENTER);
    await flush();
    expect(h.openSession).toHaveBeenCalledTimes(1);
    first.resolve(h.newSession());
    await waitFor(h, 'Total:');
    expect(h.openSession).toHaveBeenCalledTimes(2);
    await end(h);
  });
});

describe('F1 the logins of one mailbox run one after another', () => {
  it('r on the failed screen: the new login starts after the failed one, once', async () => {
    const h = await atHome();
    h.queue(() => Promise.reject(new ImapSessionError('auth-failed')));
    await press(h, ENTER);
    await waitFor(h, 'r try again');
    expect(h.openSession).toHaveBeenCalledTimes(1);
    await press(h, charKey('r'));
    await waitFor(h, 'Total:');
    expect(h.openSession).toHaveBeenCalledTimes(2);
    await end(h);
  });

  it('a reconnect asked for while the stats login is pending waits for it', async () => {
    const h = await atHome({ autoStats: true });
    const stats = deferred<MailboxSession>();
    h.queue(null);
    h.queue(() => stats.promise);
    await press(h, ENTER);
    await waitFor(h, 'Total:');
    await vi.waitFor(() => {
      expect(h.openSession).toHaveBeenCalledTimes(2);
    });
    h.load.mockRejectedValueOnce(new MailboxError('connection-lost'));
    await press(h, ENTER);
    await waitFor(h, 'Connection closed - reconnect? (y/N)');
    await press(h, charKey('y'));
    await flush();
    // Still the stats login: the reconnect's own login has not been started.
    expect(h.openSession).toHaveBeenCalledTimes(2);
    stats.resolve(h.newSession());
    await waitFor(h, 'Subject 3');
    expect(h.openSession).toHaveBeenCalledTimes(3);
    await end(h);
    for (const name of ['s1', 's2', 's3']) expect(logoutCount(h, name), name).toBe(1);
  });

  it('a queued reconnect of an app that ended is never made', async () => {
    const h = await atHome({ autoStats: true });
    const stats = deferred<MailboxSession>();
    h.queue(null);
    h.queue(() => stats.promise);
    await press(h, ENTER);
    await waitFor(h, 'Total:');
    await vi.waitFor(() => {
      expect(h.openSession).toHaveBeenCalledTimes(2);
    });
    h.load.mockRejectedValueOnce(new MailboxError('connection-lost'));
    await press(h, ENTER);
    await waitFor(h, 'Connection closed - reconnect? (y/N)');
    await press(h, charKey('y'));
    await flush();
    h.t.key(CTRL_C);
    await expect(h.done).resolves.toMatchObject({ end: 'interrupt' });
    const settled = h.app.settled();
    const late = h.newSession();
    stats.resolve(late);
    await settled;
    await flush();
    expect(h.openSession).toHaveBeenCalledTimes(2);
    expect(logoutCount(h, late.name)).toBe(1);
    expect(h.collectStats).not.toHaveBeenCalled();
  });

  it('with autoStats on, a visit left before its login settles starts no stats login', async () => {
    const h = await atHome({ autoStats: true });
    const first = deferred<MailboxSession>();
    h.queue(() => first.promise);
    await press(h, ENTER, ESC);
    await flush();
    first.resolve(h.newSession());
    await flush();
    expect(h.openSession).toHaveBeenCalledTimes(1);
    expect(h.collectStats).not.toHaveBeenCalled();
    await end(h);
  });
});

// --- F3: the same counts with the real login guard ------------------------------------------

describe('F3 the same counts with the real login guard', () => {
  const CAPS = sanitizeCapabilities({ IMAP4REV1: true, UIDPLUS: true });
  const FEATURES = buildServerFeatures(CAPS, new Set());

  function guarded(): {
    log: MemoryEventLog;
    open: ReturnType<typeof vi.fn<(o: OpenSessionOptions) => Promise<ImapSession>>>;
    logins: Deferred<ImapSession>[];
    options: Options;
    logout: ReturnType<typeof vi.fn<() => Promise<void>>>;
  } {
    const log = new MemoryEventLog({ run: RUN, ver: '0.9.0', now: () => T0, level: 'debug' });
    const credentials = new LocalCredentialProvider({
      masterKey: randomBytes(32),
      masterKeyVersion: 1,
    });
    const secret = credentials.encryptPassword(
      { userId: ALICE.userId, accountId: ID, host: HOST, port: 993, username: MAIL },
      PASSWORD,
    );
    const acct = account({ secret });
    const guard = createLocalGuard(randomBytes(32), log);
    const logout = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const session = {
      capabilities: CAPS,
      features: FEATURES,
      client: {},
      closed: false,
      logout,
    } as unknown as ImapSession;
    const logins: Deferred<ImapSession>[] = [];
    const open = vi.fn<(o: OpenSessionOptions) => Promise<ImapSession>>(() => {
      // The first connection never answers until the test says so; the others are quick.
      if (logins.length === 0) {
        const d = deferred<ImapSession>();
        logins.push(d);
        return d.promise;
      }
      return Promise.resolve(session);
    });
    const openSession: OpenSession = (a, onChallenge) =>
      openAccountSession(
        { credentials, guard, log, clientVersion: '9.9.9', onChallenge, open },
        a,
      ).then((s) => s as unknown as MailboxSession);
    return { log, open, logins, options: { account: acct, log, openSession }, logout };
  }

  const imapLogins = (log: MemoryEventLog): number =>
    log.records.filter((r) => r.event === 'imap.login').length;

  it('Enter / Esc four times, then Enter: one open() while pending, two in the end, two imap.login lines', async () => {
    const g = guarded();
    const h = await atHome(g.options);
    await enterEscFourTimesThenEnter(h);
    await flush();
    expect(g.open).toHaveBeenCalledTimes(1);
    expect(imapLogins(g.log)).toBe(0);
    const session = {
      capabilities: CAPS,
      features: FEATURES,
      client: {},
      closed: false,
      logout: g.logout,
    } as unknown as ImapSession;
    g.logins[0]?.resolve(session);
    await waitFor(h, 'Total:');
    await flush();
    expect(g.open).toHaveBeenCalledTimes(2);
    expect(imapLogins(g.log)).toBe(2);
    await end(h);
  });

  it('Ctrl+C while the first is pending: one open() and one imap.login line in total', async () => {
    const g = guarded();
    const h = await atHome(g.options);
    await press(h, ENTER, ESC, ENTER, ESC, ENTER);
    expect(g.open).toHaveBeenCalledTimes(1);
    h.t.key(CTRL_C);
    await h.done;
    const settled = h.app.settled();
    g.logins[0]?.resolve({
      capabilities: CAPS,
      features: FEATURES,
      client: {},
      closed: false,
      logout: g.logout,
    } as unknown as ImapSession);
    await settled;
    await flush();
    expect(g.open).toHaveBeenCalledTimes(1);
    expect(imapLogins(g.log)).toBe(1);
    expect(g.logout).toHaveBeenCalledTimes(1);
  });
});

// --- F4: the challenge notice ---------------------------------------------------------------

describe('F4 the wait notice is replaced when the wait ends', () => {
  it('"Several wrong passwords - waiting 5 seconds before trying again." gives way to "Connecting..."', async () => {
    const h = await atHome({ challengeDelayMs: 20 });
    const after = deferred<MailboxSession>();
    h.queue(async (onChallenge) => {
      await onChallenge();
      return after.promise;
    });
    await press(h, ENTER);
    await waitFor(h, 'Several wrong passwords - waiting 5 seconds before trying again.');
    expect(CHALLENGE_NOTICE).toBe(
      'Several wrong passwords - waiting 5 seconds before trying again.',
    );
    await vi.waitFor(() => {
      expect(last(h)).toContain('Connecting...');
      expect(last(h)).not.toContain(CHALLENGE_NOTICE);
    });
    after.resolve(h.newSession());
    await waitFor(h, 'Total:');
    await end(h);
  });

  it('a wait that ends after the visit was left changes nothing on Home', async () => {
    const h = await atHome({ challengeDelayMs: 40 });
    h.queue(async (onChallenge) => {
      await onChallenge();
      return h.newSession();
    });
    await press(h, ENTER);
    await waitFor(h, CHALLENGE_NOTICE);
    await press(h, ESC);
    expect(last(h)).toContain('Add a mailbox');
    await new Promise((resolve) => setTimeout(resolve, 120));
    await flush();
    expect(last(h)).toContain('Add a mailbox');
    expect(last(h)).not.toContain('Connecting...');
    expect(last(h)).not.toContain(CHALLENGE_NOTICE);
    await end(h);
  });

  it('a stats login waiting for a challenge ends on Ctrl+C without waiting for the delay', async () => {
    const h = await atHome({ challengeDelayMs: 60_000, autoStats: true });
    h.queue(null);
    h.queue(async (onChallenge) => {
      await onChallenge();
      return h.newSession();
    });
    await press(h, ENTER);
    await waitFor(h, 'Total:');
    await vi.waitFor(() => {
      expect(h.openSession).toHaveBeenCalledTimes(2);
    });
    h.t.key(CTRL_C);
    await expect(h.done).resolves.toMatchObject({ end: 'interrupt' });
    const finished = await Promise.race([
      h.app.settled().then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1500)),
    ]);
    expect(finished).toBe(true);
    expect(h.collectStats).not.toHaveBeenCalled();
  });
});

// --- F5: what M2d-2 guaranteed still holds --------------------------------------------------

describe('F5 a login under way is not cancelled; each session is logged out exactly once', () => {
  it('Esc while connecting: the session that arrives is logged out at once, nothing shown or logged', async () => {
    const h = await atHome();
    const login = deferred<MailboxSession>();
    h.queue(() => login.promise);
    await press(h, ENTER);
    await waitFor(h, 'Connecting...');
    await press(h, ESC);
    expect(last(h)).toContain('Add a mailbox');
    const late = h.newSession();
    login.resolve(late);
    await vi.waitFor(() => {
      expect(logoutCount(h, late.name)).toBe(1);
    });
    await flush();
    expect(h.listFolders).not.toHaveBeenCalled();
    expect(last(h)).toContain('Add a mailbox');
    expect(events(h, 'folders.list')).toHaveLength(0);
    expect(events(h, 'browse.finish')).toHaveLength(0);
    await end(h);
    expect(logoutCount(h, late.name)).toBe(1);
  });

  it('a long run of opens, leaves and a reconnect: every session is logged out exactly once', async () => {
    const h = await atHome();
    await press(h, ENTER);
    await waitFor(h, 'Total:');
    await press(h, ESC);
    await press(h, ENTER);
    await waitFor(h, 'Total:');
    h.load.mockRejectedValueOnce(new MailboxError('connection-lost'));
    await press(h, ENTER);
    await waitFor(h, 'Connection closed - reconnect? (y/N)');
    await press(h, charKey('y'));
    await waitFor(h, 'Subject 3');
    await press(h, ESC);
    await press(h, ESC);
    await end(h);
    expect(h.sessions).toHaveLength(3);
    for (const s of h.sessions) expect(logoutCount(h, s.name), s.name).toBe(1);
  });

  it('opening, leaving and opening again with fast logins is unchanged: two logins, two folder reads', async () => {
    const h = await atHome();
    await press(h, ENTER);
    await waitFor(h, 'Total:');
    await press(h, ESC);
    await press(h, ENTER);
    await waitFor(h, 'Total:');
    expect(h.openSession).toHaveBeenCalledTimes(2);
    expect(h.listFolders).toHaveBeenCalledTimes(2);
    expect(h.listFolders.mock.calls[1]?.[0]).toBe(h.sessions[1]);
    await end(h);
  });
});
