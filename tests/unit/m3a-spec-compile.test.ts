import { describe, it, expect } from 'vitest';
import { searchCompiler } from 'imapflow/lib/search-compiler.js';
import type { SearchObject } from 'imapflow';
import { EMPTY_FILTER, CRITERIA } from '../../src/core/filters/schema.js';
import type { Filter, FilterNode } from '../../src/core/filters/schema.js';
import {
  FilterError,
  ageCutoff,
  compileFilter,
  passesChecks,
} from '../../src/core/filters/compile.js';
import type { Check, CompileOptions } from '../../src/core/filters/compile.js';

// M3a filter compile (spec): compileFilter, ageCutoff and passesChecks. The expected values come
// from the Compile table, the Algorithm and the Rules of the plan, not from code. Dates are UTC.

const DAY = 86_400_000;
const NOW = new Date('2026-10-12T12:00:00Z');
const dayStart = (y: number, m: number, d: number): Date => new Date(Date.UTC(y, m - 1, d));
const OPTS: CompileOptions = { now: NOW, dayStart };

// The connection imapflow's compiler reads (capabilities, enabled extensions, the mailbox).
const CONNECTION = { capabilities: new Map(), enabled: new Set(), mailbox: { flags: new Set() } };
const CONNECTION_WITHIN = {
  capabilities: new Map([['WITHIN', true]]),
  enabled: new Set(),
  mailbox: { flags: new Set() },
};

/** The IMAP text of one search object, as imapflow's own compiler writes it (nested groups in parentheses). */
function imapText(query: SearchObject, connection: unknown = CONNECTION): string {
  return flatten(searchCompiler(connection as never, query));
}

function flatten(attrs: ReturnType<typeof searchCompiler>): string {
  return attrs
    .map((attr) => (Array.isArray(attr) ? `(${flatten(attr)})` : String(attr.value)))
    .join(' ');
}

function filterOf(where: FilterNode): Filter {
  return { version: 1, where };
}

/** The error compileFilter throws; fails the test when it does not throw a FilterError. */
function compileError(filter: Filter): FilterError {
  try {
    compileFilter(filter, OPTS);
  } catch (error) {
    if (error instanceof FilterError) return error;
    throw error;
  }
  throw new Error('compileFilter was expected to throw');
}

const word = (value: string): FilterNode => ({ kind: 'word', value });
const subject = (value: string): FilterNode => ({ kind: 'subject', value });
const fromDomain = (domain: string): FilterNode => ({ kind: 'from', values: [`@${domain}`] });

describe('compileFilter (M3a compile table)', () => {
  it('the empty filter matches everything', () => {
    const compiled = compileFilter(EMPTY_FILTER, OPTS);
    expect(compiled.query).toEqual({ all: true });
    expect(compiled.checks).toEqual([]);
    expect(compiled.criteria).toEqual([]);
    expect(compiled.needs).toEqual({ envelope: false, structure: false });
  });

  it('one test per row of the compile table', () => {
    const rows: { where: FilterNode; query: unknown; checks: Check[] }[] = [
      { where: { kind: 'from', values: ['shop'] }, query: { from: 'shop' }, checks: [] },
      {
        where: { kind: 'from', values: ['shop', 'news'] },
        query: { or: [{ from: 'shop' }, { from: 'news' }] },
        checks: [],
      },
      {
        where: { kind: 'from', values: ['anna@example-test-domain.eu'] },
        query: { from: 'anna@example-test-domain.eu' },
        checks: [
          {
            kind: 'address',
            field: 'from',
            addresses: ['anna@example-test-domain.eu'],
            domains: [],
            want: true,
          },
        ],
      },
      {
        where: { kind: 'to', values: ['@shop.example'] },
        query: { to: '@shop.example' },
        checks: [
          { kind: 'address', field: 'to', addresses: [], domains: ['shop.example'], want: true },
        ],
      },
      {
        where: { kind: 'cc', values: ['anna@example-test-domain.eu', '@shop.example'] },
        query: { or: [{ cc: 'anna@example-test-domain.eu' }, { cc: '@shop.example' }] },
        checks: [
          {
            kind: 'address',
            field: 'cc',
            addresses: ['anna@example-test-domain.eu'],
            domains: ['shop.example'],
            want: true,
          },
        ],
      },
      { where: { kind: 'subject', value: 'faktura' }, query: { subject: 'faktura' }, checks: [] },
      { where: { kind: 'body', value: 'faktura' }, query: { body: 'faktura' }, checks: [] },
      { where: { kind: 'text', value: 'faktura' }, query: { text: 'faktura' }, checks: [] },
      {
        where: word('faktura'),
        query: { or: [{ from: 'faktura' }, { subject: 'faktura' }] },
        checks: [],
      },
      { where: { kind: 'larger', bytes: 1048576 }, query: { larger: 1048576 }, checks: [] },
      { where: { kind: 'smaller', bytes: 500 }, query: { smaller: 500 }, checks: [] },
      { where: { kind: 'seen', value: false }, query: { seen: false }, checks: [] },
      { where: { kind: 'flagged', value: true }, query: { flagged: true }, checks: [] },
      { where: { kind: 'answered', value: false }, query: { answered: false }, checks: [] },
      {
        where: { kind: 'since', day: '2023-01-01' },
        query: { since: new Date(Date.UTC(2022, 11, 31)) },
        checks: [{ kind: 'received', fromMs: Date.UTC(2023, 0, 1), beforeMs: null, want: true }],
      },
      {
        where: { kind: 'before', day: '2023-01-01' },
        query: { before: new Date(Date.UTC(2023, 0, 2)) },
        checks: [{ kind: 'received', fromMs: null, beforeMs: Date.UTC(2023, 0, 1), want: true }],
      },
      {
        where: { kind: 'olderThan', age: '1y' },
        query: { before: new Date(Date.UTC(2025, 9, 13, 12)) },
        checks: [
          { kind: 'received', fromMs: null, beforeMs: Date.UTC(2025, 9, 12, 12), want: true },
        ],
      },
      {
        where: { kind: 'newerThan', age: '30d' },
        query: { since: new Date(Date.UTC(2026, 8, 11, 12)) },
        checks: [
          { kind: 'received', fromMs: Date.UTC(2026, 8, 12, 12), beforeMs: null, want: true },
        ],
      },
      {
        where: { kind: 'hasAttachments', value: true },
        query: { all: true },
        checks: [{ kind: 'attachment', want: true }],
      },
      {
        where: { kind: 'hasAttachments', value: false },
        query: { all: true },
        checks: [{ kind: 'attachment', want: false }],
      },
    ];
    for (const row of rows) {
      const compiled = compileFilter(filterOf(row.where), OPTS);
      expect(compiled.query, row.where.kind).toEqual(row.query);
      expect(compiled.checks, row.where.kind).toEqual(row.checks);
    }
  });

  it('one test per row of the compile table: the needs of the checks', () => {
    expect(compileFilter(filterOf({ kind: 'hasAttachments', value: true }), OPTS).needs).toEqual({
      envelope: false,
      structure: true,
    });
    expect(compileFilter(filterOf(fromDomain('shop.example')), OPTS).needs).toEqual({
      envelope: true,
      structure: false,
    });
  });

  it('not of a checked leaf turns the check around and sends no term', () => {
    const fromShop = compileFilter(filterOf({ kind: 'not', of: fromDomain('shop.example') }), OPTS);
    expect(fromShop.query).toEqual({ all: true });
    expect(fromShop.checks).toEqual([
      { kind: 'address', field: 'from', addresses: [], domains: ['shop.example'], want: false },
    ]);

    const noAttachments = compileFilter(
      filterOf({ kind: 'not', of: { kind: 'hasAttachments', value: true } }),
      OPTS,
    );
    expect(noAttachments.query).toEqual({ all: true });
    expect(noAttachments.checks).toEqual([{ kind: 'attachment', want: false }]);

    const notSince = compileFilter(
      filterOf({ kind: 'not', of: { kind: 'since', day: '2023-01-01' } }),
      OPTS,
    );
    expect(notSince.query).toEqual({ all: true });
    expect(notSince.checks).toEqual([
      { kind: 'received', fromMs: Date.UTC(2023, 0, 1), beforeMs: null, want: false },
    ]);
  });

  it('pure subtrees go to the server whole', () => {
    const either = compileFilter(filterOf({ kind: 'any', of: [subject('a'), subject('b')] }), OPTS);
    expect(either.query).toEqual({ or: [{ subject: 'a' }, { subject: 'b' }] });
    expect(either.checks).toEqual([]);

    const neither = compileFilter(
      filterOf({ kind: 'not', of: { kind: 'any', of: [subject('a'), subject('b')] } }),
      OPTS,
    );
    expect(neither.query).toEqual({ not: { or: [{ subject: 'a' }, { subject: 'b' }] } });

    const all = compileFilter(
      filterOf({
        kind: 'all',
        of: [
          { kind: 'seen', value: false },
          { kind: 'larger', bytes: 1048576 },
          { kind: 'not', of: { kind: 'from', values: ['a'] } },
        ],
      }),
      OPTS,
    );
    expect(all.query).toEqual({ seen: false, larger: 1048576, not: { from: 'a' } });
  });

  it('and: same key twice uses the one-element or slot', () => {
    const compiled = compileFilter(
      filterOf({ kind: 'all', of: [subject('a'), subject('b')] }),
      OPTS,
    );
    expect(compiled.query).toEqual({ subject: 'a', or: [{ subject: 'b' }] });
  });

  it('and: two words use the not-not slot', () => {
    const compiled = compileFilter(filterOf({ kind: 'all', of: [word('x'), word('y')] }), OPTS);
    expect(compiled.query).toEqual({
      or: [{ from: 'x' }, { subject: 'x' }],
      not: { not: { or: [{ from: 'y' }, { subject: 'y' }] } },
    });
  });

  it("the compiled objects mean AND in imapflow's own compiler", () => {
    expect(imapText({ subject: 'a', or: [{ subject: 'b' }] })).toBe('SUBJECT a SUBJECT b');
    expect(
      imapText({
        or: [{ from: 'x' }, { subject: 'x' }],
        not: { not: { or: [{ from: 'y' }, { subject: 'y' }] } },
      }),
    ).toBe('OR FROM x SUBJECT x NOT NOT OR FROM y SUBJECT y');
    expect(
      imapText({ seen: false, larger: 1048576, not: { or: [{ from: 'a' }, { from: 'b' }] } }),
    ).toBe('UNSEEN LARGER 1048576 NOT OR FROM a FROM b');
    expect(
      imapText({ since: new Date(Date.UTC(2023, 0, 1)), before: new Date(Date.UTC(2024, 0, 1)) }),
    ).toBe('SINCE 01-Jan-2023 BEFORE 01-Jan-2024');

    // The same three shapes come out of compileFilter for the matching filters.
    const twoSubjects = compileFilter(
      filterOf({ kind: 'all', of: [subject('a'), subject('b')] }),
      OPTS,
    );
    expect(imapText(twoSubjects.query)).toBe('SUBJECT a SUBJECT b');
    const twoWords = compileFilter(filterOf({ kind: 'all', of: [word('x'), word('y')] }), OPTS);
    expect(imapText(twoWords.query)).toBe('OR FROM x SUBJECT x NOT NOT OR FROM y SUBJECT y');
    const notAny = compileFilter(
      filterOf({
        kind: 'all',
        of: [
          { kind: 'seen', value: false },
          { kind: 'larger', bytes: 1048576 },
          {
            kind: 'not',
            of: {
              kind: 'any',
              of: [
                { kind: 'from', values: ['a'] },
                { kind: 'from', values: ['b'] },
              ],
            },
          },
        ],
      }),
      OPTS,
    );
    expect(imapText(notAny.query)).toBe('UNSEEN LARGER 1048576 NOT OR FROM a FROM b');
  });

  it('three words: each term is searched once and no ALL is sent', () => {
    const compiled = compileFilter(
      filterOf({ kind: 'all', of: [word('x'), word('y'), word('z')] }),
      OPTS,
    );
    const tokens = imapText(compiled.query).split(' ');
    for (const name of ['x', 'y', 'z']) {
      expect(
        tokens.filter((token, i) => token === 'FROM' && tokens[i + 1] === name),
        name,
      ).toHaveLength(1);
    }
    expect(tokens).not.toContain('ALL');
  });

  it('nested all is flattened', () => {
    const nested = compileFilter(
      filterOf({
        kind: 'all',
        of: [
          { kind: 'all', of: [subject('a'), fromDomain('shop.example')] },
          { kind: 'seen', value: true },
        ],
      }),
      OPTS,
    );
    const flat = compileFilter(
      filterOf({
        kind: 'all',
        of: [subject('a'), fromDomain('shop.example'), { kind: 'seen', value: true }],
      }),
      OPTS,
    );
    expect(nested).toEqual(flat);
  });

  it('a checked leaf inside any, or inside a compound not, is unsupported', () => {
    const cases: Filter[] = [
      filterOf({ kind: 'any', of: [fromDomain('shop.example'), subject('a')] }),
      filterOf({
        kind: 'not',
        of: { kind: 'all', of: [{ kind: 'since', day: '2023-01-01' }, subject('a')] },
      }),
      filterOf({ kind: 'any', of: [{ kind: 'hasAttachments', value: true }] }),
      filterOf({ kind: 'not', of: { kind: 'not', of: { kind: 'since', day: '2023-01-01' } } }),
    ];
    for (const filter of cases) {
      expect(compileError(filter).code).toBe('unsupported');
    }
  });

  it('an invalid filter throws invalid', () => {
    const error = compileError(filterOf({ kind: 'subject', value: '' }));
    expect(error).toBeInstanceOf(FilterError);
    expect(error.code).toBe('invalid');
  });

  it('criteria: names only, no duplicates, CRITERIA order', () => {
    const compiled = compileFilter(
      filterOf({
        kind: 'all',
        of: [
          word('CANARYWORD'),
          { kind: 'not', of: fromDomain('secret-domain.example') },
          { kind: 'any', of: [subject('canaryone'), subject('canarytwo')] },
          { kind: 'larger', bytes: 7654321 },
        ],
      }),
      OPTS,
    );
    expect(compiled.criteria).toEqual(['from', 'subject', 'word', 'larger', 'any', 'not']);
    expect(compiled.criteria.every((name) => CRITERIA.includes(name))).toBe(true);
    const json = JSON.stringify(compiled.criteria);
    for (const value of ['CANARYWORD', 'secret-domain', 'canaryone', 'canarytwo', '7654321']) {
      expect(json).not.toContain(value);
    }
  });

  it('a narrowing date at or after now is left out', () => {
    const olderThanOneDay = compileFilter(filterOf({ kind: 'olderThan', age: '1d' }), OPTS);
    expect(olderThanOneDay.query).toEqual({ all: true });
    expect(olderThanOneDay.checks).toEqual([
      { kind: 'received', fromMs: null, beforeMs: NOW.getTime() - DAY, want: true },
    ]);

    const beforeToday = compileFilter(filterOf({ kind: 'before', day: '2026-10-12' }), OPTS);
    expect(beforeToday.query).toEqual({ all: true });
    expect(beforeToday.checks).toEqual([
      { kind: 'received', fromMs: null, beforeMs: Date.UTC(2026, 9, 12), want: true },
    ]);

    const beforeNewYear = compileFilter(filterOf({ kind: 'before', day: '2027-01-01' }), OPTS);
    expect(beforeNewYear.query).toEqual({ all: true });
    expect(beforeNewYear.checks).toEqual([
      { kind: 'received', fromMs: null, beforeMs: Date.UTC(2027, 0, 1), want: true },
    ]);

    const sinceAhead = compileFilter(filterOf({ kind: 'since', day: '2026-10-14' }), OPTS);
    expect(sinceAhead.query).toEqual({ all: true });
    expect(sinceAhead.checks).toEqual([
      { kind: 'received', fromMs: Date.UTC(2026, 9, 14), beforeMs: null, want: true },
    ]);

    const beforePast = compileFilter(filterOf({ kind: 'before', day: '2026-10-10' }), OPTS);
    expect(beforePast.query).toEqual({ before: new Date(Date.UTC(2026, 9, 11)) });
    expect(beforePast.checks).toEqual([
      { kind: 'received', fromMs: null, beforeMs: Date.UTC(2026, 9, 10), want: true },
    ]);

    // Boundary: the narrowing date of since 2026-10-13 is 2026-10-12 00:00, clearly in the past.
    const sinceYesterday = compileFilter(filterOf({ kind: 'since', day: '2026-10-13' }), OPTS);
    expect(sinceYesterday.query).toEqual({ since: new Date(Date.UTC(2026, 9, 12)) });
  });

  it('no OLDER 0 / YOUNGER 0 with WITHIN', () => {
    const now = new Date();
    const dayOf = (offset: number): string =>
      new Date(now.getTime() + offset * DAY).toISOString().slice(0, 10);
    const real: CompileOptions = { now, dayStart };

    const olderThanOneDay = compileFilter(filterOf({ kind: 'olderThan', age: '1d' }), real);
    expect(imapText(olderThanOneDay.query, CONNECTION_WITHIN)).toBe('ALL');

    const beforeToday = compileFilter(filterOf({ kind: 'before', day: dayOf(0) }), real);
    expect(imapText(beforeToday.query, CONNECTION_WITHIN)).toBe('ALL');

    // since <tomorrow> narrows from today 00:00 UTC, a past instant, so it is sent as YOUNGER with
    // a positive count. Only in the first minute of a UTC day is today 00:00 too recent to use,
    // and then the term is dropped and the text is ALL. Either way no zero count comes out.
    const sinceTomorrow = compileFilter(filterOf({ kind: 'since', day: dayOf(1) }), real);
    expect(imapText(sinceTomorrow.query, CONNECTION_WITHIN)).toMatch(/^(ALL|YOUNGER [1-9]\d*)$/);

    const sinceAfterTomorrow = compileFilter(filterOf({ kind: 'since', day: dayOf(2) }), real);
    expect(imapText(sinceAfterTomorrow.query, CONNECTION_WITHIN)).toBe('ALL');

    const olderThanMonth = compileFilter(filterOf({ kind: 'olderThan', age: '30d' }), real);
    expect(imapText(olderThanMonth.query, CONNECTION_WITHIN)).toMatch(/^OLDER [1-9]\d*$/);
  });

  it('ageCutoff never goes before 1970', () => {
    expect(ageCutoff(NOW, '9999y')).toEqual(new Date(0));
  });

  it('ageCutoff', () => {
    expect(ageCutoff(NOW, '30d')).toEqual(new Date('2026-09-12T12:00:00Z'));
    expect(ageCutoff(NOW, '2w')).toEqual(new Date('2026-09-28T12:00:00Z'));
    expect(ageCutoff(NOW, '1m')).toEqual(new Date('2026-09-12T12:00:00Z'));
    expect(ageCutoff(NOW, '1y')).toEqual(new Date('2025-10-12T12:00:00Z'));
    expect(ageCutoff(new Date('2026-03-31T08:00:00Z'), '1m')).toEqual(
      new Date('2026-02-28T08:00:00Z'),
    );
    expect(ageCutoff(new Date('2024-02-29T00:00:00Z'), '1y')).toEqual(
      new Date('2023-02-28T00:00:00Z'),
    );
  });

  it('passesChecks: address', () => {
    const fromShop: Check = {
      kind: 'address',
      field: 'from',
      addresses: [],
      domains: ['shop.example'],
      want: true,
    };
    const sender = (address: string): unknown => ({ from: [{ address }] });

    expect(passesChecks([fromShop], { envelope: sender('News@Shop.Example') })).toBe(true);
    expect(passesChecks([fromShop], { envelope: sender('news@shop.example.evil.test') })).toBe(
      false,
    );
    expect(passesChecks([fromShop], { envelope: sender('news@sub.shop.example') })).toBe(false);

    const exact: Check = {
      kind: 'address',
      field: 'from',
      addresses: ['anna@example-test-domain.eu'],
      domains: [],
      want: true,
    };
    expect(passesChecks([exact], { envelope: sender('Anna@Example-Test-Domain.EU') })).toBe(true);
    expect(passesChecks([exact], { envelope: sender('anna2@example-test-domain.eu') })).toBe(false);

    const notFromShop: Check = { ...fromShop, want: false };
    expect(passesChecks([notFromShop], { envelope: sender('News@Shop.Example') })).toBe(false);
    expect(passesChecks([notFromShop], { envelope: sender('news@sub.shop.example') })).toBe(true);

    for (const envelope of [{}, { from: 'news@shop.example' }, { from: null }, undefined]) {
      expect(passesChecks([fromShop], { envelope })).toBe(false);
      expect(passesChecks([notFromShop], { envelope })).toBe(true);
    }

    const toShop: Check = { ...fromShop, field: 'to' };
    expect(passesChecks([toShop], { envelope: { to: [{ address: 'news@shop.example' }] } })).toBe(
      true,
    );
    expect(passesChecks([toShop], { envelope: { from: [{ address: 'news@shop.example' }] } })).toBe(
      false,
    );
    const ccShop: Check = { ...fromShop, field: 'cc' };
    expect(passesChecks([ccShop], { envelope: { cc: [{ address: 'news@shop.example' }] } })).toBe(
      true,
    );

    const second = {
      from: [{ address: 'other@other.example' }, { address: 'anna@example-test-domain.eu' }],
    };
    expect(passesChecks([exact], { envelope: second })).toBe(true);
  });

  it('passesChecks: received', () => {
    const T = Date.UTC(2023, 0, 1);
    const from: Check = { kind: 'received', fromMs: T, beforeMs: null, want: true };
    const before: Check = { kind: 'received', fromMs: null, beforeMs: T, want: true };
    const at = (ms: number): { internalDate: Date } => ({ internalDate: new Date(ms) });

    expect(passesChecks([from], at(T))).toBe(true);
    expect(passesChecks([from], at(T - 1))).toBe(false);
    expect(passesChecks([before], at(T - 1))).toBe(true);
    expect(passesChecks([before], at(T))).toBe(false);

    const withoutDate = {};
    const invalid = { internalDate: 'not a date' };
    for (const msg of [withoutDate, invalid]) {
      expect(passesChecks([from], msg)).toBe(false);
      expect(passesChecks([{ ...from, want: false }], msg)).toBe(false);
    }
  });

  it('passesChecks: received with no bounds passes every dated message', () => {
    const unbounded: Check = { kind: 'received', fromMs: null, beforeMs: null, want: true };
    expect(passesChecks([unbounded], { internalDate: new Date(0) })).toBe(true);
  });

  it('passesChecks: attachment', () => {
    const mixed = {
      type: 'multipart/mixed',
      childNodes: [{ type: 'text/plain' }, { type: 'application/pdf', disposition: 'attachment' }],
    };
    const attached: Check = { kind: 'attachment', want: true };
    expect(passesChecks([attached], { bodyStructure: mixed })).toBe(true);
    expect(passesChecks([attached], { bodyStructure: { type: 'text/plain' } })).toBe(false);
    expect(
      passesChecks([{ kind: 'attachment', want: false }], {
        bodyStructure: { type: 'text/plain' },
      }),
    ).toBe(true);
  });

  it('no checks pass everything', () => {
    expect(passesChecks([], {})).toBe(true);
  });

  it('the messages of the errors are fixed', () => {
    const invalid = compileError(filterOf({ kind: 'subject', value: '' }));
    expect(invalid.name).toBe('FilterError');
    expect(invalid.message).toBe('The filter is not valid');

    const unsupported = compileError(
      filterOf({ kind: 'any', of: [fromDomain('shop.example'), subject('a')] }),
    );
    expect(unsupported.name).toBe('FilterError');
    expect(unsupported.message).toBe('This combination of criteria is not supported yet');
  });

  it('an unreadable age is invalid for ageCutoff', () => {
    expect(() => ageCutoff(NOW, 'soon')).toThrow(FilterError);
  });

  it('addresses are lower-cased in the check and written as typed in the query', () => {
    const compiled = compileFilter(
      filterOf({ kind: 'from', values: ['Anna@Example-Test-Domain.EU', '@Shop.Example'] }),
      OPTS,
    );
    expect(compiled.query).toEqual({
      or: [{ from: 'Anna@Example-Test-Domain.EU' }, { from: '@Shop.Example' }],
    });
    expect(compiled.checks).toEqual([
      {
        kind: 'address',
        field: 'from',
        addresses: ['anna@example-test-domain.eu'],
        domains: ['shop.example'],
        want: true,
      },
    ]);
  });

  it('any with one pure member is that member', () => {
    const compiled = compileFilter(
      filterOf({ kind: 'any', of: [{ kind: 'seen', value: true }] }),
      OPTS,
    );
    expect(compiled.query).toEqual({ seen: true });
  });
});
