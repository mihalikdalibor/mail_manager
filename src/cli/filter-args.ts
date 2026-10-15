import {
  compileFilter,
  FilterError,
  type CompiledFilter,
  type DateField,
} from '../core/filters/compile.js';
import { parseFilterLine } from '../core/filters/line.js';
import {
  FILTER_VERSION,
  parseFilter,
  type Filter,
  type FilterNode,
} from '../core/filters/schema.js';
import { filterTerms } from '../core/saved-filters.js';
import { lineErrorText } from './filter-text.js';
import { SEARCH_BODY_TEXT } from './search-text.js';

// The filter words of `mm search` and `mm filter save` (M3c): the --body text, the line and its
// terms, checked the same way in both commands. Everything here runs before any login; the
// compiler runs too (it needs no network), so a filter it refuses is named before the session.

export const UNSUPPORTED_TEXT = lineErrorText({ code: 'unsupported', token: '' });

/** The filter the schema accepts for these terms; null when it refuses them. */
function filterOf(of: FilterNode[]): Filter | null {
  return parseFilter({ version: FILTER_VERSION, where: { kind: 'all', of } });
}

/** The filter for these terms and what the compiler makes of it; null when either refuses them. */
export function compileTerms(
  of: FilterNode[],
  dates: DateField,
): { filter: Filter; compiled: CompiledFilter } | null {
  const filter = filterOf(of);
  if (filter === null) return null;
  try {
    return { filter, compiled: compileFilter(filter, { now: new Date(), dates }) };
  } catch (err) {
    if (err instanceof FilterError) return null;
    throw err;
  }
}

/**
 * The line and its terms as the commands read them. The body (`--body`) must fit the schema and
 * comes last among the terms, after the line's. Nothing typed at all is `emptyText`; null lets an
 * empty filter through (a search with a saved filter brings its own terms).
 */
export function readFilterTerms(
  words: readonly string[],
  rawBody: string | undefined,
  emptyText: string | null,
): { line: string; body: string | null; terms: FilterNode[] } | { text: string } {
  const body = rawBody === undefined ? null : rawBody.trim();
  if (body !== null && filterOf([{ kind: 'body', value: body }]) === null) {
    return { text: SEARCH_BODY_TEXT };
  }
  const line = words.join(' ').trim();
  let terms: FilterNode[] = [];
  if (line !== '') {
    const parsed = parseFilterLine(line);
    if (!parsed.ok) return { text: lineErrorText(parsed.error) };
    terms = filterTerms(parsed.filter);
  }
  if (terms.length === 0 && body === null && emptyText !== null) return { text: emptyText };
  return { line, body, terms: body === null ? terms : [...terms, { kind: 'body', value: body }] };
}
