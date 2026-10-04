import { describe, it, expect } from 'vitest';
import {
  MAX_CHANGES,
  MAX_PAGES,
  bodyHeight,
  childFolders,
  initialState,
  keyOf,
  reduce,
  rowAt,
  rowCount,
} from '../../src/cli/browser/state.js';
import type {
  BrowserAction,
  BrowserEffect,
  BrowserKey,
  BrowserState,
  Keypress,
  Screen,
} from '../../src/cli/browser/state.js';
import { emptyBasket, isMarked, marksOf, setMarks } from '../../src/core/mailbox/basket.js';
import type { FolderInfo } from '../../src/core/mailbox/folders.js';
import type { FolderSnapshot, MessageRow } from '../../src/core/mailbox/messages.js';

// M2b-1 interactive browser state (spec): the pure reducer, driven only through initialState +
// reduce, with a fake "world" (folder → EXISTS / UIDVALIDITY) answering the load effects the way
// loadPage would.

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

// Root rows: INBOX, Archive (\Noselect), Big, Empty, Projects.
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
  folder('Big', { messages: 2000 }),
  folder('Big/Sub', { messages: 1 }),
  folder('Empty', { messages: 0 }),
  folder('Projects', { messages: 5 }),
  folder('Projects/Alpha', { messages: 3 }),
];

const SCREEN: Screen = { rows: 24, cols: 80 }; // body height 21

type World = Map<string, { exists: number; uidValidity: string }>;

function defaultWorld(): World {
  return new Map([
    ['INBOX', { exists: 450, uidValidity: '7' }],
    ['Archive/2023', { exists: 10, uidValidity: '7' }],
    ['Archive/2024', { exists: 0, uidValidity: '7' }],
    ['Big', { exists: 2000, uidValidity: '7' }],
    ['Big/Sub', { exists: 1, uidValidity: '7' }],
    ['Empty', { exists: 0, uidValidity: '7' }],
    ['Projects', { exists: 5, uidValidity: '7' }],
    ['Projects/Alpha', { exists: 3, uidValidity: '7' }],
  ]);
}

function mailRow(seq: number): MessageRow {
  return {
    seq,
    uid: 1000 + seq,
    received: new Date(Date.UTC(2026, 0, 1)),
    from: `Sender ${seq}`,
    subject: `Subject ${seq}`,
    bytes: seq,
    attachment: seq % 2 === 0,
  };
}

/** The rows loadPage would return for `page` (newest first). */
function pageRows(exists: number, page: number): MessageRow[] {
  const to = exists - 200 * page;
  if (to < 1) return [];
  const from = Math.max(1, to - 199);
  const rows: MessageRow[] = [];
  for (let seq = to; seq >= from; seq--) rows.push(mailRow(seq));
  return rows;
}

type LoadEffect = Extract<BrowserEffect, { type: 'load' }>;

function loadIn(effects: readonly BrowserEffect[]): LoadEffect | undefined {
  return effects.find((e): e is LoadEffect => e.type === 'load');
}

function snapshotOf(world: World, path: string): FolderSnapshot {
  const f = world.get(path);
  if (f === undefined) throw new Error(`no folder ${path} in the world`);
  return { path, uidValidity: f.uidValidity, exists: f.exists };
}

/** What loadPage answers for a load effect, given the world. */
function respond(world: World, e: LoadEffect): BrowserAction {
  const snapshot = snapshotOf(world, e.path);
  const base = {
    type: 'page-loaded',
    generation: e.generation,
    path: e.path,
    page: e.page,
  } as const;
  if (
    e.expected !== null &&
    (e.expected.uidValidity !== snapshot.uidValidity || e.expected.exists !== snapshot.exists)
  ) {
    return { ...base, result: { kind: 'changed', snapshot } };
  }
  return {
    ...base,
    result: { kind: 'page', snapshot, page: e.page, rows: pageRows(snapshot.exists, e.page) },
  };
}

// --- the driver -------------------------------------------------------------------------------

/** Reduce, proving the input state was not mutated. */
function step(
  state: BrowserState,
  action: BrowserAction,
): { state: BrowserState; effects: BrowserEffect[] } {
  const before = structuredClone(state);
  const out = reduce(state, action);
  expect(state).toEqual(before);
  return out;
}

function cursorPage(state: BrowserState): number | null {
  const row = rowAt(state, state.cursor);
  return row?.kind === 'mail' ? row.page : null;
}

function visibleRows(state: BrowserState): number[] {
  const out: number[] = [];
  const end = Math.min(rowCount(state), state.scrollTop + bodyHeight(state.screen));
  for (let i = state.scrollTop; i < end; i++) out.push(i);
  return out;
}

function visiblePages(state: BrowserState): number[] {
  const pages = new Set<number>();
  for (const i of visibleRows(state)) {
    const row = rowAt(state, i);
    if (row?.kind === 'mail') pages.add(row.page);
  }
  return [...pages].sort((a, b) => a - b);
}

function loadedPages(state: BrowserState): number[] {
  return [...(state.view?.pages.keys() ?? [])].sort((a, b) => a - b);
}

function checkInvariants(state: BrowserState): void {
  const n = rowCount(state);
  if (n === 0) {
    expect(state.cursor).toBe(0);
    return;
  }
  expect(state.cursor).toBeGreaterThanOrEqual(0);
  expect(state.cursor).toBeLessThanOrEqual(n - 1);
  expect(state.scrollTop).toBeLessThanOrEqual(state.cursor);
  expect(state.cursor).toBeLessThan(state.scrollTop + bodyHeight(state.screen));
}

class Sim {
  state: BrowserState;
  /** Effects of the last action. */
  effects: BrowserEffect[] = [];
  /** Every load effect seen so far. */
  loads: LoadEffect[] = [];
  readonly world: World;

  constructor(opts: { screen?: Screen; world?: World; title?: string } = {}) {
    this.world = opts.world ?? defaultWorld();
    this.state = initialState(opts.title ?? 'Test account', FOLDERS, opts.screen ?? SCREEN);
  }

  dispatch(action: BrowserAction): BrowserEffect[] {
    const out = step(this.state, action);
    this.state = out.state;
    this.effects = out.effects;
    for (const e of out.effects) if (e.type === 'load') this.loads.push(e);
    checkInvariants(this.state);
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

  /** Answers the pending load (and every load it triggers) from the world. */
  settle(): void {
    for (let i = 0; i < 200; i++) {
      const load = loadIn(this.effects);
      if (load === undefined) return;
      this.dispatch(respond(this.world, load));
    }
    throw new Error('settle did not finish');
  }

  /** Moves the cursor onto the child folder `path` of the current place. */
  cursorTo(path: string): void {
    const index = childFolders(this.state).findIndex((f) => f.path === path);
    if (index < 0) throw new Error(`no child folder ${path}`);
    while (this.state.cursor < index) this.key('down');
    while (this.state.cursor > index) this.key('up');
  }

  /** Opens the child folder `path` of the current place (no answer yet). */
  enter(path: string): BrowserEffect[] {
    this.cursorTo(path);
    return this.key('enter');
  }

  /** Opens and loads. */
  open(path: string): void {
    this.enter(path);
    this.settle();
  }

  /** Presses `key` until `done` (checked after each press), settling after each press if asked. */
  pressUntil(key: BrowserKey, done: () => boolean, settle = false, max = 1000): void {
    for (let i = 0; i < max; i++) {
      this.key(key);
      if (settle) this.settle();
      if (done()) return;
    }
    throw new Error(`pressUntil(${key}) did not finish`);
  }

  /** In an open folder: press `key` until a load effect is issued (left unanswered). */
  pressUntilLoad(key: BrowserKey): LoadEffect {
    this.pressUntil(key, () => loadIn(this.effects) !== undefined);
    return this.load();
  }
}

function snap(path: string, exists: number, uidValidity = '7'): FolderSnapshot {
  return { path, uidValidity, exists };
}

// --- keyOf ----------------------------------------------------------------------------------

describe('keyOf', () => {
  it.each<[Keypress, BrowserKey]>([
    [{ name: 'up' }, 'up'],
    [{ name: 'down' }, 'down'],
    [{ name: 'pageup' }, 'pageup'],
    [{ name: 'pagedown' }, 'pagedown'],
    [{ name: 'return' }, 'enter'],
    [{ name: 'enter' }, 'enter'],
    [{ name: 'backspace' }, 'back'],
    [{ name: 'left' }, 'back'],
    [{ name: 'space', sequence: ' ' }, 'space'],
    [{ name: 'a', sequence: 'a' }, 'mark-screen'],
    [{ name: 'q', sequence: 'q' }, 'quit'],
    [{ name: 'escape' }, 'quit'],
    // readline's real shape for a lone Esc: meta is set.
    [{ name: 'escape', meta: true, ctrl: false, sequence: '\x1b' }, 'quit'],
    [{ name: 'escape', ctrl: true }, 'other'],
    [{ name: 'r', sequence: 'r' }, 'reconnect'],
    [{ name: 'r', shift: true, sequence: 'R' }, 'reconnect'],
    [{ name: 'r', meta: true }, 'other'],
    [{ name: 'r', ctrl: true }, 'other'],
    [{ name: 'y' }, 'yes'],
    [{ name: 'y', shift: true, sequence: 'Y' }, 'yes'],
    [{ name: 'n' }, 'no'],
    [{ name: 'n', shift: true }, 'no'],
    [{ name: 'up', ctrl: true }, 'other'],
    [{ name: 'c', ctrl: true }, 'other'],
    [{ name: 'q', meta: true }, 'other'],
    [{ name: 'y', ctrl: true }, 'other'],
    [{ name: 'a', meta: true }, 'other'],
    [{ name: 'x' }, 'other'],
    [{ name: 'right' }, 'other'],
    [{ name: 'tab' }, 'other'],
    [{}, 'other'],
    [{ sequence: '\x1b[31m' }, 'other'],
  ])('%o → %s', (k, key) => {
    expect(keyOf(k)).toBe(key);
  });
});

// --- basics ---------------------------------------------------------------------------------

describe('initialState and helpers', () => {
  it('starts at the root, browsing, nothing marked', () => {
    const s = initialState('My account', FOLDERS, SCREEN);
    expect(s).toMatchObject({
      title: 'My account',
      path: null,
      view: null,
      generation: 0,
      cursor: 0,
      scrollTop: 0,
      screen: SCREEN,
      mode: 'browse',
      message: null,
      offline: false,
      stats: { foldersOpened: 0, mailsLoaded: 0, reconnects: 0 },
    });
    expect(s.folders).toEqual(FOLDERS);
    expect(s.basket.marks.size).toBe(0);
  });

  it.each<[number, number]>([
    [24, 21],
    [8, 5],
    [4, 1],
    [3, 1],
    [1, 1],
    [0, 1],
  ])('bodyHeight(rows %i) = %i', (rows, h) => {
    expect(bodyHeight({ rows, cols: 80 })).toBe(h);
  });

  it('root rows: top-level folders in tree order', () => {
    const s = initialState('t', FOLDERS, SCREEN);
    expect(childFolders(s).map((f) => f.path)).toEqual([
      'INBOX',
      'Archive',
      'Big',
      'Empty',
      'Projects',
    ]);
    expect(rowCount(s)).toBe(5);
    expect(rowAt(s, 0)).toEqual({ kind: 'folder', folder: FOLDERS[0] });
    expect(rowAt(s, 4)).toEqual({ kind: 'folder', folder: FOLDERS[7] });
    expect(rowAt(s, 5)).toBeNull();
    expect(rowAt(s, -1)).toBeNull();
  });

  it('folder rows first, then mails; index ↔ seq ↔ page; statuses', () => {
    const sim = new Sim();
    sim.enter('Big');
    // Before the first page: only the subfolder.
    expect(rowCount(sim.state)).toBe(1);
    expect(rowAt(sim.state, 0)).toEqual({ kind: 'folder', folder: FOLDERS[5] });
    expect(rowAt(sim.state, 1)).toBeNull();
    sim.settle();
    expect(rowCount(sim.state)).toBe(2001);
    expect(rowAt(sim.state, 1)).toEqual({
      kind: 'mail',
      index: 0,
      seq: 2000,
      page: 0,
      mail: mailRow(2000),
      status: 'loaded',
    });
    expect(rowAt(sim.state, 200)).toMatchObject({ kind: 'mail', index: 199, seq: 1801, page: 0 });
    expect(rowAt(sim.state, 201)).toEqual({
      kind: 'mail',
      index: 200,
      seq: 1800,
      page: 1,
      mail: null,
      status: 'pending',
    });
    expect(rowAt(sim.state, 2000)).toMatchObject({ kind: 'mail', index: 1999, seq: 1, page: 9 });
    expect(rowAt(sim.state, 2001)).toBeNull();
  });

  it('a page in flight shows its rows as loading', () => {
    const sim = new Sim();
    sim.open('Big');
    const load = sim.pressUntilLoad('pagedown');
    expect(load.page).toBe(1);
    expect(rowAt(sim.state, 201)).toMatchObject({ page: 1, status: 'loading', mail: null });
  });

  it('a loaded page without a row for a seq → unreadable', () => {
    const sim = new Sim();
    const load = loadIn(sim.enter('Projects'));
    if (load === undefined) throw new Error('no load');
    sim.dispatch({
      type: 'page-loaded',
      generation: load.generation,
      path: 'Projects',
      page: 0,
      result: {
        kind: 'page',
        snapshot: snap('Projects', 5),
        page: 0,
        rows: pageRows(5, 0).filter((r) => r.seq !== 4),
      },
    });
    expect(rowAt(sim.state, 1)).toMatchObject({ seq: 5, status: 'loaded' });
    expect(rowAt(sim.state, 2)).toEqual({
      kind: 'mail',
      index: 1,
      seq: 4,
      page: 0,
      mail: null,
      status: 'unreadable',
    });
  });
});

// --- navigation -------------------------------------------------------------------------------

describe('navigation', () => {
  it('up/down move by one and clamp', () => {
    const sim = new Sim();
    sim.key('up');
    expect(sim.state.cursor).toBe(0);
    sim.key('down', 2);
    expect(sim.state.cursor).toBe(2);
    sim.key('down', 10);
    expect(sim.state.cursor).toBe(4);
    sim.key('up');
    expect(sim.state.cursor).toBe(3);
  });

  it('pageup/pagedown move by the body height and clamp', () => {
    const sim = new Sim();
    sim.open('INBOX');
    sim.key('pagedown');
    expect(sim.state.cursor).toBe(21);
    sim.key('pagedown');
    expect(sim.state.cursor).toBe(42);
    sim.key('pageup');
    expect(sim.state.cursor).toBe(21);
    sim.key('pageup', 3);
    expect(sim.state.cursor).toBe(0);
    sim.pressUntil('pagedown', () => sim.state.cursor === 449, true);
    sim.key('pagedown');
    expect(sim.state.cursor).toBe(449);
    sim.key('down');
    expect(sim.state.cursor).toBe(449);
  });

  it('scrollTop keeps the cursor visible while moving', () => {
    const sim = new Sim();
    sim.open('INBOX');
    sim.key('down', 30);
    expect(sim.state.cursor).toBe(30);
    expect(sim.state.scrollTop).toBeGreaterThan(0);
    sim.key('up', 30);
    expect(sim.state.cursor).toBe(0);
    expect(sim.state.scrollTop).toBe(0);
  });

  it('Enter on a selectable folder opens it and loads page 0', () => {
    const sim = new Sim();
    sim.cursorTo('INBOX');
    const effects = sim.key('enter');
    expect(effects).toEqual([
      { type: 'load', generation: 1, path: 'INBOX', page: 0, expected: null },
    ]);
    expect(sim.state).toMatchObject({
      path: 'INBOX',
      cursor: 0,
      scrollTop: 0,
      generation: 1,
      message: null,
      stats: { foldersOpened: 1, mailsLoaded: 0, reconnects: 0 },
    });
    expect(sim.state.view).toMatchObject({
      path: 'INBOX',
      selectable: true,
      snapshot: null,
      loading: 0,
    });
    expect(sim.state.view?.pages.size).toBe(0);
    expect(sim.state.view?.failed.size).toBe(0);
  });

  it('Enter on a \\Noselect folder shows its subfolders, no load', () => {
    const sim = new Sim();
    const effects = sim.enter('Archive');
    expect(effects).toEqual([]);
    expect(sim.state.path).toBe('Archive');
    expect(sim.state.generation).toBe(1);
    expect(sim.state.stats.foldersOpened).toBe(1);
    expect(sim.state.view?.selectable).toBe(false);
    expect(sim.state.view?.loading ?? null).toBeNull();
    expect(childFolders(sim.state).map((f) => f.path)).toEqual(['Archive/2023', 'Archive/2024']);
    expect(rowCount(sim.state)).toBe(2);
  });

  it('Enter on a mail does nothing', () => {
    const sim = new Sim();
    sim.open('INBOX');
    sim.key('down', 3);
    const before = sim.state;
    const effects = sim.key('enter');
    expect(effects).toEqual([]);
    expect(sim.state).toEqual(before);
  });

  it('Back returns to the parent with the cursor on the folder we left', () => {
    const sim = new Sim();
    sim.open('Big');
    expect(sim.state.generation).toBe(1);
    const effects = sim.key('back');
    expect(effects).toEqual([]);
    expect(sim.state.path).toBeNull();
    expect(sim.state.view).toBeNull();
    expect(sim.state.cursor).toBe(2);
    expect(sim.state.generation).toBe(2);
    expect(rowAt(sim.state, sim.state.cursor)).toMatchObject({
      kind: 'folder',
      folder: { path: 'Big' },
    });
  });

  it('Back at the root does nothing', () => {
    const sim = new Sim();
    sim.key('down', 3);
    const before = sim.state;
    expect(sim.key('back')).toEqual([]);
    expect(sim.state).toEqual(before);
  });

  it('Back into a \\Noselect parent: cursor on the child, no load', () => {
    const sim = new Sim();
    sim.enter('Archive');
    sim.open('Archive/2024');
    expect(sim.key('back')).toEqual([]);
    expect(sim.state.path).toBe('Archive');
    expect(sim.state.cursor).toBe(1);
  });

  it('Back into a selectable parent reopens it (load page 0, expected null), foldersOpened unchanged', () => {
    const sim = new Sim();
    sim.open('Projects');
    sim.open('Projects/Alpha');
    expect(sim.state.stats.foldersOpened).toBe(2);
    const gen = sim.state.generation;
    const effects = sim.key('back');
    expect(effects).toEqual([
      { type: 'load', generation: gen + 1, path: 'Projects', page: 0, expected: null },
    ]);
    expect(sim.state.path).toBe('Projects');
    expect(sim.state.generation).toBe(gen + 1);
    expect(sim.state.cursor).toBe(0);
    expect(sim.state.view).toMatchObject({ path: 'Projects', snapshot: null, loading: 0 });
    expect(sim.state.view?.pages.size).toBe(0);
    expect(sim.state.stats.foldersOpened).toBe(2);
    sim.settle();
    expect(rowCount(sim.state)).toBe(6);
    expect(sim.state.cursor).toBe(0);
  });

  it('Back drops the pages of the folder we left', () => {
    const sim = new Sim();
    sim.open('INBOX');
    sim.key('back');
    sim.enter('INBOX');
    expect(sim.state.view?.pages.size).toBe(0);
    expect(sim.state.view?.snapshot).toBeNull();
  });

  it('an empty folder has no rows; the cursor stays 0', () => {
    const sim = new Sim();
    sim.open('Empty');
    expect(sim.state.view?.snapshot).toEqual(snap('Empty', 0));
    expect(rowCount(sim.state)).toBe(0);
    sim.key('down');
    sim.key('pagedown');
    expect(sim.state.cursor).toBe(0);
  });
});

// --- loads ----------------------------------------------------------------------------------

describe('loads', () => {
  it('first page: snapshot, rows, loading cleared, no further load when nothing else is visible', () => {
    const sim = new Sim();
    const load = loadIn(sim.enter('INBOX'));
    if (load === undefined) throw new Error('no load');
    const effects = sim.dispatch(respond(sim.world, load));
    expect(effects).toEqual([]);
    expect(sim.state.view?.snapshot).toEqual(snap('INBOX', 450));
    expect(loadedPages(sim.state)).toEqual([0]);
    expect(sim.state.view?.loading ?? null).toBeNull();
    expect(sim.state.stats.mailsLoaded).toBe(200);
    expect(rowCount(sim.state)).toBe(450);
  });

  it('one load in flight at a time; the next one after it arrives, expected = snapshot', () => {
    const sim = new Sim();
    sim.open('Big');
    const first = sim.pressUntilLoad('pagedown');
    expect(first).toEqual({
      type: 'load',
      generation: 1,
      path: 'Big',
      page: 1,
      expected: snap('Big', 2000),
    });
    expect(sim.state.view?.loading).toBe(1);
    const loadsBefore = sim.loads.length;
    sim.pressUntil('pagedown', () => cursorPage(sim.state) === 2);
    expect(sim.loads.length).toBe(loadsBefore);
    const effects = sim.dispatch(respond(sim.world, first));
    expect(effects).toEqual([
      { type: 'load', generation: 1, path: 'Big', page: 2, expected: snap('Big', 2000) },
    ]);
  });

  it("visible pages are requested cursor's page first, then the others ascending", () => {
    const sim = new Sim({ screen: { rows: 250, cols: 80 } }); // body height 247
    sim.enter('Big');
    sim.dispatch(respond(sim.world, sim.load()));
    const page1 = sim.load();
    expect(page1.page).toBe(1);
    sim.key('pagedown', 4);
    expect(cursorPage(sim.state)).toBe(4);
    expect(visiblePages(sim.state)).toContain(4);
    sim.dispatch(respond(sim.world, page1));
    expect(sim.load().page).toBe(4);
    // Then every other visible page, ascending, until all visible pages are loaded.
    for (;;) {
      sim.dispatch(respond(sim.world, sim.load()));
      const next = loadIn(sim.effects);
      if (next === undefined) break;
      const missing = visiblePages(sim.state).filter((p) => !loadedPages(sim.state).includes(p));
      expect(next.page).toBe(missing[0]);
      expect(next.expected).toEqual(snap('Big', 2000));
    }
    for (const p of visiblePages(sim.state)) expect(loadedPages(sim.state)).toContain(p);
  });

  it('a tall screen loads every visible page in order; visible pages are never evicted', () => {
    const sim = new Sim({ screen: { rows: 1500, cols: 80 } }); // body height 1497 → pages 0–7
    sim.open('Big');
    expect(sim.loads.map((l) => l.page)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(loadedPages(sim.state)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(sim.state.stats.mailsLoaded).toBe(1600);
  });

  it(`keeps at most ${MAX_PAGES} pages, evicting the one farthest from the cursor`, () => {
    expect(MAX_PAGES).toBe(5);
    const sim = new Sim();
    sim.open('Big');
    sim.pressUntil(
      'pagedown',
      () => {
        expect(loadedPages(sim.state).length).toBeLessThanOrEqual(MAX_PAGES);
        const p = cursorPage(sim.state);
        if (p !== null) expect(loadedPages(sim.state)).toContain(p);
        return p === 6;
      },
      true,
    );
    expect(loadedPages(sim.state)).toEqual([2, 3, 4, 5, 6]);

    // Scrolling back reloads the evicted pages (expected = snapshot) and evicts the far end.
    const before = sim.loads.length;
    sim.pressUntil(
      'pageup',
      () => {
        expect(loadedPages(sim.state).length).toBeLessThanOrEqual(MAX_PAGES);
        return sim.state.cursor === 0;
      },
      true,
    );
    const reloaded = sim.loads.slice(before);
    expect(reloaded.map((l) => l.page)).toEqual([1, 0]);
    for (const l of reloaded) expect(l.expected).toEqual(snap('Big', 2000));
    expect(loadedPages(sim.state)).toEqual([0, 1, 2, 3, 4]);
  });

  it('stale page-loaded (old generation or other path) is ignored', () => {
    const sim = new Sim();
    const load = loadIn(sim.enter('INBOX'));
    if (load === undefined) throw new Error('no load');
    const stale = respond(sim.world, load);
    if (stale.type !== 'page-loaded') throw new Error('unreachable');

    const before = sim.state;
    expect(sim.dispatch({ ...stale, generation: load.generation - 1 })).toEqual([]);
    expect(sim.state).toEqual(before);
    expect(sim.dispatch({ ...stale, path: 'Big' })).toEqual([]);
    expect(sim.state).toEqual(before);

    // After Back the old answer is stale too.
    sim.key('back');
    const atRoot = sim.state;
    expect(sim.dispatch(stale)).toEqual([]);
    expect(sim.state).toEqual(atRoot);
    expect(sim.state.view).toBeNull();
  });

  it('stale load-failed is ignored', () => {
    const sim = new Sim();
    const load = loadIn(sim.enter('INBOX'));
    if (load === undefined) throw new Error('no load');
    const before = sim.state;
    for (const action of [
      { generation: load.generation + 5, path: 'INBOX' },
      { generation: load.generation, path: 'Big' },
    ]) {
      expect(
        sim.dispatch({ type: 'load-failed', page: 0, code: 'folder-unavailable', ...action }),
      ).toEqual([]);
      expect(sim.state).toEqual(before);
      expect(
        sim.dispatch({ type: 'load-failed', page: 0, code: 'connection-lost', ...action }),
      ).toEqual([]);
      expect(sim.state).toEqual(before);
    }
  });

  it('stats count opened folders and loaded mails', () => {
    const sim = new Sim();
    sim.open('INBOX');
    sim.key('back');
    sim.open('Projects');
    sim.open('Projects/Alpha');
    sim.key('back');
    sim.settle();
    expect(sim.state.stats).toEqual({
      foldersOpened: 3,
      mailsLoaded: 200 + 5 + 3 + 5,
      reconnects: 0,
    });
  });
});

// --- marks ----------------------------------------------------------------------------------

describe('marks', () => {
  it('Space toggles the mail under the cursor', () => {
    const sim = new Sim();
    sim.open('INBOX');
    sim.key('space');
    expect(marksOf(sim.state.basket)).toEqual([
      { path: 'INBOX', uidValidity: '7', uid: 1450, bytes: 450 },
    ]);
    sim.key('down');
    sim.key('space');
    expect(isMarked(sim.state.basket, { path: 'INBOX', uidValidity: '7', uid: 1449 })).toBe(true);
    expect(sim.state.basket.marks.size).toBe(2);
    sim.key('space');
    expect(isMarked(sim.state.basket, { path: 'INBOX', uidValidity: '7', uid: 1449 })).toBe(false);
    expect(sim.state.basket.marks.size).toBe(1);
  });

  it('Space on a folder row → only-mails hint; the next key clears it', () => {
    const sim = new Sim();
    sim.open('Projects');
    expect(rowAt(sim.state, 0)).toMatchObject({ kind: 'folder' });
    sim.key('space');
    expect(sim.state.message).toEqual({ code: 'only-mails' });
    expect(sim.state.basket.marks.size).toBe(0);
    sim.key('down');
    expect(sim.state.message).toBeNull();
  });

  it('Space at the root (folder rows) → only-mails', () => {
    const sim = new Sim();
    sim.key('space');
    expect(sim.state.message).toEqual({ code: 'only-mails' });
    expect(sim.state.basket.marks.size).toBe(0);
  });

  it('Space on a loading / pending / failed / unreadable row does nothing', () => {
    const sim = new Sim();
    sim.open('Big');
    const load = sim.pressUntilLoad('pagedown');
    expect(rowAt(sim.state, sim.state.cursor)).toMatchObject({ status: 'loading' });
    sim.key('space');
    expect(sim.state.basket.marks.size).toBe(0);

    sim.dispatch({
      type: 'load-failed',
      generation: load.generation,
      path: 'Big',
      page: load.page,
      code: 'folder-unavailable',
    });
    expect(rowAt(sim.state, sim.state.cursor)).toMatchObject({ status: 'failed' });
    sim.key('space');
    expect(sim.state.basket.marks.size).toBe(0);
    expect(sim.state.message).toBeNull();

    const sim2 = new Sim();
    const l2 = loadIn(sim2.enter('Projects'));
    if (l2 === undefined) throw new Error('no load');
    sim2.dispatch({
      type: 'page-loaded',
      generation: l2.generation,
      path: 'Projects',
      page: 0,
      result: { kind: 'page', snapshot: snap('Projects', 5), page: 0, rows: [] },
    });
    sim2.key('down');
    expect(rowAt(sim2.state, sim2.state.cursor)).toMatchObject({ status: 'unreadable' });
    sim2.key('space');
    expect(sim2.state.basket.marks.size).toBe(0);
  });

  it('`a` marks every loaded mail on screen, again unmarks them', () => {
    const sim = new Sim();
    sim.open('INBOX');
    sim.key('mark-screen');
    expect(sim.state.basket.marks.size).toBe(21);
    for (let seq = 450; seq > 429; seq--) {
      expect(isMarked(sim.state.basket, { path: 'INBOX', uidValidity: '7', uid: 1000 + seq })).toBe(
        true,
      );
    }
    sim.key('mark-screen');
    expect(sim.state.basket.marks.size).toBe(0);
  });

  it('`a` with some already marked marks all of them', () => {
    const sim = new Sim();
    sim.open('INBOX');
    sim.key('space');
    sim.key('down', 2);
    sim.key('space');
    sim.key('mark-screen');
    expect(sim.state.basket.marks.size).toBe(21);
  });

  it('`a` skips folder rows and unloaded rows', () => {
    const sim = new Sim();
    sim.open('Projects');
    sim.key('mark-screen');
    expect(sim.state.basket.marks.size).toBe(5);

    const big = new Sim();
    big.open('Big');
    big.pressUntilLoad('down');
    const loadedOnScreen = visibleRows(big.state).filter((i) => {
      const row = rowAt(big.state, i);
      return row?.kind === 'mail' && row.status === 'loaded';
    }).length;
    expect(loadedOnScreen).toBeGreaterThan(0);
    expect(loadedOnScreen).toBeLessThan(21);
    big.key('mark-screen');
    expect(big.state.basket.marks.size).toBe(loadedOnScreen);
  });

  it('`a` with no loaded mails on screen does nothing', () => {
    const sim = new Sim();
    const before = sim.state;
    sim.key('mark-screen');
    expect(sim.state).toEqual(before);
  });

  it('first open reconciles the basket: marks of another UIDVALIDITY are dropped with a message', () => {
    const world = defaultWorld();
    world.set('INBOX', { exists: 450, uidValidity: '6' });
    const sim = new Sim({ world });
    sim.open('INBOX');
    sim.key('space');
    sim.key('down');
    sim.key('space');
    sim.key('down');
    sim.key('space');
    sim.key('back');
    sim.open('Projects');
    sim.key('down');
    sim.key('space');
    sim.key('back');
    expect(sim.state.basket.marks.size).toBe(4);

    world.set('INBOX', { exists: 450, uidValidity: '7' });
    sim.open('INBOX');
    expect(sim.state.message).toEqual({ code: 'marks-cleared', count: 3 });
    expect(marksOf(sim.state.basket)).toEqual([
      { path: 'Projects', uidValidity: '7', uid: 1005, bytes: 5 },
    ]);
  });

  it('reopening with the same UIDVALIDITY keeps the marks, no message', () => {
    const sim = new Sim();
    sim.open('INBOX');
    sim.key('space');
    sim.key('back');
    sim.open('INBOX');
    expect(sim.state.message).toBeNull();
    expect(sim.state.basket.marks.size).toBe(1);
  });

  it('a basket pre-filled for another UIDVALIDITY is reconciled on the first page', () => {
    const sim = new Sim();
    sim.state = {
      ...sim.state,
      basket: setMarks(
        emptyBasket,
        [
          { path: 'INBOX', uidValidity: '5', uid: 1, bytes: 1 },
          { path: 'INBOX', uidValidity: '5', uid: 2, bytes: null },
          { path: 'Big', uidValidity: '5', uid: 3, bytes: 3 },
        ],
        true,
      ),
    };
    sim.open('INBOX');
    expect(sim.state.message).toEqual({ code: 'marks-cleared', count: 2 });
    expect(marksOf(sim.state.basket).map((m) => m.path)).toEqual(['Big']);
  });
});

// --- folder changed -------------------------------------------------------------------------

describe('changed result', () => {
  function bigWithPage1Pending(): { sim: Sim; load: LoadEffect } {
    const sim = new Sim();
    sim.open('Big');
    sim.key('down', 2);
    sim.key('space');
    sim.key('down');
    sim.key('space');
    const load = sim.pressUntilLoad('pagedown');
    expect(load.expected).toEqual(snap('Big', 2000));
    return { sim, load };
  }

  it('new mail: pages dropped, folder-changed, cursor on the first mail, reload page 0', () => {
    const { sim, load } = bigWithPage1Pending();
    const gen = sim.state.generation;
    sim.world.set('Big', { exists: 2001, uidValidity: '7' });
    const effects = sim.dispatch(respond(sim.world, load));
    expect(effects).toEqual([
      { type: 'load', generation: gen, path: 'Big', page: 0, expected: snap('Big', 2001) },
    ]);
    expect(sim.state.view?.snapshot).toEqual(snap('Big', 2001));
    expect(sim.state.view?.pages.size).toBe(0);
    expect(sim.state.view?.failed.size).toBe(0);
    expect(sim.state.cursor).toBe(1);
    expect(sim.state.message).toEqual({ code: 'folder-changed' });
    expect(sim.state.basket.marks.size).toBe(2);
    expect(sim.state.generation).toBe(gen);
    sim.settle();
    expect(rowAt(sim.state, 1)).toMatchObject({ seq: 2001, status: 'loaded' });
  });

  it('new UIDVALIDITY: marks of the folder cleared with a count', () => {
    const { sim, load } = bigWithPage1Pending();
    sim.world.set('Big', { exists: 2000, uidValidity: '8' });
    const effects = sim.dispatch(respond(sim.world, load));
    expect(loadIn(effects)).toMatchObject({ page: 0, expected: snap('Big', 2000, '8') });
    expect(sim.state.message).toEqual({ code: 'marks-cleared', count: 2 });
    expect(sim.state.basket.marks.size).toBe(0);
  });

  it('a folder emptied → cursor on the last row (the subfolder)', () => {
    const { sim, load } = bigWithPage1Pending();
    sim.world.set('Big', { exists: 0, uidValidity: '7' });
    sim.dispatch(respond(sim.world, load));
    expect(rowCount(sim.state)).toBe(1);
    expect(sim.state.cursor).toBe(0);
  });

  it('failed pages are dropped too', () => {
    const sim = new Sim();
    sim.open('Big');
    const l1 = sim.pressUntilLoad('pagedown');
    sim.dispatch({
      type: 'load-failed',
      generation: l1.generation,
      path: 'Big',
      page: 1,
      code: 'folder-unavailable',
    });
    expect(sim.state.view?.failed.has(1)).toBe(true);
    const l2 = sim.pressUntilLoad('pagedown');
    sim.world.set('Big', { exists: 2002, uidValidity: '7' });
    sim.dispatch(respond(sim.world, l2));
    expect(sim.state.view?.failed.size).toBe(0);
  });
});

// --- load failures ----------------------------------------------------------------------------

describe('load-failed', () => {
  it('fresh open of a top-level folder fails → back to the root, folder-unavailable', () => {
    const sim = new Sim();
    const load = loadIn(sim.enter('Big'));
    if (load === undefined) throw new Error('no load');
    const effects = sim.dispatch({
      type: 'load-failed',
      generation: load.generation,
      path: 'Big',
      page: 0,
      code: 'folder-unavailable',
    });
    expect(effects).toEqual([]);
    expect(sim.state.path).toBeNull();
    expect(sim.state.view).toBeNull();
    expect(sim.state.cursor).toBe(2);
    expect(sim.state.generation).toBe(load.generation + 1);
    expect(sim.state.message).toEqual({ code: 'folder-unavailable' });
  });

  it('fresh open of a subfolder fails → its selectable parent is reopened', () => {
    const sim = new Sim();
    sim.open('Projects');
    const load = loadIn(sim.enter('Projects/Alpha'));
    if (load === undefined) throw new Error('no load');
    const effects = sim.dispatch({
      type: 'load-failed',
      generation: load.generation,
      path: 'Projects/Alpha',
      page: 0,
      code: 'list-failed',
    });
    expect(effects).toEqual([
      { type: 'load', generation: load.generation + 1, path: 'Projects', page: 0, expected: null },
    ]);
    expect(sim.state.path).toBe('Projects');
    expect(sim.state.cursor).toBe(0);
    expect(sim.state.message).toEqual({ code: 'folder-unavailable' });
    expect(sim.state.stats.foldersOpened).toBe(2);
  });

  it('a later page fails → failed, page-failed, never requested again', () => {
    const sim = new Sim();
    sim.open('Big');
    const load = sim.pressUntilLoad('pagedown');
    const effects = sim.dispatch({
      type: 'load-failed',
      generation: load.generation,
      path: 'Big',
      page: 1,
      code: 'folder-unavailable',
    });
    expect(loadIn(effects)?.page).not.toBe(1);
    expect(sim.state.path).toBe('Big');
    expect([...(sim.state.view?.failed ?? [])]).toEqual([1]);
    expect(sim.state.view?.loading ?? null).toBeNull();
    expect(sim.state.message).toEqual({ code: 'page-failed' });
    expect(rowAt(sim.state, sim.state.cursor)).toMatchObject({ status: 'failed', page: 1 });

    const before = sim.loads.length;
    sim.key('down', 5);
    sim.key('up', 30);
    sim.key('down', 30);
    expect(sim.loads.slice(before).filter((l) => l.page === 1)).toEqual([]);

    // Other pages still load.
    const next = sim.pressUntilLoad('pagedown');
    expect(next.page).toBe(2);
  });

  it('page 0 failing while the view has a snapshot → page-failed, stays in the folder', () => {
    const sim = new Sim();
    sim.open('Big');
    const l1 = sim.pressUntilLoad('pagedown');
    sim.world.set('Big', { exists: 2001, uidValidity: '7' });
    const reload = loadIn(sim.dispatch(respond(sim.world, l1)));
    if (reload === undefined) throw new Error('no reload');
    expect(reload.page).toBe(0);
    sim.dispatch({
      type: 'load-failed',
      generation: reload.generation,
      path: 'Big',
      page: 0,
      code: 'folder-unavailable',
    });
    expect(sim.state.path).toBe('Big');
    expect(sim.state.view?.failed.has(0)).toBe(true);
    expect(sim.state.message).toEqual({ code: 'page-failed' });
  });
});

// --- connection lost / reconnect --------------------------------------------------------------

describe('reconnect', () => {
  function lost(): { sim: Sim; load: LoadEffect } {
    const sim = new Sim();
    sim.open('Big');
    const load = sim.pressUntilLoad('pagedown');
    const effects = sim.dispatch({
      type: 'load-failed',
      generation: load.generation,
      path: 'Big',
      page: load.page,
      code: 'connection-lost',
    });
    expect(effects).toEqual([]);
    expect(sim.state.mode).toBe('reconnect-ask');
    expect(sim.state.view?.loading ?? null).toBeNull();
    return { sim, load };
  }

  it('y → reconnecting + reconnect effect; keys ignored while reconnecting', () => {
    const { sim } = lost();
    expect(sim.key('yes')).toEqual([{ type: 'reconnect' }]);
    expect(sim.state.mode).toBe('reconnecting');
    for (const k of [
      'down',
      'up',
      'quit',
      'back',
      'enter',
      'space',
      'yes',
      'no',
      'reconnect',
    ] as const) {
      const before = sim.state;
      expect(sim.key(k)).toEqual([]);
      expect(sim.state).toEqual(before);
    }
  });

  it('reconnected → browse, reconnects + 1, generation + 1, load the cursor page with the snapshot', () => {
    const { sim, load } = lost();
    sim.key('yes');
    const gen = sim.state.generation;
    const effects = sim.dispatch({ type: 'reconnected' });
    expect(effects).toEqual([
      {
        type: 'load',
        generation: gen + 1,
        path: 'Big',
        page: load.page,
        expected: snap('Big', 2000),
      },
    ]);
    expect(sim.state.mode).toBe('browse');
    expect(sim.state.offline).toBe(false);
    expect(sim.state.generation).toBe(gen + 1);
    expect(sim.state.stats.reconnects).toBe(1);

    // An answer for the old generation is stale now.
    const before = sim.state;
    expect(sim.dispatch(respond(sim.world, load))).toEqual([]);
    expect(sim.state).toEqual(before);
    const fresh = loadIn(effects);
    if (fresh === undefined) throw new Error('no load');
    sim.dispatch(respond(sim.world, fresh));
    sim.settle();
    expect(cursorPage(sim.state)).toBe(load.page);
    expect(loadedPages(sim.state)).toContain(load.page);
  });

  it('reconnected clears failed pages', () => {
    const sim = new Sim();
    sim.open('Big');
    const l1 = sim.pressUntilLoad('pagedown');
    sim.dispatch({
      type: 'load-failed',
      generation: l1.generation,
      path: 'Big',
      page: 1,
      code: 'folder-unavailable',
    });
    const l2 = sim.pressUntilLoad('pagedown');
    expect(l2.page).toBe(2);
    sim.dispatch({
      type: 'load-failed',
      generation: l2.generation,
      path: 'Big',
      page: 2,
      code: 'connection-lost',
    });
    sim.key('yes');
    const effects = sim.dispatch({ type: 'reconnected' });
    expect(sim.state.view?.failed.size).toBe(0);
    expect(loadIn(effects)?.page).toBe(2);
  });

  it('N → offline browsing with a message; loaded rows stay browsable', () => {
    const { sim } = lost();
    expect(sim.key('no')).toEqual([]);
    expect(sim.state.mode).toBe('browse');
    expect(sim.state.offline).toBe(true);
    expect(sim.state.message).toEqual({ code: 'offline' });
    sim.pressUntil('pageup', () => cursorPage(sim.state) === 0);
    expect(sim.state.mode).toBe('browse');
    expect(sim.effects).toEqual([]);
    sim.key('up', 3);
    expect(sim.state.mode).toBe('browse');
    expect(loadIn(sim.effects)).toBeUndefined();
  });

  it('any other key than y also means offline', () => {
    const { sim } = lost();
    sim.key('other');
    expect(sim.state.mode).toBe('browse');
    expect(sim.state.offline).toBe(true);
  });

  it("offline: moving onto an unloaded page doesn't ask, stays offline, no effect", () => {
    const { sim } = lost();
    sim.key('no');
    sim.pressUntil('pageup', () => cursorPage(sim.state) === 0);
    const before = sim.loads.length;
    sim.pressUntil('pagedown', () => sim.state.mode !== 'browse' || cursorPage(sim.state) === 1);
    expect(sim.state.mode).toBe('browse');
    expect(sim.state.offline).toBe(true);
    expect(sim.effects).toEqual([]);
    expect(sim.loads.length).toBe(before);
    expect(rowAt(sim.state, sim.state.cursor)).toMatchObject({ kind: 'mail', status: 'pending' });
    sim.key('down', 5);
    expect(sim.state.mode).toBe('browse');
    expect(sim.loads.length).toBe(before);
  });

  it("offline: Back to a selectable parent doesn't ask", () => {
    const sim = new Sim();
    sim.open('Projects');
    const load = loadIn(sim.enter('Projects/Alpha'));
    if (load === undefined) throw new Error('no load');
    sim.dispatch({
      type: 'load-failed',
      generation: load.generation,
      path: 'Projects/Alpha',
      page: 0,
      code: 'connection-lost',
    });
    sim.key('no');
    expect(sim.state.offline).toBe(true);
    const before = sim.loads.length;
    expect(sim.key('back')).toEqual([]);
    expect(sim.state.path).toBe('Projects');
    expect(sim.state.view?.snapshot ?? null).toBeNull();
    expect(sim.state.mode).toBe('browse');
    expect(sim.state.offline).toBe(true);
    expect(sim.loads.length).toBe(before);
    expect(rowAt(sim.state, sim.state.cursor)).toMatchObject({ kind: 'folder' });
  });

  it('offline: opening a selectable folder asks again; a \\Noselect one just opens', () => {
    const { sim } = lost();
    sim.key('no');
    sim.key('back');
    expect(sim.state.path).toBeNull();
    expect(sim.state.mode).toBe('browse');
    sim.enter('Archive');
    expect(sim.state.mode).toBe('browse');
    expect(sim.state.path).toBe('Archive');
    sim.key('back');
    const before = sim.loads.length;
    sim.enter('INBOX');
    expect(sim.state.mode).toBe('reconnect-ask');
    expect(sim.loads.length).toBe(before);
  });

  it('reconnect-failed → browse, offline, text message', () => {
    const { sim } = lost();
    sim.key('yes');
    expect(sim.dispatch({ type: 'reconnect-failed', text: 'Could not reconnect.' })).toEqual([]);
    expect(sim.state.mode).toBe('browse');
    expect(sim.state.offline).toBe(true);
    expect(sim.state.message).toEqual({ code: 'text', text: 'Could not reconnect.' });
  });

  it('reconnected with the cursor on a folder row → load page 0', () => {
    const { sim } = lost();
    sim.key('no');
    sim.pressUntil('pageup', () => sim.state.cursor === 0);
    expect(rowAt(sim.state, 0)).toMatchObject({ kind: 'folder' });
    const effects = sim.dispatch({ type: 'reconnected' });
    expect(effects).toEqual([
      {
        type: 'load',
        generation: sim.state.generation,
        path: 'Big',
        page: 0,
        expected: snap('Big', 2000),
      },
    ]);
    expect(sim.state.offline).toBe(false);
  });

  it('reconnected at the root → no load', () => {
    const { sim } = lost();
    sim.key('no');
    sim.key('back');
    const gen = sim.state.generation;
    expect(sim.dispatch({ type: 'reconnected' })).toEqual([]);
    expect(sim.state.mode).toBe('browse');
    expect(sim.state.offline).toBe(false);
    expect(sim.state.stats.reconnects).toBe(1);
    expect(sim.state.generation).toBe(gen + 1);
  });

  it('y clears the message', () => {
    const { sim } = lost();
    sim.dispatch({ type: 'notice', text: 'Something' });
    expect(sim.state.mode).toBe('reconnect-ask');
    sim.key('yes');
    expect(sim.state.mode).toBe('reconnecting');
    expect(sim.state.message).toBeNull();
  });

  it('reconnected clears the message (e.g. the challenge notice)', () => {
    const { sim } = lost();
    sim.key('yes');
    sim.dispatch({ type: 'notice', text: 'Waiting 5 seconds.' });
    expect(sim.state.message).toEqual({ code: 'text', text: 'Waiting 5 seconds.' });
    sim.dispatch({ type: 'reconnected' });
    expect(sim.state.mode).toBe('browse');
    expect(sim.state.message).toBeNull();
  });

  it('a lost connection on the first page of a fresh open asks too', () => {
    const sim = new Sim();
    const load = loadIn(sim.enter('INBOX'));
    if (load === undefined) throw new Error('no load');
    sim.dispatch({
      type: 'load-failed',
      generation: load.generation,
      path: 'INBOX',
      page: 0,
      code: 'connection-lost',
    });
    expect(sim.state.mode).toBe('reconnect-ask');
    expect(sim.state.path).toBe('INBOX');
    sim.key('yes');
    const effects = sim.dispatch({ type: 'reconnected' });
    expect(effects).toEqual([
      { type: 'load', generation: sim.state.generation, path: 'INBOX', page: 0, expected: null },
    ]);
  });
});

describe('r (reconnect key)', () => {
  function offline(): Sim {
    const sim = new Sim();
    sim.open('Big');
    const load = sim.pressUntilLoad('pagedown');
    sim.dispatch({
      type: 'load-failed',
      generation: load.generation,
      path: 'Big',
      page: load.page,
      code: 'connection-lost',
    });
    sim.key('no');
    expect(sim.state.offline).toBe(true);
    expect(sim.state.message).toEqual({ code: 'offline' });
    return sim;
  }

  it('offline → reconnecting + reconnect effect, no question, message cleared', () => {
    const sim = offline();
    expect(sim.key('reconnect')).toEqual([{ type: 'reconnect' }]);
    expect(sim.state.mode).toBe('reconnecting');
    expect(sim.state.message).toBeNull();
  });

  it('offline after a failed reconnect → r tries again', () => {
    const sim = offline();
    sim.key('reconnect');
    sim.dispatch({ type: 'reconnect-failed', text: 'No luck.' });
    expect(sim.state.offline).toBe(true);
    expect(sim.key('reconnect')).toEqual([{ type: 'reconnect' }]);
    expect(sim.state.mode).toBe('reconnecting');
    expect(sim.state.message).toBeNull();
    sim.dispatch({ type: 'reconnected' });
    expect(sim.state.offline).toBe(false);
    expect(sim.state.stats.reconnects).toBe(1);
  });

  it('online → nothing', () => {
    const sim = new Sim();
    sim.open('INBOX');
    expect(sim.key('reconnect')).toEqual([]);
    expect(sim.state.mode).toBe('browse');
    expect(sim.state.offline).toBe(false);
  });

  it('offline but too small → nothing', () => {
    const sim = offline();
    sim.dispatch({ type: 'resize', screen: { rows: 5, cols: 30 } });
    const before = sim.state;
    expect(sim.key('reconnect')).toEqual([]);
    expect(sim.state).toEqual(before);
  });

  it('at the reconnect question → same as y, message cleared', () => {
    const sim = new Sim();
    sim.open('Big');
    const load = sim.pressUntilLoad('pagedown');
    sim.dispatch({
      type: 'load-failed',
      generation: load.generation,
      path: 'Big',
      page: load.page,
      code: 'connection-lost',
    });
    sim.dispatch({ type: 'notice', text: 'Something' });
    expect(sim.state.mode).toBe('reconnect-ask');
    expect(sim.key('reconnect')).toEqual([{ type: 'reconnect' }]);
    expect(sim.state.mode).toBe('reconnecting');
    expect(sim.state.message).toBeNull();
  });
});

// --- quit, resize, notice -------------------------------------------------------------------

describe('quit', () => {
  it('empty basket → quit effect', () => {
    const sim = new Sim();
    expect(sim.key('quit')).toEqual([{ type: 'quit' }]);
  });

  it('with marks → confirm; y quits', () => {
    const sim = new Sim();
    sim.open('INBOX');
    sim.key('space');
    expect(sim.key('quit')).toEqual([]);
    expect(sim.state.mode).toBe('confirm-quit');
    expect(sim.key('yes')).toEqual([{ type: 'quit' }]);
  });

  it.each<BrowserKey>(['no', 'other', 'down', 'quit', 'reconnect'])(
    'with marks → confirm; %s goes back to browsing',
    (k) => {
      const sim = new Sim();
      sim.open('INBOX');
      sim.key('space');
      sim.key('quit');
      expect(sim.key(k)).toEqual([]);
      expect(sim.state.mode).toBe('browse');
      expect(sim.state.basket.marks.size).toBe(1);
    },
  );
});

describe('resize', () => {
  it('keeps the cursor visible and loads newly visible pages', () => {
    const sim = new Sim();
    sim.open('Big');
    sim.key('down', 100);
    expect(sim.state.cursor).toBe(100);
    expect(sim.dispatch({ type: 'resize', screen: { rows: 8, cols: 60 } })).toEqual([]);
    expect(sim.state.screen).toEqual({ rows: 8, cols: 60 });
    expect(sim.state.cursor).toBe(100);
    const effects = sim.dispatch({ type: 'resize', screen: { rows: 600, cols: 120 } });
    expect(effects).toEqual([
      {
        type: 'load',
        generation: sim.state.generation,
        path: 'Big',
        page: 1,
        expected: snap('Big', 2000),
      },
    ]);
    sim.settle();
    for (const p of visiblePages(sim.state)) expect(loadedPages(sim.state)).toContain(p);
  });

  it('at the root just changes the screen', () => {
    const sim = new Sim();
    sim.key('down', 4);
    expect(sim.dispatch({ type: 'resize', screen: { rows: 4, cols: 40 } })).toEqual([]);
    expect(sim.state.cursor).toBe(4);
    expect(sim.state.scrollTop).toBe(4);
  });
});

describe('notice and messages', () => {
  it('notice → text message', () => {
    const sim = new Sim();
    expect(sim.dispatch({ type: 'notice', text: 'Hello there' })).toEqual([]);
    expect(sim.state.message).toEqual({ code: 'text', text: 'Hello there' });
  });

  it('any key in browse mode clears the message', () => {
    const sim = new Sim();
    sim.dispatch({ type: 'notice', text: 'x' });
    sim.key('other');
    expect(sim.state.message).toBeNull();
  });

  it('Enter on a folder clears the message', () => {
    const sim = new Sim();
    sim.key('space');
    expect(sim.state.message).toEqual({ code: 'only-mails' });
    sim.enter('INBOX');
    expect(sim.state.message).toBeNull();
  });
});

// --- review fixes (independent review of M2b-1) -----------------------------------------------

describe('review fixes: a folder that keeps changing', () => {
  it(`stops reloading after ${String(MAX_CHANGES)} changes in a row, with folder-busy`, () => {
    const sim = new Sim();
    sim.open('Big');
    let load = sim.pressUntilLoad('pagedown');
    for (let i = 1; i <= MAX_CHANGES; i++) {
      sim.world.set('Big', { exists: 2000 + i, uidValidity: '7' });
      const effects = sim.dispatch(respond(sim.world, load));
      if (i < MAX_CHANGES) {
        expect(sim.state.message).toEqual({ code: 'folder-changed' });
        load = sim.load();
        expect(load.page).toBe(0);
      } else {
        expect(sim.state.message).toEqual({ code: 'folder-busy' });
        expect(sim.state.view?.failed.has(0)).toBe(true);
        expect(loadIn(effects)?.page).not.toBe(0);
      }
    }
  });

  it('a page in between resets the count', () => {
    const sim = new Sim();
    sim.open('Big');
    for (let i = 1; i <= MAX_CHANGES + 1; i++) {
      const load = sim.pressUntilLoad('pagedown');
      sim.world.set('Big', { exists: 2000 + i, uidValidity: '7' });
      sim.dispatch(respond(sim.world, load));
      expect(sim.state.message).toEqual({ code: 'folder-changed' });
      sim.settle();
      expect(sim.state.view?.failed.size).toBe(0);
    }
  });
});

describe('review fixes: the quit question', () => {
  it('a lost connection keeps the quit question and goes offline', () => {
    const sim = new Sim();
    sim.open('Big');
    sim.key('down');
    sim.key('space');
    const load = sim.pressUntilLoad('pagedown');
    sim.key('quit');
    expect(sim.state.mode).toBe('confirm-quit');
    sim.dispatch({
      type: 'load-failed',
      generation: load.generation,
      path: 'Big',
      page: load.page,
      code: 'connection-lost',
    });
    expect(sim.state.mode).toBe('confirm-quit');
    expect(sim.state.offline).toBe(true);
    expect(sim.key('yes')).toEqual([{ type: 'quit' }]);
  });

  it('marks dropped by a UIDVALIDITY change end the quit question', () => {
    const sim = new Sim();
    sim.open('Big');
    sim.key('down');
    sim.key('space');
    const load = sim.pressUntilLoad('pagedown');
    sim.key('quit');
    sim.world.set('Big', { exists: 2000, uidValidity: '8' });
    sim.dispatch(respond(sim.world, load));
    expect(sim.state.basket.marks.size).toBe(0);
    expect(sim.state.mode).toBe('browse');
  });
});
