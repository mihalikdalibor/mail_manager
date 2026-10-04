import { describe, it, expect } from 'vitest';
import type { FetchOptions, MailboxLockObject } from 'imapflow';
import type { ServerFeatures } from '../../src/core/imap/features.js';
import type { FetchedMessage, ImapClientLike } from '../../src/core/imap/session.js';
import { MAILBOX_ERROR_CODES, MailboxError } from '../../src/core/mailbox/errors.js';
import type {
  FolderInfo,
  FolderRole,
  FolderSession,
  FolderTree,
  RoleSource,
  SizeProgress,
} from '../../src/core/mailbox/folders.js';
import {
  STATS_MAX_KEYS,
  STATS_QUERY,
  STATS_TOP_N,
  collectStats,
  createStatsAggregator,
  statsScope,
} from '../../src/core/mailbox/stats.js';
import type { MailboxStats, StatsAggregator } from '../../src/core/mailbox/stats.js';

// M2c-1 stats core (spec): the aggregator (pure), statsScope (pure) and collectStats over a fake
// IMAP client. Years are always checked with an explicit time zone, never the machine's.

const BOOM = new Error('boom from the aggregator path');

// --- helpers --------------------------------------------------------------------------------

type Envelope = NonNullable<FetchedMessage['envelope']>;
interface Address {
  name?: string;
  address?: string;
}

function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('expected a value');
  return value;
}

function envelope(from: Address[] | undefined, subject?: string): Envelope {
  return {
    ...(from !== undefined && { from }),
    ...(subject !== undefined && { subject }),
  };
}

interface MailSpec {
  size?: number | string | undefined;
  date?: Date | string | undefined;
  from?: Address[] | undefined;
  address?: string;
  name?: string;
  subject?: string;
  seq?: number;
}

/** A message the way the stats fetch returns it. `address` / `name` are a one-entry `from`. */
function mail(o: MailSpec = {}): FetchedMessage {
  const from =
    o.from ??
    (o.address !== undefined || o.name !== undefined
      ? [
          {
            ...(o.address !== undefined && { address: o.address }),
            ...(o.name !== undefined && { name: o.name }),
          },
        ]
      : undefined);
  return {
    ...(o.seq !== undefined && { seq: o.seq }),
    ...(o.size !== undefined && { size: o.size as number }),
    ...(o.date !== undefined && { internalDate: o.date }),
    envelope: envelope(from, o.subject),
  };
}

function utc(iso: string): Date {
  return new Date(iso);
}

function agg(opts: { timeZone?: string; maxKeys?: number; topN?: number } = {}): StatsAggregator {
  return createStatsAggregator({ timeZone: 'UTC', ...opts });
}

/** One folder `path` with the given messages. */
function feed(a: StatsAggregator, path: string, mails: FetchedMessage[]): void {
  a.startFolder(path);
  for (const m of mails) a.add(m);
}

function folderOf(stats: MailboxStats, path: string): MailboxStats['folders'][number] {
  return must(stats.folders.find((f) => f.path === path));
}

// --- aggregator: folders, totals ------------------------------------------------------------

describe('aggregator: folder rows and totals', () => {
  it('an aggregator with no folder yields zero everything', () => {
    const s = agg().result();
    expect(s.folders).toEqual([]);
    expect(s.totals).toEqual({ messages: 0, bytes: 0 });
    expect(s.years).toEqual([]);
    expect(s.senders).toEqual({ byCount: [], bySize: [], others: { messages: 0, bytes: 0 } });
    expect(s.domains).toEqual({ byCount: [], bySize: [], others: { messages: 0, bytes: 0 } });
    expect(s.largest).toEqual([]);
    expect(s.approximate).toBe(false);
    expect(s.unreadable).toBe(0);
    expect(s.partial).toBe(0);
    expect(s.notScanned).toBe(0);
  });

  it('startFolder opens an empty row: 0 messages, 0 bytes, not partial', () => {
    const a = agg();
    a.startFolder('INBOX');
    const s = a.result();
    expect(s.folders).toEqual([{ path: 'INBOX', messages: 0, bytes: 0, partial: false }]);
    expect(s.totals).toEqual({ messages: 0, bytes: 0 });
  });

  it('add counts into the current folder and into the totals, rows in call order', () => {
    const a = agg();
    feed(a, 'INBOX', [mail({ size: 100 }), mail({ size: 250 })]);
    feed(a, 'Sent', [mail({ size: 7 })]);
    const s = a.result();
    expect(s.folders).toEqual([
      { path: 'INBOX', messages: 2, bytes: 350, partial: false },
      { path: 'Sent', messages: 1, bytes: 7, partial: false },
    ]);
    expect(s.totals).toEqual({ messages: 3, bytes: 357 });
  });

  it('add before startFolder throws an Error', () => {
    expect(() => {
      agg().add(mail({ size: 1 }));
    }).toThrow(Error);
  });

  it('folderFailed before startFolder throws an Error', () => {
    expect(() => {
      agg().folderFailed();
    }).toThrow(Error);
  });

  it('a message without size counts 1 message and 0 bytes and never enters largest', () => {
    const a = agg();
    feed(a, 'INBOX', [mail({ subject: 'no size' }), mail({ size: 10, subject: 'sized' })]);
    const s = a.result();
    expect(s.totals).toEqual({ messages: 2, bytes: 10 });
    expect(s.largest.map((l) => l.subject)).toEqual(['sized']);
  });

  it.each<[string, number | string]>([
    ['negative', -5],
    ['NaN', Number.NaN],
    ['a string', '1234'],
    ['a fraction', 1.5],
  ])('an invalid size (%s) counts as 0 bytes and stays out of largest', (_name, size) => {
    const a = agg();
    feed(a, 'INBOX', [mail({ size, subject: 'bad size' })]);
    const s = a.result();
    expect(s.totals).toEqual({ messages: 1, bytes: 0 });
    expect(s.largest).toEqual([]);
  });
});

describe('aggregator: failed folders', () => {
  it('folderFailed with nothing counted: the row becomes unreadable (null, null)', () => {
    const a = agg();
    a.startFolder('Broken');
    a.folderFailed();
    const s = a.result();
    expect(s.folders).toEqual([{ path: 'Broken', messages: null, bytes: null, partial: false }]);
    expect(s.unreadable).toBe(1);
    expect(s.partial).toBe(0);
    expect(s.totals).toEqual({ messages: 0, bytes: 0 });
  });

  it('folderFailed after some messages: partial, counts kept, still in the totals', () => {
    const a = agg();
    feed(a, 'INBOX', [mail({ size: 10 })]);
    feed(a, 'Cut', [mail({ size: 100 }), mail({ size: 200 })]);
    a.folderFailed();
    const s = a.result();
    expect(folderOf(s, 'Cut')).toEqual({ path: 'Cut', messages: 2, bytes: 300, partial: true });
    expect(s.partial).toBe(1);
    expect(s.unreadable).toBe(0);
    expect(s.totals).toEqual({ messages: 3, bytes: 310 });
  });

  it('a failed folder does not stop the next one from counting', () => {
    const a = agg();
    a.startFolder('Broken');
    a.folderFailed();
    feed(a, 'Fine', [mail({ size: 5 })]);
    const s = a.result();
    expect(s.folders.map((f) => [f.path, f.messages, f.partial])).toEqual([
      ['Broken', null, false],
      ['Fine', 1, false],
    ]);
    expect(s.unreadable).toBe(1);
    expect(s.totals).toEqual({ messages: 1, bytes: 5 });
  });

  it('a partial folder keeps what it counted in years, senders and largest', () => {
    const a = agg();
    feed(a, 'Cut', [mail({ size: 40, date: utc('2024-06-15T12:00:00Z'), address: 'a@x.com' })]);
    a.folderFailed();
    const s = a.result();
    expect(s.years).toEqual([{ year: '2024', messages: 1, bytes: 40 }]);
    expect(s.senders.byCount).toEqual([{ key: 'a@x.com', messages: 1, bytes: 40 }]);
    expect(s.largest).toHaveLength(1);
  });

  it('unreadable and partial are counted per row, several of each', () => {
    const a = agg();
    a.startFolder('U1');
    a.folderFailed();
    a.startFolder('U2');
    a.folderFailed();
    feed(a, 'P1', [mail({ size: 1 })]);
    a.folderFailed();
    const s = a.result();
    expect(s.unreadable).toBe(2);
    expect(s.partial).toBe(1);
  });
});

// --- aggregator: per year -------------------------------------------------------------------

describe('aggregator: per year', () => {
  it('the year follows the given time zone around New Year (UTC vs Pacific/Kiritimati)', () => {
    const date = utc('2023-12-31T23:30:00Z');
    const inUtc = agg({ timeZone: 'UTC' });
    feed(inUtc, 'INBOX', [mail({ size: 1, date })]);
    expect(inUtc.result().years).toEqual([{ year: '2023', messages: 1, bytes: 1 }]);

    const kiritimati = agg({ timeZone: 'Pacific/Kiritimati' }); // UTC+14: already 2024
    feed(kiritimati, 'INBOX', [mail({ size: 1, date })]);
    expect(kiritimati.result().years).toEqual([{ year: '2024', messages: 1, bytes: 1 }]);
  });

  it('a zone behind UTC moves an early-January UTC date back into the old year', () => {
    const a = agg({ timeZone: 'America/Los_Angeles' });
    feed(a, 'INBOX', [mail({ size: 1, date: utc('2024-01-01T03:00:00Z') })]);
    expect(a.result().years.map((y) => y.year)).toEqual(['2023']);
  });

  it('an ISO string date is parsed like a Date', () => {
    const a = agg();
    feed(a, 'INBOX', [mail({ size: 3, date: '2022-06-15T10:00:00Z' })]);
    expect(a.result().years).toEqual([{ year: '2022', messages: 1, bytes: 3 }]);
  });

  it('rows are summed per year and sorted ascending, "unknown" last', () => {
    const a = agg();
    feed(a, 'INBOX', [
      mail({ size: 1 }), // unknown first
      mail({ size: 10, date: utc('2024-03-01T12:00:00Z') }),
      mail({ size: 20, date: utc('2021-03-01T12:00:00Z') }),
      mail({ size: 30, date: utc('2024-09-01T12:00:00Z') }),
      mail({ size: 40, date: utc('2019-03-01T12:00:00Z') }),
    ]);
    expect(a.result().years).toEqual([
      { year: '2019', messages: 1, bytes: 40 },
      { year: '2021', messages: 1, bytes: 20 },
      { year: '2024', messages: 2, bytes: 40 },
      { year: 'unknown', messages: 1, bytes: 1 },
    ]);
  });

  it.each<[string, Date | string | undefined]>([
    ['missing', undefined],
    ['an unparseable string', 'not a date'],
    ['an invalid Date', new Date(Number.NaN)],
    ['year 1899', utc('1899-06-15T12:00:00Z')],
    ['year 2201', utc('2201-06-15T12:00:00Z')],
  ])('an internalDate that is %s → year "unknown"', (_name, date) => {
    const a = agg();
    feed(a, 'INBOX', [mail({ size: 9, date })]);
    expect(a.result().years).toEqual([{ year: 'unknown', messages: 1, bytes: 9 }]);
  });

  it('the year bounds 1900 and 2200 are still years', () => {
    const a = agg();
    feed(a, 'INBOX', [
      mail({ size: 1, date: utc('1900-06-15T12:00:00Z') }),
      mail({ size: 1, date: utc('2200-06-15T12:00:00Z') }),
    ]);
    expect(a.result().years.map((y) => y.year)).toEqual(['1900', '2200']);
  });

  it('an invalid time zone falls back to UTC instead of throwing', () => {
    const a = agg({ timeZone: 'Not/AZone' });
    feed(a, 'INBOX', [mail({ size: 1, date: utc('2023-12-31T23:30:00Z') })]);
    expect(a.result().years).toEqual([{ year: '2023', messages: 1, bytes: 1 }]);
  });

  it('years count messages without size too', () => {
    const a = agg();
    feed(a, 'INBOX', [mail({ date: utc('2020-06-15T12:00:00Z') })]);
    expect(a.result().years).toEqual([{ year: '2020', messages: 1, bytes: 0 }]);
  });
});

// --- aggregator: senders and domains --------------------------------------------------------

describe('aggregator: sender and domain keys', () => {
  it('upper-case and padded address variants are one lower-cased key', () => {
    const a = agg();
    feed(a, 'INBOX', [
      mail({ size: 1, address: 'Alice@Example.COM' }),
      mail({ size: 2, address: '  alice@example.com ' }),
      mail({ size: 4, address: 'ALICE@EXAMPLE.COM' }),
    ]);
    const s = a.result();
    expect(s.senders.byCount).toEqual([{ key: 'alice@example.com', messages: 3, bytes: 7 }]);
    expect(s.domains.byCount).toEqual([{ key: 'example.com', messages: 3, bytes: 7 }]);
  });

  it('the domain is the part after the last @; several senders add up per domain', () => {
    const a = agg();
    feed(a, 'INBOX', [
      mail({ size: 10, address: 'a@shop.example' }),
      mail({ size: 20, address: 'b@shop.example' }),
      mail({ size: 5, address: 'odd@name@host.example' }),
    ]);
    const s = a.result();
    expect(s.domains.byCount).toEqual([
      { key: 'shop.example', messages: 2, bytes: 30 },
      { key: 'host.example', messages: 1, bytes: 5 },
    ]);
    expect(s.senders.byCount.map((r) => r.key)).toContain('odd@name@host.example');
  });

  it('only the first From entry is used', () => {
    const a = agg();
    feed(a, 'INBOX', [
      mail({ size: 1, from: [{ address: 'first@x.com' }, { address: 'second@y.com' }] }),
    ]);
    const s = a.result();
    expect(s.senders.byCount.map((r) => r.key)).toEqual(['first@x.com']);
    expect(s.domains.byCount.map((r) => r.key)).toEqual(['x.com']);
  });

  it.each<[string, MailSpec]>([
    ['no envelope from', {}],
    ['an empty from list', { from: [] }],
    ['a first entry without an address', { from: [{ name: 'Only A Name' }] }],
    ['an empty address', { from: [{ address: '' }] }],
    ['a blank address', { from: [{ address: '   ' }] }],
  ])('%s → sender and domain key null', (_name, spec) => {
    const a = agg();
    feed(a, 'INBOX', [mail({ size: 8, ...spec })]);
    const s = a.result();
    expect(s.senders.byCount).toEqual([{ key: null, messages: 1, bytes: 8 }]);
    expect(s.domains.byCount).toEqual([{ key: null, messages: 1, bytes: 8 }]);
  });

  it('a message with no envelope at all counts under the null key', () => {
    const a = agg();
    a.startFolder('INBOX');
    a.add({ size: 12 });
    const s = a.result();
    expect(s.totals).toEqual({ messages: 1, bytes: 12 });
    expect(s.senders.byCount).toEqual([{ key: null, messages: 1, bytes: 12 }]);
  });

  it('an address without @ keeps its sender key, domain null', () => {
    const a = agg();
    feed(a, 'INBOX', [mail({ size: 3, address: 'postmaster' })]);
    const s = a.result();
    expect(s.senders.byCount).toEqual([{ key: 'postmaster', messages: 1, bytes: 3 }]);
    expect(s.domains.byCount).toEqual([{ key: null, messages: 1, bytes: 3 }]);
  });

  it('an address ending in @ keeps its sender key, domain null', () => {
    const a = agg();
    feed(a, 'INBOX', [mail({ size: 3, address: 'someone@' })]);
    const s = a.result();
    expect(s.senders.byCount).toEqual([{ key: 'someone@', messages: 1, bytes: 3 }]);
    expect(s.domains.byCount).toEqual([{ key: null, messages: 1, bytes: 3 }]);
  });

  it('a sender key is capped at 320 code points (the cap applies before the domain is cut)', () => {
    const a = agg();
    feed(a, 'INBOX', [mail({ size: 1, address: `${'a'.repeat(400)}@long.example` })]);
    const s = a.result();
    const key = must(must(s.senders.byCount[0]).key);
    expect([...key]).toHaveLength(320);
    expect(key).toBe('a'.repeat(320));
    expect(s.domains.byCount).toEqual([{ key: null, messages: 1, bytes: 1 }]);
  });

  it('the sender cap counts code points, not UTF-16 units', () => {
    const a = agg();
    feed(a, 'INBOX', [mail({ size: 1, address: `${'😀'.repeat(400)}@x.example` })]);
    const key = must(must(a.result().senders.byCount[0]).key);
    expect([...key]).toHaveLength(320);
  });
});

describe('aggregator: top lists', () => {
  it('byCount and bySize rank differently, rows are { key, messages, bytes }', () => {
    const a = agg();
    feed(a, 'INBOX', [
      mail({ size: 1, address: 'many@x.com' }),
      mail({ size: 1, address: 'many@x.com' }),
      mail({ size: 1, address: 'many@x.com' }),
      mail({ size: 1000, address: 'big@y.com' }),
    ]);
    const s = a.result();
    expect(s.senders.byCount).toEqual([
      { key: 'many@x.com', messages: 3, bytes: 3 },
      { key: 'big@y.com', messages: 1, bytes: 1000 },
    ]);
    expect(s.senders.bySize).toEqual([
      { key: 'big@y.com', messages: 1, bytes: 1000 },
      { key: 'many@x.com', messages: 3, bytes: 3 },
    ]);
    expect(s.domains.byCount.map((r) => r.key)).toEqual(['x.com', 'y.com']);
    expect(s.domains.bySize.map((r) => r.key)).toEqual(['y.com', 'x.com']);
  });

  it('ties are broken by key ascending, the null key last', () => {
    const a = agg();
    feed(a, 'INBOX', [
      mail({ size: 5, address: 'b@x.com' }),
      mail({ size: 5 }), // null sender
      mail({ size: 5, address: 'c@x.com' }),
      mail({ size: 5, address: 'a@x.com' }),
    ]);
    const s = a.result();
    const expected = ['a@x.com', 'b@x.com', 'c@x.com', null];
    expect(s.senders.byCount.map((r) => r.key)).toEqual(expected);
    expect(s.senders.bySize.map((r) => r.key)).toEqual(expected);
  });

  it('every list holds at most topN rows (default 10, STATS_TOP_N)', () => {
    expect(STATS_TOP_N).toBe(10);
    const a = agg();
    feed(
      a,
      'INBOX',
      Array.from({ length: 15 }, (_v, i) => mail({ size: i + 1, address: `s${i}@d${i}.example` })),
    );
    const s = a.result();
    for (const list of [s.senders.byCount, s.senders.bySize, s.domains.byCount, s.domains.bySize]) {
      expect(list).toHaveLength(10);
    }
    // Best by size first: the last ones fed are the largest.
    expect(s.senders.bySize.map((r) => r.bytes)).toEqual([15, 14, 13, 12, 11, 10, 9, 8, 7, 6]);
  });

  it('topN is configurable and applies to the lists and to largest', () => {
    const a = agg({ topN: 2 });
    feed(
      a,
      'INBOX',
      Array.from({ length: 5 }, (_v, i) => mail({ size: i + 1, address: `s${i}@d${i}.example` })),
    );
    const s = a.result();
    expect(s.senders.byCount).toHaveLength(2);
    expect(s.senders.bySize.map((r) => r.bytes)).toEqual([5, 4]);
    expect(s.domains.bySize).toHaveLength(2);
    expect(s.largest.map((l) => l.bytes)).toEqual([5, 4]);
  });

  it('the null key is a normal row in the lists, counted in full', () => {
    const a = agg();
    feed(a, 'INBOX', [mail({ size: 4 }), mail({ size: 6 }), mail({ size: 1, address: 'a@x.com' })]);
    const s = a.result();
    expect(s.senders.byCount[0]).toEqual({ key: null, messages: 2, bytes: 10 });
    expect(s.senders.bySize[0]).toEqual({ key: null, messages: 2, bytes: 10 });
  });
});

describe('aggregator: key cap (maxKeys)', () => {
  it('the default cap is 50,000 keys', () => {
    expect(STATS_MAX_KEYS).toBe(50_000);
  });

  it('senders beyond maxKeys go to others and the stats are approximate', () => {
    const a = agg({ maxKeys: 3 });
    feed(
      a,
      'INBOX',
      Array.from({ length: 5 }, (_v, i) => mail({ size: 10, address: `s${i}@d${i}.example` })),
    );
    const s = a.result();
    expect(s.senders.byCount.map((r) => r.key).sort()).toEqual([
      's0@d0.example',
      's1@d1.example',
      's2@d2.example',
    ]);
    expect(s.senders.others).toEqual({ messages: 2, bytes: 20 });
    expect(s.domains.others).toEqual({ messages: 2, bytes: 20 });
    expect(s.approximate).toBe(true);
    expect(s.totals).toEqual({ messages: 5, bytes: 50 });
  });

  it('a key already admitted keeps counting after the cap is reached', () => {
    const a = agg({ maxKeys: 2 });
    feed(a, 'INBOX', [
      mail({ size: 1, address: 'a@x.com' }),
      mail({ size: 1, address: 'b@y.com' }),
      mail({ size: 1, address: 'c@z.com' }), // over the cap
      mail({ size: 100, address: 'a@x.com' }), // known: counted
    ]);
    const s = a.result();
    expect(s.senders.byCount).toEqual([
      { key: 'a@x.com', messages: 2, bytes: 101 },
      { key: 'b@y.com', messages: 1, bytes: 1 },
    ]);
    expect(s.senders.others).toEqual({ messages: 1, bytes: 1 });
  });

  it('exactly maxKeys distinct keys is not an overflow', () => {
    const a = agg({ maxKeys: 3 });
    feed(
      a,
      'INBOX',
      Array.from({ length: 3 }, (_v, i) => mail({ size: 1, address: `s${i}@d${i}.example` })),
    );
    const s = a.result();
    expect(s.approximate).toBe(false);
    expect(s.senders.others).toEqual({ messages: 0, bytes: 0 });
    expect(s.domains.others).toEqual({ messages: 0, bytes: 0 });
  });

  it('senders and domains are capped separately', () => {
    const a = agg({ maxKeys: 3 });
    // 5 distinct senders on 2 domains: the sender map overflows, the domain map does not.
    feed(
      a,
      'INBOX',
      Array.from({ length: 5 }, (_v, i) =>
        mail({ size: 10, address: `s${i}@${i % 2 === 0 ? 'even' : 'odd'}.example` }),
      ),
    );
    const s = a.result();
    expect(s.senders.others).toEqual({ messages: 2, bytes: 20 });
    expect(s.domains.others).toEqual({ messages: 0, bytes: 0 });
    expect(s.domains.byCount.map((r) => [r.key, r.messages])).toEqual([
      ['even.example', 3],
      ['odd.example', 2],
    ]);
    expect(s.approximate).toBe(true);
  });

  it('the null key is always counted and does not use up maxKeys', () => {
    const a = agg({ maxKeys: 3 });
    feed(a, 'INBOX', [
      mail({ size: 1 }),
      mail({ size: 1 }),
      mail({ size: 1 }),
      mail({ size: 1 }),
      mail({ size: 1, address: 'a@a.example' }),
      mail({ size: 1, address: 'b@b.example' }),
      mail({ size: 1, address: 'c@c.example' }),
    ]);
    const s = a.result();
    expect(s.senders.others).toEqual({ messages: 0, bytes: 0 });
    expect(s.approximate).toBe(false);
    expect(s.senders.byCount.find((r) => r.key === null)).toEqual({
      key: null,
      messages: 4,
      bytes: 4,
    });
    expect(s.senders.byCount.filter((r) => r.key !== null)).toHaveLength(3);
  });

  it('a null key arriving after the cap is full is still counted, not moved to others', () => {
    const a = agg({ maxKeys: 1 });
    feed(a, 'INBOX', [
      mail({ size: 1, address: 'a@a.example' }),
      mail({ size: 1, address: 'b@b.example' }), // others
      mail({ size: 7 }), // null
    ]);
    const s = a.result();
    expect(s.senders.others).toEqual({ messages: 1, bytes: 1 });
    expect(s.senders.byCount.find((r) => r.key === null)).toEqual({
      key: null,
      messages: 1,
      bytes: 7,
    });
  });

  it(
    'memory stand-in: 100,000 distinct senders with maxKeys 3 keep every list bounded',
    { timeout: 60_000 },
    () => {
      const a = agg({ maxKeys: 3 });
      a.startFolder('INBOX');
      for (let i = 0; i < 100_000; i++) {
        a.add(mail({ size: (i % 1000) + 1, address: `u${i}@d${i}.example`, subject: `s${i}` }));
      }
      const s = a.result();
      expect(s.totals.messages).toBe(100_000);
      expect(s.senders.others.messages).toBe(99_997);
      expect(s.domains.others.messages).toBe(99_997);
      expect(s.approximate).toBe(true);
      for (const list of [
        s.senders.byCount,
        s.senders.bySize,
        s.domains.byCount,
        s.domains.bySize,
      ]) {
        expect(list.length).toBeLessThanOrEqual(STATS_TOP_N);
      }
      expect(s.largest.length).toBeLessThanOrEqual(STATS_TOP_N);
      expect(s.largest).toHaveLength(STATS_TOP_N);
      expect(s.largest.every((l) => l.bytes === 1000)).toBe(true);
    },
  );
});

// --- aggregator: largest --------------------------------------------------------------------

describe('aggregator: largest mails', () => {
  it('keeps the topN largest by bytes descending, with folder, date, from and subject', () => {
    const a = agg({ topN: 3 });
    a.startFolder('INBOX');
    a.add(
      mail({ size: 10, subject: 'ten', address: 'a@x.com', date: utc('2024-06-15T12:00:00Z') }),
    );
    a.startFolder('Archive');
    a.add(mail({ size: 500, subject: 'five hundred', name: 'Big Sender', address: 'big@x.com' }));
    a.add(mail({ size: 300, subject: 'three hundred', address: 'c@x.com' }));
    a.add(mail({ size: 400, subject: 'four hundred', address: 'd@x.com' }));
    const s = a.result();
    expect(s.largest).toEqual([
      {
        folder: 'Archive',
        received: null,
        from: 'Big Sender',
        subject: 'five hundred',
        bytes: 500,
      },
      { folder: 'Archive', received: null, from: 'd@x.com', subject: 'four hundred', bytes: 400 },
      { folder: 'Archive', received: null, from: 'c@x.com', subject: 'three hundred', bytes: 300 },
    ]);
  });

  it('received is the internalDate as a Date (also from an ISO string), null when invalid', () => {
    const a = agg();
    feed(a, 'INBOX', [
      mail({ size: 30, date: utc('2024-06-15T12:00:00Z') }),
      mail({ size: 20, date: '2023-02-03T04:05:06Z' }),
      mail({ size: 10, date: 'garbage' }),
    ]);
    const received = a.result().largest.map((l) => l.received);
    expect(received[0]).toEqual(utc('2024-06-15T12:00:00Z'));
    expect(received[1]).toEqual(utc('2023-02-03T04:05:06Z'));
    expect(received[2]).toBeNull();
  });

  it("from is the first entry's name, else its address, else null", () => {
    const a = agg();
    feed(a, 'INBOX', [
      mail({ size: 40, name: 'Alice', address: 'alice@x.com' }),
      mail({ size: 30, address: 'bob@x.com' }),
      mail({ size: 20, from: [{ name: '', address: 'empty-name@x.com' }] }),
      mail({ size: 10 }),
    ]);
    expect(a.result().largest.map((l) => l.from)).toEqual([
      'Alice',
      'bob@x.com',
      'empty-name@x.com',
      null,
    ]);
  });

  it('a missing subject is null', () => {
    const a = agg();
    feed(a, 'INBOX', [mail({ size: 1, address: 'a@x.com' })]);
    expect(must(a.result().largest[0]).subject).toBeNull();
  });

  it('from and subject are cut at 500 code points', () => {
    const a = agg();
    feed(a, 'INBOX', [
      mail({ size: 1, name: '😀'.repeat(600), subject: 'x'.repeat(10_000) }),
      mail({ size: 1, name: 'n'.repeat(500), subject: '😀'.repeat(500) }),
    ]);
    const [cut, exact] = a.result().largest;
    expect([...must(must(cut).from)]).toHaveLength(500);
    expect([...must(must(cut).subject)]).toHaveLength(500);
    expect(must(exact).from).toBe('n'.repeat(500));
    expect(must(exact).subject).toBe('😀'.repeat(500));
  });

  it('ties keep the first seen: a later equal mail does not evict an earlier one', () => {
    const a = agg({ topN: 2 });
    feed(a, 'INBOX', [
      mail({ size: 5, subject: 'A' }),
      mail({ size: 5, subject: 'B' }),
      mail({ size: 5, subject: 'C' }),
    ]);
    expect(a.result().largest.map((l) => l.subject)).toEqual(['A', 'B']);
  });

  it('equal sizes are listed in the order they were seen', () => {
    const a = agg();
    feed(a, 'INBOX', [
      mail({ size: 1, subject: 'small' }),
      mail({ size: 9, subject: 'first nine' }),
      mail({ size: 9, subject: 'second nine' }),
    ]);
    expect(a.result().largest.map((l) => l.subject)).toEqual([
      'first nine',
      'second nine',
      'small',
    ]);
  });

  it('a larger later mail evicts the smallest of a full list', () => {
    const a = agg({ topN: 2 });
    feed(a, 'INBOX', [
      mail({ size: 1, subject: 'one' }),
      mail({ size: 2, subject: 'two' }),
      mail({ size: 3, subject: 'three' }),
    ]);
    expect(a.result().largest.map((l) => l.subject)).toEqual(['three', 'two']);
  });

  it('is empty when no message has a size', () => {
    const a = agg();
    feed(a, 'INBOX', [mail({ subject: 'x' }), mail({ subject: 'y' })]);
    expect(a.result().largest).toEqual([]);
  });
});

// --- statsScope -----------------------------------------------------------------------------

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

function scopeError(run: () => unknown): MailboxError {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(MailboxError);
    return err as MailboxError;
  }
  throw new Error('expected statsScope to throw');
}

const paths = (r: { folders: FolderInfo[] }): string[] => r.folders.map((f) => f.path);

describe('statsScope: no folder given, not Gmail', () => {
  it('every selectable folder in tree order, Trash / Junk / Sent / Drafts included', () => {
    const tree = treeOf([
      special('INBOX', 'inbox', 'path'),
      special('Drafts', 'drafts'),
      special('Sent', 'sent'),
      special('Junk', 'junk'),
      special('Trash', 'trash'),
      fi('Work'),
      fi('Work/Sub'),
    ]);
    const r = statsScope(tree, false);
    expect(paths(r)).toEqual(['INBOX', 'Drafts', 'Sent', 'Junk', 'Trash', 'Work', 'Work/Sub']);
    expect(r.notScanned).toBe(0);
  });

  it('not-selectable folders are neither scanned nor counted as not scanned', () => {
    const tree = treeOf([fi('INBOX'), fi('Parent', { selectable: false }), fi('Parent/Child')]);
    const r = statsScope(tree, false);
    expect(paths(r)).toEqual(['INBOX', 'Parent/Child']);
    expect(r.notScanned).toBe(0);
  });

  it('server-reported \\All and \\Flagged folders are virtual: skipped and counted', () => {
    const tree = treeOf([
      fi('INBOX'),
      special('Everything', 'all'),
      special('Starred', 'flagged'),
      fi('Work'),
    ]);
    const r = statsScope(tree, false);
    expect(paths(r)).toEqual(['INBOX', 'Work']);
    expect(r.notScanned).toBe(2);
  });

  it.each<[RoleSource]>([['name'], ['user']])(
    'a folder that only looks like All / Flagged (role from its %s) is scanned',
    (source) => {
      const tree = treeOf([
        fi('INBOX'),
        special('All', 'all', source),
        special('Flagged', 'flagged', source),
      ]);
      const r = statsScope(tree, false);
      expect(paths(r)).toEqual(['INBOX', 'All', 'Flagged']);
      expect(r.notScanned).toBe(0);
    },
  );

  it('a server-reported \\Archive is a real folder and is scanned', () => {
    const r = statsScope(treeOf([special('Archive', 'archive')]), false);
    expect(paths(r)).toEqual(['Archive']);
  });

  it('an empty tree gives an empty scope', () => {
    expect(statsScope(treeOf([]), false)).toEqual({ folders: [], notScanned: 0 });
  });
});

describe('statsScope: no folder given, Gmail', () => {
  const gmailFolders = (): FolderInfo[] => [
    special('INBOX', 'inbox', 'path'),
    fi('[Gmail]', { selectable: false }),
    special('[Gmail]/All Mail', 'all'),
    special('[Gmail]/Sent Mail', 'sent'),
    special('[Gmail]/Spam', 'junk'),
    special('[Gmail]/Starred', 'flagged'),
    special('[Gmail]/Trash', 'trash'),
    fi('Work'),
  ];

  it('only All Mail, Trash and Spam (tree order); the rest is counted as not scanned', () => {
    const r = statsScope(treeOf(gmailFolders()), true);
    expect(paths(r)).toEqual(['[Gmail]/All Mail', '[Gmail]/Spam', '[Gmail]/Trash']);
    // INBOX, Sent Mail, Starred, Work — the not-selectable [Gmail] parent is not counted.
    expect(r.notScanned).toBe(4);
  });

  it('a Spam / Trash whose role was only guessed from its name is not trusted', () => {
    const tree = treeOf([
      special('[Gmail]/All Mail', 'all'),
      special('Spam', 'junk', 'name'),
      special('Trash', 'trash', 'user'),
    ]);
    const r = statsScope(tree, true);
    expect(paths(r)).toEqual(['[Gmail]/All Mail']);
    expect(r.notScanned).toBe(2);
  });

  it('All Mail hidden from IMAP → MailboxError gmail-all-hidden', () => {
    const tree = treeOf(
      gmailFolders().filter((f) => f.role !== 'all'),
      { gmailAllHidden: true },
    );
    const err = scopeError(() => statsScope(tree, true));
    expect(err.code).toBe('gmail-all-hidden');
  });
});

describe('statsScope: --folder', () => {
  const tree = (): FolderTree =>
    treeOf([
      special('INBOX', 'inbox', 'path'),
      fi('INBOX.Sent', { delimiter: '.' }),
      fi('Work'),
      fi('Nowhere', { selectable: false }),
      special('Everything', 'all'),
    ]);

  it('exactly the folder with that path, notScanned 0', () => {
    const r = statsScope(tree(), false, 'Work');
    expect(paths(r)).toEqual(['Work']);
    expect(r.notScanned).toBe(0);
  });

  it('a full path with the server delimiter works', () => {
    expect(paths(statsScope(tree(), false, 'INBOX.Sent'))).toEqual(['INBOX.Sent']);
  });

  it.each(['INBOX', 'inbox', 'Inbox', 'iNbOx'])(
    'INBOX is matched case-insensitively (%s)',
    (given) => {
      expect(paths(statsScope(tree(), false, given))).toEqual(['INBOX']);
    },
  );

  it('other paths are matched exactly (case-sensitive)', () => {
    const err = scopeError(() => statsScope(tree(), false, 'work'));
    expect(err.code).toBe('folder-not-found');
  });

  it('an unknown path → folder-not-found', () => {
    const err = scopeError(() => statsScope(tree(), false, 'Missing'));
    expect(err.code).toBe('folder-not-found');
  });

  it('a short name that is not a full path (Sent for INBOX.Sent) → folder-not-found', () => {
    const err = scopeError(() => statsScope(tree(), false, 'Sent'));
    expect(err.code).toBe('folder-not-found');
  });

  it('a not-selectable folder → folder-not-found', () => {
    const err = scopeError(() => statsScope(tree(), false, 'Nowhere'));
    expect(err.code).toBe('folder-not-found');
  });

  it('a virtual \\All folder can still be asked for by its path', () => {
    expect(paths(statsScope(tree(), false, 'Everything'))).toEqual(['Everything']);
  });

  it('Gmail: a label is allowed and scans just that label, notScanned 0', () => {
    const gmail = treeOf([special('[Gmail]/All Mail', 'all'), fi('Work')]);
    const r = statsScope(gmail, true, 'Work');
    expect(paths(r)).toEqual(['Work']);
    expect(r.notScanned).toBe(0);
  });

  it('Gmail with All Mail hidden: --folder still works (no gmail-all-hidden)', () => {
    const gmail = treeOf([fi('Work')], { gmailAllHidden: true });
    expect(paths(statsScope(gmail, true, 'Work'))).toEqual(['Work']);
  });
});

describe('mailbox error codes (M2c-1)', () => {
  it('folder-not-found and gmail-all-hidden are listed codes with plain core messages', () => {
    expect(MAILBOX_ERROR_CODES).toContain('folder-not-found');
    expect(MAILBOX_ERROR_CODES).toContain('gmail-all-hidden');
    expect(new MailboxError('folder-not-found').message).toContain(
      'There is no folder with that path',
    );
    expect(new MailboxError('gmail-all-hidden').message).toContain(
      'Gmail hides All Mail from IMAP',
    );
  });
});

// --- collectStats over a fake IMAP session --------------------------------------------------

interface FakeFolder {
  path: string;
  /** Message of sequence number i + 1 (the fake sets `seq`). */
  mails?: FetchedMessage[];
  /** EXISTS after EXAMINE; default mails.length. */
  exists?: number;
  lockThrows?: boolean;
  /** The FETCH fails after this many real messages of this folder were yielded. */
  failAfter?: number;
  /** The connection drops with the failure above (session.closed). */
  dropOnFail?: boolean;
  /** The session closes right after the last message of this folder was streamed. */
  closeAfterFolder?: boolean;
  /** What a range yields, given the real messages of that range (default: those). */
  inject?: (range: { from: number; to: number }, real: FetchedMessage[]) => FetchedMessage[];
}

interface FakeCalls {
  lock: { path: string; options: unknown }[];
  release: string[];
  fetch: { path: string; range: string; query: unknown; options: FetchOptions | undefined }[];
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

function fakeSession(
  folders: FakeFolder[],
  feat: Partial<ServerFeatures> = {},
): { session: FolderSession; calls: FakeCalls; state: { closed: boolean; usable: boolean } } {
  const state = { closed: false, usable: true };
  const calls: FakeCalls = { lock: [], release: [], fetch: [] };
  const byPath = new Map(folders.map((f) => [f.path, f]));
  const yielded = new Map<string, number>();
  let mailbox: { exists: number } | false = false;
  let selected = '';

  const client = {
    options: {},
    capabilities: new Map(),
    enabled: new Set(),
    serverInfo: null,
    get usable() {
      return state.usable;
    },
    get mailbox() {
      return mailbox;
    },
    connect: () => Promise.resolve(),
    logout: () => Promise.resolve(),
    noop: () => Promise.resolve(),
    close: () => undefined,
    on: () => undefined,
    getMailboxLock(path: string, options?: unknown): Promise<MailboxLockObject> {
      calls.lock.push({ path, options });
      const f = byPath.get(path);
      if (f === undefined || f.lockThrows === true)
        return Promise.reject(new Error('EXAMINE refused'));
      mailbox = { exists: f.exists ?? f.mails?.length ?? 0 };
      selected = path;
      return Promise.resolve({
        path,
        release: () => {
          calls.release.push(path);
        },
      });
    },
    fetch(range: string, query: unknown, options?: FetchOptions): AsyncIterable<FetchedMessage> {
      const path = selected;
      calls.fetch.push({ path, range, query, options });
      const f = byPath.get(path);
      return {
        async *[Symbol.asyncIterator]() {
          await Promise.resolve();
          if (f === undefined) throw new Error('no folder');
          const [a, b] = range.split(':').map(Number);
          const from = a ?? 1;
          const to = b ?? from;
          const real: FetchedMessage[] = [];
          let failed = false;
          for (let seq = from; seq <= to && !failed; seq++) {
            const m = f.mails?.[seq - 1];
            if (m === undefined) continue;
            const done = yielded.get(path) ?? 0;
            if (f.failAfter !== undefined && done >= f.failAfter) {
              failed = true;
              break;
            }
            yielded.set(path, done + 1);
            real.push({ ...m, seq });
          }
          const out = f.inject ? f.inject({ from, to }, real) : real;
          for (const m of out) yield m;
          if (failed) {
            if (f.dropOnFail === true) state.closed = true;
            throw new Error('NO [EXPUNGEISSUED] some messages were expunged');
          }
          if (f.closeAfterFolder === true && to >= (f.exists ?? f.mails?.length ?? 0)) {
            state.closed = true;
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

function mails(n: number, over: (i: number) => MailSpec = () => ({})): FetchedMessage[] {
  return Array.from({ length: n }, (_v, i) =>
    mail({
      size: 100 + i,
      date: utc('2024-06-15T12:00:00Z'),
      address: `s${i}@d.example`,
      ...over(i),
    }),
  );
}

async function collect(
  folders: FakeFolder[],
  opts: Partial<Parameters<typeof collectStats>[2]> = {},
  extra: { gmail?: boolean; treeFolders?: FolderInfo[]; tree?: Partial<FolderTree> } = {},
): Promise<{ stats: MailboxStats; calls: FakeCalls }> {
  const { session, calls } = fakeSession(folders, { gmail: extra.gmail === true });
  const tree = treeOf(extra.treeFolders ?? folders.map((f) => fi(f.path)), extra.tree);
  const stats = await collectStats(session, tree, { timeZone: 'UTC', ...opts });
  return { stats, calls };
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
}

describe('collectStats: what is asked from the server', () => {
  it('STATS_QUERY is exactly envelope + internalDate + size (no uid, flags, body, structure)', () => {
    expect(STATS_QUERY).toEqual({ envelope: true, internalDate: true, size: true });
  });

  it('every FETCH uses STATS_QUERY, sequence numbers, under a read-only lock that is released', async () => {
    const { calls } = await collect([
      { path: 'INBOX', mails: mails(2) },
      { path: 'Sent', mails: mails(1) },
    ]);
    expect(calls.fetch.length).toBeGreaterThan(0);
    for (const f of calls.fetch) {
      expect(f.query).toEqual({ envelope: true, internalDate: true, size: true });
      expect(f.options?.uid).not.toBe(true);
    }
    for (const l of calls.lock) expect(l.options).toEqual({ readOnly: true });
    expect(calls.release).toEqual(calls.lock.map((l) => l.path));
  });

  it('folders are scanned one after another in scope order, Trash and Junk included', async () => {
    const treeFolders = [
      special('INBOX', 'inbox', 'path'),
      fi('Parent', { selectable: false }),
      fi('Parent/Child'),
      special('Junk', 'junk'),
      special('Trash', 'trash'),
      special('Everything', 'all'), // virtual: not scanned
    ];
    const { stats, calls } = await collect(
      [
        { path: 'INBOX', mails: mails(1) },
        { path: 'Parent/Child', mails: mails(1) },
        { path: 'Junk', mails: mails(1) },
        { path: 'Trash', mails: mails(1) },
        { path: 'Everything', mails: mails(5) },
      ],
      {},
      { treeFolders },
    );
    expect(calls.lock.map((l) => l.path)).toEqual(['INBOX', 'Parent/Child', 'Junk', 'Trash']);
    expect(stats.folders.map((f) => f.path)).toEqual(['INBOX', 'Parent/Child', 'Junk', 'Trash']);
    expect(stats.notScanned).toBe(1);
    expect(stats.totals.messages).toBe(4);
  });

  it('batchSize splits a folder into sequence ranges fetched in order, every message counted once', async () => {
    const { stats, calls } = await collect([{ path: 'INBOX', mails: mails(5) }], { batchSize: 2 });
    expect(calls.fetch.map((f) => f.range)).toEqual(['1:2', '3:4', '5:5']);
    expect(stats.folders).toEqual([
      { path: 'INBOX', messages: 5, bytes: 100 + 101 + 102 + 103 + 104, partial: false },
    ]);
  });

  it('an empty folder: a row with 0 / 0 and no FETCH', async () => {
    const { stats, calls } = await collect([{ path: 'Empty', mails: [] }]);
    expect(calls.fetch).toEqual([]);
    expect(stats.folders).toEqual([{ path: 'Empty', messages: 0, bytes: 0, partial: false }]);
    expect(stats.totals).toEqual({ messages: 0, bytes: 0 });
    expect(calls.release).toEqual(['Empty']);
  });

  it('a mailbox with no selectable folder at all gives an empty result', async () => {
    const { stats } = await collect([], {}, { treeFolders: [fi('Only', { selectable: false })] });
    expect(stats.folders).toEqual([]);
    expect(stats.totals).toEqual({ messages: 0, bytes: 0 });
  });
});

describe('collectStats: the result', () => {
  it('aggregates totals, years (in the given zone), senders, domains and largest', async () => {
    const { stats } = await collect([
      {
        path: 'INBOX',
        mails: [
          mail({
            size: 100,
            date: utc('2023-12-31T23:30:00Z'),
            address: 'a@x.com',
            subject: 'one',
          }),
          mail({
            size: 300,
            date: utc('2024-06-15T12:00:00Z'),
            address: 'A@X.com',
            subject: 'two',
          }),
        ],
      },
      {
        path: 'Sent',
        mails: [mail({ size: 50, date: utc('2024-06-16T12:00:00Z'), address: 'b@y.org' })],
      },
    ]);
    expect(stats.totals).toEqual({ messages: 3, bytes: 450 });
    expect(stats.years).toEqual([
      { year: '2023', messages: 1, bytes: 100 },
      { year: '2024', messages: 2, bytes: 350 },
    ]);
    expect(stats.senders.byCount[0]).toEqual({ key: 'a@x.com', messages: 2, bytes: 400 });
    expect(stats.domains.bySize.map((r) => r.key)).toEqual(['x.com', 'y.org']);
    expect(stats.largest.map((l) => [l.folder, l.subject, l.bytes])).toEqual([
      ['INBOX', 'two', 300],
      ['INBOX', 'one', 100],
      ['Sent', null, 50],
    ]);
    expect(stats.notScanned).toBe(0);
    expect(stats.unreadable).toBe(0);
    expect(stats.partial).toBe(0);
  });

  it('the time zone option decides the year', async () => {
    const folder = { path: 'INBOX', mails: [mail({ size: 1, date: utc('2023-12-31T23:30:00Z') })] };
    const inUtc = await collect([folder], { timeZone: 'UTC' });
    const inKiritimati = await collect([folder], { timeZone: 'Pacific/Kiritimati' });
    expect(inUtc.stats.years.map((y) => y.year)).toEqual(['2023']);
    expect(inKiritimati.stats.years.map((y) => y.year)).toEqual(['2024']);
  });
});

describe('collectStats: unsolicited, repeated and out-of-range FETCH responses', () => {
  const inject =
    (extra: (real: FetchedMessage[]) => FetchedMessage[]): NonNullable<FakeFolder['inject']> =>
    (_range, real) =>
      extra(real);

  it('an unsolicited FLAGS-only update (after the real message) is not counted', async () => {
    const { stats } = await collect([
      {
        path: 'INBOX',
        mails: mails(3),
        inject: inject((real) => [...real, { seq: 2 }, { seq: 1 }]),
      },
    ]);
    expect(stats.folders[0]).toMatchObject({ messages: 3, bytes: 100 + 101 + 102 });
    expect(stats.totals).toEqual({ messages: 3, bytes: 100 + 101 + 102 });
    // The FLAGS-only answers must not show up as a sender-less, size-less message.
    expect(stats.senders.byCount.map((r) => r.key).sort()).toEqual([
      's0@d.example',
      's1@d.example',
      's2@d.example',
    ]);
    expect(stats.largest.map((l) => l.bytes)).toEqual([102, 101, 100]);
  });

  it('an unsolicited FLAGS-only update arriving first does not hide the real message of that seq', async () => {
    const { stats } = await collect([
      {
        path: 'INBOX',
        mails: mails(2),
        inject: inject((real) => [{ seq: 2 }, ...real]),
      },
    ]);
    expect(stats.totals).toEqual({ messages: 2, bytes: 100 + 101 });
    // The real seq 2 (not the FLAGS-only stub) is the one counted.
    expect(stats.senders.byCount.map((r) => r.key).sort()).toEqual([
      's0@d.example',
      's1@d.example',
    ]);
    expect(stats.senders.byCount.some((r) => r.key === null)).toBe(false);
    expect(stats.years).toEqual([{ year: '2024', messages: 2, bytes: 100 + 101 }]);
    expect(stats.largest.map((l) => [l.from, l.bytes])).toEqual([
      ['s1@d.example', 101],
      ['s0@d.example', 100],
    ]);
  });

  it('a repeated seq within a range is counted once (the first full answer)', async () => {
    const { stats } = await collect([
      {
        path: 'INBOX',
        mails: mails(2),
        inject: inject((real) => [...real, ...real]),
      },
    ]);
    expect(stats.totals.messages).toBe(2);
    expect(stats.totals.bytes).toBe(100 + 101);
  });

  it.each<[string, number | undefined]>([
    ['above the range', 99],
    ['zero', 0],
    ['negative', -1],
    ['a fraction', 1.5],
    ['NaN', Number.NaN],
    ['missing', undefined],
  ])('a full message with a seq that is %s is ignored', async (_name, seq) => {
    const stray: FetchedMessage = { ...mail({ size: 5000, address: 'stray@x.com' }), seq };
    const { stats } = await collect([
      { path: 'INBOX', mails: mails(2), inject: inject((real) => [...real, stray]) },
    ]);
    expect(stats.totals).toEqual({ messages: 2, bytes: 100 + 101 });
    expect(stats.senders.byCount.map((r) => r.key)).not.toContain('stray@x.com');
  });

  it('a seq from an earlier range is ignored in a later range', async () => {
    const stray = (): FetchedMessage => ({
      ...mail({ size: 5000, address: 'stray@x.com' }),
      seq: 1,
    });
    const { stats } = await collect(
      [
        {
          path: 'INBOX',
          mails: mails(4),
          inject: (range, real) => (range.from === 3 ? [...real, stray()] : real),
        },
      ],
      { batchSize: 2 },
    );
    expect(stats.totals.messages).toBe(4);
    expect(stats.senders.byCount.map((r) => r.key)).not.toContain('stray@x.com');
  });

  it.each<[string, FetchedMessage]>([
    ['only size', { seq: 1, size: 77 }],
    ['only internalDate', { seq: 1, internalDate: utc('2024-06-15T12:00:00Z') }],
    ['only an envelope', { seq: 1, envelope: envelope([{ address: 'only@env.example' }], 's') }],
  ])('a message carrying %s is counted', async (_name, msg) => {
    const { stats } = await collect([{ path: 'INBOX', exists: 1, mails: [msg] }]);
    expect(stats.totals.messages).toBe(1);
  });
});

describe('collectStats: folder failures', () => {
  it('EXAMINE refused: the row is unreadable (null, null) and the scan goes on', async () => {
    const { stats, calls } = await collect([
      { path: 'Broken', lockThrows: true, mails: mails(1) },
      { path: 'Fine', mails: mails(2) },
    ]);
    expect(stats.folders).toEqual([
      { path: 'Broken', messages: null, bytes: null, partial: false },
      { path: 'Fine', messages: 2, bytes: 201, partial: false },
    ]);
    expect(stats.unreadable).toBe(1);
    expect(stats.partial).toBe(0);
    expect(stats.totals.messages).toBe(2);
    expect(calls.lock.map((l) => l.path)).toEqual(['Broken', 'Fine']);
  });

  it('FETCH fails before the first message: unreadable, the lock is released, the scan goes on', async () => {
    const { stats, calls } = await collect([
      { path: 'Bad', mails: mails(3), failAfter: 0 },
      { path: 'Fine', mails: mails(1) },
    ]);
    expect(stats.folders.map((f) => [f.path, f.messages, f.bytes, f.partial])).toEqual([
      ['Bad', null, null, false],
      ['Fine', 1, 100, false],
    ]);
    expect(stats.unreadable).toBe(1);
    expect(calls.release).toEqual(['Bad', 'Fine']);
  });

  it('FETCH fails after some messages (a ranged read): partial, counts kept, the scan goes on', async () => {
    const { stats, calls } = await collect(
      [
        { path: 'Cut', mails: mails(4), failAfter: 2 },
        { path: 'Fine', mails: mails(1) },
      ],
      { batchSize: 2 },
    );
    expect(stats.folders).toEqual([
      { path: 'Cut', messages: 2, bytes: 100 + 101, partial: true },
      { path: 'Fine', messages: 1, bytes: 100, partial: false },
    ]);
    expect(stats.partial).toBe(1);
    expect(stats.unreadable).toBe(0);
    expect(stats.totals).toEqual({ messages: 3, bytes: 301 });
    expect(calls.release).toEqual(['Cut', 'Fine']);
  });

  it('what a partial folder counted stays in the years, senders and largest', async () => {
    const { stats } = await collect(
      [{ path: 'Cut', mails: mails(4, (i) => ({ subject: `m${i}` })), failAfter: 2 }],
      { batchSize: 2 },
    );
    expect(stats.years).toEqual([{ year: '2024', messages: 2, bytes: 201 }]);
    expect(stats.largest.map((l) => l.subject)).toEqual(['m1', 'm0']);
  });

  it('a failure with an open connection never throws out of collectStats', async () => {
    await expect(
      collect([
        { path: 'A', mails: mails(1), failAfter: 0 },
        { path: 'B', lockThrows: true },
      ]),
    ).resolves.toBeDefined();
  });
});

describe('collectStats: a lost connection', () => {
  it('the connection drops mid-folder → MailboxError connection-lost, later folders untouched', async () => {
    const { session, calls } = fakeSession([
      { path: 'A', mails: mails(3), failAfter: 1, dropOnFail: true },
      { path: 'B', mails: mails(1) },
    ]);
    const tree = treeOf([fi('A'), fi('B')]);
    const err = await rejection(collectStats(session, tree, { timeZone: 'UTC', batchSize: 1 }));
    expect(err).toBeInstanceOf(MailboxError);
    expect((err as MailboxError).code).toBe('connection-lost');
    expect(calls.lock.map((l) => l.path)).toEqual(['A']);
    expect(calls.release).toEqual(['A']);
  });

  it('the connection drops while taking the lock → connection-lost (not an unreadable folder)', async () => {
    const { session, state } = fakeSession([
      { path: 'A', lockThrows: true },
      { path: 'B', mails: mails(1) },
    ]);
    state.closed = true;
    const tree = treeOf([fi('A'), fi('B')]);
    const err = await rejection(collectStats(session, tree, { timeZone: 'UTC' }));
    expect(err).toBeInstanceOf(MailboxError);
    expect((err as MailboxError).code).toBe('connection-lost');
  });

  it('client.usable === false counts as a lost connection too', async () => {
    const { session, state } = fakeSession([{ path: 'A', lockThrows: true }]);
    state.usable = false;
    const err = await rejection(collectStats(session, treeOf([fi('A')]), { timeZone: 'UTC' }));
    expect((err as MailboxError).code).toBe('connection-lost');
  });

  it('a session that closed right after a good folder ends the run (checked after each folder)', async () => {
    const { session, calls } = fakeSession([
      { path: 'A', mails: mails(2), closeAfterFolder: true },
      { path: 'B', mails: mails(1) },
    ]);
    const err = await rejection(
      collectStats(session, treeOf([fi('A'), fi('B')]), { timeZone: 'UTC' }),
    );
    expect(err).toBeInstanceOf(MailboxError);
    expect((err as MailboxError).code).toBe('connection-lost');
    expect(calls.lock.map((l) => l.path)).toEqual(['A']);
  });
});

describe('collectStats: an aggregator bug is not an unreadable folder', () => {
  /** A Date whose every method throws: only the aggregator (reading the year) touches it. */
  class BoomDate extends Date {
    override getTime(): number {
      throw BOOM;
    }
    override valueOf(): number {
      throw BOOM;
    }
    override [Symbol.toPrimitive](): never {
      throw BOOM;
    }
  }

  it('the exception is rethrown unchanged, the run ends, the lock is released', async () => {
    const poisoned: FetchedMessage = {
      size: 10,
      envelope: envelope([{ address: 'a@x.com' }], 'x'),
      internalDate: new BoomDate(),
    };
    const { session, calls } = fakeSession([
      { path: 'A', mails: [poisoned] },
      { path: 'B', mails: mails(1) },
    ]);
    const err = await rejection(
      collectStats(session, treeOf([fi('A'), fi('B')]), { timeZone: 'UTC' }),
    );
    expect(err).toBe(BOOM);
    expect(calls.lock.map((l) => l.path)).toEqual(['A']);
    expect(calls.release).toEqual(['A']);
  });
});

describe('collectStats: scope rules and errors before any network traffic', () => {
  const gmailTree = (): FolderInfo[] => [
    special('INBOX', 'inbox', 'path'),
    special('[Gmail]/All Mail', 'all'),
    special('[Gmail]/Spam', 'junk'),
    special('[Gmail]/Trash', 'trash'),
    fi('Work'),
  ];

  it('Gmail: only All Mail, Spam and Trash are read; labels and INBOX are counted as not scanned', async () => {
    const { stats, calls } = await collect(
      [
        { path: 'INBOX', mails: mails(2) },
        { path: '[Gmail]/All Mail', mails: mails(5) },
        { path: '[Gmail]/Spam', mails: mails(1) },
        { path: '[Gmail]/Trash', mails: mails(2) },
        { path: 'Work', mails: mails(3) },
      ],
      {},
      { gmail: true, treeFolders: gmailTree() },
    );
    expect(calls.lock.map((l) => l.path)).toEqual([
      '[Gmail]/All Mail',
      '[Gmail]/Spam',
      '[Gmail]/Trash',
    ]);
    expect(stats.totals.messages).toBe(8);
    expect(stats.notScanned).toBe(2);
  });

  it('Gmail with All Mail hidden: rejects with gmail-all-hidden without any lock', async () => {
    const { session, calls } = fakeSession([{ path: 'INBOX', mails: mails(1) }], { gmail: true });
    const tree = treeOf([special('INBOX', 'inbox', 'path'), fi('Work')], { gmailAllHidden: true });
    const err = await rejection(collectStats(session, tree, { timeZone: 'UTC' }));
    expect(err).toBeInstanceOf(MailboxError);
    expect((err as MailboxError).code).toBe('gmail-all-hidden');
    expect(calls.lock).toEqual([]);
  });

  it('--folder: reads just that folder; INBOX is found case-insensitively', async () => {
    const { stats, calls } = await collect(
      [
        { path: 'INBOX', mails: mails(2) },
        { path: 'Work', mails: mails(5) },
      ],
      { folder: 'inbox' },
      { treeFolders: [special('INBOX', 'inbox', 'path'), fi('Work')] },
    );
    expect(calls.lock.map((l) => l.path)).toEqual(['INBOX']);
    expect(stats.folders.map((f) => f.path)).toEqual(['INBOX']);
    expect(stats.notScanned).toBe(0);
  });

  it('--folder with Gmail reads just that label', async () => {
    const { stats, calls } = await collect(
      [
        { path: '[Gmail]/All Mail', mails: mails(5) },
        { path: 'Work', mails: mails(3) },
      ],
      { folder: 'Work' },
      { gmail: true, treeFolders: [special('[Gmail]/All Mail', 'all'), fi('Work')] },
    );
    expect(calls.lock.map((l) => l.path)).toEqual(['Work']);
    expect(stats.totals.messages).toBe(3);
  });

  it('--folder unknown → folder-not-found, no lock taken', async () => {
    const { session, calls } = fakeSession([{ path: 'INBOX', mails: mails(1) }]);
    const err = await rejection(
      collectStats(session, treeOf([fi('INBOX')]), { timeZone: 'UTC', folder: 'Nope' }),
    );
    expect(err).toBeInstanceOf(MailboxError);
    expect((err as MailboxError).code).toBe('folder-not-found');
    expect(calls.lock).toEqual([]);
  });
});

describe('collectStats: progress', () => {
  it('reports { folder, folders, done, total } after each range, folder counted from 1', async () => {
    const progress: SizeProgress[] = [];
    await collect(
      [
        { path: 'A', mails: mails(3) },
        { path: 'B', mails: mails(2) },
      ],
      { batchSize: 2, onProgress: (p) => progress.push({ ...p }) },
    );
    expect(progress).toEqual([
      { folder: 1, folders: 2, done: 2, total: 3 },
      { folder: 1, folders: 2, done: 3, total: 3 },
      { folder: 2, folders: 2, done: 2, total: 2 },
    ]);
  });

  it('a throwing onProgress does not fail the run or a folder', async () => {
    const { stats } = await collect([{ path: 'A', mails: mails(3) }], {
      batchSize: 1,
      onProgress: () => {
        throw new Error('progress sink broke');
      },
    });
    expect(stats.folders).toEqual([
      { path: 'A', messages: 3, bytes: 100 + 101 + 102, partial: false },
    ]);
    expect(stats.unreadable).toBe(0);
    expect(stats.partial).toBe(0);
  });
});

// --- M2-fix: short reads without an error, --folder display-path match ----------------------

describe('collectStats: short reads without an error', () => {
  /** The range starting at `from` yields nothing (the server gave up silently). */
  const emptyAt =
    (from: number): NonNullable<FakeFolder['inject']> =>
    (range, real) =>
      range.from === from ? [] : real;

  it('an empty middle range of three: partial, the other ranges kept, bytes summed', async () => {
    const { stats } = await collect([{ path: 'INBOX', mails: mails(6), inject: emptyAt(3) }], {
      batchSize: 2,
    });
    expect(stats.folders).toEqual([
      { path: 'INBOX', messages: 4, bytes: 100 + 101 + 104 + 105, partial: true },
    ]);
    expect(stats.partial).toBe(1);
    expect(stats.unreadable).toBe(0);
    expect(stats.totals).toEqual({ messages: 4, bytes: 100 + 101 + 104 + 105 });
  });

  it('an empty last range: partial, the earlier ranges kept', async () => {
    const { stats } = await collect([{ path: 'INBOX', mails: mails(5), inject: emptyAt(5) }], {
      batchSize: 2,
    });
    expect(stats.folders).toEqual([
      { path: 'INBOX', messages: 4, bytes: 100 + 101 + 102 + 103, partial: true },
    ]);
    expect(stats.partial).toBe(1);
    expect(stats.unreadable).toBe(0);
  });

  it('12,000 messages, range 5001:10000 empty: 7,000 counted, partial', async () => {
    const { stats } = await collect([{ path: 'Big', mails: mails(12_000), inject: emptyAt(5001) }]);
    let bytes = 0;
    for (let i = 0; i < 5000; i++) bytes += 100 + i;
    for (let i = 10_000; i < 12_000; i++) bytes += 100 + i;
    expect(stats.folders).toEqual([{ path: 'Big', messages: 7000, bytes, partial: true }]);
    expect(stats.partial).toBe(1);
    expect(stats.unreadable).toBe(0);
  });

  it('a range that yields only some of its messages: partial, what arrived is kept', async () => {
    const { stats } = await collect(
      [
        {
          path: 'INBOX',
          mails: mails(6),
          inject: (range, real) => (range.from === 4 ? real.slice(0, 1) : real),
        },
      ],
      { batchSize: 3 },
    );
    expect(stats.folders).toEqual([
      { path: 'INBOX', messages: 4, bytes: 100 + 101 + 102 + 103, partial: true },
    ]);
    expect(stats.partial).toBe(1);
  });

  it('nothing yielded at all (no error): an unreadable row, not an empty one', async () => {
    const { stats } = await collect([{ path: 'INBOX', mails: mails(3), inject: () => [] }]);
    expect(stats.folders).toEqual([{ path: 'INBOX', messages: null, bytes: null, partial: false }]);
    expect(stats.unreadable).toBe(1);
    expect(stats.partial).toBe(0);
    expect(stats.totals).toEqual({ messages: 0, bytes: 0 });
  });

  it('EXISTS above what the server returns (no message of the tail): partial', async () => {
    const { stats } = await collect([{ path: 'INBOX', mails: mails(3), exists: 5 }]);
    expect(stats.folders).toEqual([
      { path: 'INBOX', messages: 3, bytes: 100 + 101 + 102, partial: true },
    ]);
    expect(stats.partial).toBe(1);
  });

  it('EXISTS above a server that returns nothing: unreadable', async () => {
    const { stats } = await collect([{ path: 'INBOX', mails: [], exists: 3 }]);
    expect(stats.folders).toEqual([{ path: 'INBOX', messages: null, bytes: null, partial: false }]);
    expect(stats.unreadable).toBe(1);
  });

  it('a short folder does not stop the scan: the next folders are read and counted', async () => {
    const { stats, calls } = await collect(
      [
        { path: 'Short', mails: mails(4), inject: emptyAt(3) },
        { path: 'Gone', mails: mails(2), inject: () => [] },
        { path: 'Fine', mails: mails(2) },
      ],
      { batchSize: 2 },
    );
    expect(stats.folders).toEqual([
      { path: 'Short', messages: 2, bytes: 100 + 101, partial: true },
      { path: 'Gone', messages: null, bytes: null, partial: false },
      { path: 'Fine', messages: 2, bytes: 100 + 101, partial: false },
    ]);
    expect(stats.partial).toBe(1);
    expect(stats.unreadable).toBe(1);
    expect(stats.totals).toEqual({ messages: 4, bytes: 2 * (100 + 101) });
    expect(calls.lock.map((l) => l.path)).toEqual(['Short', 'Gone', 'Fine']);
    expect(calls.release).toEqual(['Short', 'Gone', 'Fine']);
  });

  it('what a short folder counted stays in the years, senders and largest', async () => {
    const { stats } = await collect(
      [
        {
          path: 'Cut',
          mails: mails(4, (i) => ({ subject: `m${i}` })),
          inject: emptyAt(3),
        },
      ],
      { batchSize: 2 },
    );
    expect(stats.years).toEqual([{ year: '2024', messages: 2, bytes: 201 }]);
    expect(stats.largest.map((l) => l.subject)).toEqual(['m1', 'm0']);
  });

  it('a fully read folder and an empty folder are not marked', async () => {
    const { stats } = await collect(
      [
        { path: 'Full', mails: mails(5) },
        { path: 'Empty', mails: [] },
      ],
      { batchSize: 2 },
    );
    expect(stats.folders).toEqual([
      { path: 'Full', messages: 5, bytes: 100 + 101 + 102 + 103 + 104, partial: false },
      { path: 'Empty', messages: 0, bytes: 0, partial: false },
    ]);
    expect(stats.partial).toBe(0);
    expect(stats.unreadable).toBe(0);
  });

  it('unsolicited FLAGS-only and repeated responses on top of every real message: not marked', async () => {
    const { stats } = await collect([
      {
        path: 'INBOX',
        mails: mails(3),
        inject: (_range, real) => [...real, { seq: 1 }, { seq: 3 }, ...real],
      },
    ]);
    expect(stats.folders).toEqual([
      { path: 'INBOX', messages: 3, bytes: 100 + 101 + 102, partial: false },
    ]);
    expect(stats.partial).toBe(0);
    expect(stats.unreadable).toBe(0);
  });

  it('a FLAGS-only response instead of the real message of that seq: partial', async () => {
    const { stats } = await collect([
      {
        path: 'INBOX',
        mails: mails(3),
        inject: (_range, real) => [
          real[0] as FetchedMessage,
          { seq: 2 },
          real[2] as FetchedMessage,
        ],
      },
    ]);
    expect(stats.folders).toEqual([
      { path: 'INBOX', messages: 2, bytes: 100 + 102, partial: true },
    ]);
    expect(stats.partial).toBe(1);
  });

  it('a repeated answer does not stand in for a message that never arrived: partial', async () => {
    const { stats } = await collect([
      {
        path: 'INBOX',
        mails: mails(4),
        inject: (_range, real) => [
          real[0] as FetchedMessage,
          real[0] as FetchedMessage,
          real[2] as FetchedMessage,
          real[3] as FetchedMessage,
        ],
      },
    ]);
    expect(stats.folders).toEqual([
      { path: 'INBOX', messages: 3, bytes: 100 + 102 + 103, partial: true },
    ]);
    expect(stats.partial).toBe(1);
  });

  it('mail arriving mid-scan (more messages than the EXAMINE snapshot): not marked', async () => {
    const { stats } = await collect([{ path: 'INBOX', mails: mails(4), exists: 2 }]);
    expect(stats.folders).toEqual([
      { path: 'INBOX', messages: 2, bytes: 100 + 101, partial: false },
    ]);
    expect(stats.partial).toBe(0);
    expect(stats.unreadable).toBe(0);
  });

  it('a thrown FETCH error after a short range is one partial folder, not two', async () => {
    const { stats } = await collect(
      [{ path: 'Cut', mails: mails(6), inject: emptyAt(3), failAfter: 4 }],
      { batchSize: 2 },
    );
    expect(stats.folders).toEqual([{ path: 'Cut', messages: 2, bytes: 100 + 101, partial: true }]);
    expect(stats.partial).toBe(1);
    expect(stats.unreadable).toBe(0);
  });

  it('a short read on a connection that is gone → connection-lost, later folders untouched', async () => {
    const { session, calls } = fakeSession([
      { path: 'A', mails: mails(3), inject: () => [], closeAfterFolder: true },
      { path: 'B', mails: mails(1) },
    ]);
    const err = await rejection(
      collectStats(session, treeOf([fi('A'), fi('B')]), { timeZone: 'UTC' }),
    );
    expect(err).toBeInstanceOf(MailboxError);
    expect((err as MailboxError).code).toBe('connection-lost');
    expect(calls.lock.map((l) => l.path)).toEqual(['A']);
    expect(calls.release).toEqual(['A']);
  });

  it('an aggregator bug in a folder that also reads short is still rethrown unchanged', async () => {
    class BoomDate extends Date {
      override getTime(): number {
        throw BOOM;
      }
      override valueOf(): number {
        throw BOOM;
      }
      override [Symbol.toPrimitive](): never {
        throw BOOM;
      }
    }
    const poisoned: FetchedMessage = {
      size: 10,
      envelope: envelope([{ address: 'a@x.com' }], 'x'),
      internalDate: new BoomDate(),
    };
    const { session, calls } = fakeSession([
      { path: 'A', mails: [poisoned, mail({ size: 1 })], inject: (_r, real) => real.slice(0, 1) },
      { path: 'B', mails: mails(1) },
    ]);
    const err = await rejection(
      collectStats(session, treeOf([fi('A'), fi('B')]), { timeZone: 'UTC' }),
    );
    expect(err).toBe(BOOM);
    expect(calls.lock.map((l) => l.path)).toEqual(['A']);
  });
});

describe('statsScope: --folder through displayPath', () => {
  /** What a shell that hides soft hyphens, zero-width marks and joiners prints (like `sanitize`). */
  const shown = (path: string): string => path.replace(/[\u00ad\u200b-\u200f]/g, '');

  const SOFT = 'Caf\u00ade';
  const PERSIAN = '\u0646\u0627\u0645\u0647\u200c\u0647\u0627';
  const FAMILY = 'Family \u{1F468}\u200d\u{1F469}\u200D\u{1F467}';
  const tree = (): FolderTree =>
    treeOf([special('INBOX', 'inbox', 'path'), fi(SOFT), fi(PERSIAN), fi(FAMILY), fi('Work')]);

  it.each<[string, string]>([
    ['a soft hyphen', SOFT],
    ['a ZWNJ', PERSIAN],
    ['a ZWJ emoji sequence', FAMILY],
  ])('a folder with %s is found by its displayed path, notScanned 0', (_name, path) => {
    expect(shown(path)).not.toBe(path);
    const r = statsScope(tree(), false, shown(path), shown);
    expect(paths(r)).toEqual([path]);
    expect(r.notScanned).toBe(0);
  });

  it.each<[string, string]>([
    ['a soft hyphen', SOFT],
    ['a ZWNJ', PERSIAN],
    ['a ZWJ emoji sequence', FAMILY],
  ])('without displayPath the displayed path of a folder with %s is not found', (_name, path) => {
    const err = scopeError(() => statsScope(tree(), false, shown(path)));
    expect(err.code).toBe('folder-not-found');
  });

  it('the raw path still works with displayPath given', () => {
    expect(paths(statsScope(tree(), false, SOFT, shown))).toEqual([SOFT]);
    expect(paths(statsScope(tree(), false, 'Work', shown))).toEqual(['Work']);
  });

  it.each<[string, FolderInfo[]]>([
    ['the plain folder first', [fi('Cafe'), fi(SOFT)]],
    ['the invisible-character folder first', [fi(SOFT), fi('Cafe')]],
  ])('an exact path wins over a folder that only displays the same (%s)', (_name, folders) => {
    expect(paths(statsScope(treeOf(folders), false, 'Cafe', shown))).toEqual(['Cafe']);
  });

  it('two folders that display as the value and neither equals it → folder-not-found', () => {
    const twins = treeOf([fi(SOFT), fi('Caf\u200ce')]);
    const err = scopeError(() => statsScope(twins, false, 'Cafe', shown));
    expect(err.code).toBe('folder-not-found');
  });

  it('three folders that display as the value → folder-not-found', () => {
    const triplets = treeOf([fi(SOFT), fi('Caf\u200ce'), fi('Caf\u200de')]);
    const err = scopeError(() => statsScope(triplets, false, 'Cafe', shown));
    expect(err.code).toBe('folder-not-found');
  });

  it('exactly one displayed match among other folders is taken', () => {
    const mixed = treeOf([fi('Cafe2'), fi('Caffe'), fi(SOFT), fi('Work')]);
    expect(paths(statsScope(mixed, false, 'Cafe', shown))).toEqual([SOFT]);
  });

  it('nothing displays as the value → folder-not-found', () => {
    const err = scopeError(() => statsScope(tree(), false, 'Missing', shown));
    expect(err.code).toBe('folder-not-found');
  });

  it('the displayed path is compared exactly (case-sensitive)', () => {
    const err = scopeError(() => statsScope(tree(), false, 'cafe', shown));
    expect(err.code).toBe('folder-not-found');
  });

  it('a value that itself holds an invisible character matches nothing through the display path', () => {
    const plain = treeOf([fi('Cafe')]);
    const err = scopeError(() => statsScope(plain, false, SOFT, shown));
    expect(err.code).toBe('folder-not-found');
  });

  it('a folder that matches only through displayPath and is \\Noselect → folder-not-found', () => {
    const noselect = treeOf([fi(SOFT, { selectable: false })]);
    const err = scopeError(() => statsScope(noselect, false, 'Cafe', shown));
    expect(err.code).toBe('folder-not-found');
  });

  it('an exact \\Noselect folder wins over a selectable folder that displays the same → folder-not-found', () => {
    const exactNoselect = treeOf([fi('Cafe', { selectable: false }), fi(SOFT)]);
    const err = scopeError(() => statsScope(exactNoselect, false, 'Cafe', shown));
    expect(err.code).toBe('folder-not-found');
  });

  it('INBOX in any case is still the INBOX rule, before the display fallback', () => {
    const t = treeOf([special('INBOX', 'inbox', 'path'), fi('in\u00adbox')]);
    expect(paths(statsScope(t, false, 'inbox', shown))).toEqual(['INBOX']);
    expect(paths(statsScope(t, false, 'INBOX', shown))).toEqual(['INBOX']);
  });

  it('Gmail: the fallback applies to any listed selectable folder', () => {
    const gmail = treeOf([special('[Gmail]/All Mail', 'all'), fi(SOFT)]);
    const r = statsScope(gmail, true, 'Cafe', shown);
    expect(paths(r)).toEqual([SOFT]);
    expect(r.notScanned).toBe(0);
  });

  it('displayPath is not consulted for the whole-mailbox scope (no folder given)', () => {
    const r = statsScope(tree(), false, undefined, shown);
    expect(paths(r)).toEqual(['INBOX', SOFT, PERSIAN, FAMILY, 'Work']);
  });
});

describe('collectStats: --folder through opts.displayPath', () => {
  const SOFT = 'Caf\u00ade';
  const shown = (path: string): string => path.replace(/[\u00ad\u200b-\u200f]/g, '');

  it('opts.displayPath reaches the scope: the folder is found by its displayed path and read', async () => {
    const { stats, calls } = await collect(
      [
        { path: SOFT, mails: mails(2) },
        { path: 'Work', mails: mails(5) },
      ],
      { folder: 'Cafe', displayPath: shown },
    );
    expect(calls.lock.map((l) => l.path)).toEqual([SOFT]);
    expect(stats.folders).toEqual([{ path: SOFT, messages: 2, bytes: 100 + 101, partial: false }]);
    expect(stats.notScanned).toBe(0);
  });

  it('without opts.displayPath the same --folder is folder-not-found, no lock taken', async () => {
    const { session, calls } = fakeSession([{ path: SOFT, mails: mails(2) }]);
    const err = await rejection(
      collectStats(session, treeOf([fi(SOFT)]), { timeZone: 'UTC', folder: 'Cafe' }),
    );
    expect(err).toBeInstanceOf(MailboxError);
    expect((err as MailboxError).code).toBe('folder-not-found');
    expect(calls.lock).toEqual([]);
  });
});
