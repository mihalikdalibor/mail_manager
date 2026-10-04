import { describe, it, expect } from 'vitest';
import type {
  ListOptions,
  ListResponse,
  MailboxLockObject,
  StatusObject,
  StatusQuery,
} from 'imapflow';
import type { ServerFeatures } from '../../src/core/imap/features.js';
import type { ImapClientLike, QuotaInfo } from '../../src/core/imap/session.js';
import { MailboxError } from '../../src/core/mailbox/errors.js';
import {
  FALLBACK_OF,
  MAX_FOLDERS,
  SIZE_BATCH,
  buildTree,
  listFolders,
  roleOf,
  sizeRanges,
} from '../../src/core/mailbox/folders.js';
import type {
  FolderInfo,
  FolderSession,
  FolderTree,
  ListFoldersOptions,
  SizeProgress,
} from '../../src/core/mailbox/folders.js';

// M2a folder listing (spec): listFolders over a fake IMAP client, plus the pure helpers.

const CANARY = 'CANARY-server-text imap.secret-host.example canary@secret-domain.example';

// --- fake client --------------------------------------------------------------------------

type StatusSpec =
  { messages: number; unseen: number; size?: number } | false | 'throw' | 'error' | 'missing';

interface FakeFolder {
  path: string;
  delimiter?: string | null;
  flags?: string[];
  specialUse?: string;
  specialUseSource?: 'user' | 'extension' | 'name';
  subscribed?: boolean;
  /** STATUS answer; default { messages: exists ?? 0, unseen: 0 }. */
  status?: StatusSpec;
  /** EXISTS after EXAMINE; default status.messages (or 0). */
  exists?: number;
  /** RFC822.SIZE of message `seq`; default 100. */
  sizeOf?: (seq: number) => number;
  lockThrows?: boolean;
  fetchThrows?: boolean;
  /** A skipped seq is not yielded at all (the server gave up silently on it; no error). */
  skip?: (seq: number) => boolean;
  /** The answer for this seq carries no RFC822.SIZE. */
  noSize?: (seq: number) => boolean;
  /** The answer for this seq is yielded twice (a throttled FETCH that was reissued). */
  repeat?: (seq: number) => boolean;
  /** Extra unsolicited answers (with a size) streamed first in the range starting at `from`. */
  extra?: (range: { from: number; to: number }) => { seq: number; size: number }[];
}

interface FakeState {
  closed: boolean;
}

interface Hooks {
  onList?: (state: FakeState) => void;
  onStatus?: (path: string, state: FakeState) => void;
  onFetch?: (path: string, range: string, state: FakeState) => void;
  quota?: QuotaInfo | false | undefined | 'throw';
}

interface Calls {
  list: (ListOptions | undefined)[];
  status: { path: string; query: StatusQuery }[];
  getQuota: string[];
  lock: { path: string; options: unknown }[];
  release: string[];
  fetch: { path: string; range: string; query: unknown }[];
}

function features(over: Partial<ServerFeatures> = {}): ServerFeatures {
  return {
    uidplus: false,
    move: false,
    specialUse: false,
    quota: false,
    statusSize: false,
    condstore: false,
    qresync: false,
    esearch: false,
    within: false,
    listStatus: false,
    objectId: false,
    gmail: false,
    idle: false,
    compress: false,
    rev2: false,
    appendLimit: undefined,
    ...over,
  };
}

function statusSpec(f: FakeFolder): StatusSpec {
  return f.status ?? { messages: f.exists ?? 0, unseen: 0 };
}

function statusObject(f: FakeFolder, query: StatusQuery): StatusObject | false | 'throw' | null {
  const s = statusSpec(f);
  if (s === false) return false;
  if (s === 'throw') return 'throw';
  if (s === 'missing') return null;
  if (s === 'error') return { path: f.path, error: CANARY } as unknown as StatusObject;
  const out: StatusObject = { path: f.path, messages: s.messages, unseen: s.unseen };
  if (query.size === true && s.size !== undefined) out.size = s.size;
  return out;
}

function listEntry(f: FakeFolder, query: StatusQuery | undefined): ListResponse {
  const delimiter = f.delimiter === undefined ? '/' : f.delimiter;
  const parts = delimiter ? f.path.split(delimiter) : [f.path];
  const entry = {
    path: f.path,
    pathAsListed: f.path,
    name: parts[parts.length - 1] ?? f.path,
    delimiter,
    parent: parts.slice(0, -1),
    parentPath: delimiter ? parts.slice(0, -1).join(delimiter) : '',
    flags: new Set(f.flags ?? []),
    listed: true,
    subscribed: f.subscribed ?? true,
  } as unknown as ListResponse;
  if (f.specialUse !== undefined) entry.specialUse = f.specialUse;
  if (f.specialUseSource !== undefined) entry.specialUseSource = f.specialUseSource;
  if (query !== undefined) {
    const s = statusObject(f, query);
    if (s !== false && s !== 'throw' && s !== null) entry.status = s;
  }
  return entry;
}

function fake(
  folders: FakeFolder[],
  feat: Partial<ServerFeatures> = {},
  hooks: Hooks = {},
): { session: FolderSession; calls: Calls; state: FakeState } {
  const state: FakeState = { closed: false };
  const calls: Calls = { list: [], status: [], getQuota: [], lock: [], release: [], fetch: [] };
  const byPath = new Map(folders.map((f) => [f.path, f]));
  let mailbox: { exists: number } | false = false;
  let selected: string | null = null;

  const client = {
    options: {},
    capabilities: new Map(),
    enabled: new Set(),
    serverInfo: null,
    usable: true,
    get mailbox() {
      return mailbox;
    },
    connect: () => Promise.resolve(),
    logout: () => Promise.resolve(),
    close: () => undefined,
    on: () => undefined,
    list(options?: ListOptions): Promise<ListResponse[]> {
      calls.list.push(options);
      hooks.onList?.(state);
      return Promise.resolve(folders.map((f) => listEntry(f, options?.statusQuery)));
    },
    status(path: string, query: StatusQuery): Promise<StatusObject | false> {
      calls.status.push({ path, query });
      hooks.onStatus?.(path, state);
      if (state.closed) return Promise.reject(new Error(CANARY));
      const f = byPath.get(path);
      if (f === undefined) return Promise.reject(new Error(CANARY));
      const s = statusObject(f, query);
      if (s === 'throw') return Promise.reject(new Error(CANARY));
      if (s === null) return Promise.resolve(false);
      return Promise.resolve(s);
    },
    getQuota(path: string): Promise<QuotaInfo | false | undefined> {
      calls.getQuota.push(path);
      if (hooks.quota === 'throw') return Promise.reject(new Error(CANARY));
      return Promise.resolve(hooks.quota);
    },
    getMailboxLock(path: string, options?: unknown): Promise<MailboxLockObject> {
      calls.lock.push({ path, options });
      const f = byPath.get(path);
      if (f === undefined || f.lockThrows === true) return Promise.reject(new Error(CANARY));
      const s = statusSpec(f);
      mailbox = { exists: f.exists ?? (typeof s === 'object' ? s.messages : 0) };
      selected = path;
      return Promise.resolve({
        path,
        release: () => {
          calls.release.push(path);
        },
      });
    },
    fetch(range: string, query: unknown): AsyncIterable<{ seq?: number; size?: number }> {
      const path = selected ?? '';
      calls.fetch.push({ path, range, query });
      const f = byPath.get(path);
      return {
        async *[Symbol.asyncIterator]() {
          await Promise.resolve();
          hooks.onFetch?.(path, range, state);
          if (state.closed || f === undefined || f.fetchThrows === true) {
            throw new Error(CANARY);
          }
          const [from, to] = range.split(':').map(Number);
          for (const e of f.extra?.({ from: from ?? 1, to: to ?? 0 }) ?? []) yield e;
          for (let seq = from ?? 1; seq <= (to ?? 0); seq++) {
            if (f.skip?.(seq) === true) continue;
            if (f.noSize?.(seq) === true) {
              yield { seq };
              continue;
            }
            const answer = { seq, size: f.sizeOf ? f.sizeOf(seq) : 100 };
            yield answer;
            if (f.repeat?.(seq) === true) yield { ...answer };
          }
        },
      };
    },
  };

  const session = {
    client: client as unknown as ImapClientLike,
    features: features(feat),
    get closed() {
      return state.closed;
    },
  } as FolderSession;
  return { session, calls, state };
}

async function run(
  folders: FakeFolder[],
  feat: Partial<ServerFeatures> = {},
  opts: Partial<ListFoldersOptions> = {},
  hooks: Hooks = {},
): Promise<{ tree: FolderTree; calls: Calls }> {
  const { session, calls } = fake(folders, feat, hooks);
  const tree = await listFolders(session, { sizes: false, ...opts });
  return { tree, calls };
}

function byPath(tree: FolderTree, path: string): FolderInfo {
  const f = tree.folders.find((x) => x.path === path);
  if (f === undefined) throw new Error(`no folder ${path}`);
  return f;
}

async function mailboxError(p: Promise<unknown>): Promise<MailboxError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(MailboxError);
    return err as MailboxError;
  }
  throw new Error('expected a rejection');
}

// --- pure helpers ---------------------------------------------------------------------------

describe('constants', () => {
  it('MAX_FOLDERS and SIZE_BATCH are 5,000', () => {
    expect(MAX_FOLDERS).toBe(5000);
    expect(SIZE_BATCH).toBe(5000);
  });

  it('FALLBACK_OF maps each feature to its fallback', () => {
    expect(FALLBACK_OF).toEqual({
      'status-size': 'fetch-size-sum',
      quota: 'folder-sum',
      'list-status': 'status-per-folder',
    });
  });
});

describe('sizeRanges', () => {
  it.each<[number, string[]]>([
    [0, []],
    [1, ['1:1']],
    [4999, ['1:4999']],
    [5000, ['1:5000']],
    [5001, ['1:5000', '5001:5001']],
    [12345, ['1:5000', '5001:10000', '10001:12345']],
  ])('sizeRanges(%i)', (exists, ranges) => {
    expect(sizeRanges(exists)).toEqual(ranges);
  });

  it('batchSize overrides 5,000', () => {
    expect(sizeRanges(10, 5)).toEqual(['1:5', '6:10']);
    expect(sizeRanges(11, 5)).toEqual(['1:5', '6:10', '11:11']);
  });
});

describe('roleOf', () => {
  it.each(['INBOX', 'inbox', 'Inbox'])('path %s → inbox from path', (path) => {
    expect(roleOf({ path })).toEqual({ role: 'inbox', roleSource: 'path' });
  });

  it('INBOX wins over a special-use flag', () => {
    expect(roleOf({ path: 'INBOX', specialUse: '\\Sent', specialUseSource: 'extension' })).toEqual({
      role: 'inbox',
      roleSource: 'path',
    });
  });

  it.each<[string, string]>([
    ['\\All', 'all'],
    ['\\Archive', 'archive'],
    ['\\Drafts', 'drafts'],
    ['\\Flagged', 'flagged'],
    ['\\Junk', 'junk'],
    ['\\Sent', 'sent'],
    ['\\Trash', 'trash'],
  ])('%s → %s', (specialUse, role) => {
    for (const src of ['extension', 'name', 'user'] as const) {
      expect(roleOf({ path: 'Folder', specialUse, specialUseSource: src })).toEqual({
        role,
        roleSource: src,
      });
    }
  });

  it('unknown or no special use → null/null', () => {
    expect(roleOf({ path: 'Folder' })).toEqual({ role: null, roleSource: null });
    expect(
      roleOf({ path: 'Folder', specialUse: '\\Important', specialUseSource: 'extension' }),
    ).toEqual({ role: null, roleSource: null });
    expect(roleOf({ path: 'INBOX/Sub' })).toEqual({ role: null, roleSource: null });
  });
});

// --- LIST -----------------------------------------------------------------------------------

describe('listFolders: entries', () => {
  it('drops \\NonExistent entries (case-insensitive), keeps the rest', async () => {
    const { tree, calls } = await run([
      { path: 'INBOX' },
      { path: 'Gone', flags: ['\\NonExistent'] },
      { path: 'Gone2', flags: ['\\nonexistent'] },
      { path: 'Kept' },
    ]);
    expect(tree.folders.map((f) => f.path).sort()).toEqual(['INBOX', 'Kept']);
    expect(calls.status.map((c) => c.path)).not.toContain('Gone');
    expect(calls.status.map((c) => c.path)).not.toContain('Gone2');
  });

  it('keeps every field of a plain entry', async () => {
    const { tree } = await run([{ path: 'INBOX', status: { messages: 4, unseen: 1 } }]);
    expect(tree.folders).toHaveLength(1);
    const f = byPath(tree, 'INBOX');
    expect(f).toMatchObject({
      path: 'INBOX',
      name: 'INBOX',
      parentPath: null,
      depth: 0,
      delimiter: '/',
      role: 'inbox',
      roleSource: 'path',
      selectable: true,
      subscribed: true,
      messages: 4,
      unseen: 1,
      bytes: null,
      overlapping: false,
    });
    expect(tree.truncated).toBe(false);
    expect(tree.unreadable).toBe(0);
    expect(tree.gmailAllHidden).toBe(false);
  });

  it('caps at 5,000 folders in LIST order; only those are STATUSed', async () => {
    const folders: FakeFolder[] = [];
    for (let i = 0; i <= MAX_FOLDERS; i++) folders.push({ path: `F${String(i).padStart(5, '0')}` });
    const { tree, calls } = await run(folders);
    expect(tree.truncated).toBe(true);
    expect(tree.folders).toHaveLength(MAX_FOLDERS);
    const last = folders[MAX_FOLDERS]?.path ?? '';
    expect(tree.folders.map((f) => f.path)).not.toContain(last);
    expect(calls.status).toHaveLength(MAX_FOLDERS);
    expect(calls.status.map((c) => c.path)).not.toContain(last);
  });

  it('exactly 5,000 folders is not truncated', async () => {
    const folders: FakeFolder[] = [];
    for (let i = 0; i < MAX_FOLDERS; i++) folders.push({ path: `F${String(i).padStart(5, '0')}` });
    const { tree } = await run(folders);
    expect(tree.truncated).toBe(false);
    expect(tree.folders).toHaveLength(MAX_FOLDERS);
  });

  it('roles from the path and from special use', async () => {
    const { tree } = await run([
      { path: 'INBOX' },
      { path: 'Sent', specialUse: '\\Sent', specialUseSource: 'extension' },
      { path: 'Trash', specialUse: '\\Trash', specialUseSource: 'name' },
      { path: 'Stuff', specialUse: '\\Archive', specialUseSource: 'user' },
      { path: 'Plain' },
    ]);
    expect(byPath(tree, 'INBOX')).toMatchObject({ role: 'inbox', roleSource: 'path' });
    expect(byPath(tree, 'Sent')).toMatchObject({ role: 'sent', roleSource: 'extension' });
    expect(byPath(tree, 'Trash')).toMatchObject({ role: 'trash', roleSource: 'name' });
    expect(byPath(tree, 'Stuff')).toMatchObject({ role: 'archive', roleSource: 'user' });
    expect(byPath(tree, 'Plain')).toMatchObject({ role: null, roleSource: null });
  });

  it('\\Noselect: not selectable, null counts, not unreadable, never STATUSed or sized', async () => {
    const { tree, calls } = await run(
      [
        { path: 'INBOX', exists: 2 },
        { path: 'Parent', flags: ['\\Noselect'] },
        { path: 'Parent/Child', exists: 1 },
      ],
      {},
      { sizes: true },
    );
    expect(byPath(tree, 'Parent')).toMatchObject({
      selectable: false,
      messages: null,
      unseen: null,
      bytes: null,
    });
    expect(tree.unreadable).toBe(0);
    expect(calls.status.map((c) => c.path)).not.toContain('Parent');
    expect(calls.lock.map((c) => c.path)).not.toContain('Parent');
    expect(byPath(tree, 'Parent/Child').selectable).toBe(true);
  });

  it('\\NoSelect matches case-insensitively too', async () => {
    const { tree, calls } = await run([{ path: 'P', flags: ['\\NOSELECT'] }]);
    expect(byPath(tree, 'P').selectable).toBe(false);
    expect(calls.status).toHaveLength(0);
  });

  it('unsubscribed folders are listed with subscribed: false', async () => {
    const { tree } = await run([{ path: 'INBOX' }, { path: 'Hidden', subscribed: false }]);
    expect(byPath(tree, 'Hidden').subscribed).toBe(false);
    expect(byPath(tree, 'INBOX').subscribed).toBe(true);
  });
});

describe('listFolders: tree', () => {
  it('parent before child; INBOX first, then special use, then the rest by path', async () => {
    const { tree } = await run([
      { path: 'Zeta' },
      { path: 'Alpha/Child' },
      { path: 'Sent', specialUse: '\\Sent', specialUseSource: 'extension' },
      { path: 'INBOX/Sub' },
      { path: 'Alpha' },
      { path: 'Archive', specialUse: '\\Archive', specialUseSource: 'extension' },
      { path: 'INBOX' },
    ]);
    const paths = tree.folders.map((f) => f.path);
    expect(paths).toHaveLength(7);
    // Depth-first: each child right after its parent's subtree starts.
    expect(paths.slice(0, 2)).toEqual(['INBOX', 'INBOX/Sub']);
    expect(paths.slice(2, 4).sort()).toEqual(['Archive', 'Sent']);
    expect(paths.slice(4)).toEqual(['Alpha', 'Alpha/Child', 'Zeta']);
    expect(byPath(tree, 'INBOX/Sub')).toMatchObject({ parentPath: 'INBOX', depth: 1, name: 'Sub' });
    expect(byPath(tree, 'Alpha/Child')).toMatchObject({ parentPath: 'Alpha', depth: 1 });
    expect(byPath(tree, 'Zeta')).toMatchObject({ parentPath: null, depth: 0 });
  });

  it('INBOX is first even when listed in lower case and last', async () => {
    const { tree } = await run([{ path: 'Aaa' }, { path: 'inbox' }]);
    expect(tree.folders.map((f) => f.path)).toEqual(['inbox', 'Aaa']);
  });

  it('works with a "." delimiter', async () => {
    const { tree } = await run([
      { path: 'INBOX', delimiter: '.' },
      { path: 'INBOX.Sent', delimiter: '.', specialUse: '\\Sent', specialUseSource: 'name' },
      { path: 'INBOX.Work.2026', delimiter: '.' },
      { path: 'INBOX.Work', delimiter: '.' },
    ]);
    expect(byPath(tree, 'INBOX.Sent')).toMatchObject({
      parentPath: 'INBOX',
      depth: 1,
      delimiter: '.',
    });
    expect(byPath(tree, 'INBOX.Work.2026')).toMatchObject({ parentPath: 'INBOX.Work', depth: 2 });
    const paths = tree.folders.map((f) => f.path);
    expect(paths[0]).toBe('INBOX');
    expect(paths.indexOf('INBOX.Work')).toBeLessThan(paths.indexOf('INBOX.Work.2026'));
  });

  it.each([null, ''])(
    'a flat namespace (delimiter %j) puts every folder at depth 0',
    async (delimiter) => {
      const { tree } = await run([
        { path: 'INBOX', delimiter },
        { path: 'a.b', delimiter },
        { path: 'c/d', delimiter },
      ]);
      for (const f of tree.folders) expect(f).toMatchObject({ depth: 0, parentPath: null });
      expect(tree.folders[0]?.path).toBe('INBOX');
    },
  );

  it('a child with an unlisted parent hangs under the nearest listed ancestor, keeps its depth', async () => {
    const { tree } = await run([{ path: 'A' }, { path: 'A/B/C' }, { path: 'X/Y' }]);
    expect(tree.folders).toHaveLength(3);
    expect(byPath(tree, 'A/B/C')).toMatchObject({ parentPath: 'A', depth: 2 });
    expect(byPath(tree, 'X/Y')).toMatchObject({ parentPath: null, depth: 1 });
    const paths = tree.folders.map((f) => f.path);
    expect(paths.indexOf('A')).toBeLessThan(paths.indexOf('A/B/C'));
  });

  it('buildTree works directly on FolderInfo and adds no placeholders', () => {
    const info = (path: string): FolderInfo => ({
      path,
      name: path.split('/').pop() ?? path,
      parentPath: null,
      depth: 0,
      delimiter: '/',
      role: null,
      roleSource: null,
      selectable: true,
      subscribed: true,
      messages: null,
      unseen: null,
      bytes: null,
      sizeSource: null,
      overlapping: false,
    });
    const out = buildTree([info('B/C/D'), info('B'), info('A')]);
    expect(out.map((f) => f.path)).toEqual(['A', 'B', 'B/C/D']);
    expect(out[2]).toMatchObject({ parentPath: 'B', depth: 2 });
  });
});

// --- counts ---------------------------------------------------------------------------------

describe('listFolders: counts', () => {
  const two: FakeFolder[] = [
    { path: 'INBOX', status: { messages: 10, unseen: 2, size: 1000 } },
    { path: 'Sent', status: { messages: 5, unseen: 0, size: 500 } },
  ];

  it('LIST-STATUS: one list() with a status query, no status() calls', async () => {
    const { tree, calls } = await run(two, { listStatus: true });
    expect(calls.list).toHaveLength(1);
    const q = calls.list[0]?.statusQuery;
    expect(q?.messages).toBe(true);
    expect(q?.unseen).toBe(true);
    expect(q?.size).toBeFalsy();
    expect(calls.status).toHaveLength(0);
    expect(byPath(tree, 'INBOX')).toMatchObject({ messages: 10, unseen: 2 });
    expect(tree.fallbacks.has('list-status')).toBe(false);
  });

  it('LIST-STATUS asks for size only with sizes && STATUS=SIZE', async () => {
    const a = await run(two, { listStatus: true, statusSize: true }, { sizes: true });
    expect(a.calls.list[0]?.statusQuery?.size).toBe(true);
    const b = await run(two, { listStatus: true, statusSize: true }, { sizes: false });
    expect(b.calls.list[0]?.statusQuery?.size).toBeFalsy();
    const c = await run(two, { listStatus: true, statusSize: false }, { sizes: true });
    expect(c.calls.list[0]?.statusQuery?.size).toBeFalsy();
  });

  it('without LIST-STATUS: plain list(), one status() per selectable folder', async () => {
    const { tree, calls } = await run([...two, { path: 'NS', flags: ['\\Noselect'] }]);
    expect(calls.list).toHaveLength(1);
    expect(calls.list[0]?.statusQuery).toBeUndefined();
    expect(calls.status.map((c) => c.path).sort()).toEqual(['INBOX', 'Sent']);
    for (const c of calls.status) {
      expect(c.query.messages).toBe(true);
      expect(c.query.unseen).toBe(true);
    }
    expect(byPath(tree, 'Sent')).toMatchObject({ messages: 5, unseen: 0 });
    expect(tree.fallbacks.has('list-status')).toBe(true);
  });

  it.each<[string, StatusSpec]>([
    ['false', false],
    ['a throw', 'throw'],
    ['an error object', 'error'],
    ['missing', 'missing'],
  ])('STATUS %s → null counts, unreadable +1, the rest still lists', async (_n, status) => {
    for (const listStatus of [false, true]) {
      const { tree } = await run(
        [
          { path: 'INBOX', status: { messages: 3, unseen: 1 } },
          { path: 'Bad', status },
        ],
        { listStatus },
        { sizes: true },
      );
      expect(byPath(tree, 'Bad')).toMatchObject({ messages: null, unseen: null, bytes: null });
      expect(byPath(tree, 'INBOX')).toMatchObject({ messages: 3, unseen: 1 });
      expect(tree.unreadable).toBe(1);
      expect(JSON.stringify({ ...tree, fallbacks: [...tree.fallbacks] })).not.toContain('CANARY');
    }
  });
});

// --- sizes ----------------------------------------------------------------------------------

describe('listFolders: sizes', () => {
  it('a numeric status.size is used as-is, no lock/fetch', async () => {
    const { tree, calls } = await run(
      [{ path: 'INBOX', status: { messages: 3, unseen: 0, size: 1234 } }],
      { statusSize: true },
      { sizes: true },
    );
    expect(byPath(tree, 'INBOX')).toMatchObject({ bytes: 1234, sizeSource: 'server' });
    expect(calls.lock).toHaveLength(0);
    expect(calls.fetch).toHaveLength(0);
    expect(tree.fallbacks.has('status-size')).toBe(false);
  });

  it('fallback: EXAMINE, fetch per range, sum, release', async () => {
    const progress: SizeProgress[] = [];
    const { tree, calls } = await run(
      [{ path: 'INBOX', status: { messages: 12, unseen: 0 }, exists: 12, sizeOf: (s) => s }],
      {},
      { sizes: true, batchSize: 5, onProgress: (p) => progress.push({ ...p }) },
    );
    expect(calls.lock).toEqual([{ path: 'INBOX', options: { readOnly: true } }]);
    expect(calls.fetch.map((c) => c.range)).toEqual(['1:5', '6:10', '11:12']);
    for (const c of calls.fetch) expect(c.query).toMatchObject({ size: true });
    expect(calls.release).toEqual(['INBOX']);
    expect(byPath(tree, 'INBOX')).toMatchObject({ bytes: 78, sizeSource: 'sum' });
    expect(tree.fallbacks.has('status-size')).toBe(true);
    expect(progress).toHaveLength(3);
    for (const p of progress) expect(p).toMatchObject({ folder: 1, folders: 1 });
    const last = progress[progress.length - 1];
    expect(last?.done).toBe(last?.total);
    expect(last?.total).toBe(12);
  });

  it('fallback when STATUS=SIZE is advertised but the server omitted size', async () => {
    const { tree, calls } = await run(
      [{ path: 'INBOX', status: { messages: 2, unseen: 0 }, exists: 2 }],
      { statusSize: true, listStatus: true },
      { sizes: true },
    );
    expect(calls.lock).toHaveLength(1);
    expect(byPath(tree, 'INBOX')).toMatchObject({ bytes: 200, sizeSource: 'sum' });
    expect(tree.fallbacks.has('status-size')).toBe(true);
  });

  it('progress counts folders needing the fallback, 1-based', async () => {
    const progress: SizeProgress[] = [];
    await run(
      [
        { path: 'INBOX', status: { messages: 2, unseen: 0 } },
        { path: 'Server', status: { messages: 2, unseen: 0, size: 9 } },
        { path: 'Zed', status: { messages: 3, unseen: 0 } },
      ],
      { statusSize: true },
      { sizes: true, onProgress: (p) => progress.push({ ...p }) },
    );
    expect(progress.length).toBeGreaterThanOrEqual(2);
    for (const p of progress) expect(p.folders).toBe(2);
    expect(new Set(progress.map((p) => p.folder))).toEqual(new Set([1, 2]));
  });

  it('messages 0 → bytes 0, no lock/fetch', async () => {
    const { tree, calls } = await run(
      [{ path: 'INBOX', status: { messages: 0, unseen: 0 }, exists: 0 }],
      {},
      { sizes: true },
    );
    expect(byPath(tree, 'INBOX').bytes).toBe(0);
    expect(calls.lock).toHaveLength(0);
    expect(calls.fetch).toHaveLength(0);
  });

  it('a fetch error: lock released, bytes null, unreadable +1, others continue', async () => {
    const { tree, calls } = await run(
      [
        { path: 'INBOX', status: { messages: 2, unseen: 0 }, fetchThrows: true },
        { path: 'Other', status: { messages: 1, unseen: 0 } },
      ],
      {},
      { sizes: true },
    );
    expect(calls.release).toContain('INBOX');
    expect(calls.release).toHaveLength(calls.lock.length);
    expect(byPath(tree, 'INBOX')).toMatchObject({ bytes: null, messages: 2 });
    expect(byPath(tree, 'Other')).toMatchObject({ bytes: 100, sizeSource: 'sum' });
    expect(tree.unreadable).toBe(1);
  });

  it('a lock error: bytes null, unreadable +1, others continue', async () => {
    const { tree } = await run(
      [
        { path: 'INBOX', status: { messages: 2, unseen: 0 }, lockThrows: true },
        { path: 'Other', status: { messages: 1, unseen: 0 } },
      ],
      {},
      { sizes: true },
    );
    expect(byPath(tree, 'INBOX').bytes).toBeNull();
    expect(byPath(tree, 'Other').bytes).toBe(100);
    expect(tree.unreadable).toBe(1);
  });

  it('memory bound: 100,000 lazily yielded messages, each range requested once', async () => {
    const { tree, calls } = await run(
      [
        {
          path: 'INBOX',
          status: { messages: 100_000, unseen: 0 },
          exists: 100_000,
          sizeOf: () => 7,
        },
      ],
      {},
      { sizes: true },
    );
    const expected: string[] = [];
    for (let i = 0; i < 20; i++) expected.push(`${i * 5000 + 1}:${(i + 1) * 5000}`);
    expect(calls.fetch.map((c) => c.range)).toEqual(expected);
    expect(byPath(tree, 'INBOX').bytes).toBe(700_000);
  });

  it('sizes: false → no lock/fetch, no size query, no status-size fallback', async () => {
    const { tree, calls } = await run(
      [{ path: 'INBOX', status: { messages: 2, unseen: 0, size: 50 } }],
      { statusSize: true },
      { sizes: false },
    );
    expect(calls.lock).toHaveLength(0);
    expect(calls.fetch).toHaveLength(0);
    for (const c of calls.status) expect(c.query.size).toBeFalsy();
    expect(tree.fallbacks.has('status-size')).toBe(false);
    expect(byPath(tree, 'INBOX').bytes).toBeNull();
  });
});

describe('listFolders: only', () => {
  const folders: FakeFolder[] = [
    { path: 'INBOX', status: { messages: 1, unseen: 0 } },
    { path: 'X', status: { messages: 2, unseen: 1 } },
    { path: 'Y', status: { messages: 3, unseen: 0 } },
  ];

  it.each([false, true])('only X is STATUSed/sized (listStatus %s)', async (listStatus) => {
    const { tree, calls } = await run(
      folders,
      { listStatus },
      { sizes: true, only: (p) => p === 'X' },
    );
    expect(calls.list[0]?.statusQuery).toBeUndefined();
    expect(calls.status.map((c) => c.path)).toEqual(['X']);
    expect(calls.lock.map((c) => c.path)).toEqual(['X']);
    expect(byPath(tree, 'X')).toMatchObject({ messages: 2, unseen: 1, bytes: 200 });
    expect(byPath(tree, 'Y')).toMatchObject({ messages: null, unseen: null, bytes: null });
    expect(byPath(tree, 'INBOX').messages).toBeNull();
    expect(tree.folders).toHaveLength(3);
    expect(tree.unreadable).toBe(0);
  });
});

// --- quota ----------------------------------------------------------------------------------

describe('listFolders: quota', () => {
  it('reads GETQUOTA on INBOX (usage in bytes)', async () => {
    const { tree, calls } = await run(
      [{ path: 'INBOX' }],
      { quota: true },
      {},
      {
        quota: { storage: { usage: 2048, limit: 4096 } },
      },
    );
    expect(calls.getQuota).toEqual(['INBOX']);
    expect(tree.quota).toEqual({ usedBytes: 2048, limitBytes: 4096 });
    expect(tree.fallbacks.has('quota')).toBe(false);
  });

  it('a missing limit → limitBytes null', async () => {
    const { tree } = await run(
      [{ path: 'INBOX' }],
      { quota: true },
      {},
      {
        quota: { storage: { usage: 2048 } },
      },
    );
    expect(tree.quota).toEqual({ usedBytes: 2048, limitBytes: null });
  });

  it.each<[string, Hooks['quota']]>([
    ['false', false],
    ['undefined', undefined],
    ['no storage', {}],
    ['a throw', 'throw'],
  ])('%s → quota null + quota fallback', async (_n, quota) => {
    const { tree } = await run([{ path: 'INBOX' }], { quota: true }, {}, { quota });
    expect(tree.quota).toBeNull();
    expect(tree.fallbacks.has('quota')).toBe(true);
  });

  it('no QUOTA feature → no GETQUOTA, quota null + quota fallback', async () => {
    const { tree, calls } = await run(
      [{ path: 'INBOX' }],
      { quota: false },
      {},
      {
        quota: { storage: { usage: 1, limit: 2 } },
      },
    );
    expect(calls.getQuota).toHaveLength(0);
    expect(tree.quota).toBeNull();
    expect(tree.fallbacks.has('quota')).toBe(true);
  });
});

// --- totals ---------------------------------------------------------------------------------

describe('listFolders: totals', () => {
  it('sums selectable folders (server sizes)', async () => {
    const { tree } = await run(
      [
        { path: 'INBOX', status: { messages: 10, unseen: 2, size: 1000 } },
        { path: 'NS', flags: ['\\Noselect'] },
        { path: 'NS/Sent', status: { messages: 5, unseen: 1, size: 500 } },
      ],
      { statusSize: true },
      { sizes: true },
    );
    expect(tree.totals).toEqual({ messages: 15, unseen: 3, bytes: 1500, sizeSource: 'server' });
  });

  it("'sum' when any summed folder used the fallback", async () => {
    const { tree } = await run(
      [
        { path: 'INBOX', status: { messages: 1, unseen: 0, size: 1000 } },
        { path: 'Other', status: { messages: 2, unseen: 0 } },
      ],
      { statusSize: true },
      { sizes: true },
    );
    expect(tree.totals).toEqual({ messages: 3, unseen: 0, bytes: 1200, sizeSource: 'sum' });
  });

  it('a null value makes that total null', async () => {
    const { tree } = await run(
      [
        { path: 'INBOX', status: { messages: 1, unseen: 0 } },
        { path: 'Bad', status: false },
      ],
      {},
      { sizes: true },
    );
    expect(tree.totals).toEqual({ messages: null, unseen: null, bytes: null, sizeSource: null });
  });

  it('sizes: false → bytes and sizeSource null, counts summed', async () => {
    const { tree } = await run([
      { path: 'INBOX', status: { messages: 1, unseen: 1 } },
      { path: 'B', status: { messages: 2, unseen: 0 } },
    ]);
    expect(tree.totals).toEqual({ messages: 3, unseen: 1, bytes: null, sizeSource: null });
  });
});

describe('listFolders: Gmail', () => {
  const gmail: FakeFolder[] = [
    { path: 'INBOX', status: { messages: 4, unseen: 1 } },
    { path: '[Gmail]', flags: ['\\Noselect'] },
    {
      path: '[Gmail]/All Mail',
      specialUse: '\\All',
      specialUseSource: 'extension',
      status: { messages: 10, unseen: 2 },
    },
    {
      path: '[Gmail]/Trash',
      specialUse: '\\Trash',
      specialUseSource: 'extension',
      status: { messages: 3, unseen: 0 },
    },
    {
      path: '[Gmail]/Spam',
      specialUse: '\\Junk',
      specialUseSource: 'extension',
      status: { messages: 2, unseen: 2 },
    },
    {
      path: '[Gmail]/Sent Mail',
      specialUse: '\\Sent',
      specialUseSource: 'extension',
      status: { messages: 5, unseen: 0 },
    },
    { path: 'Work', status: { messages: 6, unseen: 1 } },
  ];

  it('total = All + Trash + Junk; the rest is overlapping; only those three are sized', async () => {
    const { tree, calls } = await run(gmail, { gmail: true }, { sizes: true });
    expect(tree.totals).toEqual({ messages: 15, unseen: 4, bytes: 1500, sizeSource: 'sum' });
    expect(tree.gmailAllHidden).toBe(false);
    expect(calls.lock.map((c) => c.path).sort()).toEqual([
      '[Gmail]/All Mail',
      '[Gmail]/Spam',
      '[Gmail]/Trash',
    ]);
    for (const p of ['INBOX', '[Gmail]/Sent Mail', 'Work']) {
      expect(byPath(tree, p)).toMatchObject({ overlapping: true, bytes: null });
      expect(byPath(tree, p).messages).not.toBeNull();
    }
    for (const p of ['[Gmail]/All Mail', '[Gmail]/Trash', '[Gmail]/Spam', '[Gmail]']) {
      expect(byPath(tree, p).overlapping).toBe(false);
    }
    expect(tree.unreadable).toBe(0);
  });

  it('no \\All listed → totals null, gmailAllHidden', async () => {
    const { tree } = await run(
      gmail.filter((f) => f.specialUse !== '\\All'),
      { gmail: true },
      { sizes: true },
    );
    expect(tree.totals).toBeNull();
    expect(tree.gmailAllHidden).toBe(true);
  });

  it('a non-Gmail server never marks overlapping', async () => {
    const { tree } = await run(gmail, { gmail: false });
    for (const f of tree.folders) expect(f.overlapping).toBe(false);
    expect(tree.gmailAllHidden).toBe(false);
  });
});

// --- errors ---------------------------------------------------------------------------------

describe('listFolders: errors', () => {
  it('list() throws while open → list-failed, no server text', async () => {
    const { session } = fake(
      [{ path: 'INBOX' }],
      {},
      {
        onList: () => {
          throw new Error(CANARY);
        },
      },
    );
    const err = await mailboxError(listFolders(session, { sizes: false }));
    expect(err.code).toBe('list-failed');
    expect(err.name).toBe('MailboxError');
    expect(err.message).not.toContain('CANARY');
  });

  it('closed during list() (throwing) → connection-lost', async () => {
    const { session } = fake(
      [{ path: 'INBOX' }],
      {},
      {
        onList: (s) => {
          s.closed = true;
          throw new Error(CANARY);
        },
      },
    );
    const err = await mailboxError(listFolders(session, { sizes: false }));
    expect(err.code).toBe('connection-lost');
    expect(err.message).not.toContain('CANARY');
  });

  it('closed after list() returned → connection-lost', async () => {
    const { session } = fake(
      [{ path: 'INBOX' }],
      { listStatus: true },
      {
        onList: (s) => {
          s.closed = true;
        },
      },
    );
    const err = await mailboxError(listFolders(session, { sizes: false }));
    expect(err.code).toBe('connection-lost');
  });

  it('closed inside status() → connection-lost, not a list of nulls', async () => {
    const { session } = fake(
      [{ path: 'INBOX' }, { path: 'B' }],
      {},
      {
        onStatus: (_p, s) => {
          s.closed = true;
        },
      },
    );
    const err = await mailboxError(listFolders(session, { sizes: false }));
    expect(err.code).toBe('connection-lost');
    expect(err.message).not.toContain('CANARY');
  });

  it('closed during a fetch → connection-lost, lock released', async () => {
    const { session, calls } = fake(
      [{ path: 'INBOX', status: { messages: 3, unseen: 0 } }],
      {},
      {
        onFetch: (_p, _r, s) => {
          s.closed = true;
        },
      },
    );
    const err = await mailboxError(listFolders(session, { sizes: true }));
    expect(err.code).toBe('connection-lost');
    expect(err.message).not.toContain('CANARY');
    expect(calls.release).toHaveLength(calls.lock.length);
  });
});

describe('listFolders: fallbacks', () => {
  it('a Set with each feature at most once', async () => {
    const { tree } = await run(
      [
        { path: 'INBOX', status: { messages: 1, unseen: 0 } },
        { path: 'A', status: { messages: 1, unseen: 0 } },
        { path: 'B', status: { messages: 1, unseen: 0 } },
      ],
      {},
      { sizes: true },
    );
    expect(tree.fallbacks).toBeInstanceOf(Set);
    expect([...tree.fallbacks].sort()).toEqual(['list-status', 'quota', 'status-size']);
  });

  it('none when every feature is there', async () => {
    const { tree } = await run(
      [{ path: 'INBOX', status: { messages: 1, unseen: 0, size: 10 } }],
      { listStatus: true, statusSize: true, quota: true },
      { sizes: true },
      { quota: { storage: { usage: 10, limit: 100 } } },
    );
    expect([...tree.fallbacks]).toEqual([]);
  });
});

// --- M2-fix: the size fallback when the server silently returns fewer sizes than messages ---

describe('listFolders: size fallback short reads', () => {
  it('fewer sized responses than EXISTS (no error): bytes null, sizeSource null, unreadable 1', async () => {
    const { tree, calls } = await run(
      [
        {
          path: 'INBOX',
          status: { messages: 12, unseen: 3 },
          exists: 12,
          skip: (seq) => seq > 10,
        },
      ],
      {},
      { sizes: true, batchSize: 5 },
    );
    expect(byPath(tree, 'INBOX')).toMatchObject({
      bytes: null,
      sizeSource: null,
      messages: 12,
      unseen: 3,
    });
    expect(tree.unreadable).toBe(1);
    expect(calls.release).toEqual(['INBOX']);
  });

  it('a whole range missing in the middle: size unknown, not a too-small sum', async () => {
    const { tree } = await run(
      [
        {
          path: 'INBOX',
          status: { messages: 12, unseen: 0 },
          exists: 12,
          skip: (seq) => seq >= 6 && seq <= 10,
        },
      ],
      {},
      { sizes: true, batchSize: 5 },
    );
    expect(byPath(tree, 'INBOX')).toMatchObject({ bytes: null, sizeSource: null, messages: 12 });
    expect(tree.unreadable).toBe(1);
  });

  it('a single missing answer is enough', async () => {
    const { tree } = await run(
      [{ path: 'INBOX', status: { messages: 3, unseen: 0 }, exists: 3, skip: (seq) => seq === 2 }],
      {},
      { sizes: true },
    );
    expect(byPath(tree, 'INBOX').bytes).toBeNull();
    expect(byPath(tree, 'INBOX').sizeSource).toBeNull();
    expect(tree.unreadable).toBe(1);
  });

  it('nothing returned at all (no error): size unknown', async () => {
    const { tree } = await run(
      [{ path: 'INBOX', status: { messages: 4, unseen: 0 }, exists: 4, skip: () => true }],
      {},
      { sizes: true },
    );
    expect(byPath(tree, 'INBOX')).toMatchObject({ bytes: null, sizeSource: null, messages: 4 });
    expect(tree.unreadable).toBe(1);
  });

  it('a response without a size does not count as sized', async () => {
    const { tree } = await run(
      [
        {
          path: 'INBOX',
          status: { messages: 3, unseen: 0 },
          exists: 3,
          noSize: (seq) => seq === 3,
        },
      ],
      {},
      { sizes: true },
    );
    expect(byPath(tree, 'INBOX')).toMatchObject({ bytes: null, sizeSource: null, messages: 3 });
    expect(tree.unreadable).toBe(1);
  });

  it('the other folders are still sized, the totals are those of an unreadable folder', async () => {
    const short = await run(
      [
        { path: 'INBOX', status: { messages: 2, unseen: 1 }, exists: 2, skip: (seq) => seq === 2 },
        { path: 'Other', status: { messages: 1, unseen: 0 }, exists: 1 },
      ],
      {},
      { sizes: true },
    );
    const thrown = await run(
      [
        { path: 'INBOX', status: { messages: 2, unseen: 1 }, exists: 2, fetchThrows: true },
        { path: 'Other', status: { messages: 1, unseen: 0 }, exists: 1 },
      ],
      {},
      { sizes: true },
    );
    expect(byPath(short.tree, 'Other')).toMatchObject({ bytes: 100, sizeSource: 'sum' });
    expect(short.tree.unreadable).toBe(1);
    expect(short.tree.totals).toEqual(thrown.tree.totals);
    expect(short.tree.totals?.bytes).toBeNull();
    expect(short.tree.totals?.messages).toBe(3);
  });

  it('the same folder with every size present is unchanged: the sum, sizeSource sum', async () => {
    const { tree } = await run(
      [{ path: 'INBOX', status: { messages: 12, unseen: 0 }, exists: 12, sizeOf: (s) => s }],
      {},
      { sizes: true, batchSize: 5 },
    );
    expect(byPath(tree, 'INBOX')).toMatchObject({ bytes: 78, sizeSource: 'sum' });
    expect(tree.unreadable).toBe(0);
  });

  it('EXISTS (EXAMINE), not STATUS, is what the sized responses are compared with', async () => {
    const { tree } = await run(
      [{ path: 'INBOX', status: { messages: 5, unseen: 0 }, exists: 3 }],
      {},
      { sizes: true },
    );
    expect(byPath(tree, 'INBOX')).toMatchObject({ bytes: 300, sizeSource: 'sum', messages: 5 });
    expect(tree.unreadable).toBe(0);
  });

  it('an empty folder is not marked', async () => {
    const { tree, calls } = await run(
      [{ path: 'INBOX', status: { messages: 0, unseen: 0 }, exists: 0 }],
      {},
      { sizes: true },
    );
    expect(byPath(tree, 'INBOX').bytes).toBe(0);
    expect(tree.unreadable).toBe(0);
    expect(calls.fetch).toHaveLength(0);
  });

  it('a thrown fetch error is as before: bytes null, unreadable 1, the lock released', async () => {
    const { tree, calls } = await run(
      [{ path: 'INBOX', status: { messages: 2, unseen: 0 }, fetchThrows: true }],
      {},
      { sizes: true },
    );
    expect(byPath(tree, 'INBOX')).toMatchObject({ bytes: null, sizeSource: null });
    expect(tree.unreadable).toBe(1);
    expect(calls.release).toEqual(['INBOX']);
  });

  it('a short read on a connection that is gone → connection-lost, lock released', async () => {
    const { session, calls, state } = fake([
      {
        path: 'INBOX',
        status: { messages: 3, unseen: 0 },
        exists: 3,
        skip: () => {
          state.closed = true;
          return true;
        },
      },
    ]);
    const err = await mailboxError(listFolders(session, { sizes: true }));
    expect(err.code).toBe('connection-lost');
    expect(calls.release).toHaveLength(calls.lock.length);
  });
});

// --- M2-fix round 1: each message counts once, only inside the range that was asked for -------

describe('listFolders: size fallback counts each message once', () => {
  const folder = (over: Partial<FakeFolder>): FakeFolder => ({
    path: 'INBOX',
    status: { messages: 12, unseen: 0 },
    exists: 12,
    ...over,
  });
  const sized = { sizes: true, batchSize: 5 };

  it('every answer repeated and one message missing: size unknown', async () => {
    const { tree } = await run(
      [folder({ repeat: () => true, skip: (seq) => seq === 7 })],
      {},
      sized,
    );
    expect(byPath(tree, 'INBOX')).toMatchObject({ bytes: null, sizeSource: null, messages: 12 });
    expect(tree.unreadable).toBe(1);
  });

  it('a whole range streamed twice and another range empty: size unknown', async () => {
    const { tree } = await run(
      [folder({ repeat: (seq) => seq <= 5, skip: (seq) => seq >= 6 && seq <= 10 })],
      {},
      sized,
    );
    expect(byPath(tree, 'INBOX')).toMatchObject({ bytes: null, sizeSource: null });
    expect(tree.unreadable).toBe(1);
  });

  it('every answer repeated, nothing missing: the sum of one copy, not doubled', async () => {
    const { tree } = await run([folder({ repeat: () => true, sizeOf: (seq) => seq })], {}, sized);
    expect(byPath(tree, 'INBOX')).toMatchObject({ bytes: 78, sizeSource: 'sum' });
    expect(tree.unreadable).toBe(0);
    expect(tree.totals?.bytes).toBe(78);
  });

  const stray: [string, number][] = [
    ['an earlier message', 2],
    ['a message past the range', 99],
    ['zero', 0],
    ['a negative number', -1],
    ['a fraction', 1.5],
    ['NaN', Number.NaN],
  ];

  it.each(stray)(
    'an answer for %s (outside the range asked for) adds no bytes',
    async (_name, seq) => {
      const { tree } = await run(
        [
          folder({
            sizeOf: (s) => s,
            extra: (range) => (range.from === 6 ? [{ seq, size: 5000 }] : []),
          }),
        ],
        {},
        sized,
      );
      expect(byPath(tree, 'INBOX')).toMatchObject({ bytes: 78, sizeSource: 'sum' });
      expect(tree.unreadable).toBe(0);
    },
  );

  it.each(stray)(
    'an answer for %s (outside the range asked for) does not make up for a missing message',
    async (_name, seq) => {
      const { tree } = await run(
        [
          folder({
            skip: (s) => s === 8,
            extra: (range) => (range.from === 6 ? [{ seq, size: 5000 }] : []),
          }),
        ],
        {},
        sized,
      );
      expect(byPath(tree, 'INBOX')).toMatchObject({ bytes: null, sizeSource: null });
      expect(tree.unreadable).toBe(1);
    },
  );

  it('a full, clean read is unchanged', async () => {
    const { tree } = await run([folder({ sizeOf: (seq) => seq })], {}, sized);
    expect(byPath(tree, 'INBOX')).toMatchObject({ bytes: 78, sizeSource: 'sum' });
    expect(tree.unreadable).toBe(0);
  });
});
