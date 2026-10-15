import { printFilterLine } from '../core/filters/line.js';
import type { Filter } from '../core/filters/schema.js';
import { SAVED_FILTERS_MAX, SavedFilterError } from '../core/saved-filters.js';
import { sanitize } from './log-text.js';
import { plural } from './stats-text.js';

// Text for the saved filters (M3c): `mm filter …` and `mm search --filter`. A saved filter is the
// user's own config in the cloud, and its terms come back out of the database: every value shown
// goes through sanitize(). A name needs no sanitising — it has already passed FILTER_NAME_RE.

export const FILTER_NAME_TEXT =
  'A filter name is 1–40 letters, digits, - or _, not starting with - (e.g. big-old).';
export const SAVE_EMPTY_TEXT =
  'Type the filter to save, e.g. mm filter save big-old "older:1y larger:1mb".';
export const LIMIT_TEXT = `You have ${SAVED_FILTERS_MAX} saved filters, the most Mail Manager keeps — delete one first (mm filter delete <name>).`;
export const NO_FILTERS_TEXT =
  'No saved filters yet — save one with mm filter save <name> "<filter>".';
export const DELETE_NEEDS_TTY_TEXT = 'mm filter delete needs a terminal to confirm, or --yes';
export const NOT_A_LINE = "(can't be shown as a line)";
export const UNREADABLE = "(can't be read)";

export function duplicateText(name: string): string {
  return `A filter named "${name}" is already saved — add --replace to overwrite it, or pick another name.`;
}

export function emptySavedText(name: string): string {
  return `The saved filter "${name}" has no terms — save it again with --replace, or delete it.`;
}

export function notFoundText(name: string): string {
  return `No saved filter named "${name}" — see \`mm filter list\`.`;
}

export function unreadableText(name: string): string {
  return `The saved filter "${name}" can't be read — save it again with --replace, or delete it.`;
}

export function skippedText(count: number): string {
  return `${plural(count, 'saved filter', 'saved filters')} couldn't be read and ${count === 1 ? 'is' : 'are'} not shown.`;
}

/** What a failed save, delete or lookup says, by the typed error's code. */
export function savedErrorText(err: SavedFilterError, name: string): string {
  switch (err.code) {
    case 'duplicate':
      return duplicateText(name);
    case 'limit':
      return LIMIT_TEXT;
    case 'not-found':
      return notFoundText(name);
  }
}

/** The line the user typed, with its body: `older:1y body:"invoice"`; '' when there is neither. */
export function typedText(line: string, body: string | null): string {
  return [
    ...(line === '' ? [] : [sanitize(line)]),
    ...(body === null ? [] : [`body:"${sanitize(body)}"`]),
  ].join(' ');
}

/** A stored filter as the line it prints as; the stand-in text when it can't be read or printed. */
export function savedFilterText(filter: Filter | null): string {
  if (filter === null) return UNREADABLE;
  const printed = printFilterLine(filter);
  return printed === null ? NOT_A_LINE : typedText(printed.line, printed.body);
}

/** The line and body of a stored filter for `--json`, sanitised; both null when it isn't a line. */
export function jsonLine(filter: Filter | null): { line: string | null; body: string | null } {
  const printed = filter === null ? null : printFilterLine(filter);
  if (printed === null) return { line: null, body: null };
  return {
    line: sanitize(printed.line),
    body: printed.body === null ? null : sanitize(printed.body),
  };
}
