import type { Rendered } from './render.js';
import { MIN_COLS, MIN_ROWS } from './state.js';
import { displayWidth, fit } from './width.js';

// Line layout shared by the folder browser (M2b) and the app (M2d): two-cell lines, centred
// text, wrapped text, the key help and the "window too small" frame. Pure: plain text, no
// escape codes. The callers sanitise what they pass in; these only measure and fit it to the
// width.

/** One key help entry; `rank` = which go first when the line is too narrow (0 = keep). */
export interface HelpItem {
  text: string;
  rank: number;
}

const HELP_GAP = '  ';
/** ASCII, so it takes three columns in every terminal (no ambiguous width). */
const ELLIPSIS = '...';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** `left` and a right-aligned `right` in exactly `cols` columns (`right` dropped if no room). */
export function columns(left: string, right: string, cols: number): string {
  const rightWidth = displayWidth(right);
  if (right === '' || rightWidth + 2 > cols) return fit(left, cols);
  return `${fit(left, cols - rightWidth - 1)} ${right}`;
}

export function centred(text: string, cols: number): string {
  const indent = Math.max(0, Math.floor((cols - displayWidth(text)) / 2));
  return fit(' '.repeat(indent) + text, cols);
}

/**
 * ASCII `text` in lines of at most `width` columns, broken at spaces; a word longer than a line
 * is split.
 */
export function wrap(text: string, width: number): string[] {
  const w = Math.max(1, Math.floor(width));
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    let rest = word;
    while (rest.length > w) {
      if (line !== '') lines.push(line);
      lines.push(rest.slice(0, w));
      line = '';
      rest = rest.slice(w);
    }
    if (rest === '') continue;
    if (line === '') line = rest;
    else if (line.length + 1 + rest.length <= w) line += ` ${rest}`;
    else {
      lines.push(line);
      line = rest;
    }
  }
  if (line !== '') lines.push(line);
  return lines;
}

/** As many help items as fit, most important first, shown in their usual order. */
export function helpLine(items: readonly HelpItem[], cols: number): string {
  const byRank = [...items].sort((a, b) => a.rank - b.rank);
  const kept = new Set<string>();
  let width = 0;
  for (const item of byRank) {
    const w = displayWidth(item.text) + (kept.size === 0 ? 0 : HELP_GAP.length);
    if (width + w > cols) continue;
    kept.add(item.text);
    width += w;
  }
  const text = items
    .filter((item) => kept.has(item.text))
    .map((item) => item.text)
    .join(HELP_GAP);
  return fit(text, cols);
}

/**
 * The frame shown below 40x8: only the "too small" text, plus the question the keys still
 * answer (`question`, null when none is pending).
 */
export function tooSmallFrame(rows: number, cols: number, question: string | null): Rendered {
  const lines: string[] = [];
  const middle = Math.floor((rows - 1) / 2);
  const long = `Window too small - need at least ${String(MIN_COLS)}x${String(MIN_ROWS)}`;
  // Stays whole down to 21 columns; the long text needs 37.
  const text =
    cols < displayWidth(long) ? `Too small - need ${String(MIN_COLS)}x${String(MIN_ROWS)}` : long;
  // A pending question goes on the next line, or replaces the text when there is no next line.
  const questionLine = question === null ? -1 : middle + 1 < rows ? middle + 1 : middle;
  for (let i = 0; i < rows; i++) {
    if (i === questionLine && question !== null) lines.push(centred(question, cols));
    else if (i === middle) lines.push(centred(text, cols));
    else lines.push(fit('', cols));
  }
  return { lines, cursorLine: null };
}

/**
 * `text` in exactly `width` columns with its end kept (a field being typed into): cut at the
 * start with a leading "..." when longer, padded with spaces when shorter.
 */
export function fitTail(text: string, width: number): string {
  if (!Number.isFinite(width) || width <= 0) return '';
  const w = Math.floor(width);
  if (displayWidth(text) <= w) return fit(text, w);
  const ellipsis = ELLIPSIS.slice(0, w);
  const room = w - ellipsis.length;
  const graphemes = Array.from(segmenter.segment(text), (s) => s.segment);
  // The longest run of whole graphemes from the end that leaves room for the ellipsis.
  let tail = '';
  let used = 0;
  for (let i = graphemes.length - 1; i >= 0; i--) {
    const g = graphemes[i] ?? '';
    const gw = displayWidth(g);
    if (used + gw > room) break;
    tail = g + tail;
    used += gw;
  }
  return `${ellipsis}${tail}${' '.repeat(room - used)}`;
}
