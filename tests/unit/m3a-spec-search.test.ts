import { describe, it, expect } from 'vitest';
import type { CompiledFilter } from '../../src/core/filters/compile.js';
import { compileFilter } from '../../src/core/filters/compile.js';
import type { FilterNode } from '../../src/core/filters/schema.js';
import type { ImapClientLike } from '../../src/core/imap/session.js';
import { MailboxError } from '../../src/core/mailbox/errors.js';
import { PAGE_SIZE } from '../../src/core/mailbox/messages.js';
import type {
  FolderSnapshot,
  MessageRow,
  MessageSession,
  PageResult,
} from '../../src/core/mailbox/messages.js';
import {
  SEARCH_BATCH_UIDS,
  SEARCH_MAX_MATCHES,
  SEARCH_SET_CHARS,
  SearchStopped,
  loadMatches,
  searchFolder,
  uidSets,
} from '../../src/core/mailbox/search.js';

// M3a search core (spec): uidSets, searchFolder and loadMatches over a fake IMAP client. The fake
// answers SEARCH with a list chosen by the test, FETCH by UID (the set string is parsed back), and
// records every other client method as forbidden: the pass must stay read-only.

const CANARY = 'CANARY-server-text imap.secret-host.example canary@secret-domain.example';
const NOW = new Date('2026-10-12T12:00:00Z');
const SNAP: FolderSnapshot = { path: 'INBOX', uidValidity: '7', exists: 10 };
const DAY2 = Date.UTC(2026, 0, 2);
const ATTACHED = {
  type: 'multipart/mixed',
  childNodes: [{ type: 'text/plain' }, { type: 'application/pdf', disposition: 'attachment' }],
};

// --- fake client --------------------------------------------------------------------------

interface FakeMsg {
  seq: number;
  uid: number;
  size?: number | undefined;
  envelope?: { subject?: string; from?: { name?: string; address?: string }[] } | undefined;
  internalDate?: Date | undefined;
  bodyStructure?: unknown;
}

type FailAt = 'lock' | 'noop' | 'search' | 'fetch';

interface FakeOpts {
  /** EXISTS after EXAMINE. */
  exists: number;
  /** Default 7n. */
  uidValidity?: unknown;
  /** The message the server has for `uid`; null = the server no longer has it. */
  message?: (uid: number) => FakeMsg | null;
  /** Yielded by every fetch on top of the asked messages: the server adds these. */
  extra?: FakeMsg[];
  /** What SEARCH resolves with when present; default []. */
  found?: unknown;
  /** The client has no search method at all. */
  noSearch?: boolean;
  fail?: { at: FailAt; how: 'plain' | 'closed' };
  /** The session is already closed before the call. */
  closed?: boolean;
}

interface Calls {
  order: string[];
  lock: { path: string; options: unknown }[];
  release: number;
  noop: number;
  search: { query: unknown; options: unknown; onClient: boolean }[];
  fetch: { set: string; query: unknown; options: unknown }[];
  /** Any other client method that was called (must stay empty: read-only). */
  forbidden: string[];
}

/** A message the server has for `uid`: 100 bytes per UID, sent from `s<uid>@shop.example`. */
function message(uid: number, over: Partial<FakeMsg> = {}): FakeMsg {
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

function sender(address: string): FakeMsg['envelope'] {
  return { from: [{ address }] };
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

function fake(opts: FakeOpts): { session: MessageSession; calls: Calls } {
  let closed = opts.closed ?? false;
  const calls: Calls = {
    order: [],
    lock: [],
    release: 0,
    noop: 0,
    search: [],
    fetch: [],
    forbidden: [],
  };
  let mailbox: Record<string, unknown> | false = false;
  const lookup =
    opts.message ?? ((uid: number) => (uid >= 1 && uid <= opts.exists ? message(uid) : null));

  function failNow(at: FailAt): boolean {
    const fail = opts.fail;
    if (fail === undefined || fail.at !== at) return false;
    if (fail.how === 'closed') closed = true;
    return true;
  }

  const base = {
    get usable(): boolean {
      return true;
    },
    get mailbox(): Record<string, unknown> | false {
      return mailbox;
    },
    getMailboxLock(
      path: string,
      options?: unknown,
    ): Promise<{ path: string; release: () => void }> {
      calls.order.push('lock');
      calls.lock.push({ path, options });
      if (failNow('lock')) return Promise.reject(new Error(CANARY));
      mailbox = { exists: opts.exists, uidValidity: opts.uidValidity ?? 7n };
      return Promise.resolve({
        path,
        release: () => {
          calls.order.push('release');
          calls.release++;
        },
      });
    },
    noop(): Promise<void> {
      calls.order.push('noop');
      calls.noop++;
      if (failNow('noop')) return Promise.reject(new Error(CANARY));
      return Promise.resolve();
    },
    search(query: unknown, options?: unknown): Promise<unknown> {
      calls.order.push('search');
      calls.search.push({ query, options, onClient: this === client });
      if (failNow('search')) return Promise.reject(new Error(CANARY));
      return Promise.resolve('found' in opts ? opts.found : []);
    },
    fetch(set: string, query: unknown, options?: unknown): AsyncIterable<FakeMsg> {
      calls.order.push('fetch');
      calls.fetch.push({ set, query, options });
      return {
        async *[Symbol.asyncIterator]() {
          await Promise.resolve();
          if (failNow('fetch')) throw new Error(CANARY);
          for (const uid of expandSet(set)) {
            const m = lookup(uid);
            if (m !== null) yield m;
          }
          for (const m of opts.extra ?? []) yield m;
        },
      };
    },
  };

  const client = new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === 'search' && opts.noSearch === true) return undefined;
      if (typeof prop === 'string' && prop !== 'then' && !(prop in target)) {
        return (): Promise<void> => {
          calls.forbidden.push(prop);
          return Promise.resolve();
        };
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });

  const session: MessageSession = {
    client: client as unknown as ImapClientLike,
    get closed() {
      return closed;
    },
  };
  return { session, calls };
}

async function mailboxError(p: Promise<unknown>): Promise<MailboxError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(MailboxError);
    const e = err as MailboxError;
    expect(e.name).toBe('MailboxError');
    expect(e.message).not.toContain('CANARY');
    expect(String(e)).not.toContain('CANARY');
    expect(JSON.stringify(e)).not.toContain('CANARY');
    return e;
  }
  throw new Error('expected a rejection');
}

function page(result: PageResult): { snapshot: FolderSnapshot; page: number; rows: MessageRow[] } {
  if (result.kind !== 'page') throw new Error(`expected a page, got ${result.kind}`);
  return result;
}

function dayStartUtc(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d));
}

function compiled(where: FilterNode): CompiledFilter {
  return compileFilter({ version: 1, where }, { now: NOW, dayStart: dayStartUtc });
}

/** A leaf with no checks and no envelope or structure need: the pass fetches only the basics. */
function plain(): CompiledFilter {
  return compiled({ kind: 'subject', value: 'a' });
}

/** A checked leaf: the pass needs the envelope. */
function fromShop(): CompiledFilter {
  return compiled({ kind: 'from', values: ['@shop.example'] });
}

function consecutive(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

// --- uidSets ------------------------------------------------------------------------------

describe('uidSets', () => {
  it('uidSets never loops on a bad limit', () => {
    expect(uidSets([1, 2, 3], 0, 0)).toEqual(['1', '2', '3']);
  });

  it('uidSets: no input gives no sets', () => {
    expect(uidSets([])).toEqual([]);
  });

  it('uidSets: runs and single UIDs share a set', () => {
    expect(uidSets([1, 2, 3, 7, 9, 10])).toEqual(['1:3,7,9:10']);
  });

  it('uidSets: 12,000 consecutive UIDs split at 5,000', () => {
    expect(uidSets(consecutive(1, 12_000))).toEqual(['1:5000', '5001:10000', '10001:12000']);
  });

  it('uidSets: 3,000 odd numbers stay within the character limit and lose nothing', () => {
    const odds = Array.from({ length: 3000 }, (_, i) => 2 * i + 1);
    const sets = uidSets(odds);
    expect(sets.length).toBeGreaterThan(1);
    for (const s of sets) {
      expect(s.length).toBeLessThanOrEqual(SEARCH_SET_CHARS);
      expect(s.startsWith(',')).toBe(false);
      expect(s.endsWith(',')).toBe(false);
    }
    expect(expandSet(sets.join(','))).toEqual(odds);
  });

  it('uidSets: maxUids 2 on [1, 2, 3] gives two sets', () => {
    expect(uidSets([1, 2, 3], 2)).toEqual(['1:2', '3']);
  });

  it('uidSets: a non-finite limit gives the default limits', () => {
    expect(uidSets(consecutive(1, 12_000), Number.NaN, Number.NaN)).toEqual(
      uidSets(consecutive(1, 12_000)),
    );
  });
});

// --- searchFolder -------------------------------------------------------------------------

describe('searchFolder', () => {
  it('searchFolder: read-only, one search, the candidates by UID', async () => {
    const { session, calls } = fake({ exists: 10, found: [3, 1, 2] });
    const filter = plain();
    const result = await searchFolder(session, 'INBOX', filter);

    expect(calls.lock).toEqual([{ path: 'INBOX', options: { readOnly: true } }]);
    expect(calls.order.slice(0, 3)).toEqual(['lock', 'noop', 'search']);
    expect(calls.order.at(-1)).toBe('release');
    expect(calls.search).toEqual([{ query: filter.query, options: { uid: true }, onClient: true }]);
    expect(calls.fetch).toEqual([
      { set: '1:3', query: { uid: true, size: true, internalDate: true }, options: { uid: true } },
    ]);
    expect(result.matches.map((m) => m.uid)).toEqual([3, 2, 1]);
    expect(result.bytes).toBe(600);
    expect(result.snapshot).toEqual(SNAP);
    expect(calls.release).toBe(1);
    expect(calls.forbidden).toEqual([]);
  });

  it('the pass asks for envelope / structure only when a check needs them', async () => {
    const address = fake({ exists: 3, found: [1] });
    await searchFolder(address.session, 'INBOX', fromShop());
    const addressQuery = address.calls.fetch[0]?.query;
    expect(addressQuery).toEqual({ uid: true, size: true, internalDate: true, envelope: true });
    expect(addressQuery).not.toHaveProperty('bodyStructure');

    const attachment = fake({ exists: 3, found: [1] });
    await searchFolder(
      attachment.session,
      'INBOX',
      compiled({ kind: 'hasAttachments', value: true }),
    );
    const structureQuery = attachment.calls.fetch[0]?.query;
    expect(structureQuery).toEqual({
      uid: true,
      size: true,
      internalDate: true,
      bodyStructure: true,
    });
    expect(structureQuery).not.toHaveProperty('envelope');
  });

  it('checks decide: a missing size gives null bytes, a missing date gives null received', async () => {
    const { session } = fake({
      exists: 4,
      found: [1, 2, 3, 4],
      message: (uid) => {
        if (uid === 1) {
          return message(1, {
            size: undefined,
            internalDate: new Date(DAY2),
            envelope: sender('s1@shop.example'),
          });
        }
        if (uid === 2) return message(2, { envelope: sender('s2@other.example') });
        if (uid === 3) {
          return message(3, { internalDate: undefined, envelope: sender('s3@shop.example') });
        }
        return message(4, { envelope: sender('s4@other.example') });
      },
    });
    const result = await searchFolder(session, 'INBOX', fromShop());
    expect(result.matches).toEqual([
      { uid: 3, bytes: 300, received: null },
      { uid: 1, bytes: null, received: DAY2 },
    ]);
    expect(result.bytes).toBe(300);
    expect(result.missing).toBe(0);
  });

  it('messages the server adds are ignored', async () => {
    const { session, calls } = fake({
      exists: 9,
      found: [1, 2],
      extra: [message(9), message(1)],
    });
    const result = await searchFolder(session, 'INBOX', plain());
    expect(result.matches.map((m) => m.uid)).toEqual([2, 1]);
    expect(result.bytes).toBe(300);
    expect(calls.fetch.map((f) => f.set)).toEqual(['1:2']);
  });

  it('candidates the server no longer has are not matches, and are counted', async () => {
    const gone = fake({
      exists: 3,
      found: [1, 2, 3],
      message: (uid) => (uid === 2 ? null : message(uid)),
    });
    const partial = await searchFolder(gone.session, 'INBOX', plain());
    expect(partial.matches.map((m) => m.uid)).toEqual([3, 1]);
    expect(partial.missing).toBe(1);

    const rejected = fake({
      exists: 3,
      found: [1, 2, 3],
      message: (uid) =>
        uid === 2 ? message(2, { envelope: sender('s2@other.example') }) : message(uid),
    });
    const complete = await searchFolder(rejected.session, 'INBOX', fromShop());
    expect(complete.matches.map((m) => m.uid)).toEqual([3, 1]);
    expect(complete.missing).toBe(0);
  });

  it('junk from search is dropped', async () => {
    const { session, calls } = fake({ exists: 7, found: [5, 5, 0, -1, 2.5, 7] });
    const result = await searchFolder(session, 'INBOX', plain());
    expect(calls.fetch.map((f) => f.set)).toEqual(['5,7']);
    expect(result.matches.map((m) => m.uid)).toEqual([7, 5]);
  });

  it('progress after each set', async () => {
    const seen: [number, number][] = [];
    const { session } = fake({ exists: 12_000, found: consecutive(1, 12_000) });
    const result = await searchFolder(session, 'INBOX', plain(), {
      onProgress: (done, total) => seen.push([done, total]),
    });
    expect(seen).toEqual([
      [5000, 12_000],
      [10_000, 12_000],
      [12_000, 12_000],
    ]);
    expect(result.matches).toHaveLength(12_000);

    const throwing = fake({ exists: 12_000, found: consecutive(1, 12_000) });
    const unaffected = await searchFolder(throwing.session, 'INBOX', plain(), {
      onProgress: () => {
        throw new Error('progress failed');
      },
    });
    expect(unaffected.matches).toHaveLength(12_000);
    expect(unaffected.bytes).toBe(result.bytes);
  });

  it('shouldStop ends it with SearchStopped', async () => {
    const { session, calls } = fake({ exists: 12_000, found: consecutive(1, 12_000) });
    let asked = 0;
    const run = searchFolder(session, 'INBOX', plain(), {
      shouldStop: () => {
        asked++;
        return asked > 1;
      },
    });
    await expect(run).rejects.toBeInstanceOf(SearchStopped);
    expect(calls.fetch).toHaveLength(1);
    expect(calls.release).toBe(1);
    expect(calls.forbidden).toEqual([]);
  });

  it('too many candidates', async () => {
    const { session, calls } = fake({ exists: 3, found: [1, 2, 3] });
    const err = await mailboxError(searchFolder(session, 'INBOX', plain(), { maxMatches: 2 }));
    expect(err.code).toBe('too-many-matches');
    expect(calls.fetch).toEqual([]);
  });

  it.each<[string, FakeOpts]>([
    ['a rejected search', { exists: 3, fail: { at: 'search', how: 'plain' } }],
    ['a search that resolves false', { exists: 3, found: false }],
    ['a search that resolves undefined', { exists: 3, found: undefined }],
    ['a search that resolves a string', { exists: 3, found: 'x' }],
    ['a client without search', { exists: 3, noSearch: true }],
  ])('a refused search (%s) → search-failed, nothing fetched', async (_name, opts) => {
    const { session, calls } = fake(opts);
    const err = await mailboxError(searchFolder(session, 'INBOX', plain()));
    expect(err.code).toBe('search-failed');
    expect(calls.fetch).toEqual([]);
    expect(calls.forbidden).toEqual([]);
  });

  it('a closed connection during the search → connection-lost', async () => {
    const { session } = fake({ exists: 3, found: [1], fail: { at: 'search', how: 'closed' } });
    const err = await mailboxError(searchFolder(session, 'INBOX', plain()));
    expect(err.code).toBe('connection-lost');
  });

  it('a failed lock → folder-unavailable', async () => {
    const { session, calls } = fake({ exists: 3, found: [1], fail: { at: 'lock', how: 'plain' } });
    const err = await mailboxError(searchFolder(session, 'INBOX', plain()));
    expect(err.code).toBe('folder-unavailable');
    expect(calls.search).toEqual([]);
  });

  it('no candidates: no fetch, no matches, no progress', async () => {
    const progress: number[] = [];
    const { session, calls } = fake({ exists: 3, found: [] });
    const result = await searchFolder(session, 'INBOX', plain(), {
      onProgress: (done) => progress.push(done),
    });
    expect(result.matches).toEqual([]);
    expect(result.bytes).toBe(0);
    expect(result.missing).toBe(0);
    expect(calls.fetch).toEqual([]);
    expect(progress).toEqual([]);
  });

  it('a session closed before the call → connection-lost, no lock taken', async () => {
    const { session, calls } = fake({ exists: 3, found: [1], closed: true });
    const err = await mailboxError(searchFolder(session, 'INBOX', plain()));
    expect(err.code).toBe('connection-lost');
    expect(calls.lock).toEqual([]);
  });

  it('shouldStop true before the first batch → SearchStopped, no fetch, lock released', async () => {
    const { session, calls } = fake({ exists: 3, found: [1, 2, 3] });
    await expect(
      searchFolder(session, 'INBOX', plain(), { shouldStop: () => true }),
    ).rejects.toBeInstanceOf(SearchStopped);
    expect(calls.fetch).toEqual([]);
    expect(calls.release).toBe(1);
  });

  it('maxMatches is inclusive: exactly that many candidates are fine', async () => {
    const { session } = fake({ exists: 3, found: [1, 2, 3] });
    const result = await searchFolder(session, 'INBOX', plain(), { maxMatches: 3 });
    expect(result.matches.map((m) => m.uid)).toEqual([3, 2, 1]);
  });

  it('the search limits have their spec values', () => {
    expect(SEARCH_MAX_MATCHES).toBe(500_000);
    expect(SEARCH_BATCH_UIDS).toBe(5000);
    expect(SEARCH_SET_CHARS).toBe(4000);
  });
});

// --- loadMatches --------------------------------------------------------------------------

describe('loadMatches', () => {
  it('loadMatches: the asked rows in the asked order', async () => {
    const { session, calls } = fake({
      exists: 10,
      message: (uid) => message(uid, uid === 9 ? { bodyStructure: ATTACHED } : {}),
    });
    const result = page(await loadMatches(session, 'INBOX', SNAP, 0, [9, 2, 5]));

    expect(calls.fetch).toEqual([
      {
        set: '2,5,9',
        query: { uid: true, envelope: true, internalDate: true, size: true, bodyStructure: true },
        options: { uid: true },
      },
    ]);
    expect(result.snapshot).toEqual(SNAP);
    expect(result.page).toBe(0);
    expect(result.rows.map((r) => r.uid)).toEqual([9, 2, 5]);
    expect(result.rows.map((r) => r.from)).toEqual(['Sender 9', 'Sender 2', 'Sender 5']);
    expect(result.rows.map((r) => r.subject)).toEqual(['Subject 9', 'Subject 2', 'Subject 5']);
    expect(result.rows.map((r) => r.bytes)).toEqual([900, 200, 500]);
    expect(result.rows.map((r) => r.attachment)).toEqual([true, false, false]);
  });

  it('loadMatches: missing and foreign rows', async () => {
    const { session } = fake({
      exists: 10,
      message: (uid) => (uid === 2 ? null : message(uid)),
      extra: [message(77)],
    });
    const result = page(await loadMatches(session, 'INBOX', SNAP, 0, [9, 2, 5]));
    expect(result.rows.map((r) => r.uid)).toEqual([9, 5]);
  });

  it('loadMatches: changed only on another UIDVALIDITY', async () => {
    const sameValidity = fake({ exists: 10 });
    const stillPage = await loadMatches(
      sameValidity.session,
      'INBOX',
      { ...SNAP, exists: 9 },
      0,
      [2],
    );
    expect(stillPage.kind).toBe('page');
    expect(sameValidity.calls.fetch).toHaveLength(1);

    const other = fake({ exists: 10, uidValidity: 8n });
    const changed = await loadMatches(other.session, 'INBOX', SNAP, 0, [2]);
    expect(changed).toEqual({ kind: 'changed', snapshot: { ...SNAP, uidValidity: '8' } });
    expect(other.calls.fetch).toEqual([]);
  });

  it('loadMatches: no uids → a page with no rows, no fetch', async () => {
    const { session, calls } = fake({ exists: 10 });
    const result = page(await loadMatches(session, 'INBOX', SNAP, 0, []));
    expect(result).toEqual({ kind: 'page', snapshot: SNAP, page: 0, rows: [] });
    expect(calls.fetch).toEqual([]);
  });

  it('loadMatches: at most one page of UIDs is asked', async () => {
    const big: FolderSnapshot = { ...SNAP, exists: 250 };
    const { session, calls } = fake({ exists: 250 });
    const result = page(await loadMatches(session, 'INBOX', big, 0, consecutive(1, 250)));
    expect(expandSet(calls.fetch[0]?.set ?? '')).toEqual(consecutive(1, PAGE_SIZE));
    expect(result.rows).toHaveLength(PAGE_SIZE);
  });

  it('loadMatches: duplicates and junk UIDs are not asked', async () => {
    const { session, calls } = fake({ exists: 10 });
    const result = page(await loadMatches(session, 'INBOX', SNAP, 0, [9, 9, 0, -3, 2.5, 2]));
    expect(calls.fetch.map((f) => f.set)).toEqual(['2,9']);
    expect(result.rows.map((r) => r.uid)).toEqual([9, 2]);
  });
});

// --- constants and errors -----------------------------------------------------------------

describe('search errors and stop signal', () => {
  it('SearchStopped is an Error with the fixed name and message', () => {
    const err = new SearchStopped();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('SearchStopped');
    expect(err.message).toBe('The search was stopped');
  });

  it('search-failed has its fixed core message', () => {
    expect(new MailboxError('search-failed').message).toBe(
      'The mail server could not run this search',
    );
  });

  it('too-many-matches has its fixed core message', () => {
    expect(new MailboxError('too-many-matches').message).toBe(
      'Too many messages match this search',
    );
  });
});
