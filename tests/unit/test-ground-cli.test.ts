import { inspect } from 'node:util';
import {
  ImapFlow,
  type AppendResponseObject,
  type FetchMessageObject,
  type ListResponse,
  type MailboxCreateResponse,
  type MailboxDeleteResponse,
  type MailboxLockObject,
  type MailboxObject,
  type StatusObject,
} from 'imapflow';
import { describe, expect, it, vi } from 'vitest';
import { imapErrorText } from '../../src/cli/imap-errors.js';
import { loginBlockedText } from '../../src/cli/login-guard-text.js';
import { ImapSessionError, IMAP_FAILURE_REASONS } from '../../src/core/imap/errors.js';
import { ImapSession, type ImapClientLike } from '../../src/core/imap/session.js';
import { LoginBlockedError } from '../../src/core/security/login-guard.js';
import { MISSING_ENV_TEXT, errorText } from '../support/test-ground/cli.js';
import {
  FolderGuardError,
  SeedRefusedError,
  SeedVerifyError,
  TestGroundError,
} from '../support/test-ground/errors.js';
import {
  TestFolder,
  imapFolderClient,
  type FolderClient,
  type ServerMessage,
} from '../support/test-ground/folder.js';
import type { SeededMessage, TestGround } from '../support/test-ground/generator.js';
import type { DiscoveryDeps } from '../../src/core/providers/discover.js';
import {
  liveDiscoveryDeps,
  readLiveImapEnv,
  resolveLiveSettings,
} from '../support/test-ground/live-env.js';
import { buildManifest } from '../support/test-ground/manifest.js';
import { seedTestGround } from '../support/test-ground/seed.js';

// Offline tests of the test-ground script plumbing (M1b-3b): env helper, errorText,
// TestFolder.fromSession narrowing, and the ImapFlow → FolderClient adapter over a stubbed
// ImapFlow.prototype object. Nothing here opens a connection.

const CANARY_PASS = 'canary-pass-123';
const CANARY_ADDRESS = 'test@canary.example';
const CANARY_HOST = 'imap.canary.example';
const CANARIES = [CANARY_PASS, CANARY_ADDRESS, CANARY_HOST, 'canary.example'];
const UNEXPECTED = 'Unexpected error';

function expectNoCanary(text: string): void {
  for (const canary of CANARIES) expect(text).not.toContain(canary);
}

async function caught(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

// ---------- readLiveImapEnv ----------

describe('readLiveImapEnv', () => {
  const FULL = {
    MM_TEST_IMAP_USER: CANARY_ADDRESS,
    MM_TEST_IMAP_PASS: CANARY_PASS,
    MM_TEST_IMAP_HOST: CANARY_HOST,
  };

  it('unset → null', () => {
    expect(readLiveImapEnv({})).toBeNull();
    expect(readLiveImapEnv({ MM_TEST_IMAP_USER: CANARY_ADDRESS })).toBeNull();
    expect(readLiveImapEnv({ MM_TEST_IMAP_PASS: CANARY_PASS })).toBeNull();
    expect(
      readLiveImapEnv({ MM_TEST_IMAP_USER: undefined, MM_TEST_IMAP_PASS: undefined }),
    ).toBeNull();
  });

  it('empty user or password → null', () => {
    expect(readLiveImapEnv({ ...FULL, MM_TEST_IMAP_USER: '' })).toBeNull();
    expect(readLiveImapEnv({ ...FULL, MM_TEST_IMAP_PASS: '' })).toBeNull();
  });

  it('returns the trimmed address and host and the raw password', () => {
    const env = readLiveImapEnv({
      MM_TEST_IMAP_USER: `  ${CANARY_ADDRESS}\t`,
      MM_TEST_IMAP_PASS: ` ${CANARY_PASS} `,
      MM_TEST_IMAP_HOST: ` ${CANARY_HOST}  `,
    });
    expect(env).not.toBeNull();
    expect(env?.address).toBe(CANARY_ADDRESS);
    expect(env?.password).toBe(` ${CANARY_PASS} `);
    expect(env?.fallbackHost).toBe(CANARY_HOST);
  });

  it('a whitespace-only password counts as set and is passed raw', () => {
    const env = readLiveImapEnv({ MM_TEST_IMAP_USER: CANARY_ADDRESS, MM_TEST_IMAP_PASS: '   ' });
    expect(env?.password).toBe('   ');
  });

  it('empty or missing fallback host → null', () => {
    const base = { MM_TEST_IMAP_USER: CANARY_ADDRESS, MM_TEST_IMAP_PASS: CANARY_PASS };
    expect(readLiveImapEnv(base)?.fallbackHost).toBeNull();
    expect(readLiveImapEnv({ ...base, MM_TEST_IMAP_HOST: '' })?.fallbackHost).toBeNull();
    expect(readLiveImapEnv({ ...base, MM_TEST_IMAP_HOST: '   ' })?.fallbackHost).toBeNull();
  });

  it('inspect and JSON of the result never show the password or the address', () => {
    const env = readLiveImapEnv(FULL);
    expect(env).not.toBeNull();
    for (const text of [
      inspect(env, { showHidden: false, depth: 5 }),
      inspect({ env }, { depth: 5 }),
      JSON.stringify(env),
      JSON.stringify({ env }),
    ]) {
      expect(text).not.toContain(CANARY_PASS);
      expect(text).not.toContain(CANARY_ADDRESS);
    }
    // Still readable where it's needed.
    expect(env?.password).toBe(CANARY_PASS);
  });
});

// ---------- errors produced through the real code paths (constructors stay private) ----------

function tinyGround(): TestGround {
  const raw = Buffer.from('X-MM-Test-Seed: v1-001\r\nSubject: t\r\n\r\nbody\r\n');
  const internalDate = new Date(Date.UTC(2024, 0, 1, 10)).toISOString();
  const message: SeededMessage = {
    raw,
    facts: {
      seedId: 'v1-001',
      index: 1,
      messageId: '<v1-001@mm-test.invalid>',
      from: { name: 'S', address: 's@example.test', domain: 'example.test' },
      to: 'mm-test@mm-test.invalid',
      subject: 't',
      sentDate: internalDate,
      internalDate,
      dateOffsetDays: 0,
      size: raw.length,
      flags: [],
      attachments: [],
    },
  };
  return { version: 1, messages: [message], manifest: buildManifest(1, [message.facts]) };
}

/** A FolderClient whose mm-test always holds `messages` (appends vanish). */
function staticClient(messages: ServerMessage[]): FolderClient {
  let selected: string | null = null;
  return {
    namespacePrefix: () => '',
    selectedPath: () => selected,
    listPaths: () => Promise.resolve(['INBOX', 'mm-test']),
    create: () => Promise.resolve(false),
    unsubscribe: () => Promise.resolve(true),
    delete: () => Promise.resolve(),
    messageCount: () => Promise.resolve(messages.length),
    select: (path) => {
      selected = path;
      return Promise.resolve({ release: () => undefined });
    },
    fetchMessages: () => Promise.resolve(messages.map((m) => ({ ...m }))),
    append: () => Promise.resolve(),
    setFlags: () => Promise.resolve(),
  };
}

async function testGroundErrors(): Promise<TestGroundError[]> {
  const guard = await caught(() =>
    TestFolder.fromClient(staticClient([])).exists(`${CANARY_HOST}/${CANARY_ADDRESS}`),
  );
  const foreign: ServerMessage = {
    uid: 1,
    seedId: `${CANARY_ADDRESS}`,
    messageId: `<x@${CANARY_HOST}>`,
    size: 10,
    internalDate: new Date(Date.UTC(2024, 0, 1)),
    flags: [],
    keywords: [],
  };
  const refused = await caught(() =>
    seedTestGround(TestFolder.fromClient(staticClient([foreign])), tinyGround()),
  );
  const verify = await caught(() =>
    seedTestGround(TestFolder.fromClient(staticClient([])), tinyGround()),
  );
  const session = await caught(() =>
    Promise.resolve(TestFolder.fromSession({ client: {} } as unknown as ImapSession)),
  );
  expect(guard).toBeInstanceOf(FolderGuardError);
  expect(refused).toBeInstanceOf(SeedRefusedError);
  expect(verify).toBeInstanceOf(SeedVerifyError);
  expect(session).toBeInstanceOf(TestGroundError);
  return [guard, refused, verify, session] as TestGroundError[];
}

// ---------- errorText ----------

describe('errorText', () => {
  it.each(IMAP_FAILURE_REASONS)(
    'ImapSessionError(%s) → the app text for this computer',
    (reason) => {
      expect(errorText(new ImapSessionError(reason))).toBe(
        imapErrorText(reason, { kind: 'this-computer' }),
      );
    },
  );

  it.each(['too-many-attempts', 'ip-blocked', 'permanent'] as const)(
    'LoginBlockedError(%s) → the login guard text',
    (kind) => {
      const err = new LoginBlockedError(kind, null);
      expect(errorText(err)).toBe(loginBlockedText(err));
    },
  );

  it('LoginBlockedError with an until date → the login guard text (same minute)', () => {
    const err = new LoginBlockedError('too-many-attempts', new Date(Date.now() + 3_600_000));
    const text = errorText(err);
    expect(text).not.toBe(UNEXPECTED);
    expect(text.startsWith('Too many wrong passwords')).toBe(true);
  });

  it('each TestGroundError subclass → its own fixed message, without caller or server text', async () => {
    for (const err of await testGroundErrors()) {
      const text = errorText(err);
      expect(text).toBe(err.message);
      expect(text).not.toBe('');
      expect(text).not.toContain(UNEXPECTED);
      expectNoCanary(text);
    }
  });

  it('OVERQUOTA → the "mailbox is full" hint', () => {
    const err = Object.assign(new Error(`Mailbox over quota for ${CANARY_ADDRESS}`), {
      serverResponseCode: 'OVERQUOTA',
      responseText: `Quota exceeded (${CANARY_HOST})`,
    });
    const text = errorText(err);
    expect(text).toContain('mailbox is full');
    expect(text).toContain('npm run test:seed');
    expectNoCanary(text);
  });

  it('a plain Error → "Unexpected error (<name>)"', () => {
    expect(errorText(new Error(CANARY_PASS))).toBe('Unexpected error (Error)');
    expect(errorText(new TypeError(CANARY_PASS))).toBe('Unexpected error (TypeError)');
    const named = new Error('x');
    named.name = 'ImapFlowError_2';
    expect(errorText(named)).toBe('Unexpected error (ImapFlowError_2)');
  });

  it.each(['x\n<script>', 'a b', '', '1Error', '_Error', 'Err-or', 'A'.repeat(42), 'Érror'])(
    'a hostile or odd name (%j) → exactly "Unexpected error"',
    (name) => {
      const err = new Error('boom');
      err.name = name;
      expect(errorText(err)).toBe(UNEXPECTED);
    },
  );

  it('the longest allowed name passes through', () => {
    const err = new Error('boom');
    err.name = `A${'b'.repeat(40)}`;
    expect(errorText(err)).toBe(`Unexpected error (${err.name})`);
  });

  it.each<[string, unknown]>([
    ['a string', CANARY_PASS],
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['a plain object', { message: CANARY_PASS, responseText: CANARY_HOST }],
  ])('a thrown non-Error (%s) → "Unexpected error"', (_label, value) => {
    expect(errorText(value)).toBe(UNEXPECTED);
  });

  it('never repeats message, response, responseText or executedCommand (canaries)', () => {
    const secretText = `LOGIN ${CANARY_ADDRESS} ${CANARY_PASS} at ${CANARY_HOST}`;
    const errors: unknown[] = [
      new Error(secretText),
      Object.assign(new Error(secretText), {
        response: secretText,
        responseText: secretText,
        executedCommand: `A1 LOGIN "${CANARY_ADDRESS}" "${CANARY_PASS}"`,
        serverResponseCode: 'NO',
        code: CANARY_HOST,
      }),
      Object.assign(new Error(secretText), {
        serverResponseCode: 'OVERQUOTA',
        responseText: secretText,
      }),
      Object.assign(new Error(secretText), { name: CANARY_HOST }),
      Object.assign(new Error(secretText), { cause: new Error(secretText) }),
      new ImapSessionError('auth-failed', CANARY_PASS),
      secretText,
      { message: secretText, name: 'Error' },
    ];
    for (const err of errors) expectNoCanary(errorText(err));
  });

  it('MISSING_ENV_TEXT names both variables and carries no value', () => {
    expect(MISSING_ENV_TEXT).toContain('MM_TEST_IMAP_USER');
    expect(MISSING_ENV_TEXT).toContain('MM_TEST_IMAP_PASS');
    expect(MISSING_ENV_TEXT).not.toContain('=');
  });
});

// ---------- TestFolder.fromSession ----------

describe('TestFolder.fromSession', () => {
  it('refuses a session whose client is not an ImapFlow', () => {
    const clientLike: ImapClientLike = {
      options: {},
      capabilities: new Map(),
      enabled: new Set(),
      serverInfo: null,
      usable: true,
      connect: () => Promise.resolve(),
      logout: () => Promise.resolve(),
      close: () => undefined,
      on: () => undefined,
    };
    const session = new ImapSession(clientLike, CANARY_HOST, CANARY_ADDRESS);
    expect(() => TestFolder.fromSession(session)).toThrow(TestGroundError);
    expect(() => TestFolder.fromSession({ client: {} } as unknown as ImapSession)).toThrow(
      TestGroundError,
    );
    expect(() => TestFolder.fromSession({} as unknown as ImapSession)).toThrow(TestGroundError);

    try {
      TestFolder.fromSession(session);
    } catch (err) {
      expectNoCanary((err as Error).message);
    }
  });
});

// ---------- imapFolderClient over a stubbed ImapFlow.prototype object ----------

type Stubs = Partial<{
  noop: ImapFlow['noop'];
  capabilities: ImapFlow['capabilities'];
  enabled: ImapFlow['enabled'];
  serverInfo: ImapFlow['serverInfo'];
  namespace: ImapFlow['namespace'];
  mailbox: ImapFlow['mailbox'];
  list: ImapFlow['list'];
  mailboxCreate: ImapFlow['mailboxCreate'];
  mailboxUnsubscribe: ImapFlow['mailboxUnsubscribe'];
  mailboxDelete: ImapFlow['mailboxDelete'];
  status: ImapFlow['status'];
  getMailboxLock: ImapFlow['getMailboxLock'];
  fetchAll: ImapFlow['fetchAll'];
  append: ImapFlow['append'];
  messageFlagsSet: ImapFlow['messageFlagsSet'];
}>;

function stubFlow(stubs: Stubs): ImapFlow {
  const client = Object.create(ImapFlow.prototype) as ImapFlow;
  // Defaults for the plain fields the constructor would have set.
  Object.defineProperty(client, 'namespace', {
    value: undefined,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(client, 'mailbox', { value: false, writable: true, configurable: true });
  for (const [key, value] of Object.entries(stubs)) {
    Object.defineProperty(client, key, { value, writable: true, configurable: true });
  }
  return client;
}

function mailboxObject(path: string, exists: number): MailboxObject {
  return {
    path,
    delimiter: '.',
    flags: new Set(),
    uidValidity: 1n,
    uidNext: exists + 1,
    exists,
  };
}

function listEntry(path: string, flags: string[] = []): ListResponse {
  return {
    path,
    pathAsListed: path,
    name: path,
    delimiter: '.',
    parent: [],
    parentPath: '',
    flags: new Set(flags),
    listed: true,
    subscribed: true,
  };
}

const PATH = 'mm-test';

async function expectTestGroundError(fn: () => Promise<unknown>): Promise<void> {
  const err = await caught(fn);
  expect(err).toBeInstanceOf(TestGroundError);
  expectNoCanary((err as Error).message);
}

describe('imapFolderClient', () => {
  it('namespacePrefix: the personal prefix, or "" when there is none', () => {
    expect(imapFolderClient(stubFlow({})).namespacePrefix()).toBe('');
    expect(
      imapFolderClient(
        stubFlow({ namespace: { prefix: 'INBOX.', delimiter: '.' } }),
      ).namespacePrefix(),
    ).toBe('INBOX.');
  });

  it('selectedPath: the open mailbox path, or null', () => {
    expect(imapFolderClient(stubFlow({ mailbox: false })).selectedPath()).toBeNull();
    expect(
      imapFolderClient(stubFlow({ mailbox: mailboxObject('INBOX.mm-test', 3) })).selectedPath(),
    ).toBe('INBOX.mm-test');
  });

  it('listPaths skips \\Noselect and \\NonExistent entries', async () => {
    const list = vi.fn<ImapFlow['list']>(() =>
      Promise.resolve([
        listEntry('INBOX'),
        listEntry('mm-test', ['\\HasNoChildren']),
        listEntry('Placeholder', ['\\Noselect']),
        listEntry('Gone', ['\\NonExistent', '\\HasNoChildren']),
        listEntry('Trash', ['\\Trash']),
      ]),
    );
    const paths = await imapFolderClient(stubFlow({ list })).listPaths();
    expect([...paths].sort()).toEqual(['INBOX', 'Trash', 'mm-test']);
  });

  it('create: true/false from { created }, undefined → TestGroundError', async () => {
    const created = vi.fn<ImapFlow['mailboxCreate']>(() =>
      Promise.resolve({ path: PATH, created: true }),
    );
    expect(await imapFolderClient(stubFlow({ mailboxCreate: created })).create(PATH)).toBe(true);
    expect(created).toHaveBeenCalledTimes(1);
    expect(created.mock.calls[0]?.[0]).toBe(PATH);

    const existed = vi.fn<ImapFlow['mailboxCreate']>(() =>
      Promise.resolve({ path: PATH, created: false }),
    );
    expect(await imapFolderClient(stubFlow({ mailboxCreate: existed })).create(PATH)).toBe(false);

    const notAuthed = vi.fn<ImapFlow['mailboxCreate']>(() =>
      Promise.resolve(undefined as unknown as MailboxCreateResponse),
    );
    await expectTestGroundError(() =>
      imapFolderClient(stubFlow({ mailboxCreate: notAuthed })).create(CANARY_HOST),
    );
  });

  it('delete: undefined result → TestGroundError', async () => {
    const ok = vi.fn<ImapFlow['mailboxDelete']>(() => Promise.resolve({ path: PATH }));
    await imapFolderClient(stubFlow({ mailboxDelete: ok })).delete(PATH);
    expect(ok.mock.calls[0]?.[0]).toBe(PATH);

    const notAuthed = vi.fn<ImapFlow['mailboxDelete']>(() =>
      Promise.resolve(undefined as unknown as MailboxDeleteResponse),
    );
    await expectTestGroundError(() =>
      imapFolderClient(stubFlow({ mailboxDelete: notAuthed })).delete(CANARY_HOST),
    );
  });

  it('unsubscribe reports the server answer and never throws on false (best effort)', async () => {
    const ok = vi.fn<ImapFlow['mailboxUnsubscribe']>(() => Promise.resolve(true));
    expect(await imapFolderClient(stubFlow({ mailboxUnsubscribe: ok })).unsubscribe(PATH)).toBe(
      true,
    );
    expect(ok.mock.calls[0]?.[0]).toBe(PATH);

    const declined = vi.fn<ImapFlow['mailboxUnsubscribe']>(() => Promise.resolve(false));
    expect(
      await imapFolderClient(stubFlow({ mailboxUnsubscribe: declined })).unsubscribe(PATH),
    ).toBe(false);
  });

  it('messageCount: STATUS messages; false or no count → TestGroundError', async () => {
    const ok = vi.fn<ImapFlow['status']>(() => Promise.resolve({ path: PATH, messages: 12 }));
    expect(await imapFolderClient(stubFlow({ status: ok })).messageCount(PATH)).toBe(12);
    expect(ok.mock.calls[0]?.[0]).toBe(PATH);
    expect(ok.mock.calls[0]?.[1]).toMatchObject({ messages: true });

    const zero = vi.fn<ImapFlow['status']>(() => Promise.resolve({ path: PATH, messages: 0 }));
    expect(await imapFolderClient(stubFlow({ status: zero })).messageCount(PATH)).toBe(0);

    const failed = vi.fn<ImapFlow['status']>(() =>
      Promise.resolve(false as unknown as StatusObject),
    );
    await expectTestGroundError(() =>
      imapFolderClient(stubFlow({ status: failed })).messageCount(CANARY_HOST),
    );

    const noCount = vi.fn<ImapFlow['status']>(() =>
      Promise.resolve({ path: `${CANARY_HOST}/${CANARY_ADDRESS}`, messages: undefined }),
    );
    await expectTestGroundError(() =>
      imapFolderClient(stubFlow({ status: noCount })).messageCount(PATH),
    );
  });

  it('select takes the mailbox lock and hands back its release', async () => {
    const release = vi.fn<() => void>();
    const getMailboxLock = vi.fn<ImapFlow['getMailboxLock']>(() =>
      Promise.resolve({ path: PATH, release } satisfies MailboxLockObject),
    );
    const lock = await imapFolderClient(stubFlow({ getMailboxLock })).select(PATH);
    expect(getMailboxLock.mock.calls[0]?.[0]).toBe(PATH);
    expect(release).not.toHaveBeenCalled();
    lock.release();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('append: passes path, bytes, flags, date; false → TestGroundError', async () => {
    const raw = Buffer.from('X-MM-Test-Seed: v1-001\r\n\r\nbody\r\n');
    const date = new Date(Date.UTC(2024, 0, 2, 3, 4, 5));
    const ok = vi.fn<ImapFlow['append']>(() =>
      Promise.resolve({ destination: PATH, uid: 5 } satisfies AppendResponseObject),
    );
    await imapFolderClient(stubFlow({ append: ok })).append(PATH, raw, ['\\Seen'], date);
    const call = ok.mock.calls[0];
    expect(call?.[0]).toBe(PATH);
    const sent = call?.[1];
    expect(Buffer.isBuffer(sent) && sent.equals(raw)).toBe(true);
    expect(call?.[2]).toEqual(['\\Seen']);
    const idate = call?.[3];
    expect(idate instanceof Date ? idate.getTime() : Date.parse(String(idate))).toBe(
      date.getTime(),
    );

    const failed = vi.fn<ImapFlow['append']>(() => Promise.resolve(false));
    await expectTestGroundError(() =>
      imapFolderClient(stubFlow({ append: failed })).append(CANARY_HOST, raw, [], date),
    );
  });

  it('setFlags: replaces flags by UID; false → TestGroundError', async () => {
    const ok = vi.fn<ImapFlow['messageFlagsSet']>(() => Promise.resolve(true));
    await imapFolderClient(stubFlow({ messageFlagsSet: ok })).setFlags(7, ['\\Seen', '$Junk']);
    const call = ok.mock.calls[0];
    const range = call?.[0];
    expect(
      typeof range === 'number' ? String(range) : Array.isArray(range) ? range.join(',') : range,
    ).toBe('7');
    expect(call?.[1]).toEqual(['\\Seen', '$Junk']);
    expect(call?.[2]).toMatchObject({ uid: true });

    const failed = vi.fn<ImapFlow['messageFlagsSet']>(() => Promise.resolve(false));
    await expectTestGroundError(() =>
      imapFolderClient(stubFlow({ messageFlagsSet: failed })).setFlags(7, []),
    );
  });

  it.each<[string, MailboxObject | false]>([
    ['no mailbox open', false],
    ['an empty mailbox', mailboxObject(PATH, 0)],
  ])('fetchMessages with %s → [] without FETCH', async (_label, mailbox) => {
    const fetchAll = vi.fn<ImapFlow['fetchAll']>(() => Promise.resolve([]));
    const noop = vi.fn<ImapFlow['noop']>(() => Promise.resolve());
    expect(await imapFolderClient(stubFlow({ mailbox, fetchAll, noop })).fetchMessages()).toEqual(
      [],
    );
    expect(fetchAll).not.toHaveBeenCalled();
  });

  it('fetchMessages refreshes a stale 0 count with NOOP before deciding the folder is empty', async () => {
    const mailbox = mailboxObject(PATH, 0);
    const rows: FetchMessageObject[] = [{ seq: 1, uid: 1, size: 10 }];
    const fetchAll = vi.fn<ImapFlow['fetchAll']>(() => Promise.resolve(rows));
    // The server's pending EXISTS arrives with the NOOP.
    const noop = vi.fn<ImapFlow['noop']>(() => {
      mailbox.exists = 1;
      return Promise.resolve();
    });
    const messages = await imapFolderClient(stubFlow({ mailbox, fetchAll, noop })).fetchMessages();
    expect(noop).toHaveBeenCalledTimes(1);
    expect(messages.map((m) => m.uid)).toEqual([1]);
  });

  it('fetchMessages maps seed id, Message-ID, size, date and normalized flags', async () => {
    const date = new Date(Date.UTC(2024, 5, 1, 12, 0, 0));
    const rows: FetchMessageObject[] = [
      {
        seq: 1,
        uid: 11,
        size: 1234,
        flags: new Set(['\\Seen', '\\Recent', '$HasAttachment', '\\Flagged']),
        internalDate: date,
        envelope: { messageId: '<v1-001@mm-test.invalid>', subject: CANARY_ADDRESS },
        headers: Buffer.from('x-mm-test-seed: v1-001\r\n\r\n'),
      },
      {
        seq: 2,
        uid: 12,
        size: 2048,
        flags: new Set(),
        internalDate: '2023-02-03T04:05:06.000Z',
        envelope: { messageId: '<other@example.test>' },
        headers: Buffer.from('\r\n'),
      },
      {
        seq: 3,
        uid: 13,
        size: 99,
        internalDate: 'not a date',
      },
      {
        seq: 4,
        uid: 14,
        size: 100,
      },
    ];
    const fetchAll = vi.fn<ImapFlow['fetchAll']>(() => Promise.resolve(rows));
    const messages = await imapFolderClient(
      stubFlow({ mailbox: mailboxObject(PATH, rows.length), fetchAll }),
    ).fetchMessages();

    expect(fetchAll).toHaveBeenCalledTimes(1);
    // Headers only (BODY.PEEK): never the message source, never \Seen as a side effect.
    expect(fetchAll.mock.calls[0]).toEqual([
      '1:*',
      {
        uid: true,
        size: true,
        flags: true,
        internalDate: true,
        envelope: true,
        headers: ['x-mm-test-seed'],
      },
    ]);
    expect(messages).toHaveLength(4);
    const [a, b, c, d] = messages;

    expect(a).toMatchObject({
      uid: 11,
      seedId: 'v1-001',
      messageId: '<v1-001@mm-test.invalid>',
      size: 1234,
      flags: ['\\Flagged', '\\Seen'],
      keywords: ['$HasAttachment'],
    });
    expect(a?.internalDate.getTime()).toBe(date.getTime());

    expect(b).toMatchObject({
      uid: 12,
      seedId: null,
      messageId: '<other@example.test>',
      size: 2048,
      flags: [],
      keywords: [],
    });
    expect(b?.internalDate.getTime()).toBe(Date.UTC(2023, 1, 3, 4, 5, 6));

    expect(c?.seedId).toBeNull();
    expect(c?.messageId).toBeNull();
    expect(c?.internalDate).toBeInstanceOf(Date);
    expect(Number.isNaN(c?.internalDate.getTime())).toBe(true);

    expect(d?.internalDate).toBeInstanceOf(Date);
    expect(Number.isNaN(d?.internalDate.getTime())).toBe(true);
    expect(d?.flags).toEqual([]);
    expect(d?.keywords).toEqual([]);

    // Nothing of the message content beyond the listed facts is kept.
    expect(JSON.stringify(messages)).not.toContain(CANARY_ADDRESS);
  });
});

describe('TestFolder.fromSession with a real ImapFlow', () => {
  function sessionOver(capabilities: [string, boolean | number][]): ImapSession {
    const flow = stubFlow({
      capabilities: new Map(capabilities),
      enabled: new Set(),
      serverInfo: null,
      namespace: { prefix: 'INBOX.', delimiter: '.' },
    });
    return new ImapSession(flow, CANARY_HOST, CANARY_ADDRESS);
  }

  it('accepts an ImapFlow session and resolves the prefixed path', () => {
    expect(TestFolder.fromSession(sessionOver([['IMAP4REV1', true]])).path).toBe('INBOX.mm-test');
  });

  it('refuses a Gmail session (folders are labels there; unseed would keep the mail)', () => {
    const session = sessionOver([
      ['IMAP4REV1', true],
      ['X-GM-EXT-1', true],
    ]);
    expect(() => TestFolder.fromSession(session)).toThrow(TestGroundError);
  });
});

describe('resolveLiveSettings (fake DNS, no network)', () => {
  function deps(mx: { exchange: string; priority: number }[] | null): DiscoveryDeps {
    return {
      resolveMx: () => (mx === null ? Promise.reject(new Error('ENOTFOUND')) : Promise.resolve(mx)),
      resolveSrv: () => Promise.reject(new Error('ENOTFOUND')),
      fetch: vi.fn<typeof globalThis.fetch>(() => Promise.reject(new Error('no HTTP'))),
      timeoutMs: 1000,
    };
  }

  it('uses the discovered settings when found (preset domain)', async () => {
    const settings = await resolveLiveSettings(
      'someone@gmail.com',
      'fallback.example.test',
      deps([]),
    );
    expect(settings.host).toBe('imap.gmail.com');
    expect(settings.username).toBe('someone@gmail.com');
  });

  it('falls back to MM_TEST_IMAP_HOST when discovery finds nothing', async () => {
    const settings = await resolveLiveSettings(
      'someone@nothing.example.test',
      'imap.fallback.example.test',
      deps(null),
    );
    expect(settings).toEqual({
      host: 'imap.fallback.example.test',
      port: 993,
      username: 'someone@nothing.example.test',
    });
  });

  it('names the variable, not a value, when discovery finds nothing and no fallback is set', async () => {
    const err = await resolveLiveSettings('someone@nothing.example.test', null, deps(null)).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TestGroundError);
    const text = (err as Error).message;
    expect(text).toContain('MM_TEST_IMAP_HOST');
    expect(text).not.toContain('nothing.example.test');
  });

  it('explains an OAuth-only (blocked) provider instead of "no host found"', async () => {
    const err = await resolveLiveSettings('someone@outlook.com', 'x.example.test', deps([])).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TestGroundError);
    expect((err as Error).message).toContain('password (IMAP) login');
  });

  it('the live deps never make an HTTP request (fetch rejects immediately)', async () => {
    await expect(liveDiscoveryDeps().fetch('https://example.test/')).rejects.toThrow();
  });
});
