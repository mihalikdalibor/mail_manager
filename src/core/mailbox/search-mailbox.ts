import type { CompiledFilter } from '../filters/compile.js';
import { MailboxError } from './errors.js';
import type { FolderSession, FolderTree, SizeProgress } from './folders.js';
import { checkOpen } from './guards.js';
import { PAGE_SIZE, type FolderSnapshot, type MessageRow } from './messages.js';
import {
  compareMatches,
  loadMatches,
  searchFolder,
  sortMatches,
  type Match,
  type SearchOrder,
} from './search.js';
import { senderKey, STATS_MAX_KEYS, statsScope, type CountBytes } from './stats.js';

// `mm search` over the mailbox (M3b), read-only: the filter runs over the stats scope's folders
// (`searchFolder`, one folder at a time), the matches are totalled per folder, the senders are
// tallied and a sample of the matches in the order asked is read by UID (`loadMatches`). A
// folder the server refuses is kept as a failed row and the rest are searched. Nothing here
// stores or logs a message: the caller gets the per-folder snapshot and matches (the M4 delete
// planner's input), the sender rows and the sample rows. Senders, subjects and folder names are
// server data, returned unsanitised for the shell to sanitise.

export const SEARCH_TOP_SENDERS = 10;
export const SEARCH_SAMPLES_DEFAULT = 20;
export const SEARCH_SAMPLES_MAX = PAGE_SIZE;

export interface FolderMatches {
  path: string;
  /** The folder as searched; null when it couldn't be searched. */
  snapshot: FolderSnapshot | null;
  /** null = searched; otherwise why it couldn't be. */
  reason: 'search-failed' | 'folder-unavailable' | null;
  /** UID descending ([] when failed). */
  matches: Match[];
  bytes: number;
  missing: number;
}

export interface SenderRow {
  key: string | null;
  messages: number;
  bytes: number;
}

/**
 * From the page row (`MessageRow`): `from` = the first From's name, else its address
 * (`messages.ts` › `sender`); `subject` capped; `attachment` by the structure rule.
 */
export interface SampleRow {
  folder: string;
  uid: number;
  received: Date | null;
  from: string | null;
  subject: string | null;
  bytes: number | null;
  attachment: boolean;
}

export interface MailboxSearch {
  /** Every scoped folder, scope order. */
  folders: FolderMatches[];
  /** Selectable folders left out of the scope (`statsScope`). */
  notSearched: number;
  totals: CountBytes;
  /** Rows with reason !== null. */
  failed: number;
  /** Sum of the folders' missing candidates. */
  missing: number;
  /** At most SEARCH_TOP_SENDERS. */
  senders: SenderRow[];
  /** Matches whose sender key didn't fit STATS_MAX_KEYS. */
  sendersOthers: CountBytes;
  samples: SampleRow[];
  /** Sample matches the server no longer has (or a folder that changed), not shown. */
  samplesGone: number;
}

export interface SearchMailboxOptions {
  /** One folder by its full path (`--folder`). */
  folder?: string;
  /** How the shell prints a folder path: the `--folder` fallback match. */
  displayPath?: (path: string) => string;
  order: SearchOrder;
  /** Clamped to 0..SEARCH_SAMPLES_MAX; non-finite → SEARCH_SAMPLES_DEFAULT. */
  limit: number;
  onProgress?: (p: SizeProgress) => void;
}

/**
 * Sender tallies: a key past STATS_MAX_KEYS goes to `others`; the null key (no address) to `none`.
 */
interface Tally {
  keys: Map<string, CountBytes>;
  none: CountBytes;
  others: CountBytes;
}

/** A shown candidate: the folder's index in `folders` (scope order) and its match. */
interface Candidate {
  folder: number;
  match: Match;
}

function newTally(): Tally {
  return { keys: new Map(), none: { messages: 0, bytes: 0 }, others: { messages: 0, bytes: 0 } };
}

function bump(tally: CountBytes, messages: number, bytes: number): void {
  tally.messages += messages;
  tally.bytes += bytes;
}

function addKey(tally: Tally, key: string | null, messages: number, bytes: number): void {
  if (key === null) return bump(tally.none, messages, bytes);
  const known = tally.keys.get(key);
  if (known !== undefined) return bump(known, messages, bytes);
  if (tally.keys.size < STATS_MAX_KEYS) {
    tally.keys.set(key, { messages, bytes });
    return;
  }
  bump(tally.others, messages, bytes);
}

/** Adds a searched folder's tally to the search's. */
function mergeTally(into: Tally, from: Tally): void {
  for (const [key, t] of from.keys) addKey(into, key, t.messages, t.bytes);
  addKey(into, null, from.none.messages, from.none.bytes);
  bump(into.others, from.others.messages, from.others.bytes);
}

/** Key ascending, null last. */
function compareKeys(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

function sampleOf(path: string, row: MessageRow): SampleRow {
  return {
    folder: path,
    uid: row.uid,
    received: row.received,
    from: row.from,
    subject: row.subject,
    bytes: row.bytes,
    attachment: row.attachment,
  };
}

/**
 * The rows of a folder's shown matches, by UID. A folder that is gone or can't be read now gives
 * none (the caller counts its matches as gone); a closed connection is rethrown.
 */
async function readRows(
  session: FolderSession,
  path: string,
  snapshot: FolderSnapshot,
  uids: readonly number[],
): Promise<Map<number, SampleRow>> {
  const rows = new Map<number, SampleRow>();
  try {
    const page = await loadMatches(session, path, snapshot, 0, uids);
    if (page.kind === 'page') {
      for (const row of page.rows) rows.set(row.uid, sampleOf(path, row));
    }
  } catch (err) {
    if (!(err instanceof MailboxError) || err.code !== 'folder-unavailable') throw err;
    checkOpen(session);
  }
  return rows;
}

/**
 * The first `limit` matches of all searched folders in the order asked (ties keep the scope
 * order), read by UID per folder. Each folder can only contribute its first `limit` matches.
 */
async function readSamples(
  session: FolderSession,
  folders: readonly FolderMatches[],
  order: SearchOrder,
  limit: number,
): Promise<{ samples: SampleRow[]; gone: number }> {
  if (limit === 0) return { samples: [], gone: 0 };
  const candidates: Candidate[] = [];
  for (const [folder, row] of folders.entries()) {
    if (row.snapshot === null) continue;
    for (const match of sortMatches(row.matches, order).slice(0, limit)) {
      candidates.push({ folder, match });
    }
  }
  candidates.sort((a, b) => compareMatches(a.match, b.match, order) || a.folder - b.folder);
  const shown = candidates.slice(0, limit);

  const rows = new Map<number, Map<number, SampleRow>>();
  for (const [folder, row] of folders.entries()) {
    const uids = shown.filter((c) => c.folder === folder).map((c) => c.match.uid);
    if (row.snapshot === null || uids.length === 0) continue;
    rows.set(folder, await readRows(session, row.path, row.snapshot, uids));
  }

  const samples: SampleRow[] = [];
  let gone = 0;
  for (const { folder, match } of shown) {
    const sample = rows.get(folder)?.get(match.uid);
    if (sample === undefined) gone++;
    else samples.push(sample);
  }
  return { samples, gone };
}

/**
 * The filter over the scope's folders (`statsScope`: `folder`, Gmail's All Mail + Trash + Spam,
 * else every selectable folder but the virtual ones). A folder the server refuses (search or
 * lock) is a failed row and the rest are searched; when every folder of the scope failed, throws
 * the first failed folder's code. Throws too-many-matches, connection-lost and the scope errors
 * (folder-not-found, gmail-all-hidden) at once.
 */
export async function searchMailbox(
  session: FolderSession,
  tree: FolderTree,
  compiled: CompiledFilter,
  opts: SearchMailboxOptions,
): Promise<MailboxSearch> {
  const scope = statsScope(tree, session.features.gmail, opts.folder, opts.displayPath);
  const limit = Number.isFinite(opts.limit)
    ? Math.min(SEARCH_SAMPLES_MAX, Math.max(0, Math.floor(opts.limit)))
    : SEARCH_SAMPLES_DEFAULT;
  const tally = newTally();
  const folders: FolderMatches[] = [];
  const n = scope.folders.length;
  for (const [i, info] of scope.folders.entries()) {
    // The folder's senders are kept apart: a folder that fails is dropped, not merged.
    const local = newTally();
    try {
      const result = await searchFolder(session, info.path, compiled, {
        envelope: true,
        onMatch: (match, msg) => addKey(local, senderKey(msg.envelope), 1, match.bytes ?? 0),
        onProgress: (done, total) => opts.onProgress?.({ folder: i + 1, folders: n, done, total }),
      });
      folders.push({
        path: info.path,
        snapshot: result.snapshot,
        reason: null,
        matches: result.matches,
        bytes: result.bytes,
        missing: result.missing,
      });
      mergeTally(tally, local);
    } catch (err) {
      if (
        !(err instanceof MailboxError) ||
        (err.code !== 'search-failed' && err.code !== 'folder-unavailable')
      ) {
        throw err;
      }
      checkOpen(session);
      folders.push({
        path: info.path,
        snapshot: null,
        reason: err.code,
        matches: [],
        bytes: 0,
        missing: 0,
      });
    }
  }

  const firstFailed = folders.find((f) => f.reason !== null);
  if (
    firstFailed !== undefined &&
    firstFailed.reason !== null &&
    folders.every((f) => f.reason !== null)
  ) {
    throw new MailboxError(firstFailed.reason);
  }

  const totals: CountBytes = { messages: 0, bytes: 0 };
  for (const f of folders) bump(totals, f.matches.length, f.bytes);

  const senders: SenderRow[] = [...tally.keys].map(([key, t]) => ({ key, ...t }));
  if (tally.none.messages > 0) senders.push({ key: null, ...tally.none });
  senders.sort((a, b) => b.messages - a.messages || b.bytes - a.bytes || compareKeys(a.key, b.key));

  const { samples, gone } = await readSamples(session, folders, opts.order, limit);

  return {
    folders,
    notSearched: scope.notScanned,
    totals,
    failed: folders.filter((f) => f.reason !== null).length,
    missing: folders.reduce((sum, f) => sum + f.missing, 0),
    senders: senders.slice(0, SEARCH_TOP_SENDERS),
    sendersOthers: { ...tally.others },
    samples,
    samplesGone: gone,
  };
}
