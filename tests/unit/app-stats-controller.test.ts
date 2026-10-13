import { afterEach, describe, it, expect, vi } from 'vitest';
import { accountErrorText } from '../../src/cli/account-text.js';
import { STATS_UNEXPECTED_TEXT, createApp } from '../../src/cli/app/controller.js';
import type { App, AppDeps, AppResult, MailboxSession } from '../../src/cli/app/controller.js';
import { STATS_GMAIL_HIDDEN, asciiText } from '../../src/cli/app/state.js';
import { CHALLENGE_NOTICE, RECONNECT_FAILED_TEXT } from '../../src/cli/browser/controller.js';
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
import { MailboxError } from '../../src/core/mailbox/errors.js';
import type { FolderInfo, FolderTree, SizeProgress } from '../../src/core/mailbox/folders.js';
import type { PageResult, loadPage } from '../../src/core/mailbox/messages.js';
import type { MailboxStats, RankedRow } from '../../src/core/mailbox/stats.js';
import { MemoryRememberedUsers } from '../../src/core/remembered-users.js';
import { LoginBlockedError } from '../../src/core/security/login-guard.js';

// M2d-3 app controller, the stats of a mailbox: the second login once the folders are there,
// the read on a session of its own, what it reports on the screens, `stats.finish`, and that
// session logged out on every way out - also when it only arrives afterwards. With a fake
// Terminal, fake sessions (a logout spy each), fake logins and reads the tests answer
// themselves, and a MemoryEventLog; a few cases run the real login guard. No Supabase, no
// IMAP, no real terminal. Addresses and hosts are placeholders.

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
const T0 = Date.UTC(2026, 9, 8, 9, 0, 0);
const HOME_ROW = '+ Add a mailbox';
const SUMMARY = 'Scanned 2 folders, 345 messages, 663.0 KB (approx.)';
/** Reads the saved passwords below: the real login decrypts them. */
const CREDENTIALS = new LocalCredentialProvider({
  masterKey: Buffer.alloc(32, 7),
  masterKeyVersion: 1,
});

const k = (name: string, extra: Keypress = {}): Keypress => ({ name, sequence: name, ...extra });
const ENTER = k('return', { sequence: '\r' });
const DOWN = k('down', { sequence: '\u001b[B' });
const ESC = k('escape', { meta: true, sequence: '\u001b' });
const CTRL_C = k('c', { ctrl: true, sequence: '\u0003' });
const ch = (text: string): Keypress =>
  text === ' ' ? { name: 'space', sequence: ' ' } : { name: text.toLowerCase(), sequence: text };

/** A saved mailbox; its secret is readable for the server and username it names. */
function account(id: string, email: string, over: Partial<MailAccount> = {}): MailAccount {
  const host = over.host ?? HOST;
  const username = over.username ?? email;
  return {
    id,
    userId: ANNA.userId,
    label: null,
    email,
    provider: 'websupport',
    host,
    port: 993,
    username,
    authType: 'password',
    secret: CREDENTIALS.encryptPassword(
      { userId: ANNA.userId, accountId: id, host, port: 993, username },
      'pw-1',
    ),
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
    ...over,
  };
}

function treeOf(folders: FolderInfo[], over: Partial<FolderTree> = {}): FolderTree {
  return {
    folders,
    totals: { messages: 4, unseen: 0, bytes: 2000, sizeSource: 'server' },
    quota: null,
    truncated: false,
    unreadable: 0,
    gmailAllHidden: false,
    fallbacks: new Set(),
    ...over,
  };
}

const TREE = treeOf([folder('INBOX'), folder('Sent')]);
const GMAIL_HIDDEN = treeOf([folder('INBOX')], { totals: null, gmailAllHidden: true });

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

const NO_OTHERS = { messages: 0, bytes: 0 };

function statsOf(over: Partial<MailboxStats> = {}): MailboxStats {
  const sender: RankedRow = { key: 'big@example-test-domain.eu', messages: 300, bytes: 600_000 };
  const domain: RankedRow = { key: 'example-test-domain.eu', messages: 345, bytes: 678_901 };
  return {
    folders: [
      { path: 'INBOX', messages: 300, bytes: 600_000, partial: false },
      { path: 'Sent', messages: 45, bytes: 78_901, partial: false },
    ],
    notScanned: 0,
    totals: { messages: 345, bytes: 678_901 },
    years: [
      { year: '2023', messages: 100, bytes: 200_000 },
      { year: '2024', messages: 245, bytes: 478_901 },
    ],
    senders: { byCount: [sender], bySize: [sender], others: NO_OTHERS },
    domains: { byCount: [domain], bySize: [domain], others: NO_OTHERS },
    largest: [
      {
        folder: 'INBOX',
        // Noon in UTC on the last day of 2024: the first of January far enough east.
        received: new Date(Date.UTC(2024, 11, 31, 12)),
        from: 'Big Sender',
        subject: 'Quarterly report',
        bytes: 50_000,
      },
    ],
    approximate: false,
    unreadable: 0,
    partial: 0,
    ...over,
  };
}

const STATS = statsOf();
const PROGRESS: SizeProgress = { folder: 3, folders: 12, done: 5000, total: 12_345 };
const PROGRESS_TEXT = 'Stats: reading folder 3/12 - 5000/12345 messages';

// --- fakes ----------------------------------------------------------------------------------

interface FakeTerminal extends Terminal {
  readonly frames: Rendered[];
  screen: Screen;
  failDraw: Error | null;
  /** The spy behind `clear`. */
  readonly cleared: ReturnType<typeof vi.fn<() => void>>;
  key(key: Keypress): void;
  resize(): void;
}

function fakeTerminal(): FakeTerminal {
  let keyHandler: ((key: Keypress) => void) | null = null;
  let resizeHandler: (() => void) | null = null;
  const cleared = vi.fn<() => void>();
  const t: FakeTerminal = {
    frames: [],
    screen: SCREEN,
    failDraw: null,
    cleared,
    size: () => t.screen,
    draw: (frame) => {
      if (t.failDraw !== null) throw t.failDraw;
      t.frames.push(frame);
    },
    clear: cleared,
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
  /** Run when the session is logged out: a read on it ends with that, as a real one does. */
  onLogout: (() => void)[];
};
type ListFolders = NonNullable<AppDeps['listFolders']>;
type CollectStats = NonNullable<AppDeps['collectStats']>;
/** What the mail server answers to one login of the mailbox `email`. */
type Answer = (email: string) => Promise<FakeSession>;
/** What a stats read on `session` comes to. */
type Read = (session: FakeSession) => Promise<MailboxStats>;

interface Harness {
  t: FakeTerminal;
  app: App;
  done: Promise<AppResult>;
  log: MemoryEventLog;
  /** In order: `find`, `login`, `list:<name>`, `stats:<name>`, `load:<name>:<path>`, `logout:<name>`. */
  calls: string[];
  /** A session of its own name, with a logout spy. */
  session(name: string): FakeSession;
  /** The next login that reaches the mail server gets this answer, once. */
  nextLogin(answer: Answer): void;
  /** Every other login: a new session at once (s1, s2, ...). */
  answer: Answer;
  /** The next stats read gets this answer, once. */
  nextRead(read: Read): void;
  /** Every other read: STATS at once. */
  read: Read;
  /** Every stats read that was asked for: where, over which folders, with what. */
  reads: { session: FakeSession; tree: FolderTree; options: Parameters<CollectStats>[2] }[];
  findAccount: ReturnType<typeof vi.fn<AppDeps['findAccount']>>;
  /** `deps.openSession`: the mail server itself, or the real guarded login around it. */
  openSession: ReturnType<typeof vi.fn<AppDeps['openSession']>>;
  /** The mail server: one call per login that was really made, with the mailbox's address. */
  server: ReturnType<typeof vi.fn<Answer>>;
  collect: ReturnType<typeof vi.fn<CollectStats>>;
  listFolders: ReturnType<typeof vi.fn<ListFolders>>;
  load: ReturnType<typeof vi.fn<typeof loadPage>>;
  onUnexpected: ReturnType<typeof vi.fn<(err: unknown) => void>>;
}

interface Options {
  /** Left out: as the app, the stats are read as soon as the folders are there. */
  autoStats?: boolean;
  tree?: FolderTree;
  mailboxes?: MailAccount[];
  timeZone?: string;
  /** As `mm app`: one real login guard for the run, openAccountSession, the fake server below it. */
  guarded?: boolean;
  /** Leaves `collectStats` out of the deps: the core's is used. */
  coreStats?: boolean;
}

function makeHarness(o: Options = {}): Harness {
  const t = fakeTerminal();
  const calls: string[] = [];
  const answers: Answer[] = [];
  const readAnswers: Read[] = [];
  const mailboxes = o.mailboxes ?? [BOX, BOX_2];
  let made = 0;
  const session = (name: string): FakeSession => {
    const onLogout: (() => void)[] = [];
    return {
      name,
      client: {},
      features: {},
      closed: false,
      onLogout,
      logout: vi.fn<() => Promise<void>>(() => {
        calls.push(`logout:${name}`);
        for (const ended of onLogout.splice(0)) ended();
        return Promise.resolve();
      }),
    } as unknown as FakeSession;
  };
  const nameOf = (s: unknown): string => (s as FakeSession).name;
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
    calls.push('find');
    const found = mailboxes.find((m) => m.id === id);
    return found === undefined
      ? Promise.reject(new AccountError('not-found'))
      : Promise.resolve(found);
  });
  const listFolders = vi.fn<ListFolders>((s) => {
    calls.push(`list:${nameOf(s)}`);
    return Promise.resolve(o.tree ?? TREE);
  });
  const load = vi.fn<typeof loadPage>((s, path) => {
    calls.push(`load:${nameOf(s)}:${path}`);
    return Promise.resolve(pageOf(path));
  });
  const collect = vi.fn<CollectStats>((s, tree, options) => {
    const on = s as FakeSession;
    calls.push(`stats:${on.name}`);
    h.reads.push({ session: on, tree, options });
    return (readAnswers.shift() ?? h.read)(on);
  });
  const onUnexpected = vi.fn<(err: unknown) => void>();
  const app = createApp({
    terminal: t,
    version: '0.9.0',
    auth: {
      currentUser: () => Promise.resolve(ANNA),
      login: () => Promise.resolve(ANNA),
      logout: (): Promise<LogoutResult> => Promise.resolve('logged-out'),
    },
    listMailboxes: () => Promise.resolve(mailboxes),
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
    timeZone: o.timeZone ?? 'UTC',
    ...(o.coreStats !== true && { collectStats: collect }),
    ...(o.autoStats !== undefined && { autoStats: o.autoStats }),
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
    nextRead: (read) => {
      readAnswers.push(read);
    },
    read: () => Promise.resolve(STATS),
    reads: [],
    findAccount,
    openSession,
    server,
    collect,
    listFolders,
    load,
    onUnexpected,
  };
  return h;
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

const count = (h: Harness, name: string): number => events(h, name).length;
const names = (h: Harness): string[] => h.log.records.map((r) => r.event);
const logouts = (h: Harness, name: string): number =>
  h.calls.filter((c) => c === `logout:${name}`).length;
const loggedOut = (h: Harness): string[] => h.calls.filter((c) => c.startsWith('logout:'));

/** What the read number `i` reports with: the callback the controller gave it. */
function report(h: Harness, progress: SizeProgress = PROGRESS, i = 0): void {
  const read = h.reads[i];
  if (read === undefined) throw new Error(`no stats read ${String(i)}`);
  read.options.onProgress(progress);
}

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

/** Enter on the first mailbox: its bars (s1); unless told otherwise the stats were read on s2. */
async function atBars(o: Options = {}): Promise<Harness> {
  const h = await atHome(o);
  await press(h, ENTER);
  await shown(h, 'Total:');
  return h;
}

/** A read the test answers itself; logging its session out ends it, as a real one. */
function slowRead(h: Harness): Deferred<MailboxStats> {
  const read = deferred<MailboxStats>();
  h.nextRead((session) => {
    session.onLogout.push(() => {
      read.reject(new MailboxError('connection-lost'));
    });
    return read.promise;
  });
  return read;
}

/** The bars with the stats login under way: the test answers it. */
async function statsLoggingIn(
  o: Options = {},
): Promise<{ h: Harness; login: Deferred<FakeSession> }> {
  const h = await atHome(o);
  const login = deferred<FakeSession>();
  // The mailbox's own login as ever, then the one of the stats.
  h.nextLogin((email) => h.answer(email));
  h.nextLogin(() => login.promise);
  await press(h, ENTER);
  await shown(h, 'Stats: reading...');
  expect(h.server).toHaveBeenCalledTimes(2);
  return { h, login };
}

/** The bars with the stats read under way on s2: the test answers it. */
async function statsReading(
  o: Options = {},
): Promise<{ h: Harness; read: Deferred<MailboxStats> }> {
  const h = await atHome(o);
  const read = slowRead(h);
  await press(h, ENTER);
  await shown(h, 'Stats: reading...');
  expect(h.collect).toHaveBeenCalledTimes(1);
  return { h, read };
}

/** INBOX open with a connection that is gone: "reconnect? (y/N)". */
async function lost(h: Harness): Promise<void> {
  h.load.mockImplementationOnce((s, path) => {
    h.calls.push(`load:${(s as FakeSession).name}:${path}`);
    return Promise.reject(new MailboxError('connection-lost'));
  });
  await press(h, ENTER);
  expect(last(h)).toContain('Connection closed - reconnect? (y/N)');
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

// --- the read starts ------------------------------------------------------------------------

describe('the folders arrive: the stats are read on a login of their own', () => {
  it('Enter on a mailbox: its login and folders, then one more login and the read on that session', async () => {
    const h = await atBars();
    await shown(h, 'Stats ready - press s');
    // The stats session is logged out as its read ends; the mailbox's own stays.
    expect(h.calls).toEqual(['find', 'login', 'list:s1', 'login', 'stats:s2', 'logout:s2']);
    expect(h.openSession.mock.calls.map(([mailbox]) => mailbox)).toEqual([BOX, BOX]);
    expect(h.findAccount).toHaveBeenCalledTimes(1);
    const read = h.reads[0];
    expect(read?.session.name).toBe('s2');
    expect(read?.tree).toBe(TREE);
    expect(Object.keys(read?.options ?? {}).sort()).toEqual(['onProgress', 'timeZone']);
    expect(read?.options.timeZone).toBe('UTC');
    await quit(h);
    expect(loggedOut(h)).toEqual(['logout:s2', 'logout:s1']);
  });

  it('the second login is asked for only once the folders are there', async () => {
    const h = await atHome();
    const folders = deferred<FolderTree>();
    h.listFolders.mockImplementationOnce((s) => {
      h.calls.push(`list:${(s as FakeSession).name}`);
      return folders.promise;
    });
    await press(h, ENTER);
    await shown(h, 'Reading folders...');
    await settle();
    expect(h.server).toHaveBeenCalledTimes(1);
    expect(h.collect).not.toHaveBeenCalled();
    folders.resolve(TREE);
    await shown(h, 'Stats ready - press s');
    expect(h.server).toHaveBeenCalledTimes(2);
    await quit(h);
  });

  it('a mailbox whose login or folder read fails gets no stats login', async () => {
    const h = await atHome();
    h.nextLogin(() => Promise.reject(new ImapSessionError('auth-failed')));
    await press(h, ENTER);
    await shown(h, 'r try again');
    await press(h, ESC);
    h.listFolders.mockRejectedValueOnce(new MailboxError('list-failed'));
    await press(h, ENTER);
    await shown(h, 'r try again');
    await settle();
    expect(h.server).toHaveBeenCalledTimes(2);
    expect(h.collect).not.toHaveBeenCalled();
    expect(count(h, 'stats.finish')).toBe(0);
    await quit(h);
  });

  it('with autoStats off nothing is read until s: then one login, and the stats screen', async () => {
    const h = await atBars({ autoStats: false });
    expect(last(h)).toContain('Stats: press s to read');
    await settle();
    expect(h.server).toHaveBeenCalledTimes(1);
    expect(h.collect).not.toHaveBeenCalled();

    await press(h, ch('s'));
    await shown(h, SUMMARY);
    expect(last(h)).toContain('Years - by size');
    expect(h.calls).toEqual(['find', 'login', 'list:s1', 'login', 'stats:s2', 'logout:s2']);
    // Esc and s again: the stats are kept, nothing is read a second time.
    await press(h, ESC);
    expect(last(h)).toContain('Stats ready - press s');
    await press(h, ch('s'));
    expect(last(h)).toContain(SUMMARY);
    expect(h.server).toHaveBeenCalledTimes(2);
    await quit(h);
  });

  it('without a collectStats dep the core reads them: nothing to read is an empty result at once', async () => {
    const tree = treeOf([folder('Archive', { selectable: false, messages: null, bytes: null })]);
    const h = await atBars({ coreStats: true, tree });
    await shown(h, 'Stats ready - press s');
    await press(h, ch('s'));
    expect(last(h)).toContain('Scanned 0 folders, 0 messages, 0 B (approx.)');
    expect(last(h)).toContain('(none)');
    expect(h.collect).not.toHaveBeenCalled();
    expect(events(h, 'stats.finish')).toEqual([
      expect.objectContaining({ acct: BOX_ID, folders: 0, messages: 0, bytes: 0, outcome: 'ok' }),
    ]);
    await quit(h);
    expect(loggedOut(h)).toEqual(['logout:s2', 'logout:s1']);
  });

  it('Gmail with All Mail hidden: no login and no read - not on the bars, not for s, not for r', async () => {
    const h = await atHome({ tree: GMAIL_HIDDEN });
    await press(h, ENTER);
    await shown(h, 'Totals unknown');
    expect(last(h)).toContain("Stats couldn't be read - press s");
    await press(h, ch('s'));
    expect(flat(last(h))).toContain(STATS_GMAIL_HIDDEN);
    expect(last(h)).toContain('r try again');
    await press(h, ch('r'), ch('r'));
    expect(flat(last(h))).toContain(STATS_GMAIL_HIDDEN);
    await settle();
    expect(h.server).toHaveBeenCalledTimes(1);
    expect(h.collect).not.toHaveBeenCalled();
    await quit(h);
    expect(names(h)).toEqual(['folders.list']);
    expect(loggedOut(h)).toEqual(['logout:s1']);
  });

  it('the time zone of the app goes to the read and decides the day a mail is shown under', async () => {
    const east = await atBars({ timeZone: 'Pacific/Kiritimati' });
    await shown(east, 'Stats ready - press s');
    expect(east.reads[0]?.options.timeZone).toBe('Pacific/Kiritimati');
    await press(east, ch('s'), ch('4'));
    expect(last(east)).toContain('2025-01-01  Big Sender - Quarterly report (INBOX)');
    await quit(east);

    const utc = await atBars();
    await shown(utc, 'Stats ready - press s');
    await press(utc, ch('s'), ch('4'));
    expect(last(utc)).toContain('2024-12-31  Big Sender - Quarterly report (INBOX)');
    await quit(utc);
  });
});

// --- what the screens show ------------------------------------------------------------------

describe('what the read reports reaches the screens', () => {
  it('the bars count along, then say the stats are ready; s shows them', async () => {
    const { h, read } = await statsReading();
    expect(last(h)).toContain('Stats: reading...');
    report(h);
    expect(last(h)).toContain(PROGRESS_TEXT);
    report(h, { folder: 12, folders: 12, done: 7, total: 7 });
    expect(last(h)).toContain('Stats: reading folder 12/12 - 7/7 messages');
    read.resolve(STATS);
    await shown(h, 'Stats ready - press s');
    await press(h, ch('s'));
    expect(last(h)).toContain(SUMMARY);
    expect(last(h)).toContain('2024');
    await press(h, ch('2'));
    expect(last(h)).toContain('big@example-test-domain.eu');
    await quit(h);
  });

  it('the stats screen while the read runs: the progress, then the stats as they arrive', async () => {
    const { h, read } = await statsReading();
    await press(h, ch('s'));
    expect(last(h)).toContain('Stats: reading...');
    expect(last(h)).not.toContain('Scanned');
    report(h);
    expect(last(h)).toContain(PROGRESS_TEXT);
    read.resolve(STATS);
    await shown(h, SUMMARY);
    expect(last(h)).not.toContain('Stats: reading');
    await quit(h);
  });

  it('progress that still arrives after the result changes nothing', async () => {
    const { h, read } = await statsReading();
    read.resolve(STATS);
    await shown(h, 'Stats ready - press s');
    const frames = h.t.frames.length;
    report(h);
    await settle();
    expect(last(h)).toContain('Stats ready - press s');
    expect(h.t.frames.length).toBe(frames);
    await quit(h);
  });
});

// --- kept while open ------------------------------------------------------------------------

describe('the stats stay while the mailbox is open, and go with it', () => {
  it('folders opened and left, marks, and a reconnect of the browser leave them alone', async () => {
    const h = await atBars();
    await shown(h, 'Stats ready - press s');
    await press(h, ENTER);
    await shown(h, 'Subject 2');
    await press(h, ch('a'), ESC);
    expect(last(h)).toContain('Stats ready - press s');
    // The connection of the mailbox's own session drops: a reconnect, the stats untouched.
    await lost(h);
    await press(h, ch('y'));
    await shown(h, 'Subject 2');
    await press(h, ESC);
    expect(last(h)).toContain('Stats ready - press s');
    await press(h, ch('s'));
    expect(last(h)).toContain(SUMMARY);
    // One read in all that: the mailbox, its stats, the reconnect.
    expect(h.server).toHaveBeenCalledTimes(3);
    expect(h.collect).toHaveBeenCalledTimes(1);
    expect(count(h, 'stats.finish')).toBe(1);
    await quit(h);
    expect(loggedOut(h)).toEqual(['logout:s2', 'logout:s1', 'logout:s3']);
  });

  it('the read goes on behind a folder; its result is there when the bars are back', async () => {
    const { h, read } = await statsReading();
    await press(h, ENTER);
    await shown(h, 'Subject 2');
    expect(h.calls.at(-1)).toBe('load:s1:INBOX');
    read.resolve(STATS);
    await vi.waitFor(() => {
      expect(logouts(h, 's2')).toBe(1);
    });
    expect(last(h)).toContain('Subject 2');
    await press(h, ESC);
    expect(last(h)).toContain('Stats ready - press s');
    expect(logouts(h, 's1')).toBe(0);
    await quit(h);
  });

  it('what a read still reports after its mailbox was left changes nothing', async () => {
    const h = await atHome();
    const late = deferred<MailboxStats>();
    // A read that outlives the logout of its session.
    h.nextRead(() => late.promise);
    await press(h, ENTER);
    await shown(h, 'Stats: reading...');
    await press(h, ESC);
    expect(last(h)).toContain(HOME_ROW);
    expect(logouts(h, 's2')).toBe(1);
    const frames = h.t.frames.length;
    report(h);
    late.resolve(STATS);
    await settle();
    await settle();
    expect(h.t.frames.length).toBe(frames);
    expect(last(h)).toContain(HOME_ROW);
    expect(count(h, 'stats.finish')).toBe(0);
    expect(logouts(h, 's2')).toBe(1);
    await quit(h);
  });

  it('the next visit starts over: a new login and a new read', async () => {
    const h = await atBars();
    await shown(h, 'Stats ready - press s');
    await press(h, ESC);
    expect(last(h)).toContain(HOME_ROW);
    const read = slowRead(h);
    await press(h, ENTER);
    await shown(h, 'Stats: reading...');
    expect(last(h)).not.toContain('Stats ready');
    expect(h.server).toHaveBeenCalledTimes(4);
    // The stats of the visit before are not shown while the new read runs.
    await press(h, ch('s'));
    expect(last(h)).not.toContain('Scanned');
    read.resolve(statsOf({ totals: { messages: 1, bytes: 512 } }));
    await shown(h, 'Scanned 2 folders, 1 message, 512 B (approx.)');
    await quit(h);
    expect(loggedOut(h)).toEqual(['logout:s2', 'logout:s1', 'logout:s4', 'logout:s3']);
  });

  it('a result of the first mailbox never shows in the second', async () => {
    const h = await atHome();
    const first = deferred<MailboxStats>();
    h.nextRead(() => first.promise);
    await press(h, ENTER);
    await shown(h, 'Stats: reading...');
    const second = slowRead(h);
    await press(h, ESC, DOWN, ENTER);
    await shown(h, `Mail Manager - ${BOX_2_EMAIL}`);
    await shown(h, 'Stats: reading...');
    first.resolve(statsOf({ totals: { messages: 9, bytes: 9 } }));
    report(h, PROGRESS, 0);
    await settle();
    await settle();
    expect(last(h)).toContain('Stats: reading...');
    expect(last(h)).not.toContain(PROGRESS_TEXT);
    second.resolve(STATS);
    await shown(h, 'Stats ready - press s');
    expect(events(h, 'stats.finish')).toEqual([expect.objectContaining({ acct: BOX_2_ID })]);
    await quit(h);
  });
});

// --- the stats session ----------------------------------------------------------------------

describe('the stats session is logged out exactly once, on every way out', () => {
  it('when its read ends - not again when the mailbox is left or the app ends', async () => {
    const h = await atBars();
    await shown(h, 'Stats ready - press s');
    expect(loggedOut(h)).toEqual(['logout:s2']);
    await press(h, ESC);
    expect(loggedOut(h)).toEqual(['logout:s2', 'logout:s1']);
    await quit(h);
    expect(loggedOut(h)).toEqual(['logout:s2', 'logout:s1']);
  });

  it('when its read fails', async () => {
    const { h, read } = await statsReading();
    read.reject(new MailboxError('connection-lost'));
    await shown(h, "Stats couldn't be read - press s");
    expect(loggedOut(h)).toEqual(['logout:s2']);
    await quit(h);
    expect(loggedOut(h)).toEqual(['logout:s2', 'logout:s1']);
  });

  it('the mailbox left during the stats login: the session that arrives is logged out at once, nothing is read', async () => {
    const { h, login } = await statsLoggingIn();
    await press(h, ESC);
    expect(last(h)).toContain(HOME_ROW);
    expect(loggedOut(h)).toEqual(['logout:s1']);
    login.resolve(h.session('late'));
    await vi.waitFor(() => {
      expect(logouts(h, 'late')).toBe(1);
    });
    await settle();
    expect(h.collect).not.toHaveBeenCalled();
    expect(names(h)).toEqual(['folders.list']);
    expect(last(h)).toContain(HOME_ROW);
    await quit(h);
    expect(loggedOut(h)).toEqual(['logout:s1', 'logout:late']);
  });

  it("the mailbox left during the stats login, which then fails: nobody's failure", async () => {
    for (const err of [new ImapSessionError('timeout'), new TypeError('boom')]) {
      const { h, login } = await statsLoggingIn();
      await press(h, ESC);
      login.reject(err);
      await settle();
      await settle();
      expect(last(h)).toContain(HOME_ROW);
      expect(names(h)).toEqual(['folders.list']);
      expect(h.onUnexpected).not.toHaveBeenCalled();
      expect(await stillRunning(h.done)).toBe(true);
      await quit(h);
    }
  });

  it('the mailbox left during the read: both sessions logged out by leaving, the read is dropped', async () => {
    const { h } = await statsReading();
    await press(h, ESC);
    expect(last(h)).toContain(HOME_ROW);
    expect(loggedOut(h).sort()).toEqual(['logout:s1', 'logout:s2']);
    await settle();
    await settle();
    // The read failed because its session was closed: not shown, not logged, not reported.
    expect(names(h)).toEqual(['folders.list']);
    expect(h.onUnexpected).not.toHaveBeenCalled();
    expect(last(h)).toContain(HOME_ROW);
    await quit(h);
    expect(loggedOut(h)).toHaveLength(2);
  });

  it.each([
    ['q', ch('q'), 'quit'],
    ['Ctrl+C', CTRL_C, 'interrupt'],
  ] as const)(
    '%s during the stats login: settled() waits for the session and logs it out',
    async (_n, key, end) => {
      const { h, login } = await statsLoggingIn();
      h.t.key(key);
      await expect(h.done).resolves.toStrictEqual({ end });
      const settled = h.app.settled();
      expect(await stillRunning(settled)).toBe(true);
      login.resolve(h.session('late'));
      await settled;
      expect(loggedOut(h)).toEqual(['logout:s1', 'logout:late']);
      expect(h.collect).not.toHaveBeenCalled();
      expect(names(h)).toEqual(['folders.list']);
    },
  );

  it.each([
    ['q', ch('q'), 'quit'],
    ['Ctrl+C', CTRL_C, 'interrupt'],
  ] as const)(
    '%s during the read: both sessions logged out by the time settled() is',
    async (_n, key, end) => {
      const { h } = await statsReading();
      h.t.key(key);
      await expect(h.done).resolves.toStrictEqual({ end });
      await h.app.settled();
      expect(loggedOut(h).sort()).toEqual(['logout:s1', 'logout:s2']);
      expect(names(h)).toEqual(['folders.list']);
      // Keys after the end do nothing.
      h.t.key(ch('s'));
      h.t.key(CTRL_C);
      await settle();
      expect(loggedOut(h)).toHaveLength(2);
    },
  );

  it('q on the stats screen while the read runs: the same', async () => {
    const { h } = await statsReading();
    await press(h, ch('s'));
    h.t.key(ch('q'));
    await expect(h.done).resolves.toStrictEqual({ end: 'quit' });
    await h.app.settled();
    expect(loggedOut(h).sort()).toEqual(['logout:s1', 'logout:s2']);
    expect(names(h)).toEqual(['folders.list']);
  });

  it('a stats login that never answers is given up after 5 seconds', async () => {
    const { h } = await statsLoggingIn();
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
    expect(loggedOut(h)).toEqual(['logout:s1']);
  });

  it('the screen fails while the stats are read: the app ends, both sessions are logged out once', async () => {
    const { h } = await statsReading();
    h.t.failDraw = new Error('terminal gone');
    h.t.key(DOWN);
    await expect(h.done).rejects.toThrow('terminal gone');
    await h.app.settled();
    expect(loggedOut(h).sort()).toEqual(['logout:s1', 'logout:s2']);
    expect(names(h)).toEqual(['folders.list']);
  });

  it('the screen fails as a result is drawn: the same, and the result is logged once', async () => {
    const { h, read } = await statsReading();
    h.t.failDraw = new Error('terminal gone');
    const crashed = expect(h.done).rejects.toThrow('terminal gone');
    read.resolve(STATS);
    await crashed;
    await h.app.settled();
    expect(loggedOut(h).sort()).toEqual(['logout:s1', 'logout:s2']);
    expect(names(h)).toEqual(['folders.list', 'stats.finish']);
  });

  it("pages are read on the mailbox's own session while the stats are read on theirs", async () => {
    const { h, read } = await statsReading();
    await press(h, ENTER);
    await shown(h, 'Subject 2');
    await press(h, ESC, DOWN, ENTER);
    await shown(h, `${BOX_EMAIL} / Sent`);
    expect(h.calls.filter((c) => c.startsWith('load:'))).toEqual(['load:s1:INBOX', 'load:s1:Sent']);
    expect(h.load.mock.calls.every(([s]) => (s as FakeSession).name === 's1')).toBe(true);
    expect(loggedOut(h)).toEqual([]);
    read.resolve(STATS);
    await vi.waitFor(() => {
      expect(logouts(h, 's2')).toBe(1);
    });
    await quit(h);
    expect(loggedOut(h)).toEqual(['logout:s2', 'logout:s1']);
  });

  it('a reconnect of the browser during the read: the read goes on, every session is logged out once', async () => {
    const { h, read } = await statsReading();
    await lost(h);
    await press(h, ch('y'));
    await shown(h, 'Subject 2');
    // The old session of the mailbox went, a new one came; the stats session is untouched.
    expect(loggedOut(h)).toEqual(['logout:s1']);
    expect(h.calls.at(-1)).toBe('load:s3:INBOX');
    report(h);
    read.resolve(STATS);
    await vi.waitFor(() => {
      expect(logouts(h, 's2')).toBe(1);
    });
    await press(h, ESC);
    expect(last(h)).toContain('Stats ready - press s');
    await quit(h);
    expect(loggedOut(h)).toEqual(['logout:s1', 'logout:s2', 'logout:s3']);
  });

  it('a logout of the stats session that fails or throws disturbs nothing', async () => {
    const h = await atHome();
    h.nextLogin((email) => h.answer(email));
    h.nextLogin(() => {
      const broken = h.session('broken');
      broken.logout.mockImplementation(() => Promise.reject(new Error('socket gone')));
      return Promise.resolve(broken);
    });
    await press(h, ENTER);
    await shown(h, 'Stats ready - press s');
    expect(await stillRunning(h.done)).toBe(true);
    await press(h, ch('s'));
    h.nextLogin(() => {
      const broken = h.session('thrower');
      broken.logout.mockImplementation(() => {
        throw new Error('socket gone');
      });
      return Promise.resolve(broken);
    });
    await press(h, ch('r'));
    await shown(h, SUMMARY);
    expect(count(h, 'stats.finish')).toBe(2);
    h.t.key(ch('q'));
    await expect(h.done).resolves.toStrictEqual({ end: 'quit' });
    await h.app.settled();
    expect(h.onUnexpected).not.toHaveBeenCalled();
  });
});

// --- failures -------------------------------------------------------------------------------

describe('a stats login or read that fails', () => {
  it('a login that fails: the bars say so, s shows its text in ASCII, nothing is tried again by itself', async () => {
    const h = await atHome();
    const err = new ImapSessionError('timeout');
    h.nextLogin((email) => h.answer(email));
    h.nextLogin(() => Promise.reject(err));
    await press(h, ENTER);
    await shown(h, "Stats couldn't be read - press s");
    await settle();
    await settle();
    expect(h.server).toHaveBeenCalledTimes(2);
    expect(h.collect).not.toHaveBeenCalled();
    expect(h.onUnexpected).not.toHaveBeenCalled();

    await press(h, ch('s'));
    expect(flat(last(h))).toContain(flat(asciiText(accountErrorText(err, BOX))));
    expect(last(h)).toContain('r try again');
    for (const line of h.t.frames.at(-1)?.lines ?? []) expect(line).toMatch(/^[\x20-\x7e]*$/);
    expect(await stillRunning(h.done)).toBe(true);
    // The mailbox itself works on: a folder opens on its own session.
    await press(h, ESC, ENTER);
    await shown(h, 'Subject 2');
    await quit(h);
    expect(loggedOut(h)).toEqual(['logout:s1']);
  });

  it('a read that fails: its text, the session logged out once', async () => {
    const { h, read } = await statsReading();
    const err = new MailboxError('connection-lost');
    read.reject(err);
    await shown(h, "Stats couldn't be read - press s");
    await press(h, ch('s'));
    expect(flat(last(h))).toContain(flat(asciiText(accountErrorText(err, BOX))));
    expect(loggedOut(h)).toEqual(['logout:s2']);
    expect(h.onUnexpected).not.toHaveBeenCalled();
    await quit(h);
  });

  it('a login blocked by the guard: its text with the time', async () => {
    const h = await atHome();
    const err = new LoginBlockedError('too-many-attempts', new Date(Date.UTC(2099, 0, 1, 12)));
    h.nextLogin((email) => h.answer(email));
    h.nextLogin(() => Promise.reject(err));
    await press(h, ENTER);
    await shown(h, "Stats couldn't be read - press s");
    await press(h, ch('s'));
    expect(flat(last(h))).toContain(flat(asciiText(accountErrorText(err, BOX))));
    expect(events(h, 'stats.finish')).toEqual([
      expect.objectContaining({ outcome: 'failed', reason: 'blocked' }),
    ]);
    await quit(h);
  });

  it('a saved password that cannot be read: the text names this mailbox by its id', async () => {
    const h = await atHome();
    h.nextLogin((email) => h.answer(email));
    h.nextLogin(() => Promise.reject(new AccountError('secret-unreadable')));
    await press(h, ENTER);
    await shown(h, "Stats couldn't be read - press s");
    await press(h, ch('s'));
    expect(flat(last(h))).toContain('`mm account remove aaaaaaaa`');
    expect(last(h)).not.toContain('<id>');
    await quit(h);
  });

  it('a stats login that works does not settle a reconnect that failed: that is still told at the end', async () => {
    const h = await atBars();
    await shown(h, 'Stats ready - press s');
    await lost(h);
    const err = new ImapSessionError('timeout');
    h.nextLogin(() => Promise.reject(err));
    await press(h, ch('y'));
    await shown(h, RECONNECT_FAILED_TEXT);
    // Back on the bars, a new stats read: its login works.
    await press(h, ESC, ch('s'), ch('r'));
    await shown(h, SUMMARY);
    expect(h.server).toHaveBeenCalledTimes(4);
    expect(count(h, 'stats.finish')).toBe(2);
    h.t.key(ch('q'));
    await expect(h.done).resolves.toStrictEqual({
      end: 'quit',
      reconnectError: err,
      reconnectAccount: BOX,
    });
    await h.app.settled();
  });

  it.each([
    ['the login', false],
    ['the read', true],
  ])(
    'an error of %s that is not ours: reported once, a plain text on the screen, the app goes on',
    async (_n, inRead) => {
      const h = await atHome();
      const err = new TypeError('cannot read properties of undefined');
      if (inRead) h.nextRead(() => Promise.reject(err));
      else {
        h.nextLogin((email) => h.answer(email));
        h.nextLogin(() => Promise.reject(err));
      }
      await press(h, ENTER);
      await shown(h, "Stats couldn't be read - press s");
      expect(h.onUnexpected.mock.calls).toEqual([[err]]);
      expect(await stillRunning(h.done)).toBe(true);
      await press(h, ch('s'));
      expect(last(h)).toContain(STATS_UNEXPECTED_TEXT);
      expect(last(h)).not.toContain('cannot read');
      expect(last(h)).toContain('r try again');
      expect(events(h, 'stats.finish')).toEqual([
        expect.objectContaining({ outcome: 'failed', reason: 'unexpected' }),
      ]);
      // Folders still open.
      await press(h, ESC, ENTER);
      await shown(h, 'Subject 2');
      h.t.key(ch('q'));
      await expect(h.done).resolves.toStrictEqual({ end: 'quit' });
      await h.app.settled();
      expect(logouts(h, 's1')).toBe(1);
      expect(logouts(h, 's2')).toBe(inRead ? 1 : 0);
    },
  );

  it('a read that throws at once is a failed read too', async () => {
    const h = await atHome();
    h.nextRead(() => {
      throw new MailboxError('connection-lost');
    });
    await press(h, ENTER);
    await shown(h, "Stats couldn't be read - press s");
    expect(loggedOut(h)).toEqual(['logout:s2']);
    expect(await stillRunning(h.done)).toBe(true);
    await quit(h);
  });

  it('the shell that reports the error fails itself: the app ends with that', async () => {
    const h = await atHome();
    h.onUnexpected.mockImplementation(() => {
      throw new Error('log folder gone');
    });
    h.nextRead(() => Promise.reject(new TypeError('boom')));
    h.t.key(ENTER);
    await expect(h.done).rejects.toThrow('log folder gone');
    await h.app.settled();
    expect(loggedOut(h).sort()).toEqual(['logout:s1', 'logout:s2']);
  });
});

// --- r --------------------------------------------------------------------------------------

describe('r on the stats screen', () => {
  it('after the stats arrived: one new login and read, the old stats gone until it ends', async () => {
    const h = await atBars();
    await shown(h, 'Stats ready - press s');
    await press(h, ch('s'));
    const read = slowRead(h);
    await press(h, ch('r'));
    expect(last(h)).toContain('Stats: reading...');
    expect(last(h)).not.toContain('Scanned');
    expect(h.server).toHaveBeenCalledTimes(3);
    expect(h.collect).toHaveBeenCalledTimes(2);
    expect(h.reads[1]?.session.name).toBe('s3');
    // While it runs r does nothing more.
    await press(h, ch('r'), ch('R'));
    expect(h.server).toHaveBeenCalledTimes(3);
    read.resolve(statsOf({ totals: { messages: 7, bytes: 7000 } }));
    await shown(h, 'Scanned 2 folders, 7 messages, 6.8 KB (approx.)');
    await quit(h);
    expect(loggedOut(h)).toEqual(['logout:s2', 'logout:s3', 'logout:s1']);
  });

  it('after a failure: one more attempt per key press', async () => {
    const h = await atHome();
    const wrong = (): Promise<FakeSession> => Promise.reject(new ImapSessionError('timeout'));
    h.nextLogin((email) => h.answer(email));
    h.nextLogin(wrong);
    h.nextLogin(wrong);
    await press(h, ENTER);
    await shown(h, "Stats couldn't be read - press s");
    await press(h, ch('s'), ch('r'));
    await shown(h, 'r try again');
    await settle();
    expect(h.server).toHaveBeenCalledTimes(3);
    await press(h, ch('r'));
    await shown(h, SUMMARY);
    expect(h.server).toHaveBeenCalledTimes(4);
    expect(events(h, 'stats.finish').map((r) => r['outcome'])).toEqual(['failed', 'failed', 'ok']);
    await quit(h);
  });
});

// --- the log --------------------------------------------------------------------------------

describe('stats.finish', () => {
  it('once for a read that ended: the account id, counts, a duration - nothing else', async () => {
    const h = await atBars();
    await shown(h, 'Stats ready - press s');
    expect(names(h)).toEqual(['folders.list', 'stats.finish']);
    const line = events(h, 'stats.finish')[0] ?? {};
    expect(line).toMatchObject({
      event: 'stats.finish',
      acct: BOX_ID,
      folders: 2,
      messages: 345,
      bytes: 678_901,
      outcome: 'ok',
    });
    expect(Object.keys(line).sort()).toEqual(
      [
        'acct',
        'bytes',
        'event',
        'folders',
        'level',
        'messages',
        'ms',
        'outcome',
        'run',
        'ts',
        'v',
      ].sort(),
    );
    await quit(h);
    expect(count(h, 'stats.finish')).toBe(1);
  });

  it.each<[string, () => Error, string]>([
    ['a login that timed out', () => new ImapSessionError('timeout'), 'timeout'],
    ['a wrong password', () => new ImapSessionError('auth-failed'), 'auth-failed'],
    [
      'a secret that cannot be read',
      () => new AccountError('secret-unreadable'),
      'secret-unreadable',
    ],
    ['an error that is not ours', () => new Error('boom'), 'unexpected'],
  ])('failed for %s: zeros and the reason code', async (_n, make, reason) => {
    const h = await atHome();
    h.nextLogin((email) => h.answer(email));
    h.nextLogin(() => Promise.reject(make()));
    await press(h, ENTER);
    await shown(h, "Stats couldn't be read - press s");
    const lines = events(h, 'stats.finish');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      acct: BOX_ID,
      folders: 0,
      messages: 0,
      bytes: 0,
      outcome: 'failed',
      reason,
    });
    await quit(h);
    expect(count(h, 'stats.finish')).toBe(1);
  });

  it('a failed read has the reason of the read', async () => {
    const { h, read } = await statsReading();
    read.reject(new MailboxError('connection-lost'));
    await shown(h, "Stats couldn't be read - press s");
    expect(events(h, 'stats.finish')).toEqual([
      expect.objectContaining({ outcome: 'failed', reason: 'connection-lost', folders: 0 }),
    ]);
    await quit(h);
  });

  it('one line per read that ended, none for one that was stopped', async () => {
    const h = await atBars();
    await shown(h, 'Stats ready - press s');
    await press(h, ch('s'));
    h.nextRead(() => Promise.reject(new MailboxError('connection-lost')));
    await press(h, ch('r'));
    await shown(h, 'r try again');
    slowRead(h);
    await press(h, ch('r'));
    expect(last(h)).toContain('Stats: reading...');
    // The third read is stopped by leaving the mailbox.
    await press(h, ESC, ESC);
    expect(last(h)).toContain(HOME_ROW);
    await quit(h);
    expect(events(h, 'stats.finish').map((r) => r['outcome'])).toEqual(['ok', 'failed']);
    expect(names(h)).toEqual(['folders.list', 'stats.finish', 'stats.finish']);
  });
});

describe('the log has ids, counts and reason codes only', () => {
  const RLO = String.fromCharCode(0x202e);
  const FOLDER = `CanaryFolder-48151${RLO}`;
  const SUBJECT = 'CanarySubject-62342';
  const SENDER = 'canary.sender@canary-sender.example-test-domain.eu';
  const DOMAIN = 'canary-domain.example-test-domain.eu';
  const HOST_NAME = 'imap.canary-host.example-test-domain.eu';
  const USERNAME = 'canary-user-name-77';
  const EMAIL = 'canary.box@example-test-domain.eu';

  it('a failed read, r, every section, leaving during a read, Ctrl+C - through the real guard', async () => {
    const canary = account(BOX_ID, EMAIL, { host: HOST_NAME, username: USERNAME });
    const tree = treeOf([folder(FOLDER), folder('Plain')]);
    const row = (key: string): RankedRow => ({ key, messages: 2, bytes: 2000 });
    const stats = statsOf({
      folders: [{ path: FOLDER, messages: 2, bytes: 2000, partial: false }],
      senders: { byCount: [row(SENDER)], bySize: [row(SENDER)], others: NO_OTHERS },
      domains: { byCount: [row(DOMAIN)], bySize: [row(DOMAIN)], others: NO_OTHERS },
      largest: [
        { folder: FOLDER, received: new Date(T0), from: SENDER, subject: SUBJECT, bytes: 1500 },
      ],
    });
    const h = await atHome({ mailboxes: [canary], tree, guarded: true });
    const failure = new MailboxError('connection-lost');
    h.nextRead(() => Promise.reject(failure));
    await press(h, ENTER);
    await shown(h, "Stats couldn't be read - press s");
    expect(last(h)).toContain('CanaryFolder-48151');
    await press(h, ch('s'));
    expect(last(h)).toContain('r try again');
    h.nextRead(() => Promise.resolve(stats));
    await press(h, ch('r'));
    await shown(h, 'Scanned 1 folder, 345 messages, 663.0 KB (approx.)');
    // Everything of the stats is on screen once - and stays there.
    await press(h, ch('2'));
    expect(last(h)).toContain(SENDER);
    await press(h, ch('3'));
    expect(last(h)).toContain(DOMAIN);
    await press(h, ch('4'));
    expect(last(h)).toContain(SUBJECT);
    await press(h, ESC, ESC);
    expect(last(h)).toContain(HOME_ROW);
    slowRead(h);
    await press(h, ENTER);
    await shown(h, 'Stats: reading...');
    await press(h, ESC);
    await quit(h);

    // Two visits: the mailbox's own login each time, and three stats logins.
    expect(names(h).filter((name) => !name.startsWith('imap.'))).toEqual([
      'folders.list',
      'stats.finish',
      'stats.finish',
      'folders.list',
    ]);
    expect(count(h, 'imap.login')).toBe(5);
    expect(new Set(names(h))).toEqual(new Set(['folders.list', 'stats.finish', 'imap.login']));
    const all = `${JSON.stringify(h.log.records)}\n${h.log.lines.join('\n')}`.toLowerCase();
    for (const needle of [
      'canary',
      'example-test-domain',
      FOLDER,
      SUBJECT,
      SENDER,
      DOMAIN,
      HOST_NAME,
      USERNAME,
      EMAIL,
      'plain',
      accountErrorText(failure, canary).slice(0, 24),
      STATS_UNEXPECTED_TEXT.slice(0, 16),
    ]) {
      expect(all).not.toContain(needle.toLowerCase());
    }
  });
});

// --- drawing --------------------------------------------------------------------------------

describe('a stats result is drawn only when the screen changes', () => {
  it('behind an open folder nothing is drawn: not for progress, not for the result', async () => {
    const { h, read } = await statsReading();
    await press(h, ENTER);
    await shown(h, 'Subject 2');
    const frames = h.t.frames.length;
    report(h);
    report(h, { ...PROGRESS, done: 6000 });
    report(h, { ...PROGRESS, folder: 4 });
    await settle();
    expect(h.t.frames.length).toBe(frames);
    read.resolve(STATS);
    await vi.waitFor(() => {
      expect(logouts(h, 's2')).toBe(1);
    });
    await settle();
    expect(h.t.frames.length).toBe(frames);
    // A key draws as ever, and the bars then show what arrived meanwhile.
    await press(h, ESC);
    expect(h.t.frames.length).toBe(frames + 1);
    expect(last(h)).toContain('Stats ready - press s');
    await quit(h);
  });

  it('behind a failed read of a folder the same holds for a failed stats read', async () => {
    const { h, read } = await statsReading();
    await press(h, ENTER);
    await shown(h, 'Subject 2');
    const frames = h.t.frames.length;
    read.reject(new MailboxError('connection-lost'));
    await vi.waitFor(() => {
      expect(count(h, 'stats.finish')).toBe(1);
    });
    await settle();
    expect(h.t.frames.length).toBe(frames);
    await quit(h);
  });

  it('on the bars a step that changes the line is one frame, the same step again is none', async () => {
    const { h } = await statsReading();
    const frames = h.t.frames.length;
    report(h);
    expect(h.t.frames.length).toBe(frames + 1);
    expect(last(h)).toContain(PROGRESS_TEXT);
    report(h);
    report(h, { ...PROGRESS });
    expect(h.t.frames.length).toBe(frames + 1);
    report(h, { ...PROGRESS, done: 5001 });
    expect(h.t.frames.length).toBe(frames + 2);
    await quit(h);
  });

  it('a key and a resize always draw, also when the frame is the one on screen', async () => {
    const { h } = await statsReading();
    report(h);
    const frames = h.t.frames.length;
    // A key the bars don't know: the same frame, drawn again as before this change.
    await press(h, ch('x'));
    expect(h.t.frames.length).toBe(frames + 1);
    expect(h.t.frames.at(-1)).toEqual(h.t.frames.at(-2));
    h.t.resize();
    expect(h.t.cleared).toHaveBeenCalledTimes(1);
    expect(h.t.frames.length).toBe(frames + 2);
    // The cleared screen was drawn: the same step again still draws nothing.
    report(h);
    expect(h.t.frames.length).toBe(frames + 2);
    await quit(h);
  });

  it('a resize to another size is drawn, and stats steps after it are compared with that frame', async () => {
    const { h } = await statsReading();
    h.t.screen = { rows: 12, cols: 60 };
    h.t.resize();
    expect(h.t.frames.at(-1)?.lines).toHaveLength(12);
    const frames = h.t.frames.length;
    report(h);
    expect(h.t.frames.length).toBe(frames + 1);
    expect(h.t.frames.at(-1)?.lines).toHaveLength(12);
    report(h);
    expect(h.t.frames.length).toBe(frames + 1);
    await quit(h);
  });
});

// --- the order of logins --------------------------------------------------------------------

describe('the stats login takes its turn among the logins of the mailbox', () => {
  it('a reconnect asked for while the stats login is under way waits for it, then is made', async () => {
    const { h, login } = await statsLoggingIn();
    await lost(h);
    await press(h, ch('y'));
    await shown(h, 'Reconnecting...');
    await settle();
    // The old session went at once; the new login waits its turn.
    expect(loggedOut(h)).toEqual(['logout:s1']);
    expect(h.server).toHaveBeenCalledTimes(2);

    const read = slowRead(h);
    login.resolve(h.session('stats'));
    await shown(h, 'Subject 2');
    expect(h.server).toHaveBeenCalledTimes(3);
    expect(h.calls.slice(-3)).toEqual(['stats:stats', 'login', 'load:s2:INBOX']);
    read.resolve(STATS);
    await vi.waitFor(() => {
      expect(logouts(h, 'stats')).toBe(1);
    });
    await quit(h);
    expect(loggedOut(h)).toEqual(['logout:s1', 'logout:stats', 'logout:s2']);
  });

  it('a queued reconnect of a visit that was left is never made', async () => {
    const { h, login } = await statsLoggingIn();
    await lost(h);
    await press(h, ch('y'));
    await shown(h, 'Reconnecting...');
    await settle();
    expect(h.server).toHaveBeenCalledTimes(2);
    // Nothing but Ctrl+C leaves a mailbox while it reconnects.
    h.t.key(CTRL_C);
    await expect(h.done).resolves.toMatchObject({ end: 'interrupt' });
    const settled = h.app.settled();
    expect(await stillRunning(settled)).toBe(true);
    login.resolve(h.session('late'));
    await settled;
    await settle();
    await settle();
    expect(h.server).toHaveBeenCalledTimes(2);
    expect(h.openSession).toHaveBeenCalledTimes(2);
    expect(h.collect).not.toHaveBeenCalled();
    expect(loggedOut(h)).toEqual(['logout:s1', 'logout:late']);
    expect(count(h, 'stats.finish')).toBe(0);
  });

  it('a queued reconnect is not made either when the screen fails while it waits', async () => {
    const { h, login } = await statsLoggingIn();
    await lost(h);
    await press(h, ch('y'));
    await shown(h, 'Reconnecting...');
    h.t.failDraw = new Error('terminal gone');
    h.t.resize();
    await expect(h.done).rejects.toThrow('terminal gone');
    login.resolve(h.session('late'));
    await h.app.settled();
    await settle();
    expect(h.server).toHaveBeenCalledTimes(2);
    expect(loggedOut(h)).toEqual(['logout:s1', 'logout:late']);
  });

  it('the mailbox opened again while the stats login of the visit before is under way waits for it', async () => {
    const { h, login } = await statsLoggingIn();
    await press(h, ESC);
    expect(last(h)).toContain(HOME_ROW);
    await press(h, ENTER);
    expect(last(h)).toContain('Connecting...');
    await settle();
    expect(h.server).toHaveBeenCalledTimes(2);
    login.resolve(h.session('late'));
    await shown(h, 'Stats ready - press s');
    // The late session is logged out as it arrives; then the new visit: its login, its stats.
    expect(h.calls.slice(3)).toEqual([
      'login',
      'logout:s1',
      'find',
      'logout:late',
      'login',
      'list:s2',
      'login',
      'stats:s3',
      'logout:s3',
    ]);
    await quit(h);
  });

  it("a read that runs and a reconnect of the browser don't wait for each other", async () => {
    // Only logins take turns: once the stats session is there, its read and a new login for
    // the mailbox's own session run side by side.
    const { h, read } = await statsReading();
    await lost(h);
    const reconnect = deferred<FakeSession>();
    h.nextLogin(() => reconnect.promise);
    await press(h, ch('y'));
    await shown(h, 'Reconnecting...');
    expect(h.server).toHaveBeenCalledTimes(3);
    read.resolve(STATS);
    await vi.waitFor(() => {
      expect(count(h, 'stats.finish')).toBe(1);
    });
    reconnect.resolve(h.session('again'));
    await shown(h, 'Subject 2');
    await quit(h);
    expect(loggedOut(h)).toEqual(['logout:s1', 'logout:s2', 'logout:again']);
  });
});

// --- the guard's wait -----------------------------------------------------------------------

describe("the guard's wait before a stats login", () => {
  /** The bars without stats; `s` then starts a read whose login has to wait first. */
  async function waiting(): Promise<Harness> {
    const h = await atBars({ autoStats: false });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    challenged(h);
    const frames = h.t.frames.length;
    await press(h, ch('s'));
    expect(vi.getTimerCount()).toBe(1);
    // One frame, for the key: the wait itself has nothing to say on this screen.
    expect(h.t.frames.length).toBe(frames + 1);
    return h;
  }

  it('no notice on any screen; the login is made when the wait is over, not before', async () => {
    const h = await waiting();
    expect(last(h)).toContain('Stats: reading...');
    await vi.advanceTimersByTimeAsync(4999);
    expect(h.server).toHaveBeenCalledTimes(1);
    expect(h.collect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await shown(h, SUMMARY);
    expect(h.server).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.t.frames.some((frame) => text(frame).includes(CHALLENGE_NOTICE))).toBe(false);
    await quit(h);
  });

  it('a wait that is still wanted keeps its time while the user works in the mailbox', async () => {
    const h = await waiting();
    // Back to the bars, into a folder, marks, back again: nothing of that ends the wait.
    await press(h, ESC, ENTER);
    expect(last(h)).toContain('Subject 2');
    await press(h, ch('a'), ESC, DOWN, ch('o'));
    expect(last(h)).toContain('Stats: reading...');
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(4999);
    expect(h.server).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await shown(h, 'Stats ready - press s');
    expect(h.server).toHaveBeenCalledTimes(2);
    await quit(h);
  });

  it('leaving the mailbox ends the wait at once: no login, no timer left', async () => {
    const h = await waiting();
    await press(h, ESC, ESC);
    expect(last(h)).toContain(HOME_ROW);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    await settle();
    expect(h.server).toHaveBeenCalledTimes(1);
    expect(h.collect).not.toHaveBeenCalled();
    expect(names(h)).toEqual(['folders.list']);
    expect(h.onUnexpected).not.toHaveBeenCalled();
    expect(await stillRunning(h.done)).toBe(true);
    await quit(h);
  });

  it('Ctrl+C ends the wait at once too: settled() does not wait for the 5 seconds', async () => {
    const h = await waiting();
    h.t.key(CTRL_C);
    await expect(h.done).resolves.toStrictEqual({ end: 'interrupt' });
    await h.app.settled();
    expect(vi.getTimerCount()).toBe(0);
    expect(h.server).toHaveBeenCalledTimes(1);
    expect(loggedOut(h)).toEqual(['logout:s1']);
    expect(names(h)).toEqual(['folders.list']);
  });

  it('a reconnect that has to wait too comes after it: one wait at a time, each for its whole time', async () => {
    const h = await waiting();
    await press(h, ESC);
    await lost(h);
    challenged(h);
    await press(h, ch('y'));
    expect(last(h)).toContain('Reconnecting...');
    // The reconnect is behind the stats login, whose wait runs: one timer, no notice yet.
    expect(vi.getTimerCount()).toBe(1);
    expect(last(h)).not.toContain(CHALLENGE_NOTICE);
    await vi.advanceTimersByTimeAsync(4999);
    expect(h.server).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    // The stats login was made; now the reconnect waits, for a whole time of its own.
    expect(h.server).toHaveBeenCalledTimes(2);
    expect(last(h)).toContain(CHALLENGE_NOTICE);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(4999);
    expect(h.server).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(h.server).toHaveBeenCalledTimes(3);
    expect(last(h)).toContain('Subject 2');
    await quit(h);
  });
});

// --- the real guard -------------------------------------------------------------------------

describe('with the real login guard', () => {
  it('two logins per open, both through the one guard: two imap.login lines for the mailbox', async () => {
    const h = await atBars({ guarded: true });
    await shown(h, 'Stats ready - press s');
    const logins = events(h, 'imap.login');
    expect(logins).toHaveLength(2);
    expect(logins.map((r) => r['acct'])).toEqual([BOX_ID, BOX_ID]);
    expect(logins[0]?.['target']).toBe(logins[1]?.['target']);
    expect(names(h)).toEqual(['imap.login', 'folders.list', 'imap.login', 'stats.finish']);
    await quit(h);
    expect(loggedOut(h)).toEqual(['logout:s2', 'logout:s1']);
  });

  it('a stats login the server refuses is counted by the guard like any other, and never repeated', async () => {
    const h = await atHome({ guarded: true });
    h.nextLogin((email) => h.answer(email));
    h.nextLogin(() => Promise.reject(new ImapSessionError('auth-failed')));
    await press(h, ENTER);
    await shown(h, "Stats couldn't be read - press s");
    await settle();
    await settle();
    expect(h.server).toHaveBeenCalledTimes(2);
    expect(events(h, 'imap.login-failed')).toEqual([
      expect.objectContaining({ acct: BOX_ID, reason: 'auth-failed', counted: true }),
    ]);
    expect(events(h, 'stats.finish')).toEqual([
      expect.objectContaining({ outcome: 'failed', reason: 'auth-failed' }),
    ]);
    await quit(h);
  });
});
