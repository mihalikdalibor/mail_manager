import { afterEach, describe, it, expect, vi } from 'vitest';
import { accountErrorText } from '../../src/cli/account-text.js';
import { createApp } from '../../src/cli/app/controller.js';
import type { App, AppDeps, AppResult, MailboxSession } from '../../src/cli/app/controller.js';
import { asciiText } from '../../src/cli/app/state.js';
import { CHALLENGE_NOTICE, RECONNECT_FAILED_TEXT } from '../../src/cli/browser/controller.js';
import type { Rendered } from '../../src/cli/browser/render.js';
import type { Keypress, Screen } from '../../src/cli/browser/state.js';
import type { Terminal } from '../../src/cli/browser/terminal.js';
import { AccountError } from '../../src/core/accounts.js';
import type { AuthUser, LogoutResult } from '../../src/core/auth.js';
import { CredentialError } from '../../src/core/credentials.js';
import type { MailAccount } from '../../src/core/db/repos.js';
import { ImapSessionError } from '../../src/core/imap/errors.js';
import { MemoryEventLog } from '../../src/core/log/index.js';
import type { LogRecord } from '../../src/core/log/index.js';
import { MailboxError } from '../../src/core/mailbox/errors.js';
import type { FolderInfo, FolderTree, SizeProgress } from '../../src/core/mailbox/folders.js';
import type { MessageRow, PageResult, loadPage } from '../../src/core/mailbox/messages.js';
import { MemoryRememberedUsers } from '../../src/core/remembered-users.js';
import { LoginBlockedError } from '../../src/core/security/login-guard.js';

// M2d-2 app controller, the mailbox: one login per open, the folders, the pages and the
// reconnect of the embedded browser, and the session logged out on every way out - with a fake
// Terminal, fake sessions (each with its own logout spy), fake findAccount / openSession /
// listFolders / load and a MemoryEventLog. No Supabase, no IMAP, no real terminal. Addresses
// and hosts are placeholders; hostile characters are written as escapes.

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
const T0 = Date.UTC(2026, 9, 6, 9, 0, 0);
const HOME_ROW = '+ Add a mailbox';

const k = (name: string, extra: Keypress = {}): Keypress => ({ name, sequence: name, ...extra });
const ENTER = k('return', { sequence: '\r' });
const DOWN = k('down', { sequence: '\u001b[B' });
const LEFT = k('left', { sequence: '\u001b[D' });
const BACKSPACE = k('backspace', { sequence: '\u007f' });
const ESC = k('escape', { meta: true, sequence: '\u001b' });
const CTRL_C = k('c', { ctrl: true, sequence: '\u0003' });
const ch = (text: string): Keypress =>
  text === ' ' ? { name: 'space', sequence: ' ' } : { name: text.toLowerCase(), sequence: text };

function account(id: string, email: string, over: Partial<MailAccount> = {}): MailAccount {
  return {
    id,
    userId: ANNA.userId,
    label: null,
    email,
    provider: 'websupport',
    host: 'imap.example-test-domain.eu',
    port: 993,
    username: email,
    authType: 'password',
    secret: { ciphertext: 'c', iv: 'i', tag: 't', keyVersion: 1 },
    capabilities: null,
    createdAt: new Date(T0),
    updatedAt: new Date(T0),
    lastCheckedAt: null,
    ...over,
  };
}

const BOX = account(BOX_ID, BOX_EMAIL);
const BOX_2 = account(BOX_2_ID, BOX_2_EMAIL);

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
    unseen: 0,
    bytes: 1000,
    sizeSource: 'server',
    overlapping: false,
    ...over,
  };
}

function treeOf(folders: FolderInfo[], over: Partial<FolderTree> = {}): FolderTree {
  return {
    folders,
    totals: { messages: 12, unseen: 0, bytes: 4000, sizeSource: 'server' },
    quota: null,
    truncated: false,
    unreadable: 0,
    gmailAllHidden: false,
    fallbacks: new Set(),
    ...over,
  };
}

// The bars, in order: INBOX, Projects (with Alpha below it), Sent.
const TREE = treeOf([
  folder('INBOX', { role: 'inbox', roleSource: 'path' }),
  folder('Projects'),
  folder('Projects/Alpha'),
  folder('Sent'),
]);

function mail(seq: number, subject = `Subject ${String(seq)}`, from = 'Sender'): MessageRow {
  return {
    seq,
    uid: 1000 + seq,
    received: new Date(Date.UTC(2026, 0, 2, 12)),
    from,
    subject,
    bytes: 100,
    attachment: false,
  };
}

/** Three mails of 100 bytes in every folder. */
function pageOf(path: string, subject?: string): PageResult {
  const rows = [3, 2, 1].map((seq) => mail(seq, subject && `${subject} ${String(seq)}`));
  return { kind: 'page', snapshot: { path, uidValidity: '7', exists: 3 }, page: 0, rows };
}

// --- fakes ----------------------------------------------------------------------------------

interface FakeTerminal extends Terminal {
  readonly frames: Rendered[];
  screen: Screen;
  failDraw: Error | null;
  key(key: Keypress): void;
  resize(): void;
}

function fakeTerminal(): FakeTerminal {
  let keyHandler: ((key: Keypress) => void) | null = null;
  let resizeHandler: (() => void) | null = null;
  const t: FakeTerminal = {
    frames: [],
    screen: SCREEN,
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

interface Harness {
  t: FakeTerminal;
  app: App;
  done: Promise<AppResult>;
  log: MemoryEventLog;
  /** In order: `find`, `open:<name>`, `list:<name>`, `load:<name>:<path>`, `logout:<name>`. */
  calls: string[];
  /** Every session a login gave, in order: s1, s2, ... */
  sessions: FakeSession[];
  /** A session of its own name, counted like the others. */
  session(name: string): FakeSession;
  findAccount: ReturnType<typeof vi.fn<AppDeps['findAccount']>>;
  openSession: ReturnType<typeof vi.fn<AppDeps['openSession']>>;
  listFolders: ReturnType<typeof vi.fn<ListFolders>>;
  load: ReturnType<typeof vi.fn<typeof loadPage>>;
  listMailboxes: ReturnType<typeof vi.fn<AppDeps['listMailboxes']>>;
  onUnexpected: ReturnType<typeof vi.fn<(err: unknown) => void>>;
}

interface Options {
  tree?: FolderTree;
  mailboxes?: MailAccount[];
  challengeDelayMs?: number;
  /** Leaves `listFolders` out of the deps: the core's is used. */
  coreListFolders?: boolean;
}

function makeHarness(o: Options = {}): Harness {
  const t = fakeTerminal();
  const calls: string[] = [];
  const sessions: FakeSession[] = [];
  const mailboxes = o.mailboxes ?? [BOX, BOX_2];
  const session = (name: string): FakeSession => {
    const made = {
      name,
      client: {},
      features: {},
      closed: false,
      logout: vi.fn<() => Promise<void>>(() => {
        calls.push(`logout:${name}`);
        return Promise.resolve();
      }),
    } as unknown as FakeSession;
    return made;
  };
  const nameOf = (s: unknown): string => (s as FakeSession).name;
  const log = new MemoryEventLog({
    run: '0123456789abcdef',
    ver: '0.9.0',
    now: () => T0,
    level: 'debug',
  });
  const findAccount = vi.fn<AppDeps['findAccount']>((id) => {
    calls.push('find');
    const found = mailboxes.find((m) => m.id === id);
    return found === undefined
      ? Promise.reject(new AccountError('not-found'))
      : Promise.resolve(found);
  });
  const openSession = vi.fn<AppDeps['openSession']>(() => {
    const made = session(`s${String(sessions.length + 1)}`);
    sessions.push(made);
    calls.push(`open:${made.name}`);
    return Promise.resolve(made);
  });
  const listFolders = vi.fn<ListFolders>((s) => {
    calls.push(`list:${nameOf(s)}`);
    return Promise.resolve(o.tree ?? TREE);
  });
  const load = vi.fn<typeof loadPage>((s, path) => {
    calls.push(`load:${nameOf(s)}:${path}`);
    return Promise.resolve(pageOf(path));
  });
  const listMailboxes = vi.fn<AppDeps['listMailboxes']>(() => Promise.resolve(mailboxes));
  const onUnexpected = vi.fn<(err: unknown) => void>();
  const app = createApp({
    terminal: t,
    version: '0.9.0',
    auth: {
      currentUser: () => Promise.resolve(ANNA),
      login: () => Promise.resolve(ANNA),
      logout: (): Promise<LogoutResult> => Promise.resolve('logged-out'),
    },
    listMailboxes,
    remembered: new MemoryRememberedUsers([ANNA.email]),
    log,
    loginTarget: () => 'ab'.repeat(32),
    onUnexpected,
    findAccount,
    openSession,
    ...(o.coreListFolders !== true && { listFolders }),
    load,
    readLogs: NO_LOGS,
    ...NO_ADD,
    autoStats: false,
    ...(o.challengeDelayMs !== undefined && { challengeDelayMs: o.challengeDelayMs }),
  });
  return {
    t,
    app,
    done: app.run(),
    log,
    calls,
    sessions,
    session,
    findAccount,
    openSession,
    listFolders,
    load,
    listMailboxes,
    onUnexpected,
  };
}

function text(frame: Rendered | undefined): string {
  return (frame?.lines ?? []).join('\n');
}

const last = (h: Harness): string => text(h.t.frames.at(-1));
const flat = (value: string): string => value.replace(/\s+/g, ' ');

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

const names = (h: Harness): string[] => h.log.records.map((r) => r.event);
const logouts = (h: Harness, name: string): number =>
  h.calls.filter((c) => c === `logout:${name}`).length;

/** Ctrl+C (unless it has ended), then everything that was still under way. */
async function quit(h: Harness): Promise<void> {
  h.t.key(CTRL_C);
  await h.done.catch(() => undefined);
  await h.app.settled();
}

/** ANNA on Home with her mailboxes listed, the cursor on the first. */
async function atHome(o: Options = {}): Promise<Harness> {
  const h = makeHarness(o);
  await shown(h, 'Sign in as another user');
  await press(h, ENTER);
  await shown(h, HOME_ROW);
  return h;
}

/** Enter on the first mailbox: its bars. */
async function atBars(o: Options = {}): Promise<Harness> {
  const h = await atHome(o);
  await press(h, ENTER);
  await shown(h, 'Total:');
  return h;
}

/** Enter on INBOX: its three mails. */
async function atMails(o: Options = {}): Promise<Harness> {
  const h = await atBars(o);
  await press(h, ENTER);
  await shown(h, 'Subject 3');
  return h;
}

/** The bars again, the three mails of INBOX marked. */
async function barsWithMarks(o: Options = {}): Promise<Harness> {
  const h = await atMails(o);
  await press(h, ch('a'));
  await shown(h, 'marked: 3 mails');
  await press(h, ESC);
  await shown(h, 'Total:');
  return h;
}

/** Enter on the first mailbox with a login the test answers itself. */
async function connecting(
  o: Options = {},
): Promise<{ h: Harness; login: Deferred<MailboxSession> }> {
  const h = await atHome(o);
  const login = deferred<MailboxSession>();
  h.openSession.mockImplementationOnce(() => {
    h.calls.push('open:pending');
    return login.promise;
  });
  await press(h, ENTER);
  await shown(h, 'Connecting...');
  await vi.waitFor(() => {
    expect(h.openSession).toHaveBeenCalledTimes(1);
  });
  return { h, login };
}

/** Enter on the first mailbox with a folder read the test answers itself. */
async function reading(): Promise<{ h: Harness; read: Deferred<FolderTree> }> {
  const h = await atHome();
  const read = deferred<FolderTree>();
  h.listFolders.mockImplementationOnce((s) => {
    h.calls.push(`list:${(s as FakeSession).name}`);
    return read.promise;
  });
  await press(h, ENTER);
  await shown(h, 'Reading folders...');
  return { h, read };
}

/** In INBOX with the connection gone: "reconnect? (y/N)". */
async function lost(o: Options = {}): Promise<Harness> {
  const h = await atBars(o);
  h.load.mockRejectedValueOnce(new MailboxError('connection-lost'));
  await press(h, ENTER);
  await shown(h, 'Connection closed - reconnect? (y/N)');
  return h;
}

afterEach(() => {
  vi.useRealTimers();
});

// --- opening --------------------------------------------------------------------------------

describe('opening a mailbox', () => {
  it('Enter: the mailbox is looked up by its id, one login, its folders - and the bars', async () => {
    const h = await atBars();
    expect(h.findAccount.mock.calls).toEqual([[BOX_ID]]);
    expect(h.openSession).toHaveBeenCalledTimes(1);
    expect(h.openSession.mock.calls[0]?.[0]).toBe(BOX);
    expect(h.listFolders.mock.calls[0]?.[0]).toBe(h.sessions[0]);
    expect(h.calls).toEqual(['find', 'open:s1', 'list:s1']);
    expect(last(h)).toContain(`Mail Manager - ${BOX_EMAIL}`);
    expect(last(h)).toContain('Total: 12 messages, 0 unread, 3.9 KB');
    for (const name of ['INBOX', 'Projects', 'Alpha', 'Sent']) expect(last(h)).toContain(name);
    expect(logouts(h, 's1')).toBe(0);
    await quit(h);
  });

  it('the second mailbox row opens the second mailbox', async () => {
    const h = await atHome();
    await press(h, DOWN, ENTER);
    await shown(h, 'Total:');
    expect(h.findAccount.mock.calls).toEqual([[BOX_2_ID]]);
    expect(h.openSession.mock.calls[0]?.[0]).toBe(BOX_2);
    expect(last(h)).toContain(`Mail Manager - ${BOX_2_EMAIL}`);
    await quit(h);
  });

  it('"Connecting..." while the login runs, "Reading folders..." after it, n/m while sizes are added up', async () => {
    const { h, login } = await connecting();
    expect(h.listFolders).not.toHaveBeenCalled();
    const read = deferred<FolderTree>();
    let report: ((progress: SizeProgress) => void) | undefined;
    h.listFolders.mockImplementationOnce((_s, onProgress) => {
      report = onProgress;
      return read.promise;
    });
    login.resolve(h.session('s1'));
    await shown(h, 'Reading folders...');
    expect(last(h)).not.toContain('Connecting...');
    report?.({ folder: 2, folders: 7, done: 50, total: 900 });
    await shown(h, 'Reading folders... 2/7');
    report?.({ folder: 6, folders: 7, done: 1, total: 2 });
    await shown(h, 'Reading folders... 6/7');
    read.resolve(TREE);
    await shown(h, 'Total:');
    await quit(h);
  });

  it('progress that still arrives after the folders are there changes nothing', async () => {
    const h = await atHome();
    let report: ((progress: SizeProgress) => void) | undefined;
    h.listFolders.mockImplementationOnce((_s, onProgress) => {
      report = onProgress;
      return Promise.resolve(TREE);
    });
    await press(h, ENTER);
    await shown(h, 'Total:');
    const frames = h.t.frames.length;
    report?.({ folder: 1, folders: 2, done: 1, total: 2 });
    await settle();
    expect(last(h)).toContain('Total:');
    expect(last(h)).not.toContain('Reading folders');
    expect(h.t.frames.length).toBeLessThanOrEqual(frames + 1);
    await quit(h);
  });

  it('without a listFolders dep the core reads the folders, sizes on', async () => {
    const h = await atHome({ coreListFolders: true });
    const list = vi.fn(() =>
      Promise.resolve([{ path: 'INBOX', name: 'INBOX', delimiter: '/', flags: new Set<string>() }]),
    );
    const status = vi.fn(() => Promise.resolve({ messages: 2, unseen: 1, size: 2048 }));
    h.openSession.mockImplementationOnce(() => {
      const made = h.session('s1');
      Object.assign(made, {
        client: { list, status },
        features: { listStatus: false, quota: false, statusSize: true, gmail: false },
      });
      return Promise.resolve(made);
    });
    await press(h, ENTER);
    await shown(h, 'Total: 2 messages, 1 unread, 2.0 KB');
    expect(list).toHaveBeenCalledTimes(1);
    // Sizes are asked for: the bars are made of them.
    expect(status.mock.calls).toEqual([['INBOX', { messages: true, unseen: true, size: true }]]);
    expect(names(h)).toEqual([
      'imap.capability-fallback',
      'imap.capability-fallback',
      'folders.list',
    ]);
    expect(events(h, 'folders.list')).toEqual([
      expect.objectContaining({ acct: BOX_ID, folders: 1, outcome: 'ok' }),
    ]);
    await quit(h);
  });

  it('the login guard waits first: its notice, then the login goes on', async () => {
    const h = await atHome({ challengeDelayMs: 15 });
    h.openSession.mockImplementationOnce(async (_account, onChallenge) => {
      await onChallenge();
      return h.session('s1');
    });
    await press(h, ENTER);
    await shown(h, CHALLENGE_NOTICE);
    expect(last(h)).not.toContain('Connecting...');
    await shown(h, 'Total:');
    expect(last(h)).not.toContain(CHALLENGE_NOTICE);
    await quit(h);
    expect(logouts(h, 's1')).toBe(1);
  });
});

// --- failing --------------------------------------------------------------------------------

describe('a login or read that fails', () => {
  it('a failed login: its text in the body in ASCII, and r - which logs in once more', async () => {
    const h = await atHome();
    const err = new ImapSessionError('auth-failed');
    h.openSession.mockRejectedValueOnce(err);
    await press(h, ENTER);
    await shown(h, 'r try again');
    expect(flat(last(h))).toContain(flat(asciiText(accountErrorText(err, BOX))));
    for (const line of h.t.frames.at(-1)?.lines ?? []) expect(line).toMatch(/^[\x20-\x7e]*$/);
    expect(h.listFolders).not.toHaveBeenCalled();
    // Nothing happens by itself: no second login until the key.
    await settle();
    await settle();
    expect(h.openSession).toHaveBeenCalledTimes(1);

    await press(h, ch('r'));
    await shown(h, 'Total:');
    expect(h.openSession).toHaveBeenCalledTimes(2);
    expect(h.findAccount).toHaveBeenCalledTimes(2);
    expect(events(h, 'folders.list')).toEqual([
      expect.objectContaining({
        acct: BOX_ID,
        folders: 0,
        outcome: 'failed',
        reason: 'auth-failed',
      }),
      expect.objectContaining({ acct: BOX_ID, folders: 4, outcome: 'ok' }),
    ]);
    expect(events(h, 'folders.list')[1]).not.toHaveProperty('reason');
    await quit(h);
    expect(logouts(h, 's1')).toBe(1);
  });

  it('a login blocked by the guard: the text with the time, and r fails the same way', async () => {
    const h = await atHome();
    const err = new LoginBlockedError('too-many-attempts', new Date(Date.UTC(2099, 0, 1, 12)));
    h.openSession.mockRejectedValue(err);
    await press(h, ENTER);
    await shown(h, 'r try again');
    expect(flat(last(h))).toContain(flat(asciiText(accountErrorText(err, BOX))));
    await press(h, ch('r'));
    await shown(h, 'r try again');
    expect(h.openSession).toHaveBeenCalledTimes(2);
    expect(events(h, 'folders.list').map((r) => r['reason'])).toEqual(['blocked', 'blocked']);
    await quit(h);
  });

  it('a mailbox that is gone meanwhile: the failed screen, no login', async () => {
    const h = await atHome();
    const err = new AccountError('not-found');
    h.findAccount.mockRejectedValueOnce(err);
    await press(h, ENTER);
    await shown(h, 'r try again');
    expect(flat(last(h))).toContain(flat(asciiText(accountErrorText(err))));
    expect(h.openSession).not.toHaveBeenCalled();
    expect(events(h, 'folders.list')).toEqual([
      expect.objectContaining({ acct: BOX_ID, outcome: 'failed', reason: 'not-found' }),
    ]);
    await quit(h);
  });

  it('no master key (the login dep throws at once): the failed screen with what to do', async () => {
    const h = await atHome();
    const err = new CredentialError('MM_MASTER_KEY is not set \u2014 run `mm keygen`');
    h.openSession.mockImplementationOnce(() => {
      throw err;
    });
    await press(h, ENTER);
    await shown(h, 'r try again');
    expect(last(h)).toContain('MM_MASTER_KEY is not set - run `mm keygen`');
    expect(events(h, 'folders.list')).toEqual([
      expect.objectContaining({ outcome: 'failed', reason: 'secret-unreadable' }),
    ]);
    expect(await stillRunning(h.done)).toBe(true);
    await quit(h);
  });

  it('a failed read: the failed screen, its session logged out once - also after Esc and quit', async () => {
    const h = await atHome();
    const err = new MailboxError('list-failed');
    h.listFolders.mockRejectedValueOnce(err);
    await press(h, ENTER);
    await shown(h, 'r try again');
    expect(flat(last(h))).toContain(flat(asciiText(accountErrorText(err, BOX))));
    expect(logouts(h, 's1')).toBe(1);
    expect(events(h, 'folders.list')).toEqual([
      expect.objectContaining({ outcome: 'failed', reason: 'list-failed' }),
    ]);
    await press(h, ESC);
    expect(last(h)).toContain(HOME_ROW);
    await quit(h);
    expect(logouts(h, 's1')).toBe(1);
  });

  it('a read that throws at once is a failed read too', async () => {
    const h = await atHome();
    h.listFolders.mockImplementationOnce(() => {
      throw new MailboxError('connection-lost');
    });
    await press(h, ENTER);
    await shown(h, 'r try again');
    expect(logouts(h, 's1')).toBe(1);
    await press(h, ch('r'));
    await shown(h, 'Total:');
    expect(h.calls.filter((c) => c.startsWith('open:'))).toEqual(['open:s1', 'open:s2']);
    await quit(h);
    expect(logouts(h, 's2')).toBe(1);
  });

  it('a login error that is not ours ends the app with it', async () => {
    const h = await atHome();
    const err = new TypeError('boom');
    h.openSession.mockRejectedValueOnce(err);
    h.t.key(ENTER);
    await expect(h.done).rejects.toBe(err);
    await h.app.settled();
    // Whoever called run() reports it: reporting it here too would log it twice.
    expect(h.onUnexpected).not.toHaveBeenCalled();
    expect(events(h, 'folders.list')).toEqual([
      expect.objectContaining({ outcome: 'failed', reason: 'unexpected' }),
    ]);
  });

  it('a read error that is not ours ends the app too; the session is logged out once', async () => {
    const h = await atHome();
    const err = new TypeError('boom');
    h.listFolders.mockRejectedValueOnce(err);
    h.t.key(ENTER);
    await expect(h.done).rejects.toBe(err);
    await h.app.settled();
    expect(h.onUnexpected).not.toHaveBeenCalled();
    expect(logouts(h, 's1')).toBe(1);
    expect(names(h)).toEqual(['folders.list']);
  });

  it('the screen fails right after the login: the app ends, the session is logged out, nothing is read on it', async () => {
    const h = await atHome();
    const draw = h.t.draw.bind(h.t);
    h.t.draw = (frame) => {
      if (text(frame).includes('Reading folders...')) throw new Error('terminal gone');
      draw(frame);
    };
    h.t.key(ENTER);
    await expect(h.done).rejects.toThrow('terminal gone');
    await h.app.settled();
    await settle();
    expect(h.calls).toEqual(['find', 'open:s1', 'logout:s1']);
    expect(h.listFolders).not.toHaveBeenCalled();
    expect(h.log.records).toEqual([]);
  });
});

// --- leaving --------------------------------------------------------------------------------

describe('leaving the mailbox', () => {
  it.each([
    ['Esc', ESC],
    ['Left', LEFT],
    ['Backspace', BACKSPACE],
  ])(
    '%s on the bars: Home as it was, the session logged out once, nothing reloaded',
    async (_n, key) => {
      const h = await atHome();
      await press(h, DOWN, ENTER);
      await shown(h, 'Total:');
      await press(h, key);
      expect(last(h)).toContain(HOME_ROW);
      expect(last(h)).toContain(BOX_EMAIL);
      expect(h.t.frames.at(-1)?.cursorLine).toBe(2);
      expect(logouts(h, 's1')).toBe(1);
      expect(h.listMailboxes).toHaveBeenCalledTimes(1);
      expect(await stillRunning(h.done)).toBe(true);
      await quit(h);
      expect(logouts(h, 's1')).toBe(1);
    },
  );

  it('opening it again is a new login on a new session', async () => {
    const h = await atBars();
    await press(h, ESC, ENTER);
    await shown(h, 'Total:');
    expect(h.calls).toEqual([
      'find',
      'open:s1',
      'list:s1',
      'logout:s1',
      'find',
      'open:s2',
      'list:s2',
    ]);
    await quit(h);
    expect(logouts(h, 's1')).toBe(1);
    expect(logouts(h, 's2')).toBe(1);
  });

  it('while connecting: Home at once; the session that still arrives is logged out and nothing else', async () => {
    const { h, login } = await connecting();
    await press(h, ESC);
    expect(last(h)).toContain(HOME_ROW);
    login.resolve(h.session('late'));
    await vi.waitFor(() => {
      expect(logouts(h, 'late')).toBe(1);
    });
    await settle();
    expect(h.listFolders).not.toHaveBeenCalled();
    expect(last(h)).toContain(HOME_ROW);
    expect(h.log.records).toEqual([]);
    await quit(h);
    expect(logouts(h, 'late')).toBe(1);
  });

  it("while connecting: a login that then fails - even with an error that is not ours - is nobody's failure", async () => {
    for (const err of [new ImapSessionError('auth-failed'), new TypeError('boom')]) {
      const { h, login } = await connecting();
      await press(h, ESC);
      login.reject(err);
      await settle();
      await settle();
      expect(last(h)).toContain(HOME_ROW);
      expect(h.log.records).toEqual([]);
      expect(h.onUnexpected).not.toHaveBeenCalled();
      expect(await stillRunning(h.done)).toBe(true);
      await quit(h);
    }
  });

  it('before the mailbox is even found: no login is made for it', async () => {
    const h = await atHome();
    const found = deferred<MailAccount>();
    h.findAccount.mockReturnValueOnce(found.promise);
    await press(h, ENTER);
    await shown(h, 'Connecting...');
    await press(h, ESC);
    found.resolve(BOX);
    await settle();
    await settle();
    expect(h.openSession).not.toHaveBeenCalled();
    expect(h.log.records).toEqual([]);
    await quit(h);
  });

  it("during the guard's wait: the wait ends and the login is not made", async () => {
    const h = await atHome({ challengeDelayMs: 60_000 });
    let outcome = 'waiting';
    h.openSession.mockImplementationOnce(async (_account, onChallenge) => {
      try {
        await onChallenge();
      } catch (err) {
        outcome = 'refused';
        throw err;
      }
      outcome = 'logged in';
      return h.session('s1');
    });
    await press(h, ENTER);
    await shown(h, CHALLENGE_NOTICE);
    await press(h, ESC);
    await settle();
    expect(outcome).toBe('refused');
    expect(last(h)).toContain(HOME_ROW);
    expect(h.log.records).toEqual([]);
    expect(h.onUnexpected).not.toHaveBeenCalled();
    expect(await stillRunning(h.done)).toBe(true);
    await quit(h);
  });

  it('while reading: the session is logged out, the read is dropped whatever it brings', async () => {
    for (const end of ['folders', 'connection-lost', 'boom'] as const) {
      const { h, read } = await reading();
      await press(h, LEFT);
      expect(last(h)).toContain(HOME_ROW);
      expect(logouts(h, 's1')).toBe(1);
      if (end === 'folders') read.resolve(TREE);
      else read.reject(end === 'boom' ? new TypeError('boom') : new MailboxError(end));
      await settle();
      await settle();
      expect(last(h)).toContain(HOME_ROW);
      expect(h.log.records).toEqual([]);
      expect(h.onUnexpected).not.toHaveBeenCalled();
      expect(await stillRunning(h.done)).toBe(true);
      await quit(h);
      expect(logouts(h, 's1')).toBe(1);
    }
  });

  it('progress of a read that was left never shows in the mailbox opened next', async () => {
    const h = await atHome();
    const reports: ((progress: SizeProgress) => void)[] = [];
    h.listFolders.mockImplementation((_s, onProgress) => {
      reports.push(onProgress);
      return new Promise<FolderTree>(() => undefined);
    });
    await press(h, ENTER);
    await shown(h, 'Reading folders...');
    await press(h, ESC, DOWN, ENTER);
    await shown(h, 'Reading folders...');
    expect(reports).toHaveLength(2);
    reports[0]?.({ folder: 8, folders: 9, done: 1, total: 2 });
    await settle();
    expect(last(h)).not.toContain('8/9');
    reports[1]?.({ folder: 1, folders: 3, done: 1, total: 2 });
    await shown(h, 'Reading folders... 1/3');
    await quit(h);
    expect(h.log.records).toEqual([]);
  });

  it('a second mailbox opened while the first login is still under way: only the second is shown', async () => {
    const { h, login } = await connecting();
    await press(h, ESC, DOWN, ENTER);
    await shown(h, 'Total:');
    expect(last(h)).toContain(`Mail Manager - ${BOX_2_EMAIL}`);
    login.resolve(h.session('late'));
    await vi.waitFor(() => {
      expect(logouts(h, 'late')).toBe(1);
    });
    expect(last(h)).toContain(`Mail Manager - ${BOX_2_EMAIL}`);
    expect(events(h, 'folders.list')).toEqual([expect.objectContaining({ acct: BOX_2_ID })]);
    expect(logouts(h, 's1')).toBe(0);
    await quit(h);
    expect(logouts(h, 's1')).toBe(1);
  });

  it('with marks it asks first: n keeps the session, y logs it out and drops them', async () => {
    const h = await barsWithMarks();
    await press(h, ESC);
    expect(last(h)).toContain('Drop 3 marks? (y/N)');
    expect(logouts(h, 's1')).toBe(0);
    await press(h, ch('n'));
    expect(last(h)).toContain('Total:');
    expect(logouts(h, 's1')).toBe(0);
    await press(h, ESC, ch('y'));
    expect(last(h)).toContain(HOME_ROW);
    expect(logouts(h, 's1')).toBe(1);
    // A new visit starts with nothing marked.
    await press(h, ENTER);
    await shown(h, 'Total:');
    await press(h, ENTER);
    await shown(h, 'marked: 0 mails');
    await quit(h);
  });
});

// --- quitting -------------------------------------------------------------------------------

describe('q and Ctrl+C', () => {
  it('q on the bars: the app ends with quit, the session is logged out', async () => {
    const h = await atBars();
    h.t.key(ch('q'));
    await expect(h.done).resolves.toStrictEqual({ end: 'quit' });
    await h.app.settled();
    expect(logouts(h, 's1')).toBe(1);
  });

  it('q with marks asks first; n stays, y quits', async () => {
    const h = await barsWithMarks();
    await press(h, ch('q'));
    expect(last(h)).toContain('Quit and drop 3 marks? (y/N)');
    await press(h, ch('n'));
    expect(await stillRunning(h.done)).toBe(true);
    expect(logouts(h, 's1')).toBe(0);
    await press(h, ch('q'), ch('y'));
    await expect(h.done).resolves.toMatchObject({ end: 'quit' });
    await h.app.settled();
    expect(logouts(h, 's1')).toBe(1);
  });

  it('q while connecting: quits; the session that arrives later is logged out before settled() is', async () => {
    const { h, login } = await connecting();
    h.t.key(ch('q'));
    await expect(h.done).resolves.toMatchObject({ end: 'quit' });
    const settled = h.app.settled();
    expect(await stillRunning(settled)).toBe(true);
    login.resolve(h.session('late'));
    await settled;
    expect(logouts(h, 'late')).toBe(1);
    expect(h.log.records).toEqual([]);
  });

  it.each<[string, () => Promise<Harness>]>([
    ['reading', async () => (await reading()).h],
    ['on the bars', () => atBars()],
    [
      'at the leave question',
      async () => {
        const h = await barsWithMarks();
        await press(h, ESC);
        return h;
      },
    ],
    ['in a folder', () => atMails()],
    [
      'at the question of the browser',
      async () => {
        const h = await atMails();
        await press(h, ch('a'), ch('q'));
        expect(last(h)).toContain('(y/N)');
        return h;
      },
    ],
    ['at the reconnect question', () => lost()],
  ])(
    'Ctrl+C %s: ends at once, the session logged out once by the time settled() is',
    async (_n, make) => {
      const h = await make();
      const frames = h.t.frames.length;
      h.t.key(CTRL_C);
      await expect(h.done).resolves.toMatchObject({ end: 'interrupt' });
      await h.app.settled();
      expect(logouts(h, 's1')).toBe(1);
      expect(h.t.frames.length).toBe(frames);
      // Keys after the end do nothing.
      h.t.key(ENTER);
      h.t.key(CTRL_C);
      await settle();
      expect(logouts(h, 's1')).toBe(1);
    },
  );

  it('Ctrl+C while connecting: settled() waits for the login and logs its session out', async () => {
    const { h, login } = await connecting();
    h.t.key(CTRL_C);
    await expect(h.done).resolves.toMatchObject({ end: 'interrupt' });
    const settled = h.app.settled();
    expect(await stillRunning(settled)).toBe(true);
    login.resolve(h.session('late'));
    await settled;
    expect(logouts(h, 'late')).toBe(1);
    expect(h.listFolders).not.toHaveBeenCalled();
    expect(h.log.records).toEqual([]);
  });

  it('a login that never answers is given up after 5 seconds; a finished one leaves no timer', async () => {
    const { h } = await connecting();
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
    expect(over).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    // Nothing under way: at once, and the 5 seconds are not left ticking.
    const bars = await (async () => {
      vi.useRealTimers();
      return atBars();
    })();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    bars.t.key(CTRL_C);
    await bars.done;
    await bars.app.settled();
    expect(vi.getTimerCount()).toBe(0);
    expect(logouts(bars, 's1')).toBe(1);
  });

  it('a logout that fails or throws does not keep settled() or end the app badly', async () => {
    const h = await atHome();
    h.openSession.mockImplementationOnce(() => {
      const made = h.session('s1');
      made.logout.mockImplementation(() => Promise.reject(new Error('socket gone')));
      return Promise.resolve(made);
    });
    await press(h, ENTER);
    await shown(h, 'Total:');
    await press(h, ESC);
    expect(last(h)).toContain(HOME_ROW);
    await settle();
    expect(await stillRunning(h.done)).toBe(true);
    h.openSession.mockImplementationOnce(() => {
      const made = h.session('s2');
      made.logout.mockImplementation(() => {
        throw new Error('socket gone');
      });
      return Promise.resolve(made);
    });
    await press(h, ENTER);
    await shown(h, 'Total:');
    h.t.key(ch('q'));
    await expect(h.done).resolves.toMatchObject({ end: 'quit' });
    await h.app.settled();
  });

  it('Home, with no mailbox open: nothing to log out, settled() at once', async () => {
    const h = await atHome();
    await quit(h);
    expect(h.calls).toEqual([]);
  });
});

// --- the embedded browser -------------------------------------------------------------------

describe('a folder', () => {
  it('Enter on a folder: its first page is read on the session of the mailbox', async () => {
    const h = await atMails();
    expect(h.load.mock.calls).toEqual([[h.sessions[0], 'INBOX', null, 0]]);
    expect(last(h)).toContain(`${BOX_EMAIL} / INBOX`);
    expect(last(h)).toContain('Esc/Left back');
    await quit(h);
  });

  it('marks, Esc to the bars (the session stays), the folder again: still marked', async () => {
    const h = await atMails();
    await press(h, ch(' '));
    expect(last(h)).toContain('marked: 1 mail,');
    await press(h, ESC);
    expect(last(h)).toContain('Total:');
    expect(logouts(h, 's1')).toBe(0);
    await press(h, ENTER);
    await shown(h, 'marked: 1 mail,');
    expect(last(h)).toContain('[x]');
    await press(h, DOWN, ch(' '));
    expect(last(h)).toContain('marked: 2 mails');
    expect(h.calls.filter((c) => c.startsWith('load:'))).toEqual([
      'load:s1:INBOX',
      'load:s1:INBOX',
    ]);
    await quit(h);
    expect(logouts(h, 's1')).toBe(1);
  });

  it('marks made in one folder are counted in another', async () => {
    const h = await barsWithMarks();
    await press(h, DOWN, DOWN, DOWN, ENTER);
    await shown(h, `${BOX_EMAIL} / Sent`);
    await shown(h, 'marked: 3 mails');
    await press(h, ch(' '));
    expect(last(h)).toContain('marked: 4 mails');
    await quit(h);
  });

  it('a subfolder opens inside the browser; Esc goes up one level, then to the bars', async () => {
    const h = await atBars();
    await press(h, DOWN, ENTER);
    await shown(h, `${BOX_EMAIL} / Projects`);
    await press(h, ENTER);
    await shown(h, 'Projects / Alpha');
    await press(h, ESC);
    await shown(h, `${BOX_EMAIL} / Projects`);
    expect(last(h)).not.toContain('Total:');
    await press(h, LEFT);
    expect(last(h)).toContain('Total:');
    expect(h.calls.filter((c) => c.startsWith('load:'))).toEqual([
      'load:s1:Projects',
      'load:s1:Projects/Alpha',
      'load:s1:Projects',
    ]);
    await quit(h);
  });

  it('a late page of a browser that was left never shows in the next one', async () => {
    const h = await atBars();
    const first = deferred<PageResult>();
    const second = deferred<PageResult>();
    h.load.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await press(h, ENTER, ESC);
    expect(last(h)).toContain('Total:');
    await press(h, ENTER);
    expect(h.load).toHaveBeenCalledTimes(2);
    first.resolve(pageOf('INBOX', 'Stale'));
    await settle();
    await settle();
    expect(last(h)).not.toContain('Stale');
    expect(last(h)).toContain('Loading...');
    second.resolve(pageOf('INBOX', 'Fresh'));
    await shown(h, 'Fresh 3');
    expect(last(h)).not.toContain('Stale');
    await quit(h);
  });

  it('a late page after the mailbox was left - or failed - changes nothing', async () => {
    for (const end of ['page', 'folder-unavailable', 'boom'] as const) {
      const h = await atBars();
      const page = deferred<PageResult>();
      h.load.mockReturnValueOnce(page.promise);
      await press(h, ENTER, ESC, ESC);
      expect(last(h)).toContain(HOME_ROW);
      if (end === 'page') page.resolve(pageOf('INBOX', 'Stale'));
      else page.reject(end === 'boom' ? new TypeError('boom') : new MailboxError(end));
      await settle();
      await settle();
      expect(last(h)).toContain(HOME_ROW);
      expect(await stillRunning(h.done)).toBe(true);
      await quit(h);
    }
  });

  it('a folder that cannot be opened: the bars again, with the message', async () => {
    const h = await atBars();
    h.load.mockRejectedValueOnce(new MailboxError('folder-unavailable'));
    await press(h, ENTER);
    await shown(h, "Couldn't open that folder.");
    expect(last(h)).toContain('Total:');
    expect(logouts(h, 's1')).toBe(0);
    await quit(h);
  });

  it('a page load that fails with an error that is not ours ends the app; the session is logged out', async () => {
    const h = await atBars();
    const err = new TypeError('boom');
    h.load.mockImplementationOnce(() => {
      throw err;
    });
    h.t.key(ENTER);
    await expect(h.done).rejects.toBe(err);
    await h.app.settled();
    expect(logouts(h, 's1')).toBe(1);
    expect(events(h, 'browse.finish')).toEqual([
      expect.objectContaining({
        acct: BOX_ID,
        folders: 1,
        outcome: 'failed',
        reason: 'unexpected',
      }),
    ]);
  });

  it('q in a folder quits the app; with marks the browser asks first', async () => {
    const plain = await atMails();
    plain.t.key(ch('q'));
    await expect(plain.done).resolves.toMatchObject({ end: 'quit' });
    await plain.app.settled();
    expect(logouts(plain, 's1')).toBe(1);

    const h = await atMails();
    await press(h, ch('a'), ch('q'));
    expect(last(h)).toContain('Quit and drop 3 marks? (y/N)');
    expect(await stillRunning(h.done)).toBe(true);
    await press(h, ch('y'));
    await expect(h.done).resolves.toMatchObject({ end: 'quit' });
    await h.app.settled();
    expect(logouts(h, 's1')).toBe(1);
  });

  it('a resize in a folder draws the browser at the new size', async () => {
    const h = await atMails();
    h.t.screen = { rows: 12, cols: 60 };
    h.t.resize();
    await settle();
    const frame = h.t.frames.at(-1);
    expect(frame?.lines).toHaveLength(12);
    for (const line of frame?.lines ?? []) expect(line).toHaveLength(60);
    expect(last(h)).toContain('Subject 3');
    await press(h, ESC);
    expect(h.t.frames.at(-1)?.lines).toHaveLength(12);
    expect(last(h)).toContain('Total:');
    await quit(h);
  });
});

// --- reconnect ------------------------------------------------------------------------------

describe('a lost connection in a folder', () => {
  it('y: the old session is logged out, then one new login; the page is read on the new one', async () => {
    const h = await lost();
    await press(h, ch('y'));
    await shown(h, 'Subject 3');
    expect(h.calls).toEqual([
      'find',
      'open:s1',
      'list:s1',
      'logout:s1',
      'open:s2',
      'load:s2:INBOX',
    ]);
    expect(h.openSession.mock.calls[1]?.[0]).toBe(BOX);
    expect(h.findAccount).toHaveBeenCalledTimes(1);
    // The new session is the mailbox's from now on: the next folder reads on it too.
    await press(h, ESC, DOWN, ENTER);
    await shown(h, `${BOX_EMAIL} / Projects`);
    expect(h.calls.at(-1)).toBe('load:s2:Projects');
    await press(h, ESC, ESC);
    expect(last(h)).toContain(HOME_ROW);
    expect(logouts(h, 's1')).toBe(1);
    expect(logouts(h, 's2')).toBe(1);
    await quit(h);
    expect(logouts(h, 's2')).toBe(1);
  });

  it('n: offline, no login; r reconnects later', async () => {
    const h = await lost();
    await press(h, ch('n'));
    expect(last(h)).toContain('Offline - showing what is loaded (r = reconnect).');
    expect(h.openSession).toHaveBeenCalledTimes(1);
    expect(logouts(h, 's1')).toBe(0);
    await press(h, ch('r'));
    await shown(h, 'Subject 3');
    expect(h.openSession).toHaveBeenCalledTimes(2);
    await quit(h);
    expect(logouts(h, 's1')).toBe(1);
    expect(logouts(h, 's2')).toBe(1);
  });

  it('the guard waits before the reconnect: its notice in the browser, then the login', async () => {
    const h = await lost({ challengeDelayMs: 15 });
    h.openSession.mockImplementationOnce(async (_account, onChallenge) => {
      await onChallenge();
      const made = h.session('s2');
      h.sessions.push(made);
      return made;
    });
    await press(h, ch('y'));
    await shown(h, CHALLENGE_NOTICE);
    await shown(h, 'Subject 3');
    expect(last(h)).not.toContain(CHALLENGE_NOTICE);
    await quit(h);
    expect(logouts(h, 's2')).toBe(1);
  });

  it('a failed reconnect: offline with the short text, nothing retried, the error kept for the end', async () => {
    const h = await lost();
    const err = new ImapSessionError('auth-failed');
    h.openSession.mockRejectedValueOnce(err);
    await press(h, ch('y'));
    await shown(h, RECONNECT_FAILED_TEXT);
    await settle();
    await settle();
    expect(h.openSession).toHaveBeenCalledTimes(2);
    expect(h.onUnexpected).not.toHaveBeenCalled();
    h.t.key(CTRL_C);
    await expect(h.done).resolves.toStrictEqual({
      end: 'interrupt',
      reconnectError: err,
      reconnectAccount: BOX,
    });
    await h.app.settled();
    // The old session was logged out by the reconnect: not a second time at the end.
    expect(logouts(h, 's1')).toBe(1);
  });

  it('after a failed reconnect the next folder asks again without reading; y logs in once', async () => {
    const h = await lost();
    h.openSession.mockRejectedValueOnce(new ImapSessionError('timeout'));
    await press(h, ch('y'));
    await shown(h, RECONNECT_FAILED_TEXT);
    await press(h, ESC);
    expect(last(h)).toContain('Total:');
    const loads = h.load.mock.calls.length;
    await press(h, DOWN, DOWN, DOWN, ENTER);
    await shown(h, 'Connection closed - reconnect? (y/N)');
    expect(h.load.mock.calls.length).toBe(loads);
    await press(h, ch('y'));
    await shown(h, 'Subject 3');
    expect(h.openSession).toHaveBeenCalledTimes(3);
    expect(h.calls.at(-1)).toBe('load:s2:Sent');
    h.t.key(CTRL_C);
    // The later reconnect worked: nothing is left to report.
    await expect(h.done).resolves.toStrictEqual({ end: 'interrupt' });
    await h.app.settled();
    expect(logouts(h, 's1')).toBe(1);
    expect(logouts(h, 's2')).toBe(1);
  });

  it('a reconnect error that is not ours is reported and the app goes on, offline', async () => {
    const h = await lost();
    const err = new TypeError('boom');
    h.openSession.mockRejectedValueOnce(err);
    await press(h, ch('y'));
    await shown(h, RECONNECT_FAILED_TEXT);
    expect(h.onUnexpected.mock.calls).toEqual([[err]]);
    expect(await stillRunning(h.done)).toBe(true);
    h.t.key(CTRL_C);
    await expect(h.done).resolves.toMatchObject({ reconnectError: err });
    await h.app.settled();
  });

  it('Ctrl+C while the reconnect logs in: the session that arrives is logged out', async () => {
    const h = await lost();
    const login = deferred<MailboxSession>();
    h.openSession.mockReturnValueOnce(login.promise);
    await press(h, ch('y'));
    await shown(h, 'Reconnecting...');
    h.t.key(CTRL_C);
    await expect(h.done).resolves.toMatchObject({ end: 'interrupt' });
    const settled = h.app.settled();
    expect(await stillRunning(settled)).toBe(true);
    login.resolve(h.session('late'));
    await settled;
    expect(logouts(h, 'late')).toBe(1);
    expect(logouts(h, 's1')).toBe(1);
  });

  it("Ctrl+C during the guard's wait of a reconnect: no wait, no login", async () => {
    const h = await lost({ challengeDelayMs: 60_000 });
    let outcome = 'waiting';
    h.openSession.mockImplementationOnce(async (_account, onChallenge) => {
      try {
        await onChallenge();
      } catch (err) {
        outcome = 'refused';
        throw err;
      }
      outcome = 'logged in';
      return h.session('s2');
    });
    await press(h, ch('y'));
    await shown(h, CHALLENGE_NOTICE);
    await quit(h);
    expect(outcome).toBe('refused');
    expect(logouts(h, 's2')).toBe(0);
  });

  describe('what is reported when the app ends', () => {
    /** In the first mailbox: a reconnect that fails with `err`, then back on Home. */
    async function failedThenHome(err: unknown): Promise<Harness> {
      const h = await lost();
      h.openSession.mockRejectedValueOnce(err);
      await press(h, ch('y'));
      await shown(h, RECONNECT_FAILED_TEXT);
      await press(h, ESC, ESC);
      expect(last(h)).toContain(HOME_ROW);
      return h;
    }

    async function quitWith(h: Harness): Promise<AppResult> {
      h.t.key(ch('q'));
      const result = await h.done;
      await h.app.settled();
      return result;
    }

    it('leaving the mailbox keeps the failure and its mailbox', async () => {
      const err = new ImapSessionError('timeout');
      const h = await failedThenHome(err);
      expect(await quitWith(h)).toStrictEqual({
        end: 'quit',
        reconnectError: err,
        reconnectAccount: BOX,
      });
    });

    it('the same mailbox opened again and logged in: nothing is left to report', async () => {
      const h = await failedThenHome(new ImapSessionError('timeout'));
      await press(h, ENTER);
      await shown(h, 'Total:');
      expect(await quitWith(h)).toStrictEqual({ end: 'quit' });
    });

    it('also when that login only arrives after the mailbox was left again', async () => {
      const h = await failedThenHome(new ImapSessionError('timeout'));
      const login = deferred<MailboxSession>();
      h.openSession.mockReturnValueOnce(login.promise);
      await press(h, ENTER);
      await shown(h, 'Connecting...');
      await press(h, ESC);
      login.resolve(h.session('late'));
      await vi.waitFor(() => {
        expect(logouts(h, 'late')).toBe(1);
      });
      expect(await quitWith(h)).toStrictEqual({ end: 'quit' });
    });

    it('a login to that mailbox that fails keeps it', async () => {
      const err = new ImapSessionError('timeout');
      const h = await failedThenHome(err);
      h.openSession.mockRejectedValueOnce(new ImapSessionError('auth-failed'));
      await press(h, ENTER);
      await shown(h, 'r try again');
      expect(await quitWith(h)).toStrictEqual({
        end: 'quit',
        reconnectError: err,
        reconnectAccount: BOX,
      });
    });

    it('another mailbox opened and logged in: the first one is still reported', async () => {
      const err = new ImapSessionError('timeout');
      const h = await failedThenHome(err);
      await press(h, DOWN, ENTER);
      await shown(h, `Mail Manager - ${BOX_2_EMAIL}`);
      await shown(h, 'Total:');
      expect(await quitWith(h)).toStrictEqual({
        end: 'quit',
        reconnectError: err,
        reconnectAccount: BOX,
      });
    });

    it('a reconnect that works in another mailbox does not clear it either', async () => {
      const err = new ImapSessionError('timeout');
      const h = await failedThenHome(err);
      await press(h, DOWN, ENTER);
      await shown(h, 'Total:');
      h.load.mockRejectedValueOnce(new MailboxError('connection-lost'));
      await press(h, ENTER);
      await shown(h, 'reconnect? (y/N)');
      await press(h, ch('y'));
      await shown(h, 'Subject 3');
      expect(await quitWith(h)).toStrictEqual({
        end: 'quit',
        reconnectError: err,
        reconnectAccount: BOX,
      });
    });

    it('a later failed reconnect in another mailbox replaces it', async () => {
      const h = await failedThenHome(new ImapSessionError('timeout'));
      await press(h, DOWN, ENTER);
      await shown(h, 'Total:');
      h.load.mockRejectedValueOnce(new MailboxError('connection-lost'));
      await press(h, ENTER);
      await shown(h, 'reconnect? (y/N)');
      const second = new ImapSessionError('auth-failed');
      h.openSession.mockRejectedValueOnce(second);
      await press(h, ch('y'));
      await shown(h, RECONNECT_FAILED_TEXT);
      h.t.key(CTRL_C);
      await expect(h.done).resolves.toStrictEqual({
        end: 'interrupt',
        reconnectError: second,
        reconnectAccount: BOX_2,
      });
      await h.app.settled();
    });
  });

  it('Ctrl+C while the old session is still being logged out: no login after the end', async () => {
    const h = await atHome();
    const out = deferred<undefined>();
    h.openSession.mockImplementationOnce(() => {
      const made = h.session('s1');
      made.logout.mockImplementation(() => {
        h.calls.push('logout:s1');
        return out.promise;
      });
      h.sessions.push(made);
      return Promise.resolve(made);
    });
    await press(h, ENTER);
    await shown(h, 'Total:');
    h.load.mockRejectedValueOnce(new MailboxError('connection-lost'));
    await press(h, ENTER);
    await shown(h, 'reconnect? (y/N)');
    await press(h, ch('y'));
    expect(logouts(h, 's1')).toBe(1);
    h.t.key(CTRL_C);
    await h.done;
    out.resolve(undefined);
    await h.app.settled();
    expect(h.openSession).toHaveBeenCalledTimes(1);
    expect(logouts(h, 's1')).toBe(1);
  });
});

// --- the log --------------------------------------------------------------------------------

describe('folders.list and imap.capability-fallback', () => {
  it('one folders.list per open: the account id, the count, a duration - nothing else', async () => {
    const h = await atBars();
    expect(h.log.records).toHaveLength(1);
    const line = h.log.records[0] ?? {};
    expect(line).toMatchObject({ event: 'folders.list', acct: BOX_ID, folders: 4, outcome: 'ok' });
    expect(Object.keys(line).sort()).toEqual(
      ['acct', 'event', 'folders', 'level', 'ms', 'outcome', 'run', 'ts', 'v'].sort(),
    );
    await press(h, ESC, ENTER);
    await shown(h, 'Total:');
    expect(names(h)).toEqual(['folders.list', 'folders.list']);
    await quit(h);
    expect(names(h)).toEqual(['folders.list', 'folders.list']);
  });

  it('each server fallback once per run, however many mailboxes are opened', async () => {
    const tree = treeOf(TREE.folders, { fallbacks: new Set(['status-size', 'quota'] as const) });
    const h = await atBars({ tree });
    expect(names(h)).toEqual([
      'imap.capability-fallback',
      'imap.capability-fallback',
      'folders.list',
    ]);
    expect(events(h, 'imap.capability-fallback').map((r) => r['feature'])).toEqual([
      'status-size',
      'quota',
    ]);
    await press(h, ESC, DOWN, ENTER);
    await shown(h, 'Total:');
    // A feature the second mailbox adds is still logged.
    h.listFolders.mockResolvedValueOnce(
      treeOf(TREE.folders, { fallbacks: new Set(['quota', 'list-status'] as const) }),
    );
    await press(h, ESC, ENTER);
    await shown(h, 'Total:');
    expect(events(h, 'imap.capability-fallback').map((r) => r['feature'])).toEqual([
      'status-size',
      'quota',
      'list-status',
    ]);
    expect(events(h, 'folders.list')).toHaveLength(3);
    await quit(h);
  });
});

describe('browse.finish', () => {
  it('none for a visit that opened no folder - left, quit or interrupted', async () => {
    const left = await atBars();
    await press(left, ESC);
    await quit(left);
    const quitted = await atBars();
    quitted.t.key(ch('q'));
    await quitted.done;
    await quitted.app.settled();
    const interrupted = await atBars();
    await quit(interrupted);
    for (const h of [left, quitted, interrupted]) expect(names(h)).toEqual(['folders.list']);
  });

  it('once when the mailbox is left: what the visit did, in counts', async () => {
    const h = await barsWithMarks();
    await press(h, DOWN, ENTER);
    await shown(h, `${BOX_EMAIL} / Projects`);
    await press(h, ESC, ESC, ch('y'));
    expect(last(h)).toContain(HOME_ROW);
    const lines = events(h, 'browse.finish');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      acct: BOX_ID,
      folders: 2,
      mails: 6,
      marked: 3,
      bytes: 300,
      reconnects: 0,
      outcome: 'ok',
    });
    expect(lines[0]).not.toHaveProperty('reason');
    expect(Object.keys(lines[0] ?? {}).sort()).toEqual(
      [
        'acct',
        'bytes',
        'event',
        'folders',
        'level',
        'mails',
        'marked',
        'ms',
        'outcome',
        'reconnects',
        'run',
        'ts',
        'v',
      ].sort(),
    );
    await quit(h);
    expect(events(h, 'browse.finish')).toHaveLength(1);
  });

  it('q from a folder: ok, with the marks the browser still held', async () => {
    const h = await atMails();
    await press(h, ch(' '), ch('q'), ch('y'));
    await h.done;
    await h.app.settled();
    expect(events(h, 'browse.finish')).toEqual([
      expect.objectContaining({ folders: 1, mails: 3, marked: 1, bytes: 100, outcome: 'ok' }),
    ]);
  });

  it('q from the bars after a folder: ok, once', async () => {
    const h = await atMails();
    await press(h, ESC);
    h.t.key(ch('q'));
    await h.done;
    await h.app.settled();
    expect(events(h, 'browse.finish')).toEqual([
      expect.objectContaining({ folders: 1, mails: 3, marked: 0, outcome: 'ok' }),
    ]);
  });

  it('Ctrl+C: interrupted, once - in a folder and on the bars after one', async () => {
    const inFolder = await atMails();
    await quit(inFolder);
    const onBars = await atMails();
    await press(onBars, ESC);
    await quit(onBars);
    for (const h of [inFolder, onBars]) {
      expect(events(h, 'browse.finish')).toEqual([
        expect.objectContaining({ folders: 1, mails: 3, outcome: 'interrupted' }),
      ]);
    }
  });

  it('the reconnects of the visit are counted', async () => {
    const h = await lost();
    await press(h, ch('y'));
    await shown(h, 'Subject 3');
    await quit(h);
    expect(events(h, 'browse.finish')).toEqual([
      expect.objectContaining({ folders: 1, mails: 3, reconnects: 1, outcome: 'interrupted' }),
    ]);
  });

  it('a folder that could not be opened was still opened', async () => {
    const h = await atBars();
    h.load.mockRejectedValueOnce(new MailboxError('folder-unavailable'));
    await press(h, ENTER);
    await shown(h, "Couldn't open that folder.");
    await press(h, ESC);
    expect(events(h, 'browse.finish')).toEqual([
      expect.objectContaining({ folders: 1, mails: 0, outcome: 'ok' }),
    ]);
    await quit(h);
  });

  it('one per visit: two visits, two lines', async () => {
    const h = await atMails();
    await press(h, ESC, ESC, DOWN, ENTER);
    await shown(h, 'Total:');
    await press(h, ENTER);
    await shown(h, 'Subject 3');
    await quit(h);
    expect(events(h, 'browse.finish')).toEqual([
      expect.objectContaining({ acct: BOX_ID, outcome: 'ok' }),
      expect.objectContaining({ acct: BOX_2_ID, outcome: 'interrupted' }),
    ]);
  });

  it('the app ending on an error: failed, with the reason code', async () => {
    const h = await atMails();
    h.t.failDraw = new Error('terminal gone');
    h.t.key(DOWN);
    await expect(h.done).rejects.toThrow('terminal gone');
    await h.app.settled();
    expect(events(h, 'browse.finish')).toEqual([
      expect.objectContaining({ folders: 1, mails: 3, outcome: 'failed', reason: 'unexpected' }),
    ]);
    expect(logouts(h, 's1')).toBe(1);
  });
});

describe('the exit hook', () => {
  it.each([130, 129, 143])('code %i: browse.finish interrupted, no logout', async (code) => {
    const h = await atMails();
    h.app.onExit(code);
    expect(events(h, 'browse.finish')).toEqual([
      expect.objectContaining({ acct: BOX_ID, folders: 1, mails: 3, outcome: 'interrupted' }),
    ]);
    expect(logouts(h, 's1')).toBe(0);
    await quit(h);
  });

  it('any other code: failed, unexpected', async () => {
    const h = await atMails();
    await press(h, ch('a'), ESC);
    h.app.onExit(1);
    expect(events(h, 'browse.finish')).toEqual([
      expect.objectContaining({ marked: 3, bytes: 300, outcome: 'failed', reason: 'unexpected' }),
    ]);
    await quit(h);
  });

  it('never a second line for the visit: not from the hook again, not from what ends it', async () => {
    const h = await atMails();
    h.app.onExit(143);
    h.app.onExit(143);
    h.app.onExit(1);
    expect(events(h, 'browse.finish')).toHaveLength(1);
    await press(h, ESC, ESC);
    expect(last(h)).toContain(HOME_ROW);
    expect(logouts(h, 's1')).toBe(1);
    await quit(h);
    expect(events(h, 'browse.finish')).toHaveLength(1);
  });

  it('nothing to write: no mailbox, no folder opened, or the visit already over', async () => {
    const home = await atHome();
    home.app.onExit(130);
    const bars = await atBars();
    bars.app.onExit(130);
    const opening = await connecting();
    opening.h.app.onExit(130);
    for (const h of [home, bars, opening.h]) expect(events(h, 'browse.finish')).toEqual([]);
    opening.login.reject(new ImapSessionError('timeout'));
    for (const h of [home, bars, opening.h]) await quit(h);

    const left = await atMails();
    await press(left, ESC, ESC);
    left.app.onExit(130);
    expect(events(left, 'browse.finish')).toHaveLength(1);
    await quit(left);
    left.app.onExit(130);
    expect(events(left, 'browse.finish')).toHaveLength(1);
  });
});

// --- nothing private in the log -------------------------------------------------------------

describe('the log has ids, counts and reason codes only', () => {
  const FOLDER = 'CanaryFolder-48151\u202e';
  const SUBJECT = 'CanarySubject-62342';
  const SENDER = 'canary.sender@example-test-domain.eu';
  const HOST = 'imap.canary-host.example-test-domain.eu';
  const USERNAME = 'canary-user-name-77';
  const SECRET = 'CanaryCiphertext-99123';

  it('a failed login, r, a hostile folder, marks, a lost connection, a failed and a good reconnect, Ctrl+C', async () => {
    const canary = account(BOX_ID, 'canary.box@example-test-domain.eu', {
      host: HOST,
      username: USERNAME,
      secret: { ciphertext: SECRET, iv: 'i', tag: 't', keyVersion: 1 },
    });
    const tree = treeOf([folder(FOLDER), folder('Plain')], {
      fallbacks: new Set(['status-size'] as const),
    });
    const h = await atHome({ mailboxes: [canary], tree });
    h.load.mockImplementation((_s, path) =>
      Promise.resolve({
        kind: 'page',
        snapshot: { path, uidValidity: '7', exists: 2 },
        page: 0,
        rows: [mail(2, SUBJECT, SENDER), mail(1, SUBJECT, SENDER)],
      }),
    );
    const loginError = new ImapSessionError('auth-failed');
    h.openSession.mockRejectedValueOnce(loginError);
    await press(h, ENTER);
    await shown(h, 'r try again');
    await press(h, ch('r'));
    await shown(h, 'CanaryFolder-48151');
    await press(h, ENTER);
    await shown(h, SUBJECT);
    await press(h, ch('a'), ESC);
    await shown(h, 'Total:');
    h.load.mockRejectedValueOnce(new MailboxError('connection-lost'));
    await press(h, DOWN, ENTER);
    await shown(h, 'reconnect? (y/N)');
    h.openSession.mockRejectedValueOnce(new ImapSessionError('timeout'));
    await press(h, ch('y'));
    await shown(h, RECONNECT_FAILED_TEXT);
    await press(h, ch('r'));
    await shown(h, SUBJECT);
    await quit(h);

    expect(names(h)).toEqual([
      'folders.list',
      'imap.capability-fallback',
      'folders.list',
      'browse.finish',
    ]);
    expect(events(h, 'browse.finish')).toEqual([
      expect.objectContaining({ folders: 2, mails: 4, marked: 2, reconnects: 1 }),
    ]);
    const all = `${JSON.stringify(h.log.records)}\n${h.log.lines.join('\n')}`.toLowerCase();
    const errorText = accountErrorText(loginError, canary);
    for (const needle of [
      'canary',
      'example-test-domain',
      FOLDER,
      SUBJECT,
      SENDER,
      HOST,
      USERNAME,
      SECRET,
      'sender',
      'plain',
      errorText.slice(0, 24),
      RECONNECT_FAILED_TEXT.slice(0, 16),
    ]) {
      expect(all).not.toContain(needle.toLowerCase());
    }
  });
});
