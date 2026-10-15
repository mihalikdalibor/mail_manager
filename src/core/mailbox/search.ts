import { passesChecks, type CompiledFilter } from '../filters/compile.js';
import type { FetchedMessage, SearchPassQuery } from '../imap/session.js';
import { MailboxError, SearchStopped } from './errors.js';
import { checkOpen, count } from './guards.js';
import {
  PAGE_QUERY,
  PAGE_SIZE,
  receivedDate,
  toRow,
  withFolder,
  type FolderSnapshot,
  type MessageRow,
  type MessageSession,
  type PageResult,
} from './messages.js';

// The filter pass over one folder (M3a), read-only: the folder is EXAMINEd, the server's UID
// SEARCH gives the candidates, and one streaming pass fetches them by UID in sets of at most
// SEARCH_BATCH_UIDS UIDs and SEARCH_SET_CHARS characters. The pass asks for UID, size, received
// date and, when a check or the caller (`SearchOptions.envelope`) needs them, the envelope and
// structure: never a body, never a flag, so `\Seen` is never set. Nothing here stores or logs a
// message: the caller gets the matches (UID, size, received date) and their total size. A page of
// matches is read by UID (`loadMatches`).
// The orders of the matches (M3b: `sortMatches`, `compareMatches`) are here too, so the browser
// and the CLI sort alike.

export { SearchStopped };

export const SEARCH_BATCH_UIDS = 5000;
export const SEARCH_SET_CHARS = 4000;
export const SEARCH_MAX_MATCHES = 500_000;

export interface Match {
  uid: number;
  /** RFC822.SIZE; null when the server gave none. */
  bytes: number | null;
  /** INTERNALDATE in ms; null when missing or invalid. */
  received: number | null;
}

export interface SearchResult {
  /** The folder as it was when it was searched. */
  snapshot: FolderSnapshot;
  /** UID descending. */
  matches: Match[];
  /** Sum of the known sizes. */
  bytes: number;
  /** Candidates the pass did not return: expunged meanwhile, or a read the server cut short. */
  missing: number;
}

export interface SearchOptions {
  /** After each batch: candidates gone through so far, of all candidates. */
  onProgress?: (done: number, total: number) => void;
  /** Asked before each batch; true ends the search with SearchStopped. */
  shouldStop?: () => boolean;
  /** Default SEARCH_MAX_MATCHES (candidates, before the checks). */
  maxMatches?: number;
  /** true: the pass also fetches the envelope when no check needs it. */
  envelope?: boolean;
  /**
   * Called once per match, after its checks passed, with the fetched message. Must not throw
   * (an exception inside the pass is reported by withFolder as folder-unavailable).
   */
  onMatch?: (match: Match, msg: FetchedMessage) => void;
}

interface UidChunk {
  set: string;
  /** UIDs in the set. */
  count: number;
}

/** A limit as the caller gave it: at least 1 and whole; a non-finite one gives the default. */
function limit(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;
}

/** A UID the server may have sent: a positive safe integer, otherwise null. */
function positiveUid(value: unknown): number | null {
  const uid = count(value);
  return uid !== null && uid > 0 ? uid : null;
}

/** Runs of consecutive UIDs of an ascending list, as [first, last] pairs. */
function runsOf(uidsAscending: readonly number[]): [number, number][] {
  const runs: [number, number][] = [];
  for (const uid of uidsAscending) {
    const last = runs[runs.length - 1];
    if (last !== undefined && uid === last[1] + 1) last[1] = uid;
    else runs.push([uid, uid]);
  }
  return runs;
}

/**
 * The UIDs split into sets of at most `maxUids` UIDs and `maxChars` characters, in order. Input:
 * ascending positive safe integers, no duplicates (the callers guarantee it). Ranges are `a:b`.
 */
function uidChunks(
  uidsAscending: readonly number[],
  maxUids: number,
  maxChars: number,
): UidChunk[] {
  const uidLimit = limit(maxUids, SEARCH_BATCH_UIDS);
  const charLimit = limit(maxChars, SEARCH_SET_CHARS);
  const chunks: UidChunk[] = [];
  let tokens: string[] = [];
  let uidsInSet = 0;
  let chars = 0;
  const flush = (): void => {
    chunks.push({ set: tokens.join(','), count: uidsInSet });
    tokens = [];
    uidsInSet = 0;
    chars = 0;
  };
  for (const [first, last] of runsOf(uidsAscending)) {
    let a = first;
    while (a <= last) {
      const room = uidLimit - uidsInSet;
      if (room === 0) {
        flush();
        continue;
      }
      const end = Math.min(last, a + room - 1);
      const token = a === end ? String(a) : `${a}:${end}`;
      const extra = token.length + (tokens.length > 0 ? 1 : 0);
      // A token that doesn't fit starts the next set (a lone token always goes in).
      if (chars + extra > charLimit && tokens.length > 0) {
        flush();
        continue;
      }
      tokens.push(token);
      uidsInSet += end - a + 1;
      chars += extra;
      a = end + 1;
    }
  }
  if (tokens.length > 0) flush();
  return chunks;
}

/** UID sets for FETCH / SEARCH: `1:5000`, `5001:10000`, `1:3,7,9:10`. */
export function uidSets(
  uidsAscending: readonly number[],
  maxUids = SEARCH_BATCH_UIDS,
  maxChars = SEARCH_SET_CHARS,
): string[] {
  return uidChunks(uidsAscending, maxUids, maxChars).map((chunk) => chunk.set);
}

export type SearchOrder = 'newest' | 'oldest' | 'largest';

/** Compares two values, either of which may be missing: a missing one sorts last. */
function nullsLast(
  a: number | null,
  b: number | null,
  compare: (x: number, y: number) => number,
): number {
  if (a === null || b === null) return (a === null ? 1 : 0) - (b === null ? 1 : 0);
  return compare(a, b);
}

/**
 * newest: received desc, null last, then uid desc; oldest: received asc, null last, uid asc;
 * largest: bytes desc, null last, uid desc.
 */
export function compareMatches(a: Match, b: Match, order: SearchOrder): number {
  if (order === 'largest') return nullsLast(a.bytes, b.bytes, (x, y) => y - x) || b.uid - a.uid;
  if (order === 'oldest') {
    return nullsLast(a.received, b.received, (x, y) => x - y) || a.uid - b.uid;
  }
  return nullsLast(a.received, b.received, (x, y) => y - x) || b.uid - a.uid;
}

/** A new array in the order asked (`compareMatches`). */
export function sortMatches(matches: readonly Match[], order: SearchOrder): Match[] {
  return [...matches].sort((a, b) => compareMatches(a, b, order));
}

/**
 * The matches of a filter in one folder, UID descending, with their total size. Runs under one
 * read-only lock. Throws SearchStopped (asked between batches), or MailboxError: too-many-matches,
 * search-failed, connection-lost, folder-unavailable.
 */
export async function searchFolder(
  session: MessageSession,
  path: string,
  compiled: CompiledFilter,
  opts: SearchOptions = {},
): Promise<SearchResult> {
  return withFolder(session, path, async (snapshot): Promise<SearchResult> => {
    if (session.client.search === undefined) throw new MailboxError('search-failed');
    let found: number[] | false | undefined;
    try {
      found = await session.client.search(compiled.query, { uid: true });
    } catch {
      checkOpen(session);
      throw new MailboxError('search-failed');
    }
    if (!Array.isArray(found)) throw new MailboxError('search-failed');

    const uids = new Set<number>();
    for (const value of found) {
      const uid = positiveUid(value);
      if (uid !== null) uids.add(uid);
    }
    const candidates = [...uids].sort((a, b) => a - b);
    if (candidates.length > (opts.maxMatches ?? SEARCH_MAX_MATCHES)) {
      throw new MailboxError('too-many-matches');
    }

    const query: SearchPassQuery = {
      uid: true,
      size: true,
      internalDate: true,
      ...((compiled.needs.envelope || opts.envelope === true) && { envelope: true as const }),
      ...(compiled.needs.structure && { bodyStructure: true as const }),
    };
    const wanted = new Set(candidates);
    const seen = new Set<number>();
    const matches: Match[] = [];
    let done = 0;
    for (const chunk of uidChunks(candidates, SEARCH_BATCH_UIDS, SEARCH_SET_CHARS)) {
      if (opts.shouldStop?.() === true) throw new SearchStopped();
      for await (const msg of session.client.fetch(chunk.set, query, { uid: true })) {
        const uid = count(msg.uid);
        if (uid === null || uid <= 0 || !wanted.has(uid) || seen.has(uid)) continue;
        seen.add(uid);
        if (passesChecks(compiled.checks, msg)) {
          const match: Match = {
            uid,
            bytes: count(msg.size),
            received: receivedDate(msg.internalDate)?.getTime() ?? null,
          };
          matches.push(match);
          opts.onMatch?.(match, msg);
        }
      }
      done += chunk.count;
      try {
        opts.onProgress?.(done, candidates.length);
      } catch {
        // Progress output never decides the result.
      }
    }

    matches.sort((a, b) => b.uid - a.uid);
    const bytes = matches.reduce((sum, match) => sum + (match.bytes ?? 0), 0);
    return { snapshot, matches, bytes, missing: candidates.length - seen.size };
  });
}

/**
 * The rows of one page of matches, by UID, in the order asked: at most PAGE_SIZE UIDs. A UID
 * the server no longer has is left out. `changed` when the folder's UIDVALIDITY differs from
 * `expected` (nothing is fetched).
 */
export async function loadMatches(
  session: MessageSession,
  path: string,
  expected: FolderSnapshot,
  page: number,
  uids: readonly number[],
): Promise<PageResult> {
  return withFolder(session, path, async (snapshot): Promise<PageResult> => {
    if (snapshot.uidValidity !== expected.uidValidity) return { kind: 'changed', snapshot };
    const askedSet = new Set<number>();
    const asked: number[] = [];
    for (const value of uids) {
      if (asked.length === PAGE_SIZE) break;
      const uid = positiveUid(value);
      if (uid !== null && !askedSet.has(uid)) {
        askedSet.add(uid);
        asked.push(uid);
      }
    }
    if (asked.length === 0) return { kind: 'page', snapshot, page, rows: [] };

    const byUid = new Map<number, MessageRow>();
    for (const set of uidSets([...asked].sort((a, b) => a - b))) {
      for await (const msg of session.client.fetch(set, PAGE_QUERY, { uid: true })) {
        const row = toRow(msg);
        if (row !== null && askedSet.has(row.uid) && !byUid.has(row.uid)) {
          byUid.set(row.uid, row);
        }
      }
    }
    const rows: MessageRow[] = [];
    for (const uid of asked) {
      const row = byUid.get(uid);
      if (row !== undefined) rows.push(row);
    }
    return { kind: 'page', snapshot, page, rows };
  });
}
