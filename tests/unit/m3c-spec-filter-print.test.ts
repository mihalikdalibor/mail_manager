import { describe, it, expect } from 'vitest';
import { parseFilterLine, printFilterLine } from '../../src/core/filters/line.js';
import type { Filter, FilterNode } from '../../src/core/filters/schema.js';

// M3c printFilterLine (spec): the filter line and body text that parse back to the same filter,
// or null for a filter the line can't express. Inputs are typed with parseFilterLine (M3a); the
// expected lines and bodies are written out here, not derived from the printer.

const LONG_LINE = [
  'date:2023',
  'from:@shop00-mail.example',
  'from:@shop01-mail.example',
  'from:@shop02-mail.example',
  'from:@shop03-mail.example',
  'from:@shop04-mail.example',
  'from:@shop05-mail.example',
  'from:@last-shop-mails.example',
].join(' ');

function parsed(text: string): Filter {
  const result = parseFilterLine(text);
  if (!result.ok) throw new Error(`fixture does not parse: ${text}`);
  return result.filter;
}

function root(...of: FilterNode[]): Filter {
  return { version: 1, where: { kind: 'all', of } };
}

function termsOf(text: string): FilterNode[] {
  const filter = parsed(text);
  if (filter.where.kind !== 'all') throw new Error(`fixture is not an all-of root: ${text}`);
  return filter.where.of;
}

/** The printed line and body; throws when the filter is not printable (a fixture error). */
function printed(filter: Filter): { line: string; body: string | null } {
  const result = printFilterLine(filter);
  if (result === null) throw new Error('fixture is not printable');
  return result;
}

/**
 * Parses the printed line the way a user would type it: split at spaces into pieces of at most
 * 200 characters, each parsed on its own. The pieces' terms, in order, are the filter.
 */
function reparseInPieces(line: string): Filter {
  const pieces: string[] = [];
  let current = '';
  for (const token of line.split(' ')) {
    const next = current === '' ? token : `${current} ${token}`;
    if ([...next].length > 200) {
      pieces.push(current);
      current = token;
    } else {
      current = next;
    }
  }
  pieces.push(current);
  const terms: FilterNode[] = [];
  for (const piece of pieces) {
    const result = parseFilterLine(piece);
    if (!result.ok) throw new Error(`piece does not parse: ${piece}`);
    if (result.filter.where.kind !== 'all') throw new Error('piece is not an all-of root');
    terms.push(...result.filter.where.of);
  }
  return root(...terms);
}

describe('round trip', () => {
  it.each([
    'from:@shop.sk older:1y larger:1mb',
    '-att unread',
    'read flagged -flagged',
    '"two words" subject:"a b"',
    '-from:a@x.sk,b@y.sk -subject:x',
    'to:"John Smith"',
    'cc:@a.sk newer:30d',
    'since:2023-05-01 before:2024-01-01',
    'date:2023',
    'smaller:300b larger:1.5mb',
    '"-dash" "unread" "key:value"',
  ])('%s prints a line that parses back to the same filter', (text) => {
    const filter = parsed(text);
    const result = printed(filter);
    expect(result.body).toBeNull();
    expect(parseFilterLine(result.line)).toEqual({ ok: true, filter });
  });
});

describe('exact text', () => {
  it('a typed line with from, older and larger prints back exactly as typed', () => {
    expect(printed(parsed('from:@shop.sk older:1y larger:1mb'))).toEqual({
      line: 'from:@shop.sk older:1y larger:1mb',
      body: null,
    });
  });

  it('a size that is not a whole MB prints in KB: larger:1536kb', () => {
    expect(printed(parsed('larger:1536kb'))).toEqual({ line: 'larger:1536kb', body: null });
  });

  it('a whole number of MB prints as MB: larger:1048576b → larger:1mb', () => {
    expect(printed(parsed('larger:1048576b'))).toEqual({ line: 'larger:1mb', body: null });
  });

  it('no terms at all print an empty line with no body', () => {
    expect(printFilterLine(root())).toEqual({ line: '', body: null });
  });

  it('a date pair prints as since and before, which parse back to the same two leaves', () => {
    expect(printed(parsed('date:2023'))).toEqual({
      line: 'since:2023-01-01 before:2024-01-01',
      body: null,
    });
  });

  it.each([
    ['unread', '"unread"'],
    ['key:value', '"key:value"'],
    ['-dash', '"-dash"'],
    ['two words', '"two words"'],
    ['plain', 'plain'],
  ])('the word %j prints as %s', (value, expected) => {
    expect(printed(root({ kind: 'word', value }))).toEqual({ line: expected, body: null });
  });
});

describe('body last', () => {
  it('the last body leaf is the body; the line holds the other terms', () => {
    const filter = root(...termsOf('older:1y'), { kind: 'body', value: 'invoice' });
    expect(printed(filter)).toEqual({ line: 'older:1y', body: 'invoice' });
  });

  it('a filter with only a body prints an empty line and the body', () => {
    expect(printed(root({ kind: 'body', value: 'invoice' }))).toEqual({
      line: '',
      body: 'invoice',
    });
  });

  it('a lone body root prints an empty line and the body', () => {
    expect(printFilterLine({ version: 1, where: { kind: 'body', value: 'invoice' } })).toEqual({
      line: '',
      body: 'invoice',
    });
  });

  it('a body leaf that is not last → null', () => {
    expect(
      printFilterLine(root({ kind: 'body', value: 'invoice' }, { kind: 'olderThan', age: '1y' })),
    ).toBeNull();
  });

  it('two body leaves → null', () => {
    expect(
      printFilterLine(
        root(
          { kind: 'body', value: 'invoice' },
          { kind: 'olderThan', age: '1y' },
          { kind: 'body', value: 'receipt' },
        ),
      ),
    ).toBeNull();
  });
});

describe('not printable', () => {
  it.each<[string, FilterNode]>([
    ['any', { kind: 'any', of: [{ kind: 'word', value: 'a' }] }],
    ['text', { kind: 'text', value: 'a' }],
    ['answered', { kind: 'answered', value: true }],
    ['not(seen)', { kind: 'not', of: { kind: 'seen', value: true } }],
  ])('%s has no line form → null', (_name, node) => {
    expect(printFilterLine(root(node))).toBeNull();
    expect(printFilterLine({ version: 1, where: node })).toBeNull();
  });
});

describe('long line', () => {
  it('the typed fixture is 190 to 199 characters and parses', () => {
    expect([...LONG_LINE].length).toBeGreaterThanOrEqual(190);
    expect([...LONG_LINE].length).toBeLessThanOrEqual(199);
    expect(parseFilterLine(LONG_LINE).ok).toBe(true);
  });

  it('prints a line over 200 characters that round-trips in pieces', () => {
    const filter = parsed(LONG_LINE);
    const result = printed(filter);
    expect([...result.line].length).toBeGreaterThan(200);
    expect(result.body).toBeNull();
    expect(reparseInPieces(result.line)).toEqual(filter);
  });
});

describe('lone leaf', () => {
  it('a root that is a single leaf prints as that one term', () => {
    expect(printFilterLine({ version: 1, where: { kind: 'larger', bytes: 1048576 } })).toEqual({
      line: 'larger:1mb',
      body: null,
    });
  });
});
