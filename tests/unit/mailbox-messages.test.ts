import { describe, it, expect } from 'vitest';
import type { MailboxLockObject } from 'imapflow';
import type { ImapClientLike } from '../../src/core/imap/session.js';
import { MailboxError } from '../../src/core/mailbox/errors.js';
import {
  MAX_STRUCTURE_NODES,
  MAX_TEXT_CHARS,
  PAGE_SIZE,
  hasAttachment,
  loadPage,
  openFolder,
  pageCount,
  pageRange,
} from '../../src/core/mailbox/messages.js';
import type {
  FolderSnapshot,
  MessageRow,
  MessageSession,
  PageResult,
} from '../../src/core/mailbox/messages.js';

// M2b-1 message pages (spec): openFolder / loadPage over a fake IMAP client, plus the pure
// helpers pageRange / pageCount / hasAttachment.

const CANARY = 'CANARY-server-text imap.secret-host.example canary@secret-domain.example';

const PAGE_QUERY = {
  uid: true,
  envelope: true,
  internalDate: true,
  size: true,
  bodyStructure: true,
};

// --- fake client --------------------------------------------------------------------------

interface FakeMsg {
  seq?: number;
  uid?: number;
  size?: number;
  envelope?: { subject?: string; from?: { name?: string; address?: string }[] };
  internalDate?: Date | string;
  bodyStructure?: unknown;
}

type FailAt = 'lock' | 'noop' | 'fetch' | 'fetch-mid';
type FailHow = 'plain' | 'closed' | 'unusable';

interface FakeOpts {
  /** EXISTS after EXAMINE (before NOOP). */
  exists: number;
  /** Default 7n; 'absent' leaves the property out; anything else is put in as is. */
  uidValidity?: unknown;
  /** client.mailbox stays false after the lock. */
  mailboxFalse?: boolean;
  /** Pending updates that only become visible when noop() runs. */
  afterNoop?: { exists?: number; uidValidity?: bigint };
  /** The message the server returns for `seq`; null = the server skips it. */
  message?: (seq: number) => FakeMsg | null;
  /** Order the server streams the range in; default ascending. */
  order?: 'asc' | 'desc' | 'shuffle';
  fail?: { at: FailAt; how: FailHow };
  /** The session is already closed before the call. */
  closed?: boolean;
}

interface FakeState {
  closed: boolean;
  usable: boolean;
}

interface Calls {
  order: string[];
  lock: { path: string; options: unknown }[];
  release: number;
  noop: number;
  fetch: { range: string; query: unknown; options: unknown }[];
  /** Any other client method that was called (must stay empty: read-only). */
  forbidden: string[];
}

function defaultMessage(seq: number): FakeMsg {
  return {
    seq,
    uid: 1000 + seq,
    size: 100 * seq,
    envelope: {
      subject: `Subject ${seq}`,
      from: [{ name: `Sender ${seq}`, address: `s${seq}@example.test` }],
    },
    internalDate: new Date(Date.UTC(2026, 0, 1) + seq * 60_000),
    bodyStructure: { type: 'text/plain' },
  };
}

function ordered<T>(items: T[], order: 'asc' | 'desc' | 'shuffle'): T[] {
  if (order === 'asc') return items;
  if (order === 'desc') return [...items].reverse();
  // Deterministic shuffle: odd positions reversed, then even positions.
  const odd = items.filter((_, i) => i % 2 === 1).reverse();
  const even = items.filter((_, i) => i % 2 === 0);
  return [...odd, ...even];
}

function fake(opts: FakeOpts): { session: MessageSession; calls: Calls; state: FakeState } {
  const state: FakeState = { closed: opts.closed ?? false, usable: true };
  const calls: Calls = { order: [], lock: [], release: 0, noop: 0, fetch: [], forbidden: [] };
  let mailbox: Record<string, unknown> | false = false;

  function failNow(at: FailAt): boolean {
    if (opts.fail?.at !== at) return false;
    if (opts.fail.how === 'closed') state.closed = true;
    if (opts.fail.how === 'unusable') state.usable = false;
    return true;
  }

  const base = {
    get usable() {
      return state.usable;
    },
    get mailbox() {
      return mailbox;
    },
    getMailboxLock(path: string, options?: unknown): Promise<MailboxLockObject> {
      calls.order.push('lock');
      calls.lock.push({ path, options });
      if (failNow('lock')) return Promise.reject(new Error(CANARY));
      if (opts.mailboxFalse !== true) {
        const box: Record<string, unknown> = { exists: opts.exists };
        if (opts.uidValidity !== 'absent') box.uidValidity = opts.uidValidity ?? 7n;
        mailbox = box;
      }
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
      if (mailbox !== false && opts.afterNoop !== undefined) {
        const next = { ...mailbox };
        if (opts.afterNoop.exists !== undefined) next.exists = opts.afterNoop.exists;
        if (opts.afterNoop.uidValidity !== undefined) next.uidValidity = opts.afterNoop.uidValidity;
        mailbox = next;
      }
      return Promise.resolve();
    },
    fetch(range: string, query: unknown, options?: unknown): AsyncIterable<FakeMsg> {
      calls.order.push('fetch');
      calls.fetch.push({ range, query, options });
      return {
        async *[Symbol.asyncIterator]() {
          await Promise.resolve();
          if (failNow('fetch')) throw new Error(CANARY);
          const [from, to] = range.split(':').map(Number);
          const items: FakeMsg[] = [];
          for (let seq = from ?? 1; seq <= (to ?? 0); seq++) {
            const m = (opts.message ?? defaultMessage)(seq);
            if (m !== null) items.push(m);
          }
          let sent = 0;
          for (const m of ordered(items, opts.order ?? 'asc')) {
            if (sent === 2 && failNow('fetch-mid')) throw new Error(CANARY);
            yield m;
            sent++;
          }
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

  const session: MessageSession = {
    client: client as unknown as ImapClientLike,
    get closed() {
      return state.closed;
    },
  };
  return { session, calls, state };
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

function onlyReadOnly(calls: Calls): void {
  expect(calls.forbidden).toEqual([]);
  for (const l of calls.lock) expect(l.options).toMatchObject({ readOnly: true });
  for (const f of calls.fetch) {
    expect(f.query).toEqual(PAGE_QUERY);
    expect((f.options as { uid?: unknown } | undefined)?.uid).not.toBe(true);
  }
}

async function oneRow(msg: FakeMsg): Promise<MessageRow> {
  const { session } = fake({ exists: 1, message: () => ({ seq: 1, uid: 77, ...msg }) });
  const rows = page(await loadPage(session, 'INBOX', null, 0)).rows;
  const row = rows[0];
  if (row === undefined) throw new Error('no row');
  expect(rows).toHaveLength(1);
  return row;
}

// --- constants and pure helpers ---------------------------------------------------------------

describe('constants', () => {
  it('PAGE_SIZE 200, MAX_TEXT_CHARS 500, MAX_STRUCTURE_NODES 1000', () => {
    expect(PAGE_SIZE).toBe(200);
    expect(MAX_TEXT_CHARS).toBe(500);
    expect(MAX_STRUCTURE_NODES).toBe(1000);
  });
});

describe('pageRange', () => {
  it.each<[number, number, { from: number; to: number } | null]>([
    [1, 0, { from: 1, to: 1 }],
    [199, 0, { from: 1, to: 199 }],
    [200, 0, { from: 1, to: 200 }],
    [201, 0, { from: 2, to: 201 }],
    [201, 1, { from: 1, to: 1 }],
    [201, 2, null],
    [450, 0, { from: 251, to: 450 }],
    [450, 1, { from: 51, to: 250 }],
    [450, 2, { from: 1, to: 50 }],
    [450, 3, null],
    [400, 1, { from: 1, to: 200 }],
    [400, 2, null],
    [1_000_000, 0, { from: 999_801, to: 1_000_000 }],
    [1_000_000, 4999, { from: 1, to: 200 }],
    [0, 0, null],
    [0, 1, null],
  ])('pageRange(%i, %i)', (exists, p, expected) => {
    expect(pageRange(exists, p)).toEqual(expected);
  });

  it.each<[number, number]>([
    [10, -1],
    [10, 0.5],
    [10.5, 0],
    [-1, 0],
    [Number.NaN, 0],
    [10, Number.NaN],
    [Number.POSITIVE_INFINITY, 0],
  ])('invalid input (%d, %d) → null', (exists, p) => {
    expect(pageRange(exists, p)).toBeNull();
  });

  it('size overrides 200', () => {
    expect(pageRange(10, 0, 5)).toEqual({ from: 6, to: 10 });
    expect(pageRange(10, 1, 5)).toEqual({ from: 1, to: 5 });
    expect(pageRange(11, 2, 5)).toEqual({ from: 1, to: 1 });
    expect(pageRange(10, 2, 5)).toBeNull();
  });
});

describe('pageCount', () => {
  it.each<[number, number]>([
    [0, 0],
    [1, 1],
    [199, 1],
    [200, 1],
    [201, 2],
    [450, 3],
    [1_000_000, 5000],
  ])('pageCount(%i) = %i', (exists, n) => {
    expect(pageCount(exists)).toBe(n);
  });

  it('size overrides 200', () => {
    expect(pageCount(10, 5)).toBe(2);
    expect(pageCount(11, 5)).toBe(3);
  });
});

// --- openFolder ---------------------------------------------------------------------------

describe('openFolder', () => {
  it('EXAMINE, NOOP, snapshot (bigint → decimal string), release; no FETCH', async () => {
    const { session, calls } = fake({ exists: 42, uidValidity: 4_294_967_295n });
    const snap = await openFolder(session, 'INBOX');
    expect(snap).toEqual({ path: 'INBOX', uidValidity: '4294967295', exists: 42 });
    expect(calls.lock).toEqual([
      { path: 'INBOX', options: expect.objectContaining({ readOnly: true }) as unknown },
    ]);
    expect(calls.order).toEqual(['lock', 'noop', 'release']);
    expect(calls.fetch).toEqual([]);
    onlyReadOnly(calls);
  });

  it('reads the snapshot after NOOP (pending EXISTS / UIDVALIDITY updates)', async () => {
    const { session } = fake({ exists: 42, afterNoop: { exists: 45, uidValidity: 9n } });
    expect(await openFolder(session, 'Work/Mail')).toEqual({
      path: 'Work/Mail',
      uidValidity: '9',
      exists: 45,
    });
  });

  it('an empty folder is a snapshot with exists 0', async () => {
    const { session, calls } = fake({ exists: 0 });
    expect(await openFolder(session, 'Empty')).toEqual({
      path: 'Empty',
      uidValidity: '7',
      exists: 0,
    });
    expect(calls.fetch).toEqual([]);
  });

  it.each<[string, FakeOpts]>([
    ['lock rejects', { exists: 1, fail: { at: 'lock', how: 'plain' } }],
    ['noop rejects', { exists: 1, fail: { at: 'noop', how: 'plain' } }],
    ['mailbox is false', { exists: 1, mailboxFalse: true }],
    ['uidValidity missing', { exists: 1, uidValidity: 'absent' }],
    ['uidValidity is a number', { exists: 1, uidValidity: 7 }],
    ['uidValidity is a string', { exists: 1, uidValidity: '7' }],
    ['exists is negative', { exists: -1 }],
    ['exists is NaN', { exists: Number.NaN }],
    ['exists is fractional', { exists: 1.5 }],
  ])('%s → folder-unavailable', async (_, opts) => {
    const { session, calls } = fake(opts);
    expect((await mailboxError(openFolder(session, 'INBOX'))).code).toBe('folder-unavailable');
    expect(calls.fetch).toEqual([]);
    onlyReadOnly(calls);
  });

  it('releases the lock on failure after locking', async () => {
    for (const opts of [
      { exists: 1, fail: { at: 'noop', how: 'plain' } },
      { exists: 1, mailboxFalse: true },
      { exists: 1, uidValidity: 'absent' },
    ] satisfies FakeOpts[]) {
      const { session, calls } = fake(opts);
      await mailboxError(openFolder(session, 'INBOX'));
      expect(calls.release).toBe(1);
    }
  });

  it('closed before the call → connection-lost, no lock taken', async () => {
    const { session, calls } = fake({ exists: 1, closed: true });
    expect((await mailboxError(openFolder(session, 'INBOX'))).code).toBe('connection-lost');
    expect(calls.lock).toEqual([]);
    expect(calls.order).toEqual([]);
  });

  it.each<[FailAt, FailHow]>([
    ['lock', 'closed'],
    ['lock', 'unusable'],
    ['noop', 'closed'],
    ['noop', 'unusable'],
  ])('%s fails with the session %s → connection-lost', async (at, how) => {
    const { session } = fake({ exists: 1, fail: { at, how } });
    expect((await mailboxError(openFolder(session, 'INBOX'))).code).toBe('connection-lost');
  });
});

// --- loadPage -------------------------------------------------------------------------------

describe('loadPage: fetch', () => {
  it.each<[number, number, string]>([
    [450, 0, '251:450'],
    [450, 1, '51:250'],
    [450, 2, '1:50'],
    [200, 0, '1:200'],
    [1, 0, '1:1'],
  ])('exists %i page %i → range %s, exact query, sequence mode', async (exists, p, range) => {
    const { session, calls } = fake({ exists });
    const result = page(await loadPage(session, 'INBOX', null, p));
    expect(result.page).toBe(p);
    expect(result.snapshot).toEqual({ path: 'INBOX', uidValidity: '7', exists });
    expect(calls.fetch).toHaveLength(1);
    expect(calls.fetch[0]?.range).toBe(range);
    expect(calls.fetch[0]?.query).toEqual(PAGE_QUERY);
    expect(calls.order).toEqual(['lock', 'noop', 'fetch', 'release']);
    onlyReadOnly(calls);
  });

  it('query has no source / bodyParts / flags / headers', async () => {
    const { session, calls } = fake({ exists: 3 });
    await loadPage(session, 'INBOX', null, 0);
    const q = calls.fetch[0]?.query as Record<string, unknown>;
    for (const k of ['source', 'bodyParts', 'flags', 'headers', 'threadId', 'labels']) {
      expect(q).not.toHaveProperty(k);
    }
  });

  it.each<'asc' | 'desc' | 'shuffle'>(['asc', 'desc', 'shuffle'])(
    'rows sorted newest first whatever the server order (%s)',
    async (order) => {
      const { session } = fake({ exists: 450, order });
      const rows = page(await loadPage(session, 'INBOX', null, 1)).rows;
      expect(rows.map((r) => r.seq)).toEqual(Array.from({ length: 200 }, (_, i) => 250 - i));
      expect(rows.map((r) => r.uid)).toEqual(Array.from({ length: 200 }, (_, i) => 1250 - i));
    },
  );

  it('page past the end → rows [] and no FETCH', async () => {
    const { session, calls } = fake({ exists: 450 });
    const result = page(await loadPage(session, 'INBOX', null, 3));
    expect(result).toEqual({
      kind: 'page',
      snapshot: { path: 'INBOX', uidValidity: '7', exists: 450 },
      page: 3,
      rows: [],
    });
    expect(calls.fetch).toEqual([]);
    expect(calls.release).toBe(1);
  });

  it('empty folder → rows [] and no FETCH', async () => {
    const { session, calls } = fake({ exists: 0 });
    expect(page(await loadPage(session, 'Empty', null, 0)).rows).toEqual([]);
    expect(calls.fetch).toEqual([]);
    expect(calls.order).toEqual(['lock', 'noop', 'release']);
  });

  it('uses the post-NOOP exists for the range', async () => {
    const { session, calls } = fake({ exists: 450, afterNoop: { exists: 452 } });
    const result = page(await loadPage(session, 'INBOX', null, 0));
    expect(result.snapshot.exists).toBe(452);
    expect(calls.fetch[0]?.range).toBe('253:452');
  });
});

describe('loadPage: expected snapshot', () => {
  const EXPECTED: FolderSnapshot = { path: 'INBOX', uidValidity: '7', exists: 450 };

  it('same snapshot → page', async () => {
    const { session, calls } = fake({ exists: 450 });
    const result = page(await loadPage(session, 'INBOX', EXPECTED, 2));
    expect(result.rows).toHaveLength(50);
    expect(calls.fetch).toHaveLength(1);
  });

  it('exists changed (visible after NOOP) → changed, no FETCH', async () => {
    const { session, calls } = fake({ exists: 450, afterNoop: { exists: 451 } });
    const result = await loadPage(session, 'INBOX', EXPECTED, 1);
    expect(result).toEqual({
      kind: 'changed',
      snapshot: { path: 'INBOX', uidValidity: '7', exists: 451 },
    });
    expect(calls.fetch).toEqual([]);
    expect(calls.release).toBe(1);
  });

  it('UIDVALIDITY changed → changed, no FETCH', async () => {
    const { session, calls } = fake({ exists: 450, afterNoop: { uidValidity: 8n } });
    const result = await loadPage(session, 'INBOX', EXPECTED, 0);
    expect(result).toEqual({
      kind: 'changed',
      snapshot: { path: 'INBOX', uidValidity: '8', exists: 450 },
    });
    expect(calls.fetch).toEqual([]);
  });

  it('fewer messages (expunge) → changed', async () => {
    const { session, calls } = fake({ exists: 450, afterNoop: { exists: 449 } });
    expect((await loadPage(session, 'INBOX', EXPECTED, 0)).kind).toBe('changed');
    expect(calls.fetch).toEqual([]);
  });

  it('expected null always fetches, even after changes', async () => {
    const { session, calls } = fake({ exists: 450, afterNoop: { exists: 460, uidValidity: 9n } });
    const result = page(await loadPage(session, 'INBOX', null, 0));
    expect(result.snapshot).toEqual({ path: 'INBOX', uidValidity: '9', exists: 460 });
    expect(calls.fetch).toHaveLength(1);
  });
});

describe('loadPage: rows', () => {
  it('maps every field', async () => {
    const date = new Date(Date.UTC(2026, 4, 6, 7, 8, 9));
    const row = await oneRow({
      size: 2048,
      envelope: { subject: 'Hello', from: [{ name: 'Alice', address: 'alice@example.test' }] },
      internalDate: date,
      bodyStructure: {
        type: 'multipart/mixed',
        childNodes: [
          { type: 'text/plain' },
          { type: 'application/pdf', disposition: 'attachment' },
        ],
      },
    });
    expect(row).toEqual({
      seq: 1,
      uid: 77,
      received: date,
      from: 'Alice',
      subject: 'Hello',
      bytes: 2048,
      attachment: true,
    });
    expect(row.received?.getTime()).toBe(date.getTime());
  });

  it('from: name, else address, else null', async () => {
    expect(
      (await oneRow({ envelope: { from: [{ name: 'Bob', address: 'b@x.test' }] } })).from,
    ).toBe('Bob');
    expect((await oneRow({ envelope: { from: [{ name: '', address: 'b@x.test' }] } })).from).toBe(
      'b@x.test',
    );
    expect((await oneRow({ envelope: { from: [{ address: 'c@x.test' }] } })).from).toBe('c@x.test');
    expect(
      (
        await oneRow({
          envelope: {
            from: [{ address: 'first@x.test' }, { name: 'Second', address: 's@x.test' }],
          },
        })
      ).from,
    ).toBe('first@x.test');
    expect((await oneRow({ envelope: { from: [] } })).from).toBeNull();
    expect((await oneRow({ envelope: {} })).from).toBeNull();
    expect((await oneRow({})).from).toBeNull();
  });

  it('subject missing → null', async () => {
    expect((await oneRow({ envelope: {} })).subject).toBeNull();
    expect((await oneRow({})).subject).toBeNull();
  });

  it('received: invalid or missing → null', async () => {
    expect((await oneRow({ internalDate: new Date('not a date') })).received).toBeNull();
    expect((await oneRow({ internalDate: 'garbage' })).received).toBeNull();
    expect((await oneRow({})).received).toBeNull();
  });

  it.each<[number | undefined, number | null]>([
    [0, 0],
    [12_345, 12_345],
    [undefined, null],
    [-1, null],
    [1.5, null],
    [Number.NaN, null],
    [Number.POSITIVE_INFINITY, null],
    [2 ** 53, null],
  ])('bytes: size %s → %s', async (size, bytes) => {
    const msg: FakeMsg = {};
    if (size !== undefined) msg.size = size;
    expect((await oneRow(msg)).bytes).toBe(bytes);
  });

  it('attachment false for a plain text body or no structure', async () => {
    expect((await oneRow({ bodyStructure: { type: 'text/plain' } })).attachment).toBe(false);
    expect((await oneRow({})).attachment).toBe(false);
  });

  it('a message without a valid uid or seq is skipped → fewer rows', async () => {
    const bad: Record<number, FakeMsg> = {
      2: { seq: 2, size: 1 },
      3: { seq: 3, uid: 0 },
      4: { seq: 4, uid: -5 },
      5: { seq: 5, uid: 1.5 },
      6: { uid: 1006 },
      7: { seq: 0, uid: 1007 },
    };
    const { session } = fake({
      exists: 10,
      message: (seq) => bad[seq] ?? defaultMessage(seq),
    });
    const rows = page(await loadPage(session, 'INBOX', null, 0)).rows;
    expect(rows.map((r) => r.seq)).toEqual([10, 9, 8, 1]);
  });

  it('a message the server does not return is just missing', async () => {
    const { session } = fake({
      exists: 5,
      message: (seq) => (seq === 3 ? null : defaultMessage(seq)),
    });
    expect(page(await loadPage(session, 'INBOX', null, 0)).rows.map((r) => r.seq)).toEqual([
      5, 4, 2, 1,
    ]);
  });

  it('from / subject capped to 500 code points', async () => {
    const longSubject = '😀'.repeat(600);
    const longName = 'n'.repeat(1_000_000);
    const row = await oneRow({ envelope: { subject: longSubject, from: [{ name: longName }] } });
    const subject = row.subject ?? '';
    const from = row.from ?? '';
    expect([...subject]).toHaveLength(MAX_TEXT_CHARS);
    expect([...from]).toHaveLength(MAX_TEXT_CHARS);
    expect([...subject].slice(0, 499).join('')).toBe('😀'.repeat(499));
    expect(from.slice(0, 499)).toBe('n'.repeat(499));
  });

  it('exactly 500 code points stay as they are', async () => {
    const s = '日'.repeat(500);
    expect((await oneRow({ envelope: { subject: s } })).subject).toBe(s);
  });

  it('control / bidi / ESC characters survive in core (the shell sanitises)', async () => {
    const subject = '\x1b[31mred\x1b[0m \u202Etxt.exe \u200B\x07\n\t';
    const name = '\x1b]0;title\x07Eve';
    const row = await oneRow({ envelope: { subject, from: [{ name }] } });
    expect(row.subject).toBe(subject);
    expect(row.from).toBe(name);
  });
});

describe('loadPage: errors', () => {
  it.each<[string, FakeOpts]>([
    ['lock rejects', { exists: 450, fail: { at: 'lock', how: 'plain' } }],
    ['noop rejects', { exists: 450, fail: { at: 'noop', how: 'plain' } }],
    ['fetch throws at once', { exists: 450, fail: { at: 'fetch', how: 'plain' } }],
    ['fetch throws mid-stream', { exists: 450, fail: { at: 'fetch-mid', how: 'plain' } }],
    ['mailbox is false', { exists: 450, mailboxFalse: true }],
    ['uidValidity missing', { exists: 450, uidValidity: 'absent' }],
    ['uidValidity not a bigint', { exists: 450, uidValidity: 7 }],
    ['exists invalid', { exists: -3 }],
  ])('%s → folder-unavailable', async (_, opts) => {
    const { session, calls } = fake(opts);
    expect((await mailboxError(loadPage(session, 'INBOX', null, 0))).code).toBe(
      'folder-unavailable',
    );
    onlyReadOnly(calls);
  });

  it.each<[FailAt, FailHow]>([
    ['lock', 'closed'],
    ['lock', 'unusable'],
    ['noop', 'closed'],
    ['noop', 'unusable'],
    ['fetch', 'closed'],
    ['fetch', 'unusable'],
    ['fetch-mid', 'closed'],
    ['fetch-mid', 'unusable'],
  ])('%s fails with the session %s → connection-lost', async (at, how) => {
    const { session } = fake({ exists: 450, fail: { at, how } });
    expect((await mailboxError(loadPage(session, 'INBOX', null, 0))).code).toBe('connection-lost');
  });

  it('closed before the call → connection-lost, no lock taken', async () => {
    const { session, calls } = fake({ exists: 450, closed: true });
    expect((await mailboxError(loadPage(session, 'INBOX', null, 0))).code).toBe('connection-lost');
    expect(calls.order).toEqual([]);
  });

  it('the lock is released on every failure after locking', async () => {
    for (const at of ['noop', 'fetch', 'fetch-mid'] as const) {
      for (const how of ['plain', 'closed', 'unusable'] as const) {
        const { session, calls } = fake({ exists: 450, fail: { at, how } });
        await mailboxError(loadPage(session, 'INBOX', null, 0));
        expect(calls.release).toBe(1);
      }
    }
  });

  it('released once on success too', async () => {
    const { session, calls } = fake({ exists: 450 });
    await loadPage(session, 'INBOX', null, 0);
    expect(calls.release).toBe(1);
    expect(calls.lock).toHaveLength(1);
  });
});

// --- hasAttachment ----------------------------------------------------------------------------

describe('hasAttachment', () => {
  const pdf = { type: 'application/pdf', disposition: 'attachment' };

  it.each<[string, unknown, boolean]>([
    ['plain text', { type: 'text/plain' }, false],
    ['attachment disposition', pdf, true],
    ['ATTACHMENT upper case', { type: 'application/pdf', disposition: 'ATTACHMENT' }, true],
    ['Attachment mixed case', { type: 'application/pdf', disposition: 'Attachment' }, true],
    [
      'attachment disposition even without a filename on text',
      { type: 'text/plain', disposition: 'attachment' },
      true,
    ],
    [
      'filename via dispositionParameters, no disposition',
      { type: 'application/pdf', dispositionParameters: { filename: 'a.pdf' } },
      true,
    ],
    [
      'name via parameters, no disposition',
      { type: 'application/pdf', parameters: { name: 'a.pdf' } },
      true,
    ],
    [
      'unknown disposition with a filename',
      { type: 'application/pdf', disposition: 'weird', parameters: { name: 'a.pdf' } },
      true,
    ],
    [
      'inline image with a filename',
      {
        type: 'image/png',
        disposition: 'inline',
        dispositionParameters: { filename: 'logo.png' },
        parameters: { name: 'logo.png' },
      },
      false,
    ],
    ['empty filename', { type: 'application/pdf', parameters: { name: '' } }, false],
    // Review fix: Apple Mail sends PDFs inline with a name; a forwarded mail has no name.
    [
      'inline PDF with a filename (Apple Mail)',
      {
        type: 'application/pdf',
        disposition: 'inline',
        dispositionParameters: { filename: 'a.pdf' },
      },
      true,
    ],
    ['forwarded mail (message/rfc822) without a name', { type: 'message/rfc822' }, true],
    ['inline text body without a name', { type: 'text/plain', disposition: 'inline' }, false],
    [
      'multipart node with a name parameter',
      {
        type: 'multipart/mixed',
        parameters: { name: 'x.zip' },
        childNodes: [{ type: 'text/plain' }],
      },
      false,
    ],
    [
      'nested multipart with an attachment deep inside',
      {
        type: 'multipart/mixed',
        childNodes: [
          {
            type: 'multipart/alternative',
            childNodes: [{ type: 'text/plain' }, { type: 'text/html' }],
          },
          {
            type: 'multipart/related',
            childNodes: [{ type: 'multipart/mixed', childNodes: [pdf] }],
          },
        ],
      },
      true,
    ],
    [
      'nested multipart, only inline images',
      {
        type: 'multipart/related',
        childNodes: [
          { type: 'text/html' },
          {
            type: 'image/png',
            disposition: 'inline',
            dispositionParameters: { filename: 'a.png' },
          },
        ],
      },
      false,
    ],
  ])('%s → %s', (_, structure, expected) => {
    expect(hasAttachment(structure)).toBe(expected);
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['undefined', undefined],
    ['string', 'x'],
    ['number', 42],
    ['empty object', {}],
    ['array', []],
    ['childNodes not an array', { type: 'multipart/mixed', childNodes: 'x' }],
    ['null / string / number children', { type: 'multipart/mixed', childNodes: [null, 'x', 42] }],
    ['disposition not a string', { type: 'application/pdf', disposition: 42 }],
    [
      'dispositionParameters not an object',
      { type: 'application/pdf', dispositionParameters: 'x' },
    ],
    ['parameters.name not a string', { type: 'application/pdf', parameters: { name: 42 } }],
    ['type not a string', { type: 42, parameters: { name: 7 } }],
  ])('garbage (%s) → false, no throw', (_, structure) => {
    expect(hasAttachment(structure)).toBe(false);
  });

  it('a real attachment next to garbage children is still found', () => {
    expect(hasAttachment({ type: 'multipart/mixed', childNodes: [null, 'x', 42, pdf] })).toBe(true);
  });

  function chain(depth: number, leaf: unknown): unknown {
    let node: unknown = leaf;
    for (let i = 0; i < depth; i++) node = { type: 'multipart/mixed', childNodes: [node] };
    return node;
  }

  it('a 5,000-deep chain does not throw; the attachment beyond the node cap is not found', () => {
    expect(() => hasAttachment(chain(5000, pdf))).not.toThrow();
    expect(hasAttachment(chain(5000, pdf))).toBe(false);
  });

  it('an attachment within the cap in a deep chain is found', () => {
    expect(hasAttachment(chain(500, pdf))).toBe(true);
  });

  it('an attachment near the top of a 5,000-deep structure is found', () => {
    const deep = chain(5000, { type: 'text/plain' });
    expect(hasAttachment({ type: 'multipart/mixed', childNodes: [pdf, deep] })).toBe(true);
  });
});
