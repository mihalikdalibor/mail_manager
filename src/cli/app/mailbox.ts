import { basketTotals } from '../../core/mailbox/basket.js';
import type { FolderTree } from '../../core/mailbox/folders.js';
import {
  openEmbedded,
  reduce,
  type BrowserAction,
  type LineKey,
  type Reduced,
} from '../browser/state.js';
import { startStats, statsKey, statsResult } from './mailbox-stats.js';
import {
  browserKeyOf,
  emit,
  folderRoom,
  isLetter,
  orderedFolders,
  tooSmall,
  type AppAction,
  type AppEffect,
  type AppKey,
  type AppMessage,
  type AppReduced,
  type AppState,
  type BrowseFinishData,
  type FolderOrder,
  type MailboxView,
} from './state.js';

// The mailbox screen (M2d-2) as a pure reducer: one mailbox of Home, opened by one login. While
// the login and the folder read run it waits ("connecting", "reading"); then its folders are
// rows with usage bars ("ready"), and Enter on one opens the M2b browser inside that folder
// ("browsing"). The browser is not a second program: its reducer runs here as part of this
// view, and its effects leave as app effects. The marks and the counts of the visit live in
// this view, so they survive from one folder to the next. Every way out of the mailbox gives
// one `close-mailbox` effect - the controller logs out the session. The stats of the mailbox
// (M2d-3, `s` on the bars) are steps of this reducer too: mailbox-stats.ts.

const NEXT_ORDER: Record<FolderOrder, FolderOrder> = { tree: 'size', size: 'name', name: 'tree' };

function same(state: AppState): AppReduced {
  return { state, effects: [] };
}

function shown(state: AppState, view: MailboxView): AppState {
  return { ...state, view };
}

function isBack(key: AppKey): boolean {
  return key.type === 'escape' || key.type === 'left' || key.type === 'backspace';
}

/** A key as the filter line takes it (M3a): typed text, Backspace, Ctrl+U, Enter or Esc. */
function lineKeyOf(key: AppKey): LineKey | null {
  switch (key.type) {
    case 'char':
      return { type: 'char', text: key.text };
    case 'backspace':
    case 'clear':
    case 'enter':
    case 'escape':
      return { type: key.type };
    default:
      return null;
  }
}

/** The cursor inside `count` rows. */
function clamped(cursor: number, count: number): number {
  return Math.min(Math.max(0, cursor), Math.max(0, count - 1));
}

/** The note that stays on the bars; a key clears any other message. */
function note(view: MailboxView): AppMessage | null {
  return view.tree?.truncated === true ? 'truncated' : null;
}

/**
 * What `browse.finish` reports of the visit this view shows; null when no folder was opened.
 * While a folder is open the browser holds the live counts and marks.
 */
export function browseFinishData(view: MailboxView): BrowseFinishData | null {
  if (!view.opened) return null;
  const stats = view.browser?.stats ?? view.visit;
  const totals = basketTotals(view.browser?.basket ?? view.basket);
  return {
    opened: true,
    folders: stats.foldersOpened,
    mails: stats.mailsLoaded,
    reconnects: stats.reconnects,
    marked: totals.count,
    bytes: totals.bytes,
  };
}

function closing(view: MailboxView): AppEffect {
  return { type: 'close-mailbox', finish: browseFinishData(view) };
}

/**
 * Back to Home as it was; the marks go with the view. The new generation drops a login or read
 * still in flight, and is past every browser token of this visit - the next visit's tokens are
 * new ones.
 */
function leave(state: AppState, view: MailboxView): AppReduced {
  return {
    state: {
      ...state,
      generation: Math.max(state.generation, view.browserToken) + 1,
      view: view.home,
    },
    effects: [closing(view)],
  };
}

function quit(state: AppState, view: MailboxView): AppReduced {
  return { state, effects: [closing(view), { type: 'quit' }] };
}

/**
 * The whole login + read again, as a new request. The stats start over with it: a new token, so
 * nothing an earlier read still reports can be taken for this attempt's.
 */
function retry(state: AppState, view: MailboxView): AppReduced {
  return emit(
    shown(state, {
      ...view,
      mode: 'connecting',
      failure: null,
      progress: null,
      tree: null,
      stats: { status: 'idle' },
      statsToken: view.statsToken + 1,
      message: null,
    }),
    { type: 'open-mailbox', accountId: view.mailbox.id },
  );
}

/** A step of the embedded browser put into the view; its effects as app effects. */
function browserStep(state: AppState, view: MailboxView, out: Reduced): AppReduced {
  const browser = out.state;
  const next: MailboxView = { ...view, browser };
  const effects: AppEffect[] = [];
  for (const effect of out.effects) {
    switch (effect.type) {
      case 'load':
        effects.push({
          type: 'load-page',
          browserToken: view.browserToken,
          browserGeneration: effect.generation,
          path: effect.path,
          page: effect.page,
          expected: effect.expected,
        });
        break;
      case 'search':
        effects.push({
          type: 'search-folder',
          browserToken: view.browserToken,
          browserGeneration: effect.generation,
          path: effect.path,
          filter: effect.filter,
        });
        break;
      case 'load-matches':
        effects.push({
          type: 'load-matches',
          browserToken: view.browserToken,
          browserGeneration: effect.generation,
          path: effect.path,
          page: effect.page,
          expected: effect.expected,
          uids: effect.uids,
        });
        break;
      case 'stop-search':
        effects.push({ type: 'stop-search' });
        break;
      case 'reconnect':
        effects.push({ type: 'reconnect-mailbox', browserToken: view.browserToken });
        break;
      case 'quit':
        // The browser asked about the marks itself.
        return quit(shown(state, next), next);
      case 'leave':
        // Back to the bars: the marks and counts return to the view, and the new token drops
        // whatever this browser still has in flight.
        return same(
          shown(state, {
            ...view,
            mode: 'ready',
            basket: browser.basket,
            visit: browser.stats,
            browser: null,
            browserToken: view.browserToken + 1,
            message: effect.message ?? note(view),
          }),
        );
    }
  }
  return { state: shown(state, next), effects };
}

/** An action for the open browser; without one it changes nothing. */
function toBrowser(state: AppState, view: MailboxView, action: BrowserAction): AppReduced {
  if (view.mode !== 'browsing' || view.browser === null) return same(state);
  return browserStep(state, view, reduce(view.browser, action));
}

/** The browser inside the folder `path`, seeded with the marks and counts of the visit. */
function openFolder(
  state: AppState,
  view: MailboxView,
  tree: FolderTree,
  path: string,
): AppReduced {
  const opened = openEmbedded(
    view.mailbox.email,
    tree.folders,
    state.screen,
    path,
    view.basket,
    view.visit,
  );
  const browsing: MailboxView = {
    ...view,
    mode: 'browsing',
    opened: true,
    browserToken: view.browserToken + 1,
    message: null,
  };
  return browserStep(state, browsing, opened);
}

function barsKey(state: AppState, view: MailboxView, tree: FolderTree, key: AppKey): AppReduced {
  const marks = view.basket.marks.size;
  if (isLetter(key, 'q')) {
    return marks === 0 ? quit(state, view) : same(shown(state, { ...view, mode: 'confirm-quit' }));
  }
  // Only "window too small" is shown: quit is the one key that acts.
  if (tooSmall(state.screen)) return same(state);
  const folders = orderedFolders(tree, view.order);
  const cursor = clamped(view.cursor, folders.length);
  const v: MailboxView = { ...view, cursor, message: note(view) };
  const moved = (to: number): AppReduced =>
    same(shown(state, { ...v, cursor: clamped(to, folders.length) }));
  const page = folderRoom(state.screen);
  switch (key.type) {
    case 'up':
      return moved(cursor - 1);
    case 'down':
      return moved(cursor + 1);
    case 'pageup':
      return moved(cursor - page);
    case 'pagedown':
      return moved(cursor + page);
    case 'enter': {
      const folder = folders[cursor];
      return folder === undefined ? same(shown(state, v)) : openFolder(state, v, tree, folder.path);
    }
    case 'escape':
    case 'left':
    case 'backspace':
      return marks === 0 ? leave(state, view) : same(shown(state, { ...v, mode: 'confirm-leave' }));
    case 'char': {
      if (isLetter(key, 's')) {
        // The stats screen; a read that was not asked for yet starts with it.
        const started = v.stats.status === 'idle' ? startStats(v, tree) : { view: v, effects: [] };
        return {
          state: shown(state, { ...started.view, mode: 'stats' }),
          effects: started.effects,
        };
      }
      if (!isLetter(key, 'o')) return same(shown(state, v));
      // The next order, the cursor still on the same folder.
      const order = NEXT_ORDER[v.order];
      const focused = folders[cursor]?.path;
      const index =
        focused === undefined
          ? 0
          : orderedFolders(tree, order).findIndex((f) => f.path === focused);
      return same(shown(state, { ...v, order, cursor: Math.max(0, index) }));
    }
    default:
      return same(shown(state, v));
  }
}

function onKey(state: AppState, view: MailboxView, key: AppKey): AppReduced {
  // Only "window too small" is shown: quit and the answer to a pending question still act.
  const small = tooSmall(state.screen);
  switch (view.mode) {
    case 'connecting':
    case 'reading':
      if (isLetter(key, 'q')) return quit(state, view);
      return !small && isBack(key) ? leave(state, view) : same(state);
    case 'failed':
      if (isLetter(key, 'q')) return quit(state, view);
      if (small) return same(state);
      if (isBack(key)) return leave(state, view);
      return isLetter(key, 'r') ? retry(state, view) : same(state);
    case 'ready':
      return view.tree === null ? same(state) : barsKey(state, view, view.tree, key);
    case 'confirm-leave':
      return isLetter(key, 'y')
        ? leave(state, view)
        : same(shown(state, { ...view, mode: 'ready' }));
    case 'confirm-quit':
      return isLetter(key, 'y')
        ? quit(state, view)
        : same(shown(state, { ...view, mode: 'ready' }));
    case 'browsing': {
      // A filter line open takes the keys as text (and Enter / Esc); other keys do nothing there.
      if (view.browser?.mode === 'filter-edit') {
        const line = lineKeyOf(key);
        return line === null ? same(state) : toBrowser(state, view, { type: 'line', key: line });
      }
      return toBrowser(state, view, { type: 'key', key: browserKeyOf(key, true) });
    }
    case 'stats':
      return statsKey(state, view, key);
  }
}

/** One step of the mailbox screen; a state showing another view comes back unchanged. */
export function reduceMailbox(state: AppState, action: AppAction): AppReduced {
  const view = state.view;
  if (view.kind !== 'mailbox') return same(state);
  const waiting = view.mode === 'connecting' || view.mode === 'reading';
  switch (action.type) {
    case 'key':
      return onKey(state, view, action.key);
    case 'resize':
      // reduceApp has set the app's screen; the open browser follows with its own.
      return toBrowser(state, view, action);
    case 'browser':
      // A result of a browser that was left meanwhile changes nothing.
      return action.browserToken === view.browserToken
        ? toBrowser(state, view, action.action)
        : same(state);
    case 'stats-progress':
    case 'stats-ready':
    case 'stats-failed':
      // Whatever is on screen: the stats belong to the mailbox, not to one of its screens.
      return statsResult(state, view, action);
    case 'challenge':
      return view.mode === 'connecting'
        ? same(shown(state, { ...view, message: 'challenge' }))
        : same(state);
    case 'challenge-done':
      // The login starts: "Connecting..." again.
      return view.mode === 'connecting' && view.message === 'challenge'
        ? same(shown(state, { ...view, message: null }))
        : same(state);
    case 'mailbox-reading':
      return view.mode === 'connecting'
        ? same(shown(state, { ...view, mode: 'reading', message: null }))
        : same(state);
    case 'mailbox-progress':
      return view.mode === 'reading'
        ? same(shown(state, { ...view, progress: action.progress }))
        : same(state);
    case 'mailbox-opened': {
      if (!waiting) return same(state);
      const ready: MailboxView = { ...view, mode: 'ready', tree: action.tree, progress: null };
      const bars: MailboxView = { ...ready, cursor: 0, message: note(ready) };
      if (!state.autoStats) return same(shown(state, bars));
      // The folders are there: the stats are read behind the bars.
      const started = startStats(bars, action.tree);
      return { state: shown(state, started.view), effects: started.effects };
    }
    case 'mailbox-failed':
      if (!waiting) return same(state);
      return same(
        shown(state, {
          ...view,
          mode: 'failed',
          failure: action.text,
          progress: null,
          message: null,
        }),
      );
    default:
      return same(state);
  }
}
