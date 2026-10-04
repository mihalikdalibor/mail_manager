import { describe, it, expect } from 'vitest';
import type { MailboxLockObject } from 'imapflow';
import type { FetchedMessage, ImapClientLike } from '../../src/core/imap/session.js';
import * as folders from '../../src/core/mailbox/folders.js';
import { SIZE_BATCH, scanFolder, sizeRanges } from '../../src/core/mailbox/scan.js';
import type { ScanRange } from '../../src/core/mailbox/scan.js';

// M2c-1 scan helper: one read-only, streaming pass over a folder in sequence ranges.

const CANARY = 'CANARY-server-text imap.secret-host.example';
const STATS = { envelope: true, internalDate: true, size: true } as const;

interface FakeOptions {
  /** `client.mailbox` after the lock; default `{ exists }`. */
  mailbox?: { exists: unknown } | false;
  exists?: number;
  lockThrows?: boolean;
  /** Throws when the range starting at this sequence number is fetched (after `yieldFirst`). */
  fetchThrowsAt?: number;
  /** Messages yielded from the failing range before it throws. */
  yieldFirst?: number;
}

interface Calls {
  lock: { path: string; options: unknown }[];
  release: string[];
  fetch: { range: string; query: unknown }[];
  /** Order of events: `fetch 1:5`, `msg 3`, `release`. */
  log: string[];
}

function fake(opts: FakeOptions = {}): { session: { client: ImapClientLike }; calls: Calls } {
  const calls: Calls = { lock: [], release: [], fetch: [], log: [] };
  const exists = opts.exists ?? 0;
  let mailbox: { exists: unknown } | false = false;
  const client = {
    get mailbox() {
      return mailbox;
    },
    getMailboxLock(path: string, options?: unknown): Promise<MailboxLockObject> {
      calls.lock.push({ path, options });
      if (opts.lockThrows === true) return Promise.reject(new Error(CANARY));
      mailbox = opts.mailbox ?? { exists };
      return Promise.resolve({
        path,
        release: () => {
          calls.release.push(path);
          calls.log.push('release');
        },
      });
    },
    fetch(range: string, query: unknown): AsyncIterable<FetchedMessage> {
      calls.fetch.push({ range, query });
      calls.log.push(`fetch ${range}`);
      return {
        async *[Symbol.asyncIterator]() {
          await Promise.resolve();
          const [from = 1, to = 0] = range.split(':').map(Number);
          for (let seq = from; seq <= to; seq++) {
            if (from === opts.fetchThrowsAt && seq - from === (opts.yieldFirst ?? 0)) {
              throw new Error(CANARY);
            }
            calls.log.push(`yield ${seq}`);
            yield { seq, size: seq * 10 };
          }
        },
      };
    },
  };
  return { session: { client: client as unknown as ImapClientLike }, calls };
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
}

describe('sizeRanges / SIZE_BATCH', () => {
  it('SIZE_BATCH is 5,000 and folders.ts re-exports the same helpers', () => {
    expect(SIZE_BATCH).toBe(5000);
    expect(folders.SIZE_BATCH).toBe(SIZE_BATCH);
    expect(folders.sizeRanges).toBe(sizeRanges);
  });

  it.each<[number, string[]]>([
    [0, []],
    [-1, []],
    [1.5, []],
    [NaN, []],
    [1, ['1:1']],
    [5000, ['1:5000']],
    [5001, ['1:5000', '5001:5001']],
    [12345, ['1:5000', '5001:10000', '10001:12345']],
  ])('sizeRanges(%d)', (exists, ranges) => {
    expect(sizeRanges(exists)).toEqual(ranges);
  });

  it.each([0, -5, 2.5, NaN])('an invalid batch size %d falls back to 5,000', (batch) => {
    expect(sizeRanges(5001, batch)).toEqual(['1:5000', '5001:5001']);
  });
});

describe('scanFolder', () => {
  it('EXAMINEs the folder (read-only lock), fetches the ranges in order, releases the lock', async () => {
    const { session, calls } = fake({ exists: 12 });
    const seen: number[] = [];
    const result = await scanFolder(session, 'INBOX/Sub', STATS, (m) => seen.push(m.seq ?? 0), {
      batchSize: 5,
    });
    expect(result).toEqual({ exists: 12, read: 12 });
    expect(calls.lock).toEqual([{ path: 'INBOX/Sub', options: { readOnly: true } }]);
    expect(calls.fetch).toEqual([
      { range: '1:5', query: STATS },
      { range: '6:10', query: STATS },
      { range: '11:12', query: STATS },
    ]);
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(calls.release).toEqual(['INBOX/Sub']);
  });

  it('passes the query through unchanged (the size-only query of M2a)', async () => {
    const { session, calls } = fake({ exists: 3 });
    await scanFolder(session, 'INBOX', { size: true }, () => undefined);
    expect(calls.fetch).toEqual([{ range: '1:3', query: { size: true } }]);
  });

  it('defaults to batches of 5,000', async () => {
    const { session, calls } = fake({ exists: 10_001 });
    const result = await scanFolder(session, 'INBOX', STATS, () => undefined);
    expect(calls.fetch.map((c) => c.range)).toEqual(['1:5000', '5001:10000', '10001:10001']);
    expect(result).toEqual({ exists: 10_001, read: 10_001 });
  });

  it('gives each message the range it was fetched in', async () => {
    const { session } = fake({ exists: 7 });
    const got: [number, ScanRange][] = [];
    await scanFolder(session, 'INBOX', STATS, (m, r) => got.push([m.seq ?? 0, { ...r }]), {
      batchSize: 3,
    });
    expect(got).toEqual([
      [1, { from: 1, to: 3 }],
      [2, { from: 1, to: 3 }],
      [3, { from: 1, to: 3 }],
      [4, { from: 4, to: 6 }],
      [5, { from: 4, to: 6 }],
      [6, { from: 4, to: 6 }],
      [7, { from: 7, to: 7 }],
    ]);
  });

  it('streams: each message reaches onMessage before the next is fetched', async () => {
    const { session, calls } = fake({ exists: 4 });
    await scanFolder(session, 'INBOX', STATS, (m) => calls.log.push(`msg ${m.seq ?? 0}`), {
      batchSize: 2,
    });
    expect(calls.log).toEqual([
      'fetch 1:2',
      'yield 1',
      'msg 1',
      'yield 2',
      'msg 2',
      'fetch 3:4',
      'yield 3',
      'msg 3',
      'yield 4',
      'msg 4',
      'release',
    ]);
  });

  it('reports progress once per range: messages read so far, of the folder count', async () => {
    const { session } = fake({ exists: 12 });
    const progress: [number, number][] = [];
    await scanFolder(session, 'INBOX', STATS, () => undefined, {
      batchSize: 5,
      onProgress: (done, total) => progress.push([done, total]),
    });
    expect(progress).toEqual([
      [5, 12],
      [10, 12],
      [12, 12],
    ]);
  });

  it('a throwing onProgress is swallowed: the scan goes on', async () => {
    const { session, calls } = fake({ exists: 6 });
    let n = 0;
    const result = await scanFolder(session, 'INBOX', STATS, () => n++, {
      batchSize: 2,
      onProgress: () => {
        throw new Error('render failed');
      },
    });
    expect(result).toEqual({ exists: 6, read: 6 });
    expect(n).toBe(6);
    expect(calls.fetch).toHaveLength(3);
    expect(calls.release).toEqual(['INBOX']);
  });

  it('an empty folder fetches nothing and reports no progress', async () => {
    const { session, calls } = fake({ exists: 0 });
    const progress: number[] = [];
    const result = await scanFolder(session, 'INBOX', STATS, () => undefined, {
      onProgress: (done) => progress.push(done),
    });
    expect(result).toEqual({ exists: 0, read: 0 });
    expect(calls.fetch).toEqual([]);
    expect(progress).toEqual([]);
    expect(calls.release).toEqual(['INBOX']);
  });

  it.each<[string, { exists: unknown } | false]>([
    ['mailbox === false', false],
    ['a negative count', { exists: -3 }],
    ['a fractional count', { exists: 2.5 }],
    ['a string count', { exists: '12' }],
    ['a missing count', { exists: undefined }],
  ])('%s → 0 messages, nothing fetched', async (_, mailbox) => {
    const { session, calls } = fake({ mailbox });
    const result = await scanFolder(session, 'INBOX', STATS, () => undefined);
    expect(result).toEqual({ exists: 0, read: 0 });
    expect(calls.fetch).toEqual([]);
    expect(calls.release).toEqual(['INBOX']);
  });

  it('a refused lock propagates and fetches nothing (no lock to release)', async () => {
    const { session, calls } = fake({ exists: 3, lockThrows: true });
    const err = await rejection(scanFolder(session, 'INBOX', STATS, () => undefined));
    expect((err as Error).message).toBe(CANARY);
    expect(calls.fetch).toEqual([]);
    expect(calls.release).toEqual([]);
  });

  it('a FETCH error propagates unchanged after the messages before it; the lock is released', async () => {
    const { session, calls } = fake({ exists: 10, fetchThrowsAt: 6, yieldFirst: 2 });
    const seen: number[] = [];
    const progress: number[] = [];
    const err = await rejection(
      scanFolder(session, 'INBOX', STATS, (m) => seen.push(m.seq ?? 0), {
        batchSize: 5,
        onProgress: (done) => progress.push(done),
      }),
    );
    expect((err as Error).message).toBe(CANARY);
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(progress).toEqual([5]);
    expect(calls.fetch.map((c) => c.range)).toEqual(['1:5', '6:10']);
    expect(calls.release).toEqual(['INBOX']);
  });

  it('an onMessage error propagates unchanged and stops the scan; the lock is released', async () => {
    const { session, calls } = fake({ exists: 10 });
    const bug = new TypeError('aggregator bug');
    const err = await rejection(
      scanFolder(
        session,
        'INBOX',
        STATS,
        (m) => {
          if (m.seq === 3) throw bug;
        },
        { batchSize: 5 },
      ),
    );
    expect(err).toBe(bug);
    expect(calls.fetch.map((c) => c.range)).toEqual(['1:5']);
    expect(calls.release).toEqual(['INBOX']);
  });
});
