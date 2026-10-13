import { describe, it, expect } from 'vitest';
import { render } from '../../src/cli/browser/render.js';
import { initialState, openEmbedded, reduce } from '../../src/cli/browser/state.js';
import type {
  BrowserAction,
  BrowserEffect,
  BrowserKey,
  BrowserState,
  BrowserStats,
  Screen,
} from '../../src/cli/browser/state.js';
import { displayWidth } from '../../src/cli/browser/width.js';
import { emptyBasket, isMarked, setMarks } from '../../src/core/mailbox/basket.js';
import type { Basket } from '../../src/core/mailbox/basket.js';
import type { FolderInfo } from '../../src/core/mailbox/folders.js';
import type { FolderSnapshot, MessageRow } from '../../src/core/mailbox/messages.js';

// M2d-2 embedded browser (spec AC12, AC13, AC16, edge cases): `openEmbedded`, the `leave` effect
// at the entry folder, and the key help of an embedded state. Driven only through
// openEmbedded / initialState + reduce + render. A non-embedded state must stay exactly as M2b.

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

const FOLDERS: FolderInfo[] = [
  folder('INBOX', { messages: 3, role: 'inbox', roleSource: 'path' }),
  folder('Archive', {
    selectable: false,
    messages: null,
    unseen: null,
    bytes: null,
    sizeSource: null,
  }),
  folder('Archive/2023', { messages: 10 }),
  folder('Projects', { messages: 5 }),
  folder('Projects/Alpha', { messages: 3 }),
  folder('Projects/Alpha/Deep', { messages: 1 }),
];

const SCREEN: Screen = { rows: 24, cols: 120 };
const NO_STATS: BrowserStats = { foldersOpened: 0, mailsLoaded: 0, reconnects: 0 };

type LoadEffect = Extract<BrowserEffect, { type: 'load' }>;

function loadIn(effects: readonly BrowserEffect[]): LoadEffect | undefined {
  return effects.find((e): e is LoadEffect => e.type === 'load');
}

function mailRow(seq: number): MessageRow {
  return {
    seq,
    uid: 1000 + seq,
    received: new Date(Date.UTC(2026, 0, 1)),
    from: `Sender ${String(seq)}`,
    subject: `Subject ${String(seq)}`,
    bytes: seq,
    attachment: false,
  };
}

function snapshot(path: string, exists: number): FolderSnapshot {
  return { path, uidValidity: '7', exists };
}

function pageLoaded(e: LoadEffect, exists: number): BrowserAction {
  const rows: MessageRow[] = [];
  for (let seq = exists; seq >= 1; seq--) rows.push(mailRow(seq));
  return {
    type: 'page-loaded',
    generation: e.generation,
    path: e.path,
    page: e.page,
    result: { kind: 'page', snapshot: snapshot(e.path, exists), page: e.page, rows },
  };
}

function key(state: BrowserState, k: BrowserKey): ReturnType<typeof reduce> {
  return reduce(state, { type: 'key', key: k });
}

function embeddedAt(
  entry: string,
  basket: Basket = emptyBasket,
  stats: BrowserStats = NO_STATS,
  screen: Screen = SCREEN,
): { state: BrowserState; load: LoadEffect | undefined } {
  const r = openEmbedded('one@example.com', FOLDERS, screen, entry, basket, stats);
  return { state: r.state, load: loadIn(r.effects) };
}

/** INBOX opened embedded and its three mails loaded. */
function inboxLoaded(basket: Basket = emptyBasket): BrowserState {
  const { state, load } = embeddedAt('INBOX', basket);
  if (load === undefined) throw new Error('no load');
  return reduce(state, pageLoaded(load, 3)).state;
}

function marks(...uids: number[]): Basket {
  return setMarks(
    emptyBasket,
    uids.map((uid) => ({ path: 'INBOX', uidValidity: '7', uid, bytes: uid })),
    true,
  );
}

function lines(state: BrowserState): string[] {
  return render(state, { sizes: true, formatDate: () => '2026-01-01' }).lines;
}

// --- openEmbedded ---------------------------------------------------------------------------

describe('openEmbedded', () => {
  it('opens inside the entry folder: embedded.entry, path, one load effect for page 0 against no snapshot', () => {
    const r = openEmbedded('one@example.com', FOLDERS, SCREEN, 'INBOX', emptyBasket, NO_STATS);
    expect(r.state.embedded).toEqual({ entry: 'INBOX' });
    expect(r.state.path).toBe('INBOX');
    expect(r.state.mode).toBe('browse');
    expect(r.state.title).toBe('one@example.com');
    expect(r.state.folders).toBe(FOLDERS);
    expect(r.effects).toHaveLength(1);
    expect(r.effects[0]).toEqual({
      type: 'load',
      generation: r.state.generation,
      path: 'INBOX',
      page: 0,
      expected: null,
    });
  });

  it('a nested entry folder opens in place (path = entry, not the root)', () => {
    const { state, load } = embeddedAt('Projects/Alpha');
    expect(state.path).toBe('Projects/Alpha');
    expect(state.embedded).toEqual({ entry: 'Projects/Alpha' });
    expect(load).toMatchObject({ path: 'Projects/Alpha', page: 0, expected: null });
  });

  it('the basket is seeded: marks made earlier are still marked', () => {
    const basket = marks(1002);
    const { state } = embeddedAt('INBOX', basket);
    expect(state.basket.marks.size).toBe(1);
    expect(isMarked(state.basket, { path: 'INBOX', uidValidity: '7', uid: 1002 })).toBe(true);
  });

  it('the stats are seeded and foldersOpened counts the entry folder', () => {
    const { state } = embeddedAt('INBOX', emptyBasket, {
      foldersOpened: 2,
      mailsLoaded: 5,
      reconnects: 1,
    });
    expect(state.stats).toEqual({ foldersOpened: 3, mailsLoaded: 5, reconnects: 1 });
  });

  it('a non-selectable entry folder shows its subfolders and loads no page; it still counts as opened', () => {
    const r = openEmbedded('one@example.com', FOLDERS, SCREEN, 'Archive', emptyBasket, NO_STATS);
    expect(r.state.path).toBe('Archive');
    expect(r.state.embedded).toEqual({ entry: 'Archive' });
    expect(loadIn(r.effects)).toBeUndefined();
    expect(r.state.stats.foldersOpened).toBe(1);
    expect(lines(r.state).join('\n')).toContain('2023');
  });

  it('an entry that is not in the folder list throws a plain Error', () => {
    expect(() =>
      openEmbedded('one@example.com', FOLDERS, SCREEN, 'Nope', emptyBasket, NO_STATS),
    ).toThrow(Error);
  });

  it('initialState is untouched: it has no embedded field', () => {
    expect(initialState('x', FOLDERS, SCREEN).embedded).toBeUndefined();
  });

  it('the page that answers the load shows the mails, keyed by the load effect generation', () => {
    const state = inboxLoaded();
    expect(lines(state).join('\n')).toContain('Subject 3');
  });
});

// --- Back at the entry folder -> leave ------------------------------------------------------

describe('Back inside an embedded browser', () => {
  it('back at the entry folder asks to leave with no message and changes nothing else', () => {
    const state = inboxLoaded();
    const r = key(state, 'back');
    expect(r.effects).toEqual([{ type: 'leave', message: null }]);
    expect(r.state).toEqual(state);
  });

  it('back at a nested entry folder also leaves (it never climbs above the entry)', () => {
    const { state, load } = embeddedAt('Projects/Alpha');
    if (load === undefined) throw new Error('no load');
    const loaded = reduce(state, pageLoaded(load, 3)).state;
    const r = key(loaded, 'back');
    expect(r.effects).toEqual([{ type: 'leave', message: null }]);
    expect(r.state.path).toBe('Projects/Alpha');
  });

  it('back at a non-selectable entry folder leaves too', () => {
    const { state } = embeddedAt('Archive');
    expect(key(state, 'back').effects).toEqual([{ type: 'leave', message: null }]);
  });

  it('back in a subfolder of the entry goes to the entry folder: no leave, a load for the entry', () => {
    const { state, load } = embeddedAt('Projects');
    if (load === undefined) throw new Error('no load');
    const atProjects = reduce(state, pageLoaded(load, 0)).state;
    // The cursor starts on the first row: the subfolder Alpha.
    const entered = key(atProjects, 'enter');
    expect(entered.state.path).toBe('Projects/Alpha');
    expect(entered.state.embedded).toEqual({ entry: 'Projects' });
    const back = key(entered.state, 'back');
    expect(back.state.path).toBe('Projects');
    expect(back.effects.some((e) => e.type === 'leave')).toBe(false);
    expect(back.state.embedded).toEqual({ entry: 'Projects' });
  });

  it('two levels down: back, back, then the next back leaves', () => {
    const { state, load } = embeddedAt('Projects');
    if (load === undefined) throw new Error('no load');
    let s = reduce(state, pageLoaded(load, 0)).state;
    const first = key(s, 'enter');
    s = first.state;
    expect(s.path).toBe('Projects/Alpha');
    const second = loadIn(first.effects);
    if (second === undefined) throw new Error('no second load');
    s = reduce(s, pageLoaded(second, 0)).state;
    s = key(s, 'enter').state;
    expect(s.path).toBe('Projects/Alpha/Deep');
    s = key(s, 'back').state;
    expect(s.path).toBe('Projects/Alpha');
    s = key(s, 'back').state;
    expect(s.path).toBe('Projects');
    expect(key(s, 'back').effects).toEqual([{ type: 'leave', message: null }]);
  });

  it('q is still the browser quit (no leave), and with marks it asks first', () => {
    const plain = inboxLoaded();
    expect(key(plain, 'quit').effects).toEqual([{ type: 'quit' }]);
    const marked = inboxLoaded(marks(1001, 1002));
    const r = key(marked, 'quit');
    expect(r.state.mode).toBe('confirm-quit');
    expect(r.effects).toEqual([]);
    expect(key(r.state, 'yes').effects).toEqual([{ type: 'quit' }]);
  });

  it('marks are kept by back at the entry (the app writes the basket back from the state)', () => {
    const state = inboxLoaded(marks(1001, 1003));
    const r = key(state, 'back');
    expect(r.state.basket.marks.size).toBe(2);
  });

  it('marking a mail in the embedded browser changes the basket the app writes back', () => {
    const state = inboxLoaded();
    const r = key(state, 'space');
    expect(r.state.basket.marks.size).toBe(1);
    expect(isMarked(r.state.basket, { path: 'INBOX', uidValidity: '7', uid: 1003 })).toBe(true);
  });
});

// --- a failed first page --------------------------------------------------------------------

describe('a first page that fails', () => {
  it('folder-unavailable at the entry folder leaves with the message', () => {
    const { state, load } = embeddedAt('INBOX');
    if (load === undefined) throw new Error('no load');
    const r = reduce(state, {
      type: 'load-failed',
      generation: load.generation,
      path: 'INBOX',
      page: 0,
      code: 'folder-unavailable',
    });
    expect(r.effects).toEqual([{ type: 'leave', message: 'folder-unavailable' }]);
  });

  it('folder-unavailable at a nested entry folder leaves too', () => {
    const { state, load } = embeddedAt('Projects/Alpha');
    if (load === undefined) throw new Error('no load');
    const r = reduce(state, {
      type: 'load-failed',
      generation: load.generation,
      path: 'Projects/Alpha',
      page: 0,
      code: 'folder-unavailable',
    });
    expect(r.effects).toEqual([{ type: 'leave', message: 'folder-unavailable' }]);
  });

  it('folder-unavailable in a subfolder goes back one level as in mm folders: no leave', () => {
    const { state, load } = embeddedAt('Projects');
    if (load === undefined) throw new Error('no load');
    const atProjects = reduce(state, pageLoaded(load, 0)).state;
    const entered = key(atProjects, 'enter');
    const inner = loadIn(entered.effects);
    if (inner === undefined) throw new Error('no inner load');
    const r = reduce(entered.state, {
      type: 'load-failed',
      generation: inner.generation,
      path: 'Projects/Alpha',
      page: 0,
      code: 'folder-unavailable',
    });
    expect(r.effects.some((e) => e.type === 'leave')).toBe(false);
    expect(r.state.path).toBe('Projects');
    expect(r.state.message).toEqual({ code: 'folder-unavailable' });
  });

  it('a lost connection at the entry folder asks to reconnect instead of leaving', () => {
    const { state, load } = embeddedAt('INBOX');
    if (load === undefined) throw new Error('no load');
    const r = reduce(state, {
      type: 'load-failed',
      generation: load.generation,
      path: 'INBOX',
      page: 0,
      code: 'connection-lost',
    });
    expect(r.effects.some((e) => e.type === 'leave')).toBe(false);
    expect(r.state.mode).toBe('reconnect-ask');
  });

  it('a failure of an older generation changes nothing and does not leave', () => {
    const { state, load } = embeddedAt('INBOX');
    if (load === undefined) throw new Error('no load');
    const r = reduce(state, {
      type: 'load-failed',
      generation: load.generation - 1,
      path: 'INBOX',
      page: 0,
      code: 'folder-unavailable',
    });
    expect(r.effects).toEqual([]);
    expect(r.state.path).toBe('INBOX');
  });
});

// --- non-embedded states stay as before -----------------------------------------------------

describe('a non-embedded browser is unchanged', () => {
  it('back at the root does nothing and never leaves', () => {
    const s = initialState('mailbox', FOLDERS, SCREEN);
    const r = key(s, 'back');
    expect(r.effects).toEqual([]);
    expect(r.state).toEqual(s);
  });

  it('back out of a first-level folder goes to the root: no leave effect', () => {
    const s = initialState('mailbox', FOLDERS, SCREEN);
    const opened = key(s, 'enter');
    expect(opened.state.path).toBe('INBOX');
    const back = key(opened.state, 'back');
    expect(back.state.path).toBeNull();
    expect(back.effects.some((e) => e.type === 'leave')).toBe(false);
  });

  it('a failed first page at a first-level folder goes back to the root with the message', () => {
    const s = initialState('mailbox', FOLDERS, SCREEN);
    const opened = key(s, 'enter');
    const load = loadIn(opened.effects);
    if (load === undefined) throw new Error('no load');
    const r = reduce(opened.state, {
      type: 'load-failed',
      generation: load.generation,
      path: 'INBOX',
      page: 0,
      code: 'folder-unavailable',
    });
    expect(r.effects).toEqual([]);
    expect(r.state.path).toBeNull();
    expect(r.state.message).toEqual({ code: 'folder-unavailable' });
  });
});

// --- AC16: the key help ---------------------------------------------------------------------

const HELP_PLAIN =
  'Up/Down move  PgUp/PgDn page  Enter open  Left back  Space mark  a mark screen  q quit  + = attachment';
const HELP_EMBEDDED =
  'Up/Down move  Enter open  Esc/Left back  / filter  o order  Space mark  a mark screen  m mark all  q quit';

function helpLine(state: BrowserState, screen: Screen = SCREEN): string {
  return lines(state)[screen.rows - 1] ?? '';
}

describe('AC16 key help', () => {
  it('an embedded state shows the M3a list with "Esc/Left back" (120 columns)', () => {
    expect(helpLine(inboxLoaded()).trimEnd()).toBe(HELP_EMBEDDED);
  });

  it('an embedded state at the root of its entry folder, before any page, shows the same help', () => {
    const { state } = embeddedAt('INBOX');
    expect(helpLine(state).trimEnd()).toBe(HELP_EMBEDDED);
  });

  it('an embedded state still shows "Esc back" at 80 columns', () => {
    const screen: Screen = { rows: 24, cols: 80 };
    const { state, load } = embeddedAt('INBOX', emptyBasket, NO_STATS, screen);
    if (load === undefined) throw new Error('no load');
    const loaded = reduce(state, pageLoaded(load, 3)).state;
    expect(helpLine(loaded, screen)).toMatch(/Esc(\/Left)? back/);
  });

  it('the embedded help never says that Esc is quit', () => {
    const help = helpLine(inboxLoaded());
    expect(help).not.toMatch(/Esc[^ ]* quit/);
    expect(help).not.toMatch(/q\/Esc/);
  });

  it('a non-embedded state shows exactly the M2b help (Left back, no Esc)', () => {
    const s = initialState('mailbox', FOLDERS, SCREEN);
    const opened = key(s, 'enter');
    const load = loadIn(opened.effects);
    if (load === undefined) throw new Error('no load');
    const loaded = reduce(opened.state, pageLoaded(load, 3)).state;
    expect(helpLine(loaded).trimEnd()).toBe(HELP_PLAIN);
    expect(helpLine(s).trimEnd()).toBe(HELP_PLAIN);
    expect(helpLine(loaded)).not.toContain('Esc');
  });

  it('only the help differs between an embedded and a non-embedded state of the same place', () => {
    const embedded = inboxLoaded();
    const plain: BrowserState = { ...embedded };
    delete plain.embedded;
    const a = lines(embedded);
    const b = lines(plain);
    expect(a).toHaveLength(b.length);
    const last = a.length - 1;
    expect(a.slice(0, last)).toEqual(b.slice(0, last));
    expect(a[last]).not.toBe(b[last]);
    expect(b[last]?.trimEnd()).toBe(HELP_PLAIN);
  });

  it('the embedded frame has exactly rows lines of cols columns at 40x8, 80x24 and 200x50', () => {
    for (const screen of [
      { rows: 8, cols: 40 },
      { rows: 24, cols: 80 },
      { rows: 50, cols: 200 },
    ]) {
      const { state, load } = embeddedAt('INBOX', marks(1001), NO_STATS, screen);
      if (load === undefined) throw new Error('no load');
      const loaded = reduce(state, pageLoaded(load, 3)).state;
      const out = lines(loaded);
      expect(out).toHaveLength(screen.rows);
      for (const line of out) expect(displayWidth(line)).toBe(screen.cols);
    }
  });
});
