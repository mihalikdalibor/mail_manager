import { randomBytes } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { accountErrorText } from '../../src/cli/account-text.js';
import { createApp } from '../../src/cli/app/controller.js';
import type { App, AppDeps, AppResult } from '../../src/cli/app/controller.js';
import { asciiText } from '../../src/cli/app/state.js';
import type { Rendered } from '../../src/cli/browser/render.js';
import type { Keypress, Screen } from '../../src/cli/browser/state.js';
import type { Terminal } from '../../src/cli/browser/terminal.js';
import { imapErrorText } from '../../src/cli/imap-errors.js';
import { loginBlockedText } from '../../src/cli/login-guard-text.js';
import {
  AccountError,
  addAccount,
  assertNotDuplicate,
  createLocalGuard,
} from '../../src/core/accounts.js';
import type { AuthUser, LogoutResult } from '../../src/core/auth.js';
import { CredentialError, LocalCredentialProvider } from '../../src/core/credentials.js';
import { RepoError } from '../../src/core/db/repos.js';
import type {
  AccountsRepo,
  AuditEntry,
  AuditRepo,
  MailAccount,
  NewMailAccount,
} from '../../src/core/db/repos.js';
import { ImapSessionError } from '../../src/core/imap/errors.js';
import type { ImapFailureReason } from '../../src/core/imap/errors.js';
import { buildServerFeatures, sanitizeCapabilities } from '../../src/core/imap/features.js';
import type { ImapSession, OpenSessionOptions } from '../../src/core/imap/session.js';
import { MemoryEventLog } from '../../src/core/log/index.js';
import type { DiscoveryResult, DiscoverySource } from '../../src/core/providers/discover.js';
import { DiscoveryInputError, parseEmail } from '../../src/core/providers/email.js';
import { MemoryRememberedUsers } from '../../src/core/remembered-users.js';
import { COUNTED_REASONS, LoginBlockedError } from '../../src/core/security/login-guard.js';

// M2d-4 add a mailbox, controller: the three calls of the add screen - the lookup, the check
// that the mailbox isn't saved yet, the add - driven with a fake Terminal. Most tests give the
// answers of those calls one by one; the last ones run the core's own assertNotDuplicate and
// addAccount over an in-memory repo, a real login guard and a fake mail server, to see what
// reaches the log. No network, no Mail Manager server. Addresses and hosts are placeholders.

// --- fixtures -------------------------------------------------------------------------------

const ANNA: AuthUser = {
  email: 'anna@example-test-domain.eu',
  userId: '11111111-1111-4111-8111-111111111111',
};
const SCREEN: Screen = { rows: 24, cols: 120 };
const T0 = Date.UTC(2026, 9, 8, 9, 0, 0);
const RUN = '0123456789abcdef';
const ADDRESS = 'canary-box@example-test-domain.eu';
const HOST = 'imap.canary-host.example-test-domain.eu';
const OTHER_HOST = 'imap.canary-other.example-test-domain.eu';
const USERNAME = 'canary-login-name';
/** Typed into the password field: in no frame, no state after it was sent, no log line. */
const PASSWORD = 'Zx9#Qw7$Lk2!vJ5^';
const WRONG_PASSWORD = 'W%0nG~Kq8&Yt3';
const NEW_ID = '33333333-3333-4333-8333-333333333333';
const FIELD = 'E-mail of the mailbox:';
const PASSWORD_LINE = 'Password:  (nothing is shown while you type)';
const CHECKING_SAVED = 'Checking your saved mailboxes...';
const CHECKING_LOGIN = 'Checking the login...';
const CHALLENGE = 'Several wrong passwords - waiting 5 seconds before trying again.';
const EMAIL = parseEmail(ADDRESS);

const FOUND: DiscoveryResult = {
  email: EMAIL,
  notices: [],
  tried: [],
  status: 'found',
  source: 'ispdb',
  via: 'canary-host.example-test-domain.eu',
  imap: { host: HOST, port: 993, username: ADDRESS },
  altHosts: [],
};
const MANUAL: DiscoveryResult = { email: EMAIL, notices: [], tried: [], status: 'manual' };

function account(id: string, email: string, over: Partial<MailAccount> = {}): MailAccount {
  return {
    id,
    userId: ANNA.userId,
    label: null,
    email,
    provider: 'custom',
    host: HOST,
    port: 993,
    username: email,
    authType: 'password',
    secret: { ciphertext: 'CIPHERTEXT', iv: 'IV', tag: 'TAG', keyVersion: 1 },
    capabilities: null,
    createdAt: new Date(T0),
    updatedAt: new Date(T0),
    lastCheckedAt: null,
    ...over,
  };
}

const BOX = account('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'box@example-test-domain.eu');
const ADDED = account(NEW_ID, ADDRESS);

const k = (name: string, extra: Keypress = {}): Keypress => ({ name, sequence: name, ...extra });
const ENTER = k('return', { sequence: '\r' });
const DOWN = k('down', { sequence: '\u001b[B' });
const TAB = k('tab', { sequence: '\t' });
const ESC = k('escape', { meta: true, sequence: '\u001b' });
const CTRL_C = k('c', { ctrl: true, sequence: '\u0003' });
const CTRL_U = k('u', { ctrl: true, sequence: '\u0015' });
const ch = (text: string): Keypress => ({ name: text.toLowerCase(), sequence: text });

// --- fakes ----------------------------------------------------------------------------------

interface FakeTerminal extends Terminal {
  readonly frames: Rendered[];
  screen: Screen;
  key(key: Keypress): void;
}

function fakeTerminal(screen: Screen): FakeTerminal {
  let keyHandler: ((key: Keypress) => void) | null = null;
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
    onResize: () => undefined,
    restore: vi.fn<() => void>(),
    close: vi.fn<() => void>(),
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

/** Lets every pending microtask and the I/O queue run. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function stillRunning(p: Promise<unknown>): Promise<boolean> {
  return Promise.race([p.then(() => false), settle().then(() => true)]);
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

type AssertNotSaved = AppDeps['assertNotSaved'];
type AddMailbox = AppDeps['addMailbox'];

/** One lookup: the address it was asked for, its progress callback, its answer for the test. */
interface Lookup extends Deferred<DiscoveryResult> {
  address: string;
  progress: (source: DiscoverySource) => void;
}

interface Check extends Deferred<void> {
  asked: Parameters<AssertNotSaved>[0];
}

interface Add extends Deferred<MailAccount> {
  asked: Parameters<AddMailbox>[0];
  onChallenge: () => Promise<void>;
}

type Opener = (options: OpenSessionOptions) => Promise<ImapSession>;

function fakeRepo(initial: readonly MailAccount[]) {
  const rows = new Map<string, MailAccount>(initial.map((a) => [a.id, a]));
  return {
    rows,
    create: vi.fn<AccountsRepo['create']>((a: NewMailAccount) => {
      const row = account(a.id, a.email.toLowerCase(), {
        userId: a.userId,
        provider: a.provider,
        host: a.host,
        username: a.username,
        secret: a.secret,
      });
      rows.set(a.id, row);
      return Promise.resolve(row);
    }),
    list: vi.fn<AccountsRepo['list']>(() => Promise.resolve([...rows.values()])),
    get: vi.fn<AccountsRepo['get']>((id) => Promise.resolve(rows.get(id) ?? null)),
    findByEmail: vi.fn<AccountsRepo['findByEmail']>((email) =>
      Promise.resolve([...rows.values()].filter((r) => r.email === email.toLowerCase())),
    ),
    updateSecret: vi.fn<AccountsRepo['updateSecret']>(() => Promise.resolve(false)),
    recordCheck: vi.fn<AccountsRepo['recordCheck']>((id) => Promise.resolve(rows.has(id))),
    remove: vi.fn<AccountsRepo['remove']>((id) => Promise.resolve(rows.delete(id))),
  } satisfies AccountsRepo & { rows: Map<string, MailAccount> };
}

function fakeAudit() {
  const entries: AuditEntry[] = [];
  return {
    entries,
    write: vi.fn<AuditRepo['write']>((entry) => {
      entries.push(entry);
      return Promise.resolve();
    }),
    listRecent: vi.fn<AuditRepo['listRecent']>(() => Promise.resolve({ records: [], skipped: 0 })),
  } satisfies AuditRepo & { entries: AuditEntry[] };
}

/** The core behind the two calls: an in-memory repo, a real guard, a fake mail server. */
interface Core {
  repo: ReturnType<typeof fakeRepo>;
  audit: ReturnType<typeof fakeAudit>;
  /** The mail server: one call per login that was really made. */
  server: ReturnType<typeof vi.fn<Opener>>;
}

interface Harness {
  t: FakeTerminal;
  app: App;
  done: Promise<AppResult>;
  log: MemoryEventLog;
  /** The saved mailboxes the list shows: a test adds to it what a fake add "saved". */
  saved: MailAccount[];
  listMailboxes: ReturnType<typeof vi.fn<AppDeps['listMailboxes']>>;
  onUnexpected: ReturnType<typeof vi.fn<(err: unknown) => void>>;
  lookups: Lookup[];
  checks: Check[];
  adds: Add[];
  core: Core | null;
}

interface Options {
  mailboxes?: readonly MailAccount[];
  /** The mailbox list instead of the saved ones. */
  listMailboxes?: AppDeps['listMailboxes'];
  addProblem?: string;
  challengeDelayMs?: number;
  /** `addMailbox` throws this instead of returning a promise. */
  addThrows?: Error;
  /** The real assertNotDuplicate and addAccount; the fake server accepts these passwords. */
  core?: { accepts: readonly string[] };
}

function makeHarness(o: Options = {}): Harness {
  const t = fakeTerminal(SCREEN);
  const log = new MemoryEventLog({ run: RUN, ver: '0.9.0', now: () => T0, level: 'debug' });
  const saved = [...(o.mailboxes ?? [BOX])];
  const lookups: Lookup[] = [];
  const checks: Check[] = [];
  const adds: Add[] = [];
  let core: Core | null = null;
  let assertNotSaved: AssertNotSaved = (asked) => {
    const check: Check = { asked, ...deferred<void>() };
    checks.push(check);
    return check.promise;
  };
  let addMailbox: AddMailbox = (asked, onChallenge) => {
    if (o.addThrows !== undefined) throw o.addThrows;
    const add: Add = { asked, onChallenge, ...deferred<MailAccount>() };
    adds.push(add);
    return add.promise;
  };
  let list: AppDeps['listMailboxes'] = () => Promise.resolve([...saved]);
  if (o.core !== undefined) {
    const accepts = new Set(o.core.accepts);
    const repo = fakeRepo(saved);
    const audit = fakeAudit();
    const caps = sanitizeCapabilities({ IMAP4REV1: true, UIDPLUS: true });
    const session = {
      capabilities: caps,
      features: buildServerFeatures(caps, new Set()),
      logout: () => Promise.resolve(),
    } as unknown as ImapSession;
    const server = vi.fn<Opener>((options) =>
      accepts.has(options.password)
        ? Promise.resolve(session)
        : Promise.reject(new ImapSessionError('auth-failed')),
    );
    const store = { repo, audit, log, runId: RUN, now: () => T0 };
    const credentials = new LocalCredentialProvider({
      masterKey: randomBytes(32),
      masterKeyVersion: 1,
    });
    const guard = createLocalGuard(randomBytes(32), log);
    core = { repo, audit, server };
    assertNotSaved = (asked) => assertNotDuplicate(store, asked);
    addMailbox = (asked, onChallenge) =>
      addAccount(
        { ...store, credentials, guard, clientVersion: '0.9.0', onChallenge, open: server },
        asked,
      );
    list = () => repo.list();
  }
  const listMailboxes = vi.fn<AppDeps['listMailboxes']>(o.listMailboxes ?? list);
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
    findAccount: () => new Promise<MailAccount>(() => undefined),
    openSession: () => Promise.reject(new Error('no mailbox login in these tests')),
    readLogs: NO_LOGS,
    discover: (address, progress) => {
      const lookup: Lookup = { address, progress, ...deferred<DiscoveryResult>() };
      lookups.push(lookup);
      return lookup.promise;
    },
    assertNotSaved,
    addMailbox,
    autoStats: false,
    timeZone: 'UTC',
    ...(o.addProblem !== undefined && { addProblem: o.addProblem }),
    ...(o.challengeDelayMs !== undefined && { challengeDelayMs: o.challengeDelayMs }),
  });
  return {
    t,
    app,
    done: app.run(),
    log,
    saved,
    listMailboxes,
    onUnexpected,
    lookups,
    checks,
    adds,
    core,
  };
}

// --- the driver -----------------------------------------------------------------------------

function lastFrame(h: Harness): Rendered {
  const frame = h.t.frames.at(-1);
  if (frame === undefined) throw new Error('nothing drawn yet');
  return frame;
}

const last = (h: Harness): string => lastFrame(h).lines.join('\n');
const status = (h: Harness): string => (lastFrame(h).lines.at(-2) ?? '').trimEnd();
/** The frame as one line of words: wrapped text reads as it was written. */
const flat = (h: Harness): string => last(h).replace(/\s+/g, ' ');
/** A text of the CLI as the app draws it, in one line of words. */
const drawn = (text: string): string => asciiText(text).replace(/\s+/g, ' ');

async function press(h: Harness, ...keys: Keypress[]): Promise<void> {
  for (const key of keys) {
    h.t.key(key);
    await settle();
  }
}

async function typeText(h: Harness, text: string): Promise<void> {
  await press(h, ...[...text].map(ch));
}

async function ready(h: Harness, needle: string): Promise<void> {
  await vi.waitFor(() => {
    expect(last(h)).toContain(needle);
  });
}

function only<T>(calls: readonly T[]): T {
  expect(calls).toHaveLength(1);
  return calls[0] as T;
}

function latest<T>(calls: readonly T[]): T {
  const call = calls.at(-1);
  if (call === undefined) throw new Error('no such call yet');
  return call;
}

/** ANNA on Home with her mailboxes listed, the cursor on "+ Add a mailbox". */
async function atHome(o: Options = {}): Promise<Harness> {
  const h = makeHarness(o);
  await ready(h, 'Sign in as another user');
  await press(h, ENTER);
  await ready(h, 'Log out');
  if (o.listMailboxes === undefined) {
    await ready(h, h.saved[0]?.email ?? 'No mailboxes yet');
    await press(h, ...h.saved.map(() => DOWN));
  }
  return h;
}

/** The address field. */
async function atAddress(o: Options = {}): Promise<Harness> {
  const h = await atHome(o);
  await press(h, ENTER);
  expect(last(h)).toContain(FIELD);
  return h;
}

/** The address sent: the lookup is under way. */
async function looking(o: Options = {}, address = ADDRESS): Promise<Harness> {
  const h = await atAddress(o);
  await typeText(h, address);
  await press(h, ENTER);
  expect(status(h)).toBe('Looking up settings...');
  return h;
}

/** The lookup answered with `result`. */
async function found(o: Options = {}, result: DiscoveryResult = FOUND): Promise<Harness> {
  const h = await looking(o);
  latest(h.lookups).resolve(result);
  await settle();
  return h;
}

/** The settings are used: the check is under way (answered by the core, when it is the core). */
async function checkingSaved(o: Options = {}): Promise<Harness> {
  const h = await found(o);
  await press(h, ENTER);
  if (h.core === null) expect(status(h)).toBe(CHECKING_SAVED);
  return h;
}

/** The password field. */
async function atPassword(o: Options = {}): Promise<Harness> {
  const h = await checkingSaved(o);
  if (h.core === null) latest(h.checks).resolve();
  await ready(h, PASSWORD_LINE);
  return h;
}

/** `password` typed and sent: the add is under way. */
async function sent(o: Options = {}, password = PASSWORD): Promise<Harness> {
  const h = await atPassword(o);
  await typeText(h, password);
  await press(h, ENTER);
  return h;
}

async function quit(h: Harness, key: Keypress = ch('q')): Promise<void> {
  await press(h, key);
  await expect(h.done).resolves.toEqual({ end: key === CTRL_C ? 'interrupt' : 'quit' });
  // An add still under way would keep settled() waiting: the test is over, so is the add.
  for (const add of h.adds) add.reject(new Error('the test is over'));
  await h.app.settled();
}

/** No frame of the run shows `secret`, or three characters in a row of it. */
function expectNeverDrawn(h: Harness, secret: string): void {
  for (const frame of h.t.frames) {
    const text = frame.lines.join('\n');
    for (let i = 0; i + 3 <= secret.length; i++) expect(text).not.toContain(secret.slice(i, i + 3));
  }
}

// --- opening --------------------------------------------------------------------------------

describe('Enter on "+ Add a mailbox" (A1)', () => {
  it('shows the address field and asks nobody anything', async () => {
    const h = await atAddress();
    expect(last(h)).toContain('Mail Manager - Add a mailbox');
    expect(h.lookups).toHaveLength(0);
    expect(h.checks).toHaveLength(0);
    expect(h.adds).toHaveLength(0);
    expect(h.listMailboxes).toHaveBeenCalledTimes(1);
    await quit(h, CTRL_C);
  });

  it('with an `addProblem`: only its text - no field, no call, whatever is pressed', async () => {
    const problem = 'MM_MASTER_KEY is not set - fix it in .env.local.';
    const h = await atHome({ addProblem: problem });
    await press(h, ENTER);
    expect(last(h)).toContain(problem);
    expect(last(h)).not.toContain(FIELD);
    await press(h, ch('a'), ENTER, ch('y'), ch('c'), ch('m'), TAB);
    expect(last(h)).toContain(problem);
    expect(h.lookups).toHaveLength(0);
    expect(h.checks).toHaveLength(0);
    expect(h.adds).toHaveLength(0);
    // Esc: Home again, and q quits from there as from here.
    await press(h, ESC);
    expect(last(h)).toContain('Log out');
    await press(h, ENTER);
    await quit(h);
  });

  it('a message of the address check is shown, and nothing is looked up', async () => {
    const h = await atAddress();
    await press(h, ENTER);
    expect(status(h)).toBe('Type the e-mail address of the mailbox.');
    await typeText(h, 'not-an-address');
    await press(h, ENTER);
    expect(status(h)).toBe('Email address must contain "@"');
    expect(h.lookups).toHaveLength(0);
    await quit(h, CTRL_C);
  });

  it('Esc from the field: Home as it was, the list not asked for again', async () => {
    const h = await atAddress();
    await typeText(h, 'half@');
    await press(h, ESC);
    expect(last(h)).toContain('Log out');
    expect(last(h)).toContain(BOX.email);
    expect(h.listMailboxes).toHaveBeenCalledTimes(1);
    // The cursor is still on "+ Add a mailbox": Enter opens an empty field.
    await press(h, ENTER);
    expect(last(h)).toContain(`${FIELD} _`);
    await quit(h, CTRL_C);
  });

  it('opened while the mailbox list was still loading: back on Home the list is asked for again', async () => {
    const first = deferred<readonly MailAccount[]>();
    const lists = [first.promise];
    const h = await atHome({ listMailboxes: () => lists.shift() ?? Promise.resolve([BOX]) });
    expect(last(h)).toContain('Loading your mailboxes...');
    // No mailbox rows yet: "+ Add a mailbox" is the first row.
    await press(h, ENTER);
    expect(last(h)).toContain(FIELD);
    first.resolve([BOX]);
    await settle();
    expect(last(h)).toContain(FIELD);
    await press(h, ESC);
    expect(h.listMailboxes).toHaveBeenCalledTimes(2);
    await ready(h, BOX.email);
    await quit(h);
  });
});

// --- the lookup -----------------------------------------------------------------------------

describe('the lookup (A2)', () => {
  it('one call with the address as typed, without the spaces around it', async () => {
    const h = await looking({}, `  ${ADDRESS} `);
    expect(only(h.lookups).address).toBe(ADDRESS);
    await quit(h);
  });

  it('progress names the source that is asked', async () => {
    const h = await looking();
    only(h.lookups).progress('preset-mx');
    await settle();
    expect(status(h)).toBe('Looking up settings... checking built-in preset (MX record)');
    only(h.lookups).progress('ispdb');
    await settle();
    expect(status(h)).toBe('Looking up settings... checking Mozilla ISPDB');
    await quit(h);
  });

  it('the answer: what was found, and nothing checked or added yet', async () => {
    const h = await found();
    expect(flat(h)).toContain(`Server: ${HOST}:993 (TLS)`);
    expect(flat(h)).toContain(`Username: ${ADDRESS}`);
    expect(flat(h)).toContain('Found via: Mozilla ISPDB - canary-host.example-test-domain.eu');
    expect(h.checks).toHaveLength(0);
    expect(h.adds).toHaveLength(0);
    await quit(h);
  });

  it('nothing found: the page that says so', async () => {
    const h = await found({}, MANUAL);
    expect(last(h)).toContain('No IMAP settings found for example-test-domain.eu.');
    await quit(h);
  });

  it('Esc while it runs: the address field; what the lookup still says changes nothing', async () => {
    const h = await looking();
    await press(h, ESC);
    expect(last(h)).toContain(`${FIELD} ${ADDRESS}_`);
    const frames = h.t.frames.length;
    only(h.lookups).progress('srv');
    only(h.lookups).resolve(FOUND);
    await settle();
    expect(h.t.frames).toHaveLength(frames);
    expect(last(h)).toContain(`${FIELD} ${ADDRESS}_`);
    // Enter looks it up again: a second call, and its answer counts.
    await press(h, ENTER);
    expect(h.lookups).toHaveLength(2);
    latest(h.lookups).resolve(MANUAL);
    await settle();
    expect(last(h)).toContain('No IMAP settings found');
    await quit(h);
  });

  it('a lookup that refuses the address after all: its message, and the way back', async () => {
    const h = await looking();
    only(h.lookups).reject(new DiscoveryInputError('Email address is too long'));
    await settle();
    expect(last(h)).toContain('Email address is too long');
    expect(last(h)).not.toContain(FIELD);
    await press(h, ESC);
    expect(last(h)).toContain('Log out');
    await quit(h);
  });

  it('a lookup that fails for a reason of its own ends the app with it', async () => {
    const h = await looking();
    const boom = new Error('resolver broke');
    only(h.lookups).reject(boom);
    await expect(h.done).rejects.toBe(boom);
    await h.app.settled();
    expect(h.log.records).toEqual([]);
  });

  it('after the app has ended an answer draws nothing', async () => {
    const h = await looking();
    await quit(h);
    const frames = h.t.frames.length;
    only(h.lookups).progress('srv');
    only(h.lookups).resolve(FOUND);
    await settle();
    expect(h.t.frames).toHaveLength(frames);
  });
});

// --- saved already? -------------------------------------------------------------------------

describe('is the mailbox saved already? (A7)', () => {
  it('asked once the settings are used: the address in its stored form, host and provider', async () => {
    const h = await checkingSaved();
    expect(only(h.checks).asked).toEqual({ email: EMAIL.address, host: HOST, provider: 'custom' });
    expect(h.adds).toHaveLength(0);
    await quit(h);
  });

  it('not saved: the password field', async () => {
    const h = await atPassword();
    expect(last(h)).toContain(PASSWORD_LINE);
    expect(flat(h)).toContain(`Server: ${HOST}:993 (TLS)`);
    expect(h.adds).toHaveLength(0);
    await quit(h, CTRL_C);
  });

  it('saved already: its text, no password asked, nothing added', async () => {
    const h = await checkingSaved();
    const duplicate = new AccountError('duplicate', BOX.id);
    only(h.checks).reject(duplicate);
    await settle();
    expect(flat(h)).toContain(drawn(accountErrorText(duplicate)));
    expect(flat(h)).toContain('This mailbox is already saved (id aaaaaaaa).');
    expect(last(h)).not.toContain('Password:');
    await press(h, ENTER, ch('y'), ch('x'));
    expect(h.adds).toHaveLength(0);
    await press(h, ESC);
    expect(last(h)).toContain('Log out');
    expect(h.listMailboxes).toHaveBeenCalledTimes(1);
    await quit(h);
  });

  it('the check fails with a text of its own: that text', async () => {
    const h = await checkingSaved();
    only(h.checks).reject(new RepoError('unavailable', "Can't reach Mail Manager right now."));
    await settle();
    expect(last(h)).toContain("Can't reach Mail Manager right now.");
    expect(last(h)).not.toContain('Password:');
    expect(await stillRunning(h.done)).toBe(true);
    await quit(h);
  });

  it('the check fails for a reason of its own: the app ends with it', async () => {
    const h = await checkingSaved();
    const boom = new Error('repo broke');
    only(h.checks).reject(boom);
    await expect(h.done).rejects.toBe(boom);
    await h.app.settled();
  });

  it('Esc while it runs: back where the server was chosen; the answer changes nothing', async () => {
    const h = await checkingSaved();
    await press(h, ESC);
    expect(flat(h)).toContain('Found via: Mozilla ISPDB');
    expect(status(h)).toBe('');
    const frames = h.t.frames.length;
    only(h.checks).resolve();
    await settle();
    expect(h.t.frames).toHaveLength(frames);
    expect(last(h)).not.toContain('Password:');
    // Used again: a second check.
    await press(h, ENTER);
    expect(h.checks).toHaveLength(2);
    await quit(h);
  });
});

// --- the add --------------------------------------------------------------------------------

describe('the password is sent once, to the add (A8)', () => {
  it('Enter on an empty field sends nothing', async () => {
    const h = await atPassword();
    await press(h, ENTER);
    expect(status(h)).toBe('Type the password.');
    expect(h.adds).toHaveLength(0);
    await quit(h, CTRL_C);
  });

  it('one call: the signed-in user, the address, the server, the provider, the password', async () => {
    const h = await sent();
    expect(only(h.adds).asked).toEqual({
      userId: ANNA.userId,
      email: EMAIL.address,
      settings: { host: HOST, port: 993, username: ADDRESS },
      provider: 'custom',
      password: PASSWORD,
    });
    expect(status(h)).toBe(CHECKING_LOGIN);
    await quit(h, CTRL_C);
  });

  it('what was typed is sent as typed: Backspace and Ctrl+U count, spaces stay', async () => {
    const h = await atPassword();
    await typeText(h, 'wrong start');
    await press(h, CTRL_U);
    await typeText(h, ' pass wordX');
    await press(h, k('backspace', { sequence: '\u007f' }), ENTER);
    expect(only(h.adds).asked.password).toBe(' pass word');
    await quit(h, CTRL_C);
  });

  it('no key acts while it runs - Esc, q, Enter: still one call, the same frame', async () => {
    const h = await sent();
    const before = lastFrame(h);
    await press(h, ESC, ch('q'), ENTER, ch('x'), TAB, DOWN);
    expect(h.adds).toHaveLength(1);
    expect(lastFrame(h)).toEqual(before);
    expect(await stillRunning(h.done)).toBe(true);
    await quit(h, CTRL_C);
  });

  it('after it was sent the password is in no state and no frame', async () => {
    const h = await atPassword();
    await typeText(h, PASSWORD);
    // While it is typed it is in the state - and nowhere on screen.
    expect(JSON.stringify(h.app.state)).toContain(PASSWORD);
    await press(h, ENTER);
    expect(JSON.stringify(h.app.state)).not.toContain(PASSWORD);
    only(h.adds).reject(new ImapSessionError('auth-failed'));
    await ready(h, PASSWORD_LINE);
    expect(JSON.stringify(h.app.state)).not.toContain(PASSWORD);
    await typeText(h, PASSWORD);
    await press(h, ENTER);
    expect(h.adds).toHaveLength(2);
    h.saved.push(ADDED);
    latest(h.adds).resolve(ADDED);
    await ready(h, `Added ${ADDRESS}.`);
    expect(JSON.stringify(h.app.state)).not.toContain(PASSWORD);
    expectNeverDrawn(h, PASSWORD);
    expect(h.log.lines.join('\n')).not.toContain(PASSWORD);
    await quit(h);
  });

  it('Esc from the field drops it: nothing is sent, and it is in no state', async () => {
    const h = await atPassword();
    await typeText(h, PASSWORD);
    await press(h, ESC);
    expect(JSON.stringify(h.app.state)).not.toContain(PASSWORD);
    expect(flat(h)).toContain('Found via:');
    // Back again: the field is empty.
    await press(h, ENTER);
    latest(h.checks).resolve();
    await ready(h, PASSWORD_LINE);
    await press(h, ENTER);
    expect(status(h)).toBe('Type the password.');
    expect(h.adds).toHaveLength(0);
    expectNeverDrawn(h, PASSWORD);
    await quit(h, CTRL_C);
  });
});

describe('saved (A10)', () => {
  it('Home with the list read again, the cursor on the new mailbox, "Added <address>."', async () => {
    const h = await sent();
    h.saved.push(ADDED);
    only(h.adds).resolve(ADDED);
    await ready(h, `Added ${ADDRESS}.`);
    await ready(h, '2 mailboxes');
    expect(h.listMailboxes).toHaveBeenCalledTimes(2);
    const frame = lastFrame(h);
    expect(frame.lines[frame.cursorLine ?? 0]).toContain(ADDRESS);
    expect(status(h)).toBe(`Added ${ADDRESS}.`);
    // The next key takes the message away.
    await press(h, DOWN);
    expect(status(h)).toBe('');
    expect(h.adds).toHaveLength(1);
    expect(h.log.records).toEqual([]);
    await quit(h);
  });

  it('the list does not have it after all: the first row', async () => {
    const h = await sent();
    only(h.adds).resolve(ADDED);
    await ready(h, `Added ${ADDRESS}.`);
    await ready(h, '1 mailbox');
    expect(lastFrame(h).cursorLine).toBe(1);
    await quit(h);
  });

  it('the list cannot be read again: its message, and the mailbox is saved all the same', async () => {
    const lists: (() => Promise<readonly MailAccount[]>)[] = [
      () => Promise.resolve([BOX]),
      () => Promise.reject(new RepoError('unavailable', 'down')),
    ];
    const h = await atHome({
      listMailboxes: () => (lists.shift() ?? (() => Promise.resolve([BOX])))(),
    });
    await ready(h, BOX.email);
    await press(h, DOWN, ENTER);
    await typeText(h, ADDRESS);
    await press(h, ENTER);
    latest(h.lookups).resolve(FOUND);
    await settle();
    await press(h, ENTER);
    latest(h.checks).resolve();
    await ready(h, PASSWORD_LINE);
    await typeText(h, PASSWORD);
    await press(h, ENTER);
    only(h.adds).resolve(ADDED);
    await ready(h, "Couldn't load your mailboxes");
    expect(await stillRunning(h.done)).toBe(true);
    await quit(h);
  });
});

// --- the retry classification (A9) ----------------------------------------------------------

describe('a login that was rejected (A9)', () => {
  /** Every reason a login can fail with: another password may fix it, or it ends the add. */
  const KIND: Record<ImapFailureReason, 'again' | 'final'> = {
    'auth-failed': 'again',
    'app-password-required': 'again',
    'password-expired': 'again',
    'contact-admin': 'again',
    'server-rejected': 'again',
    'invalid-credentials-input': 'again',
    'oauth-only': 'final',
    'host-not-found': 'final',
    'no-internet': 'final',
    unreachable: 'final',
    refused: 'final',
    reset: 'final',
    timeout: 'final',
    'tls-certificate': 'final',
    'server-unavailable': 'final',
    throttled: 'final',
    'unsupported-server': 'final',
    unexpected: 'final',
  };
  const reasons = Object.keys(KIND) as ImapFailureReason[];
  const RETRYABLE = reasons.filter((reason) => KIND[reason] === 'again');
  const FINAL = reasons.filter((reason) => KIND[reason] === 'final');

  it('the reasons another password may fix are the counted ones and unusable input', () => {
    expect(new Set(RETRYABLE)).toEqual(new Set([...COUNTED_REASONS, 'invalid-credentials-input']));
    expect(RETRYABLE).toHaveLength(6);
    expect(FINAL).toHaveLength(12);
  });

  it.each(RETRYABLE)('%s: the password field again, empty, with its text', async (reason) => {
    const h = await sent({}, WRONG_PASSWORD);
    only(h.adds).reject(new ImapSessionError(reason));
    await ready(h, PASSWORD_LINE);
    expect(flat(h)).toContain(drawn(imapErrorText(reason, { kind: 'this-computer' })));
    expect(status(h)).not.toBe(CHECKING_LOGIN);
    // Nothing is tried again by itself - and Enter on the empty field sends nothing either.
    await settle();
    await press(h, ENTER);
    expect(h.adds).toHaveLength(1);
    // A second password is a second call.
    await typeText(h, PASSWORD);
    await press(h, ENTER);
    expect(h.adds).toHaveLength(2);
    expect(latest(h.adds).asked.password).toBe(PASSWORD);
    expect(latest(h.adds).asked.settings).toEqual({ host: HOST, port: 993, username: ADDRESS });
    expectNeverDrawn(h, WRONG_PASSWORD);
    await quit(h, CTRL_C);
  });

  it.each(FINAL)('%s: its text on the failed screen - no field, no second try', async (reason) => {
    const h = await sent();
    const failure = new ImapSessionError(reason);
    only(h.adds).reject(failure);
    await ready(h, 'Esc back');
    expect(flat(h)).toContain(drawn(accountErrorText(failure)));
    expect(last(h)).not.toContain('Password:');
    await press(h, ENTER, ch('y'), ch('r'));
    expect(h.adds).toHaveLength(1);
    await press(h, ESC);
    expect(last(h)).toContain('Log out');
    expect(h.listMailboxes).toHaveBeenCalledTimes(1);
    await quit(h);
  });

  it.each<[string, () => Error]>([
    ['the login guard blocked it', () => new LoginBlockedError('too-many-attempts', new Date(T0))],
    ['this connection is blocked', () => new LoginBlockedError('permanent', null)],
    ['saved meanwhile in another window', () => new AccountError('duplicate')],
    ['Mail Manager cannot be reached', () => new RepoError('unavailable', "Can't save right now.")],
    ['the key is gone', () => new CredentialError('MM_MASTER_KEY is not set')],
  ])('%s: its text on the failed screen', async (_name, make) => {
    const h = await sent();
    const failure = make();
    only(h.adds).reject(failure);
    await ready(h, 'Esc back');
    const text =
      failure instanceof LoginBlockedError ? loginBlockedText(failure) : accountErrorText(failure);
    expect(flat(h)).toContain(drawn(text));
    expect(last(h)).not.toContain('Password:');
    expect(await stillRunning(h.done)).toBe(true);
    await press(h, ESC);
    expect(last(h)).toContain('Log out');
    await quit(h);
  });

  it('a failure that has no text for the user ends the app with it', async () => {
    const h = await sent();
    const boom = new Error('something broke');
    const crashed = expect(h.done).rejects.toBe(boom);
    only(h.adds).reject(boom);
    await crashed;
    await h.app.settled();
    expect(h.onUnexpected).not.toHaveBeenCalled();
    expectNeverDrawn(h, PASSWORD);
  });

  it('an add that throws at once is a failure like any other', async () => {
    const boom = new Error('threw at once');
    const h = await atPassword({ addThrows: boom });
    await typeText(h, PASSWORD);
    const crashed = expect(h.done).rejects.toBe(boom);
    await press(h, ENTER);
    await crashed;
    await h.app.settled();
    const shown = await atPassword({ addThrows: new AccountError('duplicate') });
    await typeText(shown, PASSWORD);
    await press(shown, ENTER);
    await ready(shown, 'This mailbox is already saved.');
    await quit(shown);
  });
});

// --- the login guard's wait -----------------------------------------------------------------

describe("the login guard's wait (A9)", () => {
  it('its notice instead of "Checking the login...", until the wait is over', async () => {
    const h = await sent({ challengeDelayMs: 40 });
    expect(status(h)).toBe(CHECKING_LOGIN);
    let waited = false;
    const wait = only(h.adds)
      .onChallenge()
      .then(() => {
        waited = true;
      });
    await settle();
    expect(status(h)).toBe(CHALLENGE);
    expect(waited).toBe(false);
    // No key ends it early.
    await press(h, ESC, ENTER, ch('q'));
    expect(status(h)).toBe(CHALLENGE);
    expect(waited).toBe(false);
    await wait;
    expect(status(h)).toBe(CHECKING_LOGIN);
    h.saved.push(ADDED);
    only(h.adds).resolve(ADDED);
    await ready(h, `Added ${ADDRESS}.`);
    await quit(h);
  });

  it('a rejection after the wait: the password field, and the notice is gone', async () => {
    const h = await sent({ challengeDelayMs: 10 });
    await only(h.adds).onChallenge();
    only(h.adds).reject(new ImapSessionError('auth-failed'));
    await ready(h, PASSWORD_LINE);
    expect(last(h)).not.toContain(CHALLENGE);
    await quit(h, CTRL_C);
  });

  it('Ctrl+C during the wait ends the app: no login is made, and the add is abandoned, not failed', async () => {
    const h = await sent({ challengeDelayMs: 60_000 });
    const wait = only(h.adds).onChallenge();
    let outcome = 'pending';
    wait.then(
      () => {
        outcome = 'resolved';
      },
      () => {
        outcome = 'rejected';
      },
    );
    await settle();
    expect(status(h)).toBe(CHALLENGE);
    await press(h, CTRL_C);
    await expect(h.done).resolves.toEqual({ end: 'interrupt' });
    // Nothing of the add is in flight: settled() does not wait for it, not even for the cap.
    const started = Date.now();
    await h.app.settled();
    expect(Date.now() - started).toBeLessThan(3000);
    // The wait is never answered: the core is told nothing, so it neither logs nor audits.
    await settle();
    expect(outcome).toBe('pending');
  });
});

// --- the end of the app while it runs -------------------------------------------------------

describe('Ctrl+C while the login is checked', () => {
  it('ends the app at once; settled() waits for the add, which may still save', async () => {
    const h = await sent();
    await press(h, CTRL_C);
    await expect(h.done).resolves.toEqual({ end: 'interrupt' });
    let settled = false;
    const waiting = h.app.settled().then(() => {
      settled = true;
    });
    await settle();
    await settle();
    expect(settled).toBe(false);
    const frames = h.t.frames.length;
    only(h.adds).resolve(ADDED);
    await waiting;
    expect(settled).toBe(true);
    // Nothing is drawn or asked for after the end.
    expect(h.t.frames).toHaveLength(frames);
    expect(h.listMailboxes).toHaveBeenCalledTimes(1);
  });

  it('a failure that arrives after the end is nobody to tell - also one without a text', async () => {
    for (const failure of [new ImapSessionError('auth-failed'), new Error('late and unknown')]) {
      const h = await sent();
      await press(h, CTRL_C);
      await expect(h.done).resolves.toEqual({ end: 'interrupt' });
      const frames = h.t.frames.length;
      only(h.adds).reject(failure);
      await h.app.settled();
      expect(h.t.frames).toHaveLength(frames);
      await expect(h.done).resolves.toEqual({ end: 'interrupt' });
      expect(h.onUnexpected).not.toHaveBeenCalled();
    }
  });

  it('settled() does not wait for the lookup or the check', async () => {
    const lookingUp = await looking();
    await press(lookingUp, CTRL_C);
    await lookingUp.app.settled();
    const checkingIt = await checkingSaved();
    await press(checkingIt, CTRL_C);
    await checkingIt.app.settled();
  });
});

// --- nothing is logged here -----------------------------------------------------------------

describe('the controller writes no log line for an add', () => {
  it('a whole add with a rejection in it: the log stays empty', async () => {
    const h = await sent({}, WRONG_PASSWORD);
    only(h.adds).reject(new ImapSessionError('auth-failed'));
    await ready(h, PASSWORD_LINE);
    await typeText(h, PASSWORD);
    await press(h, ENTER);
    h.saved.push(ADDED);
    latest(h.adds).resolve(ADDED);
    await ready(h, `Added ${ADDRESS}.`);
    expect(h.log.records).toEqual([]);
    expect(h.onUnexpected).not.toHaveBeenCalled();
    await quit(h);
    expect(h.log.records).toEqual([]);
  });
});

// --- the core behind the calls (A12) --------------------------------------------------------

describe('with the core behind it: what reaches the log (A12)', () => {
  /** Every line that was logged, and every audit row, as text. */
  function written(h: Harness): string {
    return `${h.log.lines.join('\n')}\n${JSON.stringify(h.core?.audit.entries ?? [])}`;
  }

  function expectNothingTyped(h: Harness): void {
    const text = written(h).toLowerCase();
    for (const typed of [ADDRESS, HOST, OTHER_HOST, USERNAME, PASSWORD, WRONG_PASSWORD]) {
      expect(text).not.toContain(typed.toLowerCase());
    }
    for (const part of ['canary', 'example-test-domain']) {
      expect(text).not.toContain(part);
    }
  }

  it('a wrong password, a second try that works, a duplicate, a server typed by hand', async () => {
    const h = await atPassword({ core: { accepts: [PASSWORD] } });
    const core = h.core;
    if (core === null) throw new Error('no core');

    // 1. The wrong password: the mail server says no, the field comes back.
    await typeText(h, WRONG_PASSWORD);
    await press(h, ENTER);
    await vi.waitFor(() => {
      expect(flat(h)).toContain(drawn(imapErrorText('auth-failed', { kind: 'this-computer' })));
    });
    expect(core.server).toHaveBeenCalledTimes(1);
    expect(core.repo.rows.size).toBe(1);

    // 2. The right one: saved, Home with it under the cursor.
    await typeText(h, PASSWORD);
    await press(h, ENTER);
    await ready(h, `Added ${ADDRESS}.`);
    await ready(h, '2 mailboxes');
    expect(core.server).toHaveBeenCalledTimes(2);
    expect(core.repo.rows.size).toBe(2);
    const saved = [...core.repo.rows.values()].find((row) => row.email === ADDRESS);
    expect(saved).toMatchObject({ host: HOST, username: ADDRESS, provider: 'custom' });
    expect(JSON.stringify(saved)).not.toContain(PASSWORD);
    const frame = lastFrame(h);
    expect(frame.lines[frame.cursorLine ?? 0]).toContain(ADDRESS);

    // 3. The same address and server again: saved already, no password asked.
    await press(h, DOWN, ENTER);
    expect(last(h)).toContain(FIELD);
    await typeText(h, ADDRESS);
    await press(h, ENTER);
    latest(h.lookups).resolve(FOUND);
    await settle();
    await press(h, ENTER);
    await ready(h, 'This mailbox is already saved');
    expect(last(h)).not.toContain('Password:');
    expect(core.server).toHaveBeenCalledTimes(2);
    await press(h, ESC);
    expect(last(h)).toContain('Log out');

    // 4. The same address on a server typed by hand, with a username of its own.
    await press(h, ENTER);
    await typeText(h, ADDRESS);
    await press(h, ENTER);
    latest(h.lookups).resolve(MANUAL);
    await settle();
    await press(h, ch('m'));
    await typeText(h, OTHER_HOST);
    await press(h, ENTER, CTRL_U);
    await typeText(h, USERNAME);
    await press(h, ENTER);
    await ready(h, PASSWORD_LINE);
    expect(flat(h)).toContain(`Server: ${OTHER_HOST}:993 (TLS)`);
    expect(flat(h)).toContain(`Username: ${USERNAME}`);
    await typeText(h, PASSWORD);
    await press(h, ENTER);
    await ready(h, `Added ${ADDRESS}.`);
    await ready(h, '3 mailboxes');
    expect(core.server).toHaveBeenCalledTimes(3);
    expect(core.server.mock.calls.map(([o]) => [o.settings.host, o.settings.username])).toEqual([
      [HOST, ADDRESS],
      [HOST, ADDRESS],
      [OTHER_HOST, USERNAME],
    ]);

    // The log: the core's events only, with ids, a provider id and reason codes.
    expect(h.log.records.map((r) => [r.event, r['outcome'] ?? null, r['reason'] ?? null])).toEqual([
      ['imap.login-failed', null, 'auth-failed'],
      ['account.add', 'failed', 'auth-failed'],
      ['imap.login', null, null],
      ['account.add', 'ok', null],
      ['account.add', 'failed', 'duplicate'],
      ['imap.login', null, null],
      ['account.add', 'ok', null],
    ]);
    for (const record of h.log.records) expect(record['provider']).toBe('custom');
    expect(core.audit.entries.map((e) => [e.action, e.result, e.reason ?? null])).toEqual([
      ['account.add', 'failed', 'auth-failed'],
      ['account.add', 'ok', null],
      ['account.add', 'failed', 'duplicate'],
      ['account.add', 'ok', null],
    ]);
    expect(h.log.lines.length).toBeGreaterThan(0);
    expectNothingTyped(h);
    expectNeverDrawn(h, PASSWORD);
    expectNeverDrawn(h, WRONG_PASSWORD);
    expect(h.onUnexpected).not.toHaveBeenCalled();
    await quit(h);
    expect(h.log.records).toHaveLength(7);
  });

  it('five wrong passwords: the wait before the third, then the block - and nothing by itself', async () => {
    const h = await atPassword({ core: { accepts: [] }, challengeDelayMs: 15 });
    const core = h.core;
    if (core === null) throw new Error('no core');
    const generic = drawn(imapErrorText('auth-failed', { kind: 'this-computer' }));
    for (let attempt = 1; attempt <= 4; attempt++) {
      await typeText(h, `${WRONG_PASSWORD}${String(attempt)}`);
      await press(h, ENTER);
      await vi.waitFor(() => {
        expect(core.server).toHaveBeenCalledTimes(attempt);
        expect(flat(h)).toContain(generic);
        expect(last(h)).toContain(PASSWORD_LINE);
      });
    }
    // The third and the fourth waited for the guard, and the screen said so.
    const notices = h.t.frames.filter((f) => f.lines.join('\n').includes(CHALLENGE));
    expect(notices.length).toBeGreaterThanOrEqual(2);
    expect(h.log.records.filter((r) => r.event === 'login-guard.challenge')).toHaveLength(2);
    // The fifth is the last one: the guard's text, and no field any more.
    await typeText(h, `${WRONG_PASSWORD}5`);
    await press(h, ENTER);
    await ready(h, 'Too many wrong passwords for this mailbox.');
    expect(last(h)).not.toContain('Password:');
    expect(core.server).toHaveBeenCalledTimes(5);
    await press(h, ENTER, ch('y'), ch('r'));
    await settle();
    expect(core.server).toHaveBeenCalledTimes(5);
    expect(core.repo.rows.size).toBe(1);
    const names = h.log.records.map((r) => r.event);
    expect(new Set(names)).toEqual(
      new Set(['imap.login-failed', 'account.add', 'login-guard.challenge', 'login-guard.block']),
    );
    expect(names.filter((n) => n === 'account.add')).toHaveLength(5);
    expectNothingTyped(h);
    expectNeverDrawn(h, WRONG_PASSWORD);
    await press(h, ESC);
    expect(last(h)).toContain('Log out');
    await quit(h);
  });

  it("Ctrl+C during the guard's wait: no third login is made, and the interrupted add is neither logged nor audited", async () => {
    const h = await atPassword({ core: { accepts: [] }, challengeDelayMs: 60_000 });
    const core = h.core;
    if (core === null) throw new Error('no core');
    for (let attempt = 1; attempt <= 2; attempt++) {
      await typeText(h, `${WRONG_PASSWORD}${String(attempt)}`);
      await press(h, ENTER);
      await vi.waitFor(() => {
        expect(core.server).toHaveBeenCalledTimes(attempt);
        expect(last(h)).toContain(PASSWORD_LINE);
      });
    }
    // The third try has to wait for the guard - a minute here, so only Ctrl+C can end it.
    await typeText(h, `${WRONG_PASSWORD}3`);
    await press(h, ENTER);
    await vi.waitFor(() => {
      expect(status(h)).toBe(CHALLENGE);
    });
    await press(h, CTRL_C);
    await expect(h.done).resolves.toEqual({ end: 'interrupt' });
    // Nothing of the add is in flight: settled() does not wait for it, not even for the cap.
    const started = Date.now();
    await h.app.settled();
    expect(Date.now() - started).toBeLessThan(3000);
    expect(core.server).toHaveBeenCalledTimes(2);
    expect(core.repo.rows.size).toBe(1);
    // The interrupted add was never told to the core: no log line and no audit row for it.
    expect(h.log.records.map((r) => [r.event, r['reason'] ?? null])).toEqual([
      ['imap.login-failed', 'auth-failed'],
      ['account.add', 'auth-failed'],
      ['imap.login-failed', 'auth-failed'],
      ['account.add', 'auth-failed'],
      ['login-guard.challenge', null],
    ]);
    expect(core.audit.entries.map((e) => [e.action, e.result, e.reason ?? null])).toEqual([
      ['account.add', 'failed', 'auth-failed'],
      ['account.add', 'failed', 'auth-failed'],
    ]);
    expectNothingTyped(h);
  });

  it('Ctrl+C while the core checks the login: the add is finished before settled() resolves', async () => {
    const h = await atPassword({ core: { accepts: [PASSWORD] } });
    const core = h.core;
    if (core === null) throw new Error('no core');
    const login = deferred<ImapSession>();
    const caps = sanitizeCapabilities({ IMAP4REV1: true });
    core.server.mockImplementationOnce(() => login.promise);
    await typeText(h, PASSWORD);
    await press(h, ENTER);
    await vi.waitFor(() => {
      expect(core.server).toHaveBeenCalledTimes(1);
    });
    await press(h, CTRL_C);
    await expect(h.done).resolves.toEqual({ end: 'interrupt' });
    login.resolve({
      capabilities: caps,
      features: buildServerFeatures(caps, new Set()),
      logout: () => Promise.resolve(),
    } as unknown as ImapSession);
    await h.app.settled();
    // The login worked, so the mailbox is saved and logged - only the screen no longer followed.
    expect(core.repo.rows.size).toBe(2);
    expect(h.log.records.map((r) => r.event)).toEqual(['imap.login', 'account.add']);
    expectNothingTyped(h);
  });
});
