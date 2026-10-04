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

// State of the interactive folder browser (M2b): a pure reducer. Every input (a key, a page
// that arrived, a failure, a resize) gives a new state plus effects — loads, a reconnect, quit
// — that the terminal shell (M2b-2) runs and answers with further actions. Nothing here talks
// to IMAP, prints or logs. Mail data (sender, subject) is held for display only.
//
// Rows of the current place: its subfolders first, then its mails newest arrived first. Mail
// rows are virtual: index m ↔ sequence `exists - m`, page `floor(m / PAGE_SIZE)`; at most
// MAX_PAGES pages are held.

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
  | { code: 'marks-cleared'; count: number }
  | { code: 'text'; text: string };

export type BrowserMode = 'browse' | 'confirm-quit' | 'reconnect-ask' | 'reconnecting';

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
  | { type: 'resize'; screen: Screen }
  | { type: 'page-loaded'; generation: number; path: string; page: number; result: PageResult }
  | { type: 'load-failed'; generation: number; path: string; page: number; code: MailboxErrorCode }
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
  | { type: 'reconnect' }
  | { type: 'quit' };

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

/** Body lines between the header and the status + help lines. */
export function bodyHeight(screen: Screen): number {
  return Math.max(1, screenOf(screen).rows - 3);
}

function size(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** A terminal size as whole non-negative numbers (a non-TTY reports `undefined`). */
export function screenOf(screen: Screen): Screen {
  return { rows: size(screen.rows), cols: size(screen.cols) };
}

export function childFolders(state: BrowserState): readonly FolderInfo[] {
  return state.folders.filter((f) => f.parentPath === state.path);
}

function mailCount(state: BrowserState): number {
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

export function rowAt(state: BrowserState, i: number): Row | null {
  if (!Number.isSafeInteger(i) || i < 0) return null;
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
  const body = bodyHeight(state.screen);
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
  const last = Math.min(exists - 1, state.scrollTop + bodyHeight(state.screen) - 1 - n);
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

function startLoad(state: BrowserState, view: FolderView, page: number): Reduced {
  return {
    state: withView(state, { ...view, loading: page }),
    effects: [
      {
        type: 'load',
        generation: state.generation,
        path: view.path,
        page,
        expected: view.snapshot,
      },
    ],
  };
}

/** The next page to load (nothing in flight): cursor's page first, then the visible ones. */
function nextLoad(state: BrowserState): Reduced {
  const view = state.view;
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
    view: {
      path: folder.path,
      selectable: folder.selectable,
      snapshot: null,
      pages: new Map(),
      failed: new Set(),
      loading: null,
      changes: 0,
    },
    generation: state.generation + 1,
    cursor: 0,
    scrollTop: 0,
  };
  return cursorOn(opened, cursorPath);
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
  const end = state.scrollTop + bodyHeight(state.screen);
  for (let i = state.scrollTop; i < end; i++) {
    const row = rowAt(state, i);
    if (row?.kind === 'mail' && row.mail !== null) marks.push(markOf(snapshot, row.mail));
  }
  if (marks.length === 0) return state;
  const allMarked = marks.every((m) => isMarked(state.basket, m));
  return { ...state, basket: setMarks(state.basket, marks, !allMarked) };
}

function tooSmall(screen: Screen): boolean {
  return screen.rows < MIN_ROWS || screen.cols < MIN_COLS;
}

function browseKey(state: BrowserState, key: BrowserKey): Reduced {
  // Nothing is shown but "window too small": only quit acts (no marking unseen mails).
  if (key !== 'quit' && tooSmall(state.screen)) return { state, effects: [] };
  const s: BrowserState = state.message === null ? state : { ...state, message: null };
  const body = bodyHeight(s.screen);
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
    case 'browse':
      return browseKey(state, key);
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

function onPageLoaded(
  state: BrowserState,
  a: Extract<BrowserAction, { type: 'page-loaded' }>,
): Reduced {
  const view = state.view;
  if (view === null || !isCurrent(state, a)) return { state, effects: [] };
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

function onLoadFailed(
  state: BrowserState,
  a: Extract<BrowserAction, { type: 'load-failed' }>,
): Reduced {
  const view = state.view;
  if (view === null || !isCurrent(state, a)) return { state, effects: [] };
  if (a.code === 'connection-lost') {
    // An open quit question stays; offline, the next needed load asks to reconnect.
    const quitting = state.mode === 'confirm-quit';
    return {
      state: {
        ...state,
        view: { ...view, loading: null },
        mode: quitting ? 'confirm-quit' : 'reconnect-ask',
        offline: quitting || state.offline,
      },
      effects: [],
    };
  }
  if (view.snapshot === null && a.page === 0) {
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
