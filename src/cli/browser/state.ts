import { EMPTY_FILTER, type Filter } from '../../core/filters/schema.js';
import { MAX_FILTER_LINE, parseFilterLine, type LineError } from '../../core/filters/line.js';
import type { MailboxErrorCode } from '../../core/mailbox/errors.js';
import type { FolderInfo } from '../../core/mailbox/folders.js';
import {
  PAGE_SIZE,
  type FolderSnapshot,
  type MessageRow,
  type PageResult,
} from '../../core/mailbox/messages.js';
import {
  emptyBasket,
  isMarked,
  reconcileFolder,
  setMarks,
  toggleMark,
  type Basket,
  type Mark,
} from '../../core/mailbox/basket.js';
import {
  sortMatches,
  type Match,
  type SearchOrder,
  type SearchResult,
} from '../../core/mailbox/search.js';
import { erased, typed } from './field.js';

// State of the interactive folder browser (M2b): a pure reducer. Every input (a key, a page
// that arrived, a failure, a resize) gives a new state plus effects — loads, a reconnect, quit
// — that the terminal shell (M2b-2) runs and answers with further actions. Nothing here talks
// to IMAP, prints or logs. Mail data (sender, subject) is held for display only.
//
// Rows of the current place: its subfolders first, then its mails newest arrived first. Mail
// rows are virtual: index m ↔ sequence `exists - m`, page `floor(m / PAGE_SIZE)`; at most
// MAX_PAGES pages are held.
//
// Inside the app (M2d-2) the same reducer runs with `embedded` set (`openEmbedded`): the browser
// starts in one folder, and Back there - or its first page failing - gives a `leave` effect
// instead of climbing to the parent. Without `embedded` nothing differs.
//
// Inside the app (M3a) the mail list can also be a listing: the matches of a filter line, in an
// order, with their rows read by UID (`view.listing`). The reducer says what to search and what
// to read; the shell runs it. The typed filter line is held for display only and never logged.

export type BrowserKey =
  | 'up'
  | 'down'
  | 'pageup'
  | 'pagedown'
  | 'enter'
  | 'back'
  | 'space'
  | 'mark-screen'
  | 'quit'
  | 'yes'
  | 'no'
  | 'reconnect'
  | 'filter'
  | 'order'
  | 'mark-all'
  | 'other';

/** The shape of a `node:readline` keypress. */
export interface Keypress {
  name?: string | undefined;
  sequence?: string | undefined;
  ctrl?: boolean | undefined;
  meta?: boolean | undefined;
  shift?: boolean | undefined;
}

export interface Screen {
  rows: number;
  cols: number;
}

export const MAX_PAGES = 5;
/** Consecutive `changed` results after which a busy folder stops reloading. */
export const MAX_CHANGES = 3;
/** Below this size only "window too small" is shown and only quit acts. */
export const MIN_COLS = 40;
export const MIN_ROWS = 8;
/** Marks made at once by `m` on a listing: more matches than this are not marked. */
export const MARK_ALL_MAX = 100_000;

export type MailOrder = SearchOrder;

/** One key of the filter line: a typed character, or an edit / end key. */
export type LineKey =
  { type: 'char'; text: string } | { type: 'backspace' | 'clear' | 'enter' | 'escape' };

/** A filtered and / or ordered list of the open folder (the app only). */
export interface Listing {
  /** The filter line as applied; '' = every mail. */
  text: string;
  filter: Filter;
  order: MailOrder;
  /** In display order; null while the search runs. */
  matches: readonly Match[] | null;
  /** Sum of the matches' known sizes (0 while searching). */
  bytes: number;
  progress: { done: number; total: number } | null;
}

export interface FolderView {
  path: string;
  selectable: boolean;
  /** null until the first page arrived. */
  snapshot: FolderSnapshot | null;
  pages: ReadonlyMap<number, readonly MessageRow[]>;
  failed: ReadonlySet<number>;
  /** The page in flight. */
  loading: number | null;
  /** `changed` results in a row (reset by a page): capped at MAX_CHANGES. */
  changes: number;
  /** Absent = the plain list of the folder. */
  listing?: Listing | undefined;
}

export type StatusMessage =
  | {
      code:
        | 'only-mails'
        | 'folder-changed'
        | 'folder-busy'
        | 'folder-unavailable'
        | 'page-failed'
        | 'offline';
    }
  | { code: 'search-failed' | 'too-many-matches' | 'mark-all-needs-list' }
  | { code: 'too-many-to-mark' | 'marked-all' | 'unmarked-all' | 'search-partial'; count: number }
  | { code: 'marks-cleared'; count: number }
  | { code: 'text'; text: string };

export type BrowserMode =
  'browse' | 'confirm-quit' | 'reconnect-ask' | 'reconnecting' | 'filter-edit';

/** What `browse.finish` reports (M2b-2). */
export interface BrowserStats {
  /** Folders opened with Enter (a parent reopened by Back is not counted). */
  foldersOpened: number;
  mailsLoaded: number;
  reconnects: number;
}

export interface BrowserState {
  /** The mailbox label shown in the header. */
  title: string;
  /** The M2a tree, parent before child. */
  folders: readonly FolderInfo[];
  /** Open folder; null = the root. */
  path: string | null;
  /** null at the root. */
  view: FolderView | null;
  /** Bumped on every open, back and reconnect: older results are ignored. */
  generation: number;
  cursor: number;
  scrollTop: number;
  screen: Screen;
  basket: Basket;
  mode: BrowserMode;
  message: StatusMessage | null;
  /** The user declined to reconnect: only what is loaded is shown. */
  offline: boolean;
  stats: BrowserStats;
  /** Inside the app only: the folder the browser was opened in - Back there leaves it. */
  embedded?: { entry: string };
  /** The filter line while it is open (mode `filter-edit`); removed when it closes. */
  edit?: { line: string; error: LineError | null } | undefined;
}

export type MailRowStatus = 'loaded' | 'loading' | 'failed' | 'pending' | 'unreadable';

export type Row =
  | { kind: 'folder'; folder: FolderInfo }
  | {
      kind: 'mail';
      index: number;
      seq: number;
      page: number;
      mail: MessageRow | null;
      status: MailRowStatus;
    };

export type BrowserAction =
  | { type: 'key'; key: BrowserKey }
  | { type: 'line'; key: LineKey }
  | { type: 'resize'; screen: Screen }
  | { type: 'page-loaded'; generation: number; path: string; page: number; result: PageResult }
  | { type: 'load-failed'; generation: number; path: string; page: number; code: MailboxErrorCode }
  | { type: 'search-progress'; generation: number; path: string; done: number; total: number }
  | { type: 'search-done'; generation: number; path: string; result: SearchResult }
  | { type: 'search-failed'; generation: number; path: string; code: MailboxErrorCode }
  | { type: 'reconnected' }
  | { type: 'reconnect-failed'; text: string }
  | { type: 'notice'; text: string };

export type BrowserEffect =
  | {
      type: 'load';
      generation: number;
      path: string;
      page: number;
      expected: FolderSnapshot | null;
    }
  | {
      type: 'load-matches';
      generation: number;
      path: string;
      page: number;
      expected: FolderSnapshot;
      uids: number[];
    }
  | { type: 'search'; generation: number; path: string; filter: Filter }
  | { type: 'stop-search' }
  | { type: 'reconnect' }
  | { type: 'quit' }
  /** Embedded only: out of the browser, with why when the entry folder couldn't be opened. */
  | { type: 'leave'; message: 'folder-unavailable' | null };

export interface Reduced {
  state: BrowserState;
  effects: BrowserEffect[];
}

const KEYS: Record<string, BrowserKey> = {
  up: 'up',
  down: 'down',
  pageup: 'pageup',
  pagedown: 'pagedown',
  return: 'enter',
  enter: 'enter',
  backspace: 'back',
  left: 'back',
  space: 'space',
  a: 'mark-screen',
  q: 'quit',
  escape: 'quit',
  y: 'yes',
  n: 'no',
  r: 'reconnect',
};

/**
 * Maps a readline keypress to a browser key; Ctrl/Meta combinations are the shell's. readline
 * reports a lone Esc as `{ name: 'escape', meta: true }`, so Esc is matched before that rule.
 */
export function keyOf(k: Keypress): BrowserKey {
  if (k.ctrl !== true && k.name === 'escape') return 'quit';
  if (k.ctrl === true || k.meta === true || typeof k.name !== 'string') return 'other';
  const name = k.name.toLowerCase();
  return Object.hasOwn(KEYS, name) ? (KEYS[name] ?? 'other') : 'other';
}

export function initialState(
  title: string,
  folders: readonly FolderInfo[],
  screen: Screen,
): BrowserState {
  return {
    title,
    folders,
    path: null,
    view: null,
    generation: 0,
    cursor: 0,
    scrollTop: 0,
    screen: screenOf(screen),
    basket: emptyBasket,
    mode: 'browse',
    message: null,
    offline: false,
    stats: { foldersOpened: 0, mailsLoaded: 0, reconnects: 0 },
  };
}

/**
 * The browser inside the app: opened in the folder `entry` (counted as opened), with the marks
 * and stats of the mailbox visit so far; the effect loads its first page. `entry` must be a path
 * of `folders`.
 */
export function openEmbedded(
  title: string,
  folders: readonly FolderInfo[],
  screen: Screen,
  entry: string,
  basket: Basket,
  stats: BrowserStats,
): Reduced {
  const folder = folders.find((f) => f.path === entry);
  // A bug in the caller, not a user case; the name stays out of the message.
  if (folder === undefined) throw new Error('openEmbedded: the entry folder is not in the tree');
  const start: BrowserState = {
    ...initialState(title, folders, screen),
    basket,
    stats: { ...stats, foldersOpened: stats.foldersOpened + 1 },
    embedded: { entry },
  };
  return nextLoad(enterFolder(start, folder));
}

/** Body lines between the header and the status + help lines. */
export function bodyHeight(screen: Screen): number {
  return Math.max(1, screenOf(screen).rows - 3);
}

function listingOf(state: BrowserState): Listing | undefined {
  return state.view?.listing;
}

/** The filter row is shown while the line is open and while a listing is on. */
function filterRow(state: BrowserState): boolean {
  return state.mode === 'filter-edit' || listingOf(state) !== undefined;
}

/** Rows of the list: the body minus the filter row when one is shown. */
export function listHeight(state: BrowserState): number {
  return Math.max(1, bodyHeight(state.screen) - (filterRow(state) ? 1 : 0));
}

function size(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** A terminal size as whole non-negative numbers (a non-TTY reports `undefined`). */
export function screenOf(screen: Screen): Screen {
  return { rows: size(screen.rows), cols: size(screen.cols) };
}

/** A listing shows the matches only: the subfolders of the folder are left out. */
export function childFolders(state: BrowserState): readonly FolderInfo[] {
  if (listingOf(state) !== undefined) return [];
  return state.folders.filter((f) => f.parentPath === state.path);
}

function mailCount(state: BrowserState): number {
  const listing = listingOf(state);
  if (listing !== undefined) return listing.matches?.length ?? 0;
  return state.view?.snapshot?.exists ?? 0;
}

export function rowCount(state: BrowserState): number {
  return childFolders(state).length + mailCount(state);
}

function mailStatus(view: FolderView, page: number, mail: MessageRow | null): MailRowStatus {
  if (view.pages.has(page)) return mail === null ? 'unreadable' : 'loaded';
  if (view.loading === page) return 'loading';
  if (view.failed.has(page)) return 'failed';
  return 'pending';
}

/** The i-th match of a listing; its mail when its page is loaded. Nothing while the search runs. */
function listedRowAt(state: BrowserState, listing: Listing, i: number): Row | null {
  const view = state.view;
  const match = listing.matches?.[i];
  if (view === null || match === undefined) return null;
  const page = Math.floor(i / PAGE_SIZE);
  const mail = view.pages.get(page)?.find((r) => r.uid === match.uid) ?? null;
  return {
    kind: 'mail',
    index: i,
    seq: mail?.seq ?? 0,
    page,
    mail,
    status: mailStatus(view, page, mail),
  };
}

export function rowAt(state: BrowserState, i: number): Row | null {
  if (!Number.isSafeInteger(i) || i < 0) return null;
  const listing = listingOf(state);
  if (listing !== undefined) return listedRowAt(state, listing, i);
  const children = childFolders(state);
  const folder = children[i];
  if (folder !== undefined) return { kind: 'folder', folder };
  const view = state.view;
  const exists = mailCount(state);
  const index = i - children.length;
  if (view === null || index >= exists) return null;
  const seq = exists - index;
  const page = Math.floor(index / PAGE_SIZE);
  const mail = view.pages.get(page)?.find((r) => r.seq === seq) ?? null;
  return { kind: 'mail', index, seq, page, mail, status: mailStatus(view, page, mail) };
}

function folderAt(state: BrowserState, path: string | null): FolderInfo | undefined {
  return path === null ? undefined : state.folders.find((f) => f.path === path);
}

/** Cursor clamped to the rows and kept on screen. */
function placed(state: BrowserState, cursor: number): BrowserState {
  const total = rowCount(state);
  const body = listHeight(state);
  const c = total === 0 ? 0 : Math.min(Math.max(0, cursor), total - 1);
  let top = state.scrollTop;
  if (c < top) top = c;
  if (c >= top + body) top = c - body + 1;
  top = Math.min(Math.max(0, top), Math.max(0, total - body));
  return c === state.cursor && top === state.scrollTop
    ? state
    : { ...state, cursor: c, scrollTop: top };
}

/** Page of the mail under the cursor, or null on a folder row. */
function cursorPage(state: BrowserState): number | null {
  const index = state.cursor - childFolders(state).length;
  return index >= 0 && index < mailCount(state) ? Math.floor(index / PAGE_SIZE) : null;
}

/** Pages with at least one mail row on screen, ascending. */
function visiblePages(state: BrowserState): number[] {
  const n = childFolders(state).length;
  const exists = mailCount(state);
  const first = Math.max(0, state.scrollTop - n);
  const last = Math.min(exists - 1, state.scrollTop + listHeight(state) - 1 - n);
  const pages: number[] = [];
  for (
    let p = Math.floor(first / PAGE_SIZE);
    first <= last && p <= Math.floor(last / PAGE_SIZE);
    p++
  ) {
    pages.push(p);
  }
  return pages;
}

function withView(state: BrowserState, view: FolderView): BrowserState {
  return { ...state, view };
}

/**
 * A page of the listing (its UIDs in display order) when there is one; else a page of the folder.
 */
function startLoad(state: BrowserState, view: FolderView, page: number): Reduced {
  const matches = view.listing?.matches ?? null;
  const effect: BrowserEffect =
    matches !== null && view.snapshot !== null
      ? {
          type: 'load-matches',
          generation: state.generation,
          path: view.path,
          page,
          expected: view.snapshot,
          uids: matches.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((m) => m.uid),
        }
      : {
          type: 'load',
          generation: state.generation,
          path: view.path,
          page,
          expected: view.snapshot,
        };
  return { state: withView(state, { ...view, loading: page }), effects: [effect] };
}

/** A search of the open folder is under way: its matches are not in yet. */
function searching(view: FolderView | null): boolean {
  const listing = view?.listing;
  return listing !== undefined && listing.matches === null;
}

/** The next page to load (nothing in flight): cursor's page first, then the visible ones. */
function nextLoad(state: BrowserState): Reduced {
  const view = state.view;
  if (searching(view)) return { state, effects: [] };
  if (
    state.offline ||
    view === null ||
    !view.selectable ||
    view.loading !== null ||
    state.mode === 'reconnect-ask' ||
    state.mode === 'reconnecting'
  ) {
    return { state, effects: [] };
  }
  if (view.snapshot === null) {
    return view.failed.has(0) ? { state, effects: [] } : startLoad(state, view, 0);
  }
  const cp = cursorPage(state);
  const wanted = [...(cp === null ? [] : [cp]), ...visiblePages(state)];
  const page = wanted.find((p) => !view.pages.has(p) && !view.failed.has(p));
  return page === undefined ? { state, effects: [] } : startLoad(state, view, page);
}

/**
 * Loads after a key. Offline, only opening a folder whose mails aren't loaded asks to reconnect
 * again; moving over unloaded rows shows placeholders (`r` reconnects).
 */
function loadsAfterKey(state: BrowserState, opening: boolean): Reduced {
  if (!state.offline) return nextLoad(state);
  const view = state.view;
  if (view === null || !view.selectable) return { state, effects: [] };
  const needed = opening && view.snapshot === null;
  return { state: needed ? { ...state, mode: 'reconnect-ask' } : state, effects: [] };
}

/** Shows `folder` (fresh view), cursor on the child `cursorPath` when given. */
function enterFolder(state: BrowserState, folder: FolderInfo, cursorPath?: string): BrowserState {
  const opened: BrowserState = {
    ...state,
    path: folder.path,
    view: freshView(folder),
    generation: state.generation + 1,
    cursor: 0,
    scrollTop: 0,
  };
  return cursorOn(opened, cursorPath);
}

/** The plain view of a folder, nothing read yet (no listing). */
function freshView(folder: FolderInfo): FolderView {
  return {
    path: folder.path,
    selectable: folder.selectable,
    snapshot: null,
    pages: new Map(),
    failed: new Set(),
    loading: null,
    changes: 0,
  };
}

function cursorOn(state: BrowserState, path: string | undefined): BrowserState {
  const index = path === undefined ? -1 : childFolders(state).findIndex((f) => f.path === path);
  return placed(state, Math.max(0, index));
}

/** To the parent of the open folder (reopened when selectable); at the root nothing. */
function goBack(state: BrowserState): BrowserState {
  if (state.path === null) return state;
  const left = state.path;
  const parent = folderAt(state, folderAt(state, left)?.parentPath ?? null);
  if (parent !== undefined) return enterFolder(state, parent, left);
  const root: BrowserState = {
    ...state,
    path: null,
    view: null,
    generation: state.generation + 1,
    cursor: 0,
    scrollTop: 0,
  };
  return cursorOn(root, left);
}

// The orders of the matches moved to the core (`search.ts`, M3b); re-exported for the browser's
// callers and tests.
export { sortMatches };

/** The plain list of the open folder again; a search under way is stopped. */
function plainList(state: BrowserState): Reduced {
  const folder = folderAt(state, state.path);
  if (folder === undefined) return { state, effects: [] };
  const stop: BrowserEffect[] = searching(state.view) ? [{ type: 'stop-search' }] : [];
  const out = nextLoad(enterFolder(state, folder));
  return { state: out.state, effects: [...stop, ...out.effects] };
}

/**
 * The open folder listed by `filter` in `order`: a search is started. Without a filter and with
 * the order "newest" it is the plain list.
 */
function applyListing(
  state: BrowserState,
  text: string,
  filter: Filter,
  order: MailOrder,
): Reduced {
  if (text === '' && order === 'newest') return plainList(state);
  const folder = folderAt(state, state.path);
  if (folder === undefined) return { state, effects: [] };
  const stop: BrowserEffect[] = searching(state.view) ? [{ type: 'stop-search' }] : [];
  const opened = enterFolder(state, folder);
  const listing: Listing = { text, filter, order, matches: null, bytes: 0, progress: null };
  return {
    state: { ...opened, view: { ...freshView(folder), listing }, message: null },
    effects: [
      ...stop,
      { type: 'search', generation: opened.generation, path: folder.path, filter },
    ],
  };
}

/** The app's list keys act only inside the app, online, in a folder that can be listed. */
function canList(state: BrowserState): boolean {
  return (
    state.embedded !== undefined && state.view !== null && state.view.selectable && !state.offline
  );
}

/** The state with the filter line closed: no `edit`, back to the browse mode. */
function closeLine(state: BrowserState): BrowserState {
  const closed: BrowserState = { ...state, mode: 'browse' };
  delete closed.edit;
  return closed;
}

function markOf(snapshot: FolderSnapshot, mail: MessageRow): Mark {
  return {
    path: snapshot.path,
    uidValidity: snapshot.uidValidity,
    uid: mail.uid,
    bytes: mail.bytes,
  };
}

function toggleCursor(state: BrowserState): BrowserState {
  const row = rowAt(state, state.cursor);
  if (row === null) return state;
  if (row.kind === 'folder') return { ...state, message: { code: 'only-mails' } };
  const snapshot = state.view?.snapshot;
  if (row.mail === null || snapshot === null || snapshot === undefined) return state;
  return { ...state, basket: toggleMark(state.basket, markOf(snapshot, row.mail)) };
}

/** `a`: marks every loaded mail on screen, or unmarks them when all are marked already. */
function toggleScreen(state: BrowserState): BrowserState {
  const snapshot = state.view?.snapshot;
  if (snapshot === null || snapshot === undefined) return state;
  const marks: Mark[] = [];
  const end = state.scrollTop + listHeight(state);
  for (let i = state.scrollTop; i < end; i++) {
    const row = rowAt(state, i);
    if (row?.kind === 'mail' && row.mail !== null) marks.push(markOf(snapshot, row.mail));
  }
  if (marks.length === 0) return state;
  const allMarked = marks.every((m) => isMarked(state.basket, m));
  return { ...state, basket: setMarks(state.basket, marks, !allMarked) };
}

/** `m` on a listing: marks every match, or unmarks them when all are marked already. */
function markAll(s: BrowserState): Reduced {
  if (s.embedded === undefined) return { state: s, effects: [] };
  const listing = listingOf(s);
  if (listing === undefined) {
    return { state: { ...s, message: { code: 'mark-all-needs-list' } }, effects: [] };
  }
  const snapshot = s.view?.snapshot;
  const matches = listing.matches;
  if (matches === null || snapshot === null || snapshot === undefined) {
    return { state: s, effects: [] };
  }
  if (matches.length === 0) return { state: s, effects: [] };
  if (matches.length > MARK_ALL_MAX) {
    return {
      state: { ...s, message: { code: 'too-many-to-mark', count: matches.length } },
      effects: [],
    };
  }
  const marks: Mark[] = matches.map((m) => ({
    path: snapshot.path,
    uidValidity: snapshot.uidValidity,
    uid: m.uid,
    bytes: m.bytes,
  }));
  const all = marks.every((m) => isMarked(s.basket, m));
  return {
    state: {
      ...s,
      basket: setMarks(s.basket, marks, !all),
      message: { code: all ? 'unmarked-all' : 'marked-all', count: marks.length },
    },
    effects: [],
  };
}

/** `/`: the filter line opens with the text of the listing (empty on the plain list). */
function openLine(s: BrowserState): Reduced {
  const opened: BrowserState = {
    ...s,
    mode: 'filter-edit',
    edit: { line: listingOf(s)?.text ?? '', error: null },
  };
  return { state: placed(opened, opened.cursor), effects: [] };
}

const NEXT_ORDER: Record<MailOrder, MailOrder> = {
  newest: 'oldest',
  oldest: 'largest',
  largest: 'newest',
};

/**
 * `o`: the next order. A result on screen is ordered again here, with no search; a search still
 * running takes the order when its result arrives.
 */
function cycleOrder(s: BrowserState): Reduced {
  const view = s.view;
  const listing = view?.listing;
  const next = NEXT_ORDER[listing?.order ?? 'newest'];
  if (view === null || listing === undefined) return applyListing(s, '', EMPTY_FILTER, next);
  if (listing.text === '' && next === 'newest') return plainList(s);
  if (listing.matches === null) {
    return {
      state: { ...s, view: { ...view, listing: { ...listing, order: next } } },
      effects: [],
    };
  }
  const reordered: FolderView = {
    ...view,
    listing: { ...listing, order: next, matches: sortMatches(listing.matches, next) },
    pages: new Map(),
    failed: new Set(),
    loading: null,
  };
  return nextLoad({ ...s, view: reordered, generation: s.generation + 1, cursor: 0, scrollTop: 0 });
}

/** `/` and `o` act only inside the app, online, in a folder that can be listed. */
function listKey(s: BrowserState, act: (state: BrowserState) => Reduced): Reduced {
  if (s.embedded === undefined) return { state: s, effects: [] };
  if (s.offline) return { state: { ...s, message: { code: 'offline' } }, effects: [] };
  return canList(s) ? act(s) : { state: s, effects: [] };
}

function tooSmall(screen: Screen): boolean {
  return screen.rows < MIN_ROWS || screen.cols < MIN_COLS;
}

function browseKey(state: BrowserState, key: BrowserKey): Reduced {
  // Nothing is shown but "window too small": only quit acts (no marking unseen mails).
  if (key !== 'quit' && tooSmall(state.screen)) return { state, effects: [] };
  const s: BrowserState = state.message === null ? state : { ...state, message: null };
  const body = listHeight(s);
  switch (key) {
    case 'up':
      return loadsAfterKey(placed(s, s.cursor - 1), false);
    case 'down':
      return loadsAfterKey(placed(s, s.cursor + 1), false);
    case 'pageup':
      return loadsAfterKey(placed(s, s.cursor - body), false);
    case 'pagedown':
      return loadsAfterKey(placed(s, s.cursor + body), false);
    case 'enter': {
      const row = rowAt(s, s.cursor);
      if (row?.kind !== 'folder') return { state: s, effects: [] };
      const opened = enterFolder(s, row.folder);
      return loadsAfterKey(
        { ...opened, stats: { ...opened.stats, foldersOpened: opened.stats.foldersOpened + 1 } },
        true,
      );
    }
    case 'back':
      // A listing first goes back to the plain list of its folder (a search under way stops).
      if (listingOf(s) !== undefined) return plainList(s);
      if (s.embedded !== undefined && s.path === s.embedded.entry) {
        return { state: s, effects: [{ type: 'leave', message: null }] };
      }
      return s.path === null ? { state: s, effects: [] } : loadsAfterKey(goBack(s), false);
    case 'space':
      return { state: toggleCursor(s), effects: [] };
    case 'mark-screen':
      return { state: toggleScreen(s), effects: [] };
    case 'quit':
      return s.basket.marks.size === 0
        ? { state: s, effects: [{ type: 'quit' }] }
        : { state: { ...s, mode: 'confirm-quit' }, effects: [] };
    case 'reconnect':
      return s.offline
        ? { state: { ...s, mode: 'reconnecting', message: null }, effects: [{ type: 'reconnect' }] }
        : { state: s, effects: [] };
    case 'filter':
      return listKey(s, openLine);
    case 'order':
      return listKey(s, cycleOrder);
    case 'mark-all':
      return markAll(s);
    default:
      return { state: s, effects: [] };
  }
}

function onKey(state: BrowserState, key: BrowserKey): Reduced {
  switch (state.mode) {
    case 'confirm-quit':
      return key === 'yes'
        ? { state, effects: [{ type: 'quit' }] }
        : { state: { ...state, mode: 'browse' }, effects: [] };
    case 'reconnect-ask':
      return key === 'yes' || key === 'reconnect'
        ? {
            state: { ...state, mode: 'reconnecting', message: null },
            effects: [{ type: 'reconnect' }],
          }
        : {
            state: { ...state, mode: 'browse', offline: true, message: { code: 'offline' } },
            effects: [],
          };
    case 'reconnecting':
      return { state, effects: [] };
    // The line takes text and Enter / Esc (`line` actions): named keys do nothing meanwhile.
    case 'filter-edit':
      return { state, effects: [] };
    case 'browse':
      return browseKey(state, key);
  }
}

/** Enter in the line: an unreadable line stays open with its message; otherwise it is applied. */
function enterLine(state: BrowserState, line: string): Reduced {
  const parsed = parseFilterLine(line);
  if (!parsed.ok) return { state: { ...state, edit: { line, error: parsed.error } }, effects: [] };
  const closed = closeLine(state);
  const order = listingOf(state)?.order ?? 'newest';
  const text = line.trim();
  // Offline nothing can be searched: the line closes and the reconnect question is asked.
  if (state.offline && (text !== '' || listingOf(state) !== undefined)) {
    return { state: { ...placed(closed, closed.cursor), mode: 'reconnect-ask' }, effects: [] };
  }
  if (text !== '') return applyListing(closed, text, parsed.filter, order);
  // A blank line: with nothing on it changes nothing; with a filter on, the filter goes.
  if (listingOf(state) === undefined) return { state: placed(closed, closed.cursor), effects: [] };
  return applyListing(closed, '', EMPTY_FILTER, order);
}

/** A key of the filter line (mode `filter-edit`): typed text, an edit, Enter or Esc. */
function onLine(state: BrowserState, key: LineKey): Reduced {
  const edit = state.edit;
  if (state.mode !== 'filter-edit' || edit === undefined) return { state, effects: [] };
  // Nothing is shown but "window too small": only Esc acts.
  if (tooSmall(state.screen) && key.type !== 'escape') return { state, effects: [] };
  switch (key.type) {
    case 'char':
      return {
        state: {
          ...state,
          edit: { line: typed(edit.line, key.text, MAX_FILTER_LINE), error: null },
        },
        effects: [],
      };
    case 'backspace':
      return { state: { ...state, edit: { line: erased(edit.line), error: null } }, effects: [] };
    case 'clear':
      return { state: { ...state, edit: { line: '', error: null } }, effects: [] };
    case 'escape': {
      // What was shown stays; the list may be a row taller again.
      const closed = closeLine(state);
      return { state: placed(closed, closed.cursor), effects: [] };
    }
    case 'enter':
      return enterLine(state, edit.line);
  }
}

function sameSnapshot(a: FolderSnapshot, b: FolderSnapshot): boolean {
  return a.path === b.path && a.uidValidity === b.uidValidity && a.exists === b.exists;
}

function isCurrent(state: BrowserState, a: { generation: number; path: string }): boolean {
  return a.generation === state.generation && state.view?.path === a.path;
}

/** A quit question about marks that are all gone now is dropped. */
function withBasket(state: BrowserState, basket: Basket): BrowserState {
  const quitWithoutMarks = state.mode === 'confirm-quit' && basket.marks.size === 0;
  return { ...state, basket, mode: quitWithoutMarks ? 'browse' : state.mode };
}

/**
 * Drops the cache and reloads page 0 against the folder's new snapshot. A folder that changed
 * MAX_CHANGES times in a row (mail arriving faster than a page loads) stops reloading.
 */
function folderChanged(state: BrowserState, view: FolderView, snapshot: FolderSnapshot): Reduced {
  const { basket, dropped } = reconcileFolder(state.basket, view.path, snapshot.uidValidity);
  const changes = view.changes + 1;
  const busy = changes >= MAX_CHANGES;
  const fresh: FolderView = {
    ...view,
    snapshot,
    pages: new Map(),
    failed: busy ? new Set([0]) : new Set(),
    loading: null,
    changes,
  };
  const message: StatusMessage =
    dropped > 0
      ? { code: 'marks-cleared', count: dropped }
      : { code: busy ? 'folder-busy' : 'folder-changed' };
  const s = placed(
    { ...withBasket(state, basket), view: fresh, message },
    childFolders(state).length,
  );
  return busy ? nextLoad(s) : startLoad(s, fresh, 0);
}

/** Loaded pages beyond MAX_PAGES, farthest from the cursor first; never one on screen. */
function evicted(state: BrowserState, pages: Map<number, readonly MessageRow[]>): void {
  if (pages.size <= MAX_PAGES) return;
  const visible = new Set(visiblePages(state));
  const center = cursorPage(state) ?? 0;
  while (pages.size > MAX_PAGES) {
    let victim: number | null = null;
    for (const p of pages.keys()) {
      if (visible.has(p)) continue;
      if (victim === null || Math.abs(p - center) > Math.abs(victim - center)) victim = p;
    }
    if (victim === null) return;
    pages.delete(victim);
  }
}

/**
 * A page of matches arrived, read by UID. A folder that changed (UIDVALIDITY) is searched again,
 * at most MAX_CHANGES times in a row. The header keeps the folder as it was searched.
 */
function onMatchesLoaded(
  state: BrowserState,
  view: FolderView,
  listing: Listing,
  a: Extract<BrowserAction, { type: 'page-loaded' }>,
): Reduced {
  const { result } = a;
  if (result.kind === 'changed') {
    const { basket, dropped } = reconcileFolder(
      state.basket,
      view.path,
      result.snapshot.uidValidity,
    );
    const changes = view.changes + 1;
    const withMarks = withBasket(state, basket);
    if (changes >= MAX_CHANGES)
      return plainList({ ...withMarks, message: { code: 'folder-busy' } });
    const again = applyListing(withMarks, listing.text, listing.filter, listing.order);
    const shown = again.state.view;
    return {
      state: {
        ...again.state,
        view: shown === null ? null : { ...shown, changes },
        message:
          dropped > 0 ? { code: 'marks-cleared', count: dropped } : { code: 'folder-changed' },
      },
      effects: again.effects,
    };
  }
  const pages = new Map(view.pages);
  pages.set(a.page, result.rows);
  const failed = new Set(view.failed);
  failed.delete(a.page);
  const s = placed(
    {
      ...state,
      view: { ...view, pages, failed, loading: null, changes: 0 },
      stats: { ...state.stats, mailsLoaded: state.stats.mailsLoaded + result.rows.length },
    },
    state.cursor,
  );
  evicted(s, pages);
  return nextLoad(s);
}

function onPageLoaded(
  state: BrowserState,
  a: Extract<BrowserAction, { type: 'page-loaded' }>,
): Reduced {
  const view = state.view;
  if (view === null || !isCurrent(state, a)) return { state, effects: [] };
  const listing = view.listing;
  if (listing !== undefined) return onMatchesLoaded(state, view, listing, a);
  const { result } = a;
  if (
    result.kind === 'changed' ||
    (view.snapshot !== null && !sameSnapshot(view.snapshot, result.snapshot))
  ) {
    return folderChanged(state, view, result.snapshot);
  }
  let s = state;
  if (view.snapshot === null) {
    const { basket, dropped } = reconcileFolder(s.basket, view.path, result.snapshot.uidValidity);
    s = withBasket(s, basket);
    if (dropped > 0) s = { ...s, message: { code: 'marks-cleared', count: dropped } };
  }
  const pages = new Map(view.pages);
  pages.set(a.page, result.rows);
  const failed = new Set(view.failed);
  failed.delete(a.page);
  s = placed(
    {
      ...s,
      view: { ...view, snapshot: result.snapshot, pages, failed, loading: null, changes: 0 },
      stats: { ...s.stats, mailsLoaded: s.stats.mailsLoaded + result.rows.length },
    },
    s.cursor,
  );
  evicted(s, pages);
  return nextLoad(s);
}

/** A lost connection: the reconnect question (offline, the next needed load asks again). */
function connectionLost(state: BrowserState, view: FolderView): Reduced {
  // An open quit question or filter line stays: keys typed there must never answer a question
  // that appeared under them. Offline, the next needed load or Enter in the line asks to reconnect.
  const held = state.mode === 'confirm-quit' || state.mode === 'filter-edit';
  return {
    state: {
      ...state,
      view: { ...view, loading: null },
      mode: held ? state.mode : 'reconnect-ask',
      offline: held || state.offline,
    },
    effects: [],
  };
}

function onLoadFailed(
  state: BrowserState,
  a: Extract<BrowserAction, { type: 'load-failed' }>,
): Reduced {
  const view = state.view;
  if (view === null || !isCurrent(state, a)) return { state, effects: [] };
  if (a.code === 'connection-lost') return connectionLost(state, view);
  if (view.snapshot === null && a.page === 0) {
    // Embedded, there is no parent to fall back to above the entry folder.
    if (state.embedded !== undefined && a.path === state.embedded.entry) {
      return { state, effects: [{ type: 'leave', message: 'folder-unavailable' }] };
    }
    return nextLoad({ ...goBack(state), message: { code: 'folder-unavailable' } });
  }
  const failed = new Set(view.failed);
  failed.add(a.page);
  return nextLoad({
    ...state,
    view: { ...view, failed, loading: null },
    message: { code: 'page-failed' },
  });
}

/** How far the search under way has got, for the screen. */
function onSearchProgress(
  state: BrowserState,
  a: Extract<BrowserAction, { type: 'search-progress' }>,
): Reduced {
  const view = state.view;
  const listing = view?.listing;
  if (view === null || listing === undefined || listing.matches !== null || !isCurrent(state, a)) {
    return { state, effects: [] };
  }
  const progress = { done: a.done, total: a.total };
  return { state: { ...state, view: { ...view, listing: { ...listing, progress } } }, effects: [] };
}

/**
 * The matches arrived: they are listed in the order chosen and their rows are read by UID. A
 * result without its matches (a search that ended a second time) is dropped.
 */
function onSearchDone(
  state: BrowserState,
  a: Extract<BrowserAction, { type: 'search-done' }>,
): Reduced {
  const view = state.view;
  const listing = view?.listing;
  if (view === null || listing === undefined || listing.matches !== null || !isCurrent(state, a)) {
    return { state, effects: [] };
  }
  const { result } = a;
  const { basket, dropped } = reconcileFolder(state.basket, view.path, result.snapshot.uidValidity);
  let s = withBasket(state, basket);
  if (dropped > 0) s = { ...s, message: { code: 'marks-cleared', count: dropped } };
  else if (result.missing > 0) {
    s = { ...s, message: { code: 'search-partial', count: result.missing } };
  }
  const shown: FolderView = {
    ...view,
    snapshot: result.snapshot,
    listing: {
      ...listing,
      matches: sortMatches(result.matches, listing.order),
      bytes: result.bytes,
      progress: null,
    },
    pages: new Map(),
    failed: new Set(),
    loading: null,
  };
  return nextLoad(placed({ ...s, view: shown }, 0));
}

/**
 * The search failed. A lost connection asks to reconnect (the plain view of the folder is shown);
 * any other failure shows the plain list with its message. The search has ended by itself, so
 * nothing is stopped here.
 */
function onSearchFailed(
  state: BrowserState,
  a: Extract<BrowserAction, { type: 'search-failed' }>,
): Reduced {
  const view = state.view;
  const listing = view?.listing;
  if (view === null || listing === undefined || listing.matches !== null || !isCurrent(state, a)) {
    return { state, effects: [] };
  }
  const folder = folderAt(state, state.path);
  if (folder === undefined) return { state, effects: [] };
  if (a.code === 'connection-lost') {
    return connectionLost(enterFolder(state, folder), freshView(folder));
  }
  const out = nextLoad(enterFolder(state, folder));
  const code = a.code === 'too-many-matches' ? 'too-many-matches' : 'search-failed';
  return { state: { ...out.state, message: { code } }, effects: out.effects };
}

function onReconnected(state: BrowserState): Reduced {
  const s: BrowserState = {
    ...state,
    mode: 'browse',
    offline: false,
    message: null,
    generation: state.generation + 1,
    stats: { ...state.stats, reconnects: state.stats.reconnects + 1 },
  };
  const view = s.view;
  if (view === null || !view.selectable) return { state: s, effects: [] };
  // The cursor's page is read again: a folder that changed meanwhile comes back as `changed`.
  return startLoad(s, { ...view, failed: new Set(), loading: null }, cursorPage(s) ?? 0);
}

export function reduce(state: BrowserState, action: BrowserAction): Reduced {
  switch (action.type) {
    case 'key':
      return onKey(state, action.key);
    case 'line':
      return onLine(state, action.key);
    case 'search-progress':
      return onSearchProgress(state, action);
    case 'search-done':
      return onSearchDone(state, action);
    case 'search-failed':
      return onSearchFailed(state, action);
    case 'resize':
      return nextLoad(placed({ ...state, screen: screenOf(action.screen) }, state.cursor));
    case 'page-loaded':
      return onPageLoaded(state, action);
    case 'load-failed':
      return onLoadFailed(state, action);
    case 'reconnected':
      return onReconnected(state);
    case 'reconnect-failed':
      return {
        state: {
          ...state,
          mode: 'browse',
          offline: true,
          message: { code: 'text', text: action.text },
        },
        effects: [],
      };
    case 'notice':
      return { state: { ...state, message: { code: 'text', text: action.text } }, effects: [] };
  }
}
