import { basketTotals, isMarked } from '../../core/mailbox/basket.js';
import type { FolderInfo } from '../../core/mailbox/folders.js';
import { formatBytes, sizeText } from '../folders-text.js';
import { lineErrorText, orderText } from '../filter-text.js';
import { sanitize } from '../log-text.js';
import { columns, fitTail, helpLine, tooSmallFrame, type HelpItem } from './layout.js';
import {
  MIN_COLS,
  MIN_ROWS,
  listHeight,
  rowAt,
  rowCount,
  screenOf,
  type BrowserState,
  type Row,
  type StatusMessage,
} from './state.js';
import { displayWidth, fit } from './width.js';

// The browser screen (M2b) as plain-text lines: header, body rows, status line, key help. Pure:
// no escape codes (the terminal shell highlights `cursorLine`). Every server string - mailbox
// label, folder names, sender, subject - goes through sanitize() and is fitted to the width.
// Mail data is only displayed. Inside the app (M3a) a filter row shows the filter line being
// typed, or the filter and order of a listing; the typed text is sanitised too.

export { MIN_COLS, MIN_ROWS };

export interface RenderOptions {
  /** Received date of a mail; default local `YYYY-MM-DD`. */
  formatDate?: (d: Date) => string;
  /** false: folder rows have no size cell (`--no-size`). Default true. */
  sizes?: boolean;
}

export interface Rendered {
  /** Exactly `screen.rows` lines, each at most `screen.cols` columns wide. */
  lines: string[];
  /** Line of the cursor row (for the highlight), or null. */
  cursorLine: number | null;
}

const UNKNOWN = '-';
const NOT_LOADED = 'not loaded (offline)';
const DATE_WIDTH = 10;
const SIZE_WIDTH = 9;
/** The sender column never gets narrower than this; the subject shrinks instead. */
const FROM_MIN = 8;
/** Key help in display order; `rank` = which go first when the line is too narrow (0 = keep). */
const HELP: readonly HelpItem[] = [
  { text: 'Up/Down move', rank: 0 },
  { text: 'PgUp/PgDn page', rank: 7 },
  { text: 'Enter open', rank: 3 },
  { text: 'Left back', rank: 4 },
  { text: 'Space mark', rank: 2 },
  { text: 'a mark screen', rank: 5 },
  { text: 'q quit', rank: 1 },
  { text: '+ = attachment', rank: 6 },
];
/**
 * Inside the app (`state.embedded`): Esc goes back like Left, it doesn't quit; the filter, the
 * order and the mark-all keys are the app's (M3a).
 */
const HELP_EMBEDDED: readonly HelpItem[] = [
  { text: 'Up/Down move', rank: 0 },
  { text: 'PgUp/PgDn page', rank: 10 },
  { text: 'Enter open', rank: 5 },
  { text: 'Esc/Left back', rank: 4 },
  { text: '/ filter', rank: 2 },
  { text: 'o order', rank: 6 },
  { text: 'Space mark', rank: 3 },
  { text: 'a mark screen', rank: 8 },
  { text: 'm mark all', rank: 7 },
  { text: 'q quit', rank: 1 },
  { text: '+ = attachment', rank: 9 },
];
/** The filter line while it is typed (M3a): what the keys do there. */
const HELP_EDIT: readonly HelpItem[] = [
  { text: 'Enter apply', rank: 0 },
  { text: 'Esc cancel', rank: 1 },
  { text: 'e.g. shop.sk', rank: 2 },
  { text: 'from:x', rank: 3 },
  { text: 'older:1y', rank: 4 },
  { text: 'larger:5mb', rank: 5 },
  { text: 'unread', rank: 6 },
  { text: 'att', rank: 7 },
];

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function localDate(d: Date): string {
  return `${String(d.getFullYear())}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function plural(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

/** Plain words for a status message. */
export function statusText(message: StatusMessage): string {
  switch (message.code) {
    case 'only-mails':
      return 'Only mails can be marked - open the folder to mark its mails.';
    case 'folder-changed':
      return 'Folder changed on the server - reloaded.';
    case 'folder-busy':
      return 'This folder keeps changing on the server - reopen it to try again.';
    case 'marks-cleared':
      return `The folder was reset on the server - ${plural(message.count, 'mark', 'marks')} in it dropped.`;
    case 'folder-unavailable':
      return "Couldn't open this folder - it may have been deleted or renamed.";
    case 'page-failed':
      return "Couldn't load some mails - reopen the folder to retry.";
    case 'offline':
      return 'Offline - showing what is loaded (r = reconnect).';
    case 'search-failed':
      return "The mail server couldn't run this filter - try a simpler one.";
    case 'too-many-matches':
      return 'More than 500,000 mails to go through - narrow the filter.';
    case 'mark-all-needs-list':
      return 'm marks every mail of a filtered list - press / and type a filter first.';
    case 'too-many-to-mark':
      return `Too many mails to mark at once (${String(message.count)}) - narrow the filter.`;
    case 'marked-all':
      return `Marked ${plural(message.count, 'mail', 'mails')}.`;
    case 'unmarked-all':
      return `Unmarked ${plural(message.count, 'mail', 'mails')}.`;
    case 'search-partial':
      return `${plural(message.count, 'mail', 'mails')} couldn't be read - the list may be incomplete (/ and Enter tries again).`;
    case 'text':
      return sanitize(message.text);
  }
}

function folderName(folder: FolderInfo): string {
  return sanitize(folder.name);
}

/** A listing with its matches: "37 of 4521 mails, 49.2 MB" (the folder's count when searched). */
function matchCount(state: BrowserState): string | null {
  const listing = state.view?.listing;
  const snapshot = state.view?.snapshot ?? null;
  if (listing === undefined || listing.matches === null || snapshot === null) return null;
  const shown = `${String(listing.matches.length)} of ${plural(snapshot.exists, 'mail', 'mails')}`;
  return `${shown}, ${formatBytes(listing.bytes)}`;
}

function headerLine(state: BrowserState, cols: number): string {
  const segments = [sanitize(state.title)];
  const chain: FolderInfo[] = [];
  let path = state.path;
  // Bounded by the tree size: a parent loop in server data can't spin forever.
  while (path !== null && chain.length < state.folders.length) {
    const folder = state.folders.find((f) => f.path === path);
    if (folder === undefined) break;
    chain.unshift(folder);
    path = folder.parentPath;
  }
  for (const f of chain) segments.push(folderName(f));
  const open = chain[chain.length - 1];
  const total = state.view?.snapshot?.exists ?? (open === undefined ? null : open.messages);
  const right =
    matchCount(state) ??
    (open === undefined
      ? plural(state.folders.length, 'folder', 'folders')
      : total === null
        ? ''
        : plural(total, 'mail', 'mails'));
  return columns(segments.join(' / '), right, cols);
}

/** The filter row (M3a): the line while it is typed, else the filter and the order of the list. */
function filterLine(state: BrowserState, cols: number): string | null {
  if (state.mode === 'filter-edit') {
    return fitTail(`Filter: ${sanitize(state.edit?.line ?? '')}_`, cols);
  }
  const listing = state.view?.listing;
  if (listing === undefined) return null;
  const text = listing.text === '' ? '(none)' : sanitize(listing.text);
  return columns(`Filter: ${text}`, orderText(listing.order), cols);
}

function folderLine(folder: FolderInfo, cols: number, sizes: boolean): string {
  const messages = (folder.messages === null ? UNKNOWN : String(folder.messages)).padStart(9);
  const right = sizes
    ? `${messages} ${(folder.bytes === null ? UNKNOWN : sizeText(folder.bytes, folder.sizeSource)).padStart(SIZE_WIDTH + 1)}`
    : messages;
  return columns(`    ${folderName(folder)}/`, `${right}  `, cols);
}

function mailLine(
  state: BrowserState,
  row: Extract<Row, { kind: 'mail' }>,
  cols: number,
  formatDate: (d: Date) => string,
): string {
  const mail = row.mail;
  const snapshot = state.view?.snapshot;
  if (mail === null || snapshot === null || snapshot === undefined) {
    const text =
      row.status === 'failed'
        ? "couldn't load"
        : row.status === 'unreadable'
          ? '(not readable)'
          : state.offline && row.status === 'pending'
            ? NOT_LOADED
            : 'loading...';
    return fit(`    ${text}`, cols);
  }
  const marked = isMarked(state.basket, {
    path: snapshot.path,
    uidValidity: snapshot.uidValidity,
    uid: mail.uid,
  });
  const date = mail.received === null ? UNKNOWN : sanitize(formatDate(mail.received));
  const size = mail.bytes === null ? UNKNOWN : formatBytes(mail.bytes);
  const fixed = `${marked ? '[x]' : '[ ]'} ${fit(date, DATE_WIDTH)}  `;
  const tail = ` ${size.padStart(SIZE_WIDTH)} ${mail.attachment ? '+' : ' '}`;
  const avail = Math.max(0, cols - displayWidth(fixed) - displayWidth(tail) - 1);
  const fromWidth = Math.min(
    avail,
    Math.max(FROM_MIN, Math.min(Math.floor(cols / 4), Math.floor(avail * 0.4))),
  );
  const from = fit(sanitize(mail.from ?? UNKNOWN), fromWidth);
  const subject = fit(sanitize(mail.subject ?? ''), avail - fromWidth);
  return fit(`${fixed}${from} ${subject}${tail}`, cols);
}

function bodyLines(
  state: BrowserState,
  height: number,
  cols: number,
  formatDate: (d: Date) => string,
  sizes: boolean,
): string[] {
  const lines: string[] = [];
  const total = rowCount(state);
  const view = state.view;
  const listing = view?.listing;
  // Offline, an opened folder whose mails never loaded says so (after its subfolders, if any).
  const notLoaded = state.offline && view !== null && view.selectable && view.snapshot === null;
  if (listing !== undefined && listing.matches === null) {
    const progress =
      listing.progress === null
        ? ''
        : ` ${String(listing.progress.done)}/${String(listing.progress.total)}`;
    lines.push(fit(`    Filtering...${progress}`, cols));
  } else if (total === 0) {
    const empty =
      listing !== undefined
        ? 'No mails match.'
        : view === null
          ? 'No folders'
          : notLoaded
            ? NOT_LOADED
            : view.selectable && view.snapshot === null
              ? ''
              : 'This folder is empty';
    if (empty !== '') lines.push(fit(`    ${empty}`, cols));
  }
  for (let i = state.scrollTop; i < state.scrollTop + height && i < total; i++) {
    const row = rowAt(state, i);
    if (row === null) break;
    lines.push(
      row.kind === 'folder'
        ? folderLine(row.folder, cols, sizes)
        : mailLine(state, row, cols, formatDate),
    );
  }
  // Only when scrolled to the end: the line below the last subfolder is free.
  if (total > 0 && notLoaded && lines.length < height) lines.push(fit(`    ${NOT_LOADED}`, cols));
  while (lines.length < height) lines.push(fit('', cols));
  return lines;
}

function statusLine(state: BrowserState, cols: number): string {
  const totals = basketTotals(state.basket);
  const right = `marked: ${plural(totals.count, 'mail', 'mails')}, ${formatBytes(totals.bytes)}`;
  let left: string;
  switch (state.mode) {
    case 'confirm-quit':
      left = `Quit and drop ${plural(totals.count, 'mark', 'marks')}? (y/N)`;
      break;
    case 'reconnect-ask':
      left = 'Connection closed - reconnect? (y/N)';
      break;
    case 'reconnecting':
      // The login guard's challenge wait arrives as a notice.
      left = state.message?.code === 'text' ? statusText(state.message) : 'Reconnecting...';
      break;
    case 'browse':
      left =
        state.message !== null
          ? statusText(state.message)
          : (state.view?.loading ?? null) !== null
            ? 'Loading...'
            : state.offline
              ? statusText({ code: 'offline' })
              : '';
      break;
    case 'filter-edit': {
      // The line's own error first; a result that arrives while the line is open is still said.
      const error = state.edit?.error ?? null;
      left =
        error !== null
          ? lineErrorText(error)
          : state.message !== null
            ? statusText(state.message)
            : '';
      break;
    }
  }
  // The question or message comes first: "marked: ..." only when both fit whole.
  if (left === '') return columns('', right, cols);
  return displayWidth(left) + 1 + displayWidth(right) <= cols
    ? columns(left, right, cols)
    : fit(left, cols);
}

/** The question the keys answer while only "too small" is shown (q, y and r still act). */
function pendingQuestion(state: BrowserState): string | null {
  switch (state.mode) {
    case 'confirm-quit':
      return `Drop ${plural(state.basket.marks.size, 'mark', 'marks')}? (y/N)`;
    case 'reconnect-ask':
      return 'Reconnect? (y/N)';
    case 'reconnecting':
      return 'Reconnecting...';
    case 'filter-edit':
      return 'Filter - Esc cancels';
    case 'browse':
      return null;
  }
}

function helpItems(state: BrowserState): readonly HelpItem[] {
  if (state.mode === 'filter-edit') return HELP_EDIT;
  return state.embedded === undefined ? HELP : HELP_EMBEDDED;
}

export function render(state: BrowserState, opts: RenderOptions = {}): Rendered {
  const { rows, cols } = screenOf(state.screen);
  if (rows < MIN_ROWS || cols < MIN_COLS) return tooSmallFrame(rows, cols, pendingQuestion(state));
  const formatDate = opts.formatDate ?? localDate;
  const height = listHeight(state);
  const row = filterLine(state, cols);
  const lines = [
    headerLine(state, cols),
    ...(row === null ? [] : [row]),
    ...bodyLines(state, height, cols, formatDate, opts.sizes ?? true),
    statusLine(state, cols),
    helpLine(helpItems(state), cols),
  ];
  const offset = state.cursor - state.scrollTop;
  // The cursor's row sits below the filter row; while the line is typed nothing is highlighted.
  const cursorLine =
    rowCount(state) > 0 && state.mode !== 'filter-edit' && offset >= 0 && offset < height
      ? 1 + (row === null ? 0 : 1) + offset
      : null;
  return { lines, cursorLine };
}
