import { describe, it, expect } from 'vitest';
import type { Filter, FilterNode } from '../../src/core/filters/schema.js';
import { compileFilter } from '../../src/core/filters/compile.js';
import { parseFilterLine, parseSize } from '../../src/core/filters/line.js';
import type { LineError } from '../../src/core/filters/line.js';
import { lineErrorText, orderText } from '../../src/cli/filter-text.js';

// M3a filter line (spec): parseFilterLine and parseSize, plus the shell's texts for the line
// errors and the order names. The expected values come from the Line grammar, the Line errors
// and the text table of the plan, not from code. Placeholders only; hostile characters as escapes.

/** The filter of a line that must be read; fails the test when the line is refused. */
function filterOf(text: string): Filter {
  const result = parseFilterLine(text);
  if (!result.ok) throw new Error(`"${text}" was refused as ${result.error.code}`);
  return result.filter;
}

/** The terms (the `of` of the root `all`) of a line that must be read. */
function termsOf(text: string): FilterNode[] {
  const { where } = filterOf(text);
  if (where.kind !== 'all') throw new Error(`"${text}" is not an all node`);
  return where.of;
}

/** The error of a line that must be refused; fails the test when the line is read. */
function refusal(text: string): LineError {
  const result = parseFilterLine(text);
  if (result.ok) throw new Error(`"${text}" was read`);
  return result.error;
}

describe('parseFilterLine (M3a line grammar)', () => {
  it('a blank line is the empty filter', () => {
    expect(parseFilterLine('')).toEqual({
      ok: true,
      filter: { version: 1, where: { kind: 'all', of: [] } },
    });
    expect(parseFilterLine('   ')).toEqual({
      ok: true,
      filter: { version: 1, where: { kind: 'all', of: [] } },
    });
  });

  it('bare words', () => {
    expect(termsOf('shop faktura')).toEqual([
      { kind: 'word', value: 'shop' },
      { kind: 'word', value: 'faktura' },
    ]);
    expect(termsOf('"faktura 2023"')).toEqual([{ kind: 'word', value: 'faktura 2023' }]);
    expect(termsOf('"read"')).toEqual([{ kind: 'word', value: 'read' }]);
  });

  it('flag words, any letter case, and their negation', () => {
    expect(termsOf('unread')).toEqual([{ kind: 'seen', value: false }]);
    expect(termsOf('READ')).toEqual([{ kind: 'seen', value: true }]);
    expect(termsOf('flagged')).toEqual([{ kind: 'flagged', value: true }]);
    expect(termsOf('att')).toEqual([{ kind: 'hasAttachments', value: true }]);
    expect(termsOf('Att')).toEqual([{ kind: 'hasAttachments', value: true }]);
    expect(termsOf('-unread')).toEqual([{ kind: 'seen', value: true }]);
    expect(termsOf('-att')).toEqual([{ kind: 'hasAttachments', value: false }]);
    expect(termsOf('-flagged')).toEqual([{ kind: 'flagged', value: false }]);
  });

  it('keys', () => {
    expect(termsOf('from:shop')).toEqual([{ kind: 'from', values: ['shop'] }]);
    expect(termsOf('from:@shop.example,a@news.example')).toEqual([
      { kind: 'from', values: ['@shop.example', 'a@news.example'] },
    ]);
    expect(termsOf('to:x')).toEqual([{ kind: 'to', values: ['x'] }]);
    expect(termsOf('cc:x')).toEqual([{ kind: 'cc', values: ['x'] }]);
    expect(termsOf('subject:"faktura 2023"')).toEqual([{ kind: 'subject', value: 'faktura 2023' }]);
    expect(termsOf('SUBJECT:x')).toEqual([{ kind: 'subject', value: 'x' }]);
    expect(termsOf('older:1Y')).toEqual([{ kind: 'olderThan', age: '1y' }]);
    expect(termsOf('newer:30d')).toEqual([{ kind: 'newerThan', age: '30d' }]);
    expect(termsOf('since:2023-01-31')).toEqual([{ kind: 'since', day: '2023-01-31' }]);
    expect(termsOf('since:2023')).toEqual([{ kind: 'since', day: '2023-01-01' }]);
    expect(termsOf('before:2023-06')).toEqual([{ kind: 'before', day: '2023-06-01' }]);
    expect(termsOf('larger:5mb')).toEqual([{ kind: 'larger', bytes: 5242880 }]);
    expect(termsOf('smaller:500KB')).toEqual([{ kind: 'smaller', bytes: 512000 }]);
  });

  it('date forms', () => {
    expect(termsOf('date:2023')).toEqual([
      { kind: 'since', day: '2023-01-01' },
      { kind: 'before', day: '2024-01-01' },
    ]);
    expect(termsOf('date:2023-02')).toEqual([
      { kind: 'since', day: '2023-02-01' },
      { kind: 'before', day: '2023-03-01' },
    ]);
    expect(termsOf('date:2024-02-29')).toEqual([
      { kind: 'since', day: '2024-02-29' },
      { kind: 'before', day: '2024-03-01' },
    ]);
    expect(termsOf('date:2023-01..2023-06')).toEqual([
      { kind: 'since', day: '2023-01-01' },
      { kind: 'before', day: '2023-07-01' },
    ]);
    expect(termsOf('date:2023-01-15..2023-01-15')).toEqual([
      { kind: 'since', day: '2023-01-15' },
      { kind: 'before', day: '2023-01-16' },
    ]);
  });

  it('negation with -', () => {
    expect(termsOf('-shop')).toEqual([{ kind: 'not', of: { kind: 'word', value: 'shop' } }]);
    expect(termsOf('-from:@shop.example')).toEqual([
      { kind: 'not', of: { kind: 'from', values: ['@shop.example'] } },
    ]);
    expect(termsOf('-older:1y')).toEqual([{ kind: 'not', of: { kind: 'olderThan', age: '1y' } }]);
    expect(termsOf('-larger:5mb')).toEqual([
      { kind: 'not', of: { kind: 'larger', bytes: 5242880 } },
    ]);
    expect(termsOf('-"a b"')).toEqual([{ kind: 'not', of: { kind: 'word', value: 'a b' } }]);
    expect(termsOf('-')).toEqual([{ kind: 'word', value: '-' }]);
  });

  it('digits before a colon are a word', () => {
    expect(termsOf('10:30')).toEqual([{ kind: 'word', value: '10:30' }]);
    expect(termsOf('"re: hello"')).toEqual([{ kind: 'word', value: 're: hello' }]);
  });

  it('errors carry the token', () => {
    expect(refusal('subject:"abc')).toEqual({ code: 'unclosed-quote', token: 'subject:"abc' });
    expect(refusal('form:shop')).toEqual({ code: 'unknown-key', token: 'form:shop' });
    expect(refusal('from:')).toEqual({ code: 'empty-value', token: 'from:' });
    expect(refusal('from:,')).toEqual({ code: 'empty-value', token: 'from:,' });
    expect(refusal('subject:""')).toEqual({ code: 'empty-value', token: 'subject:""' });
    expect(refusal('older:soon')).toEqual({ code: 'bad-age', token: 'older:soon' });
    expect(refusal('older:0d')).toEqual({ code: 'bad-age', token: 'older:0d' });
    expect(refusal('since:2023-02-30')).toEqual({ code: 'bad-date', token: 'since:2023-02-30' });
    expect(refusal('date:2023-12..2023-01')).toEqual({
      code: 'bad-date',
      token: 'date:2023-12..2023-01',
    });
    expect(refusal('date:2100')).toEqual({ code: 'bad-date', token: 'date:2100' });
    expect(refusal('date:x')).toEqual({ code: 'bad-date', token: 'date:x' });
    expect(refusal('larger:5')).toEqual({ code: 'bad-size', token: 'larger:5' });
    expect(refusal('larger:big')).toEqual({ code: 'bad-size', token: 'larger:big' });
    expect(refusal('from:@shop.example,shop')).toEqual({
      code: 'mixed-addresses',
      token: 'from:@shop.example,shop',
    });
    expect(refusal('-date:2023')).toEqual({ code: 'no-negation', token: '-date:2023' });
    expect(refusal('a'.repeat(201))).toEqual({ code: 'too-long', token: '' });
    expect(refusal(Array.from({ length: 21 }, (_, i) => `w${i}`).join(' '))).toEqual({
      code: 'too-long',
      token: '',
    });
  });

  it('every ok result compiles', () => {
    const lines = [
      '',
      'shop faktura',
      '"faktura 2023"',
      'unread',
      '-att',
      'from:shop',
      'from:@shop.example,a@news.example',
      'subject:"faktura 2023"',
      'older:1y',
      'newer:30d',
      'since:2023-01-31',
      'before:2023-06',
      'larger:5mb',
      'smaller:500kb',
      'date:2023',
      'date:2023-01..2023-06',
      'date:2024-02-29',
      '-shop',
      '-from:@shop.example',
      '-older:1y',
      '-"a b"',
      '-',
      'x -unread',
      'from:@shop.example since:2023 -att',
    ];
    for (const line of lines) {
      expect(() => compileFilter(filterOf(line), { now: new Date(0) }), line).not.toThrow();
    }
  });

  // Additions beyond the plan: the boundaries of the line and the grammar's quoting rules.

  it('a line of 200 code points is read, 201 is too long; the count is by code point', () => {
    expect(termsOf('a'.repeat(200))).toEqual([{ kind: 'word', value: 'a'.repeat(200) }]);
    expect(termsOf('\u{1F600}'.repeat(200))).toEqual([
      { kind: 'word', value: '\u{1F600}'.repeat(200) },
    ]);
    expect(refusal('\u{1F600}'.repeat(201))).toEqual({ code: 'too-long', token: '' });
  });

  it('a line of 20 terms is read (21 is too long, see the errors)', () => {
    expect(termsOf(Array.from({ length: 20 }, (_, i) => `w${i}`).join(' ')).length).toBe(20);
  });

  it('a quote on its own is an unclosed quote, and an open quote takes the rest of the line', () => {
    expect(refusal('"')).toEqual({ code: 'unclosed-quote', token: '"' });
    expect(refusal('from:shop "x y')).toEqual({ code: 'unclosed-quote', token: '"x y' });
  });

  it('an unknown key keeps its minus sign in the token', () => {
    expect(refusal('-form:x')).toEqual({ code: 'unknown-key', token: '-form:x' });
  });
});

describe('parseSize (M3a line sizes)', () => {
  it('reads bytes, kb, mb and gb with a point or a comma', () => {
    expect(parseSize('300b')).toBe(300);
    expect(parseSize('500kb')).toBe(512000);
    expect(parseSize('5mb')).toBe(5242880);
    expect(parseSize('1.5gb')).toBe(1610612736);
    expect(parseSize('1,5mb')).toBe(1572864);
  });

  it('unreadable or outside 1..MAX_FILTER_BYTES is null', () => {
    for (const text of ['5', 'mb', '0mb', '5tb', '-5mb', '9999999gb']) {
      expect(parseSize(text), text).toBeNull();
    }
  });

  it('the largest size is 1024 gb, one more byte is outside', () => {
    expect(parseSize('1024gb')).toBe(1099511627776);
    expect(parseSize('0b')).toBeNull();
  });
});

describe('lineErrorText and orderText (M3a shell texts)', () => {
  const TOKEN = 'form:x';

  it('every code gives its tabled text with the token inside quotes', () => {
    expect(lineErrorText({ code: 'unclosed-quote', token: TOKEN })).toBe(
      'A quote (") is not closed.',
    );
    expect(lineErrorText({ code: 'unknown-key', token: TOKEN })).toBe(
      `Don't know "${TOKEN}" - the keys are from: to: cc: subject: older: newer: since: before: date: larger: smaller:`,
    );
    expect(lineErrorText({ code: 'empty-value', token: TOKEN })).toBe(
      `"${TOKEN}" needs a value, e.g. from:shop.sk`,
    );
    expect(lineErrorText({ code: 'bad-age', token: TOKEN })).toBe(
      `Can't read "${TOKEN}" - write an age like older:30d, older:6m or older:2y.`,
    );
    expect(lineErrorText({ code: 'bad-date', token: TOKEN })).toBe(
      `Can't read "${TOKEN}" - write a date like since:2023-01-31 or date:2023-01..2023-06.`,
    );
    expect(lineErrorText({ code: 'bad-size', token: TOKEN })).toBe(
      `Can't read "${TOKEN}" - write a size like larger:500kb or larger:5mb.`,
    );
    expect(lineErrorText({ code: 'mixed-addresses', token: TOKEN })).toBe(
      `"${TOKEN}" mixes addresses and plain words - use one kind per key.`,
    );
    expect(lineErrorText({ code: 'no-negation', token: TOKEN })).toBe(
      `"${TOKEN}" can't be turned around - use since: and before: instead.`,
    );
    expect(lineErrorText({ code: 'too-long', token: '' })).toBe(
      'The filter is too long - use fewer words.',
    );
    expect(lineErrorText({ code: 'unsupported', token: '' })).toBe(
      "This filter isn't supported yet - try a simpler one.",
    );
  });

  it('the texts are ASCII for an ASCII token', () => {
    const codes: LineError['code'][] = [
      'unclosed-quote',
      'unknown-key',
      'empty-value',
      'bad-age',
      'bad-date',
      'bad-size',
      'mixed-addresses',
      'no-negation',
      'too-long',
      'unsupported',
    ];
    for (const code of codes) {
      expect(lineErrorText({ code, token: TOKEN }), code).toMatch(/^[\x20-\x7e]*$/);
    }
  });

  it('a token with a right-to-left override is shown without it', () => {
    const text = lineErrorText({ code: 'bad-date', token: 'since:\u202E2023-01-01' });
    expect(text).not.toContain('\u202E');
    expect(text).toContain('2023-01-01');
  });

  it('a token with a control character is shown without it', () => {
    const text = lineErrorText({ code: 'empty-value', token: 'from:\u0007' });
    expect(text).not.toContain('\u0007');
  });

  it('orderText names the three orders', () => {
    expect(orderText('newest')).toBe('newest first');
    expect(orderText('oldest')).toBe('oldest first');
    expect(orderText('largest')).toBe('largest first');
  });
});
