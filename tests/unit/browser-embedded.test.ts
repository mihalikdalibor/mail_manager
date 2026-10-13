import { describe, it, expect } from 'vitest';
import { render } from '../../src/cli/browser/render.js';
import type { RenderOptions, Rendered } from '../../src/cli/browser/render.js';
import {
  childFolders,
  initialState,
  openEmbedded,
  reduce,
  rowAt,
  rowCount,
} from '../../src/cli/browser/state.js';
import type {
  BrowserAction,
  BrowserEffect,
  BrowserKey,
  BrowserState,
  BrowserStats,
  Reduced,
  Screen,
} from '../../src/cli/browser/state.js';
import { displayWidth } from '../../src/cli/browser/width.js';
import { emptyBasket, isMarked, marksOf, setMarks } from '../../src/core/mailbox/basket.js';
import type { Basket, Mark } from '../../src/core/mailbox/basket.js';
import type { MailboxErrorCode } from '../../src/core/mailbox/errors.js';
import type { FolderInfo } from '../../src/core/mailbox/folders.js';
import type { FolderSnapshot, MessageRow } from '../../src/core/mailbox/messages.js';

// M2d-2 embedded browser: openEmbedded, the `leave` effect of the M2b reducer and the key help of
// an embedded state. A state without `embedded` behaves and is drawn as before.

// --- fixtures -------------------------------------------------------------------------------

function folder(path: string, over: Partial<FolderInfo> = {}): FolderInfo {
  const parts = path.split('/');
  return {
    path,
    name: parts[parts.length - 1] ?? path,
    parentPath: parts.length > 1 ? parts.slice(0, -1).join('/') : null,
    depth: parts.length - 1,
    delimiter: '/',
    role: null,
    roleSource: null,
    selectable: true,
    subscribed: true,
    messages: 0,
    unseen: 0,
    bytes: 0,
    sizeSource: 'server',
    overlapping: false,
    ...over,
  };
}

// Root rows: INBOX, Archive (\Noselect), Empty, Projects.
const FOLDERS: FolderInfo[] = [
  folder('INBOX', { messages: 450, role: 'inbox', roleSource: 'path' }),
  folder('Archive', {
    selectable: false,
    messages: null,
    unseen: null,
    bytes: null,
    sizeSource: null,
  }),
  folder('Archive/2023', { messages: 10 }),
  folder('Archive/2024', { messages: 0 }),
  folder('Empty', { messages: 0 }),
  folder('Projects', { messages: 5 }),
  folder('Projects/Alpha', { messages: 3 }),
  folder('Projects/Alpha/Deep', { messages: 2 }),
];

const EXISTS: Record<string, number> = {
  INBOX: 450,
  'Archive/2023': 10,
  'Archive/2024': 0,
  Empty: 0,
  Projects: 5,
  'Projects/Alpha': 3,
  'Projects/Alpha/Deep': 2,
};

const TITLE = 'me@example-test-domain.eu';
const SCREEN: Screen = { rows: 24, cols: 80 }; // body height 21
const NO_STATS: BrowserStats = { foldersOpened: 0, mailsLoaded: 0, reconnects: 0 };
// Ten columns like the default YYYY-MM-DD, but independent of the local time zone.
const FMT: RenderOptions = { formatDate: (d) => d.toISOString().slice(0, 10) };

function mailRow(seq: number): MessageRow {
  return {
    seq,
    uid: 1000 + seq,
    received: new Date(Date.UTC(2026, 0, 2, 12)),
    from: `Sender ${String(seq)}`,
    subject: `Subject ${String(seq)}`,
    bytes: 100,
    attachment: false,
  };
}

/** The rows loadPage would return for `page` (newest first). */
function pageRows(exists: number, page: number): MessageRow[] {
  const to = exists - 200 * page;
  const rows: MessageRow[] = [];
  for (let seq = to; seq >= Math.max(1, to - 199); seq--) rows.push(mailRow(seq));
  return rows;
}

function snap(path: string, uidValidity = '7'): FolderSnapshot {
  const exists = EXISTS[path];
  if (exists === undefined) throw new Error(`no folder ${path} in the fixture`);
  return { path, uidValidity, exists };
}

function mark(path: string, uid: number, uidValidity = '7'): Mark {
  return { path, uidValidity, uid, bytes: 100 };
}

function basketOf(...marks: Mark[]): Basket {
  return setMarks(emptyBasket, marks, true);
}

type LoadEffect = Extract<BrowserEffect, { type: 'load' }>;

function loadIn(effects: readonly BrowserEffect[]): LoadEffect | undefined {
  return effects.find((e): e is LoadEffect => e.type === 'load');
}

function leavesIn(effects: readonly BrowserEffect[]): BrowserEffect[] {
  return effects.filter((e) => e.type === 'leave');
}

/** What loadPage answers for a load effect. */
function answer(e: LoadEffect, uidValidity = '7'): BrowserAction {
  const snapshot = snap(e.path, uidValidity);
  return {
    type: 'page-loaded',
    generation: e.generation,
    path: e.path,
    page: e.page,
    result: { kind: 'page', snapshot, page: e.page, rows: pageRows(snapshot.exists, e.page) },
  };
}

function failed(e: LoadEffect, code: MailboxErrorCode): BrowserAction {
  return { type: 'load-failed', generation: e.generation, path: e.path, page: e.page, code };
}

// --- the driver -----------------------------------------------------------------------------

/** An embedded browser, driven through reduce only; every step proves the input wasn't mutated. */
class Sim {
  state: BrowserState;
  /** Effects of the last step. */
  effects: BrowserEffect[];
  /** Every `leave` effect seen so far. */
  leaves: BrowserEffect[] = [];

  constructor(
    entry: string,
    opts: { basket?: Basket; stats?: BrowserStats; screen?: Screen } = {},
  ) {
    const out = openEmbedded(
      TITLE,
      FOLDERS,
      opts.screen ?? SCREEN,
      entry,
      opts.basket ?? emptyBasket,
      opts.stats ?? NO_STATS,
    );
    this.state = out.state;
    this.effects = out.effects;
  }

  dispatch(action: BrowserAction): BrowserEffect[] {
    const before = structuredClone(this.state);
    const out = reduce(this.state, action);
    expect(this.state).toEqual(before);
    this.state = out.state;
    this.effects = out.effects;
    this.leaves.push(...leavesIn(out.effects));
    return out.effects;
  }

  key(key: BrowserKey, times = 1): BrowserEffect[] {
    for (let i = 0; i < times; i++) this.dispatch({ type: 'key', key });
    return this.effects;
  }

  load(): LoadEffect {
    const load = loadIn(this.effects);
    if (load === undefined) throw new Error('expected a load effect');
    return load;
  }

  /** Answers the pending load and every load it triggers. */
  settle(): this {
    for (let i = 0; i < 50; i++) {
      const load = loadIn(this.effects);
      if (load === undefined) return this;
      this.dispatch(answer(load));
    }
    throw new Error('settle did not finish');
  }

  /** Opens the child folder `path` of the current place (no answer yet). */
  enter(path: string): BrowserEffect[] {
    const index = childFolders(this.state).findIndex((f) => f.path === path);
    if (index < 0) throw new Error(`no child folder ${path}`);
    while (this.state.cursor < index) this.key('down');
    while (this.state.cursor > index) this.key('up');
    return this.key('enter');
  }

  /** Presses `key` until a load effect is issued (left unanswered). */
  pressUntilLoad(key: BrowserKey): LoadEffect {
    for (let i = 0; i < 1000; i++) {
      this.key(key);
      const load = loadIn(this.effects);
      if (load !== undefined) return load;
    }
    throw new Error(`pressUntilLoad(${key}) did not finish`);
  }
}

/** The same state as the stand-alone browser would hold it. */
function standalone(state: BrowserState): BrowserState {
  const copy = { ...state };
  delete copy.embedded;
  return copy;
}

// --- openEmbedded ---------------------------------------------------------------------------

describe('openEmbedded', () => {
  it('opens inside the entry folder and loads its first page', () => {
    const out = openEmbedded(TITLE, FOLDERS, SCREEN, 'Projects', emptyBasket, NO_STATS);
    expect(out.state).toMatchObject({
      title: TITLE,
      path: 'Projects',
      cursor: 0,
      scrollTop: 0,
      screen: SCREEN,
      mode: 'browse',
      message: null,
      offline: false,
      embedded: { entry: 'Projects' },
    });
    expect(out.state.folders).toBe(FOLDERS);
    expect(out.state.view).toMatchObject({
      path: 'Projects',
      selectable: true,
      snapshot: null,
      loading: 0,
      changes: 0,
    });
    expect(out.state.view?.pages.size).toBe(0);
    expect(out.state.view?.failed.size).toBe(0);
    expect(childFolders(out.state).map((f) => f.path)).toEqual(['Projects/Alpha']);
    // The load belongs to the state it came with: its answer is accepted.
    expect(out.effects).toEqual([
      { type: 'load', generation: out.state.generation, path: 'Projects', page: 0, expected: null },
    ]);
  });

  it('the first page arrives: mails below the subfolders', () => {
    const sim = new Sim('Projects').settle();
    expect(sim.state.view?.snapshot).toEqual(snap('Projects'));
    expect(sim.state.view?.loading).toBeNull();
    expect(rowCount(sim.state)).toBe(6);
    expect(rowAt(sim.state, 0)).toMatchObject({
      kind: 'folder',
      folder: { path: 'Projects/Alpha' },
    });
    expect(rowAt(sim.state, 1)).toMatchObject({ kind: 'mail', seq: 5, status: 'loaded' });
    expect(sim.state.embedded).toEqual({ entry: 'Projects' });
    expect(sim.leaves).toEqual([]);
  });

  it('an entry below the top level opens that folder, not its parent', () => {
    const out = openEmbedded(TITLE, FOLDERS, SCREEN, 'Projects/Alpha', emptyBasket, NO_STATS);
    expect(out.state.path).toBe('Projects/Alpha');
    expect(out.state.embedded).toEqual({ entry: 'Projects/Alpha' });
    expect(childFolders(out.state).map((f) => f.path)).toEqual(['Projects/Alpha/Deep']);
    expect(loadIn(out.effects)).toMatchObject({ path: 'Projects/Alpha', page: 0, expected: null });
  });

  it('a \\Noselect entry shows its subfolders, no load', () => {
    const out = openEmbedded(TITLE, FOLDERS, SCREEN, 'Archive', emptyBasket, NO_STATS);
    expect(out.effects).toEqual([]);
    expect(out.state.path).toBe('Archive');
    expect(out.state.view).toMatchObject({ selectable: false, snapshot: null, loading: null });
    expect(childFolders(out.state).map((f) => f.path)).toEqual(['Archive/2023', 'Archive/2024']);
    expect(out.state.stats.foldersOpened).toBe(1);
    expect(out.state.embedded).toEqual({ entry: 'Archive' });
  });

  it('the basket and the stats of the visit are carried in; the entry counts as opened', () => {
    const marks = [mark('INBOX', 1450), mark('Projects', 1003)];
    const basket = basketOf(...marks);
    const stats: BrowserStats = { foldersOpened: 3, mailsLoaded: 40, reconnects: 1 };
    const out = openEmbedded(TITLE, FOLDERS, SCREEN, 'Projects', basket, stats);
    expect(marksOf(out.state.basket)).toEqual(marks);
    expect(out.state.stats).toEqual({ foldersOpened: 4, mailsLoaded: 40, reconnects: 1 });
    // The caller's objects are left alone.
    expect(stats).toEqual({ foldersOpened: 3, mailsLoaded: 40, reconnects: 1 });
    expect(marksOf(basket)).toEqual(marks);
  });

  it('a mark carried in is a mark again once the page is loaded; loaded mails add to the stats', () => {
    const sim = new Sim('Projects', {
      basket: basketOf(mark('Projects', 1003)),
      stats: { foldersOpened: 3, mailsLoaded: 40, reconnects: 1 },
    }).settle();
    expect(sim.state.message).toBeNull();
    expect(isMarked(sim.state.basket, { path: 'Projects', uidValidity: '7', uid: 1003 })).toBe(
      true,
    );
    expect(sim.state.stats).toEqual({ foldersOpened: 4, mailsLoaded: 45, reconnects: 1 });
    const lines = render(sim.state, FMT).lines;
    expect(lines.find((l) => l.includes('Subject 3'))).toContain('[x]');
    expect(lines.find((l) => l.includes('Subject 4'))).toContain('[ ]');
    expect(lines[SCREEN.rows - 2]).toContain('marked: 1 mail');
  });

  it('marks of the entry taken under another UIDVALIDITY are dropped on its first page', () => {
    const kept = mark('INBOX', 1450);
    const sim = new Sim('Projects', { basket: basketOf(kept, mark('Projects', 1003, '6')) });
    sim.settle();
    expect(marksOf(sim.state.basket)).toEqual([kept]);
    expect(sim.state.message).toEqual({ code: 'marks-cleared', count: 1 });
  });

  it('a window that is too small still opens and loads', () => {
    const out = openEmbedded(TITLE, FOLDERS, { rows: 4, cols: 20 }, 'INBOX', emptyBasket, NO_STATS);
    expect(out.state.path).toBe('INBOX');
    expect(loadIn(out.effects)).toMatchObject({ path: 'INBOX', page: 0 });
  });

  it('an entry that is not in the tree throws (a bug, not a user case)', () => {
    const open = (folders: readonly FolderInfo[], entry: string) => () =>
      openEmbedded(TITLE, folders, SCREEN, entry, emptyBasket, NO_STATS);
    expect(open(FOLDERS, 'Nowhere')).toThrow(Error);
    expect(open([], 'INBOX')).toThrow(Error);
    // A path is matched whole, never by its last segment.
    expect(open(FOLDERS, 'Alpha')).toThrow(Error);
    expect(open(FOLDERS, '')).toThrow(Error);
  });

  it('the error never names the folder', () => {
    let message = '';
    try {
      openEmbedded(TITLE, FOLDERS, SCREEN, 'Canary-Folder-Name', emptyBasket, NO_STATS);
    } catch (err) {
      message = err instanceof Error ? err.message : '';
    }
    expect(message).not.toBe('');
    expect(message).not.toContain('Canary-Folder-Name');
  });
});

// --- Back at the entry folder ---------------------------------------------------------------

describe('Back at the entry folder -> leave', () => {
  it('a leave effect and nothing else; marks and stats stay readable in the state', () => {
    const sim = new Sim('Projects').settle();
    sim.key('down');
    sim.key('space');
    const before = sim.state;
    const effects = sim.key('back');
    expect(effects).toEqual([{ type: 'leave', message: null }]);
    expect(sim.state).toEqual(before);
    expect(sim.state.path).toBe('Projects');
    expect(marksOf(sim.state.basket)).toEqual([mark('Projects', 1005)]);
    expect(sim.state.stats).toEqual({ foldersOpened: 1, mailsLoaded: 5, reconnects: 0 });
  });

  it('while the first page is still loading', () => {
    const sim = new Sim('INBOX');
    expect(sim.key('back')).toEqual([{ type: 'leave', message: null }]);
    expect(sim.state.path).toBe('INBOX');
  });

  it('at a \\Noselect entry', () => {
    const sim = new Sim('Archive');
    expect(sim.key('back')).toEqual([{ type: 'leave', message: null }]);
    expect(sim.state.path).toBe('Archive');
  });

  it('at an entry below the top level: no climbing to its parent', () => {
    const sim = new Sim('Projects/Alpha').settle();
    expect(sim.key('back')).toEqual([{ type: 'leave', message: null }]);
    expect(sim.state.path).toBe('Projects/Alpha');
  });

  it('offline (reconnect declined): still leaves, no question', () => {
    const sim = new Sim('INBOX');
    sim.dispatch(failed(sim.load(), 'connection-lost'));
    expect(sim.state.mode).toBe('reconnect-ask');
    sim.key('no');
    expect(sim.state).toMatchObject({ mode: 'browse', offline: true });
    expect(sim.key('back')).toEqual([{ type: 'leave', message: null }]);
    expect(sim.state.mode).toBe('browse');
  });

  it('a question is answered first: Back means no, it does not leave', () => {
    const quitting = new Sim('Projects', { basket: basketOf(mark('INBOX', 1450)) }).settle();
    quitting.key('quit');
    expect(quitting.state.mode).toBe('confirm-quit');
    expect(quitting.key('back')).toEqual([]);
    expect(quitting.state.mode).toBe('browse');

    const asking = new Sim('INBOX');
    asking.dispatch(failed(asking.load(), 'connection-lost'));
    expect(asking.key('back')).toEqual([]);
    expect(asking.state).toMatchObject({ mode: 'browse', offline: true, path: 'INBOX' });

    const reconnecting = new Sim('INBOX');
    reconnecting.dispatch(failed(reconnecting.load(), 'connection-lost'));
    reconnecting.key('yes');
    expect(reconnecting.state.mode).toBe('reconnecting');
    const before = reconnecting.state;
    expect(reconnecting.key('back')).toEqual([]);
    expect(reconnecting.state).toEqual(before);

    expect([...quitting.leaves, ...asking.leaves, ...reconnecting.leaves]).toEqual([]);
  });

  it('window too small: only quit acts, Back does nothing', () => {
    const sim = new Sim('Projects', { screen: { rows: 8, cols: 39 } }).settle();
    const before = sim.state;
    expect(sim.key('back')).toEqual([]);
    expect(sim.state).toEqual(before);
    expect(sim.key('quit')).toEqual([{ type: 'quit' }]);
  });

  it('quit is still quit: at once without marks, a question with the marks carried in', () => {
    expect(new Sim('Projects').settle().key('quit')).toEqual([{ type: 'quit' }]);
    const sim = new Sim('Projects', { basket: basketOf(mark('INBOX', 1450)) }).settle();
    expect(sim.key('quit')).toEqual([]);
    expect(sim.state.mode).toBe('confirm-quit');
    expect(sim.key('yes')).toEqual([{ type: 'quit' }]);
    expect(sim.leaves).toEqual([]);
  });
});

// --- Back below the entry folder ------------------------------------------------------------

describe('Back in a subfolder -> its parent, no leave', () => {
  it('back to the entry: reopened with the cursor on the folder that was left', () => {
    const sim = new Sim('Projects').settle();
    sim.enter('Projects/Alpha');
    sim.settle();
    expect(sim.state.path).toBe('Projects/Alpha');
    const gen = sim.state.generation;
    const effects = sim.key('back');
    expect(effects).toEqual([
      { type: 'load', generation: gen + 1, path: 'Projects', page: 0, expected: null },
    ]);
    expect(sim.state.path).toBe('Projects');
    expect(sim.state.cursor).toBe(0);
    expect(sim.state.embedded).toEqual({ entry: 'Projects' });
    // Entry + the subfolder; the parent reopened by Back is not counted.
    expect(sim.state.stats.foldersOpened).toBe(2);
    expect(sim.leaves).toEqual([]);

    // Now at the entry again: the next Back leaves, loading or not.
    expect(sim.key('back')).toEqual([{ type: 'leave', message: null }]);
  });

  it('two levels down: one level per Back, leave only at the entry', () => {
    const sim = new Sim('Projects').settle();
    sim.enter('Projects/Alpha');
    sim.settle();
    sim.enter('Projects/Alpha/Deep');
    sim.settle();
    expect(sim.state.path).toBe('Projects/Alpha/Deep');

    sim.key('back');
    sim.settle();
    expect(sim.state.path).toBe('Projects/Alpha');
    sim.key('back');
    sim.settle();
    expect(sim.state.path).toBe('Projects');
    expect(sim.leaves).toEqual([]);

    sim.key('back');
    expect(sim.leaves).toEqual([{ type: 'leave', message: null }]);
    expect(sim.state.path).toBe('Projects');
    expect(sim.state.stats.foldersOpened).toBe(3);
  });

  it('back into a \\Noselect entry: no load, no leave', () => {
    const sim = new Sim('Archive');
    sim.enter('Archive/2024');
    sim.settle();
    expect(sim.key('back')).toEqual([]);
    expect(sim.state.path).toBe('Archive');
    expect(sim.state.cursor).toBe(1);
    expect(sim.key('back')).toEqual([{ type: 'leave', message: null }]);
  });

  it('marks made below the entry are in the basket when the browser is left', () => {
    const sim = new Sim('Projects', { basket: basketOf(mark('INBOX', 1450)) }).settle();
    sim.enter('Projects/Alpha');
    sim.settle();
    sim.key('down');
    sim.key('space');
    sim.key('back');
    sim.settle();
    expect(sim.key('back')).toEqual([{ type: 'leave', message: null }]);
    expect(marksOf(sim.state.basket)).toEqual([mark('INBOX', 1450), mark('Projects/Alpha', 1003)]);
  });
});

// --- the first page fails -------------------------------------------------------------------

describe('first page fails', () => {
  it.each<MailboxErrorCode>(['folder-unavailable', 'list-failed', 'folder-not-found'])(
    'at the entry (%s) -> leave with folder-unavailable, no climbing above the entry',
    (code) => {
      const sim = new Sim('Projects/Alpha', { basket: basketOf(mark('INBOX', 1450)) });
      const before = sim.state;
      const effects = sim.dispatch(failed(sim.load(), code));
      expect(effects).toEqual([{ type: 'leave', message: 'folder-unavailable' }]);
      expect(sim.state).toEqual(before);
      expect(sim.state.path).toBe('Projects/Alpha');
      expect(marksOf(sim.state.basket)).toEqual([mark('INBOX', 1450)]);
    },
  );

  it('at the entry, a lost connection asks to reconnect as before (no leave)', () => {
    const sim = new Sim('Projects');
    expect(sim.dispatch(failed(sim.load(), 'connection-lost'))).toEqual([]);
    expect(sim.state).toMatchObject({ mode: 'reconnect-ask', path: 'Projects' });
    expect(sim.state.view?.loading).toBeNull();
  });

  it('at the entry after a reconnect -> leave', () => {
    const sim = new Sim('Projects');
    sim.dispatch(failed(sim.load(), 'connection-lost'));
    expect(sim.key('yes')).toEqual([{ type: 'reconnect' }]);
    const load = loadIn(sim.dispatch({ type: 'reconnected' }));
    if (load === undefined) throw new Error('no load after the reconnect');
    expect(load).toMatchObject({ path: 'Projects', page: 0, expected: null });
    expect(sim.dispatch(failed(load, 'folder-unavailable'))).toEqual([
      { type: 'leave', message: 'folder-unavailable' },
    ]);
  });

  it('in a subfolder -> back to its parent with the message, as before', () => {
    const sim = new Sim('Projects').settle();
    const load = loadIn(sim.enter('Projects/Alpha'));
    if (load === undefined) throw new Error('no load');
    const effects = sim.dispatch(failed(load, 'folder-unavailable'));
    expect(effects).toEqual([
      { type: 'load', generation: load.generation + 1, path: 'Projects', page: 0, expected: null },
    ]);
    expect(sim.state.path).toBe('Projects');
    expect(sim.state.cursor).toBe(0);
    expect(sim.state.message).toEqual({ code: 'folder-unavailable' });
    expect(sim.state.embedded).toEqual({ entry: 'Projects' });
    expect(sim.leaves).toEqual([]);
  });

  it('in a subfolder, then the reopened entry fails too -> leave', () => {
    const sim = new Sim('Projects').settle();
    const sub = loadIn(sim.enter('Projects/Alpha'));
    if (sub === undefined) throw new Error('no load');
    const reopen = loadIn(sim.dispatch(failed(sub, 'folder-unavailable')));
    if (reopen === undefined) throw new Error('no reload of the entry');
    expect(sim.dispatch(failed(reopen, 'folder-unavailable'))).toEqual([
      { type: 'leave', message: 'folder-unavailable' },
    ]);
    expect(sim.state.path).toBe('Projects');
  });

  it('a stale failure of an earlier open of the entry is ignored', () => {
    const sim = new Sim('Projects');
    const first = sim.load();
    sim.settle();
    sim.enter('Projects/Alpha');
    sim.settle();
    sim.key('back');
    const second = sim.load();
    expect(second.generation).not.toBe(first.generation);
    const before = sim.state;
    // Same path and page as the load in flight, but from the first time the entry was open.
    expect(sim.dispatch(failed(first, 'folder-unavailable'))).toEqual([]);
    expect(sim.state).toEqual(before);
    expect(sim.leaves).toEqual([]);
  });

  it('the quit question does not hold the leave back', () => {
    const sim = new Sim('Projects', { basket: basketOf(mark('INBOX', 1450)) });
    const load = sim.load();
    sim.key('quit');
    expect(sim.state.mode).toBe('confirm-quit');
    expect(sim.dispatch(failed(load, 'folder-unavailable'))).toEqual([
      { type: 'leave', message: 'folder-unavailable' },
    ]);
  });
});

describe('later failures at the entry stay in the folder', () => {
  it('a later page fails -> page-failed, no leave', () => {
    const sim = new Sim('INBOX').settle();
    const load = sim.pressUntilLoad('pagedown');
    expect(load).toMatchObject({ path: 'INBOX', page: 1 });
    const effects = sim.dispatch(failed(load, 'folder-unavailable'));
    expect(leavesIn(effects)).toEqual([]);
    expect(sim.state.path).toBe('INBOX');
    expect(sim.state.message).toEqual({ code: 'page-failed' });
    expect([...(sim.state.view?.failed ?? [])]).toEqual([1]);
  });

  it('page 0 failing once the folder has a snapshot -> page-failed, no leave', () => {
    const sim = new Sim('INBOX').settle();
    const load = sim.pressUntilLoad('pagedown');
    // New mail meanwhile: the page comes back as `changed` and page 0 is read again.
    const reload = loadIn(
      sim.dispatch({
        type: 'page-loaded',
        generation: load.generation,
        path: 'INBOX',
        page: load.page,
        result: { kind: 'changed', snapshot: { path: 'INBOX', uidValidity: '7', exists: 451 } },
      }),
    );
    if (reload === undefined) throw new Error('no reload');
    expect(reload.page).toBe(0);
    const effects = sim.dispatch(failed(reload, 'folder-unavailable'));
    expect(leavesIn(effects)).toEqual([]);
    expect(sim.state.path).toBe('INBOX');
    expect(sim.state.message).toEqual({ code: 'page-failed' });
  });
});

// --- not embedded ---------------------------------------------------------------------------

describe('a browser that is not embedded never leaves', () => {
  function opened(path: string): Reduced {
    let s = initialState(TITLE, FOLDERS, SCREEN);
    const index = childFolders(s).findIndex((f) => f.path === path);
    for (let i = 0; i < index; i++) s = reduce(s, { type: 'key', key: 'down' }).state;
    return reduce(s, { type: 'key', key: 'enter' });
  }

  it('initialState has no `embedded`', () => {
    expect('embedded' in initialState(TITLE, FOLDERS, SCREEN)).toBe(false);
  });

  it('Back in a top-level folder goes to the root; Back at the root does nothing', () => {
    const out = reduce(opened('Projects').state, { type: 'key', key: 'back' });
    expect(out.effects).toEqual([]);
    expect(out.state.path).toBeNull();
    const again = reduce(out.state, { type: 'key', key: 'back' });
    expect(again.effects).toEqual([]);
    expect(again.state).toEqual(out.state);
  });

  it('a first page that fails goes back to the root with the message', () => {
    const { state, effects } = opened('Projects');
    const load = loadIn(effects);
    if (load === undefined) throw new Error('no load');
    const out = reduce(state, failed(load, 'folder-unavailable'));
    expect(out.effects).toEqual([]);
    expect(out.state.path).toBeNull();
    expect(out.state.message).toEqual({ code: 'folder-unavailable' });
  });
});

// --- render ---------------------------------------------------------------------------------

const SCREENS: Screen[] = [
  { cols: 40, rows: 8 },
  { cols: 80, rows: 24 },
  { cols: 200, rows: 50 },
];

const HELP_BEFORE =
  'Up/Down move  PgUp/PgDn page  Enter open  Left back  Space mark  a mark screen  q quit  + = attachment';
const HELP_EMBEDDED =
  'Up/Down move  PgUp/PgDn page  Enter open  Esc/Left back  / filter  o order  Space mark  a mark screen  m mark all  q quit  + = attachment';

function helpOf(out: Rendered): string {
  return (out.lines[out.lines.length - 1] ?? '').trimEnd();
}

/** Embedded states in every mode, by name. */
function embeddedStates(screen: Screen): [string, BrowserState][] {
  const marks = basketOf(mark('INBOX', 1450), mark('Projects', 1003));

  const loading = new Sim('INBOX', { screen });
  const loaded = new Sim('Projects', { screen, basket: marks }).settle();
  const scrolled = new Sim('INBOX', { screen }).settle();
  scrolled.key('pagedown', 2);
  scrolled.settle();
  const sub = new Sim('Projects', { screen }).settle();
  sub.enter('Projects/Alpha');
  sub.settle();
  const noselect = new Sim('Archive', { screen });
  const empty = new Sim('Empty', { screen }).settle();
  const quitting = new Sim('Projects', { screen, basket: marks }).settle();
  quitting.key('quit');
  const asking = new Sim('INBOX', { screen });
  asking.dispatch(failed(asking.load(), 'connection-lost'));
  const reconnecting = new Sim('INBOX', { screen });
  reconnecting.dispatch(failed(reconnecting.load(), 'connection-lost'));
  reconnecting.key('yes');
  const offline = new Sim('INBOX', { screen });
  offline.dispatch(failed(offline.load(), 'connection-lost'));
  offline.key('no');
  const message = new Sim('Projects', { screen }).settle();
  message.key('space');

  return [
    ['loading', loading.state],
    ['loaded with marks', loaded.state],
    ['scrolled', scrolled.state],
    ['subfolder', sub.state],
    ['noselect entry', noselect.state],
    ['empty entry', empty.state],
    ['quit question', quitting.state],
    ['reconnect question', asking.state],
    ['reconnecting', reconnecting.state],
    ['offline', offline.state],
    ['status message', message.state],
  ];
}

describe('render: key help of an embedded browser', () => {
  it('the stand-alone help is unchanged; the embedded help is the M3a list', () => {
    const wide = new Sim('Projects', { screen: { cols: 200, rows: 50 } }).settle();
    expect(helpOf(render(wide.state, FMT))).toBe(HELP_EMBEDDED);
    const normal = new Sim('Projects').settle();
    expect(helpOf(render(normal.state, FMT))).toBe(
      'Up/Down move  Enter open  Esc/Left back  / filter  o order  Space mark  q quit',
    );
  });

  it('also below the entry folder', () => {
    const sim = new Sim('Projects', { screen: { cols: 200, rows: 50 } }).settle();
    sim.enter('Projects/Alpha');
    sim.settle();
    expect(helpOf(render(sim.state, FMT))).toBe(HELP_EMBEDDED);
  });

  it('a narrow window drops the items of least rank first', () => {
    const narrow = new Sim('Projects', { screen: { cols: 40, rows: 8 } }).settle();
    expect(helpOf(render(narrow.state, FMT))).toBe('Up/Down move  / filter  o order  q quit');
    expect(helpOf(render(standalone(narrow.state), FMT))).toBe('Up/Down move  Space mark  q quit');
  });
});

describe('render: a state without `embedded` is drawn as before', () => {
  it('the stand-alone key help is byte-identical to before', () => {
    const root = initialState(TITLE, FOLDERS, { cols: 200, rows: 50 });
    expect(render(root, FMT).lines[49]).toBe(HELP_BEFORE.padEnd(200));
    const normal = initialState(TITLE, FOLDERS, SCREEN);
    expect(render(normal, FMT).lines[23]).toBe(
      'Up/Down move  Enter open  Left back  Space mark  a mark screen  q quit'.padEnd(80),
    );
    for (const screen of SCREENS) {
      expect(helpOf(render(initialState(TITLE, FOLDERS, screen), FMT))).not.toContain('Esc');
    }
  });

  it('the same state without `embedded` gets the stand-alone help', () => {
    const sim = new Sim('Projects', { screen: { cols: 200, rows: 50 } }).settle();
    expect(helpOf(render(standalone(sim.state), FMT))).toBe(HELP_BEFORE);
  });

  it('an embedded frame differs from the stand-alone frame of that state in the help line only', () => {
    for (const screen of SCREENS) {
      for (const [name, state] of embeddedStates(screen)) {
        const embedded = render(state, FMT);
        const plain = render(standalone(state), FMT);
        try {
          expect(embedded.lines).toHaveLength(screen.rows);
          for (const line of embedded.lines) expect(displayWidth(line)).toBe(screen.cols);
          expect(embedded.lines.slice(0, -1)).toEqual(plain.lines.slice(0, -1));
          expect(embedded.cursorLine).toBe(plain.cursorLine);
          expect(helpOf(embedded)).not.toBe(helpOf(plain));
          expect(helpOf(plain)).not.toMatch(/\/ filter|o order|m mark all|Esc\/Left back/);
        } catch (err) {
          throw new Error(
            `${name} at ${String(screen.cols)}x${String(screen.rows)}: ${(err as Error).message}`,
            { cause: err },
          );
        }
      }
    }
  });

  it('the same screen as the stand-alone browser opened in that folder', () => {
    let s = initialState(TITLE, FOLDERS, SCREEN);
    s = reduce(s, { type: 'key', key: 'down' }).state;
    s = reduce(s, { type: 'key', key: 'down' }).state;
    s = reduce(s, { type: 'key', key: 'down' }).state;
    const entered = reduce(s, { type: 'key', key: 'enter' });
    expect(entered.state.path).toBe('Projects');
    const load = loadIn(entered.effects);
    if (load === undefined) throw new Error('no load');
    const plain = reduce(entered.state, answer(load)).state;
    const embedded = new Sim('Projects').settle().state;
    expect(render(standalone(embedded), FMT)).toEqual(render(plain, FMT));
  });

  it('window too small: the same frame, with or without a pending question', () => {
    for (const screen of [
      { cols: 39, rows: 8 },
      { cols: 40, rows: 7 },
      { cols: 20, rows: 3 },
    ]) {
      for (const [name, state] of embeddedStates(screen)) {
        const embedded = render(state, FMT);
        try {
          expect(embedded).toEqual(render(standalone(state), FMT));
          expect(embedded.lines).toHaveLength(screen.rows);
          expect(embedded.lines.join('\n')).not.toContain('back');
        } catch (err) {
          throw new Error(`${name}: ${(err as Error).message}`, { cause: err });
        }
      }
    }
  });
});
