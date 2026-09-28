import { describe, expect, it } from 'vitest';
import { FolderGuardError, TestGroundError } from '../support/test-ground/errors.js';
import {
  SYSTEM_FLAGS,
  TEST_FOLDER,
  TestFolder,
  normalizeFlags,
  parseSeedId,
  testFolderPath,
  type FolderClient,
  type ServerMessage,
} from '../support/test-ground/folder.js';
import { unseedTestGround } from '../support/test-ground/unseed.js';

// Offline tests of the mm-test folder guard (M1b-3b). A recording in-memory fake stands in for
// the IMAP client: every FolderClient method except the two read-only getters is logged, so
// "refused before any IMAP call" is checked as "nothing was logged".

const CANARY_PATH = 'canary-folder-7f3';

// ---------- recording fake FolderClient ----------

interface StoredMessage {
  uid: number;
  seedId: string | null;
  messageId: string | null;
  size: number;
  internalDate: Date;
  /** Everything the server has, keywords included. */
  flags: string[];
}

interface FakeFolder {
  nextUid: number;
  messages: StoredMessage[];
}

type LoggedMethod = Exclude<keyof FolderClient, 'namespacePrefix' | 'selectedPath'>;

interface Call {
  method: LoggedMethod;
  args: unknown[];
}

const WRITES: ReadonlySet<LoggedMethod> = new Set<LoggedMethod>([
  'create',
  'unsubscribe',
  'delete',
  'append',
  'setFlags',
]);

const SYSTEM = new Set(['\\Answered', '\\Deleted', '\\Draft', '\\Flagged', '\\Seen']);

function headerValue(raw: Buffer, name: string): string | null {
  const end = raw.indexOf('\r\n\r\n');
  const block = raw.subarray(0, end === -1 ? raw.length : end).toString('latin1');
  for (const line of block.replace(/\r\n(?=[ \t])/g, '').split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon > 0 && line.slice(0, colon).toLowerCase() === name.toLowerCase()) {
      return line.slice(colon + 1).trim();
    }
  }
  return null;
}

class FakeFolderClient implements FolderClient {
  prefix: string;
  selected: string | null = null;
  readonly folders = new Map<string, FakeFolder>();
  readonly calls: Call[] = [];
  lockReleases = 0;
  /** DELETE "succeeds" but the folder stays (a broken server). */
  deleteKeepsFolder = false;

  constructor(prefix = '', folders: string[] = []) {
    this.prefix = prefix;
    for (const path of folders) this.folders.set(path, { nextUid: 1, messages: [] });
  }

  writes(): Call[] {
    return this.calls.filter((c) => WRITES.has(c.method));
  }

  addMessages(path: string, count: number): void {
    const folder = this.folders.get(path);
    if (folder === undefined) throw new Error('fake: no such folder');
    for (let i = 0; i < count; i++) {
      folder.messages.push({
        uid: folder.nextUid++,
        seedId: null,
        messageId: null,
        size: 100,
        internalDate: new Date(Date.UTC(2024, 0, 1)),
        flags: [],
      });
    }
  }

  private log(method: LoggedMethod, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }

  private folder(path: string): FakeFolder {
    const folder = this.folders.get(path);
    if (folder === undefined) throw new Error('fake: no such folder');
    return folder;
  }

  namespacePrefix(): string {
    return this.prefix;
  }

  selectedPath(): string | null {
    return this.selected;
  }

  listPaths(): Promise<string[]> {
    this.log('listPaths');
    return Promise.resolve([...this.folders.keys()]);
  }

  create(path: string): Promise<boolean> {
    this.log('create', path);
    if (this.folders.has(path)) return Promise.resolve(false);
    this.folders.set(path, { nextUid: 1, messages: [] });
    return Promise.resolve(true);
  }

  unsubscribe(path: string): Promise<boolean> {
    this.log('unsubscribe', path);
    return Promise.resolve(true);
  }

  delete(path: string): Promise<void> {
    this.log('delete', path);
    if (!this.deleteKeepsFolder) this.folders.delete(path);
    return Promise.resolve();
  }

  messageCount(path: string): Promise<number> {
    this.log('messageCount', path);
    const folder = this.folders.get(path);
    if (folder === undefined) return Promise.reject(new Error('fake: no such folder'));
    return Promise.resolve(folder.messages.length);
  }

  select(path: string): Promise<{ release(): void }> {
    this.log('select', path);
    if (!this.folders.has(path)) return Promise.reject(new Error('fake: no such folder'));
    this.selected = path;
    return Promise.resolve({
      release: () => {
        this.lockReleases++;
      },
    });
  }

  fetchMessages(): Promise<ServerMessage[]> {
    this.log('fetchMessages');
    if (this.selected === null) return Promise.reject(new Error('fake: nothing selected'));
    const messages = this.folder(this.selected).messages.map((m): ServerMessage => ({
      uid: m.uid,
      seedId: m.seedId,
      messageId: m.messageId,
      size: m.size,
      internalDate: new Date(m.internalDate.getTime()),
      flags: m.flags.filter((f) => SYSTEM.has(f)).sort(),
      keywords: m.flags.filter((f) => !SYSTEM.has(f) && f !== '\\Recent').sort(),
    }));
    return Promise.resolve(messages);
  }

  append(path: string, raw: Buffer, flags: string[], internalDate: Date): Promise<void> {
    this.log('append', path, raw, flags, internalDate);
    const folder = this.folder(path);
    folder.messages.push({
      uid: folder.nextUid++,
      seedId: headerValue(raw, 'X-MM-Test-Seed'),
      messageId: headerValue(raw, 'Message-ID'),
      size: raw.length,
      internalDate: new Date(internalDate.getTime()),
      flags: [...flags],
    });
    return Promise.resolve();
  }

  setFlags(uid: number, flags: string[]): Promise<void> {
    this.log('setFlags', uid, flags);
    if (this.selected === null) return Promise.reject(new Error('fake: nothing selected'));
    const message = this.folder(this.selected).messages.find((m) => m.uid === uid);
    if (message === undefined) return Promise.reject(new Error('fake: no such uid'));
    message.flags = [...flags];
    return Promise.resolve();
  }
}

/** The error a call rejects (or throws) with; undefined when it succeeds. */
async function caught(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

const RAW = Buffer.from('X-MM-Test-Seed: v1-001\r\nSubject: s\r\n\r\nbody\r\n');

// ---------- guard ----------

type Operation = 'exists' | 'create' | 'remove' | 'messageCount' | 'open';
const OPERATIONS: readonly Operation[] = ['exists', 'create', 'remove', 'messageCount', 'open'];

function run(folder: TestFolder, op: Operation, path: string): Promise<unknown> {
  switch (op) {
    case 'exists':
      return folder.exists(path);
    case 'create':
      return folder.create(path);
    case 'remove':
      return folder.remove(path);
    case 'messageCount':
      return folder.messageCount(path);
    case 'open':
      return folder.open(path);
  }
}

function refusedPaths(prefix: string): string[] {
  const paths = [
    'INBOX',
    'Trash',
    'mm-test/x',
    `${prefix}mm-test.x`,
    `${prefix}mm-test/x`,
    'MM-TEST',
    `${prefix}MM-TEST`,
    'mm-test2',
    `${prefix}mm-test2`,
    'mm-test ',
    ' mm-test',
    `${prefix}mm-test `,
    '*',
    '%',
    '',
    CANARY_PATH,
  ];
  if (prefix !== '') paths.push('mm-test', `${prefix}${prefix}mm-test`);
  return [...new Set(paths)];
}

describe.each(['', 'INBOX.'])('TestFolder guard (namespace prefix %j)', (prefix) => {
  const target = `${prefix}mm-test`;

  it('resolves the path once from the personal namespace', () => {
    const fake = new FakeFolderClient(prefix);
    const folder = TestFolder.fromClient(fake);
    expect(folder.path).toBe(target);
    expect(testFolderPath(prefix)).toBe(target);
    fake.prefix = 'Other.';
    expect(folder.path).toBe(target);
    expect(fake.calls).toEqual([]);
  });

  for (const path of refusedPaths(prefix)) {
    it(`refuses ${JSON.stringify(path)} for every operation before any IMAP call`, async () => {
      // The refused folders exist on the fake, so a guard leak would be observable.
      const fake = new FakeFolderClient(prefix, [target, 'INBOX', 'Trash', path]);
      const folder = TestFolder.fromClient(fake);
      for (const op of OPERATIONS) {
        const err = await caught(() => run(folder, op, path));
        expect(err, `${op}(${JSON.stringify(path)})`).toBeInstanceOf(FolderGuardError);
        expect(err).toBeInstanceOf(TestGroundError);
        expect(fake.calls, `${op}(${JSON.stringify(path)})`).toEqual([]);
      }
      expect(fake.selected).toBeNull();
      expect([...fake.folders.keys()].sort()).toEqual(
        [...new Set([target, 'INBOX', 'Trash', path])].sort(),
      );
    });
  }

  it('the guard message never contains the refused path', async () => {
    const fake = new FakeFolderClient(prefix, [target]);
    const folder = TestFolder.fromClient(fake);
    for (const op of OPERATIONS) {
      const err = await caught(() => run(folder, op, CANARY_PATH));
      expect(err).toBeInstanceOf(FolderGuardError);
      expect((err as Error).message).not.toContain(CANARY_PATH);
      expect((err as Error).message).not.toBe('');
    }
  });

  it('allows the resolved path, explicitly or by default', async () => {
    const fake = new FakeFolderClient(prefix);
    const folder = TestFolder.fromClient(fake);

    expect(await folder.exists()).toBe(false);
    expect(await folder.create()).toBe(true);
    expect(await folder.create(target)).toBe(false);
    expect(await folder.exists(target)).toBe(true);
    expect(await folder.messageCount()).toBe(0);

    const open = await folder.open(target);
    expect(fake.selected).toBe(target);
    expect(folder.selectedPath()).toBe(target);
    await open.append(RAW, ['\\Seen'], new Date(Date.UTC(2024, 0, 1)));
    const messages = await open.fetchMessages();
    expect(messages).toHaveLength(1);
    await open.setFlags(messages[0]?.uid ?? -1, []);
    open.release();

    // Every path that reached the client is the resolved one.
    for (const call of fake.calls) {
      if (call.method === 'listPaths' || call.method === 'fetchMessages') continue;
      if (call.method === 'setFlags') continue;
      expect(call.args[0], call.method).toBe(target);
    }
    expect(fake.calls.filter((c) => c.method === 'create')).toHaveLength(2);
    expect(fake.calls.filter((c) => c.method === 'select')).toHaveLength(1);
    expect(fake.lockReleases).toBe(1);
  });
});

describe('TestFolder constants', () => {
  it('exports the folder name and the system flags', () => {
    expect(TEST_FOLDER).toBe('mm-test');
    expect(testFolderPath('')).toBe('mm-test');
    expect(testFolderPath('INBOX.')).toBe('INBOX.mm-test');
    expect([...SYSTEM_FLAGS]).toEqual([
      '\\Answered',
      '\\Deleted',
      '\\Draft',
      '\\Flagged',
      '\\Seen',
    ]);
  });
});

// ---------- selection and release rules ----------

describe('TestFolder selection rules', () => {
  function fresh(): { fake: FakeFolderClient; folder: TestFolder } {
    const fake = new FakeFolderClient('', ['mm-test', 'INBOX']);
    const folder = TestFolder.fromClient(fake);
    return { fake, folder };
  }

  it('remove refuses while the test folder is selected (no DELETE, no CLOSE)', async () => {
    const { fake, folder } = fresh();
    const open = await folder.open();

    let err = await caught(() => folder.remove());
    expect(err).toBeInstanceOf(TestGroundError);

    // Still selected after the handle is released: imapflow keeps the mailbox open.
    open.release();
    err = await caught(() => folder.remove());
    expect(err).toBeInstanceOf(TestGroundError);

    expect(fake.calls.filter((c) => c.method === 'delete')).toEqual([]);
    expect(fake.folders.has('mm-test')).toBe(true);
  });

  it('remove deletes, then unsubscribes (best effort) when the folder is not selected', async () => {
    const { fake, folder } = fresh();
    await folder.remove();
    expect(fake.writes()).toEqual([
      { method: 'delete', args: ['mm-test'] },
      { method: 'unsubscribe', args: ['mm-test'] },
    ]);
    expect(fake.folders.has('mm-test')).toBe(false);
  });

  it('every OpenTestFolder method throws after release(); release is idempotent', async () => {
    const { fake, folder } = fresh();
    const open = await folder.open();
    open.release();
    open.release();
    expect(fake.lockReleases).toBe(1);

    const before = fake.calls.length;
    for (const call of [
      () => open.fetchMessages(),
      () => open.append(RAW, [], new Date(Date.UTC(2024, 0, 1))),
      () => open.setFlags(1, []),
    ]) {
      const err = await caught(call);
      expect(err).toBeInstanceOf(TestGroundError);
      // Not the guard's "may only touch mm-test" text: the handle is just released.
      expect(err).not.toBeInstanceOf(FolderGuardError);
    }
    expect(fake.calls.slice(before)).toEqual([]);
    expect(fake.folders.get('mm-test')?.messages).toEqual([]);
  });

  it('every OpenTestFolder method throws when another folder got selected', async () => {
    const { fake, folder } = fresh();
    const open = await folder.open();
    // Someone selected another mailbox on the same connection.
    fake.selected = 'INBOX';

    const before = fake.calls.length;
    for (const call of [
      () => open.fetchMessages(),
      () => open.append(RAW, [], new Date(Date.UTC(2024, 0, 1))),
      () => open.setFlags(1, []),
    ]) {
      expect(await caught(call)).toBeInstanceOf(TestGroundError);
    }
    expect(fake.calls.slice(before)).toEqual([]);

    fake.selected = null;
    expect(await caught(() => open.fetchMessages())).toBeInstanceOf(TestGroundError);
    expect(fake.calls.slice(before)).toEqual([]);
    open.release();
  });

  it('refuses a second open() started before the first one resolved (no second select)', async () => {
    const { fake, folder } = fresh();
    const first = folder.open();
    const second = folder.open();
    expect(await caught(() => second)).toBeInstanceOf(TestGroundError);
    (await first).release();
    expect(fake.calls.filter((c) => c.method === 'select')).toHaveLength(1);
  });

  it('refuses a second open() while a handle is still open, allows it after release', async () => {
    const { fake, folder } = fresh();
    const first = await folder.open();

    expect(await caught(() => folder.open())).toBeInstanceOf(TestGroundError);
    expect(fake.calls.filter((c) => c.method === 'select')).toHaveLength(1);

    first.release();
    const second = await folder.open();
    expect(fake.calls.filter((c) => c.method === 'select')).toHaveLength(2);
    expect(await second.fetchMessages()).toEqual([]);
    second.release();
    expect(fake.lockReleases).toBe(2);
  });
});

// ---------- unseed ----------

describe('unseedTestGround', () => {
  it('missing folder → { deleted: false, messages: 0 } with no writes', async () => {
    const fake = new FakeFolderClient('', ['INBOX']);
    const result = await unseedTestGround(TestFolder.fromClient(fake));
    expect(result).toEqual({ deleted: false, messages: 0 });
    expect(fake.writes()).toEqual([]);
    expect(fake.folders.has('INBOX')).toBe(true);
  });

  it.each(['', 'INBOX.'])(
    'present folder (prefix %j) → reports the count, deletes and unsubscribes once',
    async (prefix) => {
      const target = `${prefix}mm-test`;
      const fake = new FakeFolderClient(prefix, ['INBOX', 'Trash', target]);
      fake.addMessages(target, 3);

      const result = await unseedTestGround(TestFolder.fromClient(fake));

      expect(result).toEqual({ deleted: true, messages: 3 });
      expect(fake.writes()).toEqual([
        { method: 'delete', args: [target] },
        { method: 'unsubscribe', args: [target] },
      ]);
      expect(fake.calls.some((c) => c.method === 'select')).toBe(false);
      expect([...fake.folders.keys()].sort()).toEqual(['INBOX', 'Trash']);
    },
  );

  it('a DELETE that leaves the folder in place → TestGroundError', async () => {
    const fake = new FakeFolderClient('', ['mm-test']);
    fake.addMessages('mm-test', 2);
    fake.deleteKeepsFolder = true;

    const err = await caught(() => unseedTestGround(TestFolder.fromClient(fake)));
    expect(err).toBeInstanceOf(TestGroundError);
    expect(fake.writes().filter((c) => c.method === 'delete')).toHaveLength(1);
    expect(fake.writes().some((c) => c.method === 'append' || c.method === 'setFlags')).toBe(false);
  });

  it('refuses while the test folder is selected on the same connection (no DELETE)', async () => {
    const fake = new FakeFolderClient('', ['mm-test']);
    fake.addMessages('mm-test', 1);
    fake.selected = 'mm-test';

    const err = await caught(() => unseedTestGround(TestFolder.fromClient(fake)));
    expect(err).toBeInstanceOf(TestGroundError);
    expect(fake.calls.filter((c) => c.method === 'delete')).toEqual([]);
    expect(fake.folders.has('mm-test')).toBe(true);
  });
});

// ---------- pure helpers ----------

describe('parseSeedId', () => {
  it.each([
    ['X-MM-Test-Seed: v1-001\r\n\r\n', 'v1-001'],
    ['x-mm-test-seed: v1-002\r\n\r\n', 'v1-002'],
    ['X-Mm-Test-Seed: v1-003\r\n\r\n', 'v1-003'],
    ['X-MM-TEST-SEED: v1-004\r\n\r\n', 'v1-004'],
    ['X-MM-Test-Seed:v1-005\r\n\r\n', 'v1-005'],
    ['X-MM-Test-Seed:   v1-006  \r\n\r\n', 'v1-006'],
    ['X-MM-Test-Seed: v1-007', 'v1-007'],
  ])('reads the header regardless of name case: %j', (text, expected) => {
    expect(parseSeedId(Buffer.from(text))).toBe(expected);
  });

  it('finds the header among other headers', () => {
    const headers =
      'Subject: hello\r\nX-Other: 1\r\nX-MM-Test-Seed: v1-042\r\nFrom: a@example.test\r\n\r\n';
    expect(parseSeedId(Buffer.from(headers))).toBe('v1-042');
  });

  it('unfolds a folded value', () => {
    expect(parseSeedId(Buffer.from('X-MM-Test-Seed:\r\n v1-008\r\n\r\n'))).toBe('v1-008');
  });

  it.each([
    ['undefined buffer', undefined],
    ['empty buffer', Buffer.alloc(0)],
    ['only the header terminator', Buffer.from('\r\n')],
    ['no seed header', Buffer.from('Subject: hi\r\nFrom: a@example.test\r\n\r\n')],
    ['name inside another header value', Buffer.from('X-Other: X-MM-Test-Seed: v9-999\r\n\r\n')],
    [
      'name on a folded continuation line',
      Buffer.from('Subject: hi\r\n X-MM-Test-Seed: v9-998\r\n\r\n'),
    ],
    ['a similar header name', Buffer.from('X-MM-Test-Seeds: v9-997\r\n\r\n')],
    ['prefixed header name', Buffer.from('XX-MM-Test-Seed: v9-996\r\n\r\n')],
  ])('%s → null', (_label, headers) => {
    expect(parseSeedId(headers)).toBeNull();
  });
});

describe('normalizeFlags', () => {
  it('keeps sorted system flags, drops \\Recent, splits keywords off (sorted)', () => {
    expect(
      normalizeFlags(['\\Seen', '\\Recent', '$HasAttachment', '\\Flagged', '$Junk', 'NonJunk']),
    ).toEqual({ flags: ['\\Flagged', '\\Seen'], keywords: ['$HasAttachment', '$Junk', 'NonJunk'] });
  });

  it('accepts any iterable (imapflow gives a Set)', () => {
    expect(normalizeFlags(new Set(['\\Draft', '\\Answered', '$HasNoAttachment']))).toEqual({
      flags: ['\\Answered', '\\Draft'],
      keywords: ['$HasNoAttachment'],
    });
  });

  it('sorts all five system flags', () => {
    expect(normalizeFlags(['\\Seen', '\\Flagged', '\\Draft', '\\Deleted', '\\Answered'])).toEqual({
      flags: ['\\Answered', '\\Deleted', '\\Draft', '\\Flagged', '\\Seen'],
      keywords: [],
    });
  });

  it('empty and \\Recent-only → nothing', () => {
    expect(normalizeFlags([])).toEqual({ flags: [], keywords: [] });
    expect(normalizeFlags(['\\Recent'])).toEqual({ flags: [], keywords: [] });
  });
});
