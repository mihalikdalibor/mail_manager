import { isDeepStrictEqual } from 'node:util';
import { compileFilter, FilterError } from './compile.js';
import {
  FILTER_VERSION,
  MAX_FILTER_BYTES,
  addressClass,
  parseAge,
  parseDay,
  parseFilter,
  type AddressField,
  type Filter,
  type FilterNode,
} from './schema.js';

// The typed filter line (M3a): what the user types in the app's filter line becomes a Filter.
// Bare words and quoted phrases, `key:value` terms, the flag words, and a leading `-` for "not".
// A term that can't be read gives a typed error with the token as typed; the shell shows it
// (src/cli/filter-text.ts) and nothing is logged. The printer (M3c) writes a filter back as such a
// line and checks that it parses back to the same filter. Pure: no IMAP, no clock.

export const MAX_FILTER_LINE = 200; // code points
export const MAX_LINE_TERMS = 20;

export type LineErrorCode =
  | 'unclosed-quote'
  | 'unknown-key'
  | 'empty-value'
  | 'bad-age'
  | 'bad-date'
  | 'bad-size'
  | 'mixed-addresses'
  | 'no-negation'
  | 'too-long'
  | 'unsupported';

export interface LineError {
  code: LineErrorCode;
  /** The token as typed (quotes and `-` included); '' for too-long / unsupported. */
  token: string;
}

export type LineResult = { ok: true; filter: Filter } | { ok: false; error: LineError };

/** The terms one token means, or the error that stops the line. */
type TermsResult = { terms: FilterNode[] } | { error: LineError };

const KEY_RE = /^([A-Za-z]+):/;
const PERIOD_RE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;
const SIZE_RE = /^(\d+(?:[.,]\d+)?)(b|kb|mb|gb)$/i;
const UNIT_POWER = new Map([
  ['b', 0],
  ['kb', 1],
  ['mb', 2],
  ['gb', 3],
]);

export function parseFilterLine(text: string): LineResult {
  return parseLine(text, true);
}

/**
 * `capped` false leaves out the length check: the printer verifies lines that can be longer than
 * a typed one (`date:2023` prints as two terms). Nothing else differs.
 */
function parseLine(text: string, capped: boolean): LineResult {
  if (capped && [...text].length > MAX_FILTER_LINE) return fail('too-long', '');
  const { tokens, unclosed } = tokenize(text);
  if (unclosed !== null) return fail('unclosed-quote', unclosed);
  const terms: FilterNode[] = [];
  for (const raw of tokens) {
    const found = termsOf(raw);
    if ('error' in found) return { ok: false, error: found.error };
    terms.push(...found.terms);
  }
  if (terms.length > MAX_LINE_TERMS) return fail('too-long', '');
  const parsed = parseFilter({ version: FILTER_VERSION, where: { kind: 'all', of: terms } });
  if (parsed === null || !compiles(parsed)) return fail('unsupported', '');
  return { ok: true, filter: parsed };
}

/**
 * `500kb`, `5mb`, `1.5gb`, `1,5mb`, `300b` → bytes (base 1024, rounded); null when unreadable or
 * outside 1..MAX_FILTER_BYTES.
 */
export function parseSize(text: string): number | null {
  const match = SIZE_RE.exec(text);
  if (match === null) return null;
  const power = UNIT_POWER.get((match[2] ?? '').toLowerCase());
  if (power === undefined) return null;
  const amount = Number((match[1] ?? '').replace(',', '.'));
  const bytes = Math.round(amount * 1024 ** power);
  return bytes >= 1 && bytes <= MAX_FILTER_BYTES ? bytes : null;
}

function fail(code: LineErrorCode, token: string): LineResult {
  return { ok: false, error: { code, token } };
}

function termsOk(...nodes: FilterNode[]): TermsResult {
  return { terms: nodes };
}

function termsFail(code: LineErrorCode, token: string): TermsResult {
  return { error: { code, token } };
}

/** The tokens of the line, split at the spaces outside quotes; each keeps its quotes. */
function tokenize(text: string): { tokens: string[]; unclosed: string | null } {
  const tokens: string[] = [];
  let raw = '';
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') {
      quoted = !quoted;
      raw += ch;
    } else if (ch === ' ' && !quoted) {
      if (raw !== '') tokens.push(raw);
      raw = '';
    } else {
      raw += ch;
    }
  }
  if (quoted) return { tokens, unclosed: raw };
  if (raw !== '') tokens.push(raw);
  return { tokens, unclosed: null };
}

/** The text with every quote removed, then trimmed. */
function clean(text: string): string {
  return text.replace(/"/g, '').trim();
}

/** The node, turned around when the term had a leading `-`. */
function wrap(node: FilterNode, neg: boolean): FilterNode {
  return neg ? { kind: 'not', of: node } : node;
}

/** The compiler takes the filter: it fails only where a checked criterion can't be sent. */
function compiles(filter: Filter): boolean {
  try {
    compileFilter(filter, { now: new Date(0) });
    return true;
  } catch (err) {
    if (err instanceof FilterError) return false;
    throw err;
  }
}

/** The terms of one raw token (quotes and a leading `-` included). */
function termsOf(raw: string): TermsResult {
  const neg = raw.length > 1 && raw.startsWith('-');
  const rest = neg ? raw.slice(1) : raw;
  const match = rest.startsWith('"') ? null : KEY_RE.exec(rest);
  if (match === null) return bareTerms(rest, neg);
  const name = (match[1] ?? '').toLowerCase();
  return keyTerms(name, clean(rest.slice(match[0].length)), neg, raw);
}

/** A token without a key: a flag word, or a word / quoted phrase. */
function bareTerms(rest: string, neg: boolean): TermsResult {
  const value = clean(rest);
  if (value === '') return termsOk();
  if (!rest.includes('"')) {
    const flag = flagNode(value.toLowerCase(), neg);
    if (flag !== null) return termsOk(flag);
  }
  return termsOk(wrap({ kind: 'word', value }, neg));
}

/** The leaf of a flag word; `-` turns it around (`-unread` is read, `-att` has no attachment). */
function flagNode(word: string, neg: boolean): FilterNode | null {
  switch (word) {
    case 'unread':
      return { kind: 'seen', value: neg };
    case 'read':
      return { kind: 'seen', value: !neg };
    case 'flagged':
      return { kind: 'flagged', value: !neg };
    case 'att':
      return { kind: 'hasAttachments', value: !neg };
    default:
      return null;
  }
}

function keyTerms(name: string, value: string, neg: boolean, raw: string): TermsResult {
  switch (name) {
    case 'from':
      return addressTerms('from', value, neg, raw);
    case 'to':
      return addressTerms('to', value, neg, raw);
    case 'cc':
      return addressTerms('cc', value, neg, raw);
    case 'subject':
      if (value === '') return termsFail('empty-value', raw);
      return termsOk(wrap({ kind: 'subject', value }, neg));
    case 'older':
      return ageTerm('olderThan', value, neg, raw);
    case 'newer':
      return ageTerm('newerThan', value, neg, raw);
    case 'since':
      return dayTerm('since', value, neg, raw);
    case 'before':
      return dayTerm('before', value, neg, raw);
    case 'date':
      if (neg) return termsFail('no-negation', raw);
      return dateRange(value, raw);
    case 'larger':
      return sizeTerm('larger', value, neg, raw);
    case 'smaller':
      return sizeTerm('smaller', value, neg, raw);
    default:
      return termsFail('unknown-key', raw);
  }
}

/** `from:a,b` → one leaf of the values; addresses and domains may mix, plain words may not. */
function addressTerms(field: AddressField, value: string, neg: boolean, raw: string): TermsResult {
  const values = value
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v !== '');
  if (values.length === 0) return termsFail('empty-value', raw);
  const words = values.filter((v) => addressClass(v) === 'part').length;
  if (words > 0 && words < values.length) return termsFail('mixed-addresses', raw);
  return termsOk(wrap({ kind: field, values }, neg));
}

function ageTerm(
  kind: 'olderThan' | 'newerThan',
  value: string,
  neg: boolean,
  raw: string,
): TermsResult {
  const age = value.toLowerCase();
  if (parseAge(age) === null) return termsFail('bad-age', raw);
  return termsOk(wrap({ kind, age }, neg));
}

/** `since:` / `before:` read a period and keep its first day. */
function dayTerm(kind: 'since' | 'before', value: string, neg: boolean, raw: string): TermsResult {
  const period = periodOf(value);
  if (period === null) return termsFail('bad-date', raw);
  return termsOk(wrap({ kind, day: period.start }, neg));
}

/** `date:A..B` (or `date:A`): since the first day of A, before the day after the last day of B. */
function dateRange(value: string, raw: string): TermsResult {
  const parts = value.split('..');
  if (parts.length > 2) return termsFail('bad-date', raw);
  const [startText = '', endText = startText] = parts;
  const first = periodOf(startText);
  const last = periodOf(endText);
  if (first === null || last === null || first.start > last.end) return termsFail('bad-date', raw);
  const after = dayAfter(last.end);
  if (after === null) return termsFail('bad-date', raw);
  return termsOk({ kind: 'since', day: first.start }, { kind: 'before', day: after });
}

function sizeTerm(
  kind: 'larger' | 'smaller',
  value: string,
  neg: boolean,
  raw: string,
): TermsResult {
  const bytes = parseSize(value);
  if (bytes === null) return termsFail('bad-size', raw);
  return termsOk(wrap({ kind, bytes }, neg));
}

/** `YYYY`, `YYYY-MM` or `YYYY-MM-DD` as its first and last day; null when unreadable. */
function periodOf(text: string): { start: string; end: string } | null {
  const match = PERIOD_RE.exec(text);
  if (match === null) return null;
  const [, year = '', month, day] = match;
  const start = `${year}-${month ?? '01'}-${day ?? '01'}`;
  if (parseDay(start) === null) return null;
  const endMonth = month ?? '12';
  const endDay =
    day ??
    String(new Date(Date.UTC(Number(year), Number(endMonth), 0)).getUTCDate()).padStart(2, '0');
  const end = `${year}-${endMonth}-${endDay}`;
  return parseDay(end) === null ? null : { start, end };
}

/** The day after `day` as YYYY-MM-DD, or null when that falls outside 1970..2100. */
function dayAfter(day: string): string | null {
  const parts = parseDay(day);
  if (parts === null) return null;
  const next = new Date(Date.UTC(parts.y, parts.m - 1, parts.d + 1));
  const year = next.getUTCFullYear();
  return year >= 1970 && year <= 2100 ? next.toISOString().slice(0, 10) : null;
}

// The printer (M3c): a filter back to the line that types it, for saved filters (`mm filter list`,
// `mm search --filter`). Each token is the typed form of one leaf; the line is parsed again and
// compared with the filter before it is returned, so a printed line never means something else.

/** The kinds a `-` can turn around; the flag words have their own negated forms (`-att`). */
const NEGATABLE: readonly FilterNode['kind'][] = [
  'word',
  'subject',
  'from',
  'to',
  'cc',
  'olderThan',
  'newerThan',
  'since',
  'before',
  'larger',
  'smaller',
];

const FLAG_WORDS = new Set(['unread', 'read', 'flagged', 'att']);

/**
 * The line, and the body text (which the line can't hold: the last `body` leaf), that parses back
 * to `filter`; null when the line can't express it.
 */
export function printFilterLine(filter: Filter): { line: string; body: string | null } | null {
  const leaves = leavesOf(filter);
  const last = leaves.at(-1);
  const body = last?.kind === 'body' ? last.value : null;
  const tokens: string[] = [];
  for (const leaf of body === null ? leaves : leaves.slice(0, -1)) {
    const token = tokenOf(leaf);
    if (token === null) return null;
    tokens.push(token);
  }
  const line = tokens.join(' ');
  const expected = parseFilter({ version: FILTER_VERSION, where: { kind: 'all', of: leaves } });
  const reread = parseLine(line, false);
  if (expected === null || !reread.ok) return null;
  const bodyLeaves: FilterNode[] = body === null ? [] : [{ kind: 'body', value: body }];
  const actual = parseFilter({
    version: FILTER_VERSION,
    where: { kind: 'all', of: [...leavesOf(reread.filter), ...bodyLeaves] },
  });
  return actual !== null && isDeepStrictEqual(actual, expected) ? { line, body } : null;
}

/** The leaves of a filter: an all-of root's terms, or the root itself when it is one leaf. */
function leavesOf(filter: Filter): FilterNode[] {
  return filter.where.kind === 'all' ? filter.where.of : [filter.where];
}

/** The token of one leaf; a `not` puts a `-` in front. Null when the line has no form for it. */
function tokenOf(node: FilterNode): string | null {
  if (node.kind !== 'not') return termToken(node);
  if (!NEGATABLE.includes(node.of.kind)) return null;
  const inner = termToken(node.of);
  return inner === null ? null : `-${inner}`;
}

/** The token of a leaf that is not a `not`. */
function termToken(node: FilterNode): string | null {
  switch (node.kind) {
    case 'word':
      return wordToken(node.value);
    case 'subject':
      return `subject:${valueText(node.value)}`;
    case 'from':
    case 'to':
    case 'cc':
      return `${node.kind}:${valueText(node.values.join(','))}`;
    case 'olderThan':
      return `older:${node.age}`;
    case 'newerThan':
      return `newer:${node.age}`;
    case 'since':
    case 'before':
      return `${node.kind}:${node.day}`;
    case 'larger':
    case 'smaller':
      return `${node.kind}:${sizeText(node.bytes)}`;
    case 'seen':
      return node.value ? 'read' : 'unread';
    case 'flagged':
      return node.value ? 'flagged' : '-flagged';
    case 'hasAttachments':
      return node.value ? 'att' : '-att';
    default:
      return null;
  }
}

/** A plain word, quoted where the line would read it as a key, a flag, a `-` or a phrase. */
function wordToken(value: string): string {
  const quoted =
    value.includes(' ') ||
    value.startsWith('-') ||
    KEY_RE.test(value) ||
    FLAG_WORDS.has(value.toLowerCase());
  return quoted ? `"${value}"` : value;
}

/** The value of a `key:` term, quoted when it has a space. */
function valueText(value: string): string {
  return value.includes(' ') ? `"${value}"` : value;
}

/** The size in the largest unit that divides it exactly: `1mb`, `1536kb`, `300b`. */
function sizeText(bytes: number): string {
  if (bytes % 1024 ** 3 === 0) return `${bytes / 1024 ** 3}gb`;
  if (bytes % 1024 ** 2 === 0) return `${bytes / 1024 ** 2}mb`;
  if (bytes % 1024 === 0) return `${bytes / 1024}kb`;
  return `${bytes}b`;
}
