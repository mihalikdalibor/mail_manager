import type { FolderTree } from '../../core/mailbox/folders.js';
import type { MailboxStats, RankedStats } from '../../core/mailbox/stats.js';
import { wrap } from '../browser/layout.js';
import { bodyHeight, type Screen } from '../browser/state.js';
import { formatBytes } from '../folders-text.js';
import { browseFinishData } from './mailbox.js';
import {
  STATS_GMAIL_HIDDEN,
  isLetter,
  tooSmall,
  type AppAction,
  type AppEffect,
  type AppKey,
  type AppReduced,
  type AppState,
  type MailboxView,
  type StatsBy,
  type StatsSection,
} from './state.js';

// The stats of an open mailbox (M2d-3) as pure steps of the mailbox reducer: starting a read,
// taking what it reports, and the keys of the stats screen. The read itself is the controller's
// - one more login, on a connection of its own. Every read has a token; what it reports carries
// it, and a result with another token belongs to an earlier read and changes nothing. The stats
// live in the view: folders, marks and a reconnect of the browser don't touch them, and they
// go with the mailbox when it is left. (mailbox.ts and this file use each other's functions;
// nothing of either runs while they load.)

/** A result of a stats read, as the controller sends it. */
export type StatsAction = Extract<
  AppAction,
  { type: 'stats-progress' | 'stats-ready' | 'stats-failed' }
>;

/** The least body lines the summary takes above the rows; it takes more when it wraps. */
export const STATS_FIXED_LINES = 1;

/** The keys that choose a section. */
const SECTION_KEYS: ReadonlyMap<string, StatsSection> = new Map([
  ['1', 'years'],
  ['2', 'senders'],
  ['3', 'domains'],
  ['4', 'largest'],
]);

function same(state: AppState): AppReduced {
  return { state, effects: [] };
}

function shown(state: AppState, view: MailboxView): AppState {
  return { ...state, view };
}

function plural(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

function folders(n: number): string {
  return plural(n, 'folder', 'folders');
}

/** `Scanned 12 folders, 3456 messages, 1.2 GB (approx.)`, then what could not be read whole. */
function summaryText(stats: MailboxStats): string {
  const parts = [
    `Scanned ${folders(stats.folders.length)}`,
    plural(stats.totals.messages, 'message', 'messages'),
    `${formatBytes(stats.totals.bytes)} (approx.)`,
  ];
  if (stats.unreadable > 0) parts.push(`${folders(stats.unreadable)} couldn't be read`);
  if (stats.partial > 0) parts.push(`${folders(stats.partial)} read only partly`);
  if (stats.notScanned > 0) parts.push(`${folders(stats.notScanned)} skipped (counted elsewhere)`);
  return parts.join(', ');
}

/**
 * The summary as lines of at most `cols` columns: what could not be read whole must not be
 * lost at the right edge. It stays above the rows and leaves them at least one line of a body
 * of `height` lines; what a body that short has no line for is joined to the last one, where
 * the renderer cuts it.
 */
export function statsSummary(stats: MailboxStats, cols: number, height: number): string[] {
  const lines = wrap(summaryText(stats), cols);
  const most = Math.max(STATS_FIXED_LINES, height - 1);
  if (lines.length <= most) return lines;
  return [...lines.slice(0, most - 1), lines.slice(most - 1).join(' ')];
}

/** Rows of a section that fit below the summary (one line of it when no stats are given). */
export function statsRoom(screen: Screen, stats?: MailboxStats): number {
  const height = bodyHeight(screen);
  const fixed =
    stats === undefined ? STATS_FIXED_LINES : statsSummary(stats, screen.cols, height).length;
  return Math.max(1, height - fixed);
}

/** A top list in the chosen order. */
export function rankedRows(ranked: RankedStats, by: StatsBy): RankedStats['bySize'] {
  return by === 'size' ? ranked.bySize : ranked.byCount;
}

function rankedCount(ranked: RankedStats, by: StatsBy): number {
  // The keys past the cap are one more row.
  return rankedRows(ranked, by).length + (ranked.others.messages > 0 ? 1 : 0);
}

/** How many rows a section has below the summary line (an empty one has none to scroll). */
export function statsRowCount(stats: MailboxStats, section: StatsSection, by: StatsBy): number {
  switch (section) {
    case 'years':
      return stats.years.length;
    case 'senders':
      return rankedCount(stats.senders, by);
    case 'domains':
      return rankedCount(stats.domains, by);
    case 'largest':
      return stats.largest.length;
  }
}

/**
 * A stats read starts: a new token and the effect that reads. Gmail with All Mail hidden has
 * nothing to read from - its text at once, and no login is made.
 */
export function startStats(
  view: MailboxView,
  tree: FolderTree,
): { view: MailboxView; effects: AppEffect[] } {
  const statsToken = view.statsToken + 1;
  if (tree.gmailAllHidden) {
    return {
      view: { ...view, stats: { status: 'failed', text: STATS_GMAIL_HIDDEN }, statsToken },
      effects: [],
    };
  }
  return {
    view: { ...view, stats: { status: 'reading', progress: null }, statsToken },
    effects: [{ type: 'read-stats', statsToken, tree }],
  };
}

/** The rows `by` further down (or up), kept inside what the section has. */
function scrolled(state: AppState, view: MailboxView, by: number): AppReduced {
  const stats = view.stats;
  const rows =
    stats.status === 'ready' ? statsRowCount(stats.stats, view.statsSection, view.statsBy) : 0;
  const room = statsRoom(state.screen, stats.status === 'ready' ? stats.stats : undefined);
  const last = Math.max(0, rows - room);
  const top = Math.min(Math.max(0, view.statsTop + by), last);
  return top === view.statsTop ? same(state) : same(shown(state, { ...view, statsTop: top }));
}

function letterKey(state: AppState, view: MailboxView, key: AppKey): AppReduced {
  const section = key.type === 'char' ? SECTION_KEYS.get(key.text) : undefined;
  if (section !== undefined) {
    return same(shown(state, { ...view, statsSection: section, statsTop: 0 }));
  }
  if (isLetter(key, 'o')) {
    // The largest mails have one order only.
    if (view.statsSection === 'largest') return same(state);
    const statsBy: StatsBy = view.statsBy === 'size' ? 'messages' : 'size';
    return same(shown(state, { ...view, statsBy, statsTop: 0 }));
  }
  if (isLetter(key, 'r')) {
    // One more login, asked for by this key - never while a read is still running.
    if (view.stats.status === 'reading' || view.tree === null) return same(state);
    const started = startStats(view, view.tree);
    return { state: shown(state, started.view), effects: started.effects };
  }
  return same(state);
}

/** A key on the stats screen (mode `stats`). */
export function statsKey(state: AppState, view: MailboxView, key: AppKey): AppReduced {
  if (isLetter(key, 'q')) {
    // As on the bars: with marks it asks first.
    return view.basket.marks.size === 0
      ? {
          state,
          effects: [{ type: 'close-mailbox', finish: browseFinishData(view) }, { type: 'quit' }],
        }
      : same(shown(state, { ...view, mode: 'confirm-quit' }));
  }
  // Only "window too small" is shown: quit is the one key that acts.
  if (tooSmall(state.screen)) return same(state);
  const page = statsRoom(
    state.screen,
    view.stats.status === 'ready' ? view.stats.stats : undefined,
  );
  switch (key.type) {
    case 'escape':
    case 'left':
    case 'backspace':
      // The bars again: a read goes on, and the section and the order are kept for next time.
      return same(shown(state, { ...view, mode: 'ready' }));
    case 'up':
      return scrolled(state, view, -1);
    case 'down':
      return scrolled(state, view, 1);
    case 'pageup':
      return scrolled(state, view, -page);
    case 'pagedown':
      return scrolled(state, view, page);
    default:
      return letterKey(state, view, key);
  }
}

/**
 * What a stats read reports, whatever the mailbox screen shows meanwhile (the bars, a folder,
 * a question). Only the read that is under way counts: a result of an earlier one is dropped.
 */
export function statsResult(state: AppState, view: MailboxView, action: StatsAction): AppReduced {
  if (action.statsToken !== view.statsToken) return same(state);
  switch (action.type) {
    case 'stats-progress':
      // Progress that arrives after the result changes nothing.
      return view.stats.status === 'reading'
        ? same(shown(state, { ...view, stats: { status: 'reading', progress: action.progress } }))
        : same(state);
    case 'stats-ready':
      return same(shown(state, { ...view, stats: { status: 'ready', stats: action.stats } }));
    case 'stats-failed':
      return same(shown(state, { ...view, stats: { status: 'failed', text: action.text } }));
  }
}
