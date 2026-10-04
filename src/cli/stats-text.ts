import type { FolderTree, QuotaBytes } from '../core/mailbox/folders.js';
import { MAX_FOLDERS } from '../core/mailbox/folders.js';
import { STATS_MAX_YEAR, STATS_MIN_YEAR } from '../core/mailbox/stats.js';
import type {
  CountBytes,
  MailboxStats,
  RankedRow,
  RankedStats,
  StatsYearRow,
} from '../core/mailbox/stats.js';
import { formatBytes, quotaLine, safeName } from './folders-text.js';
import { sanitize } from './log-text.js';

// Text and JSON for `mm stats` (M2c-1). Folder paths, senders, domains and subjects come from
// the mail server and are untrusted: every one goes through sanitize() and is cut, in the text
// and in the JSON. Sizes are RFC822.SIZE sums — approximate and not the quota; the first line
// says so once, so no "~" per size.

const UNKNOWN = '—';
const NONE = '  (none)';
const NO_ADDRESS = '(no address)';
const NO_DOMAIN = '(no domain)';
/** LARGEST MAILS cuts the sender and subject further than the core does (one line per mail). */
const MAX_FROM_CHARS = 40;
const MAX_SUBJECT_CHARS = 80;
/** A sender or domain in the top lists (the core keeps up to 320). */
const MAX_KEY_CHARS = 60;

function n(value: number): string {
  return value.toLocaleString('en-US');
}

function plural(count: number, one: string, many: string): string {
  return `${n(count)} ${count === 1 ? one : many}`;
}

/** At most `max` code points of the sanitised text, `…` when cut. */
function clip(text: string, max: number): string {
  const chars = [...sanitize(text)];
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max - 1).join('')}…`;
}

/** Rows aligned: the first column left, the others right; `suffix[i]` goes after row i. */
function table(rows: string[][], suffix: string[] = []): string[] {
  const widths: number[] = [];
  for (const r of rows) {
    r.forEach((c, i) => {
      widths[i] = Math.max(widths[i] ?? 0, [...c].length);
    });
  }
  return rows.map((r, row) => {
    const cells = r.map((c, i) => {
      const gap = ' '.repeat(Math.max(0, (widths[i] ?? 0) - [...c].length));
      return i === 0 ? c + gap : gap + c;
    });
    return `${cells.join('  ').trimEnd()}${suffix[row] ?? ''}`;
  });
}

function firstLine(stats: MailboxStats, tree: FolderTree): string[] {
  const t = stats.totals;
  let line =
    `Scanned ${plural(stats.folders.length, 'folder', 'folders')}, ` +
    `${plural(t.messages, 'message', 'messages')}, ${formatBytes(t.bytes)}` +
    ' — sizes are approx. (message sizes, not the quota)';
  if (stats.unreadable > 0) {
    line += `; ${plural(stats.unreadable, 'folder', 'folders')} couldn't be read`;
  }
  if (stats.partial > 0) line += `; ${plural(stats.partial, 'folder', 'folders')} read only partly`;
  if (tree.truncated) line += `; first ${n(MAX_FOLDERS)} folders only`;
  const lines = [line];
  if (stats.notScanned > 0) {
    lines.push(
      `Not scanned: ${plural(stats.notScanned, 'folder', 'folders')} (Gmail labels or virtual folders; their mail is counted in the folders above)`,
    );
  }
  return lines;
}

function folderSection(stats: MailboxStats): string[] {
  if (stats.folders.length === 0) return ['FOLDER  MESSAGES  SIZE', NONE];
  const rows = stats.folders.map((f) => [
    safeName(f.path),
    f.messages === null ? UNKNOWN : n(f.messages),
    f.bytes === null ? UNKNOWN : formatBytes(f.bytes),
  ]);
  const suffix = stats.folders.map((f) => (f.partial ? ' (partial)' : ''));
  return table([['FOLDER', 'MESSAGES', 'SIZE'], ...rows], ['', ...suffix]);
}

function section(heading: string, rows: string[][]): string[] {
  return rows.length === 0 ? [heading, NONE] : [heading, ...table(rows)];
}

function yearSection(years: StatsYearRow[]): string[] {
  return section(
    'PER YEAR',
    years.map((y) => [y.year, n(y.messages), formatBytes(y.bytes)]),
  );
}

/**
 * A sender or domain: `none` for no key; `(unreadable)` when sanitising leaves nothing (a key
 * made only of control or bidi characters); otherwise trimmed and cut.
 */
function keyText(key: string | null, none: string): string {
  if (key === null) return none;
  const text = sanitize(key).trim();
  return text === '' ? '(unreadable)' : clip(text, MAX_KEY_CHARS);
}

/**
 * One top list. `others` grows only when that list's map overflowed its cap, so it alone says
 * whether this list is approximate (the global flag covers senders and domains together).
 */
function rankedSection(
  heading: string,
  rows: RankedRow[],
  others: CountBytes,
  none: string,
): string[] {
  const cells = rows.map((r) => [keyText(r.key, none), n(r.messages), formatBytes(r.bytes)]);
  const approximate = others.messages > 0;
  if (approximate) cells.push(['others', n(others.messages), formatBytes(others.bytes)]);
  return section(approximate ? `${heading} (approximate)` : heading, cells);
}

function rankedSections(what: 'SENDERS' | 'DOMAINS', r: RankedStats): string[][] {
  // A sender without `@` has a key but no domain.
  const none = what === 'SENDERS' ? NO_ADDRESS : NO_DOMAIN;
  return [
    rankedSection(`TOP ${what} BY MESSAGES`, r.byCount, r.others, none),
    rankedSection(`TOP ${what} BY SIZE`, r.bySize, r.others, none),
  ];
}

function dateFormatter(timeZone: string): Intl.DateTimeFormat {
  const options: Intl.DateTimeFormatOptions = { year: 'numeric', month: '2-digit', day: '2-digit' };
  try {
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone });
  } catch {
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' });
  }
}

/** `YYYY-MM-DD` in the zone; `-` when unknown or outside the years PER YEAR counts. */
function dayText(date: Date | null, format: Intl.DateTimeFormat): string {
  if (date === null || !Number.isFinite(date.getTime())) return '-';
  const parts: Record<string, string> = {};
  for (const p of format.formatToParts(date)) parts[p.type] = p.value;
  const year = /^\d{4}$/.test(parts['year'] ?? '') ? Number(parts['year']) : NaN;
  if (!(year >= STATS_MIN_YEAR && year <= STATS_MAX_YEAR)) return '-';
  return `${parts['year'] ?? ''}-${parts['month'] ?? ''}-${parts['day'] ?? ''}`;
}

/** The sender column: sanitised, trimmed, cut; `(no address)` when nothing is left. */
function fromText(from: string | null): string {
  const text = from === null ? '' : sanitize(from).trim();
  return text === '' ? NO_ADDRESS : clip(text, MAX_FROM_CHARS);
}

/** The subject column: sanitised, trimmed, cut; `(no subject)` when nothing is left. */
function subjectText(subject: string | null): string {
  const text = subject === null ? '' : sanitize(subject).trim();
  return text === '' ? '(no subject)' : clip(text, MAX_SUBJECT_CHARS);
}

function largestSection(stats: MailboxStats, timeZone: string): string[] {
  const format = dateFormatter(timeZone);
  const rows = stats.largest.map((l) => {
    return [
      dayText(l.received, format),
      formatBytes(l.bytes),
      fromText(l.from),
      `${subjectText(l.subject)}  (${safeName(l.folder)})`,
    ];
  });
  if (rows.length === 0) return ['LARGEST MAILS', NONE];
  // Date left, size right, sender left-padded to one column; the subject runs to the end.
  const dates = table(rows.map((r) => [r[0] ?? '', r[1] ?? '']));
  const from = Math.max(...rows.map((r) => [...(r[2] ?? '')].length));
  return [
    'LARGEST MAILS',
    ...rows.map((r, i) => {
      const sender = r[2] ?? '';
      const gap = ' '.repeat(from - [...sender].length);
      return `${dates[i] ?? ''}  ${sender}${gap}  ${r[3] ?? ''}`;
    }),
  ];
}

/** The text report: sections separated by a blank line, then the quota for a whole mailbox. */
export function statsLines(
  stats: MailboxStats,
  tree: FolderTree,
  opts: { wholeMailbox: boolean; timeZone: string },
): string[] {
  const sections: string[][] = [
    firstLine(stats, tree),
    folderSection(stats),
    yearSection(stats.years),
    ...rankedSections('SENDERS', stats.senders),
    ...rankedSections('DOMAINS', stats.domains),
    largestSection(stats, opts.timeZone),
  ];
  if (opts.wholeMailbox) sections.push([quotaLine(tree)]);
  return sections.flatMap((s, i) => (i === 0 ? s : ['', ...s]));
}

export interface StatsJson {
  v: 1;
  account: string;
  scope: { folder: string | null; gmail: boolean };
  folders: { path: string; messages: number | null; bytes: number | null; partial: boolean }[];
  notScanned: number;
  totals: CountBytes;
  years: StatsYearRow[];
  senders: { byCount: RankedRow[]; bySize: RankedRow[]; others: CountBytes };
  domains: { byCount: RankedRow[]; bySize: RankedRow[]; others: CountBytes };
  largest: {
    folder: string;
    received: string | null;
    from: string | null;
    subject: string | null;
    bytes: number;
  }[];
  approximate: boolean;
  unreadable: number;
  partial: number;
  truncated: boolean;
  /** null with `--folder`. */
  quota: QuotaBytes | null;
}

function rankedJson(r: RankedStats): StatsJson['senders'] {
  const rows = (list: RankedRow[]): RankedRow[] =>
    list.map((row) => ({ ...row, key: row.key === null ? null : sanitize(row.key) }));
  return { byCount: rows(r.byCount), bySize: rows(r.bySize), others: { ...r.others } };
}

/**
 * The `--json` object (versioned). Paths are sanitised but not cut (as in `mm folders --json`,
 * so a path can be passed to `--folder`); senders and subjects are sanitised (the core cuts them).
 */
export function statsJson(
  stats: MailboxStats,
  tree: FolderTree,
  account: string,
  scope: { folder: string | null; gmail: boolean },
): StatsJson {
  return {
    v: 1,
    account: sanitize(account),
    scope: { folder: scope.folder === null ? null : sanitize(scope.folder), gmail: scope.gmail },
    folders: stats.folders.map((f) => ({
      path: sanitize(f.path),
      messages: f.messages,
      bytes: f.bytes,
      partial: f.partial,
    })),
    notScanned: stats.notScanned,
    totals: { ...stats.totals },
    years: stats.years.map((y) => ({ ...y })),
    senders: rankedJson(stats.senders),
    domains: rankedJson(stats.domains),
    largest: stats.largest.map((l) => ({
      folder: sanitize(l.folder),
      received: l.received === null ? null : l.received.toISOString(),
      from: l.from === null ? null : sanitize(l.from),
      subject: l.subject === null ? null : sanitize(l.subject),
      bytes: l.bytes,
    })),
    approximate: stats.approximate,
    unreadable: stats.unreadable,
    partial: stats.partial,
    truncated: tree.truncated,
    quota: scope.folder === null && tree.quota !== null ? { ...tree.quota } : null,
  };
}
