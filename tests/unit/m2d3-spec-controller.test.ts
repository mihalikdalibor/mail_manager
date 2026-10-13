import { afterEach, describe, it, expect, vi } from 'vitest';
import { createApp } from '../../src/cli/app/controller.js';
import type { App, AppDeps, AppResult, MailboxSession } from '../../src/cli/app/controller.js';
import { STATS_GMAIL_HIDDEN, asciiText } from '../../src/cli/app/state.js';
import { accountErrorText } from '../../src/cli/account-text.js';
import type { Rendered } from '../../src/cli/browser/render.js';
import type { Keypress, Screen } from '../../src/cli/browser/state.js';
import type { Terminal } from '../../src/cli/browser/terminal.js';
import type { AuthUser, LogoutResult } from '../../src/core/auth.js';
import type { MailAccount } from '../../src/core/db/repos.js';
import { ImapSessionError } from '../../src/core/imap/errors.js';
import { MemoryEventLog } from '../../src/core/log/index.js';
import { MailboxError } from '../../src/core/mailbox/errors.js';
import type { FolderInfo, FolderTree } from '../../src/core/mailbox/folders.js';
import type { PageResult, loadPage } from '../../src/core/mailbox/messages.js';
import type { MailboxStats } from '../../src/core/mailbox/stats.js';
import { MemoryRememberedUsers } from '../../src/core/remembered-users.js';
import { LoginBlockedError } from '../../src/core/security/login-guard.js';

// M2d-3 stats in the app controller (spec S1, S3, S8-S13 and the stats edge cases): keys ->
// reducers -> effects, driven with a fake Terminal, fake sessions (a logout spy each, a stats
// read that fails once its session is logged out - as the real one does), deferred logins and
// reads, and a MemoryEventLog. No Supabase, no IMAP, no real terminal, no real clock.

// --- fixtures -------------------------------------------------------------------------------

const SCREEN: Screen = { rows: 24, cols: 120 };
const ALICE: AuthUser = {
  email: 'alice@example.com',
  userId: '11111111-1111-4111-8111-111111111111',
};
const ID = '22222222-2222-4222-8222-222222222222';
const MAIL = 'one@example.com';
const RUN = '0123456789abcdef';
const T0 = Date.UTC(2026, 9, 1, 9, 0, 0);
const TARGET = 'ab'.repeat(32);
const TZ = 'Asia/Tokyo';

const k = (name: string, extra: Keypress = {}): Keypress => ({ name, sequence: name, ...extra });
const ENTER = k('return', { sequence: '\r' });
const DOWN = k('down', { sequence: '\x1b[B' });
const CTRL_C = k('c', { ctrl: true, sequence: '\x03' });
const ESC = k('escape', { meta: true, sequence: '\x1b' });

function charKey(c: string): Keypress {
  if (c === ' ') return { name: 'space', sequence: ' ' };
  return /^[a-z]$/.test(c) ? { name: c, sequence: c } : { sequence: c };
}

function account(over: Partial<MailAccount> = {}): MailAccount {
  return {
    id: ID,
    userId: ALICE.userId,
    label: null,
    email: MAIL,
    provider: 'websupport',
    host: 'imap.example.com',
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
  const parts = path.split('/');
  return {
    path,
    name: parts[parts.length - 1] ?? path,
    parentPath: parts.length > 1 ? parts.slice(0, -1).join('/') : null,
    depth: parts.length - 1,
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

function treeOf(folders: FolderInfo[], over: Partial<FolderTree> = {}): FolderTree {
  return {
    folders,
    totals: { messages: 345, unseen: 7, bytes: 10_000, sizeSource: 'server' },
    quota: null,
    truncated: false,
    unreadable: 0,
    gmailAllHidden: false,
    fallbacks: new Set(),
    ...over,
  };
}

const TREE: FolderTree = treeOf([
  folder('INBOX', { bytes: 5000, messages: 3, role: 'inbox', roleSource: 'path' }),
  folder('Sent', { bytes: 3000 }),
  folder('Projects', { bytes: 1000 }),
]);

function mailRow(seq: number, subject = `Subject ${String(seq)}`, from = `Sender ${String(seq)}`) {
  return {
    seq,
    uid: 1000 + seq,
    received: new Date(Date.UTC(2026, 0, 1)),
    from,
    subject,
    bytes: seq,
    attachment: false,
  };
}

function pageFor(path: string): PageResult {
  const exists = path === 'INBOX' ? 3 : 0;
  const rows = path === 'INBOX' ? [3, 2, 1].map((seq) => mailRow(seq)) : [];
  return { kind: 'page', snapshot: { path, uidValidity: '7', exists }, page: 0, rows };
}

const STATS: MailboxStats = {
  folders: [
    { path: 'INBOX', messages: 100, bytes: 6000, partial: false },
    { path: 'Sent', messages: 60, bytes: 3000, partial: false },
    { path: 'Projects', messages: 40, bytes: 1000, partial: false },
  ],
  notScanned: 0,
  totals: { messages: 200, bytes: 10_000 },
  years: [
    { year: '2023', messages: 80, bytes: 4000 },
    { year: '2024', messages: 120, bytes: 6000 },
  ],
  senders: {
    bySize: [{ key: 'big@example-test-domain.eu', messages: 3, bytes: 9000 }],
    byCount: [{ key: 'many@example-test-domain.eu', messages: 50, bytes: 100 }],
    others: { messages: 0, bytes: 0 },
  },
  domains: {
    bySize: [{ key: 'example-test-domain.eu', messages: 3, bytes: 9000 }],
    byCount: [{ key: 'example-test-domain.eu', messages: 3, bytes: 9000 }],
    others: { messages: 0, bytes: 0 },
  },
  largest: [],
  approximate: false,
  unreadable: 0,
  partial: 0,
};

const EMPTY_STATS: MailboxStats = {
  ...STATS,
  folders: [],
  totals: { messages: 0, bytes: 0 },
  years: [],
  senders: { bySize: [], byCount: [], others: { messages: 0, bytes: 0 } },
  domains: { bySize: [], byCount: [], others: { messages: 0, bytes: 0 } },
};

// --- fakes ----------------------------------------------------------------------------------

interface FakeTerminal extends Terminal {
  readonly frames: Rendered[];
  screen: Screen;
  key(key: Keypress): void;
  resize(): void;
}

function fakeTerminal(screen: Screen = SCREEN): FakeTerminal {
  let keyHandler: ((key: Keypress) => void) | null = null;
  let resizeHandler: (() => void) | null = null;
  const t: FakeTerminal = {
    frames: [],
    screen,
    size: () => t.screen,
    draw: (frame) => {
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
  for (let i = 0; i < 6; i++) await settle();
}

async function stillRunning(p: Promise<unknown>): Promise<boolean> {
  return Promise.race([p.then(() => false), settle().then(() => true)]);
}

async function within(p: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([
    p.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);
}

type FakeSession = MailboxSession & { name: string };
type OpenSession = AppDeps['openSession'];
type ListFolders = NonNullable<AppDeps['listFolders']>;
type CollectStats = NonNullable<AppDeps['collectStats']>;
type Login = ((onChallenge: () => Promise<void>) => Promise<MailboxSession>) | null;

interface Read {
  session: MailboxSession;
  tree: FolderTree;
  options: Parameters<CollectStats>[2];
  done: Deferred<MailboxStats>;
}

interface Harness {
  t: FakeTerminal;
  app: App;
  deps: AppDeps;
  done: Promise<AppResult>;
  log: MemoryEventLog;
  sessions: FakeSession[];
  logouts: Map<string, ReturnType<typeof vi.fn<() => Promise<void>>>>;
  reads: Read[];
  findAccount: ReturnType<typeof vi.fn<AppDeps['findAccount']>>;
  listMailboxes: ReturnType<typeof vi.fn<AppDeps['listMailboxes']>>;
  openSession: ReturnType<typeof vi.fn<OpenSession>>;
  listFolders: ReturnType<typeof vi.fn<ListFolders>>;
  load: ReturnType<typeof vi.fn<typeof loadPage>>;
  collectStats: ReturnType<typeof vi.fn<CollectStats>>;
  onUnexpected: ReturnType<typeof vi.fn<(err: unknown) => void>>;
  account: MailAccount;
  /** The next login (in call order): null = the default one (a new session at once). */
  queue(login: Login): void;
  /** A new session with a logout spy, as the default login hands out. */
  newSession(): FakeSession;
}

interface Options {
  account?: MailAccount;
  tree?: FolderTree;
  autoStats?: boolean;
  challengeDelayMs?: number;
}

function makeHarness(options: Options = {}): Harness {
  const acct = options.account ?? account();
  const tree = options.tree ?? TREE;
  const sessions: FakeSession[] = [];
  const logouts = new Map<string, ReturnType<typeof vi.fn<() => Promise<void>>>>();
  const reads: Read[] = [];
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
  const log = new MemoryEventLog({ run: RUN, ver: '0.9.0', now: () => T0, level: 'debug' });
  const findAccount = vi.fn<AppDeps['findAccount']>(() => Promise.resolve(acct));
  const listMailboxes = vi.fn<AppDeps['listMailboxes']>(() => Promise.resolve([acct]));
  const openSession = vi.fn<OpenSession>((_account, onChallenge) => {
    const next = loginQueue.shift();
    return next === undefined || next === null ? Promise.resolve(newSession()) : next(onChallenge);
  });
  const listFolders = vi.fn<ListFolders>(() => Promise.resolve(tree));
  const load = vi.fn<typeof loadPage>((_session, path) => Promise.resolve(pageFor(path)));
  const onUnexpected = vi.fn<(err: unknown) => void>();
  // A read has no cancel: it ends when its session is logged out, as the real one does.
  const collectStats = vi.fn<CollectStats>((session, readTree, readOptions) => {
    const read: Read = { session, tree: readTree, options: readOptions, done: deferred() };
    const spy = logouts.get((session as FakeSession).name);
    const before = spy?.getMockImplementation();
    spy?.mockImplementation(() => {
      read.done.reject(new MailboxError('connection-lost'));
      return before?.() ?? Promise.resolve();
    });
    reads.push(read);
    return read.done.promise;
  });
  const deps: AppDeps = {
    terminal: t,
    version: '0.9.0',
    auth,
    listMailboxes,
    remembered: new MemoryRememberedUsers([ALICE.email]),
    log,
    loginTarget: () => TARGET,
    onUnexpected,
    findAccount,
    openSession,
    listFolders,
    load,
    collectStats,
    timeZone: TZ,
    autoStats: options.autoStats ?? true,
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
    deps,
    done: app.run(),
    log,
    sessions,
    logouts,
    reads,
    findAccount,
    listMailboxes,
    openSession,
    listFolders,
    load,
    collectStats,
    onUnexpected,
    account: acct,
    queue: (login) => {
      loginQueue.push(login);
    },
    newSession,
  };
}

const text = (frame: Rendered | undefined): string => (frame?.lines ?? []).join('\n');
const last = (h: Harness): string => text(h.t.frames.at(-1));
const collapsed = (s: string): string => s.replace(/\s+/g, ' ');

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

function events(h: Harness, name: string): Record<string, unknown>[] {
  return h.log.records.filter((r) => r.event === name);
}

const count = (h: Harness, name: string): number => events(h, name).length;

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

/** Enter on the mailbox: the bars are shown (`needle` is on the totals line). */
async function atBars(options: Options = {}, needle = 'Total:'): Promise<Harness> {
  const h = await atHome(options);
  await press(h, ENTER);
  await waitFor(h, needle);
  return h;
}

/** The bars, and the stats read has started (its collectStats call is pending). */
async function atReading(options: Options = {}): Promise<Harness> {
  const h = await atBars(options);
  await vi.waitFor(() => {
    expect(h.reads).toHaveLength(1);
  });
  return h;
}

/** The bars with the stats login (the second one) still pending. */
async function atStatsLogin(): Promise<{ h: Harness; login: Deferred<MailboxSession> }> {
  const h = await atHome();
  const login = deferred<MailboxSession>();
  h.queue(null);
  h.queue(() => login.promise);
  await press(h, ENTER);
  await waitFor(h, 'Total:');
  await vi.waitFor(() => {
    expect(h.openSession).toHaveBeenCalledTimes(2);
  });
  return { h, login };
}

/** The bars, INBOX opened and its mails shown (the stats read is pending). */
async function atMails(options: Options = {}): Promise<Harness> {
  const h = await atReading(options);
  await press(h, ENTER);
  await waitFor(h, 'Subject 3');
  return h;
}

// --- S1: starting the read ------------------------------------------------------------------

describe('S1 the stats read starts when the folders are shown', () => {
  it('a second login is made after the folders, and collectStats runs on that second session', async () => {
    const h = await atReading();
    expect(h.openSession).toHaveBeenCalledTimes(2);
    expect(h.openSession.mock.calls[1]?.[0]).toBe(h.account);
    expect(h.collectStats).toHaveBeenCalledTimes(1);
    const [session, tree, options] = h.collectStats.mock.calls[0] ?? [];
    expect(session).toBe(h.sessions[1]);
    expect(session).not.toBe(h.sessions[0]);
    expect(tree).toBe(TREE);
    expect(options).toMatchObject({ timeZone: TZ });
    expect(typeof options?.onProgress).toBe('function');
    expect(h.listFolders.mock.calls[0]?.[0]).toBe(h.sessions[0]);
    expect(logoutCount(h, 's1')).toBe(0);
    expect(logoutCount(h, 's2')).toBe(0);
    await end(h);
  });

  it('the second login is only made once the folders are there (after the first listFolders)', async () => {
    const h = await atHome();
    const reading = deferred<FolderTree>();
    h.listFolders.mockReturnValueOnce(reading.promise);
    await press(h, ENTER);
    await waitFor(h, 'Reading folders...');
    await flush();
    expect(h.openSession).toHaveBeenCalledTimes(1);
    expect(h.collectStats).not.toHaveBeenCalled();
    reading.resolve(TREE);
    await waitFor(h, 'Total:');
    await vi.waitFor(() => {
      expect(h.collectStats).toHaveBeenCalledTimes(1);
    });
    await end(h);
  });

  it('autoStats off: nothing is read until s is pressed; then the read starts and the stats screen opens', async () => {
    const h = await atBars({ autoStats: false });
    await flush();
    expect(h.openSession).toHaveBeenCalledTimes(1);
    expect(h.collectStats).not.toHaveBeenCalled();
    expect(last(h)).toContain('Stats: press s to read');
    await press(h, charKey('s'));
    await vi.waitFor(() => {
      expect(h.collectStats).toHaveBeenCalledTimes(1);
    });
    expect(h.openSession).toHaveBeenCalledTimes(2);
    expect(h.collectStats.mock.calls[0]?.[0]).toBe(h.sessions[1]);
    expect(last(h)).toContain('Years - by size');
    await end(h);
  });

  it('the finished stats show on the stats screen (Years, then the other sections)', async () => {
    const h = await atReading();
    await press(h, charKey('s'));
    h.reads[0]?.done.resolve(STATS);
    await waitFor(h, 'Scanned 3 folders, 200 messages, 9.8 KB (approx.)');
    expect(last(h)).toContain('2024');
    await press(h, charKey('2'));
    expect(last(h)).toContain('Top senders - by size');
    expect(last(h)).toContain('big@example-test-domain.eu');
    await press(h, charKey('o'));
    expect(last(h)).toContain('many@example-test-domain.eu');
    await end(h);
  });
});

describe('S2 Gmail with All Mail hidden', () => {
  const HIDDEN = treeOf(TREE.folders, { gmailAllHidden: true, totals: null });

  it('no second login and no read; the stats are failed with the Gmail text', async () => {
    const h = await atBars({ tree: HIDDEN }, 'Totals unknown');
    await flush();
    expect(h.openSession).toHaveBeenCalledTimes(1);
    expect(h.collectStats).not.toHaveBeenCalled();
    expect(last(h)).toContain("Stats couldn't be read - press s");
    await press(h, charKey('s'));
    expect(collapsed(last(h))).toContain(STATS_GMAIL_HIDDEN);
    await flush();
    expect(h.openSession).toHaveBeenCalledTimes(1);
    expect(count(h, 'stats.finish')).toBe(0);
    await end(h);
    expect(count(h, 'stats.finish')).toBe(0);
  });
});

// --- S3: the status line --------------------------------------------------------------------

describe('S3 the stats note follows the read', () => {
  it('reading..., the progress, ready, and the retry after a failure', async () => {
    const h = await atReading();
    expect(last(h)).toContain('Stats: reading...');
    expect(last(h)).toContain('s stats');
    h.reads[0]?.options.onProgress?.({ folder: 3, folders: 12, done: 5000, total: 12345 });
    await waitFor(h, 'Stats: reading folder 3/12 - 5000/12345 messages');
    h.reads[0]?.done.resolve(STATS);
    await waitFor(h, 'Stats ready - press s');
    await end(h);
  });

  it('a failed read: "Stats couldn\'t be read - press s"', async () => {
    const h = await atReading();
    h.reads[0]?.done.reject(new MailboxError('list-failed'));
    await waitFor(h, "Stats couldn't be read - press s");
    await end(h);
  });

  it('a progress that changes the frame redraws the bars', async () => {
    const h = await atReading();
    const before = h.t.frames.length;
    h.reads[0]?.options.onProgress?.({ folder: 1, folders: 4, done: 2, total: 9 });
    await waitFor(h, 'Stats: reading folder 1/4 - 2/9 messages');
    expect(h.t.frames.length).toBeGreaterThan(before);
    await end(h);
  });
});

// --- S6, S7: the stats screen at work -------------------------------------------------------

describe('S6 the stats screen: back, r, q', () => {
  it('Esc goes back to the bars while the read goes on; the result is then shown there as a note', async () => {
    const h = await atReading();
    await press(h, charKey('s'));
    expect(last(h)).toContain('Years - by size');
    await press(h, ESC);
    expect(last(h)).toContain('Total:');
    expect(logoutCount(h, 's2')).toBe(0);
    h.reads[0]?.done.resolve(STATS);
    await waitFor(h, 'Stats ready - press s');
    await end(h);
  });

  it('r after a finished read: one new login, one new read, the old stats session logged out once', async () => {
    const h = await atReading();
    await press(h, charKey('s'));
    h.reads[0]?.done.resolve(STATS);
    await waitFor(h, 'Scanned 3 folders');
    await vi.waitFor(() => {
      expect(logoutCount(h, 's2')).toBe(1);
    });
    await press(h, charKey('r'));
    await vi.waitFor(() => {
      expect(h.reads).toHaveLength(2);
    });
    expect(h.openSession).toHaveBeenCalledTimes(3);
    expect(h.reads[1]?.session).toBe(h.sessions[2]);
    expect(last(h)).toContain('Stats: reading...');
    expect(logoutCount(h, 's2')).toBe(1);
    h.reads[1]?.done.resolve(EMPTY_STATS);
    await waitFor(h, 'Scanned 0 folders, 0 messages, 0 B (approx.)');
    await end(h);
    expect(logoutCount(h, 's3')).toBe(1);
  });

  it('r pressed twice quickly: the second finds a read running and does nothing', async () => {
    const h = await atReading();
    await press(h, charKey('s'));
    h.reads[0]?.done.resolve(STATS);
    await waitFor(h, 'Scanned 3 folders');
    h.t.key(charKey('r'));
    h.t.key(charKey('r'));
    await flush();
    expect(h.openSession).toHaveBeenCalledTimes(3);
    expect(h.collectStats).toHaveBeenCalledTimes(2);
    await end(h);
  });

  it('r while the first read still runs does nothing', async () => {
    const h = await atReading();
    await press(h, charKey('s'), charKey('r'));
    await flush();
    expect(h.openSession).toHaveBeenCalledTimes(2);
    expect(h.collectStats).toHaveBeenCalledTimes(1);
    await end(h);
  });

  it('r after a failed read is one more attempt', async () => {
    const h = await atReading();
    await press(h, charKey('s'));
    h.reads[0]?.done.reject(new MailboxError('list-failed'));
    await waitFor(h, 'r try again');
    await press(h, charKey('r'));
    await vi.waitFor(() => {
      expect(h.reads).toHaveLength(2);
    });
    h.reads[1]?.done.resolve(STATS);
    await waitFor(h, 'Scanned 3 folders');
    await end(h);
  });

  it('a result of the read before r is ignored (its late progress shows nowhere)', async () => {
    const h = await atReading();
    await press(h, charKey('s'));
    h.reads[0]?.done.resolve(STATS);
    await waitFor(h, 'Scanned 3 folders');
    await press(h, charKey('r'));
    await vi.waitFor(() => {
      expect(h.reads).toHaveLength(2);
    });
    h.reads[0]?.options.onProgress?.({ folder: 9, folders: 9, done: 9, total: 9 });
    await flush();
    expect(last(h)).not.toContain('9/9');
    expect(last(h)).toContain('Stats: reading...');
    await end(h);
  });

  it('q on the stats screen quits and logs both sessions out', async () => {
    const h = await atReading();
    await press(h, charKey('s'));
    h.t.key(charKey('q'));
    await expect(h.done).resolves.toMatchObject({ end: 'quit' });
    await h.app.settled();
    expect(logoutCount(h, 's1')).toBe(1);
    expect(logoutCount(h, 's2')).toBe(1);
    expect(count(h, 'stats.finish')).toBe(0);
  });
});

// --- S8: the stats stay while the mailbox is open -------------------------------------------

describe('S8 the stats live as long as the mailbox is open', () => {
  it('they stay across opening and leaving folders', async () => {
    const h = await atReading();
    h.reads[0]?.done.resolve(STATS);
    await waitFor(h, 'Stats ready - press s');
    await press(h, ENTER);
    await waitFor(h, 'Subject 3');
    await press(h, ESC);
    await waitFor(h, 'Total:');
    expect(last(h)).toContain('Stats ready - press s');
    expect(h.collectStats).toHaveBeenCalledTimes(1);
    expect(h.openSession).toHaveBeenCalledTimes(2);
    await press(h, charKey('s'));
    expect(last(h)).toContain('Scanned 3 folders');
    await end(h);
  });

  it('a result that arrives while a folder is open is stored; the note shows when the bars are back', async () => {
    const h = await atMails();
    const before = h.t.frames.length;
    h.reads[0]?.done.resolve(STATS);
    await flush();
    expect(last(h)).toContain('Subject 3');
    expect(last(h)).not.toContain('Stats');
    expect(h.t.frames.length).toBe(before);
    await press(h, ESC);
    await waitFor(h, 'Stats ready - press s');
    await end(h);
  });

  it('a result that arrives while the leave question is open: the question stays', async () => {
    const h = await atReading();
    await press(h, ENTER);
    await waitFor(h, 'Subject 3');
    await press(h, charKey('a'));
    await waitFor(h, 'marked: 3 mails');
    await press(h, ESC, ESC);
    await waitFor(h, 'Drop 3 marks? (y/N)');
    h.reads[0]?.done.resolve(STATS);
    await flush();
    expect(last(h)).toContain('Drop 3 marks? (y/N)');
    await press(h, charKey('n'));
    await waitFor(h, 'Stats ready - press s');
    await end(h);
  });

  it('they are dropped when the mailbox is left: opening it again reads again', async () => {
    const h = await atReading();
    h.reads[0]?.done.resolve(STATS);
    await waitFor(h, 'Stats ready - press s');
    await press(h, ESC);
    expect(last(h)).toContain('Add a mailbox');
    await press(h, ENTER);
    await waitFor(h, 'Total:');
    await vi.waitFor(() => {
      expect(h.reads).toHaveLength(2);
    });
    expect(last(h)).not.toContain('Stats ready');
    expect(last(h)).toContain('Stats: reading');
    await end(h);
  });

  it('a late result of the visit that was left does not show in the next visit', async () => {
    const h = await atReading();
    await press(h, ESC);
    await press(h, ENTER);
    await waitFor(h, 'Total:');
    await vi.waitFor(() => {
      expect(h.reads).toHaveLength(2);
    });
    h.reads[0]?.done.resolve(STATS);
    await flush();
    expect(last(h)).not.toContain('Stats ready');
    expect(last(h)).toContain('Stats: reading');
    h.reads[1]?.done.resolve(STATS);
    await waitFor(h, 'Stats ready - press s');
    await end(h);
  });
});

// --- S9: every session is logged out exactly once -------------------------------------------

describe('S9 the stats session is logged out exactly once on every path', () => {
  it('when its read ends ok: at once, the mailbox session and the browser untouched', async () => {
    const h = await atReading();
    h.reads[0]?.done.resolve(STATS);
    await vi.waitFor(() => {
      expect(logoutCount(h, 's2')).toBe(1);
    });
    expect(logoutCount(h, 's1')).toBe(0);
    await press(h, ENTER);
    await waitFor(h, 'Subject 3');
    expect(h.load.mock.calls[0]?.[0]).toBe(h.sessions[0]);
    await end(h);
    expect(logoutCount(h, 's1')).toBe(1);
    expect(logoutCount(h, 's2')).toBe(1);
  });

  it('when its read fails: logged out once, the failure shown, the bars still work', async () => {
    const h = await atReading();
    h.reads[0]?.done.reject(new MailboxError('list-failed'));
    await waitFor(h, "Stats couldn't be read - press s");
    expect(logoutCount(h, 's2')).toBe(1);
    expect(logoutCount(h, 's1')).toBe(0);
    await press(h, ENTER);
    await waitFor(h, 'Subject 3');
    await end(h);
    expect(logoutCount(h, 's2')).toBe(1);
  });

  it('when the mailbox is left during the read: both logged out, the late failure shows nothing', async () => {
    const h = await atReading();
    await press(h, ESC);
    expect(last(h)).toContain('Add a mailbox');
    expect(logoutCount(h, 's1')).toBe(1);
    expect(logoutCount(h, 's2')).toBe(1);
    await flush();
    expect(last(h)).toContain('Add a mailbox');
    expect(last(h)).not.toContain('Stats');
    expect(h.onUnexpected).not.toHaveBeenCalled();
    expect(count(h, 'stats.finish')).toBe(0);
    expect(await stillRunning(h.done)).toBe(true);
    await end(h);
    expect(logoutCount(h, 's1')).toBe(1);
    expect(logoutCount(h, 's2')).toBe(1);
  });

  it('a stats login that arrives after the mailbox was left is logged out at once; no read', async () => {
    const { h, login } = await atStatsLogin();
    await press(h, ESC);
    expect(last(h)).toContain('Add a mailbox');
    const late = h.newSession();
    login.resolve(late);
    await vi.waitFor(() => {
      expect(logoutCount(h, late.name)).toBe(1);
    });
    await flush();
    expect(h.collectStats).not.toHaveBeenCalled();
    expect(count(h, 'stats.finish')).toBe(0);
    expect(logoutCount(h, late.name)).toBe(1);
    await end(h);
    expect(logoutCount(h, late.name)).toBe(1);
  });

  it('q during the read: both logged out before settled() returns', async () => {
    const h = await atReading();
    h.t.key(charKey('q'));
    await expect(h.done).resolves.toMatchObject({ end: 'quit' });
    await h.app.settled();
    expect(logoutCount(h, 's1')).toBe(1);
    expect(logoutCount(h, 's2')).toBe(1);
    expect(count(h, 'stats.finish')).toBe(0);
  });

  it('Ctrl+C during the read: ends at once; settled() returns in time; both logged out once', async () => {
    const h = await atReading();
    h.t.key(CTRL_C);
    await expect(h.done).resolves.toMatchObject({ end: 'interrupt' });
    expect(await within(h.app.settled(), 1500)).toBe(true);
    expect(logoutCount(h, 's1')).toBe(1);
    expect(logoutCount(h, 's2')).toBe(1);
    expect(count(h, 'stats.finish')).toBe(0);
  });

  it('Ctrl+C during the stats login: settled() waits for it, the late session is logged out, no read', async () => {
    const { h, login } = await atStatsLogin();
    h.t.key(CTRL_C);
    await expect(h.done).resolves.toMatchObject({ end: 'interrupt' });
    const settled = h.app.settled();
    expect(await stillRunning(settled)).toBe(true);
    const late = h.newSession();
    login.resolve(late);
    await settled;
    expect(logoutCount(h, late.name)).toBe(1);
    expect(logoutCount(h, 's1')).toBe(1);
    expect(h.collectStats).not.toHaveBeenCalled();
    expect(count(h, 'stats.finish')).toBe(0);
  });

  it('a crash (an error that is not user-facing elsewhere) logs both out inside settled()', async () => {
    const h = await atReading();
    const err = new Error('boom');
    h.load.mockRejectedValueOnce(err);
    h.t.key(ENTER);
    await expect(h.done).rejects.toBe(err);
    await h.app.settled();
    expect(logoutCount(h, 's1')).toBe(1);
    expect(logoutCount(h, 's2')).toBe(1);
  });

  it('pages keep loading on the mailbox session while the stats are read', async () => {
    const h = await atMails();
    expect(h.load).toHaveBeenCalledTimes(1);
    expect(h.load.mock.calls[0]?.[0]).toBe(h.sessions[0]);
    expect(h.reads).toHaveLength(1);
    expect(logoutCount(h, 's2')).toBe(0);
    await press(h, ESC);
    await press(h, DOWN, DOWN, ENTER);
    await vi.waitFor(() => {
      expect(h.load).toHaveBeenCalledTimes(2);
    });
    expect(h.load.mock.calls[1]?.[0]).toBe(h.sessions[0]);
    await end(h);
  });

  it('a reconnect of the browser during the read leaves the stats session alone', async () => {
    const h = await atReading();
    h.load.mockRejectedValueOnce(new MailboxError('connection-lost'));
    await press(h, ENTER);
    await waitFor(h, 'Connection closed - reconnect? (y/N)');
    expect(logoutCount(h, 's2')).toBe(0);
    await press(h, charKey('y'));
    await waitFor(h, 'Subject 3');
    expect(logoutCount(h, 's1')).toBe(1);
    expect(logoutCount(h, 's2')).toBe(0);
    expect(h.sessions).toHaveLength(3);
    h.reads[0]?.done.resolve(STATS);
    await press(h, ESC);
    await waitFor(h, 'Stats ready - press s');
    await end(h);
    expect(logoutCount(h, 's1')).toBe(1);
    expect(logoutCount(h, 's2')).toBe(1);
    expect(logoutCount(h, 's3')).toBe(1);
  });

  it('the stats read failing on its own does not touch the browser', async () => {
    const h = await atMails();
    h.reads[0]?.done.reject(new MailboxError('connection-lost'));
    await flush();
    expect(last(h)).toContain('Subject 3');
    expect(last(h)).not.toContain('reconnect');
    expect(logoutCount(h, 's2')).toBe(1);
    expect(logoutCount(h, 's1')).toBe(0);
    await press(h, ESC);
    await waitFor(h, "Stats couldn't be read - press s");
    await end(h);
  });
});

// --- S10: failures --------------------------------------------------------------------------

describe('S10 a failed stats login or read', () => {
  it('a user-facing login failure: its text on the stats screen, wrapped, in ASCII', async () => {
    const h = await atHome();
    const err = new ImapSessionError('auth-failed');
    h.queue(null);
    h.queue(() => Promise.reject(err));
    await press(h, ENTER);
    await waitFor(h, "Stats couldn't be read - press s");
    await press(h, charKey('s'));
    expect(collapsed(last(h))).toContain(collapsed(asciiText(accountErrorText(err, h.account))));
    for (const line of h.t.frames.at(-1)?.lines ?? []) expect(line).toMatch(/^[\x20-\x7E]*$/);
    expect(last(h)).toContain('r try again');
    await end(h);
  });

  it('a stats login blocked by the guard: its text; the bars and the browser keep working; r is one more attempt', async () => {
    const h = await atHome();
    const err = new LoginBlockedError('too-many-attempts', new Date(Date.UTC(2099, 0, 1, 12)));
    h.queue(null);
    h.queue(() => Promise.reject(err));
    await press(h, ENTER);
    await waitFor(h, "Stats couldn't be read - press s");
    await press(h, ENTER);
    await waitFor(h, 'Subject 3');
    await press(h, ESC);
    await press(h, charKey('s'));
    expect(collapsed(last(h))).toContain(collapsed(asciiText(accountErrorText(err, h.account))));
    await press(h, charKey('r'));
    await vi.waitFor(() => {
      expect(h.reads).toHaveLength(1);
    });
    expect(h.openSession).toHaveBeenCalledTimes(3);
    h.reads[0]?.done.resolve(STATS);
    await waitFor(h, 'Scanned 3 folders');
    await end(h);
  });

  it('a user-facing read failure: its text, the session logged out', async () => {
    const h = await atReading();
    const err = new MailboxError('list-failed');
    await press(h, charKey('s'));
    h.reads[0]?.done.reject(err);
    await waitFor(h, 'r try again');
    expect(collapsed(last(h))).toContain(collapsed(asciiText(accountErrorText(err, h.account))));
    expect(logoutCount(h, 's2')).toBe(1);
    await end(h);
  });

  it('a read failure that is not user-facing: onUnexpected once, the generic text, the app goes on', async () => {
    const h = await atReading();
    const err = new Error('boom');
    await press(h, charKey('s'));
    h.reads[0]?.done.reject(err);
    await waitFor(h, 'Unexpected error while reading the stats.');
    expect(h.onUnexpected).toHaveBeenCalledTimes(1);
    expect(h.onUnexpected).toHaveBeenCalledWith(err);
    expect(logoutCount(h, 's2')).toBe(1);
    expect(await stillRunning(h.done)).toBe(true);
    await press(h, ESC);
    expect(last(h)).toContain('Total:');
    await end(h);
  });

  it('a login failure that is not user-facing: the same, and the app goes on', async () => {
    const h = await atHome();
    const err = new Error('boom');
    h.queue(null);
    h.queue(() => Promise.reject(err));
    await press(h, ENTER);
    await waitFor(h, "Stats couldn't be read - press s");
    expect(h.onUnexpected).toHaveBeenCalledTimes(1);
    expect(h.onUnexpected).toHaveBeenCalledWith(err);
    await press(h, charKey('s'));
    expect(last(h)).toContain('Unexpected error while reading the stats.');
    expect(await stillRunning(h.done)).toBe(true);
    await end(h);
  });

  it('nothing is retried by itself', async () => {
    const h = await atHome();
    h.queue(null);
    h.queue(() => Promise.reject(new ImapSessionError('timeout')));
    await press(h, ENTER);
    await waitFor(h, "Stats couldn't be read - press s");
    await flush();
    await flush();
    expect(h.openSession).toHaveBeenCalledTimes(2);
    expect(h.collectStats).not.toHaveBeenCalled();
    await end(h);
  });
});

// --- S11: stats.finish ----------------------------------------------------------------------

describe('S11 stats.finish', () => {
  it('ok: once per read, with acct, folders, messages, bytes and ms', async () => {
    const h = await atReading();
    h.reads[0]?.done.resolve(STATS);
    await waitFor(h, 'Stats ready - press s');
    const lines = events(h, 'stats.finish');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      acct: ID,
      folders: 3,
      messages: 200,
      bytes: 10_000,
      outcome: 'ok',
    });
    expect(typeof lines[0]?.['ms']).toBe('number');
    expect(lines[0]?.['reason']).toBeUndefined();
    await end(h);
    expect(count(h, 'stats.finish')).toBe(1);
  });

  it('a mailbox with no selectable folder: ok with zeros', async () => {
    const h = await atReading();
    h.reads[0]?.done.resolve(EMPTY_STATS);
    await waitFor(h, 'Stats ready - press s');
    expect(events(h, 'stats.finish')).toEqual([
      expect.objectContaining({ acct: ID, folders: 0, messages: 0, bytes: 0, outcome: 'ok' }),
    ]);
    await end(h);
  });

  it('failed in the login: zeros and the reason', async () => {
    const h = await atHome();
    h.queue(null);
    h.queue(() => Promise.reject(new ImapSessionError('auth-failed')));
    await press(h, ENTER);
    await waitFor(h, "Stats couldn't be read - press s");
    expect(events(h, 'stats.finish')).toEqual([
      expect.objectContaining({
        acct: ID,
        folders: 0,
        messages: 0,
        bytes: 0,
        outcome: 'failed',
        reason: 'auth-failed',
      }),
    ]);
    await end(h);
  });

  it('failed in the read: zeros and the reason of the error', async () => {
    const h = await atReading();
    h.reads[0]?.done.reject(new MailboxError('list-failed'));
    await waitFor(h, "Stats couldn't be read - press s");
    expect(events(h, 'stats.finish')).toEqual([
      expect.objectContaining({
        folders: 0,
        messages: 0,
        bytes: 0,
        outcome: 'failed',
        reason: 'list-failed',
      }),
    ]);
    await end(h);
  });

  it('an unexpected error is reason "unexpected"', async () => {
    const h = await atReading();
    h.reads[0]?.done.reject(new Error('boom'));
    await waitFor(h, "Stats couldn't be read - press s");
    expect(events(h, 'stats.finish')).toEqual([
      expect.objectContaining({ outcome: 'failed', reason: 'unexpected' }),
    ]);
    await end(h);
  });

  it('one line per read that ended: a failed read and its retry write two', async () => {
    const h = await atReading();
    await press(h, charKey('s'));
    h.reads[0]?.done.reject(new MailboxError('list-failed'));
    await waitFor(h, 'r try again');
    await press(h, charKey('r'));
    await vi.waitFor(() => {
      expect(h.reads).toHaveLength(2);
    });
    h.reads[1]?.done.resolve(STATS);
    await waitFor(h, 'Scanned 3 folders');
    const lines = events(h, 'stats.finish');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ outcome: 'failed' });
    expect(lines[1]).toMatchObject({ outcome: 'ok' });
    await end(h);
  });

  it('none for a read stopped by leaving, quitting or Ctrl+C', async () => {
    const left = await atReading();
    await press(left, ESC);
    await flush();
    await end(left);
    expect(count(left, 'stats.finish')).toBe(0);

    const quit = await atReading();
    quit.t.key(charKey('q'));
    await quit.done;
    await quit.app.settled();
    expect(count(quit, 'stats.finish')).toBe(0);

    const interrupted = await atReading();
    interrupted.t.key(CTRL_C);
    await interrupted.done;
    await interrupted.app.settled();
    expect(count(interrupted, 'stats.finish')).toBe(0);
  });

  it('none for the read of an earlier visit that ends late', async () => {
    const h = await atReading();
    await press(h, ESC);
    h.reads[0]?.done.resolve(STATS);
    await flush();
    expect(count(h, 'stats.finish')).toBe(0);
    await end(h);
  });
});

// --- S12: nothing private in the log --------------------------------------------------------

describe('S12 the log carries no sender, domain, subject or folder name', () => {
  const NAME = 'CanaryFolder-48151\u202E';
  const SUBJECT = 'CanarySubject-62342';
  const SENDER = 'canary.sender@canary-domain.example-test-domain.eu';
  const HOST = 'imap.canary-host.example-test-domain.eu';
  const USER = 'canary-user-name-77';
  const NEEDLES = [
    'CanaryFolder',
    NAME,
    SUBJECT,
    'CanarySubject',
    SENDER,
    'canary.sender',
    'canary-domain',
    HOST,
    'canary-host',
    USER,
    'canary-user-name',
    MAIL,
    'example-test-domain',
  ];
  const ALLOWED = new Set(['folders.list', 'browse.finish', 'stats.finish', 'error.unexpected']);

  it('across a visit, a failed read, r, a screen of stats and leaving during a read', async () => {
    const canary = account({ host: HOST, username: USER });
    const tree = treeOf([folder(NAME, { bytes: 5000 }), folder('Plain')]);
    const canaryStats: MailboxStats = {
      ...STATS,
      folders: [{ path: NAME, messages: 10, bytes: 100, partial: false }],
      senders: {
        bySize: [{ key: SENDER, messages: 3, bytes: 9000 }],
        byCount: [{ key: SENDER, messages: 3, bytes: 9000 }],
        others: { messages: 0, bytes: 0 },
      },
      domains: {
        bySize: [{ key: 'canary-domain.example-test-domain.eu', messages: 3, bytes: 9000 }],
        byCount: [],
        others: { messages: 0, bytes: 0 },
      },
      largest: [
        { folder: NAME, received: new Date(T0), from: SENDER, subject: SUBJECT, bytes: 9000 },
      ],
    };
    const h = await atHome({ account: canary, tree });
    h.queue(null);
    h.queue(() => Promise.reject(new ImapSessionError('auth-failed')));
    await press(h, ENTER);
    await waitFor(h, "Stats couldn't be read - press s");
    await press(h, charKey('s'), charKey('r'));
    await vi.waitFor(() => {
      expect(h.reads).toHaveLength(1);
    });
    h.reads[0]?.done.resolve(canaryStats);
    await waitFor(h, 'Scanned 1 folder');
    await press(h, charKey('4'));
    await waitFor(h, 'CanarySubject');
    await press(h, charKey('r'));
    await vi.waitFor(() => {
      expect(h.reads).toHaveLength(2);
    });
    await press(h, ESC, ESC);
    await end(h);

    expect(count(h, 'stats.finish')).toBe(2);
    const all = JSON.stringify(h.log.records) + h.log.lines.join('\n');
    for (const needle of NEEDLES) expect(all, needle).not.toContain(needle);
    for (const record of h.log.records) {
      const name = String(record.event);
      expect(ALLOWED.has(name) || /^(imap|auth|command)\./.test(name), name).toBe(true);
    }
  });
});

// --- S13: no redraw of an unchanged frame ---------------------------------------------------

describe('S13 a stats action redraws only when the frame differs', () => {
  it('progress steps while a folder is open draw nothing', async () => {
    const h = await atMails();
    const before = h.t.frames.length;
    const options = h.reads[0]?.options;
    for (let i = 1; i <= 5; i++) {
      options?.onProgress?.({ folder: i, folders: 5, done: i, total: 10 });
    }
    await flush();
    expect(h.t.frames.length).toBe(before);
    expect(last(h)).toContain('Subject 3');
    await end(h);
  });

  it('a result that does not change the frame draws nothing either', async () => {
    const h = await atMails();
    const before = h.t.frames.length;
    h.reads[0]?.done.reject(new MailboxError('list-failed'));
    await flush();
    expect(h.t.frames.length).toBe(before);
    await end(h);
  });

  it('on the bars a progress step that changes the status line does draw', async () => {
    const h = await atReading();
    const before = h.t.frames.length;
    h.reads[0]?.options.onProgress?.({ folder: 2, folders: 5, done: 1, total: 3 });
    await waitFor(h, 'Stats: reading folder 2/5 - 1/3 messages');
    expect(h.t.frames.length).toBe(before + 1);
    await end(h);
  });
});
