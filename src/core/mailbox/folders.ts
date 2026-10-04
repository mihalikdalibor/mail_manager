import type { ListResponse, StatusObject, StatusQuery } from 'imapflow';
import type { ImapSession } from '../imap/session.js';
import { MailboxError } from './errors.js';
import { checkOpen, count } from './guards.js';
import { SIZE_BATCH, scanFolder, type ScanRange } from './scan.js';

export { SIZE_BATCH, sizeRanges } from './scan.js';

// The folder tree of a mailbox (M2a): LIST + counts + sizes + quota, read-only. Folder names
// come from the server and are untrusted: they are returned as data and the shell sanitises
// them before display. Nothing here logs; the fallbacks used are returned for the shell to log.
//
// Order of IMAP commands: LIST, then every STATUS, then quota, then the size fallback (EXAMINE
// + FETCH RFC822.SIZE) — a folder is never STATUSed while it is selected (docs/IMAP.md §4).

export const MAX_FOLDERS = 5000;

export type FolderRole =
  'inbox' | 'all' | 'archive' | 'drafts' | 'flagged' | 'junk' | 'sent' | 'trash';
/** `path`: INBOX by its name; otherwise imapflow's `specialUseSource`. */
export type RoleSource = 'path' | 'extension' | 'name' | 'user';
/** `server`: STATUS=SIZE (RFC 8438: ≥ the sum of RFC822.SIZE); `sum`: our own FETCH sum. */
export type SizeSource = 'server' | 'sum';

/** A server feature that was missing, and what ran instead (the shell logs it once). */
export type FallbackFeature = 'status-size' | 'quota' | 'list-status';
export type FallbackKind = 'fetch-size-sum' | 'folder-sum' | 'status-per-folder';
export const FALLBACK_OF: Record<FallbackFeature, FallbackKind> = {
  'status-size': 'fetch-size-sum',
  quota: 'folder-sum',
  'list-status': 'status-per-folder',
};

export interface FolderInfo {
  /** Full path as the server lists it (unsanitised). */
  path: string;
  /** Last path segment (unsanitised). */
  name: string;
  /** Nearest listed ancestor, or null at the root. */
  parentPath: string | null;
  /** From the delimiter segments (0 = top level). */
  depth: number;
  delimiter: string | null;
  role: FolderRole | null;
  roleSource: RoleSource | null;
  selectable: boolean;
  subscribed: boolean;
  /** null = unknown (not selectable, STATUS failed, or not read). */
  messages: number | null;
  unseen: number | null;
  bytes: number | null;
  sizeSource: SizeSource | null;
  /** Gmail label folder: its messages are also in All Mail, so it isn't summed. */
  overlapping: boolean;
}

export interface FolderTotals {
  messages: number | null;
  unseen: number | null;
  bytes: number | null;
  sizeSource: SizeSource | null;
}

export interface QuotaBytes {
  usedBytes: number;
  limitBytes: number | null;
}

export interface FolderTree {
  /** Parent before child: INBOX, special-use folders, then by path (at every level). */
  folders: FolderInfo[];
  /** null when unknown (Gmail with All Mail hidden from IMAP). */
  totals: FolderTotals | null;
  quota: QuotaBytes | null;
  /** More than MAX_FOLDERS were listed; only the first ones are here. */
  truncated: boolean;
  /** Selectable folders whose counts or size could not be read. */
  unreadable: number;
  /** Gmail without a `\All` folder: totals can't be computed. */
  gmailAllHidden: boolean;
  fallbacks: ReadonlySet<FallbackFeature>;
}

export interface SizeProgress {
  /** 1-based index of the folder being sized, of `folders` that need the fallback. */
  folder: number;
  folders: number;
  /** Messages read so far in this folder, of `total`. */
  done: number;
  total: number;
}

export interface ListFoldersOptions {
  /** Read sizes (STATUS=SIZE or the FETCH fallback). false = `--no-size`. */
  sizes: boolean;
  onProgress?: (p: SizeProgress) => void;
  /** Only these folders are STATUSed and sized (the live test); the others keep LIST data. */
  only?: (path: string) => boolean;
  batchSize?: number;
}

/** The part of ImapSession this module needs (tests pass a fake). */
export type FolderSession = Pick<ImapSession, 'client' | 'features' | 'closed'>;

const SPECIAL_USE_ROLES: Record<string, FolderRole> = {
  // imapflow marks a localised XLIST inbox (e.g. "Posteingang") with \Inbox.
  '\\inbox': 'inbox',
  '\\all': 'all',
  '\\archive': 'archive',
  '\\drafts': 'drafts',
  '\\flagged': 'flagged',
  '\\junk': 'junk',
  '\\sent': 'sent',
  '\\trash': 'trash',
};

const GMAIL_SUMMED: ReadonlySet<FolderRole> = new Set<FolderRole>(['all', 'trash', 'junk']);

/**
 * Gmail's own All Mail / Trash / Spam: only a server-reported role counts. A role guessed from
 * the name (imapflow does that when Spam/Trash is hidden from IMAP) could be a user label whose
 * mail is already in All Mail — summing it would count it twice.
 */
export function gmailSummed(f: FolderInfo): boolean {
  return (
    f.selectable && f.roleSource === 'extension' && f.role !== null && GMAIL_SUMMED.has(f.role)
  );
}

function gmailAllListed(folders: readonly FolderInfo[]): boolean {
  return folders.some((f) => gmailSummed(f) && f.role === 'all');
}

function lowerFlags(entry: Pick<ListResponse, 'flags'>): Set<string> {
  const out = new Set<string>();
  // Server data: a missing or odd `flags` must not throw.
  if (entry.flags instanceof Set) {
    for (const f of entry.flags) if (typeof f === 'string') out.add(f.toLowerCase());
  }
  return out;
}

/** Role of a listed folder: INBOX by its path, otherwise its special-use flag. */
export function roleOf(entry: Pick<ListResponse, 'path' | 'specialUse' | 'specialUseSource'>): {
  role: FolderRole | null;
  roleSource: RoleSource | null;
} {
  if (entry.path.toUpperCase() === 'INBOX') return { role: 'inbox', roleSource: 'path' };
  const role =
    typeof entry.specialUse === 'string'
      ? SPECIAL_USE_ROLES[entry.specialUse.toLowerCase()]
      : undefined;
  if (role === undefined) return { role: null, roleSource: null };
  const source = entry.specialUseSource;
  return {
    role,
    roleSource: source === 'user' || source === 'name' ? source : 'extension',
  };
}

function delimiterOf(entry: Pick<ListResponse, 'delimiter'>): string | null {
  return typeof entry.delimiter === 'string' && entry.delimiter.length > 0 ? entry.delimiter : null;
}

const ROLE_ORDER: Record<FolderRole, number> = {
  inbox: 0,
  drafts: 1,
  sent: 2,
  archive: 3,
  all: 4,
  flagged: 5,
  junk: 6,
  trash: 7,
};

function compareFolders(a: FolderInfo, b: FolderInfo): number {
  const ra = a.role === null ? 99 : ROLE_ORDER[a.role];
  const rb = b.role === null ? 99 : ROLE_ORDER[b.role];
  if (ra !== rb) return ra - rb;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/**
 * Orders folders parent-before-child and sets `depth` / `parentPath`. A folder whose parent
 * wasn't listed (or was cut by the cap) hangs under its nearest listed ancestor, or the root;
 * its depth still comes from its own delimiter segments. No placeholders are added.
 */
export function buildTree(folders: readonly FolderInfo[]): FolderInfo[] {
  const byPath = new Map<string, FolderInfo>();
  for (const f of folders) if (!byPath.has(f.path)) byPath.set(f.path, f);
  const children = new Map<string | null, FolderInfo[]>();
  for (const f of byPath.values()) {
    let parentPath: string | null = null;
    let depth = 0;
    if (f.delimiter !== null) {
      const segments = f.path.split(f.delimiter);
      depth = Math.max(0, segments.length - 1);
      for (let i = segments.length - 1; i > 0; i--) {
        const candidate = segments.slice(0, i).join(f.delimiter);
        if (candidate !== f.path && byPath.has(candidate)) {
          parentPath = candidate;
          break;
        }
      }
    }
    f.parentPath = parentPath;
    f.depth = depth;
    const list = children.get(parentPath) ?? [];
    list.push(f);
    children.set(parentPath, list);
  }
  const out: FolderInfo[] = [];
  // Iterative depth-first walk: a 5,000-level path must not overflow the stack.
  const stack: FolderInfo[] = [...(children.get(null) ?? [])].sort(compareFolders).reverse();
  while (stack.length > 0) {
    const f = stack.pop() as FolderInfo;
    out.push(f);
    const kids = children.get(f.path);
    if (kids !== undefined) stack.push(...[...kids].sort(compareFolders).reverse());
  }
  return out;
}

function sumOrNull(values: (number | null)[]): number | null {
  let total = 0;
  for (const v of values) {
    if (v === null) return null;
    total += v;
  }
  return total;
}

/**
 * Totals without double counting. Gmail: `\All` + `\Trash` + `\Junk` (labels are flagged
 * `overlapping`); no `\All` → null. Others: every selectable folder. A sum with an unknown
 * part is unknown (null), never silently too small.
 */
export function computeTotals(
  folders: FolderInfo[],
  gmail: boolean,
): { totals: FolderTotals | null; gmailAllHidden: boolean } {
  let summed: FolderInfo[];
  if (gmail) {
    for (const f of folders) {
      f.overlapping = f.selectable && !gmailSummed(f);
    }
    if (!gmailAllListed(folders)) return { totals: null, gmailAllHidden: true };
    summed = folders.filter(gmailSummed);
  } else {
    summed = folders.filter((f) => f.selectable);
  }
  const bytes = sumOrNull(summed.map((f) => f.bytes));
  return {
    totals: {
      messages: sumOrNull(summed.map((f) => f.messages)),
      unseen: sumOrNull(summed.map((f) => f.unseen)),
      bytes,
      sizeSource:
        bytes === null ? null : summed.some((f) => f.sizeSource === 'sum') ? 'sum' : 'server',
    },
    gmailAllHidden: false,
  };
}

/** Applies a STATUS result; false when it failed (`status.error` is never read). */
function applyStatus(f: FolderInfo, status: StatusObject | false | undefined | null): boolean {
  const messages = count(status === false ? undefined : status?.messages);
  if (messages === null || status === false || status === undefined || status === null) {
    return false;
  }
  f.messages = messages;
  f.unseen = count(status.unseen);
  const size = count(status.size);
  if (size !== null) {
    f.bytes = size;
    f.sizeSource = 'server';
  }
  return true;
}

function toFolder(entry: ListResponse): FolderInfo {
  const flags = lowerFlags(entry);
  return {
    path: entry.path,
    name: typeof entry.name === 'string' ? entry.name : entry.path,
    parentPath: null,
    depth: 0,
    delimiter: delimiterOf(entry),
    ...roleOf(entry),
    selectable: !flags.has('\\noselect'),
    // imapflow only ever sets `true` (LSUB / RETURN SUBSCRIBED, or every folder when the server
    // reports no subscription state); an unsubscribed folder is left undefined.
    subscribed: entry.subscribed === true,
    messages: null,
    unseen: null,
    bytes: null,
    sizeSource: null,
    overlapping: false,
  };
}

/**
 * Sums RFC822.SIZE of a folder read-only (EXAMINE), batch by batch: only a number is kept.
 * A response counts only when its sequence number is inside the range asked for, wasn't counted
 * in that range yet and carries a size (not unsolicited, not repeated). `null` when fewer
 * messages were sized than the folder has (no error): the sum would be too small.
 */
async function sumSizes(
  session: FolderSession,
  path: string,
  batchSize: number,
  progress: (done: number, total: number) => void,
): Promise<number | null> {
  let total = 0;
  let sized = 0;
  // Seqs sized in the current range: at most one batch, cleared on every new range.
  const seen = new Set<number>();
  let seenRange: ScanRange | null = null;
  const { exists } = await scanFolder(
    session,
    path,
    { size: true },
    (msg, range) => {
      if (seenRange === null || seenRange.from !== range.from || seenRange.to !== range.to) {
        seen.clear();
        seenRange = { from: range.from, to: range.to };
      }
      const seq = msg.seq;
      if (typeof seq !== 'number' || !Number.isSafeInteger(seq)) return;
      if (seq < range.from || seq > range.to || seen.has(seq)) return;
      const size = count(msg.size);
      if (size === null) return;
      seen.add(seq);
      total += size;
      sized++;
    },
    { batchSize, onProgress: progress },
  );
  return sized < exists ? null : total;
}

/**
 * Lists every folder with counts, sizes and the quota. Throws `MailboxError` when LIST fails
 * (`list-failed`) or the connection closes (`connection-lost`); a single folder that can't be
 * read becomes `null` values and counts towards `unreadable`.
 */
export async function listFolders(
  session: FolderSession,
  opts: ListFoldersOptions,
): Promise<FolderTree> {
  const { client, features } = session;
  const fallbacks = new Set<FallbackFeature>();
  const only = opts.only;
  const wanted = (f: FolderInfo): boolean => f.selectable && (only === undefined || only(f.path));
  const askSize = opts.sizes && features.statusSize;
  const statusQuery: StatusQuery = { messages: true, unseen: true, ...(askSize && { size: true }) };
  // With `only`, LIST-STATUS would count every folder: take the per-folder path instead.
  const useListStatus = features.listStatus && only === undefined;
  if (!features.listStatus) fallbacks.add('list-status');

  let entries: ListResponse[];
  try {
    entries = await client.list(useListStatus ? { statusQuery } : undefined);
  } catch {
    checkOpen(session);
    throw new MailboxError('list-failed');
  }
  checkOpen(session);
  if (!Array.isArray(entries)) throw new MailboxError('list-failed');

  const listed = entries.filter((e) => !lowerFlags(e).has('\\nonexistent'));
  const truncated = listed.length > MAX_FOLDERS;
  const capped = listed.slice(0, MAX_FOLDERS);
  const folders = capped.map(toFolder);
  let unreadable = 0;

  // Counts: from LIST-STATUS, or our own STATUS per capped folder.
  for (let i = 0; i < folders.length; i++) {
    const f = folders[i] as FolderInfo;
    if (!wanted(f)) continue;
    let status: StatusObject | false | undefined;
    if (useListStatus && capped[i]?.status !== undefined) {
      status = capped[i]?.status;
    } else {
      // No LIST-STATUS, or the server left this folder out of it: ask it directly.
      try {
        status = await client.status(f.path, statusQuery);
      } catch {
        status = undefined;
      }
      checkOpen(session);
    }
    if (!applyStatus(f, status)) unreadable++;
  }

  // Quota.
  let quota: QuotaBytes | null = null;
  if (features.quota) {
    try {
      const q = await client.getQuota('INBOX');
      const used = q === false || q === undefined ? null : count(q.storage?.usage);
      if (used !== null && q !== false && q !== undefined) {
        quota = { usedBytes: used, limitBytes: count(q.storage?.limit) };
      }
    } catch {
      // Treated as "not reported"; a dropped connection is caught below.
    }
    checkOpen(session);
  }
  if (quota === null) fallbacks.add('quota');

  // Sizes: the FETCH fallback for every readable folder the server gave no size for.
  if (opts.sizes) {
    const toSize = folders.filter(
      (f) =>
        wanted(f) &&
        f.messages !== null &&
        f.sizeSource === null &&
        // Gmail: only All Mail / Trash / Spam, and only when All Mail is listed (otherwise the
        // totals are unknown anyway and a large Spam would be read for nothing).
        (!features.gmail || (gmailSummed(f) && gmailAllListed(folders))),
    );
    if (toSize.length > 0) fallbacks.add('status-size');
    const batchSize = opts.batchSize ?? SIZE_BATCH;
    for (let i = 0; i < toSize.length; i++) {
      const f = toSize[i] as FolderInfo;
      if (f.messages === 0) {
        f.bytes = 0;
        f.sizeSource = 'sum';
        continue;
      }
      try {
        const bytes = await sumSizes(session, f.path, batchSize, (done, total) => {
          try {
            opts.onProgress?.({ folder: i + 1, folders: toSize.length, done, total });
          } catch {
            // Progress output never decides whether a folder could be read.
          }
        });
        if (bytes === null) {
          f.bytes = null;
          unreadable++;
        } else {
          f.bytes = bytes;
          f.sizeSource = 'sum';
        }
      } catch {
        checkOpen(session);
        f.bytes = null;
        unreadable++;
      }
      checkOpen(session);
    }
  }

  const ordered = buildTree(folders);
  const { totals, gmailAllHidden } = computeTotals(ordered, features.gmail);
  return { folders: ordered, totals, quota, truncated, unreadable, gmailAllHidden, fallbacks };
}
