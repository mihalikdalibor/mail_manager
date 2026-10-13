import { describe, it, expect, vi } from 'vitest';
import { createApp } from '../../src/cli/app/controller.js';
import type { App, AppDeps, AppResult, MailboxSession } from '../../src/cli/app/controller.js';
import { RECONNECT_FAILED_TEXT } from '../../src/cli/browser/controller.js';
import type { Rendered } from '../../src/cli/browser/render.js';
import type { Keypress, Screen } from '../../src/cli/browser/state.js';
import type { Terminal } from '../../src/cli/browser/terminal.js';
import { formatBytes } from '../../src/cli/folders-text.js';
import type { AuthUser, LogoutResult } from '../../src/core/auth.js';
import type { MailAccount } from '../../src/core/db/repos.js';
import { ImapSessionError } from '../../src/core/imap/errors.js';
import type { LogRecord } from '../../src/core/log/index.js';
import { MemoryEventLog } from '../../src/core/log/index.js';
import { MailboxError } from '../../src/core/mailbox/errors.js';
import type { FolderInfo, FolderTree } from '../../src/core/mailbox/folders.js';
import type {
  FolderSnapshot,
  MessageRow,
  PageResult,
  loadPage,
} from '../../src/core/mailbox/messages.js';
import type {
  Match,
  SearchResult,
  loadMatches,
  searchFolder,
} from '../../src/core/mailbox/search.js';
import { SearchStopped } from '../../src/core/mailbox/search.js';
import { MemoryRememberedUsers } from '../../src/core/remembered-users.js';

// M3a in the app controller: `/` opens the filter line of the open folder, Enter runs one search
// on the mailbox's session, the matches are read by UID, `o` orders, `m` marks, and Esc / Left /
// Ctrl+C / leaving the mailbox stop what runs. Driven with a fake Terminal, fake sessions (a logout
// record each), fake openSession / listFolders / load / search / loadMatches, a fixed clock and a
// MemoryEventLog. No IMAP, no real terminal, no real clock. Addresses are placeholders; the
// canary values are the ones the spec names for "never logged".

// --- fixtures -------------------------------------------------------------------------------

const SCREEN: Screen = { rows: 24, cols: 100 };
const ANNA: AuthUser = {
  email: 'anna@example-test-domain.eu',
  userId: '11111111-1111-4111-8111-111111111111',
};
const BOX_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOX_EMAIL = 'one@example-test-domain.eu';
const T0 = Date.UTC(2026, 9, 6, 9, 0, 0);
const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);
const BASE = Date.UTC(2026, 0, 2, 12, 0, 0);
const HOME_ROW = '+ Add a mailbox';
const INBOX: FolderSnapshot = { path: 'INBOX', uidValidity: '7', exists: 3 };
/** The two mails of INBOX a filter finds by default: "Subject 1" and "Subject 3". */
const MATCH_UIDS = [1001, 1003];
const CANARY_LINE = 'from:canary@secret-domain.example CANARYWORD since:2019-03-04 larger:7654321b';
const CANARY_VALUES = ['canary@secret-domain.example', 'CANARYWORD', '2019-03-04', '7654321'];

const k = (name: string, extra: Keypress = {}): Keypress => ({ name, sequence: name, ...extra });
const ENTER = k('return', { sequence: '\r' });
const DOWN = k('down', { sequence: '\u001b[B' });
const LEFT = k('left', { sequence: '\u001b[D' });
const BACKSPACE = k('backspace', { sequence: '\u007f' });
const ESC = k('escape', { meta: true, sequence: '\u001b' });
const CTRL_C = k('c', { ctrl: true, sequence: '\u0003' });
const SLASH: Keypress = { sequence: '/' };

function charKey(c: string): Keypress {
  if (c === ' ') return { name: 'space', sequence: ' ' };
  return /^[a-z]$/.test(c) ? { name: c, sequence: c } : { sequence: c };
}

const ch = (c: string): Keypress => charKey(c);

const BOX: MailAccount = {
  id: BOX_ID,
  userId: ANNA.userId,
  label: null,
  email: BOX_EMAIL,
  provider: 'websupport',
  host: 'imap.example-test-domain.eu',
  port: 993,
  username: BOX_EMAIL,
  authType: 'password',
  secret: { ciphertext: 'c', iv: 'i', tag: 't', keyVersion: 1 },
  capabilities: null,
  createdAt: new Date(T0),
  updatedAt: new Date(T0),
  lastCheckedAt: null,
};

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

function treeOf(folders: FolderInfo[]): FolderTree {
  return {
    folders,
    totals: { messages: 6, unseen: 0, bytes: 2000, sizeSource: 'server' },
    quota: null,
    truncated: false,
    unreadable: 0,
    gmailAllHidden: false,
    fallbacks: new Set(),
  };
}

const TREE = treeOf([folder('INBOX', { role: 'inbox', roleSource: 'path' }), folder('Sent')]);

/** A mail of INBOX: UID 1000 + seq, 100 bytes, "Subject <seq>". */
function mail(seq: number): MessageRow {
  return {
    seq,
    uid: 1000 + seq,
    received: new Date(BASE),
    from: 'Sender',
    subject: `Subject ${String(seq)}`,
    bytes: 100,
    attachment: false,
  };
}

/** The first page of every folder: the three mails of INBOX. */
function pageOf(path: string): PageResult {
  return { kind: 'page', snapshot: { ...INBOX, path }, page: 0, rows: [3, 2, 1].map(mail) };
}

/** A match of a search: the lower UID is the newer mail, so newest first is UID ascending. */
function matchOf(uid: number): Match {
  return { uid, bytes: 100, received: BASE - uid * 1000 };
}

/** A search result for these UIDs, UID descending as the core gives it. */
function resultOf(uids: number[], over: Partial<SearchResult> = {}): SearchResult {
  const matches = [...uids].sort((a, b) => b - a).map(matchOf);
  return { snapshot: INBOX, matches, bytes: matches.length * 100, missing: 0, ...over };
}

/** The page of matches by UID, rows in the asked order. */
function matchPage(snapshot: FolderSnapshot, page: number, uids: readonly number[]): PageResult {
  return { kind: 'page', snapshot, page, rows: uids.map((uid) => mail(uid - 1000)) };
}

// --- fakes ----------------------------------------------------------------------------------

interface FakeTerminal extends Terminal {
  readonly frames: Rendered[];
  screen: Screen;
  key(key: Keypress): void;
  resize(): void;
}

function fakeTerminal(): FakeTerminal {
  let keyHandler: ((key: Keypress) => void) | null = null;
  let resizeHandler: (() => void) | null = null;
  const t: FakeTerminal = {
    frames: [],
    screen: SCREEN,
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

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await settle();
}

async function stillRunning(p: Promise<unknown>): Promise<boolean> {
  return Promise.race([p.then(() => false), settle().then(() => true)]);
}

type FakeSession = MailboxSession & { name: string };
type ListFolders = NonNullable<AppDeps['listFolders']>;

interface Harness {
  t: FakeTerminal;
  app: App;
  done: Promise<AppResult>;
  log: MemoryEventLog;
  /** In order: `logout:<name>`. */
  calls: string[];
  /** Every session a login gave, in order: s1, s2, ... */
  sessions: FakeSession[];
  openSession: ReturnType<typeof vi.fn<AppDeps['openSession']>>;
  load: ReturnType<typeof vi.fn<typeof loadPage>>;
  search: ReturnType<typeof vi.fn<typeof searchFolder>>;
  loadMatches: ReturnType<typeof vi.fn<typeof loadMatches>>;
  onUnexpected: ReturnType<typeof vi.fn<(err: unknown) => void>>;
}

function makeHarness(): Harness {
  const t = fakeTerminal();
  const calls: string[] = [];
  const sessions: FakeSession[] = [];
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
  const log = new MemoryEventLog({
    run: '0123456789abcdef',
    ver: '0.9.0',
    now: () => T0,
    level: 'debug',
  });
  const findAccount = vi.fn<AppDeps['findAccount']>(() => Promise.resolve(BOX));
  const openSession = vi.fn<AppDeps['openSession']>(() => {
    const made = session(`s${String(sessions.length + 1)}`);
    sessions.push(made);
    return Promise.resolve(made);
  });
  const listFolders = vi.fn<ListFolders>(() => Promise.resolve(TREE));
  const load = vi.fn<typeof loadPage>((_session, path) => Promise.resolve(pageOf(path)));
  const search = vi.fn<typeof searchFolder>(() => Promise.resolve(resultOf(MATCH_UIDS)));
  const loadMatchPage = vi.fn<typeof loadMatches>((_session, _path, expected, page, uids) =>
    Promise.resolve(matchPage(expected, page, uids)),
  );
  const onUnexpected = vi.fn<(err: unknown) => void>();
  const app = createApp({
    terminal: t,
    version: '0.9.0',
    auth: {
      currentUser: () => Promise.resolve(ANNA),
      login: () => Promise.resolve(ANNA),
      logout: (): Promise<LogoutResult> => Promise.resolve('logged-out'),
    },
    listMailboxes: vi.fn<AppDeps['listMailboxes']>(() => Promise.resolve([BOX])),
    remembered: new MemoryRememberedUsers([ANNA.email]),
    log,
    loginTarget: () => 'ab'.repeat(32),
    onUnexpected,
    findAccount,
    openSession,
    listFolders,
    load,
    search,
    loadMatches: loadMatchPage,
    now: () => NOW,
    readLogs: NO_LOGS,
    ...NO_ADD,
    autoStats: false,
  });
  return {
    t,
    app,
    done: app.run(),
    log,
    calls,
    sessions,
    openSession,
    load,
    search,
    loadMatches: loadMatchPage,
    onUnexpected,
  };
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

/** `/`, the line typed, Enter. */
async function filterFor(h: Harness, line: string): Promise<void> {
  await press(h, SLASH, ...[...line].map(charKey), ENTER);
}

function events(h: Harness, name: string): LogRecord[] {
  return h.log.records.filter((r) => r.event === name);
}

const count = (h: Harness, name: string): number => events(h, name).length;
const logouts = (h: Harness, name: string): number =>
  h.calls.filter((c) => c === `logout:${name}`).length;

/** Ctrl+C (unless it has ended), then everything that was still under way. */
async function quit(h: Harness): Promise<void> {
  h.t.key(CTRL_C);
  await h.done.catch(() => undefined);
  await h.app.settled();
}

/** ANNA on Home with her mailbox listed, the cursor on it. */
async function atHome(): Promise<Harness> {
  const h = makeHarness();
  await shown(h, 'Sign in as another user');
  await press(h, ENTER);
  await shown(h, HOME_ROW);
  return h;
}

/** Enter on the mailbox: its bars. */
async function atBars(): Promise<Harness> {
  const h = await atHome();
  await press(h, ENTER);
  await shown(h, 'Total:');
  return h;
}

/** Enter on INBOX: its three mails, the first page loaded. */
async function atMails(): Promise<Harness> {
  const h = await atBars();
  await press(h, ENTER);
  await shown(h, 'Subject 3');
  return h;
}

// --- the filter line and the search ---------------------------------------------------------

describe('search from the filter line', () => {
  it('typing a filter and Enter runs one search on the mailbox session', async () => {
    const h = await atMails();
    const pending = deferred<SearchResult>();
    h.search.mockImplementationOnce(() => pending.promise);
    await filterFor(h, 'shop');
    await vi.waitFor(() => {
      expect(h.search).toHaveBeenCalledTimes(1);
    });
    const [session, path, compiled, opts] = h.search.mock.calls[0] ?? [];
    expect(session).toBe(h.sessions[0]);
    expect(path).toBe('INBOX');
    expect(compiled?.criteria).toEqual(['word']);
    expect(typeof opts?.shouldStop).toBe('function');
    expect(typeof opts?.onProgress).toBe('function');
    await shown(h, 'Filtering...');
    pending.resolve(resultOf(MATCH_UIDS));
    await shown(h, `2 of 3 mails, ${formatBytes(200)}`);
    expect(last(h)).toContain('Subject 3');
    expect(last(h)).not.toContain('Subject 2');
    expect(h.search).toHaveBeenCalledTimes(1);
    await quit(h);
  });

  it('q inside the line is a letter', async () => {
    const h = await atMails();
    await press(h, SLASH, { name: 'q', sequence: 'q' });
    await shown(h, 'Filter: q_');
    expect(await stillRunning(h.done)).toBe(true);
    expect(h.search).not.toHaveBeenCalled();
    await quit(h);
  });

  it('the page of matches is read by UID', async () => {
    const h = await atMails();
    const uids = Array.from({ length: 250 }, (_, i) => 1000 + i);
    const snapshot = { ...INBOX, exists: 250 };
    h.search.mockResolvedValueOnce(resultOf(uids, { snapshot }));
    await filterFor(h, 'shop');
    await shown(h, '250 of 250 mails');
    await vi.waitFor(() => {
      expect(h.loadMatches).toHaveBeenCalledTimes(1);
    });
    const [session, path, expected, page, asked] = h.loadMatches.mock.calls[0] ?? [];
    expect(session).toBe(h.sessions[0]);
    expect(path).toBe('INBOX');
    expect(expected).toEqual(snapshot);
    expect(page).toBe(0);
    // The search gave them UID descending; the newest first is UID ascending here.
    expect(asked).toEqual(uids.slice(0, 200));
    await quit(h);
  });

  it("older: uses the app's clock", async () => {
    const h = await atMails();
    await filterFor(h, 'older:1y');
    await vi.waitFor(() => {
      expect(h.search).toHaveBeenCalledTimes(1);
    });
    const compiled = h.search.mock.calls[0]?.[2];
    expect(compiled?.checks).toEqual([
      { kind: 'received', fromMs: null, beforeMs: Date.UTC(2025, 9, 12, 12), want: true },
    ]);
    await shown(h, '2 of 3 mails');
    await quit(h);
  });

  it('search.finish ok', async () => {
    const h = await atMails();
    await filterFor(h, 'shop');
    await shown(h, `2 of 3 mails, ${formatBytes(200)}`);
    expect(events(h, 'search.finish')).toEqual([
      expect.objectContaining({
        acct: BOX_ID,
        count: 2,
        bytes: 200,
        criteria: ['word'],
        outcome: 'ok',
      }),
    ]);
    const [line] = events(h, 'search.finish');
    expect(typeof line?.['ms']).toBe('number');
    expect(line).not.toHaveProperty('reason');
    await quit(h);
  });

  it('nothing typed is logged', async () => {
    const h = await atMails();
    await filterFor(h, CANARY_LINE);
    await vi.waitFor(() => {
      expect(count(h, 'search.finish')).toBe(1);
    });
    const logged = JSON.stringify(h.log.records);
    expect(logged).toContain('search.finish');
    for (const value of CANARY_VALUES) expect(logged).not.toContain(value);
    await quit(h);
  });

  it('a refused search', async () => {
    const h = await atMails();
    h.search.mockRejectedValueOnce(new MailboxError('search-failed'));
    await filterFor(h, 'shop');
    await shown(h, "The mail server couldn't run this filter");
    expect(last(h)).toContain('Subject 2');
    expect(last(h)).not.toContain('Filter:');
    expect(events(h, 'search.finish')).toEqual([
      expect.objectContaining({ count: 0, bytes: 0, outcome: 'failed', reason: 'search-failed' }),
    ]);
    await quit(h);
  });

  it('too many mails', async () => {
    const h = await atMails();
    h.search.mockRejectedValueOnce(new MailboxError('too-many-matches'));
    await filterFor(h, 'shop');
    await shown(h, 'More than 500,000 mails to go through - narrow the filter.');
    expect(last(h)).toContain('Subject 2');
    expect(events(h, 'search.finish')).toEqual([
      expect.objectContaining({
        count: 0,
        bytes: 0,
        outcome: 'failed',
        reason: 'too-many-matches',
      }),
    ]);
    await quit(h);
  });

  it('Esc while filtering stops it and logs nothing', async () => {
    const h = await atMails();
    const pending = deferred<SearchResult>();
    h.search.mockImplementationOnce(() => pending.promise);
    await filterFor(h, 'shop');
    await shown(h, 'Filtering...');
    const opts = h.search.mock.calls[0]?.[3];
    expect(opts?.shouldStop?.()).toBe(false);
    await press(h, ESC);
    expect(opts?.shouldStop?.()).toBe(true);
    await shown(h, 'Subject 2');
    pending.resolve(resultOf(MATCH_UIDS));
    await flush();
    expect(count(h, 'search.finish')).toBe(0);
    expect(last(h)).toContain('Subject 2');
    expect(last(h)).not.toContain('2 of 3 mails');
    await quit(h);
  });

  it('SearchStopped is not a failure', async () => {
    const h = await atMails();
    h.search.mockRejectedValueOnce(new SearchStopped());
    await filterFor(h, 'shop');
    await vi.waitFor(() => {
      expect(h.search).toHaveBeenCalledTimes(1);
    });
    await flush();
    expect(count(h, 'search.finish')).toBe(0);
    expect(await stillRunning(h.done)).toBe(true);
    expect(h.onUnexpected).not.toHaveBeenCalled();
    await press(h, ESC);
    await shown(h, 'Subject 2');
    await quit(h);
  });

  it('a second filter while the first still runs', async () => {
    const h = await atMails();
    const first = deferred<SearchResult>();
    const second = deferred<SearchResult>();
    h.search
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    await filterFor(h, 'a');
    await shown(h, 'Filtering...');
    // `/` opens the line with the text being searched: "a" plus "b".
    await press(h, SLASH, { name: 'b', sequence: 'b' }, ENTER);
    await vi.waitFor(() => {
      expect(h.search).toHaveBeenCalledTimes(2);
    });
    expect(h.search.mock.calls[0]?.[3]?.shouldStop?.()).toBe(true);
    first.resolve(resultOf([1001]));
    await flush();
    expect(last(h)).toContain('Filtering...');
    expect(last(h)).not.toContain('1 of 3 mails');
    second.resolve(resultOf(MATCH_UIDS));
    await shown(h, `2 of 3 mails, ${formatBytes(200)}`);
    expect(events(h, 'search.finish')).toEqual([
      expect.objectContaining({ count: 2, outcome: 'ok' }),
    ]);
    await quit(h);
  });

  it('progress reaches the screen', async () => {
    const h = await atMails();
    const pending = deferred<SearchResult>();
    h.search.mockImplementationOnce(() => pending.promise);
    await filterFor(h, 'shop');
    await vi.waitFor(() => {
      expect(h.search).toHaveBeenCalledTimes(1);
    });
    h.search.mock.calls[0]?.[3]?.onProgress?.(5000, 12000);
    await shown(h, 'Filtering... 5000/12000');
    pending.resolve(resultOf(MATCH_UIDS));
    await shown(h, '2 of 3 mails');
    await quit(h);
  });
});

// --- order, marks and the other keys of a result --------------------------------------------

describe('order and marks on a result', () => {
  it('o on the plain list searches with no criteria', async () => {
    const h = await atMails();
    await press(h, ch('o'));
    await vi.waitFor(() => {
      expect(h.search).toHaveBeenCalledTimes(1);
    });
    expect(h.search.mock.calls[0]?.[2]?.criteria).toEqual([]);
    await shown(h, '2 of 3 mails');
    expect(last(h)).toContain('oldest first');
    expect(events(h, 'search.finish')).toEqual([
      expect.objectContaining({ criteria: [], outcome: 'ok' }),
    ]);
    await quit(h);
  });

  it('o on a result does not search again', async () => {
    const h = await atMails();
    await filterFor(h, 'shop');
    await shown(h, '2 of 3 mails');
    await press(h, ch('o'));
    await shown(h, 'oldest first');
    await vi.waitFor(() => {
      expect(h.loadMatches).toHaveBeenCalledTimes(2);
    });
    expect(h.search).toHaveBeenCalledTimes(1);
    // Oldest first: the higher UID is the older mail here.
    expect(h.loadMatches.mock.calls[1]?.[4]).toEqual([1003, 1001]);
    await quit(h);
  });

  it('m marks all, the status line counts them', async () => {
    const h = await atMails();
    h.search.mockResolvedValueOnce(resultOf([1001, 1002, 1003]));
    await filterFor(h, 'shop');
    await shown(h, `3 of 3 mails, ${formatBytes(300)}`);
    await press(h, ch('m'));
    await shown(h, 'marked: 3 mails');
    await press(h, ch('q'), ch('y'));
    await h.done;
    await h.app.settled();
    expect(events(h, 'browse.finish')).toEqual([
      expect.objectContaining({ marked: 3, outcome: 'ok' }),
    ]);
  });

  it('Ctrl+C during a search: the session is logged out once, no search.finish, the late result changes nothing', async () => {
    const h = await atMails();
    const pending = deferred<SearchResult>();
    h.search.mockImplementationOnce(() => pending.promise);
    await filterFor(h, 'shop');
    await shown(h, 'Filtering...');
    h.t.key(CTRL_C);
    await expect(h.done).resolves.toMatchObject({ end: 'interrupt' });
    await h.app.settled();
    pending.resolve(resultOf(MATCH_UIDS));
    await flush();
    expect(logouts(h, 's1')).toBe(1);
    expect(count(h, 'search.finish')).toBe(0);
  });

  it('o while filtering only changes the order the result gets', async () => {
    const h = await atMails();
    const pending = deferred<SearchResult>();
    h.search.mockImplementationOnce(() => pending.promise);
    await filterFor(h, 'shop');
    await shown(h, 'Filtering...');
    await press(h, ch('o'));
    expect(h.search).toHaveBeenCalledTimes(1);
    pending.resolve(resultOf(MATCH_UIDS));
    await shown(h, 'oldest first');
    await vi.waitFor(() => {
      expect(h.loadMatches).toHaveBeenCalled();
    });
    expect(h.search).toHaveBeenCalledTimes(1);
    expect(h.loadMatches.mock.calls[0]?.[4]).toEqual([1003, 1001]);
    await quit(h);
  });

  it('Up / Down and m do nothing while filtering', async () => {
    const h = await atMails();
    const pending = deferred<SearchResult>();
    h.search.mockImplementationOnce(() => pending.promise);
    await filterFor(h, 'shop');
    await shown(h, 'Filtering...');
    await press(h, DOWN, ch('m'));
    expect(last(h)).toContain('Filtering...');
    expect(h.search).toHaveBeenCalledTimes(1);
    pending.resolve(resultOf(MATCH_UIDS));
    await shown(h, '2 of 3 mails');
    expect(last(h)).not.toContain('marked: 2 mails');
    await quit(h);
  });

  it('m on the plain list only hints at the filter line', async () => {
    const h = await atMails();
    await press(h, ch('m'));
    await shown(h, 'press / and type a filter first');
    expect(last(h)).toContain('Subject 2');
    expect(h.search).not.toHaveBeenCalled();
    await quit(h);
  });
});

// --- leaving, stopping and failing ----------------------------------------------------------

describe('leaving and failing during a search', () => {
  it('connection lost during a search', async () => {
    const h = await atMails();
    h.search.mockRejectedValueOnce(new MailboxError('connection-lost'));
    await filterFor(h, 'shop');
    await shown(h, 'Connection closed - reconnect? (y/N)');
    expect(events(h, 'search.finish')).toEqual([
      expect.objectContaining({ count: 0, bytes: 0, outcome: 'failed', reason: 'connection-lost' }),
    ]);
    await quit(h);
  });

  it('connection lost during a search while the line is open: typed letters stay text and no login is made', async () => {
    const h = await atMails();
    const pending = deferred<SearchResult>();
    h.search.mockImplementationOnce(() => pending.promise);
    await filterFor(h, 'shop');
    await shown(h, 'Filtering...');
    // `/` reopens the line holding the text being searched; the search is then cut.
    await press(h, SLASH);
    await shown(h, 'Filter: shop_');
    pending.reject(new MailboxError('connection-lost'));
    await vi.waitFor(() => {
      expect(events(h, 'search.finish')).toEqual([
        expect.objectContaining({ outcome: 'failed', reason: 'connection-lost' }),
      ]);
    });
    const opened = h.openSession.mock.calls.length;

    // The letters are text of the line, not an answer to the reconnect question.
    await press(h, ch('y'), ch('r'));
    await shown(h, 'Filter: shopyr_');
    expect(h.openSession).toHaveBeenCalledTimes(opened);
    expect(last(h)).not.toContain('Connection closed - reconnect? (y/N)');

    // Enter asks the question; the search was never run again.
    await press(h, ENTER);
    await shown(h, 'Connection closed - reconnect? (y/N)');
    expect(h.search).toHaveBeenCalledTimes(1);
    await quit(h);
  });

  it('leaving the mailbox during a search', async () => {
    const h = await atMails();
    const pending = deferred<SearchResult>();
    h.search.mockImplementationOnce(() => pending.promise);
    await filterFor(h, 'shop');
    await shown(h, 'Filtering...');
    // The first Esc stops the search and shows the plain list; two more leave the mailbox.
    await press(h, ESC);
    await shown(h, 'Subject 2');
    await press(h, ESC);
    await shown(h, 'Total:');
    await press(h, ESC);
    await shown(h, HOME_ROW);
    expect(logouts(h, 's1')).toBe(1);
    pending.resolve(resultOf(MATCH_UIDS));
    await flush();
    expect(logouts(h, 's1')).toBe(1);
    expect(count(h, 'search.finish')).toBe(0);
    expect(last(h)).toContain(HOME_ROW);
    await quit(h);
  });

  it('an unexpected error ends the app', async () => {
    const h = await atMails();
    const err = new TypeError('boom');
    const crashed = expect(h.done).rejects.toBe(err);
    h.search.mockRejectedValueOnce(err);
    await press(h, SLASH, ...[...'shop'].map(charKey));
    h.t.key(ENTER);
    await crashed;
    await h.app.settled();
    expect(events(h, 'search.finish')).toEqual([
      expect.objectContaining({ count: 0, bytes: 0, outcome: 'failed', reason: 'unexpected' }),
    ]);
    expect(h.onUnexpected).not.toHaveBeenCalled();
  });

  it('no session (after a failed reconnect)', async () => {
    const h = await atBars();
    h.load.mockRejectedValueOnce(new MailboxError('connection-lost'));
    await press(h, ENTER);
    await shown(h, 'Connection closed - reconnect? (y/N)');
    h.openSession.mockRejectedValueOnce(new ImapSessionError('auth-failed'));
    await press(h, ch('y'));
    await shown(h, RECONNECT_FAILED_TEXT);
    await press(h, SLASH, ch('x'), ENTER);
    await flush();
    expect(h.search).not.toHaveBeenCalled();
    expect(count(h, 'search.finish')).toBe(0);
    expect(last(h)).not.toContain('Filter:');
    await quit(h);
  });
});

// --- edges of the line and of the result (added beyond the plan) ----------------------------

describe('edges of the filter line', () => {
  it('a blank line with no filter on changes nothing: no search, the plain list stays', async () => {
    const h = await atMails();
    const loads = h.load.mock.calls.length;
    await filterFor(h, '');
    await flush();
    expect(h.search).not.toHaveBeenCalled();
    expect(h.load.mock.calls.length).toBe(loads);
    expect(last(h)).toContain('Subject 2');
    expect(last(h)).not.toContain('Filter:');
    await quit(h);
  });

  it('a blank line with a filter on clears it: the plain list, no search', async () => {
    const h = await atMails();
    await filterFor(h, 'shop');
    await shown(h, '2 of 3 mails');
    await press(h, SLASH, ...Array.from({ length: 4 }, () => BACKSPACE), ENTER);
    await shown(h, 'Subject 2');
    expect(last(h)).not.toContain('Filter:');
    expect(h.search).toHaveBeenCalledTimes(1);
    await quit(h);
  });

  it('Enter with the same text searches again', async () => {
    const h = await atMails();
    await filterFor(h, 'shop');
    await shown(h, '2 of 3 mails');
    await press(h, SLASH, ENTER);
    await vi.waitFor(() => {
      expect(h.search).toHaveBeenCalledTimes(2);
    });
    expect(h.search.mock.calls[1]?.[2]?.criteria).toEqual(['word']);
    await shown(h, '2 of 3 mails');
    await quit(h);
  });

  it('Left with a filter on returns to the plain list, not out of the folder', async () => {
    const h = await atMails();
    await filterFor(h, 'shop');
    await shown(h, '2 of 3 mails');
    await press(h, LEFT);
    await shown(h, 'Subject 2');
    expect(last(h)).not.toContain('Filter:');
    expect(logouts(h, 's1')).toBe(0);
    expect(h.search).toHaveBeenCalledTimes(1);
    await quit(h);
  });

  it('Esc in the line cancels the edit and keeps the result on screen', async () => {
    const h = await atMails();
    await filterFor(h, 'shop');
    await shown(h, '2 of 3 mails');
    await press(h, SLASH, ch('x'));
    await shown(h, 'Filter: shopx_');
    await press(h, ESC);
    await shown(h, `2 of 3 mails, ${formatBytes(200)}`);
    expect(last(h)).toContain('Filter: shop');
    expect(last(h)).not.toContain('shopx');
    expect(h.search).toHaveBeenCalledTimes(1);
    await quit(h);
  });

  it('an unreadable line stays open with its message and nothing is searched', async () => {
    const h = await atMails();
    await press(h, SLASH, ...[...'form:x'].map(charKey), ENTER);
    await shown(h, 'Don\'t know "form:x"');
    expect(last(h)).toContain('Filter: form:x_');
    expect(h.search).not.toHaveBeenCalled();
    await quit(h);
  });

  it('a search that finds nothing says so', async () => {
    const h = await atMails();
    h.search.mockResolvedValueOnce(resultOf([]));
    await filterFor(h, 'shop');
    await shown(h, 'No mails match.');
    expect(events(h, 'search.finish')).toEqual([
      expect.objectContaining({ count: 0, outcome: 'ok' }),
    ]);
    await quit(h);
  });

  it('candidates the pass could not read: the status line says how many', async () => {
    const h = await atMails();
    h.search.mockResolvedValueOnce(resultOf(MATCH_UIDS, { missing: 2 }));
    await filterFor(h, 'shop');
    await shown(h, "2 mails couldn't be read");
    await quit(h);
  });

  it('a match gone before its page is read shows (not readable)', async () => {
    const h = await atMails();
    h.loadMatches.mockImplementationOnce((_session, _path, expected, page, uids) =>
      Promise.resolve(
        matchPage(
          expected,
          page,
          uids.filter((uid) => uid !== 1003),
        ),
      ),
    );
    await filterFor(h, 'shop');
    await shown(h, '(not readable)');
    expect(last(h)).toContain('Subject 1');
    expect(last(h)).toContain('2 of 3 mails');
    await quit(h);
  });

  it('UIDVALIDITY changed under a match page: the filter runs again', async () => {
    const h = await atMails();
    h.loadMatches.mockResolvedValueOnce({
      kind: 'changed',
      snapshot: { ...INBOX, uidValidity: '8' },
    });
    await filterFor(h, 'shop');
    await vi.waitFor(() => {
      expect(h.search).toHaveBeenCalledTimes(2);
    });
    await shown(h, `2 of 3 mails, ${formatBytes(200)}`);
    await quit(h);
  });

  it('UIDVALIDITY changed three times in a row: the plain list, not a fourth search', async () => {
    const h = await atMails();
    h.loadMatches.mockResolvedValue({
      kind: 'changed',
      snapshot: { ...INBOX, uidValidity: '8' },
    });
    await filterFor(h, 'shop');
    await shown(h, 'Subject 2');
    await flush();
    expect(h.search).toHaveBeenCalledTimes(3);
    expect(h.loadMatches).toHaveBeenCalledTimes(3);
    expect(last(h)).not.toContain('Filter:');
    await quit(h);
  });

  it('reconnected with a result on screen: the cursor page is read again by UID', async () => {
    const h = await atMails();
    h.loadMatches.mockRejectedValueOnce(new MailboxError('connection-lost'));
    await filterFor(h, 'shop');
    await shown(h, 'Connection closed - reconnect? (y/N)');
    await press(h, ch('y'));
    await vi.waitFor(() => {
      expect(h.loadMatches).toHaveBeenCalledTimes(2);
    });
    await shown(h, 'Subject 3');
    const [session, , , , uids] = h.loadMatches.mock.calls[1] ?? [];
    expect(session).toBe(h.sessions[1]);
    expect(uids).toEqual([1001, 1003]);
    await quit(h);
  });

  it('a search cut by a lost connection: after the reconnect the plain list is read', async () => {
    const h = await atMails();
    h.search.mockRejectedValueOnce(new MailboxError('connection-lost'));
    await filterFor(h, 'shop');
    await shown(h, 'Connection closed - reconnect? (y/N)');
    await press(h, ch('y'));
    await shown(h, 'Subject 2');
    expect(h.load.mock.calls.at(-1)?.[0]).toBe(h.sessions[1]);
    expect(last(h)).not.toContain('Filter:');
    await quit(h);
  });

  it('/ on the bars does nothing: no line, no search', async () => {
    const h = await atBars();
    await press(h, SLASH);
    await flush();
    expect(last(h)).toContain('Total:');
    expect(last(h)).not.toContain('Filter:');
    expect(h.search).not.toHaveBeenCalled();
    await quit(h);
  });
});
