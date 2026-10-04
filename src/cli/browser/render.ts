import { basketTotals, isMarked } from '../../core/mailbox/basket.js';
import type { FolderInfo } from '../../core/mailbox/folders.js';
import { formatBytes, sizeText } from '../folders-text.js';
import { sanitize } from '../log-text.js';
import {
  MIN_COLS,
  MIN_ROWS,
  bodyHeight,
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
// Mail data is only displayed.

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
const HELP: readonly { text: string; rank: number }[] = [
  { text: 'Up/Down move', rank: 0 },
  { text: 'PgUp/PgDn page', rank: 7 },
  { text: 'Enter open', rank: 3 },
  { text: 'Left back', rank: 4 },
  { text: 'Space mark', rank: 2 },
  { text: 'a mark screen', rank: 5 },
  { text: 'q quit', rank: 1 },
  { text: '+ = attachment', rank: 6 },
];
const HELP_GAP = '  ';

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
    case 'text':
      return sanitize(message.text);
  }
}

/** `left` and a right-aligned `right` in exactly `cols` columns (`right` dropped if no room). */
function columns(left: string, right: string, cols: number): string {
  const rightWidth = displayWidth(right);
  if (right === '' || rightWidth + 2 > cols) return fit(left, cols);
  return `${fit(left, cols - rightWidth - 1)} ${right}`;
}

function folderName(folder: FolderInfo): string {
  return sanitize(folder.name);
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
    open === undefined
      ? plural(state.folders.length, 'folder', 'folders')
      : total === null
        ? ''
        : plural(total, 'mail', 'mails');
  return columns(segments.join(' / '), right, cols);
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
  // Offline, an opened folder whose mails never loaded says so (after its subfolders, if any).
  const notLoaded = state.offline && view !== null && view.selectable && view.snapshot === null;
  if (total === 0) {
    const empty =
      view === null
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
  }
  // The question or message comes first: "marked: ..." only when both fit whole.
  if (left === '') return columns('', right, cols);
  return displayWidth(left) + 1 + displayWidth(right) <= cols
    ? columns(left, right, cols)
    : fit(left, cols);
}

/** As many help items as fit, most important first, shown in their usual order. */
function helpLine(cols: number): string {
  const byRank = [...HELP].sort((a, b) => a.rank - b.rank);
  const kept = new Set<string>();
  let width = 0;
  for (const item of byRank) {
    const w = displayWidth(item.text) + (kept.size === 0 ? 0 : HELP_GAP.length);
    if (width + w > cols) continue;
    kept.add(item.text);
    width += w;
  }
  const text = HELP.filter((item) => kept.has(item.text))
    .map((item) => item.text)
    .join(HELP_GAP);
  return fit(text, cols);
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
    case 'browse':
      return null;
  }
}

function centred(text: string, cols: number): string {
  const indent = Math.max(0, Math.floor((cols - displayWidth(text)) / 2));
  return fit(' '.repeat(indent) + text, cols);
}

function tooSmall(state: BrowserState, rows: number, cols: number): Rendered {
  const lines: string[] = [];
  const middle = Math.floor((rows - 1) / 2);
  const long = `Window too small - need at least ${String(MIN_COLS)}x${String(MIN_ROWS)}`;
  // Stays whole down to 21 columns; the long text needs 37.
  const text =
    cols < displayWidth(long) ? `Too small - need ${String(MIN_COLS)}x${String(MIN_ROWS)}` : long;
  // A pending question goes on the next line, or replaces the text when there is no next line.
  const question = pendingQuestion(state);
  const questionLine = question === null ? -1 : middle + 1 < rows ? middle + 1 : middle;
  for (let i = 0; i < rows; i++) {
    if (i === questionLine && question !== null) lines.push(centred(question, cols));
    else if (i === middle) lines.push(centred(text, cols));
    else lines.push(fit('', cols));
  }
  return { lines, cursorLine: null };
}

export function render(state: BrowserState, opts: RenderOptions = {}): Rendered {
  const { rows, cols } = screenOf(state.screen);
  if (rows < MIN_ROWS || cols < MIN_COLS) return tooSmall(state, rows, cols);
  const formatDate = opts.formatDate ?? localDate;
  const height = bodyHeight(state.screen);
  const lines = [
    headerLine(state, cols),
    ...bodyLines(state, height, cols, formatDate, opts.sizes ?? true),
    statusLine(state, cols),
    helpLine(cols),
  ];
  const offset = state.cursor - state.scrollTop;
  const cursorLine = rowCount(state) > 0 && offset >= 0 && offset < height ? 1 + offset : null;
  return { lines, cursorLine };
}
