import { describe, it, expect } from 'vitest';
import {
  EMPTY_FILTER,
  MAX_FILTER_BYTES,
  MAX_FILTER_DEPTH,
  MAX_FILTER_NODES,
  MAX_FILTER_TEXT,
  MAX_FILTER_VALUES,
  addressClass,
  parseAge,
  parseDay,
  parseFilter,
} from '../../src/core/filters/schema.js';
import type { FilterNode } from '../../src/core/filters/schema.js';

// M3a filter model v1 (spec): parseFilter and the helpers addressClass / parseDay / parseAge.
// Every expected value comes from the Interfaces, Rules and Tests of the plan, not from code.

const SEEN: FilterNode = { kind: 'seen', value: true };

/** Wraps one node as a filter document (the input is unknown, as it is at the boundary). */
function doc(where: unknown): unknown {
  return { version: 1, where };
}

function subject(value: string): unknown {
  return doc({ kind: 'subject', value });
}

describe('parseFilter (M3a schema)', () => {
  it('accepts one node of every kind', () => {
    const nodes: FilterNode[] = [
      { kind: 'from', values: ['shop'] },
      { kind: 'to', values: ['a@shop.example'] },
      { kind: 'cc', values: ['@shop.example'] },
      { kind: 'subject', value: 'faktura' },
      { kind: 'body', value: 'faktura' },
      { kind: 'text', value: 'faktura' },
      { kind: 'word', value: 'faktura' },
      { kind: 'since', day: '2023-01-31' },
      { kind: 'before', day: '2024-01-01' },
      { kind: 'olderThan', age: '30d' },
      { kind: 'newerThan', age: '2y' },
      { kind: 'larger', bytes: 5242880 },
      { kind: 'smaller', bytes: 500 },
      { kind: 'seen', value: false },
      { kind: 'flagged', value: true },
      { kind: 'answered', value: false },
      { kind: 'hasAttachments', value: true },
      { kind: 'any', of: [SEEN] },
      { kind: 'not', of: SEEN },
      { kind: 'all', of: [SEEN, { kind: 'word', value: 'x' }] },
    ];
    for (const where of nodes) {
      const input = doc(where);
      expect(parseFilter(input), where.kind).toEqual(input);
    }
  });

  it('EMPTY_FILTER is valid', () => {
    expect(parseFilter(EMPTY_FILTER)).not.toBeNull();
  });

  it('returns a fresh object, not the input', () => {
    const input = doc(SEEN);
    const out = parseFilter(input);
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
  });

  it('rejects unknown keys and a wrong version', () => {
    expect(parseFilter({ version: 2, where: { kind: 'all', of: [] } })).toBeNull();
    expect(parseFilter(subject('a'))).not.toBeNull();
    expect(
      parseFilter({ version: 1, where: { kind: 'subject', value: 'a', extra: 1 } }),
    ).toBeNull();
    expect(parseFilter({ version: 1, where: { kind: 'all', of: [] }, extra: true })).toBeNull();
  });

  it('text values: trimmed, 1..200 code points, no control character, no quote', () => {
    expect(parseFilter(subject(''))).toBeNull();
    expect(parseFilter(subject(' a'))).toBeNull();
    expect(parseFilter(subject('a '))).toBeNull();
    expect(parseFilter(subject('a'.repeat(MAX_FILTER_TEXT + 1)))).toBeNull();
    expect(parseFilter(subject('a\u0007b'))).toBeNull();
    expect(parseFilter(subject('a"b'))).toBeNull();
    expect(parseFilter(subject('ž'.repeat(MAX_FILTER_TEXT)))).not.toBeNull();
  });

  it('text values count code points, not UTF-16 units', () => {
    // An emoji is one code point but two UTF-16 units.
    expect(parseFilter(subject('\u{1F600}'.repeat(200)))).not.toBeNull();
    expect(parseFilter(subject('\u{1F600}'.repeat(201)))).toBeNull();
  });

  it('text values also refuse a control character in the word and body kinds', () => {
    expect(parseFilter(doc({ kind: 'word', value: 'a\u0000b' }))).toBeNull();
    expect(parseFilter(doc({ kind: 'body', value: 'a\u001fb' }))).toBeNull();
  });

  it('address values refuse a control character (AC1 reading: a control character is never accepted)', () => {
    expect(parseFilter(doc({ kind: 'from', values: ['shop\u0007'] }))).toBeNull();
    expect(parseFilter(doc({ kind: 'to', values: ['a@shop.example\u0007'] }))).toBeNull();
  });

  it('address leaves: at most 20 values, no mix of words and addresses', () => {
    const values = (n: number): string[] =>
      Array.from({ length: n }, (_, i) => `a${i}@shop.example`);
    expect(parseFilter(doc({ kind: 'from', values: values(MAX_FILTER_VALUES) }))).not.toBeNull();
    expect(parseFilter(doc({ kind: 'from', values: values(MAX_FILTER_VALUES + 1) }))).toBeNull();
    expect(parseFilter(doc({ kind: 'from', values: [] }))).toBeNull();
    expect(parseFilter(doc({ kind: 'from', values: ['@shop.example', 'shop'] }))).toBeNull();
    expect(
      parseFilter(doc({ kind: 'from', values: ['@shop.example', 'a@shop.example'] })),
    ).not.toBeNull();
    expect(parseFilter(doc({ kind: 'from', values: ['shop', 'news'] }))).not.toBeNull();
  });

  it('an address next to a plain word is refused, in either order', () => {
    expect(parseFilter(doc({ kind: 'to', values: ['a@shop.example', 'shop'] }))).toBeNull();
    expect(parseFilter(doc({ kind: 'to', values: ['shop', 'a@shop.example'] }))).toBeNull();
  });

  it('address entries follow the text rules too: trimmed, 1..200 code points, no quote', () => {
    expect(parseFilter(doc({ kind: 'from', values: [''] }))).toBeNull();
    expect(parseFilter(doc({ kind: 'from', values: [' shop'] }))).toBeNull();
    expect(parseFilter(doc({ kind: 'from', values: ['a"b'] }))).toBeNull();
    expect(
      parseFilter(doc({ kind: 'from', values: ['a'.repeat(MAX_FILTER_TEXT + 1)] })),
    ).toBeNull();
  });

  it('addressClass', () => {
    expect(addressClass('@shop.example')).toBe('domain');
    expect(addressClass('@shop')).toBe('part');
    expect(addressClass('a@shop.example')).toBe('address');
    expect(addressClass('shop')).toBe('part');
    expect(addressClass('a b@shop.example')).toBe('part');
  });

  it('parseDay: real calendar days in 1970..2100 only', () => {
    expect(parseDay('2023-02-28')).toEqual({ y: 2023, m: 2, d: 28 });
    expect(parseDay('2024-02-29')).toEqual({ y: 2024, m: 2, d: 29 });
    expect(parseDay('2023-02-30')).toBeNull();
    expect(parseDay('2023-02-29')).toBeNull();
    expect(parseDay('1969-12-31')).toBeNull();
    expect(parseDay('2101-01-01')).toBeNull();
    expect(parseDay('2023-2-3')).toBeNull();
    expect(parseDay('')).toBeNull();
  });

  it('parseAge: a count of 1..9999 and one unit d / w / m / y', () => {
    expect(parseAge('30d')).toEqual({ n: 30, unit: 'd' });
    expect(parseAge('2w')).toEqual({ n: 2, unit: 'w' });
    expect(parseAge('6m')).toEqual({ n: 6, unit: 'm' });
    expect(parseAge('2y')).toEqual({ n: 2, unit: 'y' });
    expect(parseAge('9999d')).toEqual({ n: 9999, unit: 'd' });
    expect(parseAge('0d')).toBeNull();
    expect(parseAge('10000d')).toBeNull();
    expect(parseAge('1h')).toBeNull();
    expect(parseAge('d')).toBeNull();
    expect(parseAge('-1d')).toBeNull();
  });

  it('dates, ages and sizes inside a filter are checked too', () => {
    expect(parseFilter(doc({ kind: 'since', day: '2023-02-30' }))).toBeNull();
    expect(parseFilter(doc({ kind: 'before', day: '1969-12-31' }))).toBeNull();
    expect(parseFilter(doc({ kind: 'olderThan', age: '0d' }))).toBeNull();
    expect(parseFilter(doc({ kind: 'newerThan', age: '1h' }))).toBeNull();
    expect(parseFilter(doc({ kind: 'since', day: '2023-02-28' }))).not.toBeNull();
    expect(parseFilter(doc({ kind: 'before', day: '2024-02-29' }))).not.toBeNull();
  });

  it('sizes: integers 1..MAX_FILTER_BYTES', () => {
    const larger = (bytes: number): unknown => doc({ kind: 'larger', bytes });
    expect(parseFilter(larger(0))).toBeNull();
    expect(parseFilter(larger(1.5))).toBeNull();
    expect(parseFilter(larger(MAX_FILTER_BYTES + 1))).toBeNull();
    expect(parseFilter(larger(1))).not.toBeNull();
    expect(parseFilter(larger(MAX_FILTER_BYTES))).not.toBeNull();
    expect(parseFilter(doc({ kind: 'smaller', bytes: 0 }))).toBeNull();
  });

  it('an empty any is refused, an empty all is fine, one member is enough for any', () => {
    expect(parseFilter(doc({ kind: 'any', of: [] }))).toBeNull();
    expect(parseFilter(doc({ kind: 'all', of: [] }))).not.toBeNull();
    expect(parseFilter(doc({ kind: 'any', of: [SEEN] }))).not.toBeNull();
  });

  it('one bad member makes the whole filter invalid', () => {
    expect(
      parseFilter(doc({ kind: 'all', of: [SEEN, { kind: 'subject', value: '' }] })),
    ).toBeNull();
  });

  it('not holds exactly one node', () => {
    expect(parseFilter(doc({ kind: 'not', of: [SEEN] }))).toBeNull();
    expect(parseFilter(doc({ kind: 'not', of: SEEN }))).not.toBeNull();
  });

  it('at most 50 nodes (the root included) and depth 6 (where is depth 1)', () => {
    const allOf = (n: number): unknown =>
      doc({ kind: 'all', of: Array.from({ length: n }, () => SEEN) });
    expect(MAX_FILTER_NODES).toBe(50);
    expect(parseFilter(allOf(MAX_FILTER_NODES - 1))).not.toBeNull();
    expect(parseFilter(allOf(MAX_FILTER_NODES))).toBeNull();

    const nots = (depth: number): unknown => {
      let node: unknown = SEEN;
      for (let i = 0; i < depth; i += 1) node = { kind: 'not', of: node };
      return doc(node);
    };
    expect(MAX_FILTER_DEPTH).toBe(6);
    expect(parseFilter(nots(MAX_FILTER_DEPTH - 1))).not.toBeNull();
    expect(parseFilter(nots(MAX_FILTER_DEPTH))).toBeNull();
  });

  it('never throws on junk', () => {
    expect(parseFilter(null)).toBeNull();
    expect(parseFilter(42)).toBeNull();
    expect(parseFilter('x')).toBeNull();
    expect(parseFilter([])).toBeNull();

    let deep: unknown = SEEN;
    for (let i = 0; i < 10_000; i += 1) deep = { kind: 'not', of: deep };
    expect(parseFilter(doc(deep))).toBeNull();
  });
});
