import type { SizeProgress } from '../../core/mailbox/folders.js';
import type {
  LargestMail,
  MailboxStats,
  RankedStats,
  StatsYearRow,
} from '../../core/mailbox/stats.js';
import { columns, type HelpItem } from '../browser/layout.js';
import { fit } from '../browser/width.js';
import { formatBytes, safeName } from '../folders-text.js';
import { sanitize } from '../log-text.js';
import { dateFormatter, dayText } from '../stats-text.js';
import { bar, failureLines, percent, type MailboxBody } from './mailbox-render.js';
import { rankedRows, statsRowCount, statsSummary } from './mailbox-stats.js';
import type { MailboxView, StatsBy, StatsSection } from './state.js';

// The stats screen of a mailbox (M2d-3) as plain-text pieces for mailbox-render.ts: the right
// header cell, the body, what the status line says about the read, the key help. The body is the
// summary, wrapped to the width and kept above the rows, then the rows of one section - the years
// with a share bar each, the top senders, the top domains or the largest mails. Pure, and plain
// ASCII but for what the mail server gave: senders, domains, subjects and folder names go through
// sanitize() and every line is fitted to the width. Sizes are sums of message sizes: the summary
// says "approx." once.
// (mailbox-render.ts and this file use each other's functions; nothing runs while they load.)

/** Which right cells the year rows of one frame have; size and messages are always there. */
interface YearSet {
  /** Cells of the bar; 0 = no bar. */
  bar: number;
  percent: boolean;
}

/** One row of a section before it is laid out. */
interface CountRow {
  label: string;
  messages: number;
  bytes: number;
}

const INDENT = '    ';
const NONE = '(none)';
const NO_ADDRESS = '(no address)';
const NO_DOMAIN = '(no domain)';
const NO_SUBJECT = '(no subject)';
const UNREADABLE = '(unreadable)';
const OTHERS = 'others';
const NOT_STARTED = 'Press r to read the stats.';
const BAR_CELLS = 10;
const PERCENT_WIDTH = 4;
/** As a folder name on the bars: a year keeps this many columns before its cells give way. */
const LABEL_MIN = 12;
/** `YYYY-MM-DD`. */
const DATE_WIDTH = 10;
/** Below this width the largest mails have no date. */
const DATE_MIN_COLS = 56;

/** In order of preference: the first one that leaves the year its room is used. */
const YEAR_SETS: readonly YearSet[] = [
  { bar: BAR_CELLS, percent: true },
  { bar: 6, percent: true },
  { bar: 0, percent: true },
  { bar: 0, percent: false },
];

const SECTION_TITLE: Record<StatsSection, string> = {
  years: 'Years',
  senders: 'Top senders',
  domains: 'Top domains',
  largest: 'Largest mails',
};

const BY_TEXT: Record<StatsBy, string> = { size: 'by size', messages: 'by messages' };

const HELP_SECTION: HelpItem = { text: '1-4 section', rank: 2 };
const HELP_ORDER: HelpItem = { text: 'o size/messages', rank: 4 };
const HELP_BACK: HelpItem = { text: 'Esc back', rank: 0 };
const HELP_QUIT: HelpItem = { text: 'q quit', rank: 1 };
const HELP_STATS: readonly HelpItem[] = [
  HELP_SECTION,
  HELP_ORDER,
  { text: 'Up/Down scroll', rank: 5 },
  { text: 'r read again', rank: 3 },
  HELP_BACK,
  HELP_QUIT,
];
/** Nothing to scroll yet, and `r` waits for the read that runs. */
const HELP_READING: readonly HelpItem[] = [HELP_SECTION, HELP_ORDER, HELP_BACK, HELP_QUIT];
const HELP_FAILED: readonly HelpItem[] = [{ text: 'r try again', rank: 2 }, HELP_BACK, HELP_QUIT];

function padded(lines: string[], height: number, cols: number): string[] {
  const out = lines.slice(0, height);
  while (out.length < height) out.push(fit('', cols));
  return out;
}

/** A string of the mail server for one line: safe, trimmed; `none` when nothing is left. */
function shownOr(text: string | null, none: string): string {
  const safe = text === null ? '' : sanitize(text).trim();
  return safe === '' ? none : safe;
}

/** A sender or domain of a top list: `none` for no key; one made of control characters says so. */
function keyText(key: string | null, none: string): string {
  return key === null ? none : shownOr(key, UNREADABLE);
}

function widest(cells: readonly string[]): number {
  return cells.reduce((width, cell) => Math.max(width, cell.length), 1);
}

/** Newest first; the mails without a usable date (`unknown`) last. */
function newestFirst(years: readonly StatsYearRow[]): StatsYearRow[] {
  const numbered = (y: StatsYearRow): boolean => /^\d+$/.test(y.year);
  return [
    ...years.filter(numbered).sort((a, b) => Number(b.year) - Number(a.year)),
    ...years.filter((y) => !numbered(y)),
  ];
}

/**
 * The years: each with its share of the whole mailbox - by size or by messages - as a bar and a
 * percent, then its size and its messages. One set of cells for the whole frame, chosen as on
 * the bars: the widest that leaves the year its room; none has a bar or a percent when the
 * whole is nothing.
 */
function yearLines(stats: MailboxStats, by: StatsBy, cols: number): string[] {
  const years = newestFirst(stats.years).map((y) => ({ ...y, label: sanitize(y.year) }));
  const total = by === 'size' ? stats.totals.bytes : stats.totals.messages;
  const shares = total > 0;
  const sizeWidth = widest(years.map((y) => formatBytes(y.bytes)));
  const messagesWidth = widest(years.map((y) => String(y.messages)));
  const widthOf = (set: YearSet): number =>
    (set.bar > 0 ? set.bar + 3 : 0) +
    (set.percent ? PERCENT_WIDTH + 2 : 0) +
    sizeWidth +
    2 +
    messagesWidth +
    2;
  const plain = YEAR_SETS[YEAR_SETS.length - 1] ?? { bar: 0, percent: false };
  // Size and messages alone are the last resort: they fit every window that isn't "too small".
  const set =
    YEAR_SETS.find(
      (s) => (shares || s === plain) && cols - widthOf(s) - 1 - INDENT.length >= LABEL_MIN,
    ) ?? plain;
  return years.map((y) => {
    const part = by === 'size' ? y.bytes : y.messages;
    const share = shares ? Math.min(1, Math.max(0, part / total)) : 0;
    let cells = '';
    if (set.bar > 0) cells += `${bar(share, set.bar)} `;
    if (set.percent) cells += `${percent(share).padStart(PERCENT_WIDTH)}  `;
    cells += `${formatBytes(y.bytes).padStart(sizeWidth)}  `;
    cells += `${String(y.messages).padStart(messagesWidth)}  `;
    return columns(`${INDENT}${y.label}`, cells, cols);
  });
}

/** Rows with a size and a messages cell on the right, one width each for the whole list. */
function countLines(rows: readonly CountRow[], cols: number): string[] {
  const sizeWidth = widest(rows.map((r) => formatBytes(r.bytes)));
  const messagesWidth = widest(rows.map((r) => String(r.messages)));
  return rows.map((r) => {
    const size = formatBytes(r.bytes).padStart(sizeWidth);
    const messages = String(r.messages).padStart(messagesWidth);
    return columns(`${INDENT}${r.label}`, `${size}  ${messages}  `, cols);
  });
}

/** A top list in the chosen order; the keys past the cap are one last row. */
function rankedLines(ranked: RankedStats, by: StatsBy, none: string, cols: number): string[] {
  const rows: CountRow[] = rankedRows(ranked, by).map((r) => ({
    label: keyText(r.key, none),
    messages: r.messages,
    bytes: r.bytes,
  }));
  if (ranked.others.messages > 0) rows.push({ label: OTHERS, ...ranked.others });
  return countLines(rows, cols);
}

/** One line per mail: size, the day it arrived, who sent it, its subject, its folder. */
function largestLines(largest: readonly LargestMail[], cols: number, timeZone: string): string[] {
  const format = dateFormatter(timeZone);
  const sizeWidth = widest(largest.map((l) => formatBytes(l.bytes)));
  return largest.map((l) => {
    const size = formatBytes(l.bytes).padStart(sizeWidth);
    const day = cols < DATE_MIN_COLS ? '' : `${dayText(l.received, format).padEnd(DATE_WIDTH)}  `;
    const mail = `${shownOr(l.from, NO_ADDRESS)} - ${shownOr(l.subject, NO_SUBJECT)}`;
    return fit(`${INDENT}${size}  ${day}${mail} (${safeName(l.folder)})`, cols);
  });
}

function sectionLines(
  stats: MailboxStats,
  section: StatsSection,
  by: StatsBy,
  cols: number,
  timeZone: string,
): string[] {
  switch (section) {
    case 'years':
      return yearLines(stats, by, cols);
    case 'senders':
      return rankedLines(stats.senders, by, NO_ADDRESS, cols);
    case 'domains':
      return rankedLines(stats.domains, by, NO_DOMAIN, cols);
    case 'largest':
      return largestLines(stats.largest, cols, timeZone);
  }
}

/** The summary, which stays, and below it the rows of the section from the first one in view. */
function readyBody(
  view: MailboxView,
  stats: MailboxStats,
  height: number,
  cols: number,
  timeZone: string,
): string[] {
  const summary = statsSummary(stats, cols, height).map((line) => fit(line, cols));
  const rows = sectionLines(stats, view.statsSection, view.statsBy, cols, timeZone);
  if (rows.length === 0) return [...summary, fit(`${INDENT}${NONE}`, cols)];
  const room = Math.max(1, height - summary.length);
  // The same count the keys scroll within; a window that grew shows more of the end.
  const last = Math.max(0, statsRowCount(stats, view.statsSection, view.statsBy) - room);
  const top = Math.min(Math.max(0, view.statsTop), last);
  return [...summary, ...rows.slice(top, top + room)];
}

/**
 * The right header cell: the section, its order, and whether its list is cut short. A header of
 * `cols` columns that has no room for all of it drops the last part - a cell that doesn't fit
 * would be left out whole, and nothing would name the section.
 */
export function statsHeaderRight(view: MailboxView, cols?: number): string {
  const section = view.statsSection;
  if (section === 'largest') return SECTION_TITLE[section];
  const title = `${SECTION_TITLE[section]} - ${BY_TEXT[view.statsBy]}`;
  const stats = view.stats;
  // Only a top list can be approximate: its own `others` says whether its cap overflowed.
  const approximate =
    stats.status === 'ready' && section !== 'years' && stats.stats[section].others.messages > 0;
  if (!approximate) return title;
  const full = `${title} (approximate)`;
  // As columns() decides: a right cell needs one column of the left one and the gap beside it.
  return cols !== undefined && full.length + 2 > cols ? title : full;
}

export function statsBody(
  view: MailboxView,
  height: number,
  cols: number,
  timeZone: string,
): MailboxBody {
  const stats = view.stats;
  let lines: string[];
  switch (stats.status) {
    case 'idle':
      lines = [fit(`${INDENT}${NOT_STARTED}`, cols)];
      break;
    case 'reading':
      // The status line says how far the read is.
      lines = [];
      break;
    case 'failed':
      lines = failureLines(stats.text, height, cols);
      break;
    case 'ready':
      lines = readyBody(view, stats.stats, height, cols, timeZone);
      break;
  }
  return { lines: padded(lines, height, cols), cursorLine: null };
}

function readingText(progress: SizeProgress | null): string {
  if (progress === null) return 'Stats: reading...';
  const folder = `${String(progress.folder)}/${String(progress.folders)}`;
  const messages = `${String(progress.done)}/${String(progress.total)}`;
  return `Stats: reading folder ${folder} - ${messages} messages`;
}

/**
 * What the status line says about the stats, or null: on the bars where the read stands, on
 * the stats screen only how far a running read is (the rest is in its body).
 */
export function statsNote(view: MailboxView): string | null {
  const stats = view.stats;
  if (view.mode === 'stats') return stats.status === 'reading' ? readingText(stats.progress) : null;
  if (view.mode !== 'ready') return null;
  switch (stats.status) {
    case 'idle':
      return 'Stats: press s to read';
    case 'reading':
      return readingText(stats.progress);
    case 'ready':
      return 'Stats ready - press s';
    case 'failed':
      return "Stats couldn't be read - press s";
  }
}

export function statsHelp(view: MailboxView): readonly HelpItem[] {
  switch (view.stats.status) {
    case 'reading':
      return HELP_READING;
    case 'failed':
      return HELP_FAILED;
    case 'idle':
    case 'ready':
      return HELP_STATS;
  }
}
