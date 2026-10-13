import { randomBytes } from 'node:crypto';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { createApp } from '../../src/cli/app/controller.js';
import type { App, AppDeps, AppResult } from '../../src/cli/app/controller.js';
import { asciiText } from '../../src/cli/app/state.js';
import { accountErrorText } from '../../src/cli/account-text.js';
import { CHALLENGE_NOTICE } from '../../src/cli/browser/controller.js';
import type { Rendered } from '../../src/cli/browser/render.js';
import type { Keypress, Screen } from '../../src/cli/browser/state.js';
import type { Terminal } from '../../src/cli/browser/terminal.js';
import { imapErrorText } from '../../src/cli/imap-errors.js';
import {
  AccountError,
  addAccount,
  assertNotDuplicate,
  createLocalGuard,
} from '../../src/core/accounts.js';
import type { AuthUser, LogoutResult } from '../../src/core/auth.js';
import { LocalCredentialProvider } from '../../src/core/credentials.js';
import type {
  AccountsRepo,
  AuditEntry,
  AuditRepo,
  MailAccount,
  NewMailAccount,
} from '../../src/core/db/repos.js';
import { ImapSessionError } from '../../src/core/imap/errors.js';
import { buildServerFeatures, sanitizeCapabilities } from '../../src/core/imap/features.js';
import type { ImapSession, OpenSessionOptions } from '../../src/core/imap/session.js';
import { MemoryEventLog } from '../../src/core/log/index.js';
import { providerInfo } from '../../src/core/providers/discover.js';
import type { DiscoveryResult, DiscoverySource } from '../../src/core/providers/discover.js';
import { DiscoveryInputError, parseEmail } from '../../src/core/providers/email.js';
import { PRESETS, pickableProviders } from '../../src/core/providers/presets.js';
import type { Preset } from '../../src/core/providers/presets.js';
import { MemoryRememberedUsers } from '../../src/core/remembered-users.js';
import { LoginBlockedError } from '../../src/core/security/login-guard.js';

// M2d-4 add a mailbox in the app controller (spec A1-A12 and the add edge cases): keys ->
// reducers -> effects, driven with a fake Terminal, fake discovery / duplicate check / add
// (deferred where order matters) and a MemoryEventLog. The canary test runs the real core
// addAccount and assertNotDuplicate against in-memory repos and a fake session opener. No
// Supabase, no IMAP, no DNS, no real terminal, no real clock.

// --- fixtures -------------------------------------------------------------------------------

const SCREEN: Screen = { rows: 24, cols: 120 };
const ALICE: AuthUser = {
  email: 'alice@example.com',
  userId: '11111111-1111-4111-8111-111111111111',
};
const ID = '22222222-2222-4222-8222-222222222222';
const NEW_ID = '33333333-3333-4333-8333-333333333333';
const MAIL = 'one@example.com';
const ADDRESS = 'anna@example-test-domain.eu';
const HOST = 'imap.example-test-domain.eu';
const PASSWORD = 'Zq7#Wx9!Lp3^Nv5';
const RUN = '0123456789abcdef';
const T0 = Date.UTC(2026, 9, 1, 9, 0, 0);
const TARGET = 'ab'.repeat(32);
const PARSED = parseEmail(ADDRESS);

const k = (name: string, extra: Keypress = {}): Keypress => ({ name, sequence: name, ...extra });
const ENTER = k('return', { sequence: '\r' });
const DOWN = k('down', { sequence: '\x1b[B' });
const TAB = k('tab', { sequence: '\t' });
const CTRL_C = k('c', { ctrl: true, sequence: '\x03' });
const CTRL_U = k('u', { ctrl: true, sequence: '\x15' });
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

const NEW_ACCOUNT = account({
  id: NEW_ID,
  email: ADDRESS,
  provider: 'websupport',
  host: HOST,
  username: ADDRESS,
});

function preset(id: string): Preset {
  const p = PRESETS.find((x) => x.id === id);
  if (p === undefined) throw new Error(`no preset ${id}`);
  return p;
}

const BASE = { email: PARSED, notices: [] as string[], tried: [] as never[] };

const FOUND: DiscoveryResult = {
  ...BASE,
  status: 'found',
  source: 'preset-domain',
  imap: { host: HOST, port: 993, username: ADDRESS },
  altHosts: [],
  provider: providerInfo(preset('websupport')),
};

const MANUAL: DiscoveryResult = { ...BASE, status: 'manual' };

const NEEDS_HOST: DiscoveryResult = {
  ...BASE,
  status: 'needs-host',
  source: 'preset-mx',
  provider: providerInfo(preset('wedos')),
};

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
  for (let i = 0; i < 6; i++) await settle();
}

async function stillRunning(p: Promise<unknown>): Promise<boolean> {
  return Promise.race([p.then(() => false), settle().then(() => true)]);
}

type Discover = AppDeps['discover'];
type AssertNotSaved = AppDeps['assertNotSaved'];
type AddMailbox = AppDeps['addMailbox'];

interface Harness {
  t: FakeTerminal;
  app: App;
  done: Promise<AppResult>;
  log: MemoryEventLog;
  discover: ReturnType<typeof vi.fn<Discover>>;
  assertNotSaved: ReturnType<typeof vi.fn<AssertNotSaved>>;
  addMailbox: ReturnType<typeof vi.fn<AddMailbox>>;
  listMailboxes: ReturnType<typeof vi.fn<AppDeps['listMailboxes']>>;
  openSession: ReturnType<typeof vi.fn<AppDeps['openSession']>>;
  onUnexpected: ReturnType<typeof vi.fn<(err: unknown) => void>>;
}

interface Options {
  addProblem?: string | null;
  challengeDelayMs?: number;
  log?: MemoryEventLog;
  discover?: Discover;
  assertNotSaved?: AssertNotSaved;
  addMailbox?: AddMailbox;
  listMailboxes?: AppDeps['listMailboxes'];
}

function makeHarness(options: Options = {}): Harness {
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
  const discover = vi.fn<Discover>(options.discover ?? (() => Promise.resolve(FOUND)));
  const assertNotSaved = vi.fn<AssertNotSaved>(options.assertNotSaved ?? (() => Promise.resolve()));
  const addMailbox = vi.fn<AddMailbox>(options.addMailbox ?? (() => Promise.resolve(NEW_ACCOUNT)));
  const listMailboxes = vi.fn<AppDeps['listMailboxes']>(
    options.listMailboxes ?? (() => Promise.resolve([account()])),
  );
  const openSession = vi.fn<AppDeps['openSession']>(() => Promise.reject(new Error('not used')));
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
    findAccount: vi.fn<AppDeps['findAccount']>(() => Promise.resolve(account())),
    openSession,
    collectStats: vi.fn<NonNullable<AppDeps['collectStats']>>(() =>
      Promise.reject(new Error('not used')),
    ),
    timeZone: 'UTC',
    autoStats: false,
    readLogs: vi.fn<AppDeps['readLogs']>(() => Promise.reject(new Error('not used'))),
    discover,
    assertNotSaved,
    addMailbox,
    ...(options.addProblem !== undefined && { addProblem: options.addProblem }),
    ...(options.challengeDelayMs !== undefined && { challengeDelayMs: options.challengeDelayMs }),
  };
  const app = createApp(deps);
  return {
    t,
    app,
    done: app.run(),
    log,
    discover,
    assertNotSaved,
    addMailbox,
    listMailboxes,
    openSession,
    onUnexpected,
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

async function typeText(h: Harness, value: string): Promise<void> {
  await press(h, ...[...value].map(charKey));
}

async function waitFor(h: Harness, needle: string): Promise<void> {
  await vi.waitFor(() => {
    expect(last(h)).toContain(needle);
  });
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

/** Enter on "+ Add a mailbox" (rows: the mailbox, Add, Logs, Log out). */
async function atAddress(options: Options = {}): Promise<Harness> {
  const h = await atHome(options);
  await press(h, DOWN, ENTER);
  await waitFor(h, 'E-mail of the mailbox:');
  return h;
}

/** The address typed and Enter: found (the default discovery) is shown. */
async function atFound(options: Options = {}): Promise<Harness> {
  const h = await atAddress(options);
  await typeText(h, ADDRESS);
  await press(h, ENTER);
  await waitFor(h, 'Provider:');
  return h;
}

/** Found -> Enter -> the password step. */
async function atPassword(options: Options = {}): Promise<Harness> {
  const h = await atFound(options);
  await press(h, ENTER);
  await waitFor(h, 'Password:');
  return h;
}

/** The password typed and Enter: "Checking the login..." (the add is what the options say). */
async function submit(h: Harness, password = PASSWORD): Promise<void> {
  await typeText(h, password);
  await press(h, ENTER);
}

const everyFrame = (h: Harness): string => h.t.frames.map((f) => text(f)).join('\n');

// --- A1, A2: the start and the lookup -------------------------------------------------------

describe('A1 an add problem', () => {
  it('shows its text and asks nothing: no lookup is started', async () => {
    const h = await atHome({ addProblem: 'MM_MASTER_KEY is missing - run `mm doctor`.' });
    await press(h, DOWN, ENTER);
    await waitFor(h, 'MM_MASTER_KEY is missing - run `mm doctor`.');
    expect(last(h)).not.toContain('E-mail of the mailbox:');
    await typeText(h, ADDRESS);
    await press(h, ENTER);
    await flush();
    expect(h.discover).not.toHaveBeenCalled();
    await press(h, ESC);
    expect(last(h)).toContain(MAIL);
    expect(last(h)).toContain('Add a mailbox');
    await end(h);
  });
});

describe('A1, A2 the address and the lookup', () => {
  it('Enter on the Add row shows the address field; nothing is looked up yet', async () => {
    const h = await atAddress();
    expect(h.discover).not.toHaveBeenCalled();
    await end(h);
  });

  it('Esc from the address field goes back to Home as it was, without reloading', async () => {
    const h = await atHome();
    await press(h, DOWN);
    const before = h.t.frames.at(-1)?.lines;
    await press(h, ENTER);
    await waitFor(h, 'E-mail of the mailbox:');
    await press(h, ESC);
    expect(h.t.frames.at(-1)?.lines).toEqual(before);
    expect(h.listMailboxes).toHaveBeenCalledTimes(1);
    await end(h);
  });

  it('a bad address: the message, nothing is looked up', async () => {
    const h = await atAddress();
    await typeText(h, 'not-an-address');
    await press(h, ENTER);
    await waitFor(h, 'Email address must contain "@"');
    expect(h.discover).not.toHaveBeenCalled();
    await end(h);
  });

  it('a valid address: discovery is asked once with the address; "Looking up settings..." shows', async () => {
    const pending = deferred<DiscoveryResult>();
    const h = await atAddress({ discover: () => pending.promise });
    await typeText(h, `  ${ADDRESS}  `);
    await press(h, ENTER);
    await waitFor(h, 'Looking up settings...');
    expect(h.discover).toHaveBeenCalledTimes(1);
    expect(h.discover.mock.calls[0]?.[0]).toBe(ADDRESS);
    expect(typeof h.discover.mock.calls[0]?.[1]).toBe('function');
    pending.resolve(FOUND);
    await waitFor(h, 'Provider:');
    await end(h);
  });

  it('the progress of discovery names the source being checked', async () => {
    const pending = deferred<DiscoveryResult>();
    const h = await atAddress({
      discover: (_address, onProgress) => {
        onProgress('ispdb');
        return pending.promise;
      },
    });
    await typeText(h, ADDRESS);
    await press(h, ENTER);
    await waitFor(h, 'Looking up settings... checking Mozilla ISPDB');
    h.discover.mock.calls[0]?.[1]('srv' satisfies DiscoverySource);
    await waitFor(h, 'checking DNS SRV record');
    pending.resolve(MANUAL);
    await waitFor(h, 'No IMAP settings found for');
    await end(h);
  });

  it('Esc cancels: back to the address field with the address; the late result changes nothing', async () => {
    const pending = deferred<DiscoveryResult>();
    const h = await atAddress({ discover: () => pending.promise });
    await typeText(h, ADDRESS);
    await press(h, ENTER);
    await waitFor(h, 'Looking up settings...');
    await press(h, ESC);
    await waitFor(h, 'E-mail of the mailbox:');
    expect(last(h)).toContain(ADDRESS);
    pending.resolve(FOUND);
    await flush();
    expect(last(h)).toContain('E-mail of the mailbox:');
    expect(last(h)).not.toContain('Provider:');
    expect(await stillRunning(h.done)).toBe(true);
    await end(h);
  });

  it('a discovery that fails with an input error shows its message and Esc goes on', async () => {
    const h = await atAddress({
      discover: () =>
        Promise.reject(new DiscoveryInputError('Email domain is not a valid domain name')),
    });
    await typeText(h, ADDRESS);
    await press(h, ENTER);
    await waitFor(h, 'Email domain is not a valid domain name');
    expect(await stillRunning(h.done)).toBe(true);
    await end(h);
  });

  it('a discovery that fails with anything else ends the app through the crash path', async () => {
    const err = new Error('boom');
    const h = await atAddress({ discover: () => Promise.reject(err) });
    await typeText(h, ADDRESS);
    h.t.key(ENTER);
    await expect(h.done).rejects.toBe(err);
  });

  it('Ctrl+C during the lookup ends the app at once', async () => {
    const pending = deferred<DiscoveryResult>();
    const h = await atAddress({ discover: () => pending.promise });
    await typeText(h, ADDRESS);
    await press(h, ENTER);
    await waitFor(h, 'Looking up settings...');
    h.t.key(CTRL_C);
    await expect(h.done).resolves.toMatchObject({ end: 'interrupt' });
    pending.resolve(FOUND);
    await h.app.settled();
  });
});

// --- A3-A6: choosing the server -------------------------------------------------------------

describe('A3-A6 choosing the server', () => {
  it('found: Enter checks the saved mailboxes with the address, host and provider id', async () => {
    const pending = deferred<void>();
    const h = await atFound({ assertNotSaved: () => pending.promise });
    await press(h, ENTER);
    await waitFor(h, 'Checking your saved mailboxes...');
    expect(h.assertNotSaved).toHaveBeenCalledTimes(1);
    expect(h.assertNotSaved).toHaveBeenCalledWith({
      email: ADDRESS,
      host: HOST,
      provider: 'websupport',
    });
    pending.resolve();
    await waitFor(h, 'Password:');
    await end(h);
  });

  it('a manual server (m): the typed host, the address as username, provider custom', async () => {
    const h = await atAddress({ discover: () => Promise.resolve(MANUAL) });
    await typeText(h, ADDRESS);
    await press(h, ENTER);
    await waitFor(h, 'No IMAP settings found for');
    await press(h, charKey('m'));
    await waitFor(h, 'IMAP host:');
    await typeText(h, HOST);
    await press(h, ENTER, ENTER);
    await waitFor(h, 'Password:');
    expect(h.assertNotSaved).toHaveBeenCalledWith({
      email: ADDRESS,
      host: HOST,
      provider: 'custom',
    });
    await submit(h);
    await vi.waitFor(() => {
      expect(h.addMailbox).toHaveBeenCalledTimes(1);
    });
    expect(h.addMailbox.mock.calls[0]?.[0]).toEqual({
      userId: ALICE.userId,
      email: ADDRESS,
      settings: { host: HOST, port: 993, username: ADDRESS },
      provider: 'custom',
      password: PASSWORD,
    });
    await end(h);
  });

  it('a typed username replaces the address in the manual settings', async () => {
    const h = await atAddress({ discover: () => Promise.resolve(MANUAL) });
    await typeText(h, ADDRESS);
    await press(h, ENTER);
    await waitFor(h, 'No IMAP settings found for');
    await press(h, charKey('m'));
    await typeText(h, HOST);
    await press(h, TAB, CTRL_U);
    await typeText(h, 'box-17');
    await press(h, ENTER);
    await waitFor(h, 'Password:');
    await submit(h);
    await vi.waitFor(() => {
      expect(h.addMailbox).toHaveBeenCalledTimes(1);
    });
    expect(h.addMailbox.mock.calls[0]?.[0].settings).toEqual({
      host: HOST,
      port: 993,
      username: 'box-17',
    });
    await end(h);
  });

  it('the provider list (c): a fixed-host preset is used with its own host', async () => {
    const order = pickableProviders();
    const index = order.findIndex((p) => p.id === 'websupport');
    const target = order[index] as Preset;
    const h = await atAddress({ discover: () => Promise.resolve(MANUAL) });
    await typeText(h, ADDRESS);
    await press(h, ENTER);
    await waitFor(h, 'No IMAP settings found for');
    await press(h, charKey('c'));
    await waitFor(h, 'Slovakia / Czechia');
    await press(h, ...Array.from({ length: index }, () => DOWN), ENTER);
    await waitFor(h, 'Password:');
    expect(h.assertNotSaved).toHaveBeenCalledWith({
      email: ADDRESS,
      host: target.imap?.host ?? 'missing',
      provider: 'websupport',
    });
    await end(h);
  });

  it('needs-host: the host field, its hint, then the settings of that provider', async () => {
    const wedos = preset('wedos');
    const h = await atAddress({ discover: () => Promise.resolve(NEEDS_HOST) });
    await typeText(h, ADDRESS);
    await press(h, ENTER);
    await waitFor(h, 'IMAP host:');
    expect(collapsed(last(h))).toContain(asciiText(wedos.hostHint ?? ''));
    await typeText(h, HOST);
    await press(h, ENTER);
    await waitFor(h, 'Password:');
    expect(h.assertNotSaved).toHaveBeenCalledWith({
      email: ADDRESS,
      host: HOST,
      provider: 'wedos',
    });
    await end(h);
  });

  it('q quits from a step without a field', async () => {
    const h = await atFound();
    h.t.key(charKey('q'));
    await expect(h.done).resolves.toMatchObject({ end: 'quit' });
    await h.app.settled();
    expect(h.addMailbox).not.toHaveBeenCalled();
  });
});

// --- A7: the duplicate check ----------------------------------------------------------------

describe('A7 an address + server that is already saved', () => {
  it('its text on the failed screen, no password asked, nothing added; Esc goes Home', async () => {
    const err = new AccountError('duplicate', ID);
    const h = await atFound({ assertNotSaved: () => Promise.reject(err) });
    await press(h, ENTER);
    await vi.waitFor(() => {
      expect(collapsed(last(h))).toContain(collapsed(asciiText(accountErrorText(err))));
    });
    expect(last(h)).not.toContain('Password:');
    expect(h.addMailbox).not.toHaveBeenCalled();
    for (const line of h.t.frames.at(-1)?.lines ?? []) expect(line).toMatch(/^[\x20-\x7E]*$/);
    await press(h, ESC);
    expect(last(h)).toContain('Add a mailbox');
    expect(last(h)).toContain(MAIL);
    expect(await stillRunning(h.done)).toBe(true);
    await end(h);
  });

  it('another user-facing failure of the check shows its text too', async () => {
    const err = new AccountError('unsupported');
    const h = await atFound({ assertNotSaved: () => Promise.reject(err) });
    await press(h, ENTER);
    await vi.waitFor(() => {
      expect(collapsed(last(h))).toContain(collapsed(asciiText(accountErrorText(err))));
    });
    await end(h);
  });

  it('a failure that is not user-facing ends the app through the crash path', async () => {
    const err = new Error('boom');
    const h = await atFound({ assertNotSaved: () => Promise.reject(err) });
    h.t.key(ENTER);
    await expect(h.done).rejects.toBe(err);
  });

  it('Esc while checking goes one step back; the late answer changes nothing', async () => {
    const pending = deferred<void>();
    const h = await atFound({ assertNotSaved: () => pending.promise });
    await press(h, ENTER);
    await waitFor(h, 'Checking your saved mailboxes...');
    await press(h, ESC);
    await waitFor(h, 'Provider:');
    pending.resolve();
    await flush();
    expect(last(h)).toContain('Provider:');
    expect(last(h)).not.toContain('Password:');
    await end(h);
  });
});

// --- A8, A9: the password and the add -------------------------------------------------------

describe('A8 the password and the login check', () => {
  it('one addMailbox call with the user, address, settings, provider and password; "Checking the login..."', async () => {
    const pending = deferred<MailAccount>();
    const h = await atPassword({ addMailbox: () => pending.promise });
    await submit(h);
    await waitFor(h, 'Checking the login...');
    expect(h.addMailbox).toHaveBeenCalledTimes(1);
    const [input, onChallenge] = h.addMailbox.mock.calls[0] ?? [];
    expect(input).toEqual({
      userId: ALICE.userId,
      email: ADDRESS,
      settings: { host: HOST, port: 993, username: ADDRESS },
      provider: 'websupport',
      password: PASSWORD,
    });
    expect(typeof onChallenge).toBe('function');
    pending.resolve(NEW_ACCOUNT);
    await waitFor(h, 'Added');
    await end(h);
  });

  it('an empty password asks again and calls nothing', async () => {
    const h = await atPassword();
    await press(h, ENTER);
    await waitFor(h, 'Type the password.');
    expect(h.addMailbox).not.toHaveBeenCalled();
    await end(h);
  });

  it('while the login runs only Ctrl+C acts', async () => {
    const pending = deferred<MailAccount>();
    const h = await atPassword({ addMailbox: () => pending.promise });
    await submit(h);
    await waitFor(h, 'Checking the login...');
    const frame = last(h);
    await press(h, ESC, charKey('q'), ENTER, charKey('y'), charKey('a'), DOWN, TAB);
    expect(last(h)).toBe(frame);
    expect(h.addMailbox).toHaveBeenCalledTimes(1);
    expect(await stillRunning(h.done)).toBe(true);
    pending.resolve(NEW_ACCOUNT);
    await waitFor(h, 'Added');
    await end(h);
  });

  it('the password is in no frame and in no state, at any time', async () => {
    const pending = deferred<MailAccount>();
    const h = await atPassword({ addMailbox: () => pending.promise });
    await typeText(h, PASSWORD);
    expect(everyFrame(h)).not.toContain(PASSWORD);
    await press(h, ENTER);
    await waitFor(h, 'Checking the login...');
    expect(JSON.stringify(h.app.state)).not.toContain(PASSWORD);
    pending.resolve(NEW_ACCOUNT);
    await waitFor(h, 'Added');
    expect(JSON.stringify(h.app.state)).not.toContain(PASSWORD);
    const all = everyFrame(h);
    expect(all).not.toContain(PASSWORD);
    expect(all).not.toContain('Zq7#');
    await end(h);
  });

  it('the frames at the password step do not depend on the length of what is typed', async () => {
    const a = await atPassword();
    await typeText(a, 'x');
    const b = await atPassword();
    await typeText(b, 'y'.repeat(40));
    expect(a.t.frames.at(-1)?.lines).toEqual(b.t.frames.at(-1)?.lines);
    await end(a);
    await end(b);
  });
});

describe('A9 a rejected password, a block, other failures', () => {
  it.each([
    'auth-failed',
    'app-password-required',
    'password-expired',
    'contact-admin',
    'server-rejected',
    'invalid-credentials-input',
  ] as const)(
    '%s: the password step again, the field empty, the generic text below it; a second try can work',
    async (reason) => {
      const h = await atPassword({
        addMailbox: vi
          .fn<AddMailbox>()
          .mockRejectedValueOnce(new ImapSessionError(reason))
          .mockResolvedValueOnce(NEW_ACCOUNT),
      });
      await submit(h);
      await vi.waitFor(() => {
        expect(collapsed(last(h))).toContain(
          collapsed(asciiText(imapErrorText(reason, { kind: 'this-computer' }))),
        );
      });
      expect(last(h)).toContain('Password:');
      expect(last(h)).not.toContain('Checking the login...');
      expect(everyFrame(h)).not.toContain(PASSWORD);
      expect(h.addMailbox).toHaveBeenCalledTimes(1);
      await flush();
      expect(h.addMailbox).toHaveBeenCalledTimes(1);
      await submit(h, 'second-try-pw-8a');
      await waitFor(h, 'Added');
      expect(h.addMailbox).toHaveBeenCalledTimes(2);
      expect(h.addMailbox.mock.calls[1]?.[0].password).toBe('second-try-pw-8a');
      expect(h.addMailbox.mock.calls[1]?.[0].settings).toEqual({
        host: HOST,
        port: 993,
        username: ADDRESS,
      });
      await end(h);
    },
  );

  it('the retry starts with an empty field: Enter alone asks for the password', async () => {
    const h = await atPassword({
      addMailbox: () => Promise.reject(new ImapSessionError('auth-failed')),
    });
    await submit(h);
    await vi.waitFor(() => {
      expect(last(h)).toContain('Password:');
      expect(last(h)).not.toContain('Checking the login...');
    });
    await flush();
    await press(h, ENTER);
    await waitFor(h, 'Type the password.');
    expect(h.addMailbox).toHaveBeenCalledTimes(1);
    await end(h);
  });

  it('the guard\'s wait shows its notice instead of "Checking the login..." until the wait ends', async () => {
    const after = deferred<MailAccount>();
    const h = await atPassword({
      challengeDelayMs: 30,
      addMailbox: async (_input, onChallenge) => {
        await onChallenge();
        return after.promise;
      },
    });
    await submit(h);
    await waitFor(h, CHALLENGE_NOTICE);
    expect(last(h)).not.toContain('Checking the login...');
    await vi.waitFor(() => {
      expect(last(h)).toContain('Checking the login...');
      expect(last(h)).not.toContain(CHALLENGE_NOTICE);
    });
    after.resolve(NEW_ACCOUNT);
    await waitFor(h, 'Added');
    await end(h);
  });

  it('a blocked login: its text on the failed screen; Esc goes Home; nothing is tried again', async () => {
    const err = new LoginBlockedError('too-many-attempts', new Date(Date.UTC(2099, 0, 1, 12)));
    const h = await atPassword({ addMailbox: () => Promise.reject(err) });
    await submit(h);
    await vi.waitFor(() => {
      expect(collapsed(last(h))).toContain(collapsed(asciiText(accountErrorText(err))));
    });
    expect(last(h)).not.toContain('Password:');
    await flush();
    expect(h.addMailbox).toHaveBeenCalledTimes(1);
    await press(h, ESC);
    expect(last(h)).toContain('Add a mailbox');
    await end(h);
  });

  it.each([
    ['no-internet', new ImapSessionError('no-internet')],
    ['tls-certificate', new ImapSessionError('tls-certificate')],
    ['oauth-only', new ImapSessionError('oauth-only')],
    ['a duplicate saved in another window', new AccountError('duplicate')],
  ])('%s: the failed screen with its text', async (_name, err) => {
    const h = await atPassword({ addMailbox: () => Promise.reject(err) });
    await submit(h);
    await vi.waitFor(() => {
      expect(collapsed(last(h))).toContain(collapsed(asciiText(accountErrorText(err))));
    });
    expect(last(h)).not.toContain('Password:');
    expect(await stillRunning(h.done)).toBe(true);
    await end(h);
  });

  it('an error that is not user-facing ends the app through the crash path', async () => {
    const err = new Error('boom');
    const h = await atPassword({ addMailbox: () => Promise.reject(err) });
    await typeText(h, PASSWORD);
    h.t.key(ENTER);
    await expect(h.done).rejects.toBe(err);
  });
});

// --- A10, A11: saved, back -------------------------------------------------------------------

describe('A10 saved', () => {
  it('Home with the list loaded again, the new mailbox under the cursor, "Added <address>."', async () => {
    const h = await atPassword({
      listMailboxes: vi
        .fn<AppDeps['listMailboxes']>()
        .mockResolvedValueOnce([account()])
        .mockResolvedValue([account(), NEW_ACCOUNT]),
    });
    await submit(h);
    await waitFor(h, `Added ${ADDRESS}.`);
    expect(h.listMailboxes).toHaveBeenCalledTimes(2);
    const frame = h.t.frames.at(-1);
    expect(frame?.lines[frame.cursorLine ?? -1]).toContain(ADDRESS);
    expect(last(h)).toContain(MAIL);
    await press(h, DOWN);
    expect(last(h)).not.toContain('Added ');
    await end(h);
  });

  it('row 0 when the list does not hold the new mailbox', async () => {
    const h = await atPassword();
    await submit(h);
    await waitFor(h, `Added ${ADDRESS}.`);
    const frame = h.t.frames.at(-1);
    expect(frame?.lines[frame.cursorLine ?? -1]).toContain(MAIL);
    await end(h);
  });

  it('after it, the new mailbox is a normal Home row: Esc, q and the rest work', async () => {
    const h = await atPassword();
    await submit(h);
    await waitFor(h, 'Added');
    h.t.key(charKey('q'));
    await expect(h.done).resolves.toMatchObject({ end: 'quit' });
    await h.app.settled();
  });
});

describe('A11 nothing is saved unless the add resolved', () => {
  it('backing out at every step never calls addMailbox', async () => {
    const h = await atPassword();
    await typeText(h, 'half');
    await press(h, ESC);
    await waitFor(h, 'Provider:');
    await press(h, ESC);
    await waitFor(h, 'E-mail of the mailbox:');
    await press(h, ESC);
    expect(last(h)).toContain('+ Add a mailbox');
    expect(last(h)).not.toContain('E-mail of the mailbox:');
    expect(h.addMailbox).not.toHaveBeenCalled();
    await end(h);
  });
});

describe('A8 Ctrl+C while checking the login', () => {
  it('ends at once; settled() waits for the call; the result is then dropped', async () => {
    const pending = deferred<MailAccount>();
    const h = await atPassword({ addMailbox: () => pending.promise });
    await submit(h);
    await waitFor(h, 'Checking the login...');
    h.t.key(CTRL_C);
    await expect(h.done).resolves.toMatchObject({ end: 'interrupt' });
    const settled = h.app.settled();
    expect(await stillRunning(settled)).toBe(true);
    const frames = h.t.frames.length;
    pending.resolve(NEW_ACCOUNT);
    await settled;
    await flush();
    // The app had ended: no list is loaded again, nothing more is drawn.
    expect(h.listMailboxes).toHaveBeenCalledTimes(1);
    expect(h.t.frames.length).toBe(frames);
  });

  it('a rejection after the end is dropped too', async () => {
    const pending = deferred<MailAccount>();
    const h = await atPassword({ addMailbox: () => pending.promise });
    await submit(h);
    await waitFor(h, 'Checking the login...');
    h.t.key(CTRL_C);
    await h.done;
    const settled = h.app.settled();
    pending.reject(new Error('boom after the end'));
    await settled;
    expect(h.onUnexpected).not.toHaveBeenCalled();
  });
});

// --- A12: nothing private in the log --------------------------------------------------------

describe('A12 the log carries no typed address, server, username or password', () => {
  const C_ADDRESS = 'canary.user@canary-domain.example-test-domain.eu';
  const C_HOST = 'imap.canary-host.example-test-domain.eu';
  const C_USER = 'canary-user-name-77';
  const C_PASSWORD = 'CanaryPassword-99123';
  const C_WRONG = 'CanaryWrongPw-48151';
  const NEEDLES = [
    C_ADDRESS,
    'canary.user',
    'canary-domain',
    C_HOST,
    'canary-host',
    C_USER,
    'canary-user-name',
    C_PASSWORD,
    'CanaryPassword',
    C_WRONG,
    'CanaryWrongPw',
    'example-test-domain',
  ];
  const CAPS = sanitizeCapabilities({ IMAP4REV1: true, UIDPLUS: true });
  const FEATURES = buildServerFeatures(CAPS, new Set());

  function memoryRepo(): AccountsRepo & { rows: Map<string, MailAccount> } {
    const rows = new Map<string, MailAccount>([[ID, account()]]);
    return {
      rows,
      create: (a: NewMailAccount) => {
        const row: MailAccount = {
          id: a.id,
          userId: a.userId,
          label: a.label ?? null,
          email: a.email.toLowerCase(),
          provider: a.provider,
          host: a.host,
          port: a.port,
          username: a.username,
          authType: a.authType,
          secret: a.secret,
          capabilities: null,
          createdAt: new Date(T0),
          updatedAt: new Date(T0),
          lastCheckedAt: null,
        };
        rows.set(a.id, row);
        return Promise.resolve(row);
      },
      list: () => Promise.resolve([...rows.values()]),
      get: (id) => Promise.resolve(rows.get(id) ?? null),
      findByEmail: (email) =>
        Promise.resolve([...rows.values()].filter((r) => r.email === email.toLowerCase())),
      updateSecret: () => Promise.resolve(true),
      recordCheck: (id) => Promise.resolve(rows.has(id)),
      remove: (id) => Promise.resolve(rows.delete(id)),
    };
  }

  it('across a wrong password, a second try that works, a duplicate and a manual server', async () => {
    const log = new MemoryEventLog({ run: RUN, ver: '0.9.0', now: () => T0, level: 'debug' });
    const repo = memoryRepo();
    const entries: AuditEntry[] = [];
    const audit: AuditRepo = {
      write: (e) => {
        entries.push(e);
        return Promise.resolve();
      },
      listRecent: () => Promise.resolve({ records: [], skipped: 0 }),
    };
    const credentials = new LocalCredentialProvider({
      masterKey: randomBytes(32),
      masterKeyVersion: 1,
    });
    const guard = createLocalGuard(randomBytes(32), log);
    const logout = vi.fn(() => Promise.resolve());
    const session = { capabilities: CAPS, features: FEATURES, logout } as unknown as ImapSession;
    const open = vi.fn<(o: OpenSessionOptions) => Promise<ImapSession>>((o) => {
      // The first attempt has the wrong password; the next ones work.
      if (o.password === C_WRONG) return Promise.reject(new ImapSessionError('auth-failed'));
      return Promise.resolve(session);
    });
    const store = { repo, audit, log, runId: RUN, now: () => T0 };
    const canaryManual: DiscoveryResult = {
      ...BASE,
      email: parseEmail(C_ADDRESS),
      status: 'manual',
    };
    const h = await atHome({
      log,
      listMailboxes: () => repo.list(),
      discover: () => Promise.resolve(canaryManual),
      assertNotSaved: (o) => assertNotDuplicate(store, o),
      addMailbox: (o, onChallenge) =>
        addAccount(
          {
            ...store,
            credentials,
            guard,
            clientVersion: '9.9.9',
            onChallenge,
            open,
          },
          o,
        ),
    });

    const addOnce = async (password: string): Promise<void> => {
      await press(h, DOWN, ENTER);
      await waitFor(h, 'E-mail of the mailbox:');
      await typeText(h, C_ADDRESS);
      await press(h, ENTER);
      await waitFor(h, 'No IMAP settings found for');
      await press(h, charKey('m'));
      await typeText(h, C_HOST);
      await press(h, TAB, CTRL_U);
      await typeText(h, C_USER);
      await press(h, ENTER);
      await vi.waitFor(() => {
        const t = last(h);
        expect(t.includes('Password:') || t.includes('already saved')).toBe(true);
      });
      if (!last(h).includes('Password:')) return;
      await typeText(h, password);
      await press(h, ENTER);
    };

    // The wrong password, then the right one.
    await addOnce(C_WRONG);
    await vi.waitFor(() => {
      expect(last(h)).toContain('Password:');
      expect(last(h)).not.toContain('Checking the login...');
    });
    await flush();
    await typeText(h, C_PASSWORD);
    await press(h, ENTER);
    await waitFor(h, 'Added ');
    expect(repo.rows.size).toBe(2);

    // The same address and server again: a duplicate, no password asked.
    await addOnce(C_PASSWORD);
    await vi.waitFor(() => {
      expect(collapsed(last(h))).toContain('already saved');
    });
    expect(repo.rows.size).toBe(2);
    await press(h, ESC);
    await end(h);

    const all = JSON.stringify(h.log.records) + h.log.lines.join('\n') + JSON.stringify(entries);
    for (const needle of NEEDLES) expect(all, needle).not.toContain(needle);
    const names = h.log.records.map((r) => String(r.event));
    expect(names).toContain('account.add');
    for (const name of names) {
      expect(name === 'account.add' || /^(imap|auth|command|login-guard)\./.test(name), name).toBe(
        true,
      );
    }
    const adds = h.log.records.filter((r) => r.event === 'account.add');
    expect(adds.filter((r) => r['outcome'] === 'ok')).toHaveLength(1);
    expect(adds.filter((r) => r['outcome'] === 'failed')).toHaveLength(2);
    // The password also never reached a frame.
    expect(everyFrame(h)).not.toContain(C_PASSWORD);
    expect(everyFrame(h)).not.toContain(C_WRONG);
  });
});
