import type { BasketTotals } from '../core/mailbox/basket.js';
import type {
  FolderRole,
  FolderTotals,
  FolderTree,
  QuotaBytes,
  RoleSource,
  SizeSource,
} from '../core/mailbox/folders.js';
import { MAX_FOLDERS } from '../core/mailbox/folders.js';
import { sanitize } from './log-text.js';

// Text and JSON for `mm folders` (M2a), and the line after its browser closes (M2b-2). Folder
// names come from the mail server and are untrusted: every one goes through sanitize() and is cut
// to MAX_NAME_CHARS, in the text and in the JSON. A size the server reports (STATUS=SIZE) is
// exact — checked byte for byte against the test ground; a size we add up from RFC822.SIZE
// carries a "~" (messages can change meanwhile).

const MAX_NAME_CHARS = 200;
const UNKNOWN = '—';

const ROLE_TAG: Record<FolderRole, string> = {
  inbox: '[Inbox]',
  all: '[All Mail]',
  archive: '[Archive]',
  drafts: '[Drafts]',
  flagged: '[Flagged]',
  junk: '[Junk]',
  sent: '[Sent]',
  trash: '[Trash]',
};

const UNITS = ['KB', 'MB', 'GB', 'TB'];

/** 1024-based: `0 B`, `512 B`, `1.5 KB`, `12.3 MB`, `1.0 GB`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) {
    return `${Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes) : 0} B`;
  }
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${UNITS[unit] ?? 'TB'}`;
}

/** `1.5 MB` from the server, `~1.5 MB` when added up by us, `—` when unknown. */
export function sizeText(bytes: number | null, source: SizeSource | null = 'sum'): string {
  if (bytes === null) return UNKNOWN;
  return source === 'server' ? formatBytes(bytes) : `~${formatBytes(bytes)}`;
}

function plural(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

/** The line printed after the browser closes. */
export function browseSummary(totals: BasketTotals): string {
  if (totals.count === 0) return 'Folder browser closed — nothing was changed on the server.';
  return `Folder browser closed — ${plural(totals.count, 'mark', 'marks')} (${formatBytes(totals.bytes)}) dropped, nothing was changed on the server.`;
}

function countText(n: number | null): string {
  return n === null ? UNKNOWN : String(n);
}

/** A server string made safe for the terminal and capped. */
export function safeName(text: string): string {
  return [...sanitize(text)].slice(0, MAX_NAME_CHARS).join('');
}

/** Aligned header + one row per folder (name + tags, messages, unread, size). */
function folderTable(tree: FolderTree, o: { sizes: boolean }): { header: string; rows: string[] } {
  const labels = tree.folders.map((f) => {
    const tags = [
      f.role === null ? '' : ROLE_TAG[f.role],
      f.subscribed ? '' : '(hidden)',
      f.overlapping ? '(overlapping)' : '',
      f.selectable ? '' : '(not selectable)',
    ].filter((t) => t !== '');
    return [`${'  '.repeat(f.depth)}${safeName(f.name)}`, ...tags].join(' ');
  });
  const rows = tree.folders.map((f, i) => [
    labels[i] ?? '',
    countText(f.messages),
    countText(f.unseen),
    ...(o.sizes ? [sizeText(f.bytes, f.sizeSource)] : []),
  ]);
  const header = ['FOLDER', 'MESSAGES', 'UNREAD', ...(o.sizes ? ['SIZE'] : [])];
  const widths = header.map((h, i) =>
    Math.max([...h].length, ...rows.map((r) => [...(r[i] ?? '')].length)),
  );
  const pad = (text: string, width: number, left: boolean): string => {
    const gap = ' '.repeat(Math.max(0, width - [...text].length));
    return left ? text + gap : gap + text;
  };
  const format = (cells: string[]): string =>
    cells
      .map((c, i) => pad(c, widths[i] ?? 0, i === 0))
      .join('  ')
      .trimEnd();
  return { header: format(header), rows: rows.map(format) };
}

/** One line per folder, in tree order, aligned with `folderHeader`. */
export function folderLines(tree: FolderTree, o: { sizes: boolean }): string[] {
  return folderTable(tree, o).rows;
}

/** The column header for `folderLines`. */
export function folderHeader(tree: FolderTree, o: { sizes: boolean }): string {
  return folderTable(tree, o).header;
}

/** `Total: 1234 messages, 56 unread, ~1.2 GB` (+ the Gmail rule), or why it is unknown. */
export function totalsLine(tree: FolderTree, o: { sizes: boolean }): string {
  if (tree.gmailAllHidden) {
    return 'Totals unknown: All Mail is hidden from IMAP — enable it in Gmail settings (Labels → Show in IMAP).';
  }
  const t = tree.totals;
  if (t === null) return 'Totals unknown.';
  const parts = [
    `${countText(t.messages)} messages`,
    `${countText(t.unseen)} unread`,
    ...(o.sizes ? [sizeText(t.bytes, t.sizeSource)] : []),
  ];
  const gmail = tree.folders.some((f) => f.overlapping)
    ? ' (All Mail + Trash + Spam; labels overlap and are not added)'
    : '';
  const unknown = t.messages === null || t.unseen === null ? ' (some folders unknown)' : '';
  return `Total: ${parts.join(', ')}${gmail}${unknown}${firstOnly(tree)}`;
}

/** ` (first 5,000 folders only)` when the list was cut: the sums leave the rest out. */
function firstOnly(tree: FolderTree): string {
  return tree.truncated ? ` (first ${MAX_FOLDERS.toLocaleString('en-US')} folders only)` : '';
}

/**
 * The quota from the server. Not available — the server doesn't support QUOTA, or sets no
 * limit for the mailbox (e.g. Websupport: the limit is on the hosting plan as a whole, mail +
 * web + databases) — is one text: the Total line already shows what the mailbox uses.
 */
export function quotaLine(tree: FolderTree): string {
  const q = tree.quota;
  if (q === null) return 'Quota: not available from the mail server';
  const used = formatBytes(q.usedBytes);
  return q.limitBytes === null || q.limitBytes === 0
    ? `Quota: ${used} used`
    : `Quota: ${used} of ${formatBytes(q.limitBytes)} used (${Math.round((q.usedBytes / q.limitBytes) * 100)}%)`;
}

/** Notes after the totals: folders cut by the cap, folders that couldn't be read. */
export function footerLines(tree: FolderTree): string[] {
  const lines: string[] = [];
  if (tree.truncated) {
    lines.push(`Showing the first ${MAX_FOLDERS.toLocaleString('en-US')} folders.`);
  }
  if (tree.folders.some((f) => f.sizeSource === 'sum' && f.bytes !== null)) {
    lines.push('~ = added up from the message sizes (the server reports no folder size).');
  }
  if (tree.unreadable > 0) {
    lines.push(
      `${tree.unreadable} ${tree.unreadable === 1 ? 'folder' : 'folders'} could not be read (shown as ${UNKNOWN}).`,
    );
  }
  return lines;
}

export interface FolderJson {
  path: string;
  name: string;
  parent: string | null;
  depth: number;
  role: FolderRole | null;
  roleSource: RoleSource | null;
  selectable: boolean;
  subscribed: boolean;
  messages: number | null;
  unseen: number | null;
  bytes: number | null;
  sizeSource: SizeSource | null;
  overlapping: boolean;
}

export interface FoldersJson {
  v: 1;
  account: string;
  folders: FolderJson[];
  totals: FolderTotals | null;
  quota: QuotaBytes | null;
  truncated: boolean;
  unreadable: number;
}

/** The `--json` object (versioned). Names and paths are sanitised like the text. */
export function foldersJson(tree: FolderTree, accountId: string): FoldersJson {
  return {
    v: 1,
    account: sanitize(accountId),
    folders: tree.folders.map((f) => ({
      // Paths are not cut: `parent` must keep matching a `path` so the tree can be rebuilt.
      path: sanitize(f.path),
      name: safeName(f.name),
      parent: f.parentPath === null ? null : sanitize(f.parentPath),
      depth: f.depth,
      role: f.role,
      roleSource: f.roleSource,
      selectable: f.selectable,
      subscribed: f.subscribed,
      messages: f.messages,
      unseen: f.unseen,
      bytes: f.bytes,
      sizeSource: f.sizeSource,
      overlapping: f.overlapping,
    })),
    totals: tree.totals === null ? null : { ...tree.totals },
    quota: tree.quota === null ? null : { ...tree.quota },
    truncated: tree.truncated,
    unreadable: tree.unreadable,
  };
}
