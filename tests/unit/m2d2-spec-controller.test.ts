import { afterEach, describe, it, expect, vi } from 'vitest';
import { createApp } from '../../src/cli/app/controller.js';
import type { App, AppDeps, AppResult, MailboxSession } from '../../src/cli/app/controller.js';
import { asciiText } from '../../src/cli/app/state.js';
import { accountErrorText } from '../../src/cli/account-text.js';
import { CHALLENGE_NOTICE, RECONNECT_FAILED_TEXT } from '../../src/cli/browser/controller.js';
import type { Rendered } from '../../src/cli/browser/render.js';
import type { Keypress, Screen } from '../../src/cli/browser/state.js';
import type { Terminal } from '../../src/cli/browser/terminal.js';
import { AccountError } from '../../src/core/accounts.js';
import type { AuthUser, LogoutResult } from '../../src/core/auth.js';
import type { MailAccount } from '../../src/core/db/repos.js';
import { ImapSessionError } from '../../src/core/imap/errors.js';
import { MemoryEventLog } from '../../src/core/log/index.js';
import { MailboxError } from '../../src/core/mailbox/errors.js';
import type { FolderInfo, FolderTree, SizeProgress } from '../../src/core/mailbox/folders.js';
import type { PageResult, loadPage } from '../../src/core/mailbox/messages.js';
import { MemoryRememberedUsers } from '../../src/core/remembered-users.js';
import { LoginBlockedError } from '../../src/core/security/login-guard.js';

// M2d-2 app controller (spec AC1, AC8-AC10, AC12-AC15, AC17, AC18): keys -> reducers -> effects,
// driven with a fake Terminal, fake sessions (a logout spy each), fake findAccount / openSession /
// listFolders / load (deferred promises where order matters) and a MemoryEventLog. No Supabase,
// no IMAP, no real terminal, no real clock (the challenge wait is shortened by challengeDelayMs).

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

const k = (name: string, extra: Keypress = {}): Keypress => ({ name, sequence: name, ...extra });
const ENTER = k('return', { sequence: '\r' });
const DOWN = k('down', { sequence: '\x1b[B' });
const LEFT = k('left', { sequence: '\x1b[D' });
const CTRL_C = k('c', { ctrl: true, sequence: '\x03' });
const ESC = k('escape', { meta: true, sequence: '\x1b' });

/** The keypress readline would deliver for one typed character. */
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

// Rows: INBOX (three mails, no subfolder), Sent, Projects with the subfolder Alpha.
const TREE: FolderTree = treeOf([
  folder('INBOX', { bytes: 5000, messages: 3, role: 'inbox', roleSource: 'path' }),
  folder('Sent', { bytes: 3000 }),
  folder('Projects', { bytes: 1000 }),
  folder('Projects/Alpha', { bytes: 500 }),
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

/** Three mails (bytes 3 + 2 + 1) for INBOX, an empty folder for every other path. */
function pageFor(path: string, subject?: string): PageResult {
  const exists = path === 'INBOX' ? 3 : 0;
  const rows =
    path === 'INBOX'
      ? [3, 2, 1].map((seq) => mailRow(seq, subject && `${subject} ${String(seq)}`))
      : [];
  return { kind: 'page', snapshot: { path, uidValidity: '7', exists }, page: 0, rows };
}

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

/** true when `p` settled within `ms` real milliseconds. */
async function within(p: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([
    p.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);
}

type FakeSession = MailboxSession & { name: string };
type OpenSession = AppDeps['openSession'];
type ListFolders = NonNullable<AppDeps['listFolders']>;

interface Harness {
  t: FakeTerminal;
  app: App;
  deps: AppDeps;
  done: Promise<AppResult>;
  log: MemoryEventLog;
  /** What happened, in order: `open:<n>`, `logout:<name>`. */
  order: string[];
  /** Every session handed out by the default openSession, in order (s1, s2, ...). */
  sessions: FakeSession[];
  logouts: Map<string, ReturnType<typeof vi.fn<() => Promise<void>>>>;
  findAccount: ReturnType<typeof vi.fn<AppDeps['findAccount']>>;
  listMailboxes: ReturnType<typeof vi.fn<AppDeps['listMailboxes']>>;
  openSession: ReturnType<typeof vi.fn<OpenSession>>;
  listFolders: ReturnType<typeof vi.fn<ListFolders>>;
  load: ReturnType<typeof vi.fn<typeof loadPage>>;
  onUnexpected: ReturnType<typeof vi.fn<(err: unknown) => void>>;
  account: MailAccount;
}

interface Options {
  account?: MailAccount;
  tree?: FolderTree;
  challengeDelayMs?: number;
}

function makeHarness(options: Options = {}): Harness {
  const acct = options.account ?? account();
  const tree = options.tree ?? TREE;
  const order: string[] = [];
  const sessions: FakeSession[] = [];
  const logouts = new Map<string, ReturnType<typeof vi.fn<() => Promise<void>>>>();
  const makeSession = (): FakeSession => {
    const name = `s${String(sessions.length + 1)}`;
    const logout = vi.fn<() => Promise<void>>(() => {
      order.push(`logout:${name}`);
      return Promise.resolve();
    });
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
  const openSession = vi.fn<OpenSession>(() => {
    order.push(`open:${String(sessions.length + 1)}`);
    return Promise.resolve(makeSession());
  });
  const listFolders = vi.fn<ListFolders>(() => Promise.resolve(tree));
  const load = vi.fn<typeof loadPage>((_session, path) => Promise.resolve(pageFor(path)));
  const onUnexpected = vi.fn<(err: unknown) => void>();
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
    readLogs: NO_LOGS,
    ...NO_ADD,
    autoStats: false,
    ...(options.challengeDelayMs !== undefined && { challengeDelayMs: options.challengeDelayMs }),
  };
  const app = createApp(deps);
  return {
    t,
    app,
    deps,
    done: app.run(),
    log,
    order,
    sessions,
    logouts,
    findAccount,
    listMailboxes,
    openSession,
    listFolders,
    load,
    onUnexpected,
    account: acct,
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

/** Signed-in ALICE on Home with the one mailbox listed. */
async function atHome(options: Options = {}): Promise<Harness> {
  const h = makeHarness(options);
  await waitFor(h, 'Sign in as another user');
  await press(h, ENTER);
  await waitFor(h, MAIL);
  return h;
}

/** Enter on the mailbox: the bars are shown. */
async function atBars(options: Options = {}): Promise<Harness> {
  const h = await atHome(options);
  await press(h, ENTER);
  await waitFor(h, 'Total:');
  return h;
}

/** On the bars, INBOX opened and its three mails shown. */
async function atMails(options: Options = {}): Promise<Harness> {
  const h = await atBars(options);
  await press(h, ENTER);
  await waitFor(h, 'Subject 3');
  return h;
}

/** On the bars with three marks (mark screen in INBOX, then Esc back). */
async function barsWithMarks(options: Options = {}): Promise<Harness> {
  const h = await atMails(options);
  await press(h, charKey('a'));
  await waitFor(h, 'marked: 3 mails');
  await press(h, ESC);
  await waitFor(h, 'Total:');
  return h;
}

/** Enter on the mailbox with a login that stays pending. */
async function connecting(): Promise<{ h: Harness; login: Deferred<MailboxSession> }> {
  const h = await atHome();
  const login = deferred<MailboxSession>();
  h.openSession.mockImplementationOnce(() => {
    h.order.push(`open:${String(h.sessions.length + 1)}`);
    return login.promise;
  });
  await press(h, ENTER);
  await waitFor(h, 'Connecting...');
  return { h, login };
}

function lateSession(h: Harness, name = 'late'): FakeSession {
  const logout = vi.fn<() => Promise<void>>(() => {
    h.order.push(`logout:${name}`);
    return Promise.resolve();
  });
  h.logouts.set(name, logout);
  return { name, client: {}, features: {}, closed: false, logout } as unknown as FakeSession;
}

// --- AC1: opening a mailbox -----------------------------------------------------------------

describe('AC1 opening a mailbox', () => {
  it('Enter on the mailbox: "Connecting...", the account is looked up by id and one login is started', async () => {
    const { h, login } = await connecting();
    expect(h.findAccount).toHaveBeenCalledTimes(1);
    expect(h.findAccount).toHaveBeenCalledWith(ID);
    await vi.waitFor(() => {
      expect(h.openSession).toHaveBeenCalledTimes(1);
    });
    expect(h.openSession).toHaveBeenCalledWith(h.account, expect.any(Function));
    expect(h.listFolders).not.toHaveBeenCalled();
    // Settle the pending login before the end: the visit is left, so its session is logged out.
    await press(h, ESC);
    login.resolve(lateSession(h));
    await vi.waitFor(() => {
      expect(logoutCount(h, 'late')).toBe(1);
    });
    await end(h);
  });

  it('after the login: "Reading folders...", the folders are read on that session', async () => {
    const h = await atHome();
    const reading = deferred<FolderTree>();
    h.listFolders.mockReturnValueOnce(reading.promise);
    await press(h, ENTER);
    await waitFor(h, 'Reading folders...');
    expect(h.listFolders).toHaveBeenCalledTimes(1);
    expect(h.listFolders.mock.calls[0]?.[0]).toBe(h.sessions[0]);
    expect(last(h)).not.toContain('Connecting...');
    reading.resolve(TREE);
    await waitFor(h, 'Total:');
    await end(h);
  });

  it('progress of the size fallback shows as "Reading folders... n/m"', async () => {
    const h = await atHome();
    const reading = deferred<FolderTree>();
    let report: ((p: SizeProgress) => void) | undefined;
    h.listFolders.mockImplementationOnce((_session, onProgress) => {
      report = onProgress;
      return reading.promise;
    });
    await press(h, ENTER);
    await waitFor(h, 'Reading folders...');
    report?.({ folder: 2, folders: 5, done: 10, total: 90 });
    await waitFor(h, 'Reading folders... 2/5');
    report?.({ folder: 3, folders: 5, done: 1, total: 4 });
    await waitFor(h, 'Reading folders... 3/5');
    reading.resolve(TREE);
    await end(h);
  });

  it('the bars appear with the totals, the mailbox in the header and the folders as rows', async () => {
    const h = await atBars();
    expect(last(h)).toContain(`Mail Manager - ${MAIL}`);
    expect(last(h)).toContain('Total: 345 messages, 7 unread, 9.8 KB');
    for (const name of ['INBOX', 'Sent', 'Projects', 'Alpha']) expect(last(h)).toContain(name);
    expect(h.findAccount).toHaveBeenCalledTimes(1);
    expect(h.openSession).toHaveBeenCalledTimes(1);
    expect(h.listFolders).toHaveBeenCalledTimes(1);
    expect(logoutCount(h, 's1')).toBe(0);
    await end(h);
  });

  it('a truncated tree shows its message on the bars', async () => {
    const h = await atBars({ tree: { ...TREE, truncated: true } });
    expect(last(h)).toContain('Only the first 5,000 folders are shown.');
    await end(h);
  });

  it('a login that waits for a challenge shows the notice while connecting, then goes on', async () => {
    const h = await atHome({ challengeDelayMs: 20 });
    h.openSession.mockImplementationOnce(async (_account, onChallenge) => {
      await onChallenge();
      return lateSession(h, 's1');
    });
    await press(h, ENTER);
    await waitFor(h, CHALLENGE_NOTICE);
    await waitFor(h, 'Total:');
    await end(h);
  });

  it('a mailbox that is gone (findAccount not-found): the failed screen, no login', async () => {
    const h = await atHome();
    const err = new AccountError('not-found');
    h.findAccount.mockRejectedValueOnce(err);
    await press(h, ENTER);
    await waitFor(h, 'r try again');
    expect(collapsed(last(h))).toContain(collapsed(asciiText(accountErrorText(err))));
    expect(h.openSession).not.toHaveBeenCalled();
    expect(events(h, 'folders.list')).toEqual([
      expect.objectContaining({ outcome: 'failed', reason: 'not-found' }),
    ]);
    await end(h);
  });
});

// --- AC8: leaving the bars ------------------------------------------------------------------

describe('AC8 leaving the bars', () => {
  it.each([
    ['Esc', ESC],
    ['Left', LEFT],
    ['Backspace', k('backspace', { sequence: '\x7f' })],
  ])('%s on the bars: Home, no reload, the session logged out once', async (_n, key) => {
    const h = await atBars();
    await press(h, key);
    expect(last(h)).toContain(MAIL);
    expect(last(h)).toContain('Add a mailbox');
    expect(last(h)).not.toContain('Total:');
    expect(logoutCount(h, 's1')).toBe(1);
    expect(h.openSession).toHaveBeenCalledTimes(1);
    expect(await stillRunning(h.done)).toBe(true);
    await end(h);
    expect(logoutCount(h, 's1')).toBe(1);
  });

  it('Home comes back without reading the mailbox list again', async () => {
    const h = await atBars();
    expect(h.listMailboxes).toHaveBeenCalledTimes(1);
    await press(h, ESC);
    expect(last(h)).toContain(MAIL);
    await settle();
    expect(h.listMailboxes).toHaveBeenCalledTimes(1);
    await end(h);
  });

  it('opening the same mailbox again logs in again with a new session; the old one stays logged out', async () => {
    const h = await atBars();
    await press(h, ESC);
    await press(h, ENTER);
    await waitFor(h, 'Total:');
    expect(h.openSession).toHaveBeenCalledTimes(2);
    expect(h.listFolders.mock.calls[1]?.[0]).toBe(h.sessions[1]);
    expect(logoutCount(h, 's1')).toBe(1);
    expect(logoutCount(h, 's2')).toBe(0);
    await end(h);
    expect(logoutCount(h, 's2')).toBe(1);
  });

  it('Left while connecting: Home at once; the session that arrives later is logged out at once and nothing else happens', async () => {
    const { h, login } = await connecting();
    await press(h, ESC);
    expect(last(h)).toContain('Add a mailbox');
    expect(last(h)).not.toContain('Connecting...');
    const late = lateSession(h);
    login.resolve(late);
    await vi.waitFor(() => {
      expect(logoutCount(h, 'late')).toBe(1);
    });
    await settle();
    expect(h.listFolders).not.toHaveBeenCalled();
    expect(last(h)).toContain('Add a mailbox');
    expect(last(h)).not.toContain('Total:');
    expect(count(h, 'folders.list')).toBe(0);
    expect(count(h, 'browse.finish')).toBe(0);
    await end(h);
  });

  it('Left while reading: the session is logged out, the read is dropped, no folders.list is written', async () => {
    const h = await atHome();
    const reading = deferred<FolderTree>();
    h.listFolders.mockReturnValueOnce(reading.promise);
    await press(h, ENTER);
    await waitFor(h, 'Reading folders...');
    await press(h, ESC);
    expect(last(h)).toContain('Add a mailbox');
    expect(logoutCount(h, 's1')).toBe(1);
    reading.resolve(TREE);
    await settle();
    await settle();
    expect(last(h)).toContain('Add a mailbox');
    expect(last(h)).not.toContain('Total:');
    expect(count(h, 'folders.list')).toBe(0);
    expect(logoutCount(h, 's1')).toBe(1);
    await end(h);
  });

  it('Left while reading, and the read then fails because the session was closed: nothing is shown or logged', async () => {
    const h = await atHome();
    const reading = deferred<FolderTree>();
    h.listFolders.mockReturnValueOnce(reading.promise);
    await press(h, ENTER);
    await waitFor(h, 'Reading folders...');
    await press(h, ESC);
    reading.reject(new MailboxError('connection-lost'));
    await settle();
    await settle();
    expect(last(h)).toContain('Add a mailbox');
    expect(last(h)).not.toContain('r try again');
    expect(count(h, 'folders.list')).toBe(0);
    expect(h.onUnexpected).not.toHaveBeenCalled();
    expect(await stillRunning(h.done)).toBe(true);
    await end(h);
  });

  it('with marks, Esc asks "Drop 3 marks? (y/N)" first; the session stays open', async () => {
    const h = await barsWithMarks();
    await press(h, ESC);
    expect(last(h)).toContain('Drop 3 marks? (y/N)');
    expect(logoutCount(h, 's1')).toBe(0);
    await end(h);
  });

  it('with marks, any other key than y stays on the bars with the marks', async () => {
    const h = await barsWithMarks();
    await press(h, ESC, charKey('n'));
    expect(last(h)).toContain('Total:');
    expect(last(h)).not.toContain('(y/N)');
    expect(logoutCount(h, 's1')).toBe(0);
    await press(h, ENTER);
    await waitFor(h, 'marked: 3 mails');
    await end(h);
  });

  it('with marks, y leaves: Home, the marks dropped, the session logged out', async () => {
    const h = await barsWithMarks();
    await press(h, ESC, charKey('y'));
    expect(last(h)).toContain('Add a mailbox');
    expect(logoutCount(h, 's1')).toBe(1);
    await press(h, ENTER);
    await waitFor(h, 'Total:');
    await press(h, ENTER);
    await waitFor(h, 'Subject 3');
    expect(last(h)).toContain('marked: 0 mails');
    await end(h);
  });
});

// --- AC9: q and Ctrl+C ----------------------------------------------------------------------

describe('AC9 quitting', () => {
  it('q on the bars ends the app with quit and logs the session out', async () => {
    const h = await atBars();
    h.t.key(charKey('q'));
    await expect(h.done).resolves.toMatchObject({ end: 'quit' });
    await h.app.settled();
    expect(logoutCount(h, 's1')).toBe(1);
  });

  it('q with marks asks "Quit and drop 3 marks? (y/N)" first; n stays', async () => {
    const h = await barsWithMarks();
    await press(h, charKey('q'));
    expect(last(h)).toContain('Quit and drop 3 marks? (y/N)');
    expect(await stillRunning(h.done)).toBe(true);
    await press(h, charKey('n'));
    expect(last(h)).toContain('Total:');
    expect(await stillRunning(h.done)).toBe(true);
    expect(logoutCount(h, 's1')).toBe(0);
    await end(h);
  });

  it('q with marks, then y: quits and logs the session out', async () => {
    const h = await barsWithMarks();
    await press(h, charKey('q'), charKey('y'));
    await expect(h.done).resolves.toMatchObject({ end: 'quit' });
    await h.app.settled();
    expect(logoutCount(h, 's1')).toBe(1);
  });

  it('Ctrl+C while connecting: ends at once; settled() waits for the login and logs the late session out', async () => {
    const { h, login } = await connecting();
    h.t.key(CTRL_C);
    await expect(h.done).resolves.toMatchObject({ end: 'interrupt' });
    const settled = h.app.settled();
    expect(await stillRunning(settled)).toBe(true);
    const late = lateSession(h);
    login.resolve(late);
    await settled;
    expect(logoutCount(h, 'late')).toBe(1);
    expect(h.listFolders).not.toHaveBeenCalled();
    expect(count(h, 'folders.list')).toBe(0);
  });

  it('Ctrl+C while connecting with a login that never answers: settled() gives up after 5 seconds', async () => {
    const { h } = await connectingNever();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    h.t.key(CTRL_C);
    await expect(h.done).resolves.toMatchObject({ end: 'interrupt' });
    const settled = h.app.settled();
    expect(await stillRunning(settled)).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(settled).resolves.toBeUndefined();
  });

  it('Ctrl+C while reading: ends at once and the session is logged out', async () => {
    const h = await atHome();
    const reading = deferred<FolderTree>();
    h.listFolders.mockReturnValueOnce(reading.promise);
    await press(h, ENTER);
    await waitFor(h, 'Reading folders...');
    h.t.key(CTRL_C);
    await expect(h.done).resolves.toMatchObject({ end: 'interrupt' });
    // The read fails once its session is closed; settle it so settled() does not wait for the cap.
    reading.reject(new MailboxError('connection-lost'));
    await h.app.settled();
    expect(logoutCount(h, 's1')).toBe(1);
    expect(count(h, 'folders.list')).toBe(0);
  });

  it('Ctrl+C on the bars and at a question: the session is logged out', async () => {
    const bars = await atBars();
    bars.t.key(CTRL_C);
    await expect(bars.done).resolves.toMatchObject({ end: 'interrupt' });
    await bars.app.settled();
    expect(logoutCount(bars, 's1')).toBe(1);

    const asked = await barsWithMarks();
    await press(asked, ESC);
    expect(last(asked)).toContain('(y/N)');
    asked.t.key(CTRL_C);
    await expect(asked.done).resolves.toMatchObject({ end: 'interrupt' });
    await asked.app.settled();
    expect(logoutCount(asked, 's1')).toBe(1);
  });

  it('Ctrl+C in the embedded browser: the session is logged out, exactly once', async () => {
    const h = await atMails();
    h.t.key(CTRL_C);
    await expect(h.done).resolves.toMatchObject({ end: 'interrupt' });
    await h.app.settled();
    expect(logoutCount(h, 's1')).toBe(1);
  });

  it('Ctrl+C at the browser question: the session is logged out', async () => {
    const h = await atMails();
    await press(h, charKey('a'), charKey('q'));
    expect(last(h)).toContain('(y/N)');
    h.t.key(CTRL_C);
    await expect(h.done).resolves.toMatchObject({ end: 'interrupt' });
    await h.app.settled();
    expect(logoutCount(h, 's1')).toBe(1);
  });

  it('Ctrl+C on Home (no mailbox open): nothing to log out', async () => {
    const h = await atHome();
    h.t.key(CTRL_C);
    await expect(h.done).resolves.toMatchObject({ end: 'interrupt' });
    await h.app.settled();
    expect(h.sessions).toHaveLength(0);
  });
});

/** Enter on the mailbox with a login that never answers (the caller uses fake timers). */
async function connectingNever(): Promise<{ h: Harness }> {
  const h = await atHome();
  h.openSession.mockImplementationOnce(() => new Promise<MailboxSession>(() => undefined));
  await press(h, ENTER);
  await waitFor(h, 'Connecting...');
  return { h };
}

// --- AC10: failures -------------------------------------------------------------------------

describe('AC10 a failed login or read', () => {
  it('a failed login: the error text in the body, wrapped, in ASCII; r try again', async () => {
    const h = await atHome();
    const err = new ImapSessionError('auth-failed');
    h.openSession.mockRejectedValueOnce(err);
    await press(h, ENTER);
    await waitFor(h, 'r try again');
    const body = collapsed(last(h));
    expect(body).toContain(collapsed(asciiText(accountErrorText(err, h.account))));
    for (const line of h.t.frames.at(-1)?.lines ?? []) expect(line).toMatch(/^[\x20-\x7E]*$/);
    expect(await stillRunning(h.done)).toBe(true);
    await end(h);
  });

  it('a failed login: folders.list is written once with outcome failed and the reason, no names', async () => {
    const h = await atHome();
    h.openSession.mockRejectedValueOnce(new ImapSessionError('auth-failed'));
    await press(h, ENTER);
    await waitFor(h, 'r try again');
    expect(events(h, 'folders.list')).toEqual([
      expect.objectContaining({ acct: ID, folders: 0, outcome: 'failed', reason: 'auth-failed' }),
    ]);
    await end(h);
  });

  it('r runs login + read again: a new attempt, then the bars; two folders.list lines (failed, ok)', async () => {
    const h = await atHome();
    h.openSession.mockRejectedValueOnce(new ImapSessionError('auth-failed'));
    await press(h, ENTER);
    await waitFor(h, 'r try again');
    await press(h, charKey('r'));
    await waitFor(h, 'Total:');
    expect(h.openSession).toHaveBeenCalledTimes(2);
    expect(h.listFolders).toHaveBeenCalledTimes(1);
    const lines = events(h, 'folders.list');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ outcome: 'failed', reason: 'auth-failed' });
    expect(lines[1]).toMatchObject({ outcome: 'ok', acct: ID, folders: TREE.folders.length });
    await end(h);
  });

  it('r is not an automatic retry: a failing login is tried once per key press', async () => {
    const h = await atHome();
    h.openSession.mockRejectedValue(new ImapSessionError('auth-failed'));
    await press(h, ENTER);
    await waitFor(h, 'r try again');
    await settle();
    await settle();
    expect(h.openSession).toHaveBeenCalledTimes(1);
    await press(h, charKey('r'));
    await waitFor(h, 'r try again');
    await settle();
    expect(h.openSession).toHaveBeenCalledTimes(2);
    await end(h);
  });

  it('a login blocked by the guard: its text (with the unblock time) in the body', async () => {
    const h = await atHome();
    const err = new LoginBlockedError('too-many-attempts', new Date(Date.UTC(2099, 0, 1, 12)));
    h.openSession.mockRejectedValueOnce(err);
    await press(h, ENTER);
    await waitFor(h, 'r try again');
    expect(collapsed(last(h))).toContain(collapsed(asciiText(accountErrorText(err, h.account))));
    expect(events(h, 'folders.list')).toEqual([
      expect.objectContaining({ outcome: 'failed', reason: 'blocked' }),
    ]);
    await end(h);
  });

  it('a failed read: the failed screen, the session logged out, folders.list failed with the reason', async () => {
    const h = await atHome();
    const err = new MailboxError('list-failed');
    h.listFolders.mockRejectedValueOnce(err);
    await press(h, ENTER);
    await waitFor(h, 'r try again');
    expect(collapsed(last(h))).toContain(collapsed(asciiText(accountErrorText(err, h.account))));
    expect(logoutCount(h, 's1')).toBe(1);
    expect(events(h, 'folders.list')).toEqual([
      expect.objectContaining({ outcome: 'failed', reason: 'list-failed' }),
    ]);
    await end(h);
    expect(logoutCount(h, 's1')).toBe(1);
  });

  it('a read that fails with connection-lost shows the failed screen and r reads again', async () => {
    const h = await atHome();
    h.listFolders.mockRejectedValueOnce(new MailboxError('connection-lost'));
    await press(h, ENTER);
    await waitFor(h, 'r try again');
    await press(h, charKey('r'));
    await waitFor(h, 'Total:');
    expect(h.openSession).toHaveBeenCalledTimes(2);
    expect(logoutCount(h, 's1')).toBe(1);
    await end(h);
  });

  it('Esc on the failed screen goes back to Home (nothing left to log out)', async () => {
    const h = await atHome();
    h.openSession.mockRejectedValueOnce(new ImapSessionError('timeout'));
    await press(h, ENTER);
    await waitFor(h, 'r try again');
    await press(h, ESC);
    expect(last(h)).toContain('Add a mailbox');
    expect(await stillRunning(h.done)).toBe(true);
    await end(h);
  });

  it('a login error that is not user-facing: run() rejects with it, onUnexpected is not called', async () => {
    const h = await atHome();
    const err = new Error('boom');
    h.openSession.mockRejectedValueOnce(err);
    h.t.key(ENTER);
    await expect(h.done).rejects.toBe(err);
    expect(h.onUnexpected).not.toHaveBeenCalled();
  });

  it('a read error that is not user-facing: run() rejects with it, onUnexpected is not called, the session is logged out', async () => {
    const h = await atHome();
    const err = new Error('boom');
    h.listFolders.mockRejectedValueOnce(err);
    h.t.key(ENTER);
    await expect(h.done).rejects.toBe(err);
    await h.app.settled();
    expect(h.onUnexpected).not.toHaveBeenCalled();
    expect(logoutCount(h, 's1')).toBe(1);
  });
});

// --- AC12: mails inside the app -------------------------------------------------------------

describe('AC12 the embedded browser', () => {
  it('Enter on a folder: the first page is loaded on the mailbox session and the mails are shown', async () => {
    const h = await atBars();
    await press(h, ENTER);
    await waitFor(h, 'Subject 3');
    expect(h.load).toHaveBeenCalledTimes(1);
    const [session, path, expected, page] = h.load.mock.calls[0] ?? [];
    expect(session).toBe(h.sessions[0]);
    expect([path, expected, page]).toEqual(['INBOX', null, 0]);
    expect(last(h)).toMatch(/Esc(\/Left)? back/);
    await end(h);
  });

  it('Space marks a mail; a marked mail shows [x] and the status shows the total', async () => {
    const h = await atMails();
    await press(h, charKey(' '));
    expect(last(h)).toContain('[x]');
    expect(last(h)).toContain('marked: 1 mail');
    await press(h, charKey('a'));
    expect(last(h)).toContain('marked: 3 mails');
    await end(h);
  });

  it.each([
    ['Esc', ESC],
    ['Left', LEFT],
    ['Backspace', k('backspace', { sequence: '\x7f' })],
  ])('%s at the entry folder returns to the bars (the session stays open)', async (_n, key) => {
    const h = await atMails();
    await press(h, key);
    expect(last(h)).toContain('Total:');
    expect(last(h)).toContain('Sent');
    expect(logoutCount(h, 's1')).toBe(0);
    expect(await stillRunning(h.done)).toBe(true);
    await end(h);
  });

  it('subfolders of the entry folder open and are left again before Esc returns to the bars', async () => {
    const h = await atBars();
    await press(h, DOWN, DOWN, ENTER);
    await vi.waitFor(() => {
      expect(last(h)).not.toContain('Total:');
    });
    expect(h.load.mock.calls[0]?.[1]).toBe('Projects');
    expect(last(h)).toContain('Alpha');
    await press(h, ENTER);
    await vi.waitFor(() => {
      expect(h.load.mock.calls.at(-1)?.[1]).toBe('Projects/Alpha');
    });
    await press(h, ESC);
    expect(last(h)).not.toContain('Total:');
    expect(last(h)).toContain('Alpha');
    await press(h, ESC);
    expect(last(h)).toContain('Total:');
    await end(h);
  });

  it('a folder that cannot be opened: back on the bars with "Couldn\'t open that folder."', async () => {
    const h = await atBars();
    h.load.mockRejectedValueOnce(new MailboxError('folder-unavailable'));
    await press(h, ENTER);
    await waitFor(h, "Couldn't open that folder.");
    expect(last(h)).toContain('Total:');
    expect(await stillRunning(h.done)).toBe(true);
    await end(h);
  });

  it('q in the browser quits the app and logs the session out', async () => {
    const h = await atMails();
    h.t.key(charKey('q'));
    await expect(h.done).resolves.toMatchObject({ end: 'quit' });
    await h.app.settled();
    expect(logoutCount(h, 's1')).toBe(1);
  });

  it('q with marks asks the browser question first; y quits', async () => {
    const h = await atMails();
    await press(h, charKey('a'), charKey('q'));
    expect(last(h)).toContain('(y/N)');
    expect(await stillRunning(h.done)).toBe(true);
    await press(h, charKey('n'));
    expect(await stillRunning(h.done)).toBe(true);
    await press(h, charKey('q'), charKey('y'));
    await expect(h.done).resolves.toMatchObject({ end: 'quit' });
    await h.app.settled();
    expect(logoutCount(h, 's1')).toBe(1);
  });

  it('a page load that fails with something that is not a MailboxError ends the app (crash path)', async () => {
    const h = await atBars();
    const err = new Error('boom');
    h.load.mockRejectedValueOnce(err);
    h.t.key(ENTER);
    await expect(h.done).rejects.toBe(err);
  });

  it('a resize while browsing redraws the browser at the new size', async () => {
    const h = await atMails();
    h.t.screen = { rows: 12, cols: 60 };
    h.t.resize();
    await settle();
    const frame = h.t.frames.at(-1);
    expect(frame?.lines).toHaveLength(12);
    for (const line of frame?.lines ?? []) expect(line).toHaveLength(60);
    expect(last(h)).toContain('Subject 3');
    await end(h);
  });
});

// --- AC13: the basket -----------------------------------------------------------------------

describe('AC13 marks belong to the mailbox visit', () => {
  it('marks survive Left to the bars and are marked when the folder is opened again', async () => {
    const h = await barsWithMarks();
    await press(h, ENTER);
    await waitFor(h, 'Subject 3');
    expect(last(h)).toContain('marked: 3 mails');
    expect(last(h)).toContain('[x]');
    expect(h.load).toHaveBeenCalledTimes(2);
    await end(h);
  });

  it('a mark made in the second visit of the folder adds to the first', async () => {
    const h = await atMails();
    await press(h, charKey(' '));
    await press(h, ESC);
    await press(h, ENTER);
    await waitFor(h, 'marked: 1 mail');
    await press(h, DOWN, charKey(' '));
    expect(last(h)).toContain('marked: 2 mails');
    await end(h);
  });

  it('marks are dropped when the mailbox is left (a new visit starts empty)', async () => {
    const h = await barsWithMarks();
    await press(h, ESC, charKey('y'));
    await press(h, ENTER);
    await waitFor(h, 'Total:');
    await press(h, ENTER);
    await waitFor(h, 'Subject 3');
    expect(last(h)).toContain('marked: 0 mails');
    await end(h);
  });
});

// --- AC14: stale page results ---------------------------------------------------------------

describe('AC14 a page of a browser that was left changes nothing', () => {
  it('the late answer of the first browser is dropped; the second browser shows its own page', async () => {
    const h = await atBars();
    const first = deferred<PageResult>();
    const second = deferred<PageResult>();
    h.load.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await press(h, ENTER);
    expect(h.load).toHaveBeenCalledTimes(1);
    await press(h, ESC);
    expect(last(h)).toContain('Total:');
    await press(h, ENTER);
    expect(h.load).toHaveBeenCalledTimes(2);
    first.resolve(pageFor('INBOX', 'Stale'));
    await settle();
    await settle();
    expect(last(h)).not.toContain('Stale');
    second.resolve(pageFor('INBOX', 'Fresh'));
    await waitFor(h, 'Fresh 3');
    expect(last(h)).not.toContain('Stale');
    await end(h);
  });

  it('a late answer after the bars were shown again does not open anything', async () => {
    const h = await atBars();
    const first = deferred<PageResult>();
    h.load.mockReturnValueOnce(first.promise);
    await press(h, ENTER);
    await press(h, ESC);
    first.resolve(pageFor('INBOX', 'Stale'));
    await settle();
    await settle();
    expect(last(h)).toContain('Total:');
    expect(last(h)).not.toContain('Stale');
    await end(h);
  });
});

// --- AC15: offline and reconnect ------------------------------------------------------------

describe('AC15 reconnect inside the embedded browser', () => {
  async function toReconnectAsk(h: Harness): Promise<void> {
    h.load.mockRejectedValueOnce(new MailboxError('connection-lost'));
    await press(h, ENTER);
    await waitFor(h, 'Connection closed - reconnect? (y/N)');
  }

  it('y: the old session is logged out first, one new login, the page is loaded on the new session', async () => {
    const h = await atBars();
    await toReconnectAsk(h);
    await press(h, charKey('y'));
    await waitFor(h, 'Subject 3');
    expect(h.order.indexOf('logout:s1')).toBeGreaterThanOrEqual(0);
    expect(h.order.indexOf('logout:s1')).toBeLessThan(h.order.indexOf('open:2'));
    expect(h.openSession).toHaveBeenCalledTimes(2);
    expect(h.openSession.mock.calls[1]?.[0]).toBe(h.account);
    expect(h.load.mock.calls.at(-1)?.[0]).toBe(h.sessions[1]);
    await end(h);
  });

  it('r at the question also reconnects', async () => {
    const h = await atBars();
    await toReconnectAsk(h);
    await press(h, charKey('r'));
    await waitFor(h, 'Subject 3');
    expect(h.openSession).toHaveBeenCalledTimes(2);
    await end(h);
  });

  it('the reconnected session replaces the mailbox session: it is the one logged out later', async () => {
    const h = await atBars();
    await toReconnectAsk(h);
    await press(h, charKey('y'));
    await waitFor(h, 'Subject 3');
    await press(h, ESC);
    await press(h, ESC);
    expect(last(h)).toContain('Add a mailbox');
    expect(logoutCount(h, 's1')).toBe(1);
    expect(logoutCount(h, 's2')).toBe(1);
    await end(h);
  });

  it('Ctrl+C after a reconnect logs out the new session once and the old one only once', async () => {
    const h = await atBars();
    await toReconnectAsk(h);
    await press(h, charKey('y'));
    await waitFor(h, 'Subject 3');
    h.t.key(CTRL_C);
    await h.done;
    await h.app.settled();
    expect(logoutCount(h, 's1')).toBe(1);
    expect(logoutCount(h, 's2')).toBe(1);
  });

  it('the challenge notice shows while the reconnect waits', async () => {
    const h = await atBars({ challengeDelayMs: 20 });
    await toReconnectAsk(h);
    h.openSession.mockImplementationOnce(async (_account, onChallenge) => {
      await onChallenge();
      return lateSession(h, 's2');
    });
    await press(h, charKey('y'));
    await waitFor(h, CHALLENGE_NOTICE);
    await waitFor(h, 'Subject 3');
    await end(h);
  });

  it('a failed reconnect: "Couldn\'t reconnect - showing what is loaded.", offline, the error kept', async () => {
    const err = new ImapSessionError('auth-failed');
    const h = await atBars();
    await toReconnectAsk(h);
    h.openSession.mockRejectedValueOnce(err);
    await press(h, charKey('y'));
    await waitFor(h, RECONNECT_FAILED_TEXT);
    await settle();
    expect(h.openSession).toHaveBeenCalledTimes(2);
    expect(h.onUnexpected).not.toHaveBeenCalled();
    expect(await stillRunning(h.done)).toBe(true);
    h.t.key(CTRL_C);
    const result = await h.done;
    await h.app.settled();
    expect(result.reconnectError).toBe(err);
  });

  it('a later successful reconnect clears the kept error', async () => {
    const h = await atBars();
    await toReconnectAsk(h);
    h.openSession.mockRejectedValueOnce(new ImapSessionError('auth-failed'));
    await press(h, charKey('y'));
    await waitFor(h, RECONNECT_FAILED_TEXT);
    await press(h, charKey('r'));
    await waitFor(h, 'Subject 3');
    expect(last(h)).not.toContain(RECONNECT_FAILED_TEXT);
    h.t.key(CTRL_C);
    const result = await h.done;
    await h.app.settled();
    expect(result.reconnectError).toBeUndefined();
  });

  it('Ctrl+C during the challenge wait of a reconnect ends at once and does not wait for the delay', async () => {
    const h = await atBars({ challengeDelayMs: 60_000 });
    await toReconnectAsk(h);
    h.openSession.mockImplementationOnce(async (_account, onChallenge) => {
      await onChallenge();
      return lateSession(h, 's2');
    });
    await press(h, charKey('y'));
    await waitFor(h, CHALLENGE_NOTICE);
    h.t.key(CTRL_C);
    await expect(h.done).resolves.toMatchObject({ end: 'interrupt' });
    expect(await within(h.app.settled(), 1500)).toBe(true);
    expect(logoutCount(h, 'late')).toBe(0);
  });

  it('a reconnect error that is not user-facing is reported through onUnexpected', async () => {
    const err = new Error('boom');
    const h = await atBars();
    await toReconnectAsk(h);
    h.openSession.mockRejectedValueOnce(err);
    await press(h, charKey('y'));
    await waitFor(h, RECONNECT_FAILED_TEXT);
    expect(h.onUnexpected).toHaveBeenCalledWith(err);
    await end(h);
  });
});

// --- AC17: the log --------------------------------------------------------------------------

describe('AC17 folders.list, imap.capability-fallback, browse.finish', () => {
  it('folders.list once per mailbox open: acct, folders, ms, outcome ok, no reason', async () => {
    const h = await atBars();
    const lines = events(h, 'folders.list');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ acct: ID, folders: TREE.folders.length, outcome: 'ok' });
    expect(lines[0]?.['reason']).toBeUndefined();
    expect(typeof lines[0]?.['ms']).toBe('number');
    await end(h);
    expect(count(h, 'folders.list')).toBe(1);
  });

  it('a second visit writes a second folders.list', async () => {
    const h = await atBars();
    await press(h, ESC);
    await press(h, ENTER);
    await waitFor(h, 'Total:');
    expect(count(h, 'folders.list')).toBe(2);
    await end(h);
  });

  it('imap.capability-fallback: one line per fallback feature, once per app run across visits', async () => {
    const tree = treeOf(TREE.folders, { fallbacks: new Set(['status-size', 'quota'] as const) });
    const h = await atBars({ tree });
    expect(events(h, 'imap.capability-fallback')).toHaveLength(2);
    const features = events(h, 'imap.capability-fallback').map((r) => r['feature']);
    expect(features).toContain('status-size');
    expect(features).toContain('quota');
    await press(h, ESC);
    await press(h, ENTER);
    await waitFor(h, 'Total:');
    expect(count(h, 'folders.list')).toBe(2);
    expect(events(h, 'imap.capability-fallback')).toHaveLength(2);
    await end(h);
  });

  it('a tree without fallbacks writes no imap.capability-fallback', async () => {
    const h = await atBars();
    expect(count(h, 'imap.capability-fallback')).toBe(0);
    await end(h);
  });

  it('no browse.finish for a visit in which no folder was opened', async () => {
    const h = await atBars();
    await press(h, ESC);
    h.t.key(CTRL_C);
    await h.done;
    await h.app.settled();
    expect(count(h, 'browse.finish')).toBe(0);
  });

  it('browse.finish once when the mailbox is left after a folder was opened', async () => {
    const h = await atMails();
    await press(h, charKey('a'));
    await press(h, ESC);
    await press(h, ESC, charKey('y'));
    expect(last(h)).toContain('Add a mailbox');
    const lines = events(h, 'browse.finish');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      acct: ID,
      folders: 1,
      mails: 3,
      marked: 3,
      bytes: 6,
      reconnects: 0,
      outcome: 'ok',
    });
    expect(typeof lines[0]?.['ms']).toBe('number');
    expect(lines[0]?.['reason']).toBeUndefined();
    await end(h);
    expect(count(h, 'browse.finish')).toBe(1);
  });

  it('browse.finish when quitting from the browser: ok, once', async () => {
    const h = await atMails();
    h.t.key(charKey('q'));
    await h.done;
    await h.app.settled();
    expect(events(h, 'browse.finish')).toEqual([
      expect.objectContaining({ acct: ID, folders: 1, mails: 3, marked: 0, outcome: 'ok' }),
    ]);
  });

  it('browse.finish on Ctrl+C: interrupted, once', async () => {
    const h = await atMails();
    h.t.key(CTRL_C);
    await h.done;
    await h.app.settled();
    const lines = events(h, 'browse.finish');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ outcome: 'interrupted', folders: 1, mails: 3 });
  });

  it('one browse.finish per visit: two visits that opened a folder write two', async () => {
    const h = await atMails();
    await press(h, ESC);
    await press(h, ESC);
    expect(last(h)).toContain('Add a mailbox');
    await press(h, ENTER);
    await waitFor(h, 'Total:');
    await press(h, ENTER);
    await waitFor(h, 'Subject 3');
    h.t.key(charKey('q'));
    await h.done;
    await h.app.settled();
    expect(count(h, 'browse.finish')).toBe(2);
  });

  it('the reconnects of the visit are counted in browse.finish', async () => {
    const h = await atBars();
    h.load.mockRejectedValueOnce(new MailboxError('connection-lost'));
    await press(h, ENTER);
    await waitFor(h, 'Connection closed - reconnect? (y/N)');
    await press(h, charKey('y'));
    await waitFor(h, 'Subject 3');
    h.t.key(charKey('q'));
    await h.done;
    await h.app.settled();
    expect(events(h, 'browse.finish')).toEqual([expect.objectContaining({ reconnects: 1 })]);
  });

  it('a folder that could not be opened still counts as opened', async () => {
    const h = await atBars();
    h.load.mockRejectedValueOnce(new MailboxError('folder-unavailable'));
    await press(h, ENTER);
    await waitFor(h, "Couldn't open that folder.");
    h.t.key(charKey('q'));
    await h.done;
    await h.app.settled();
    expect(count(h, 'browse.finish')).toBe(1);
  });

  it('a visit left while connecting or reading writes neither folders.list nor browse.finish', async () => {
    const { h, login } = await connecting();
    await press(h, ESC);
    login.resolve(lateSession(h));
    await settle();
    await settle();
    expect(count(h, 'folders.list')).toBe(0);
    expect(count(h, 'browse.finish')).toBe(0);
    await end(h);
  });
});

describe('AC17 the exit hook (App.onExit)', () => {
  it.each([
    [130, 'interrupted'],
    [129, 'interrupted'],
    [143, 'interrupted'],
  ])(
    'exit code %i writes browse.finish "%s" for a visit with a folder opened',
    async (code, outcome) => {
      const h = await atMails();
      h.app.onExit(code);
      expect(events(h, 'browse.finish')).toEqual([
        expect.objectContaining({ acct: ID, folders: 1, mails: 3, outcome }),
      ]);
      await end(h);
    },
  );

  it('any other code writes outcome failed with a reason', async () => {
    const h = await atMails();
    h.app.onExit(1);
    const lines = events(h, 'browse.finish');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ outcome: 'failed', reason: 'unexpected' });
    await end(h);
  });

  it('never twice for one visit', async () => {
    const h = await atMails();
    h.app.onExit(130);
    h.app.onExit(130);
    h.app.onExit(1);
    expect(count(h, 'browse.finish')).toBe(1);
    await end(h);
    expect(count(h, 'browse.finish')).toBe(1);
  });

  it('does not log a session out (it is synchronous)', async () => {
    const h = await atMails();
    h.app.onExit(130);
    expect(logoutCount(h, 's1')).toBe(0);
    await end(h);
  });

  it('none for a visit in which no folder was opened', async () => {
    const h = await atBars();
    h.app.onExit(130);
    expect(count(h, 'browse.finish')).toBe(0);
    await end(h);
  });

  it('none when the visit was already finished by Ctrl+C or by leaving the mailbox', async () => {
    const a = await atMails();
    a.t.key(CTRL_C);
    await a.done;
    await a.app.settled();
    a.app.onExit(130);
    expect(count(a, 'browse.finish')).toBe(1);

    const b = await atMails();
    await press(b, ESC);
    await press(b, ESC);
    expect(count(b, 'browse.finish')).toBe(1);
    b.app.onExit(130);
    expect(count(b, 'browse.finish')).toBe(1);
    await end(b);
  });

  it('none on Home, before any mailbox was opened', async () => {
    const h = await atHome();
    h.app.onExit(130);
    expect(count(h, 'browse.finish')).toBe(0);
    await end(h);
  });
});

// --- AC18: nothing private in the log -------------------------------------------------------

describe('AC18 the log carries no names, addresses, host, username or password', () => {
  const NAME = 'CanaryFolder-48151\u202E';
  const SUBJECT = 'CanarySubject-62342';
  const SENDER = 'canary.sender@example-test-domain.eu';
  const HOST = 'imap.canary-host.example-test-domain.eu';
  const USER = 'canary-user-name-77';
  const PASSWORD = 'CanaryPassword-99123';
  const NEEDLES = [
    'CanaryFolder',
    NAME,
    SUBJECT,
    'CanarySubject',
    SENDER,
    'canary.sender',
    HOST,
    'canary-host',
    USER,
    'canary-user-name',
    PASSWORD,
    'CanaryPassword',
    'example-test-domain',
  ];
  const ALLOWED = new Set([
    'folders.list',
    'imap.capability-fallback',
    'browse.finish',
    'error.unexpected',
  ]);

  it('across a failed login, a retry, a hostile folder, marks, a reconnect and Ctrl+C', async () => {
    const canary = account({
      host: HOST,
      username: USER,
      secret: { password: PASSWORD } as unknown as MailAccount['secret'],
    });
    const tree = treeOf([folder(NAME, { bytes: 5000 }), folder('Plain')], {
      fallbacks: new Set(['status-size'] as const),
    });
    const h = await atHome({ account: canary, tree });
    h.load.mockImplementation((_session, path) =>
      Promise.resolve({
        kind: 'page',
        snapshot: { path, uidValidity: '7', exists: 2 },
        page: 0,
        rows: [mailRow(2, SUBJECT, SENDER), mailRow(1, SUBJECT, SENDER)],
      }),
    );
    h.openSession.mockRejectedValueOnce(new ImapSessionError('auth-failed'));
    await press(h, ENTER);
    await waitFor(h, 'r try again');
    await press(h, charKey('r'));
    await waitFor(h, 'Total:');
    await press(h, ENTER);
    await waitFor(h, 'CanarySubject');
    await press(h, charKey('a'));
    await waitFor(h, 'marked: 2 mails');
    await press(h, ESC);
    await waitFor(h, 'Total:');
    // The connection drops when the next folder is opened; reconnect.
    h.load.mockRejectedValueOnce(new MailboxError('connection-lost'));
    await press(h, DOWN, ENTER);
    await waitFor(h, 'reconnect? (y/N)');
    await press(h, charKey('y'));
    await waitFor(h, 'CanarySubject');
    h.t.key(CTRL_C);
    await h.done;
    await h.app.settled();

    expect(count(h, 'folders.list')).toBe(2);
    expect(count(h, 'browse.finish')).toBe(1);
    const all = JSON.stringify(h.log.records) + h.log.lines.join('\n');
    for (const needle of NEEDLES) expect(all, needle).not.toContain(needle);
    for (const record of h.log.records) {
      const name = String(record.event);
      const known = ALLOWED.has(name) || /^(imap|auth|command)\./.test(name);
      expect(known, name).toBe(true);
    }
  });

  it('a failed login with a canary host and username shows no private data in any log line', async () => {
    const canary = account({ host: HOST, username: USER });
    const h = await atHome({ account: canary });
    h.openSession.mockRejectedValueOnce(new ImapSessionError('auth-failed'));
    await press(h, ENTER);
    await waitFor(h, 'r try again');
    await end(h);
    const all = JSON.stringify(h.log.records) + h.log.lines.join('\n');
    for (const needle of [HOST, USER, 'canary-host', 'canary-user-name', MAIL]) {
      expect(all, needle).not.toContain(needle);
    }
    expect(h.log.records.map((r) => r.event)).toEqual(['folders.list']);
  });
});
