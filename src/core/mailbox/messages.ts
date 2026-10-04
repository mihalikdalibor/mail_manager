import type { ImapSession, MessagePageQuery, FetchedMessage } from '../imap/session.js';
import { MailboxError } from './errors.js';
import { checkOpen, count } from './guards.js';

// The mails of one folder, page by page (M2b), read-only. Newest arrived first: sequence
// numbers descending, 200 per page, paged against a snapshot (UIDVALIDITY + message count).
// Every read takes the read-only lock (EXAMINE) and sends NOOP before reading the snapshot:
// imapflow skips EXAMINE for an already selected folder and a non-UID FETCH may carry no
// EXPUNGE, so without NOOP new or expunged mail would go unseen. NOOP brings EXISTS / EXPUNGE
// only: UIDVALIDITY is read only on SELECT/EXAMINE, so a reset folder shows after a reconnect
// or after another folder was selected (M4 re-EXAMINEs before acting). Only UID, INTERNALDATE,
// ENVELOPE, RFC822.SIZE and BODYSTRUCTURE are fetched — never a body, never a flag change, so
// `\Seen` is never set. Sender and subject are server data: returned unsanitised (the shell
// sanitises them for display), only capped in length. Nothing here stores or logs them.

export const PAGE_SIZE = 200;
/** `from` and `subject` are cut to this many code points (bounds memory, not display). */
export const MAX_TEXT_CHARS = 500;
/** `hasAttachment` stops after this many BODYSTRUCTURE nodes (server data). */
export const MAX_STRUCTURE_NODES = 1000;

/** What a page was read against. `uidValidity` is the decimal of the server's number. */
export interface FolderSnapshot {
  path: string;
  uidValidity: string;
  exists: number;
}

export interface MessageRow {
  seq: number;
  uid: number;
  /** INTERNALDATE (when the server received it); null when missing or invalid. */
  received: Date | null;
  /** First From address: its name, else the address itself. */
  from: string | null;
  subject: string | null;
  bytes: number | null;
  attachment: boolean;
}

export type PageResult =
  | { kind: 'page'; snapshot: FolderSnapshot; page: number; rows: MessageRow[] }
  /** The folder changed since `expected` (new mail, expunge, UIDVALIDITY): nothing was fetched. */
  | { kind: 'changed'; snapshot: FolderSnapshot };

/** The part of ImapSession this module needs (tests pass a fake). */
export type MessageSession = Pick<ImapSession, 'client' | 'closed'>;

const PAGE_QUERY: MessagePageQuery = {
  uid: true,
  envelope: true,
  internalDate: true,
  size: true,
  bodyStructure: true,
};

function positive(value: unknown): number | null {
  const n = count(value);
  return n !== null && n > 0 ? n : null;
}

/** Sequence range of `page` (0 = newest), or null past the end / for an empty folder. */
export function pageRange(
  exists: number,
  page: number,
  size: number = PAGE_SIZE,
): { from: number; to: number } | null {
  if (count(exists) === null || count(page) === null || positive(size) === null) return null;
  const to = exists - size * page;
  if (to < 1) return null;
  return { from: Math.max(1, to - size + 1), to };
}

/** Number of pages of a folder with `exists` messages (0 when empty). */
export function pageCount(exists: number, size: number = PAGE_SIZE): number {
  if (count(exists) === null || positive(size) === null) return 0;
  return Math.ceil(exists / size);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function hasFilename(node: Record<string, unknown>): boolean {
  return (
    nonEmpty(record(node['dispositionParameters'])?.['filename']) ||
    nonEmpty(record(node['parameters'])?.['name'])
  );
}

/**
 * True when a part is an attachment: disposition `attachment`, a forwarded mail
 * (`message/rfc822`), or a named part that isn't an inline image. Iterative and capped at
 * MAX_STRUCTURE_NODES: the structure comes from the server.
 */
export function hasAttachment(structure: unknown): boolean {
  const stack: unknown[] = [structure];
  let visited = 0;
  while (stack.length > 0 && visited < MAX_STRUCTURE_NODES) {
    const node = record(stack.pop());
    visited++;
    if (node === null) continue;
    const disposition =
      typeof node['disposition'] === 'string' ? node['disposition'].toLowerCase() : null;
    if (disposition === 'attachment') return true;
    const type = typeof node['type'] === 'string' ? node['type'].toLowerCase() : '';
    // A forwarded mail is an attachment even without a name.
    if (type === 'message/rfc822') return true;
    // A named part counts, except an inline image (a logo in an HTML mail). Apple Mail sends
    // PDFs as `inline; filename=…`, so an inline non-image with a name counts too.
    if (
      !type.startsWith('multipart/') &&
      hasFilename(node) &&
      (disposition !== 'inline' || !type.startsWith('image/'))
    ) {
      return true;
    }
    const children = node['childNodes'];
    if (Array.isArray(children)) {
      for (let i = children.length - 1; i >= 0 && stack.length < MAX_STRUCTURE_NODES; i--) {
        stack.push(children[i]);
      }
    }
  }
  return false;
}

/** At most `max` code points; no other change. null for a non-string. */
export function capped(value: unknown, max: number = MAX_TEXT_CHARS): string | null {
  if (typeof value !== 'string') return null;
  if (value.length <= max) return value;
  let out = '';
  let n = 0;
  for (const ch of value) {
    if (n++ === max) break;
    out += ch;
  }
  return out;
}

/** INTERNALDATE as a Date (a Date or an ISO string), or null when missing or invalid. */
export function receivedDate(value: unknown): Date | null {
  const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  return date !== null && Number.isFinite(date.getTime()) ? new Date(date.getTime()) : null;
}

/** The first From entry: its name, else its address; capped. */
export function sender(envelope: unknown): string | null {
  const from = record(envelope)?.['from'];
  const first = Array.isArray(from) ? record(from[0]) : null;
  if (first === null) return null;
  if (nonEmpty(first['name'])) return capped(first['name']);
  return nonEmpty(first['address']) ? capped(first['address']) : null;
}

function toRow(msg: FetchedMessage): MessageRow | null {
  const seq = positive(msg.seq);
  const uid = positive(msg.uid);
  if (seq === null || uid === null) return null;
  return {
    seq,
    uid,
    received: receivedDate(msg.internalDate),
    from: sender(msg.envelope),
    subject: capped(record(msg.envelope)?.['subject']),
    bytes: count(msg.size),
    attachment: hasAttachment(msg.bodyStructure),
  };
}

function snapshotOf(session: MessageSession, path: string): FolderSnapshot {
  const mailbox = session.client.mailbox;
  if (mailbox === false) throw new MailboxError('folder-unavailable');
  const exists = count(mailbox.exists);
  const uidValidity = mailbox.uidValidity;
  if (exists === null || typeof uidValidity !== 'bigint' || uidValidity <= 0n) {
    // Without UIDVALIDITY a mark (folder + UID) could later point at another message.
    throw new MailboxError('folder-unavailable');
  }
  return { path, uidValidity: uidValidity.toString(), exists };
}

/**
 * Runs `fn` with the folder EXAMINEd and its snapshot read after a NOOP; the lock is released
 * afterwards. A closed connection → `connection-lost`; any other failure → `folder-unavailable`.
 */
async function withFolder<T>(
  session: MessageSession,
  path: string,
  fn: (snapshot: FolderSnapshot) => Promise<T>,
): Promise<T> {
  checkOpen(session);
  const { client } = session;
  let lock;
  try {
    lock = await client.getMailboxLock(path, { readOnly: true });
  } catch {
    checkOpen(session);
    throw new MailboxError('folder-unavailable');
  }
  try {
    await client.noop();
    return await fn(snapshotOf(session, path));
  } catch (err) {
    checkOpen(session);
    if (err instanceof MailboxError) throw err;
    throw new MailboxError('folder-unavailable');
  } finally {
    lock.release();
  }
}

/** EXAMINEs a folder (read-only) and returns its snapshot. */
export async function openFolder(session: MessageSession, path: string): Promise<FolderSnapshot> {
  return withFolder(session, path, (snapshot) => Promise.resolve(snapshot));
}

function sameSnapshot(a: FolderSnapshot, b: FolderSnapshot): boolean {
  return a.path === b.path && a.uidValidity === b.uidValidity && a.exists === b.exists;
}

/**
 * Page `page` (0 = newest) of a folder, newest arrived first. `expected` = the snapshot the
 * caller pages against: when the folder differs now, `changed` is returned without fetching
 * (the caller reloads). `expected === null` (a fresh open) snapshots and fetches under one lock.
 */
export async function loadPage(
  session: MessageSession,
  path: string,
  expected: FolderSnapshot | null,
  page: number,
): Promise<PageResult> {
  return withFolder(session, path, async (snapshot): Promise<PageResult> => {
    if (expected !== null && !sameSnapshot(expected, snapshot)) {
      return { kind: 'changed', snapshot };
    }
    const range = pageRange(snapshot.exists, page);
    if (range === null) return { kind: 'page', snapshot, page, rows: [] };
    // Keyed by sequence: a server that repeats a message or answers outside the range can't
    // grow the page past its size.
    const bySeq = new Map<number, MessageRow>();
    for await (const msg of session.client.fetch(`${range.from}:${range.to}`, PAGE_QUERY)) {
      const row = toRow(msg);
      if (row !== null && row.seq >= range.from && row.seq <= range.to && !bySeq.has(row.seq)) {
        bySeq.set(row.seq, row);
      }
    }
    const rows = [...bySeq.values()].sort((a, b) => b.seq - a.seq);
    return { kind: 'page', snapshot, page, rows };
  });
}
