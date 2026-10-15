import { describe, it, expect } from 'vitest';
import type { CompiledFilter } from '../../src/core/filters/compile.js';
import { compileFilter } from '../../src/core/filters/compile.js';
import { EMPTY_FILTER } from '../../src/core/filters/schema.js';
import type { FilterNode } from '../../src/core/filters/schema.js';
import type { ServerFeatures } from '../../src/core/imap/features.js';
import type { ImapClientLike } from '../../src/core/imap/session.js';
import { MailboxError } from '../../src/core/mailbox/errors.js';
import type {
  FolderInfo,
  FolderRole,
  FolderSession,
  FolderTree,
  RoleSource,
  SizeProgress,
} from '../../src/core/mailbox/folders.js';
import type { Match } from '../../src/core/mailbox/search.js';
import { compareMatches, sortMatches } from '../../src/core/mailbox/search.js';
import type { SearchMailboxOptions } from '../../src/core/mailbox/search-mailbox.js';
import { searchMailbox } from '../../src/core/mailbox/search-mailbox.js';

// M3b mailbox search (spec): searchMailbox over a fake IMAP client with several folders, and the
// order of matches (compareMatches / sortMatches). The fake answers SEARCH with the UIDs chosen by
// the test, FETCH by UID (the set string is parsed back) and LOCK per folder. The expected values
// come from the plan, not from code. Dates are UTC.

const NOW = new Date('2026-10-12T12:00:00Z');
const dayStart = (y: number, m: number, d: number): Date => new Date(Date.UTC(y, m - 1, d));
const CANARY = 'CANARY-server-text imap.secret-host.example canary@secret-domain.example';
const ATTACHED = {
  type: 'multipart/mixed',
  childNodes: [{ type: 'text/plain' }, { type: 'application/pdf', disposition: 'attachment' }],
};
const NEWEST: SearchMailboxOptions = { order: 'newest', limit: 20 };

// --- fake client --------------------------------------------------------------------------

interface FakeMsg {
  seq: number;
  uid: number;
  size?: number | undefined;
  envelope?: { subject?: string; from?: { name?: string; address?: string }[] } | undefined;
  internalDate?: Date | undefined;
  bodyStructure?: unknown;
}

interface FakeFolder {
  /** What the server holds, by UID. Read live, so a hook may change it. */
  messages: FakeMsg[];
  /** What SEARCH answers; default: every UID the folder holds. */
  found?: number[] | undefined;
  /** Default 7n. */
  uidValidity?: unknown;
  lockFails?: boolean | undefined;
  searchFails?: boolean | undefined;
  /** The connection drops during this folder's search. */
  searchCloses?: boolean | undefined;
  /** The FETCH throws after this many messages of this folder were yielded. */
  fetchFailsAfter?: number | undefined;
  /** Runs once, after the FETCH of this folder has yielded everything it asks for. */
  afterFetch?: (() => void) | undefined;
}

interface Calls {
  lock: { path: string; options: unknown }[];
  search: { path: string; query: unknown; options: unknown }[];
  fetch: { path: string; set: string; query: unknown; options: unknown }[];
  /** Any other client method that was called (must stay empty: read-only). */
  forbidden: string[];
}

/** A message the server has for `uid`: 100 bytes per UID, dated one minute per UID. */
function msg(uid: number, over: Partial<FakeMsg> = {}): FakeMsg {
  return {
    seq: uid,
    uid,
    size: 100 * uid,
    envelope: {
      subject: `Subject ${uid}`,
      from: [{ name: `Sender ${uid}`, address: `s${uid}@shop.example` }],
    },
    internalDate: new Date(Date.UTC(2026, 0, 1) + uid * 60_000),
    bodyStructure: { type: 'text/plain' },
    ...over,
  };
}

/** A message on day `d` of January 2026 from Anna, subject `Day d`. */
function dated(uid: number, d: number, size?: number): FakeMsg {
  return msg(uid, {
    internalDate: day(d),
    size: size ?? 100 * uid,
    envelope: { subject: `Day ${d}`, from: [{ name: 'Anna', address: 'anna@x.test' }] },
  });
}

function day(n: number): Date {
  return new Date(Date.UTC(2026, 0, n));
}

/** The UIDs of a UID set string such as `1:3,7,9:10`. */
function expandSet(set: string): number[] {
  const uids: number[] = [];
  for (const part of set.split(',')) {
    const [a, b] = part.split(':');
    const from = Number(a);
    const to = b === undefined ? from : Number(b);
    for (let uid = from; uid <= to; uid++) uids.push(uid);
  }
  return uids;
}

function consecutive(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

function top(messages: FakeMsg[]): number {
  return messages.reduce((max, m) => Math.max(max, m.uid), 0);
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

function fake(
  folders: Record<string, FakeFolder>,
  feat: Partial<ServerFeatures> = {},
): { session: FolderSession; calls: Calls } {
  const state = { closed: false };
  const calls: Calls = { lock: [], search: [], fetch: [], forbidden: [] };
  const byPath = new Map(Object.entries(folders));
  let selected = '';
  let mailbox: { exists: number; uidValidity: unknown } | false = false;

  const base = {
    get usable(): boolean {
      return true;
    },
    get mailbox(): typeof mailbox {
      return mailbox;
    },
    getMailboxLock(
      path: string,
      options?: unknown,
    ): Promise<{ path: string; release: () => void }> {
      calls.lock.push({ path, options });
      const folder = byPath.get(path);
      if (folder === undefined || folder.lockFails === true) {
        return Promise.reject(new Error(CANARY));
      }
      selected = path;
      mailbox = { exists: top(folder.messages), uidValidity: folder.uidValidity ?? 7n };
      return Promise.resolve({ path, release: () => undefined });
    },
    noop(): Promise<void> {
      return Promise.resolve();
    },
    search(query: unknown, options?: unknown): Promise<unknown> {
      const folder = byPath.get(selected);
      calls.search.push({ path: selected, query, options });
      if (folder === undefined) return Promise.reject(new Error(CANARY));
      if (folder.searchCloses === true) {
        state.closed = true;
        return Promise.reject(new Error(CANARY));
      }
      if (folder.searchFails === true) return Promise.reject(new Error(CANARY));
      return Promise.resolve(folder.found ?? folder.messages.map((m) => m.uid));
    },
    fetch(set: string, query: unknown, options?: unknown): AsyncIterable<FakeMsg> {
      const path = selected;
      const folder = byPath.get(path);
      calls.fetch.push({ path, set, query, options });
      return {
        async *[Symbol.asyncIterator]() {
          await Promise.resolve();
          if (folder === undefined) throw new Error(CANARY);
          let yielded = 0;
          for (const uid of expandSet(set)) {
            if (folder.fetchFailsAfter !== undefined && yielded >= folder.fetchFailsAfter) {
              throw new Error(CANARY);
            }
            const m = folder.messages.find((x) => x.uid === uid);
            if (m === undefined) continue;
            yielded++;
            yield m;
          }
          const hook = folder.afterFetch;
          folder.afterFetch = undefined;
          hook?.();
        },
      };
    },
  };

  const client = new Proxy(base, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && prop !== 'then' && !(prop in target)) {
        return (): Promise<void> => {
          calls.forbidden.push(prop);
          return Promise.resolve();
        };
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });

  const session = {
    client: client as unknown as ImapClientLike,
    features: features(feat),
    get closed() {
      return state.closed;
    },
  } as FolderSession;
  return { session, calls };
}

async function mailboxError(p: Promise<unknown>): Promise<MailboxError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(MailboxError);
    const e = err as MailboxError;
    expect(e.message).not.toContain('CANARY');
    return e;
  }
  throw new Error('expected a rejection');
}

function compiled(where: FilterNode): CompiledFilter {
  return compileFilter({ version: 1, where }, { now: NOW, dayStart });
}

const EMPTY = (): CompiledFilter => compiled(EMPTY_FILTER.where);

/** A checked leaf needs nothing from the server but the envelope; `larger` needs only the basics. */
const LARGER_1 = (): CompiledFilter => compiled({ kind: 'larger', bytes: 1 });

// --- fake folder trees ----------------------------------------------------------------------

function fi(path: string, over: Partial<FolderInfo> = {}): FolderInfo {
  const delimiter = over.delimiter === undefined ? '/' : over.delimiter;
  const parts = delimiter === null ? [path] : path.split(delimiter);
  return {
    path,
    name: parts.at(-1) ?? path,
    parentPath: null,
    depth: 0,
    delimiter,
    role: null,
    roleSource: null,
    selectable: true,
    subscribed: true,
    messages: null,
    unseen: null,
    bytes: null,
    sizeSource: null,
    overlapping: false,
    ...over,
  };
}

function special(path: string, role: FolderRole, roleSource: RoleSource = 'extension'): FolderInfo {
  return fi(path, { role, roleSource });
}

function treeOf(folders: FolderInfo[], over: Partial<FolderTree> = {}): FolderTree {
  return {
    folders,
    totals: null,
    quota: null,
    truncated: false,
    unreadable: 0,
    gmailAllHidden: false,
    fallbacks: new Set(),
    ...over,
  };
}

/** INBOX, Archive and Trash, in that scope order. */
const PLAIN_TREE = (): FolderTree =>
  treeOf([
    special('INBOX', 'inbox', 'path'),
    special('Archive', 'archive'),
    special('Trash', 'trash'),
  ]);

/** INBOX and Trash, with dated mail for the sample tests (see `datedFolders`). */
const TWO_TREE = (): FolderTree =>
  treeOf([special('INBOX', 'inbox', 'path'), special('Trash', 'trash')]);

/**
 * INBOX holds UID 1 (day 1) and UID 2 (day 5); Trash holds UID 1 (day 3). `trashSize` sets the
 * size of Trash's mail (default 100 bytes).
 */
function datedFolders(trashSize?: number): Record<string, FakeFolder> {
  return {
    INBOX: { messages: [dated(1, 1), dated(2, 5)] },
    Trash: { messages: [dated(1, 3, trashSize)] },
  };
}

// --- searchMailbox: scope, folders, failures ------------------------------------------------

describe('searchMailbox: scope and folders (spec)', () => {
  it('searches the stats scope in order', async () => {
    const { session, calls } = fake({
      INBOX: { messages: [msg(1), msg(2), msg(3)] },
      Archive: { messages: [] },
      Trash: { messages: [msg(1)] },
    });
    const result = await searchMailbox(session, PLAIN_TREE(), EMPTY(), { ...NEWEST, limit: 0 });

    expect(result.folders.map((f) => f.path)).toEqual(['INBOX', 'Archive', 'Trash']);
    expect(calls.lock.map((l) => l.path)).toEqual(['INBOX', 'Archive', 'Trash']);
    expect(result.folders.map((f) => f.reason)).toEqual([null, null, null]);
    expect(result.folders.map((f) => f.matches.length)).toEqual([3, 0, 1]);
    expect(result.folders[0]?.snapshot?.path).toBe('INBOX');
    expect(result.totals).toEqual({ messages: 4, bytes: 100 + 200 + 300 + 100 });
    expect(result.failed).toBe(0);
    expect(result.missing).toBe(0);
    expect(result.notSearched).toBe(0);
  });

  it('Gmail scope', async () => {
    const { session, calls } = fake(
      {
        '[Gmail]/All Mail': { messages: [msg(1)] },
        Work: { messages: [msg(2)] },
        '[Gmail]/Trash': { messages: [] },
        '[Gmail]/Spam': { messages: [] },
      },
      { gmail: true },
    );
    const tree = treeOf([
      special('[Gmail]/All Mail', 'all'),
      fi('Work', { overlapping: true }),
      special('[Gmail]/Trash', 'trash'),
      special('[Gmail]/Spam', 'junk'),
    ]);
    const result = await searchMailbox(session, tree, EMPTY(), { ...NEWEST, limit: 0 });

    expect(calls.lock.map((l) => l.path)).toEqual([
      '[Gmail]/All Mail',
      '[Gmail]/Trash',
      '[Gmail]/Spam',
    ]);
    expect(result.folders.map((f) => f.path)).toEqual([
      '[Gmail]/All Mail',
      '[Gmail]/Trash',
      '[Gmail]/Spam',
    ]);
    expect(result.notSearched).toBe(1);
  });

  it('folder option: only that folder is searched', async () => {
    const { session, calls } = fake({
      INBOX: { messages: [msg(1)] },
      Archive: { messages: [msg(1), msg(2)] },
      Trash: { messages: [msg(1)] },
    });
    const result = await searchMailbox(session, PLAIN_TREE(), EMPTY(), {
      ...NEWEST,
      folder: 'Archive',
      limit: 0,
    });
    expect(result.folders.map((f) => f.path)).toEqual(['Archive']);
    expect(calls.lock.map((l) => l.path)).toEqual(['Archive']);
    expect(result.totals).toEqual({ messages: 2, bytes: 300 });
    expect(result.notSearched).toBe(0);
  });

  it('folder option matches INBOX in any case (addition)', async () => {
    const { session, calls } = fake({ INBOX: { messages: [msg(1)] } });
    const result = await searchMailbox(session, PLAIN_TREE(), EMPTY(), {
      ...NEWEST,
      folder: 'inbox',
      limit: 0,
    });
    expect(result.folders.map((f) => f.path)).toEqual(['INBOX']);
    expect(calls.lock.map((l) => l.path)).toEqual(['INBOX']);
  });

  it('folder option: an unknown path is folder-not-found, nothing is locked', async () => {
    const { session, calls } = fake({ INBOX: { messages: [msg(1)] } });
    const err = await mailboxError(
      searchMailbox(session, PLAIN_TREE(), EMPTY(), { ...NEWEST, folder: 'Missing' }),
    );
    expect(err.code).toBe('folder-not-found');
    expect(calls.lock).toEqual([]);
  });

  it('Gmail with All Mail hidden and no folder option is gmail-all-hidden', async () => {
    const { session, calls } = fake({ '[Gmail]/Trash': { messages: [msg(1)] } }, { gmail: true });
    const tree = treeOf([special('[Gmail]/Trash', 'trash')], { gmailAllHidden: true });
    const err = await mailboxError(searchMailbox(session, tree, EMPTY(), NEWEST));
    expect(err.code).toBe('gmail-all-hidden');
    expect(calls.lock).toEqual([]);
  });

  it('an empty tree gives an empty search, no lock (addition)', async () => {
    const { session, calls } = fake({});
    const result = await searchMailbox(session, treeOf([]), EMPTY(), NEWEST);
    expect(result.folders).toEqual([]);
    expect(result.totals).toEqual({ messages: 0, bytes: 0 });
    expect(result.failed).toBe(0);
    expect(result.senders).toEqual([]);
    expect(result.samples).toEqual([]);
    expect(result.samplesGone).toBe(0);
    expect(calls.lock).toEqual([]);
  });

  it('one folder refused: its row is a failed row, the next folders are still searched', async () => {
    const { session } = fake({
      INBOX: { messages: [msg(1)] },
      Archive: { messages: [msg(1), msg(2)], searchFails: true },
      Trash: { messages: [msg(1)] },
    });
    const result = await searchMailbox(session, PLAIN_TREE(), EMPTY(), NEWEST);

    expect(result.folders[1]).toEqual({
      path: 'Archive',
      snapshot: null,
      reason: 'search-failed',
      matches: [],
      bytes: 0,
      missing: 0,
    });
    expect(result.folders[2]?.reason).toBeNull();
    expect(result.folders[2]?.matches.map((m) => m.uid)).toEqual([1]);
    expect(result.failed).toBe(1);
    expect(result.totals).toEqual({ messages: 2, bytes: 200 });
  });

  it('lock refused on one folder → folder-unavailable', async () => {
    const { session } = fake({
      INBOX: { messages: [msg(1)] },
      Archive: { messages: [msg(1)], lockFails: true },
      Trash: { messages: [msg(1)] },
    });
    const result = await searchMailbox(session, PLAIN_TREE(), EMPTY(), NEWEST);
    expect(result.folders[1]).toEqual({
      path: 'Archive',
      snapshot: null,
      reason: 'folder-unavailable',
      matches: [],
      bytes: 0,
      missing: 0,
    });
    expect(result.failed).toBe(1);
  });

  it('every folder fails → MailboxError search-failed', async () => {
    const { session } = fake({
      INBOX: { messages: [msg(1)], searchFails: true },
      Trash: { messages: [msg(1)], searchFails: true },
    });
    const err = await mailboxError(searchMailbox(session, TWO_TREE(), EMPTY(), NEWEST));
    expect(err).toBeInstanceOf(MailboxError);
    expect(err.code).toBe('search-failed');
  });

  it('every folder fails with mixed codes: the first folder code wins (addition)', async () => {
    const { session } = fake({
      INBOX: { messages: [msg(1)], lockFails: true },
      Trash: { messages: [msg(1)], searchFails: true },
    });
    const err = await mailboxError(searchMailbox(session, TWO_TREE(), EMPTY(), NEWEST));
    expect(err.code).toBe('folder-unavailable');
  });

  it('too many candidates → too-many-matches, the next folder is never locked', async () => {
    const { session, calls } = fake({
      INBOX: { messages: [], found: consecutive(1, 500_001) },
      Trash: { messages: [msg(1)] },
    });
    const err = await mailboxError(searchMailbox(session, TWO_TREE(), EMPTY(), NEWEST));
    expect(err.code).toBe('too-many-matches');
    expect(calls.lock.map((l) => l.path)).toEqual(['INBOX']);
  });

  it('connection lost during the search → connection-lost, the next folder is never locked', async () => {
    const { session, calls } = fake({
      INBOX: { messages: [msg(1)], searchCloses: true },
      Trash: { messages: [msg(1)] },
    });
    const err = await mailboxError(searchMailbox(session, TWO_TREE(), EMPTY(), NEWEST));
    expect(err.code).toBe('connection-lost');
    expect(calls.lock.map((l) => l.path)).toEqual(['INBOX']);
  });

  it('missing candidates are counted per folder and in total (addition)', async () => {
    const { session } = fake({
      INBOX: { messages: [msg(1)], found: [1, 2] },
      Trash: { messages: [msg(1)] },
    });
    const result = await searchMailbox(session, TWO_TREE(), EMPTY(), NEWEST);
    expect(result.folders[0]?.missing).toBe(1);
    expect(result.folders[0]?.matches.map((m) => m.uid)).toEqual([1]);
    expect(result.missing).toBe(1);
    expect(result.totals).toEqual({ messages: 2, bytes: 200 });
  });

  it('envelope always fetched: every fetch asks for it, and never for the flags, source or body parts', async () => {
    const { session, calls } = fake({
      INBOX: { messages: [msg(1), msg(2)] },
      Trash: { messages: [msg(1)] },
    });
    await searchMailbox(session, TWO_TREE(), LARGER_1(), NEWEST);

    expect(calls.fetch.length).toBeGreaterThan(0);
    for (const call of calls.fetch) {
      expect(call.query).toHaveProperty('envelope', true);
      expect(call.query).not.toHaveProperty('source');
      expect(call.query).not.toHaveProperty('flags');
      expect(call.query).not.toHaveProperty('bodyParts');
    }
  });

  it('progress: each folder reports through the scope order', async () => {
    const { session } = fake({
      INBOX: { messages: [msg(1), msg(2)] },
      Archive: { messages: [msg(1)] },
      Trash: { messages: [msg(1), msg(2), msg(3)] },
    });
    const seen: SizeProgress[] = [];
    await searchMailbox(session, PLAIN_TREE(), EMPTY(), {
      ...NEWEST,
      limit: 0,
      onProgress: (p) => {
        seen.push(p);
      },
    });

    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toMatchObject({ folder: 1, folders: 3 });
    expect(seen.at(-1)).toMatchObject({ folder: 3, folders: 3 });
    expect(seen.every((p) => p.folders === 3)).toBe(true);
    expect(seen.every((p) => p.total > 0)).toBe(true);
    const last = seen.at(-1);
    expect(last?.done).toBe(last?.total);
  });

  it('progress: a folder with no candidates gets no progress call (addition)', async () => {
    const { session } = fake({
      INBOX: { messages: [msg(1), msg(2)] },
      Archive: { messages: [] },
      Trash: { messages: [msg(1)] },
    });
    const seen: SizeProgress[] = [];
    await searchMailbox(session, PLAIN_TREE(), EMPTY(), {
      ...NEWEST,
      limit: 0,
      onProgress: (p) => {
        seen.push(p);
      },
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((p) => p.total > 0)).toBe(true);
  });

  it('read-only: every lock is readOnly and no other client method is called', async () => {
    const { session, calls } = fake({
      INBOX: { messages: [msg(1), msg(2)] },
      Trash: { messages: [msg(1)] },
    });
    await searchMailbox(session, TWO_TREE(), EMPTY(), NEWEST);

    expect(calls.lock.length).toBeGreaterThan(0);
    for (const lock of calls.lock) {
      expect(lock.options).toEqual({ readOnly: true });
    }
    expect(calls.forbidden).toEqual([]);
  });
});

// --- top senders ----------------------------------------------------------------------------

describe('searchMailbox: top senders (spec)', () => {
  it('top senders: by messages, then bytes, then key; no address last among equals', async () => {
    const from = (address: string): FakeMsg['envelope'] => ({ subject: 'x', from: [{ address }] });
    const { session } = fake({
      INBOX: {
        messages: [
          msg(1, { size: 100, envelope: from('a@x.test') }),
          msg(2, { size: 200, envelope: from('a@x.test') }),
          msg(3, { size: 500, envelope: from('b@y.test') }),
          msg(4, { size: 50, envelope: { subject: 'No sender' } }),
        ],
      },
    });
    const result = await searchMailbox(
      session,
      treeOf([special('INBOX', 'inbox', 'path')]),
      EMPTY(),
      NEWEST,
    );

    expect(result.senders).toEqual([
      { key: 'a@x.test', messages: 2, bytes: 300 },
      { key: 'b@y.test', messages: 1, bytes: 500 },
      { key: null, messages: 1, bytes: 50 },
    ]);
  });

  it('top senders cap 10: twelve senders give ten rows, the largest first', async () => {
    const uids = consecutive(1, 12);
    const { session } = fake({
      INBOX: {
        messages: uids.map((uid) =>
          msg(uid, { envelope: { subject: 'x', from: [{ address: `s${uid}@x.test` }] } }),
        ),
      },
    });
    const result = await searchMailbox(
      session,
      treeOf([special('INBOX', 'inbox', 'path')]),
      EMPTY(),
      NEWEST,
    );

    expect(result.senders).toHaveLength(10);
    const expected = [12, 11, 10, 9, 8, 7, 6, 5, 4, 3].map((uid) => ({
      key: `s${uid}@x.test`,
      messages: 1,
      bytes: 100 * uid,
    }));
    expect(result.senders).toEqual(expected);
  });

  it("a failed folder's senders are not counted", async () => {
    const from = (address: string): FakeMsg['envelope'] => ({ subject: 'x', from: [{ address }] });
    const { session } = fake({
      INBOX: { messages: [msg(1, { envelope: from('a@x.test') })] },
      Archive: {
        messages: [
          msg(1, { envelope: from('archive@x.test') }),
          msg(2, { envelope: from('archive@x.test') }),
        ],
        fetchFailsAfter: 1,
      },
      Trash: { messages: [] },
    });
    const result = await searchMailbox(session, PLAIN_TREE(), EMPTY(), NEWEST);

    expect(result.folders[1]?.reason).not.toBeNull();
    expect(result.folders[1]?.matches).toEqual([]);
    expect(result.senders).toEqual([{ key: 'a@x.test', messages: 1, bytes: 100 }]);
  });
});

// --- samples --------------------------------------------------------------------------------

describe('searchMailbox: samples (spec)', () => {
  it('samples newest across folders', async () => {
    const { session } = fake(datedFolders());
    const result = await searchMailbox(session, TWO_TREE(), EMPTY(), { ...NEWEST, limit: 2 });

    expect(result.samples).toEqual([
      {
        folder: 'INBOX',
        uid: 2,
        received: day(5),
        from: 'Anna',
        subject: 'Day 5',
        bytes: 200,
        attachment: false,
      },
      {
        folder: 'Trash',
        uid: 1,
        received: day(3),
        from: 'Anna',
        subject: 'Day 3',
        bytes: 100,
        attachment: false,
      },
    ]);
    expect(result.samplesGone).toBe(0);
  });

  it('samples oldest / largest', async () => {
    const oldest = await searchMailbox(fake(datedFolders()).session, TWO_TREE(), EMPTY(), {
      order: 'oldest',
      limit: 2,
    });
    expect(oldest.samples.map((s) => [s.folder, s.uid])).toEqual([
      ['INBOX', 1],
      ['Trash', 1],
    ]);

    // Trash's mail is 300 bytes here, so the largest two are Trash 1 and INBOX 2.
    const largest = await searchMailbox(fake(datedFolders(300)).session, TWO_TREE(), EMPTY(), {
      order: 'largest',
      limit: 2,
    });
    expect(largest.samples.map((s) => [s.folder, s.uid, s.bytes])).toEqual([
      ['Trash', 1, 300],
      ['INBOX', 2, 200],
    ]);
  });

  it('samples tie by folder order: equal dates and UIDs keep the scope order', async () => {
    const twins = (): Record<string, FakeFolder> => ({
      INBOX: { messages: [dated(5, 2)] },
      Trash: { messages: [dated(5, 2)] },
    });
    const inboxFirst = await searchMailbox(fake(twins()).session, TWO_TREE(), EMPTY(), {
      ...NEWEST,
      limit: 2,
    });
    expect(inboxFirst.samples.map((s) => s.folder)).toEqual(['INBOX', 'Trash']);

    const trashFirst = await searchMailbox(
      fake(twins()).session,
      treeOf([special('Trash', 'trash'), special('INBOX', 'inbox', 'path')]),
      EMPTY(),
      { ...NEWEST, limit: 2 },
    );
    expect(trashFirst.samples.map((s) => s.folder)).toEqual(['Trash', 'INBOX']);
  });

  it('samples with no date are last in both date orders (addition)', async () => {
    const folders = (): Record<string, FakeFolder> => ({
      INBOX: {
        messages: [msg(1, { internalDate: undefined }), dated(2, 1), dated(3, 2)],
      },
    });
    const tree = treeOf([special('INBOX', 'inbox', 'path')]);

    const newest = await searchMailbox(fake(folders()).session, tree, EMPTY(), {
      ...NEWEST,
      limit: 3,
    });
    expect(newest.samples.map((s) => s.uid)).toEqual([3, 2, 1]);
    expect(newest.samples[2]?.received).toBeNull();

    const oldest = await searchMailbox(fake(folders()).session, tree, EMPTY(), {
      order: 'oldest',
      limit: 3,
    });
    expect(oldest.samples.map((s) => s.uid)).toEqual([2, 3, 1]);
    expect(oldest.samples[2]?.received).toBeNull();
  });

  it('a sample shows attachment by the structure rule (addition)', async () => {
    const { session } = fake({
      INBOX: { messages: [msg(1, { bodyStructure: ATTACHED }), msg(2)] },
    });
    const result = await searchMailbox(
      session,
      treeOf([special('INBOX', 'inbox', 'path')]),
      EMPTY(),
      NEWEST,
    );
    expect(result.samples.find((s) => s.uid === 1)?.attachment).toBe(true);
    expect(result.samples.find((s) => s.uid === 2)?.attachment).toBe(false);
  });

  it('limit 0 gives no samples and no sample read', async () => {
    const { session, calls } = fake({
      INBOX: { messages: [msg(1), msg(2)] },
    });
    const result = await searchMailbox(
      session,
      treeOf([special('INBOX', 'inbox', 'path')]),
      EMPTY(),
      {
        ...NEWEST,
        limit: 0,
      },
    );
    expect(result.samples).toEqual([]);
    // The search pass asks for no body structure; only the sample read does.
    expect(calls.fetch.length).toBeGreaterThan(0);
    expect(calls.fetch.filter((f) => 'bodyStructure' in (f.query as object))).toEqual([]);
  });

  it('a negative limit is 0 (addition)', async () => {
    const { session } = fake({ INBOX: { messages: [msg(1), msg(2)] } });
    const result = await searchMailbox(
      session,
      treeOf([special('INBOX', 'inbox', 'path')]),
      EMPTY(),
      {
        ...NEWEST,
        limit: -5,
      },
    );
    expect(result.samples).toEqual([]);
  });

  it('limit clamping: 500 gives at most 200 rows, NaN gives 20', async () => {
    const tree = treeOf([special('INBOX', 'inbox', 'path')]);

    const many = await searchMailbox(
      fake({ INBOX: { messages: consecutive(1, 250).map((uid) => msg(uid)) } }).session,
      tree,
      EMPTY(),
      { ...NEWEST, limit: 500 },
    );
    expect(many.samples).toHaveLength(200);
    expect(many.samples[0]?.uid).toBe(250);

    const fallback = await searchMailbox(
      fake({ INBOX: { messages: consecutive(1, 30).map((uid) => msg(uid)) } }).session,
      tree,
      EMPTY(),
      { ...NEWEST, limit: Number.NaN },
    );
    expect(fallback.samples).toHaveLength(20);
  });

  it('samples gone: a folder whose UIDVALIDITY changed is counted, the others are kept', async () => {
    const trash: FakeFolder = {
      messages: [msg(1)],
      afterFetch: () => {
        trash.uidValidity = 8n;
      },
    };
    const { session } = fake({
      INBOX: { messages: [msg(1), msg(2)] },
      Trash: trash,
    });
    const result = await searchMailbox(session, TWO_TREE(), EMPTY(), NEWEST);

    expect(result.samples.map((s) => [s.folder, s.uid])).toEqual([
      ['INBOX', 2],
      ['INBOX', 1],
    ]);
    expect(result.samplesGone).toBe(1);
  });

  it('samples gone: a sample the server no longer has is counted (addition)', async () => {
    const inbox: FakeFolder = {
      messages: [msg(1), msg(2)],
      afterFetch: () => {
        inbox.messages = inbox.messages.filter((m) => m.uid !== 2);
      },
    };
    const { session } = fake({ INBOX: inbox });
    const result = await searchMailbox(
      session,
      treeOf([special('INBOX', 'inbox', 'path')]),
      EMPTY(),
      NEWEST,
    );

    expect(result.samples.map((s) => s.uid)).toEqual([1]);
    expect(result.samplesGone).toBe(1);
  });
});

// --- order of matches -----------------------------------------------------------------------

describe('compareMatches and sortMatches (spec, addition)', () => {
  const T1 = Date.UTC(2026, 0, 1);
  const T2 = Date.UTC(2026, 0, 2);
  const a: Match = { uid: 1, bytes: 100, received: T2 };
  const b: Match = { uid: 2, bytes: 100, received: T2 };
  const c: Match = { uid: 3, bytes: 50, received: null };
  const d: Match = { uid: 4, bytes: null, received: T1 };
  const uids = (list: Match[]): number[] => list.map((m) => m.uid);

  it('newest: received desc, null last, then uid desc', () => {
    expect(uids(sortMatches([a, b, c, d], 'newest'))).toEqual([2, 1, 4, 3]);
    expect(compareMatches(b, a, 'newest')).toBeLessThan(0);
  });

  it('oldest: received asc, null last, then uid asc', () => {
    expect(uids(sortMatches([a, b, c, d], 'oldest'))).toEqual([4, 1, 2, 3]);
  });

  it('largest: bytes desc, null last, then uid desc', () => {
    expect(uids(sortMatches([a, b, c, d], 'largest'))).toEqual([2, 1, 3, 4]);
  });

  it('sortMatches returns a new array and leaves its input alone', () => {
    const input = [c, a, d, b];
    const out = sortMatches(input, 'newest');
    expect(out).not.toBe(input);
    expect(uids(input)).toEqual([3, 1, 4, 2]);
  });
});
