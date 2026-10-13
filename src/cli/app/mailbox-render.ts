import type { FolderInfo, FolderTree } from '../../core/mailbox/folders.js';
import { columns, wrap, type HelpItem } from '../browser/layout.js';
import { fit } from '../browser/width.js';
import { formatBytes, safeName, sizeText } from '../folders-text.js';
import { sanitize } from '../log-text.js';
import {
  MAILBOX_FIXED_LINES,
  asciiText,
  orderedFolders,
  windowTop,
  type FolderOrder,
  type MailboxView,
} from './state.js';
import { statsBody, statsHeaderRight, statsHelp } from './stats-render.js';

// `wrap` lives with the shared layout now; this module still exports it.
export { wrap };

// The mailbox screen (M2d-2) as plain-text pieces for render.ts: header, body, what the status
// line says, key help. The body is the totals line, the quota line and one row per folder with
// an ASCII usage bar - the folder's share of the summed mailbox size. Pure, and plain ASCII but
// for the names: folder names and the mailbox address come from outside, go through sanitize()
// and are fitted to the width. A failed login or read shows its text in the body, wrapped.
// (Inside a folder the M2b browser draws the whole frame - render.ts; the stats screen's pieces
// are in stats-render.ts.)

export interface MailboxBody {
  /** Exactly the body height. */
  lines: string[];
  cursorLine: number | null;
}

/** Which right cells the folder rows of one frame have; the size is always there. */
interface CellSet {
  /** Cells of the bar; 0 = no bar. */
  bar: number;
  percent: boolean;
  messages: boolean;
}

interface Cells extends CellSet {
  sizeWidth: number;
  messagesWidth: number;
  /** Columns of the whole right cell. */
  width: number;
}

const INDENT = '    ';
const UNKNOWN = '-';
const BAR_CELLS = 10;
const PERCENT_WIDTH = 4;
/** A folder name keeps this many columns before the right cells give way. */
const NAME_MIN = 12;
const NO_FOLDERS = 'No folders';
const NO_QUOTA = 'Quota: not available from the mail server';
const GMAIL_ALL_HIDDEN = 'Totals unknown - Gmail hides All Mail from IMAP (Labels > Show in IMAP).';

const SIZE_ONLY: CellSet = { bar: 0, percent: false, messages: false };
/** In order of preference: the first one that leaves the name its room is used. */
const CELL_SETS: readonly CellSet[] = [
  { bar: BAR_CELLS, percent: true, messages: true },
  { bar: 6, percent: true, messages: true },
  { bar: 0, percent: true, messages: true },
  { bar: 0, percent: false, messages: true },
  SIZE_ONLY,
];

const ORDER_TEXT: Record<FolderOrder, string> = {
  tree: 'tree order',
  size: 'by size',
  name: 'by name',
};

const HELP_OPENING: readonly HelpItem[] = [
  { text: 'Esc back', rank: 0 },
  { text: 'q quit', rank: 1 },
];
const HELP_BARS: readonly HelpItem[] = [
  { text: 'Up/Down move', rank: 0 },
  { text: 'Enter open', rank: 2 },
  { text: 'o sort', rank: 4 },
  { text: 's stats', rank: 5 },
  { text: 'Esc back', rank: 3 },
  { text: 'q quit', rank: 1 },
];
const HELP_FAILED: readonly HelpItem[] = [
  { text: 'r try again', rank: 0 },
  { text: 'Esc back', rank: 2 },
  { text: 'q quit', rank: 1 },
];
const HELP_QUESTION: readonly HelpItem[] = [
  { text: 'y yes', rank: 0 },
  { text: 'any other key no', rank: 1 },
];

function plural(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

function padded(lines: string[], height: number, cols: number): string[] {
  const out = lines.slice(0, height);
  while (out.length < height) out.push(fit('', cols));
  return out;
}

/** `[###.......]`: at least one cell for any share above nothing. */
export function bar(share: number, cells: number): string {
  const full = share > 0 ? Math.min(cells, Math.max(1, Math.round(share * cells))) : 0;
  return `[${'#'.repeat(full)}${'.'.repeat(cells - full)}]`;
}

export function percent(share: number): string {
  if (share <= 0) return '0%';
  return share < 0.005 ? '<1%' : `${String(Math.round(share * 100))}%`;
}

/**
 * The folder's share of the summed mailbox size (0..1), or null when it has no bar: the sum is
 * unknown or nothing, the folder's size is unknown, it can't hold mails, or it is a Gmail label
 * whose mails are counted in All Mail already.
 */
function shareOf(folder: FolderInfo, tree: FolderTree): number | null {
  const total = tree.gmailAllHidden ? null : (tree.totals?.bytes ?? null);
  if (total === null || !(total > 0)) return null;
  if (folder.bytes === null || folder.overlapping || !folder.selectable) return null;
  return Math.min(1, Math.max(0, folder.bytes / total));
}

function sizeCell(folder: FolderInfo): string {
  return folder.bytes === null ? UNKNOWN : sizeText(folder.bytes, folder.sizeSource);
}

function countCell(n: number | null): string {
  return n === null ? UNKNOWN : String(n);
}

/**
 * The right cells of every folder row, one kind for the whole frame: the widest set that leaves
 * the name its room. A mailbox without any bar starts at "size, messages".
 */
function cellsOf(tree: FolderTree, cols: number): Cells {
  let sizeWidth = 1;
  let messagesWidth = 1;
  let bars = false;
  for (const folder of tree.folders) {
    sizeWidth = Math.max(sizeWidth, sizeCell(folder).length);
    messagesWidth = Math.max(messagesWidth, countCell(folder.messages).length);
    bars ||= shareOf(folder, tree) !== null;
  }
  const widthOf = (set: CellSet): number =>
    (set.bar > 0 ? set.bar + 3 : 0) +
    (set.percent ? PERCENT_WIDTH + 2 : 0) +
    sizeWidth +
    (set.messages ? 2 + messagesWidth : 0) +
    2;
  // The size alone is the last resort: it fits every window that isn't "too small".
  const set =
    CELL_SETS.find(
      (s) => (bars || !s.percent) && cols - widthOf(s) - 1 - INDENT.length >= NAME_MIN,
    ) ?? SIZE_ONLY;
  return { ...set, sizeWidth, messagesWidth, width: widthOf(set) };
}

function cellText(folder: FolderInfo, tree: FolderTree, cells: Cells): string {
  const share = shareOf(folder, tree);
  let text = '';
  if (cells.bar > 0) {
    text += `${share === null ? ' '.repeat(cells.bar + 2) : bar(share, cells.bar)} `;
  }
  if (cells.percent) {
    text += `${(share === null ? '' : percent(share)).padStart(PERCENT_WIDTH)}  `;
  }
  text += sizeCell(folder).padStart(cells.sizeWidth);
  if (cells.messages) text += `  ${countCell(folder.messages).padStart(cells.messagesWidth)}`;
  return `${text}  `;
}

function folderLine(
  folder: FolderInfo,
  tree: FolderTree,
  order: FolderOrder,
  cells: Cells,
  cols: number,
): string {
  const room = cols - cells.width - 1 - INDENT.length;
  // Tree order indents by depth; a deep folder's indent gives way before its name does.
  const indent = order === 'tree' ? Math.max(0, Math.min(folder.depth * 2, room - NAME_MIN)) : 0;
  const name = safeName(order === 'tree' ? folder.name : folder.path);
  const tags = `${folder.subscribed ? '' : ' (hidden)'}${folder.overlapping ? ' (overlapping)' : ''}`;
  return columns(
    `${INDENT}${' '.repeat(indent)}${name}${tags}`,
    cellText(folder, tree, cells),
    cols,
  );
}

function totalsText(tree: FolderTree): string {
  const unreadable =
    tree.unreadable > 0 ? `${plural(tree.unreadable, 'folder', 'folders')} couldn't be read` : null;
  const unknown = tree.gmailAllHidden ? GMAIL_ALL_HIDDEN : 'Totals unknown.';
  const totals = tree.gmailAllHidden ? null : tree.totals;
  if (totals === null) return unreadable === null ? unknown : `${unknown} ${unreadable}.`;
  const size = totals.bytes === null ? UNKNOWN : sizeText(totals.bytes, totals.sizeSource);
  const parts = [
    `${countCell(totals.messages)} messages`,
    `${countCell(totals.unseen)} unread`,
    size,
    ...(unreadable === null ? [] : [unreadable]),
  ];
  return `Total: ${parts.join(', ')}`;
}

function quotaText(tree: FolderTree): string {
  const quota = tree.quota;
  if (quota === null || quota.limitBytes === null || !(quota.limitBytes > 0)) return NO_QUOTA;
  // The bar stops at full; the percent says by how much a mailbox is over.
  const used = Math.max(0, quota.usedBytes / quota.limitBytes);
  return `Quota: ${bar(Math.min(1, used), BAR_CELLS)} ${percent(used)}  ${formatBytes(quota.usedBytes)} of ${formatBytes(quota.limitBytes)}`;
}

function barsBody(view: MailboxView, tree: FolderTree, height: number, cols: number): MailboxBody {
  const lines = [fit(totalsText(tree), cols), fit(quotaText(tree), cols)];
  const folders = orderedFolders(tree, view.order);
  if (folders.length === 0) {
    lines.push(fit(`${INDENT}${NO_FOLDERS}`, cols));
    return { lines: padded(lines, height, cols), cursorLine: null };
  }
  // The two lines above don't scroll: the rows get what is left.
  const room = Math.max(1, height - MAILBOX_FIXED_LINES);
  const cursor = Math.min(Math.max(0, view.cursor), folders.length - 1);
  const top = windowTop(cursor, room);
  const cells = cellsOf(tree, cols);
  for (let i = top; i < top + room && i < folders.length; i++) {
    const folder = folders[i];
    if (folder !== undefined) lines.push(folderLine(folder, tree, view.order, cells, cols));
  }
  return {
    lines: padded(lines, height, cols),
    cursorLine: 1 + MAILBOX_FIXED_LINES + cursor - top,
  };
}

/** The failure text wrapped to the body; what doesn't fit ends in "...". */
export function failureLines(failure: string, height: number, cols: number): string[] {
  const width = Math.max(1, cols - INDENT.length);
  // Line by line: sanitize() removes the line breaks, which would join two sentences.
  const lines = failure.split('\n').flatMap((part) => wrap(asciiText(sanitize(part)), width));
  if (lines.length > height) {
    lines.splice(height - 1, lines.length, fit(`${lines[height - 1] ?? ''} ...`, width));
  }
  return lines.map((line) => fit(`${INDENT}${line}`, cols));
}

export function mailboxHeader(view: MailboxView, cols: number): string {
  const listed =
    view.tree !== null &&
    (view.mode === 'ready' || view.mode === 'confirm-leave' || view.mode === 'confirm-quit');
  const right =
    view.mode === 'stats' ? statsHeaderRight(view, cols) : listed ? ORDER_TEXT[view.order] : '';
  return columns(`Mail Manager - ${sanitize(view.mailbox.email)}`, right, cols);
}

/** `timeZone`: where a mail's date on the stats screen is a day; default: this computer's zone. */
export function mailboxBody(
  view: MailboxView,
  height: number,
  cols: number,
  timeZone?: string,
): MailboxBody {
  switch (view.mode) {
    case 'connecting':
    case 'reading':
      return { lines: padded([], height, cols), cursorLine: null };
    case 'failed':
      return {
        lines: padded(failureLines(view.failure ?? '', height, cols), height, cols),
        cursorLine: null,
      };
    case 'ready':
    case 'confirm-leave':
    case 'confirm-quit':
    case 'browsing':
      return view.tree === null
        ? { lines: padded([], height, cols), cursorLine: null }
        : barsBody(view, view.tree, height, cols);
    case 'stats':
      // Looked up only here: no other screen of the mailbox shows a date.
      return statsBody(
        view,
        height,
        cols,
        timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      );
  }
}

/** What the screen is waiting for, or null. A message, when there is one, is shown instead. */
export function mailboxBusy(view: MailboxView): string | null {
  if (view.mode === 'connecting') return view.message === null ? 'Connecting...' : null;
  if (view.mode !== 'reading') return null;
  const progress = view.progress;
  return progress === null
    ? 'Reading folders...'
    : `Reading folders... ${String(progress.folder)}/${String(progress.folders)}`;
}

/** The question a `y` answers, or null: it is also shown while the window is too small. */
export function mailboxQuestion(view: MailboxView): string | null {
  const marks = plural(view.basket.marks.size, 'mark', 'marks');
  if (view.mode === 'confirm-leave') return `Drop ${marks}? (y/N)`;
  if (view.mode === 'confirm-quit') return `Quit and drop ${marks}? (y/N)`;
  return null;
}

export function mailboxHelp(view: MailboxView): readonly HelpItem[] {
  switch (view.mode) {
    case 'connecting':
    case 'reading':
      return HELP_OPENING;
    case 'failed':
      return HELP_FAILED;
    case 'confirm-leave':
    case 'confirm-quit':
      return HELP_QUESTION;
    case 'ready':
    case 'browsing':
      return HELP_BARS;
    case 'stats':
      return statsHelp(view);
  }
}
