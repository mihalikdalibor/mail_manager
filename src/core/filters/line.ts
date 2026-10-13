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
// (src/cli/filter-text.ts) and nothing is logged. Pure: no IMAP, no clock.

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
  if ([...text].length > MAX_FILTER_LINE) return fail('too-long', '');
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
