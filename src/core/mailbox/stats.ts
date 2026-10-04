import type { FetchedMessage, StatsQuery } from '../imap/session.js';
import { MailboxError } from './errors.js';
import {
  gmailSummed,
  type FolderInfo,
  type FolderSession,
  type FolderTree,
  type SizeProgress,
} from './folders.js';
import { checkOpen, count } from './guards.js';
import { capped, receivedDate, sender } from './messages.js';
import { SIZE_BATCH, scanFolder, type ScanRange } from './scan.js';

// Where a mailbox's space and mail come from (M2c-1): one read-only streaming pass over the
// scoped folders (ENVELOPE, INTERNALDATE, RFC822.SIZE), folded into totals, per folder, per year,
// top senders/domains and the largest mails. No per-message list is kept: memory is bounded by
// STATS_MAX_KEYS distinct senders/domains (later new ones go to `others`, marked approximate)
// and STATS_TOP_N largest mails. Senders, subjects and folder names are server data, returned
// unsanitised for the shell to sanitise; nothing here logs or stores them.

export const STATS_TOP_N = 10;
export const STATS_MAX_KEYS = 50_000;
export const STATS_QUERY: StatsQuery = { envelope: true, internalDate: true, size: true };

/** RFC 5321's longest address: a longer key is cut (bounds memory per key). */
const MAX_ADDRESS_CHARS = 320;
/** Years outside this range are `unknown` (a broken or forged INTERNALDATE). */
export const STATS_MIN_YEAR = 1900;
export const STATS_MAX_YEAR = 2200;
const UNKNOWN_YEAR = 'unknown';

export interface CountBytes {
  messages: number;
  bytes: number;
}

export interface RankedRow {
  /** Lowercased address or domain; null = no address. */
  key: string | null;
  messages: number;
  bytes: number;
}

export interface StatsFolderRow {
  path: string;
  /** null = unreadable (failed, or came back short, before any message was counted). */
  messages: number | null;
  bytes: number | null;
  /** Failed or came back short after some messages: the counts are kept. */
  partial: boolean;
}

export interface StatsYearRow {
  /** `2024` or `unknown`. */
  year: string;
  messages: number;
  bytes: number;
}

export interface LargestMail {
  folder: string;
  received: Date | null;
  from: string | null;
  subject: string | null;
  bytes: number;
}

export interface RankedStats {
  byCount: RankedRow[];
  bySize: RankedRow[];
  /** Keys past the cap. */
  others: CountBytes;
}

export interface MailboxStats {
  /** Scope order. */
  folders: StatsFolderRow[];
  /** Selectable folders left out (Gmail labels, virtual folders). */
  notScanned: number;
  totals: CountBytes;
  /** Numeric ascending, `unknown` last. */
  years: StatsYearRow[];
  senders: RankedStats;
  domains: RankedStats;
  /** Bytes descending, ties in the order seen. */
  largest: LargestMail[];
  /** A sender or domain cap overflowed. */
  approximate: boolean;
  /** Rows with `messages === null`. */
  unreadable: number;
  /** Rows with `partial === true`. */
  partial: number;
}

export interface StatsAggregator {
  /** Opens a folder row (0 messages) and makes it current. */
  startFolder(path: string): void;
  /** Counts one message into the current folder and every global stat. */
  add(msg: FetchedMessage): void;
  /** The current folder failed: unreadable when nothing was counted, otherwise partial. */
  folderFailed(): void;
  /** `notScanned` is 0; collectStats sets it. */
  result(): MailboxStats;
}

export interface StatsAggregatorOptions {
  /** IANA zone for the per-year rows; an invalid one falls back to UTC. */
  timeZone: string;
  maxKeys?: number;
  topN?: number;
}

interface FolderState {
  path: string;
  messages: number;
  bytes: number;
  failed: boolean;
}

/** One capped key map (senders or domains); the null key is outside the cap. */
interface KeyTally {
  keys: Map<string, CountBytes>;
  none: CountBytes;
  others: CountBytes;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function yearFormatter(timeZone: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric' });
  } catch {
    return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric' });
  }
}

function yearOf(value: unknown, format: Intl.DateTimeFormat): string {
  const date = receivedDate(value);
  if (date === null) return UNKNOWN_YEAR;
  const part = format.formatToParts(date).find((p) => p.type === 'year')?.value;
  const year = part !== undefined && /^\d{4}$/.test(part) ? Number(part) : NaN;
  return year >= STATS_MIN_YEAR && year <= STATS_MAX_YEAR ? String(year) : UNKNOWN_YEAR;
}

/** The first From address: trimmed, lowercased, capped; null when missing or empty. */
function senderKey(envelope: unknown): string | null {
  const from = record(envelope)?.['from'];
  const address = Array.isArray(from) ? record(from[0])?.['address'] : undefined;
  if (typeof address !== 'string') return null;
  const key = address.trim().toLowerCase();
  return key === '' ? null : capped(key, MAX_ADDRESS_CHARS);
}

function domainOf(key: string | null): string | null {
  if (key === null) return null;
  const domain = key.slice(key.lastIndexOf('@') + 1);
  return key.includes('@') && domain !== '' ? domain : null;
}

function bump(tally: CountBytes, bytes: number): void {
  tally.messages++;
  tally.bytes += bytes;
}

function newTally(): KeyTally {
  return { keys: new Map(), none: { messages: 0, bytes: 0 }, others: { messages: 0, bytes: 0 } };
}

/** Key ascending, null last. */
function compareKeys(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

function ranked(tally: KeyTally, topN: number): RankedStats {
  const rows: RankedRow[] = [...tally.keys].map(([key, t]) => ({ key, ...t }));
  if (tally.none.messages > 0) rows.push({ key: null, ...tally.none });
  const top = (by: 'messages' | 'bytes'): RankedRow[] =>
    [...rows]
      .sort((a, b) => b[by] - a[by] || compareKeys(a.key, b.key))
      .slice(0, topN)
      .map((r) => ({ ...r }));
  return { byCount: top('messages'), bySize: top('bytes'), others: { ...tally.others } };
}

export function createStatsAggregator(opts: StatsAggregatorOptions): StatsAggregator {
  const format = yearFormatter(opts.timeZone);
  const maxKeys = count(opts.maxKeys) ?? STATS_MAX_KEYS;
  const topN = count(opts.topN) ?? STATS_TOP_N;
  const folders: FolderState[] = [];
  let current: FolderState | null = null;
  const totals: CountBytes = { messages: 0, bytes: 0 };
  const years = new Map<string, CountBytes>();
  const senders = newTally();
  const domains = newTally();
  // Sorted by bytes descending; a new message goes after equal sizes (first seen wins ties).
  const largest: LargestMail[] = [];
  let approximate = false;

  function tallyKey(tally: KeyTally, key: string | null, bytes: number): void {
    if (key === null) return bump(tally.none, bytes);
    const known = tally.keys.get(key);
    if (known !== undefined) return bump(known, bytes);
    if (tally.keys.size < maxKeys) {
      tally.keys.set(key, { messages: 1, bytes });
      return;
    }
    bump(tally.others, bytes);
    approximate = true;
  }

  function addLargest(folder: string, msg: FetchedMessage, bytes: number): void {
    if (topN === 0) return;
    const last = largest[largest.length - 1];
    if (largest.length === topN && last !== undefined && bytes <= last.bytes) return;
    let at = largest.length;
    while (at > 0 && (largest[at - 1] as LargestMail).bytes < bytes) at--;
    largest.splice(at, 0, {
      folder,
      received: receivedDate(msg.internalDate),
      from: sender(msg.envelope),
      subject: capped(record(msg.envelope)?.['subject']),
      bytes,
    });
    if (largest.length > topN) largest.pop();
  }

  function need(): FolderState {
    if (current === null) throw new Error('stats aggregator: no current folder');
    return current;
  }

  return {
    startFolder(path) {
      current = { path, messages: 0, bytes: 0, failed: false };
      folders.push(current);
    },
    add(msg) {
      const folder = need();
      const size = count(msg.size);
      const bytes = size ?? 0;
      bump(folder, bytes);
      bump(totals, bytes);
      const year = yearOf(msg.internalDate, format);
      const yearTally = years.get(year);
      if (yearTally === undefined) years.set(year, { messages: 1, bytes });
      else bump(yearTally, bytes);
      const key = senderKey(msg.envelope);
      tallyKey(senders, key, bytes);
      tallyKey(domains, domainOf(key), bytes);
      if (size !== null) addLargest(folder.path, msg, size);
    },
    folderFailed() {
      need().failed = true;
    },
    result() {
      const rows: StatsFolderRow[] = folders.map((f) =>
        f.failed && f.messages === 0
          ? { path: f.path, messages: null, bytes: null, partial: false }
          : { path: f.path, messages: f.messages, bytes: f.bytes, partial: f.failed },
      );
      const yearRows: StatsYearRow[] = [...years]
        .map(([year, t]) => ({ year, ...t }))
        .sort((a, b) =>
          a.year === UNKNOWN_YEAR
            ? 1
            : b.year === UNKNOWN_YEAR
              ? -1
              : Number(a.year) - Number(b.year),
        );
      return {
        folders: rows,
        notScanned: 0,
        totals: { ...totals },
        years: yearRows,
        senders: ranked(senders, topN),
        domains: ranked(domains, topN),
        largest: largest.map((l) => ({ ...l })),
        approximate,
        unreadable: rows.filter((r) => r.messages === null).length,
        partial: rows.filter((r) => r.partial).length,
      };
    },
  };
}

/** A server-reported `\All` / `\Flagged` outside Gmail: a view of other folders' mail. */
function virtualFolder(f: FolderInfo): boolean {
  return f.roleSource === 'extension' && (f.role === 'all' || f.role === 'flagged');
}

/**
 * The folders `mm stats` reads. `folder`: exactly that path (INBOX in any case), else the
 * single folder whose displayed path (`displayPath`) equals it, else `folder-not-found`.
 * Gmail: All Mail + Trash + Spam (labels are in All Mail), or `gmail-all-hidden`. Others:
 * every selectable folder except virtual ones.
 */
export function statsScope(
  tree: FolderTree,
  gmail: boolean,
  folder?: string,
  displayPath?: (path: string) => string,
): { folders: FolderInfo[]; notScanned: number } {
  if (folder !== undefined) {
    const inbox = folder.toUpperCase() === 'INBOX';
    let match =
      tree.folders.find((f) => f.path === folder) ??
      (inbox ? tree.folders.find((f) => f.path.toUpperCase() === 'INBOX') : undefined);
    if (match === undefined && displayPath !== undefined) {
      // The path as the shell prints it (invisible characters removed): only an unambiguous one.
      const shown = tree.folders.filter((f) => displayPath(f.path) === folder);
      if (shown.length === 1) match = shown[0];
    }
    if (match === undefined || !match.selectable) throw new MailboxError('folder-not-found');
    return { folders: [match], notScanned: 0 };
  }
  if (gmail && tree.gmailAllHidden) throw new MailboxError('gmail-all-hidden');
  const selectable = tree.folders.filter((f) => f.selectable);
  const folders = selectable.filter(gmail ? gmailSummed : (f) => !virtualFolder(f));
  return { folders, notScanned: selectable.length - folders.length };
}

export interface CollectStatsOptions {
  /** One folder by its full path (`--folder`). */
  folder?: string;
  timeZone: string;
  onProgress?: (p: SizeProgress) => void;
  batchSize?: number;
  /** How the shell prints a folder path (`--json`): the `--folder` fallback match. */
  displayPath?: (path: string) => string;
}

/** Whether a FETCH response belongs to the range asked for (not unsolicited, not repeated). */
function wanted(msg: FetchedMessage, range: ScanRange, seen: Set<number>): boolean {
  const seq = msg.seq;
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq)) return false;
  if (seq < range.from || seq > range.to || seen.has(seq)) return false;
  if (msg.envelope === undefined && msg.internalDate === undefined && msg.size === undefined) {
    return false;
  }
  seen.add(seq);
  return true;
}

/**
 * Reads the scoped folders one by one into the stats. A folder that fails or comes back short
 * (fewer messages than it holds, without an error) is kept as unreadable or partial and the
 * scan goes on; a closed connection throws `connection-lost`; a scope problem throws
 * `folder-not-found` / `gmail-all-hidden`. An exception from the aggregation itself is a bug
 * and is rethrown unchanged.
 */
export async function collectStats(
  session: FolderSession,
  tree: FolderTree,
  opts: CollectStatsOptions,
): Promise<MailboxStats> {
  const gmail = session.features.gmail;
  const scope = statsScope(tree, gmail, opts.folder, opts.displayPath);
  const agg = createStatsAggregator({ timeZone: opts.timeZone });
  const n = scope.folders.length;
  for (let i = 0; i < n; i++) {
    const path = (scope.folders[i] as FolderInfo).path;
    agg.startFolder(path);
    // Seqs seen in the current range: at most one batch, cleared on every new range.
    const seen = new Set<number>();
    let seenRange: ScanRange | null = null;
    // Messages of this folder that passed the filter: compared with what the folder holds.
    let counted = 0;
    const failure: { bug: { err: unknown } | null } = { bug: null };
    const onMessage = (msg: FetchedMessage, range: ScanRange): void => {
      try {
        if (seenRange === null || seenRange.from !== range.from || seenRange.to !== range.to) {
          seen.clear();
          seenRange = { from: range.from, to: range.to };
        }
        if (wanted(msg, range, seen)) {
          agg.add(msg);
          counted++;
        }
      } catch (err) {
        failure.bug = { err };
        throw err;
      }
    };
    let failed: boolean;
    try {
      const { exists } = await scanFolder(session, path, STATS_QUERY, onMessage, {
        batchSize: opts.batchSize ?? SIZE_BATCH,
        onProgress: (done, total) => {
          opts.onProgress?.({ folder: i + 1, folders: n, done, total });
        },
      });
      // A range can end early without an error (imapflow gives up on a throttled FETCH after
      // its retries and yields nothing): fewer messages than the folder holds is a failed read.
      failed = counted < exists;
    } catch {
      if (failure.bug !== null) throw failure.bug.err;
      checkOpen(session);
      // E.g. EXAMINE refused, or a NO for mail expunged during the scan: keep what was counted.
      failed = true;
    }
    if (failed) agg.folderFailed();
    checkOpen(session);
  }
  return { ...agg.result(), notScanned: scope.notScanned };
}
