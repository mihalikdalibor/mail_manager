import { inspect } from 'node:util';
import type { ImapFlowOptions } from 'imapflow';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { ImapSessionError, type ImapFailureReason } from '../../src/core/imap/errors.js';
import { buildServerFeatures, sanitizeCapabilities } from '../../src/core/imap/features.js';
import {
  LOGOUT_TIMEOUT_MS,
  ImapSession,
  openSession,
  type ImapClientLike,
  type OpenSessionOptions,
} from '../../src/core/imap/session.js';
import type { ImapSettings } from '../../src/core/providers/settings.js';

const PASSWORD = 'pw-CANARY-9d1e';
const CANARY = 'CANARY-7f3a';
const USERNAME = 'someone@example-test-domain.eu';
const HOST = 'imap.example-test-domain.eu';
const CLIENT_MARKER = 'FAKE-CLIENT-INTERNALS-b41c';

type Listener = (arg?: unknown) => void;
type Event = 'error' | 'close';

interface Behaviour {
  connect?: (c: FakeClient) => Promise<void>;
  logout?: (c: FakeClient) => Promise<void>;
}

class FakeClient implements ImapClientLike {
  readonly marker = CLIENT_MARKER;
  capabilities = new Map<string, boolean | number>();
  enabled = new Set<string>();
  serverInfo: unknown = null;
  usable = false;
  readonly listeners: Record<Event, Listener[]> = { error: [], close: [] };

  constructor(
    public options: ImapFlowOptions,
    private readonly log: string[],
    private readonly behaviour: Behaviour,
  ) {}

  connect = vi.fn((): Promise<void> => {
    this.log.push('connect');
    return (this.behaviour.connect ?? succeed)(this);
  });

  logout = vi.fn((): Promise<void> => {
    this.log.push('logout');
    return this.behaviour.logout ? this.behaviour.logout(this) : Promise.resolve();
  });

  // Like imapflow: close() emits 'close'.
  close = vi.fn((): void => {
    this.log.push('close');
    this.usable = false;
    this.emit('close');
  });

  on = vi.fn((event: Event, listener: Listener): unknown => {
    this.log.push(`on:${event}`);
    this.listeners[event].push(listener);
    return this;
  });

  emit(event: Event, arg?: unknown): void {
    for (const l of this.listeners[event]) l(arg);
  }
}

const POST_AUTH_CAPS: [string, boolean | number][] = [
  ['IMAP4rev1', true],
  ['IDLE', true],
  ['UIDPLUS', true],
  ['MOVE', true],
  ['CONDSTORE', true],
  ['APPENDLIMIT', 35651584],
  ['bad name', true],
];

function succeed(c: FakeClient): Promise<void> {
  c.capabilities = new Map(POST_AUTH_CAPS);
  c.enabled = new Set(['CONDSTORE']);
  c.serverInfo = { name: 'Dovecot', version: '2.3.21-secret', vendor: CANARY };
  c.usable = true;
  return Promise.resolve();
}

/** A connect() that fails after the greeting, with the given pre-auth capabilities. */
function failWith(err: Error, preAuthCaps: string[] = []): (c: FakeClient) => Promise<void> {
  return (c) => {
    c.capabilities = new Map(preAuthCaps.map((n) => [n, true]));
    return Promise.reject(err);
  };
}

function authFailure(): Error {
  return Object.assign(new Error(`${CANARY} Command failed`), {
    authenticationFailed: true,
    responseText: `${CANARY} Authentication failed.`,
    executedCommand: `A1 LOGIN "${USERNAME}" "${PASSWORD}"`,
    serverResponseCode: 'AUTHENTICATIONFAILED',
  });
}

function nodeError(code: string): Error {
  return Object.assign(new Error(`${CANARY} ${code} ${PASSWORD}`), { code });
}

function settings(overrides: Partial<ImapSettings> = {}): ImapSettings {
  return { host: HOST, port: 993, username: USERNAME, ...overrides };
}

function setup(behaviour: Behaviour = {}, online = true) {
  const log: string[] = [];
  const created: FakeClient[] = [];
  const snapshots: ImapFlowOptions[] = [];
  const createClient = vi.fn((options: ImapFlowOptions): ImapClientLike => {
    log.push('createClient');
    // Snapshot what was passed at creation time (openSession removes auth afterwards).
    snapshots.push(JSON.parse(JSON.stringify(options)) as ImapFlowOptions);
    const c = new FakeClient(options, log, behaviour);
    created.push(c);
    return c;
  });
  const checkConnectivity = vi.fn((): Promise<boolean> => {
    log.push('checkConnectivity');
    return Promise.resolve(online);
  });
  const opts = (extra: Partial<OpenSessionOptions> = {}): OpenSessionOptions => ({
    settings: settings(),
    password: PASSWORD,
    clientVersion: '0.2.0',
    createClient,
    checkConnectivity,
    ...extra,
  });
  const client = (): FakeClient => {
    const c = created[0];
    if (!c) throw new Error('no client was created');
    return c;
  };
  return { log, created, snapshots, createClient, checkConnectivity, opts, client };
}

async function rejection(p: Promise<unknown>): Promise<ImapSessionError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ImapSessionError);
    return err as ImapSessionError;
  }
  throw new Error('expected openSession to reject');
}

function expectNoSecrets(value: unknown): void {
  const texts = [inspect(value, { depth: 10 }), String(JSON.stringify(value)), String(value)];
  for (const t of texts) {
    expect(t).not.toContain(PASSWORD);
    expect(t).not.toContain(CANARY);
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('openSession: input validation (before any client is created)', () => {
  it.each<[string, string]>([
    ['empty password', ''],
    ['password with CRLF', 'pw\r\nA2 LOGOUT'],
    ['password with NUL', 'pw\0'],
    ['password over 1024 chars', 'x'.repeat(1025)],
  ])('%s → invalid-credentials-input', async (_label, password) => {
    const s = setup();
    const err = await rejection(openSession(s.opts({ password })));
    expect(err.reason).toBe('invalid-credentials-input');
    expect(s.createClient).not.toHaveBeenCalled();
    expect(s.checkConnectivity).not.toHaveBeenCalled();
  });

  it.each<[string, string]>([
    ['empty username', ''],
    ['whitespace username', '  '],
    ['username with LF', 'some\none'],
    ['username with zero-width space', 'some\u200bone'],
    ['username over 254 chars', 'u'.repeat(255)],
  ])('%s → invalid-credentials-input', async (_label, username) => {
    const s = setup();
    const err = await rejection(openSession(s.opts({ settings: settings({ username }) })));
    expect(err.reason).toBe('invalid-credentials-input');
    expect(s.createClient).not.toHaveBeenCalled();
  });

  it.each([
    '1.2.3.4',
    '127.0.0.1',
    '0x7f.0x1',
    'localhost',
    'imap.example.com:993',
    'imap.example.com/x',
    'imap example.com',
    'https://imap.example.com',
    '',
    '[::1]',
  ])('host %j → unexpected, no client', async (host) => {
    const s = setup();
    const err = await rejection(openSession(s.opts({ settings: settings({ host }) })));
    expect(err.reason).toBe('unexpected');
    expect(s.createClient).not.toHaveBeenCalled();
  });

  it.each([143, 0, 994])('port %i → unexpected, no client', async (port) => {
    const s = setup();
    const bad = { host: HOST, port, username: USERNAME } as unknown as ImapSettings;
    const err = await rejection(openSession(s.opts({ settings: bad })));
    expect(err.reason).toBe('unexpected');
    expect(s.createClient).not.toHaveBeenCalled();
  });

  it('the rejected password never appears in the error', async () => {
    const s = setup();
    const bad = `${PASSWORD}\r\n`;
    const err = await rejection(openSession(s.opts({ password: bad })));
    expectNoSecrets(err);
  });
});

describe('openSession: client options', () => {
  it('creates exactly one client with secure, quiet options', async () => {
    const s = setup();
    await openSession(s.opts());
    expect(s.createClient).toHaveBeenCalledTimes(1);
    const o = s.snapshots[0];
    expect(o).toMatchObject({
      host: HOST,
      port: 993,
      secure: true,
      servername: HOST,
      tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
      auth: { user: USERNAME, pass: PASSWORD },
      logger: false,
      disableAutoIdle: true,
      disableCompression: true,
      clientInfo: { name: 'mail-manager', version: '0.2.0', vendor: false, 'support-url': false },
      connectionTimeout: 15000,
      greetingTimeout: 10000,
      socketTimeout: 300000,
    });
    // Nothing that would weaken TLS, log raw traffic or route through a proxy.
    expect(o?.proxy).toBeUndefined();
    expect(o?.logRaw ?? false).toBe(false);
    expect(o?.emitLogs ?? false).toBe(false);
    expect(o?.auth?.accessToken).toBeUndefined();
  });

  it('uses the normalized host for host, servername and session.host', async () => {
    const s = setup();
    const session = await openSession(
      s.opts({ settings: settings({ host: 'IMAP.Example-Test-Domain.EU' }) }),
    );
    expect(s.snapshots[0]?.host).toBe(HOST);
    expect(s.snapshots[0]?.servername).toBe(HOST);
    expect(session.host).toBe(HOST);
    expect(session.username).toBe(USERNAME);
  });

  it('timeouts can be overridden one by one', async () => {
    const s = setup();
    await openSession(s.opts({ timeouts: { connectMs: 1000 } }));
    expect(s.snapshots[0]).toMatchObject({
      connectionTimeout: 1000,
      greetingTimeout: 10000,
      socketTimeout: 300000,
    });

    const s2 = setup();
    await openSession(s2.opts({ timeouts: { connectMs: 1, greetingMs: 2, socketMs: 3 } }));
    expect(s2.snapshots[0]).toMatchObject({
      connectionTimeout: 1,
      greetingTimeout: 2,
      socketTimeout: 3,
    });
  });

  it("attaches 'error' and 'close' listeners before connect(), and connects exactly once", async () => {
    const s = setup();
    await openSession(s.opts());
    const connectAt = s.log.indexOf('connect');
    expect(connectAt).toBeGreaterThan(-1);
    expect(s.log.indexOf('on:error')).toBeGreaterThan(-1);
    expect(s.log.indexOf('on:error')).toBeLessThan(connectAt);
    expect(s.log.indexOf('on:close')).toBeGreaterThan(-1);
    expect(s.log.indexOf('on:close')).toBeLessThan(connectAt);
    expect(s.client().connect).toHaveBeenCalledTimes(1);
  });
});

describe('openSession: success', () => {
  it('fills capabilities, features and serverName from the client', async () => {
    const s = setup();
    const session = await openSession(s.opts());
    const expectedCaps = sanitizeCapabilities(new Map(POST_AUTH_CAPS));
    expect(session).toBeInstanceOf(ImapSession);
    expect(session.capabilities).toEqual(expectedCaps);
    expect(session.capabilities['IMAP4REV1']).toBe(true);
    expect(Object.keys(session.capabilities)).not.toContain('bad name');
    expect(session.features).toEqual(buildServerFeatures(expectedCaps, new Set(['CONDSTORE'])));
    expect(session.features.appendLimit).toBe(35651584);
    expect(session.features.condstore).toBe(true);
    expect(session.serverName).toBe('Dovecot');
    expect(session.closed).toBe(false);
    expect(session.lastErrorReason).toBeUndefined();
    expect(session.client).toBe(s.client());
    expect(s.checkConnectivity).not.toHaveBeenCalled();
  });

  it('removes the password from the client options after login', async () => {
    const s = setup();
    await openSession(s.opts());
    expect(s.client().options.auth).toBeUndefined();
    expect(inspect(s.client().options, { depth: 10 })).not.toContain(PASSWORD);
  });

  it('serverName is undefined when the server name is unsafe or missing', async () => {
    const s = setup({
      connect: async (c) => {
        await succeed(c);
        c.serverInfo = { name: `evil\r\n${CANARY}` };
      },
    });
    const session = await openSession(s.opts());
    expect(session.serverName).toBeUndefined();

    const s2 = setup({
      connect: async (c) => {
        await succeed(c);
        c.serverInfo = null;
      },
    });
    expect((await openSession(s2.opts())).serverName).toBeUndefined();
  });

  it('never exposes the password or the client via inspect / JSON / String', async () => {
    const s = setup();
    const session = await openSession(s.opts());
    expectNoSecrets(session);
    expect(inspect(session, { depth: 10 })).not.toContain(CLIENT_MARKER);
    expect(JSON.stringify(session)).not.toContain(CLIENT_MARKER);
    expect(Object.keys(session)).not.toContain('client');
    expect(JSON.stringify(session)).not.toContain('2.3.21-secret');
  });

  it('toJSON has host, username, serverName and features only', async () => {
    const s = setup();
    const session = await openSession(s.opts());
    expect(session.toJSON()).toEqual({
      host: HOST,
      username: USERNAME,
      serverName: 'Dovecot',
      features: session.features,
    });
    expect(Object.keys(session.toJSON()).sort()).toEqual(
      ['features', 'host', 'serverName', 'username'].sort(),
    );
  });
});

describe('openSession: connect failure', () => {
  it('maps the error, removes auth, closes the client and never retries', async () => {
    const raw = authFailure();
    const s = setup({ connect: failWith(raw, ['IMAP4REV1', 'AUTH=PLAIN']) });
    const err = await rejection(openSession(s.opts()));
    expect(err).not.toBe(raw);
    expect(err.reason).toBe('auth-failed');
    expect(s.createClient).toHaveBeenCalledTimes(1);
    expect(s.client().connect).toHaveBeenCalledTimes(1);
    expect(s.client().close).toHaveBeenCalled();
    expect(s.client().options.auth).toBeUndefined();
    expect(s.checkConnectivity).not.toHaveBeenCalled();
    expectNoSecrets(err);
    expect('cause' in err).toBe(false);
  });

  it('uses the pre-auth capabilities: OAuth-only server → oauth-only', async () => {
    const s = setup({
      connect: failWith(Object.assign(new Error(CANARY), { authenticationFailed: true }), [
        'IMAP4REV1',
        'LOGINDISABLED',
        'AUTH=XOAUTH2',
      ]),
    });
    const err = await rejection(openSession(s.opts()));
    expect(err.reason).toBe('oauth-only');
  });

  it.each<[boolean, ImapFailureReason]>([
    [false, 'no-internet'],
    [true, 'unreachable'],
  ])('network-down error: checks connectivity once (online=%s → %s)', async (online, reason) => {
    const s = setup({ connect: failWith(nodeError('EAI_AGAIN')) }, online);
    const err = await rejection(openSession(s.opts()));
    expect(err.reason).toBe(reason);
    expect(s.checkConnectivity).toHaveBeenCalledTimes(1);
    expect(s.client().close).toHaveBeenCalled();
    expectNoSecrets(err);
  });

  it.each<[string, ImapFailureReason]>([
    ['ENOTFOUND', 'host-not-found'],
    ['ECONNREFUSED', 'refused'],
    ['ECONNRESET', 'reset'],
    ['CERT_HAS_EXPIRED', 'tls-certificate'],
  ])('%s → %s without a connectivity check', async (code, reason) => {
    const s = setup({ connect: failWith(nodeError(code)) }, false);
    const err = await rejection(openSession(s.opts()));
    expect(err.reason).toBe(reason);
    expect(s.checkConnectivity).not.toHaveBeenCalled();
    expect(s.client().close).toHaveBeenCalled();
  });

  it('a plain Error or a non-Error rejection → unexpected', async () => {
    const s = setup({ connect: () => Promise.reject(new Error(`${CANARY} ${PASSWORD}`)) });
    const err = await rejection(openSession(s.opts()));
    expect(err.reason).toBe('unexpected');
    expectNoSecrets(err);

    const s2 = setup({
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a library could reject with anything
      connect: () => Promise.reject(`${CANARY} ${PASSWORD}`),
    });
    const err2 = await rejection(openSession(s2.opts()));
    expect(err2.reason).toBe('unexpected');
    expectNoSecrets(err2);
  });
});

describe('ImapSession events', () => {
  it("'error' after connect marks the session closed with the mapped reason", async () => {
    const s = setup();
    const session = await openSession(s.opts());
    expect(() => s.client().emit('error', nodeError('ECONNRESET'))).not.toThrow();
    expect(session.closed).toBe(true);
    expect(session.lastErrorReason).toBe('reset');
    expectNoSecrets(session);
  });

  it.each<[string, unknown]>([
    ['undefined', undefined],
    ['null', null],
    ['a string', CANARY],
    [
      'a hostile object',
      {
        get code(): never {
          throw new Error(CANARY);
        },
      },
    ],
  ])("'error' with %s never throws and gives unexpected", async (_label, arg) => {
    const s = setup();
    const session = await openSession(s.opts());
    expect(() => s.client().emit('error', arg)).not.toThrow();
    expect(session.closed).toBe(true);
    expect(session.lastErrorReason).toBe('unexpected');
  });

  it("'close' marks the session closed without an error reason", async () => {
    const s = setup();
    const session = await openSession(s.opts());
    s.client().emit('close');
    expect(session.closed).toBe(true);
    expect(session.lastErrorReason).toBeUndefined();
  });
});

describe('ImapSession.logout', () => {
  it('logs out, then closes the client', async () => {
    const s = setup();
    const session = await openSession(s.opts());
    await expect(session.logout()).resolves.toBeUndefined();
    expect(s.client().logout).toHaveBeenCalledTimes(1);
    expect(s.client().close).toHaveBeenCalledTimes(1);
    expect(s.log.indexOf('logout')).toBeLessThan(s.log.lastIndexOf('close'));
    expect(session.closed).toBe(true);
  });

  it('swallows a logout rejection and still closes', async () => {
    const s = setup({ logout: () => Promise.reject(new Error(CANARY)) });
    const session = await openSession(s.opts());
    await expect(session.logout()).resolves.toBeUndefined();
    expect(s.client().close).toHaveBeenCalledTimes(1);
  });

  it('survives a logout that throws synchronously', async () => {
    const s = setup({
      logout: () => {
        throw new Error(CANARY);
      },
    });
    const session = await openSession(s.opts());
    await expect(session.logout()).resolves.toBeUndefined();
    expect(s.client().close).toHaveBeenCalledTimes(1);
  });

  it(`gives up after LOGOUT_TIMEOUT_MS (${LOGOUT_TIMEOUT_MS} ms) when logout hangs`, async () => {
    expect(LOGOUT_TIMEOUT_MS).toBe(5000);
    const s = setup({ logout: () => new Promise<void>(() => undefined) });
    const session = await openSession(s.opts());
    vi.useFakeTimers();
    let done = false;
    const p = session.logout().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(LOGOUT_TIMEOUT_MS - 100);
    expect(done).toBe(false);
    expect(s.client().close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    await p;
    expect(done).toBe(true);
    expect(s.client().close).toHaveBeenCalledTimes(1);
  });
});

describe('openSession: client construction failure', () => {
  it('a throwing client constructor rejects with ImapSessionError, not the raw error', async () => {
    const s = setup();
    const err = await rejection(
      openSession(
        s.opts({
          createClient: () => {
            throw new Error(`${CANARY} bad options ${PASSWORD}`);
          },
        }),
      ),
    );
    expect(err.reason).toBe('unexpected');
    expectNoSecrets(err);
  });
});
