import type { FolderTree } from '../core/mailbox/folders.js';
import { MAX_FOLDERS } from '../core/mailbox/folders.js';
import type { FolderMatches, MailboxSearch, SenderRow } from '../core/mailbox/search-mailbox.js';
import type { SearchOrder } from '../core/mailbox/search.js';
import type { CountBytes } from '../core/mailbox/stats.js';
import { formatBytes, safeName } from './folders-text.js';
import { sanitize } from './log-text.js';
import { NOT_A_LINE, UNREADABLE } from './saved-filter-text.js';
import { keyText, mailLines, plural, table } from './stats-text.js';

// Text and JSON for `mm search` (M3b). Folder paths, senders, subjects and the echoed filter come
// from the mail server or from what the user typed: untrusted, so every one goes through
// sanitize(). Sizes are RFC822.SIZE sums — approximate, not the quota; the first line says so
// once. The texts that stop a search before any login are here too: the command checks them.

const UNKNOWN = '—';
const NO_ADDRESS = '(no address)';

export const SEARCH_EMPTY_TEXT =
  'Type a filter, e.g. mm search "from:@shop.sk older:1y" — see `mm search --help`.';
export const SEARCH_LIMIT_TEXT = '--limit takes a whole number from 0 to 200.';
export const SEARCH_ORDER_TEXT = '--order takes newest, oldest or largest.';
export const SEARCH_BODY_TEXT =
  'The --body text can\'t be used — up to 200 characters, without quotes (") or control characters.';
export const BODY_WARNING =
  'Body search is done by the mail server — some servers are slow at it or search only part of a mail.';
export const SEARCH_USAGE = 'mm search "<filter>" --account <id>';

export function unknownOptionText(word: string, command = 'search'): string {
  return `Unknown option "${sanitize(word)}" — see \`mm ${command} --help\`.`;
}

function n(value: number): string {
  return value.toLocaleString('en-US');
}

export interface SearchTextOptions {
  /** The filter line as typed (joined words); '' when only `--body` was given. */
  filter: string;
  body: string | null;
  sent: boolean;
  order: SearchOrder;
  timeZone: string;
  /**
   * `--filter <name>`: the saved filter's name and line; `body`: whether the search uses a body
   * term anywhere (saved or typed).
   */
  saved?: { name: string; text: string; body: boolean } | null;
}

/** The saved filter's name and its line; a stand-in text already has its parentheses. */
function savedText(saved: NonNullable<SearchTextOptions['saved']>): string {
  if (saved.text === '') return saved.name;
  if (saved.text === NOT_A_LINE || saved.text === UNREADABLE) return `${saved.name} ${saved.text}`;
  return `${saved.name} (${saved.text})`;
}

/** `Filter:` with the saved filter, the line and the body text, and the sent-date suffix for `--sent`. */
function filterLine(o: SearchTextOptions): string {
  const saved = o.saved ? [savedText(o.saved)] : [];
  const parts = [
    ...saved,
    ...(o.filter === '' ? [] : [sanitize(o.filter)]),
    ...(o.body === null ? [] : [`body:"${sanitize(o.body)}"`]),
  ];
  const suffix = o.sent ? ' — dates are sent dates (the Date: header)' : '';
  return `Filter: ${parts.join(' ')}${suffix}`;
}

/** The first block: the filter, the total, and the notes that apply (no blank lines inside). */
function summaryLines(r: MailboxSearch, tree: FolderTree, o: SearchTextOptions): string[] {
  const lines = [filterLine(o)];
  if (r.totals.messages === 0) {
    lines.push('No mails match.');
  } else {
    const withMatches = r.folders.filter((f) => f.matches.length > 0).length;
    lines.push(
      `Found ${plural(r.totals.messages, 'mail', 'mails')}, ${formatBytes(r.totals.bytes)} ` +
        `in ${plural(withMatches, 'folder', 'folders')} — sizes are approx. (message sizes)`,
    );
  }
  if (r.failed > 0) {
    lines.push(
      `${plural(r.failed, 'folder', 'folders')} couldn't be searched — the result may be incomplete.`,
    );
  }
  if (r.missing > 0) {
    lines.push(
      `${plural(r.missing, 'mail', 'mails')} couldn't be read — the result may be incomplete (run it again).`,
    );
  }
  if (r.notSearched > 0) {
    lines.push(
      `Not searched: ${plural(r.notSearched, 'folder', 'folders')} (Gmail labels or virtual folders; their mail is in the folders above)`,
    );
  }
  if (tree.truncated) lines.push(`First ${n(MAX_FOLDERS)} folders only.`);
  if (o.body !== null || o.saved?.body === true) lines.push(BODY_WARNING);
  if (o.sent && r.samples.length > 0) lines.push('Dates in the list are received dates.');
  return lines;
}

/** Folders with matches and the folders that couldn't be searched, in scope order. */
function folderSection(folders: readonly FolderMatches[]): string[] {
  const shown = folders.filter((f) => f.reason !== null || f.matches.length > 0);
  if (shown.length === 0) return [];
  const rows = shown.map((f) =>
    f.reason === null
      ? [safeName(f.path), n(f.matches.length), formatBytes(f.bytes)]
      : [safeName(f.path), UNKNOWN, UNKNOWN],
  );
  const suffix = shown.map((f) => (f.reason === null ? '' : " (couldn't be searched)"));
  return table([['FOLDER', 'MAILS', 'SIZE'], ...rows], ['', ...suffix]);
}

function senderSection(r: MailboxSearch): string[] {
  const approximate = r.sendersOthers.messages > 0;
  const rows = r.senders.map((s) => [
    keyText(s.key, NO_ADDRESS),
    n(s.messages),
    formatBytes(s.bytes),
  ]);
  if (approximate) {
    rows.push(['others', n(r.sendersOthers.messages), formatBytes(r.sendersOthers.bytes)]);
  }
  return [approximate ? 'TOP SENDERS (approximate)' : 'TOP SENDERS', ...table(rows)];
}

function goneLine(gone: number): string {
  return `${plural(gone, 'mail', 'mails')} of this list couldn't be shown — gone from the server or not readable now.`;
}

/** The sample list; when every shown mail is gone, only the note (no heading, no mail lines). */
function sampleSection(r: MailboxSearch, o: SearchTextOptions): string[] {
  if (r.samples.length === 0) return r.samplesGone > 0 ? [goneLine(r.samplesGone)] : [];
  const heading = `${o.order.toUpperCase()} ${n(r.samples.length)} OF ${n(r.totals.messages)}`;
  const lines = [heading, ...mailLines(r.samples, o.timeZone)];
  if (r.samplesGone > 0) lines.push(goneLine(r.samplesGone));
  return lines;
}

/** The text report: the summary block, then sections separated by a blank line. */
export function searchLines(r: MailboxSearch, tree: FolderTree, o: SearchTextOptions): string[] {
  const sections: string[][] = [];
  const folders = folderSection(r.folders);
  if (folders.length > 0) sections.push(folders);
  if (r.totals.messages > 0) sections.push(senderSection(r));
  const samples = sampleSection(r, o);
  if (samples.length > 0) sections.push(samples);
  return [...summaryLines(r, tree, o), ...sections.flatMap((s) => ['', ...s])];
}

export interface SearchJson {
  v: 1;
  account: string;
  filter: string;
  /** The saved filter's name with `--filter`; null without it. */
  saved: string | null;
  body: string | null;
  dates: 'received' | 'sent';
  /** null without `--folder`. */
  scope: { folder: string | null; gmail: boolean };
  totals: CountBytes;
  /** Every scoped folder, scope order; a failed one has null counts. */
  folders: {
    path: string;
    messages: number | null;
    bytes: number | null;
    missing: number;
    failed: boolean;
  }[];
  notSearched: number;
  failed: number;
  missing: number;
  truncated: boolean;
  senders: { rows: SenderRow[]; others: CountBytes };
  samples: {
    order: SearchOrder;
    rows: {
      folder: string;
      uid: number;
      received: string | null;
      from: string | null;
      subject: string | null;
      bytes: number | null;
      attachment: boolean;
    }[];
    gone: number;
  };
}

/**
 * The `--json` object (versioned). Every string is sanitised but not cut (as `mm stats --json`, so
 * a path can be passed to `--folder`).
 */
export function searchJson(
  r: MailboxSearch,
  tree: FolderTree,
  account: string,
  o: {
    filter: string;
    body: string | null;
    sent: boolean;
    order: SearchOrder;
    folder: string | null;
    gmail: boolean;
    saved?: string | null;
  },
): SearchJson {
  return {
    v: 1,
    account: sanitize(account),
    filter: sanitize(o.filter),
    saved: o.saved ?? null,
    body: o.body === null ? null : sanitize(o.body),
    dates: o.sent ? 'sent' : 'received',
    scope: { folder: o.folder === null ? null : sanitize(o.folder), gmail: o.gmail },
    totals: { ...r.totals },
    folders: r.folders.map((f) => ({
      path: sanitize(f.path),
      messages: f.reason === null ? f.matches.length : null,
      bytes: f.reason === null ? f.bytes : null,
      missing: f.missing,
      failed: f.reason !== null,
    })),
    notSearched: r.notSearched,
    failed: r.failed,
    missing: r.missing,
    truncated: tree.truncated,
    senders: {
      rows: r.senders.map((s) => ({ ...s, key: s.key === null ? null : sanitize(s.key) })),
      others: { ...r.sendersOthers },
    },
    samples: {
      order: o.order,
      rows: r.samples.map((s) => ({
        folder: sanitize(s.folder),
        uid: s.uid,
        received: s.received === null ? null : s.received.toISOString(),
        from: s.from === null ? null : sanitize(s.from),
        subject: s.subject === null ? null : sanitize(s.subject),
        bytes: s.bytes,
        attachment: s.attachment,
      })),
      gone: r.samplesGone,
    },
  };
}
