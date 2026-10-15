import { describe, it, expect } from 'vitest';
import { searchCompiler } from 'imapflow/lib/search-compiler.js';
import type { SearchObject } from 'imapflow';
import type { Filter, FilterNode } from '../../src/core/filters/schema.js';
import { FilterError, compileFilter, passesChecks } from '../../src/core/filters/compile.js';
import type { Check, CompileOptions } from '../../src/core/filters/compile.js';

// M3b filter compile with dates: sent (spec): `dates: 'sent'` on the date leaves, the widened
// SENTSINCE / SENTBEFORE terms, passesChecks on the Date: header. The expected values come from
// the plan, not from code. Dates are UTC.

const DAY = 86_400_000;
const NOW = new Date('2026-10-12T12:00:00Z');
const dayStart = (y: number, m: number, d: number): Date => new Date(Date.UTC(y, m - 1, d));
const OPTS: CompileOptions = { now: NOW, dayStart };
const SENT: CompileOptions = { now: NOW, dayStart, dates: 'sent' };

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

const since23 = (): FilterNode => ({ kind: 'since', day: '2023-03-10' });
const before23 = (): FilterNode => ({ kind: 'before', day: '2023-03-10' });
const olderThanYear = (): FilterNode => ({ kind: 'olderThan', age: '1y' });
const newerThanMonth = (): FilterNode => ({ kind: 'newerThan', age: '30d' });

describe('compileFilter with dates: sent (M3b compile)', () => {
  it('sent since: a sent check and a SENTSINCE term widened by 2 days', () => {
    const compiled = compileFilter(filterOf(since23()), SENT);
    expect(compiled.checks).toEqual([
      { kind: 'sent', fromMs: Date.UTC(2023, 2, 10), beforeMs: null, want: true },
    ]);
    expect(compiled.query).toEqual({ sentSince: new Date(Date.UTC(2023, 2, 8)) });
    expect(compiled.needs.envelope).toBe(true);
  });

  it('sent before: a SENTBEFORE term widened by 2 days', () => {
    const compiled = compileFilter(filterOf(before23()), SENT);
    expect(compiled.checks).toEqual([
      { kind: 'sent', fromMs: null, beforeMs: Date.UTC(2023, 2, 10), want: true },
    ]);
    expect(compiled.query).toEqual({ sentBefore: new Date(Date.UTC(2023, 2, 12)) });
  });

  it('sent olderThan 1y: the check is the received instant, the term is widened', () => {
    const compiled = compileFilter(filterOf(olderThanYear()), SENT);
    expect(compiled.checks).toEqual([
      { kind: 'sent', fromMs: null, beforeMs: Date.UTC(2025, 9, 12, 12), want: true },
    ]);
    expect(compiled.query).toEqual({ sentBefore: new Date(Date.UTC(2025, 9, 14, 12)) });
  });

  it('sent newerThan 30d: the term is the check instant widened by 2 days', () => {
    const compiled = compileFilter(filterOf(newerThanMonth()), SENT);
    const fromMs = NOW.getTime() - 30 * DAY;
    expect(fromMs).toBe(Date.UTC(2026, 8, 12, 12));
    expect(compiled.checks).toEqual([{ kind: 'sent', fromMs, beforeMs: null, want: true }]);
    expect(compiled.query).toEqual({ sentSince: new Date(fromMs - 2 * DAY) });
  });

  it('sent since a future day: the check stays, no narrowing term is sent', () => {
    const compiled = compileFilter(filterOf({ kind: 'since', day: '2026-10-15' }), SENT);
    expect(compiled.query).toEqual({ all: true });
    expect(compiled.checks).toEqual([
      { kind: 'sent', fromMs: Date.UTC(2026, 9, 15), beforeMs: null, want: true },
    ]);
  });

  it('received is unchanged without dates and with dates: received', () => {
    const cases: { where: FilterNode; key: 'since' | 'before'; check: Check; query: unknown }[] = [
      {
        where: since23(),
        key: 'since',
        check: { kind: 'received', fromMs: Date.UTC(2023, 2, 10), beforeMs: null, want: true },
        query: { since: new Date(Date.UTC(2023, 2, 9)) },
      },
      {
        where: before23(),
        key: 'before',
        check: { kind: 'received', fromMs: null, beforeMs: Date.UTC(2023, 2, 10), want: true },
        query: { before: new Date(Date.UTC(2023, 2, 11)) },
      },
      {
        where: olderThanYear(),
        key: 'before',
        check: { kind: 'received', fromMs: null, beforeMs: Date.UTC(2025, 9, 12, 12), want: true },
        query: { before: new Date(Date.UTC(2025, 9, 13, 12)) },
      },
      {
        where: newerThanMonth(),
        key: 'since',
        check: { kind: 'received', fromMs: Date.UTC(2026, 8, 12, 12), beforeMs: null, want: true },
        query: { since: new Date(Date.UTC(2026, 8, 11, 12)) },
      },
    ];
    for (const { where, key, check, query } of cases) {
      const absent = compileFilter(filterOf(where), OPTS);
      const explicit = compileFilter(filterOf(where), { ...OPTS, dates: 'received' });
      expect(explicit, where.kind).toEqual(absent);
      expect(absent.query, where.kind).toEqual(query);
      expect(absent.checks, where.kind).toEqual([check]);
      expect(absent.query, where.kind).toHaveProperty(key);
      expect(absent.query).not.toHaveProperty('sentSince');
      expect(absent.query).not.toHaveProperty('sentBefore');
      expect(absent.needs.envelope, where.kind).toBe(false);
    }
  });

  it('negated sent date: the check turns around and no term is sent', () => {
    const compiled = compileFilter(filterOf({ kind: 'not', of: since23() }), SENT);
    expect(compiled.query).toEqual({ all: true });
    expect(compiled.checks).toEqual([
      { kind: 'sent', fromMs: Date.UTC(2023, 2, 10), beforeMs: null, want: false },
    ]);
  });

  it('criteria are unchanged by dates: sent since is criteria since', () => {
    const compiled = compileFilter(filterOf(since23()), SENT);
    expect(compiled.criteria).toEqual(['since']);
  });

  it('sent since and sent before together: both widened terms and both checks', () => {
    const compiled = compileFilter(
      filterOf({
        kind: 'all',
        of: [since23(), { kind: 'before', day: '2023-03-20' }],
      }),
      SENT,
    );
    expect(compiled.query).toEqual({
      sentSince: new Date(Date.UTC(2023, 2, 8)),
      sentBefore: new Date(Date.UTC(2023, 2, 22)),
    });
    expect(compiled.checks).toEqual([
      { kind: 'sent', fromMs: Date.UTC(2023, 2, 10), beforeMs: null, want: true },
      { kind: 'sent', fromMs: null, beforeMs: Date.UTC(2023, 2, 20), want: true },
    ]);
  });

  it('sent without a date term does not need the envelope', () => {
    const compiled = compileFilter(filterOf({ kind: 'hasAttachments', value: true }), SENT);
    expect(compiled.needs).toEqual({ envelope: false, structure: true });
  });

  it('a sent check inside any is unsupported, as a received check is', () => {
    let thrown: unknown;
    try {
      compileFilter(
        filterOf({ kind: 'any', of: [since23(), { kind: 'subject', value: 'a' }] }),
        SENT,
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(FilterError);
    expect((thrown as FilterError).code).toBe('unsupported');
  });

  it('imapflow compiles SENTSINCE and SENTBEFORE, with and without WITHIN', () => {
    const since = compileFilter(filterOf(since23()), SENT).query;
    const before = compileFilter(filterOf(before23()), SENT).query;
    const older = compileFilter(filterOf(olderThanYear()), SENT).query;

    for (const connection of [CONNECTION, CONNECTION_WITHIN]) {
      expect(imapText(since, connection)).toContain('SENTSINCE 08-Mar-2023');
      expect(imapText(before, connection)).toContain('SENTBEFORE 12-Mar-2023');
      // imapflow adds a day to a before date that is not midnight.
      expect(imapText(older, connection)).toContain('SENTBEFORE 15-Oct-2025');
      for (const query of [since, before, older]) {
        expect(imapText(query, connection)).not.toMatch(/YOUNGER|OLDER/);
      }
    }
  });

  it('passesChecks sent: reads the Date: header, a Date or an ISO string', () => {
    const T = Date.UTC(2023, 2, 10);
    const sent: Check = { kind: 'sent', fromMs: T, beforeMs: null, want: true };

    expect(passesChecks([sent], { envelope: { date: new Date(T) } })).toBe(true);
    expect(passesChecks([sent], { envelope: { date: new Date(T - 1) } })).toBe(false);
    expect(passesChecks([sent], { envelope: { date: new Date(T).toISOString() } })).toBe(true);

    for (const msg of [
      {},
      { envelope: undefined },
      { envelope: {} },
      { envelope: { date: 'garbage' } },
    ]) {
      expect(passesChecks([sent], msg)).toBe(false);
      expect(passesChecks([{ ...sent, want: false }], msg)).toBe(false);
    }
  });

  it('passesChecks sent ignores internalDate', () => {
    const T = Date.UTC(2023, 2, 10);
    const sent: Check = { kind: 'sent', fromMs: T, beforeMs: null, want: true };
    expect(
      passesChecks([sent], {
        internalDate: new Date(T + DAY),
        envelope: { date: new Date(T - 1) },
      }),
    ).toBe(false);
  });
});
