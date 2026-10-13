import { describe, it, expect } from 'vitest';
import { EMPTY_FILTER } from '../../src/core/filters/schema.js';
import type { Filter } from '../../src/core/filters/schema.js';
import { parseFilterLine } from '../../src/core/filters/line.js';
import {
  MARK_ALL_MAX,
  MAX_CHANGES,
  bodyHeight,
  childFolders,
  initialState,
  keyOf,
  listHeight,
  openEmbedded,
  reduce,
  rowAt,
  rowCount,
  sortMatches,
} from '../../src/cli/browser/state.js';
import type {
  BrowserAction,
  BrowserEffect,
  BrowserKey,
  BrowserState,
  BrowserStats,
  LineKey,
  Screen,
} from '../../src/cli/browser/state.js';
import { emptyBasket, isMarked, marksOf, setMarks } from '../../src/core/mailbox/basket.js';
import type { Basket, Mark } from '../../src/core/mailbox/basket.js';
import type { MailboxErrorCode } from '../../src/core/mailbox/errors.js';
import type { FolderInfo } from '../../src/core/mailbox/folders.js';
import type { FolderSnapshot, MessageRow } from '../../src/core/mailbox/messages.js';
import type { Match, SearchResult } from '../../src/core/mailbox/search.js';

// M3a mail list (spec): the filter line, the order and the marks of the matches. Driven only through
// openEmbedded / initialState + reduce + keyOf. The search is faked: SearchResult fixtures are built
// by hand, as the core returns them (UID descending). A state without `embedded` stays as in M2b.

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

// Root rows: INBOX (450 mails), Archive (\Noselect, one subfolder), Projects (5 mails, two subfolders).
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
  folder('Projects', { messages: 5 }),
  folder('Projects/Alpha', { messages: 3 }),
  folder('Projects/Beta', { messages: 2 }),
];

const EXISTS: Record<string, number> = {
  INBOX: 450,
  'Archive/2023': 10,
  Projects: 5,
  'Projects/Alpha': 3,
  'Projects/Beta': 2,
};

const TITLE = 'me@example-test-domain.eu';
const SCREEN: Screen = { rows: 24, cols: 100 };
const NO_STATS: BrowserStats = { foldersOpened: 0, mailsLoaded: 0, reconnects: 0 };
const PAGE = 200; // rows per page of the browser
const DAY = 86_400_000;
const JAN_1 = Date.UTC(2026, 0, 1);

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

/** The rows loadPage would return for `page` of a folder with `exists` mails (newest first). */
function pageRows(exists: number, page: number): MessageRow[] {
  const to = exists - PAGE * page;
  const rows: MessageRow[] = [];
  for (let seq = to; seq >= Math.max(1, to - PAGE + 1); seq--) rows.push(mailRow(seq));
  return rows;
}

function snap(path: string, exists?: number): FolderSnapshot {
  const count = exists ?? EXISTS[path];
  if (count === undefined) throw new Error(`no folder ${path} in the fixture`);
  return { path, uidValidity: '7', exists: count };
}

/** A match: its INTERNALDATE is `uid` days after 1 Jan 2026 (a higher UID is newer), 100 bytes. */
function hit(uid: number, over: Partial<Match> = {}): Match {
  return { uid, bytes: 100, received: JAN_1 + DAY * uid, ...over };
}

/** A SearchResult as the core builds it: bytes is the sum of the known sizes. */
function resultOf(matches: Match[], over: Partial<SearchResult> = {}): SearchResult {
  let bytes = 0;
  for (const m of matches) bytes += m.bytes ?? 0;
  return { snapshot: snap('INBOX'), matches, bytes, missing: 0, ...over };
}

/** The row loadMatches returns for a match: loaded, 100 bytes, no attachment. */
function rowOf(uid: number): MessageRow {
  return {
    seq: uid,
    uid,
    received: new Date(JAN_1 + DAY * uid),
    from: `Sender ${String(uid)}`,
    subject: `Subject ${String(uid)}`,
    bytes: 100,
    attachment: false,
  };
}

/** Newest first: 10, 20, 30 ; oldest first: 30, 20, 10 ; largest first: 20, 10, 30. */
const SIZED: Match[] = [
  hit(30, { bytes: 5, received: JAN_1 + DAY }),
  hit(20, { bytes: 50, received: JAN_1 + 2 * DAY }),
  hit(10, { bytes: 20, received: JAN_1 + 3 * DAY }),
];

function mark(path: string, uid: number, uidValidity = '7'): Mark {
  return { path, uidValidity, uid, bytes: 100 };
}

function basketOf(...marks: Mark[]): Basket {
  return setMarks(emptyBasket, marks, true);
}

/** The filter a readable line means; fails the test when the line is not readable. */
function filterOf(text: string): Filter {
  const parsed = parseFilterLine(text);
  if (!parsed.ok) throw new Error(`"${text}" should be a readable line`);
  return parsed.filter;
}

/** The UIDs of the listed matches in display order; undefined on the plain list. */
function listedUids(state: BrowserState): number[] | undefined {
  return state.view?.listing?.matches?.map((m) => m.uid);
}

// --- effects and answers --------------------------------------------------------------------

type LoadEffect = Extract<BrowserEffect, { type: 'load' }>;
type MatchesEffect = Extract<BrowserEffect, { type: 'load-matches' }>;
type SearchEffect = Extract<BrowserEffect, { type: 'search' }>;

function effectOf<T extends BrowserEffect['type']>(
  effects: readonly BrowserEffect[],
  type: T,
): Extract<BrowserEffect, { type: T }> {
  const found = effects.find((e): e is Extract<BrowserEffect, { type: T }> => e.type === type);
  if (found === undefined) throw new Error(`expected a ${type} effect`);
  return found;
}

function loadIn(effects: readonly BrowserEffect[]): LoadEffect | undefined {
  return effects.find((e): e is LoadEffect => e.type === 'load');
}

function leavesIn(effects: readonly BrowserEffect[]): BrowserEffect[] {
  return effects.filter((e) => e.type === 'leave');
}

/** A page of matches answered with `rows`. */
function pageOf(e: MatchesEffect, rows: MessageRow[]): BrowserAction {
  return {
    type: 'page-loaded',
    generation: e.generation,
    path: e.path,
    page: e.page,
    result: { kind: 'page', snapshot: e.expected, page: e.page, rows },
  };
}

/** What the page reader answers for a `load` or `load-matches` effect. */
function answerOf(e: LoadEffect | MatchesEffect): BrowserAction {
  if (e.type === 'load') {
    const snapshot = snap(e.path);
    return {
      type: 'page-loaded',
      generation: e.generation,
      path: e.path,
      page: e.page,
      result: { kind: 'page', snapshot, page: e.page, rows: pageRows(snapshot.exists, e.page) },
    };
  }
  return pageOf(e, e.uids.map(rowOf));
}

function failedAt(e: LoadEffect | MatchesEffect, code: MailboxErrorCode): BrowserAction {
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

  line(key: LineKey): BrowserEffect[] {
    return this.dispatch({ type: 'line', key });
  }

  /** Types `text` into the open line, one code point at a time. */
  type(text: string): this {
    for (const ch of [...text]) this.line({ type: 'char', text: ch });
    return this;
  }

  /** `/`, the line cleared, `text` typed and Enter: returns the search it starts (not answered). */
  search(text: string): SearchEffect {
    this.key('filter');
    this.line({ type: 'clear' });
    this.type(text);
    this.line({ type: 'enter' });
    return effectOf(this.effects, 'search');
  }

  /** Answers a search with `matches` (UID descending, as the core gives them). */
  finish(e: SearchEffect, matches: Match[], over: Partial<SearchResult> = {}): BrowserEffect[] {
    return this.dispatch({
      type: 'search-done',
      generation: e.generation,
      path: e.path,
      result: resultOf(matches, over),
    });
  }

  /** Answers the pending loads, pages and match pages alike, until none is left. */
  settle(): this {
    for (let i = 0; i < 50; i++) {
      const pending = this.effects.find(
        (e): e is LoadEffect | MatchesEffect => e.type === 'load' || e.type === 'load-matches',
      );
      if (pending === undefined) return this;
      this.dispatch(answerOf(pending));
    }
    throw new Error('settle did not finish');
  }
}

// --- the line -------------------------------------------------------------------------------

describe('the filter line', () => {
  it('/ opens the line; typed text, Backspace and Ctrl+U edit it', () => {
    const sim = new Sim('INBOX').settle();
    const view = sim.state.view;
    expect(sim.key('filter')).toEqual([]);
    expect(sim.state.mode).toBe('filter-edit');
    expect(sim.state.edit).toEqual({ line: '', error: null });
    expect(sim.state.view).toEqual(view);

    sim.type('ab');
    expect(sim.state.edit?.line).toBe('ab');
    expect(sim.effects).toEqual([]);
    expect(sim.line({ type: 'backspace' })).toEqual([]);
    expect(sim.state.edit?.line).toBe('a');
    expect(sim.line({ type: 'clear' })).toEqual([]);
    expect(sim.state.edit?.line).toBe('');
  });

  it('the line holds at most 200 code points', () => {
    const sim = new Sim('INBOX').settle();
    sim.key('filter');
    sim.type('a'.repeat(205));
    expect(sim.state.edit?.line).toBe('a'.repeat(200));
  });

  it('the line counts code points, not UTF-16 units (an emoji is one)', () => {
    const sim = new Sim('INBOX').settle();
    sim.key('filter');
    sim.type('\u{1F600}'.repeat(205));
    expect([...(sim.state.edit?.line ?? '')]).toHaveLength(200);
  });

  it('Esc cancels the edit and keeps what was shown', () => {
    // A plain list: the line goes, nothing else changes.
    const plain = new Sim('INBOX').settle();
    const plainBefore = plain.state;
    plain.key('filter');
    plain.type('ab');
    expect(plain.line({ type: 'escape' })).toEqual([]);
    expect(plain.state.mode).toBe('browse');
    expect(plain.state).not.toHaveProperty('edit');
    expect(plain.state.view).toEqual(plainBefore.view);

    // A result on screen: the edit is dropped, the result stays as it was.
    const sim = new Sim('INBOX').settle();
    sim.finish(sim.search('shop'), [hit(30), hit(20), hit(10)]);
    sim.settle();
    const before = sim.state;
    sim.key('filter');
    sim.line({ type: 'clear' });
    sim.type('news');
    expect(sim.line({ type: 'escape' })).toEqual([]);
    expect(sim.state.mode).toBe('browse');
    expect(sim.state).not.toHaveProperty('edit');
    expect(sim.state.view).toEqual(before.view);
    expect(sim.state.view?.listing?.text).toBe('shop');
  });

  it('Enter with a readable line starts one search', () => {
    const sim = new Sim('INBOX').settle();
    const generation = sim.state.generation;
    sim.search('shop');
    expect(sim.state.mode).toBe('browse');
    expect(sim.state.view?.listing).toMatchObject({ text: 'shop', order: 'newest', matches: null });
    expect(sim.state.generation).toBe(generation + 1);
    expect(sim.state.cursor).toBe(0);
    expect(sim.effects).toEqual([
      {
        type: 'search',
        generation: sim.state.generation,
        path: 'INBOX',
        filter: filterOf('shop'),
      },
    ]);
  });

  it('Enter with an unreadable line stays open with the error', () => {
    const sim = new Sim('INBOX').settle();
    sim.key('filter');
    sim.type('form:x');
    expect(sim.line({ type: 'enter' })).toEqual([]);
    expect(sim.state.mode).toBe('filter-edit');
    expect(sim.state.edit?.error).toMatchObject({ code: 'unknown-key', token: 'form:x' });
    expect(sim.state.view?.listing).toBeUndefined();

    sim.line({ type: 'char', text: 'y' });
    expect(sim.state.edit?.error).toBeNull();
  });

  it('a blank line with no filter on changes nothing; with a filter on it clears it', () => {
    const sim = new Sim('INBOX').settle();
    const view = sim.state.view;
    sim.key('filter');
    sim.line({ type: 'clear' });
    expect(sim.line({ type: 'enter' })).toEqual([]);
    expect(sim.state.mode).toBe('browse');
    expect(sim.state).not.toHaveProperty('edit');
    expect(sim.state.view).toEqual(view);

    sim.finish(sim.search('shop'), [hit(30)]);
    sim.settle();
    sim.key('filter');
    sim.line({ type: 'clear' });
    const out = sim.line({ type: 'enter' });
    expect(sim.state.view?.listing).toBeUndefined();
    expect(loadIn(out)).toMatchObject({ path: 'INBOX', page: 0 });
    expect(out.some((e) => e.type === 'search')).toBe(false);
  });

  it('Enter trims the line before it is searched', () => {
    const sim = new Sim('INBOX').settle();
    sim.search('  shop  ');
    expect(sim.state.view?.listing?.text).toBe('shop');
    expect(sim.effects).toEqual([
      { type: 'search', generation: sim.state.generation, path: 'INBOX', filter: filterOf('shop') },
    ]);
  });

  it('Enter with the same text searches again', () => {
    const sim = new Sim('INBOX').settle();
    const first = sim.search('shop');
    sim.finish(first, [hit(30)]);
    const again = sim.search('shop');
    expect(again.generation).toBe(first.generation + 1);
    expect(again.filter).toEqual(filterOf('shop'));
  });

  it('/ while a search runs opens the line with the text being searched', () => {
    const sim = new Sim('INBOX').settle();
    sim.search('shop');
    expect(sim.key('filter')).toEqual([]);
    expect(sim.state.mode).toBe('filter-edit');
    expect(sim.state.edit).toEqual({ line: 'shop', error: null });
  });

  it('a blank line with another order keeps the order and reads the folder again', () => {
    const sim = new Sim('INBOX').settle();
    sim.finish(sim.search('shop'), SIZED);
    sim.key('order');
    sim.key('filter');
    sim.line({ type: 'clear' });
    const out = sim.line({ type: 'enter' });
    expect(sim.state.view?.listing).toMatchObject({ text: '', order: 'oldest', matches: null });
    expect(out).toEqual([
      { type: 'search', generation: sim.state.generation, path: 'INBOX', filter: EMPTY_FILTER },
    ]);
  });

  it('an unreadable line over a result keeps the result as it is', () => {
    const sim = new Sim('INBOX').settle();
    sim.finish(sim.search('shop'), [hit(30), hit(20)]);
    sim.settle();
    const listing = sim.state.view?.listing;
    sim.key('filter');
    sim.line({ type: 'clear' });
    sim.type('form:x');
    expect(sim.line({ type: 'enter' })).toEqual([]);
    expect(sim.state.mode).toBe('filter-edit');
    expect(sim.state.view?.listing).toEqual(listing);
  });

  it('Esc on a line with an error closes it without a search', () => {
    const sim = new Sim('INBOX').settle();
    sim.key('filter');
    sim.type('form:x');
    sim.line({ type: 'enter' });
    expect(sim.state.edit?.error).not.toBeNull();
    expect(sim.line({ type: 'escape' })).toEqual([]);
    expect(sim.state.mode).toBe('browse');
    expect(sim.state.view?.listing).toBeUndefined();
  });

  it('Backspace and Ctrl+U on an empty line do nothing', () => {
    const sim = new Sim('INBOX').settle();
    sim.key('filter');
    expect(sim.line({ type: 'backspace' })).toEqual([]);
    expect(sim.state.edit).toEqual({ line: '', error: null });
    expect(sim.line({ type: 'clear' })).toEqual([]);
    expect(sim.state.edit).toEqual({ line: '', error: null });
  });

  it('q inside the line is the letter q; named keys do nothing while the line is open', () => {
    const sim = new Sim('INBOX').settle();
    sim.key('filter');
    expect(sim.line({ type: 'char', text: 'q' })).toEqual([]);
    expect(sim.state.edit?.line).toBe('q');
    expect(sim.key('quit')).toEqual([]);
    expect(sim.key('down')).toEqual([]);
    expect(sim.state.mode).toBe('filter-edit');
    expect(sim.state.edit?.line).toBe('q');
  });

  it('too small: in the line only Esc acts', () => {
    const sim = new Sim('INBOX').settle();
    sim.key('filter');
    sim.type('ab');
    sim.dispatch({ type: 'resize', screen: { rows: 8, cols: 39 } });
    expect(sim.line({ type: 'char', text: 'c' })).toEqual([]);
    expect(sim.state.edit?.line).toBe('ab');
    expect(sim.line({ type: 'enter' })).toEqual([]);
    expect(sim.state.mode).toBe('filter-edit');
    expect(sim.state.view?.listing).toBeUndefined();
    expect(sim.line({ type: 'escape' })).toEqual([]);
    expect(sim.state.mode).toBe('browse');
  });

  it('too small: / does nothing', () => {
    const sim = new Sim('INBOX').settle();
    sim.key('filter');
    expect(sim.state.mode).toBe('filter-edit');
    sim.line({ type: 'escape' });
    sim.dispatch({ type: 'resize', screen: { rows: 8, cols: 39 } });
    const before = sim.state;
    expect(sim.key('filter')).toEqual([]);
    expect(sim.state).toEqual(before);
  });

  it('/ and o at a \\Noselect folder do nothing', () => {
    // The same keys do open the line on a selectable folder.
    const open = new Sim('INBOX').settle();
    open.key('filter');
    expect(open.state.mode).toBe('filter-edit');

    const sim = new Sim('Archive');
    const before = sim.state;
    expect(sim.key('filter')).toEqual([]);
    expect(sim.state).toEqual(before);
    expect(sim.key('order')).toEqual([]);
    expect(sim.state).toEqual(before);
  });

  it('opening and closing the line keeps the cursor on screen', () => {
    const sim = new Sim('INBOX').settle();
    sim.key('down', bodyHeight(sim.state.screen) - 1);
    const cursor = sim.state.cursor;
    sim.key('filter');
    expect(sim.state.cursor).toBe(cursor);
    expect(sim.state.cursor - sim.state.scrollTop).toBeLessThan(listHeight(sim.state));
    sim.line({ type: 'escape' });
    expect(sim.state.cursor).toBe(cursor);
    expect(sim.state.cursor - sim.state.scrollTop).toBeLessThan(listHeight(sim.state));
  });

  it('listHeight', () => {
    const sim = new Sim('INBOX').settle();
    expect(listHeight(sim.state)).toBe(bodyHeight(sim.state.screen));
    sim.key('filter');
    expect(listHeight(sim.state)).toBe(bodyHeight(sim.state.screen) - 1);
    sim.line({ type: 'escape' });
    sim.search('shop');
    expect(listHeight(sim.state)).toBe(bodyHeight(sim.state.screen) - 1);
    sim.dispatch({ type: 'resize', screen: { rows: 4, cols: 40 } });
    expect(listHeight(sim.state)).toBeGreaterThanOrEqual(1);
    expect(listHeight(sim.state)).toBe(Math.max(1, bodyHeight(sim.state.screen) - 1));
  });
});

// --- the search -----------------------------------------------------------------------------

describe('the search', () => {
  it('a result that arrives while the line is open', () => {
    const sim = new Sim('INBOX').settle();
    const e = sim.search('shop');
    sim.key('filter');
    expect(sim.state.mode).toBe('filter-edit');
    sim.finish(e, [hit(30), hit(20), hit(10)]);
    expect(sim.state.mode).toBe('filter-edit');
    expect(listedUids(sim.state)).toEqual([30, 20, 10]);

    const failing = new Sim('INBOX').settle();
    const f = failing.search('shop');
    failing.key('filter');
    failing.dispatch({
      type: 'search-failed',
      generation: f.generation,
      path: 'INBOX',
      code: 'search-failed',
    });
    expect(failing.state.mode).toBe('filter-edit');
    expect(failing.state.view?.listing).toBeUndefined();
    expect(failing.state.message).toEqual({ code: 'search-failed' });
  });

  it('search-done shows the matches', () => {
    const sim = new Sim('INBOX').settle();
    const e = sim.search('shop');
    const out = sim.finish(e, [hit(30), hit(20), hit(10)]);
    expect(listedUids(sim.state)).toEqual([30, 20, 10]);
    expect(rowCount(sim.state)).toBe(3);
    expect(rowAt(sim.state, 0)).toMatchObject({ kind: 'mail', mail: null, status: 'loading' });
    expect(out).toEqual([
      {
        type: 'load-matches',
        generation: sim.state.generation,
        path: 'INBOX',
        page: 0,
        expected: snap('INBOX'),
        uids: [30, 20, 10],
      },
    ]);
  });

  it('subfolders are hidden under a listing', () => {
    const sim = new Sim('Projects').settle();
    expect(childFolders(sim.state).map((f) => f.path)).toEqual(['Projects/Alpha', 'Projects/Beta']);
    sim.finish(sim.search('shop'), [hit(30), hit(20), hit(10)]);
    expect(childFolders(sim.state)).toEqual([]);
    expect(rowCount(sim.state)).toBe(3);
  });

  it('page-loaded under a listing fills the rows by UID', () => {
    const sim = new Sim('INBOX').settle();
    sim.finish(sim.search('shop'), [hit(30), hit(20), hit(10)]);
    const load = effectOf(sim.effects, 'load-matches');
    const loadedBefore = sim.state.stats.mailsLoaded;
    // The mail with UID 20 is gone; the page reader answers with the snapshot of the next read.
    sim.dispatch({
      type: 'page-loaded',
      generation: load.generation,
      path: 'INBOX',
      page: 0,
      result: { kind: 'page', snapshot: snap('INBOX', 451), page: 0, rows: [rowOf(30), rowOf(10)] },
    });
    expect(rowAt(sim.state, 0)).toMatchObject({
      kind: 'mail',
      mail: { uid: 30 },
      status: 'loaded',
    });
    expect(rowAt(sim.state, 1)).toMatchObject({ kind: 'mail', status: 'unreadable' });
    expect(rowAt(sim.state, 2)).toMatchObject({
      kind: 'mail',
      mail: { uid: 10 },
      status: 'loaded',
    });
    expect(sim.state.stats.mailsLoaded).toBe(loadedBefore + 2);
    // The header keeps the folder as it was searched.
    expect(sim.state.view?.snapshot).toEqual(snap('INBOX'));
    expect(sim.state.view?.loading).toBeNull();
  });

  it('a second page is asked when the cursor reaches it', () => {
    const sim = new Sim('INBOX').settle();
    // Newest first: UID 450 down to 1; page 1 is the display rows 200..399.
    const all = Array.from({ length: 450 }, (_, i) => hit(450 - i));
    sim.finish(sim.search('shop'), all);
    sim.settle();
    const effects: BrowserEffect[] = [];
    for (let i = 0; i < 1000 && sim.state.cursor < PAGE; i++) {
      effects.push(...sim.key('pagedown'));
    }
    expect(sim.state.cursor).toBeGreaterThanOrEqual(PAGE);
    const second = effects.find(
      (e): e is MatchesEffect => e.type === 'load-matches' && e.page === 1,
    );
    expect(second?.uids).toEqual(all.slice(PAGE, 2 * PAGE).map((m) => m.uid));
  });

  it('stale results are dropped', () => {
    const sim = new Sim('INBOX').settle();
    const e = sim.search('shop');
    const before = sim.state;
    const older = e.generation - 1;
    expect(
      sim.dispatch({
        type: 'search-done',
        generation: older,
        path: 'INBOX',
        result: resultOf([hit(30)]),
      }),
    ).toEqual([]);
    expect(sim.state).toEqual(before);
    expect(
      sim.dispatch({
        type: 'search-progress',
        generation: older,
        path: 'INBOX',
        done: 1,
        total: 2,
      }),
    ).toEqual([]);
    expect(sim.state).toEqual(before);
    expect(
      sim.dispatch({
        type: 'search-failed',
        generation: older,
        path: 'INBOX',
        code: 'search-failed',
      }),
    ).toEqual([]);
    expect(sim.state).toEqual(before);
    // The current number, but another folder.
    const other = snap('Projects');
    expect(
      sim.dispatch({
        type: 'search-done',
        generation: e.generation,
        path: 'Projects',
        result: resultOf([hit(30)], { snapshot: other }),
      }),
    ).toEqual([]);
    expect(sim.state).toEqual(before);
    expect(
      sim.dispatch({
        type: 'search-failed',
        generation: e.generation,
        path: 'Projects',
        code: 'search-failed',
      }),
    ).toEqual([]);
    expect(sim.state).toEqual(before);
  });

  it('a second result for the same search, after it ended, is dropped', () => {
    const sim = new Sim('INBOX').settle();
    const e = sim.search('shop');
    sim.finish(e, [hit(30)]);
    const after = sim.state;
    expect(
      sim.dispatch({
        type: 'search-done',
        generation: e.generation,
        path: 'INBOX',
        result: resultOf([hit(20)]),
      }),
    ).toEqual([]);
    expect(sim.state).toEqual(after);
  });

  it('search-progress is kept for the renderer', () => {
    const sim = new Sim('INBOX').settle();
    const e = sim.search('shop');
    sim.dispatch({
      type: 'search-progress',
      generation: e.generation,
      path: 'INBOX',
      done: 5000,
      total: 12000,
    });
    expect(sim.state.view?.listing).toMatchObject({
      matches: null,
      progress: { done: 5000, total: 12000 },
    });
  });

  it('a result with missing candidates says so', () => {
    const sim = new Sim('INBOX').settle();
    sim.finish(sim.search('shop'), [hit(30)], { missing: 4 });
    expect(sim.state.message).toEqual({ code: 'search-partial', count: 4 });

    const full = new Sim('INBOX').settle();
    full.finish(full.search('shop'), [hit(30)]);
    expect(full.state.message).toBeNull();
  });

  it('a match without a size counts 0 bytes and is marked with bytes null', () => {
    const sim = new Sim('INBOX').settle();
    sim.finish(sim.search('shop'), [hit(30, { bytes: null }), hit(20, { bytes: 50 })]);
    expect(sim.state.view?.listing?.bytes).toBe(50);
    sim.key('mark-all');
    expect(marksOf(sim.state.basket)).toEqual(
      expect.arrayContaining([
        { path: 'INBOX', uidValidity: '7', uid: 30, bytes: null },
        { path: 'INBOX', uidValidity: '7', uid: 20, bytes: 50 },
      ]),
    );
  });

  it('the next search after a stopped one carries a new number', () => {
    const sim = new Sim('INBOX').settle();
    const first = sim.search('shop');
    expect(sim.key('back')).toContainEqual({ type: 'stop-search' });
    const second = sim.search('news');
    expect(second.generation).toBeGreaterThan(first.generation);
    // The stopped search's answer, if it still came, changes nothing.
    const before = sim.state;
    sim.dispatch({
      type: 'search-done',
      generation: first.generation,
      path: 'INBOX',
      result: resultOf([hit(30)]),
    });
    expect(sim.state).toEqual(before);
  });
});

// --- the order ------------------------------------------------------------------------------

describe('the order', () => {
  it('o on a result re-orders without a search', () => {
    const sim = new Sim('INBOX').settle();
    sim.finish(sim.search('shop'), SIZED);
    sim.settle();
    expect(listedUids(sim.state)).toEqual([10, 20, 30]);

    const before = sim.state.generation;
    const oldest = sim.key('order');
    expect(sim.state.view?.listing).toMatchObject({ order: 'oldest' });
    expect(sim.state.generation).toBe(before + 1);
    expect(sim.state.view?.pages.size).toBe(0);
    expect(oldest).toEqual([
      {
        type: 'load-matches',
        generation: sim.state.generation,
        path: 'INBOX',
        page: 0,
        expected: snap('INBOX'),
        uids: [30, 20, 10],
      },
    ]);

    const largest = sim.key('order');
    expect(sim.state.view?.listing).toMatchObject({ order: 'largest' });
    expect(sim.state.view?.pages.size).toBe(0);
    expect(largest).toEqual([
      {
        type: 'load-matches',
        generation: sim.state.generation,
        path: 'INBOX',
        page: 0,
        expected: snap('INBOX'),
        uids: [20, 10, 30],
      },
    ]);
  });

  it('o on the plain list reads the folder once', () => {
    const sim = new Sim('INBOX').settle();
    const before = sim.state.generation;
    const effects = sim.key('order');
    expect(effects).toEqual([
      { type: 'search', generation: before + 1, path: 'INBOX', filter: EMPTY_FILTER },
    ]);
    expect(sim.state.view?.listing).toMatchObject({
      text: '',
      order: 'oldest',
      matches: null,
    });
  });

  it('o back to newest without a filter returns to the plain list', () => {
    const sim = new Sim('INBOX').settle();
    sim.finish(effectOf(sim.key('order'), 'search'), SIZED);
    sim.settle();
    sim.key('order');
    expect(sim.state.view?.listing).toMatchObject({ text: '', order: 'largest' });

    const back = sim.key('order');
    expect(sim.state.view?.listing).toBeUndefined();
    expect(back.some((e) => e.type === 'search')).toBe(false);
    expect(loadIn(back)).toMatchObject({ path: 'INBOX', page: 0 });
  });

  it('o while filtering only changes the order the result will get', () => {
    const sim = new Sim('INBOX').settle();
    const e = sim.search('shop');
    expect(sim.key('order')).toEqual([]);
    expect(sim.state.view?.listing).toMatchObject({ order: 'oldest', matches: null });
    sim.finish(e, SIZED);
    expect(listedUids(sim.state)).toEqual([30, 20, 10]);
    expect(sim.effects).toEqual([
      {
        type: 'load-matches',
        generation: sim.state.generation,
        path: 'INBOX',
        page: 0,
        expected: snap('INBOX'),
        uids: [30, 20, 10],
      },
    ]);
  });

  it('Up and Down do nothing while filtering', () => {
    const sim = new Sim('INBOX').settle();
    sim.search('shop');
    const cursor = sim.state.cursor;
    expect(sim.key('down')).toEqual([]);
    expect(sim.key('up')).toEqual([]);
    expect(sim.state.cursor).toBe(cursor);
  });

  it('sortMatches', () => {
    const input: Match[] = [
      hit(1, { received: JAN_1 + 5 * DAY, bytes: 100 }),
      hit(2, { received: null, bytes: null }),
      hit(3, { received: JAN_1 + 5 * DAY, bytes: 100 }),
      hit(4, { received: JAN_1 + 9 * DAY, bytes: 900 }),
    ];
    const copy = structuredClone(input);
    const uids = (matches: readonly Match[]): number[] => matches.map((m) => m.uid);
    // Newest first: received descending, null last, ties by UID descending.
    expect(uids(sortMatches(input, 'newest'))).toEqual([4, 3, 1, 2]);
    // Oldest first: received ascending, null last, ties by UID ascending.
    expect(uids(sortMatches(input, 'oldest'))).toEqual([1, 3, 4, 2]);
    // Largest first: bytes descending, null last, ties by UID descending.
    expect(uids(sortMatches(input, 'largest'))).toEqual([4, 3, 1, 2]);
    // The input is left alone; the result is a new array.
    expect(input).toEqual(copy);
    expect(sortMatches(input, 'oldest')).not.toBe(input);
  });
});

// --- the marks ------------------------------------------------------------------------------

describe('the marks of matches', () => {
  it('m marks every match and m again unmarks them', () => {
    const sim = new Sim('INBOX').settle();
    sim.finish(sim.search('shop'), [hit(30), hit(20), hit(10)]);
    sim.key('mark-all');
    expect(marksOf(sim.state.basket)).toHaveLength(3);
    expect(marksOf(sim.state.basket)).toEqual(
      expect.arrayContaining([mark('INBOX', 30), mark('INBOX', 20), mark('INBOX', 10)]),
    );
    expect(sim.state.message).toEqual({ code: 'marked-all', count: 3 });

    sim.key('mark-all');
    expect(marksOf(sim.state.basket)).toEqual([]);
    expect(sim.state.message).toEqual({ code: 'unmarked-all', count: 3 });
  });

  it('m with some already marked marks the rest', () => {
    const sim = new Sim('INBOX', { basket: basketOf(mark('INBOX', 20)) }).settle();
    sim.finish(sim.search('shop'), [hit(30), hit(20), hit(10)]);
    sim.key('mark-all');
    for (const uid of [30, 20, 10]) {
      expect(isMarked(sim.state.basket, { path: 'INBOX', uidValidity: '7', uid })).toBe(true);
    }
    expect(marksOf(sim.state.basket)).toHaveLength(3);
    expect(sim.state.message).toEqual({ code: 'marked-all', count: 3 });
  });

  it('m above MARK_ALL_MAX marks nothing', () => {
    const sim = new Sim('INBOX').settle();
    const e = sim.search('shop');
    const many = Array.from({ length: MARK_ALL_MAX + 1 }, (_, i) => hit(MARK_ALL_MAX + 1 - i));
    const listed = reduce(sim.state, {
      type: 'search-done',
      generation: e.generation,
      path: 'INBOX',
      result: resultOf(many),
    }).state;
    const out = reduce(listed, { type: 'key', key: 'mark-all' });
    expect(out.state.message).toEqual({ code: 'too-many-to-mark', count: MARK_ALL_MAX + 1 });
    expect(out.state.basket).toEqual(listed.basket);
    expect(marksOf(out.state.basket)).toEqual([]);
  });

  it('m on the plain list only hints', () => {
    const sim = new Sim('INBOX').settle();
    const before = sim.state;
    sim.key('mark-all');
    expect(sim.state.message).toEqual({ code: 'mark-all-needs-list' });
    expect(sim.state.basket).toEqual(before.basket);
    expect(marksOf(sim.state.basket)).toEqual([]);
  });

  it('m while the search runs changes nothing', () => {
    const sim = new Sim('INBOX').settle();
    sim.search('shop');
    const before = sim.state;
    expect(sim.key('mark-all')).toEqual([]);
    expect(sim.state).toEqual(before);
  });

  it('m with no match changes nothing', () => {
    const sim = new Sim('INBOX').settle();
    sim.finish(sim.search('shop'), []);
    const before = sim.state;
    sim.key('mark-all');
    expect(sim.state).toEqual(before);
    expect(marksOf(sim.state.basket)).toEqual([]);
  });

  it('Space and a work on a filtered list', () => {
    const sim = new Sim('INBOX').settle();
    sim.finish(sim.search('shop'), [hit(30), hit(20), hit(10)]);
    const load = effectOf(sim.effects, 'load-matches');
    sim.dispatch(pageOf(load, [rowOf(30), rowOf(20), rowOf(10)]));

    sim.key('space');
    expect(marksOf(sim.state.basket).map((m) => m.uid)).toEqual([30]);

    sim.key('mark-screen');
    expect(
      marksOf(sim.state.basket)
        .map((m) => m.uid)
        .sort((a, b) => a - b),
    ).toEqual([10, 20, 30]);
  });

  it('Space on a match still loading does nothing', () => {
    const sim = new Sim('INBOX').settle();
    sim.finish(sim.search('shop'), [hit(30)]);
    const before = sim.state.basket;
    sim.key('space');
    expect(sim.state.basket).toEqual(before);
  });

  it('marks stay when the filter is cleared or changed', () => {
    const sim = new Sim('INBOX').settle();
    sim.finish(sim.search('shop'), [hit(30), hit(20), hit(10)]);
    sim.settle();
    sim.key('space');
    expect(marksOf(sim.state.basket)).toEqual([mark('INBOX', 30)]);

    sim.finish(sim.search('news'), [hit(20)]);
    expect(marksOf(sim.state.basket)).toEqual([mark('INBOX', 30)]);

    sim.key('filter');
    sim.line({ type: 'clear' });
    sim.line({ type: 'enter' });
    expect(sim.state.view?.listing).toBeUndefined();
    expect(marksOf(sim.state.basket)).toEqual([mark('INBOX', 30)]);
  });
});

// --- back and the search's ends -------------------------------------------------------------

describe('Back and the ends of a search', () => {
  it('Back with a listing returns to the plain list, not out of the folder', () => {
    const sim = new Sim('INBOX').settle();
    sim.finish(sim.search('shop'), [hit(30), hit(20), hit(10)]);
    const effects = sim.key('back');
    expect(effects).toEqual([
      { type: 'load', generation: sim.state.generation, path: 'INBOX', page: 0, expected: null },
    ]);
    expect(sim.state.view?.listing).toBeUndefined();
    expect(leavesIn(effects)).toEqual([]);
    expect(sim.key('back')).toEqual([{ type: 'leave', message: null }]);
  });

  it('Back while filtering stops the search', () => {
    const sim = new Sim('INBOX').settle();
    sim.search('shop');
    const effects = sim.key('back');
    expect(effects[0]).toEqual({ type: 'stop-search' });
    expect(leavesIn(effects)).toEqual([]);
    expect(sim.state.view?.listing).toBeUndefined();
  });

  it('a new filter while one is still searching stops the old one first', () => {
    const sim = new Sim('INBOX').settle();
    sim.search('shop');
    sim.search('news');
    expect(sim.effects).toEqual([
      { type: 'stop-search' },
      {
        type: 'search',
        generation: sim.state.generation,
        path: 'INBOX',
        filter: filterOf('news'),
      },
    ]);
  });

  it('search-failed', () => {
    // A refused search, and one with too many mails: the plain list, one load, the message.
    for (const code of ['search-failed', 'too-many-matches'] as const) {
      const sim = new Sim('INBOX').settle();
      const e = sim.search('shop');
      const effects = sim.dispatch({
        type: 'search-failed',
        generation: e.generation,
        path: 'INBOX',
        code,
      });
      expect(sim.state.view?.listing).toBeUndefined();
      expect(sim.state.message).toEqual({ code });
      expect(effects.map((x) => x.type)).toEqual(['load']);
      expect(loadIn(effects)).toMatchObject({ path: 'INBOX', page: 0 });
    }

    // A lost connection during the search: the reconnect question, no effect.
    const lost = new Sim('INBOX').settle();
    const e = lost.search('shop');
    expect(
      lost.dispatch({
        type: 'search-failed',
        generation: e.generation,
        path: 'INBOX',
        code: 'connection-lost',
      }),
    ).toEqual([]);
    expect(lost.state.view?.listing).toBeUndefined();
    expect(lost.state.mode).toBe('reconnect-ask');
  });

  it('UIDVALIDITY changed under a match page filters again', () => {
    const sim = new Sim('INBOX', { basket: basketOf(mark('INBOX', 20)) }).settle();
    sim.finish(sim.search('shop'), [hit(30), hit(20), hit(10)]);
    for (let i = 1; i <= MAX_CHANGES; i++) {
      const load = effectOf(sim.effects, 'load-matches');
      const changed: FolderSnapshot = { path: 'INBOX', uidValidity: String(7 + i), exists: 450 };
      const effects = sim.dispatch({
        type: 'page-loaded',
        generation: load.generation,
        path: 'INBOX',
        page: 0,
        result: { kind: 'changed', snapshot: changed },
      });
      if (i < MAX_CHANGES) {
        expect(sim.state.message).toEqual(
          i === 1 ? { code: 'marks-cleared', count: 1 } : { code: 'folder-changed' },
        );
        if (i === 1) expect(marksOf(sim.state.basket)).toEqual([]);
        const again = effectOf(effects, 'search');
        expect(effects.map((x) => x.type)).toEqual(['search']);
        expect(again.filter).toEqual(filterOf('shop'));
        sim.finish(again, [hit(30), hit(20), hit(10)], { snapshot: changed });
      } else {
        expect(sim.state.view?.listing).toBeUndefined();
        expect(sim.state.message).toEqual({ code: 'folder-busy' });
      }
    }
  });

  it("reconnected with a result reads the cursor's page by UID", () => {
    // A page of matches cut by a lost connection: the page under the cursor is read again by UID.
    const sim = new Sim('INBOX').settle();
    sim.finish(sim.search('shop'), [hit(30), hit(20), hit(10)]);
    const load = effectOf(sim.effects, 'load-matches');
    sim.dispatch(failedAt(load, 'connection-lost'));
    expect(sim.state.mode).toBe('reconnect-ask');
    expect(sim.key('yes')).toEqual([{ type: 'reconnect' }]);
    const after = sim.dispatch({ type: 'reconnected' });
    expect(effectOf(after, 'load-matches')).toMatchObject({ page: 0, uids: [30, 20, 10] });

    // A search cut by the lost connection: the plain list is read instead.
    const cut = new Sim('INBOX').settle();
    const e = cut.search('shop');
    cut.dispatch({
      type: 'search-failed',
      generation: e.generation,
      path: 'INBOX',
      code: 'connection-lost',
    });
    expect(cut.key('yes')).toEqual([{ type: 'reconnect' }]);
    const plain = cut.dispatch({ type: 'reconnected' });
    expect(cut.state.view?.listing).toBeUndefined();
    expect(loadIn(plain)).toMatchObject({ path: 'INBOX', page: 0 });
  });

  it('offline: / and o only show the offline message', () => {
    const sim = new Sim('INBOX');
    sim.dispatch(failedAt(effectOf(sim.effects, 'load'), 'connection-lost'));
    sim.key('no');
    expect(sim.state.offline).toBe(true);

    expect(sim.key('filter')).toEqual([]);
    expect(sim.state.mode).toBe('browse');
    expect(sim.state.message).toEqual({ code: 'offline' });
    expect(sim.state.view?.listing).toBeUndefined();

    sim.dispatch({ type: 'key', key: 'order' });
    expect(sim.effects).toEqual([]);
    expect(sim.state.message).toEqual({ code: 'offline' });
    expect(sim.state.view?.listing).toBeUndefined();
  });
});

// --- without embedded, and the keys --------------------------------------------------------

describe('the stand-alone browser', () => {
  it('the new keys do nothing without embedded', () => {
    // At the root there is no folder to filter, order or mark.
    const root = initialState(TITLE, FOLDERS, SCREEN);
    for (const key of ['filter', 'order', 'mark-all'] as const) {
      expect(reduce(root, { type: 'key', key })).toEqual({ state: root, effects: [] });
    }

    let s = initialState(TITLE, FOLDERS, SCREEN);
    const index = childFolders(s).findIndex((f) => f.path === 'INBOX');
    for (let i = 0; i < index; i++) s = reduce(s, { type: 'key', key: 'down' }).state;
    const entered = reduce(s, { type: 'key', key: 'enter' });
    const inbox = reduce(entered.state, answerOf(effectOf(entered.effects, 'load'))).state;

    for (const key of ['filter', 'order', 'mark-all'] as const) {
      const out = reduce(inbox, { type: 'key', key });
      expect(out.state).toEqual(inbox);
      expect(out.effects).toEqual([]);
    }
    expect(keyOf({ name: '/', sequence: '/' })).toBe('other');
    expect(keyOf({ name: 'o', sequence: 'o' })).toBe('other');
    expect(keyOf({ name: 'm', sequence: 'm' })).toBe('other');
  });
});

// --- a lost connection while the line is open (fix round 1) --------------------------------

/** Presses `key` until it asks for a page; fails the test when none is asked. */
function pressUntilLoadIn(sim: Sim, key: BrowserKey): LoadEffect {
  for (let i = 0; i < 1000; i++) {
    const load = loadIn(sim.key(key));
    if (load !== undefined) return load;
  }
  throw new Error(`${key} never asked for a page`);
}

/** `shop` searching, `/` and a char `x`; the connection is lost: the line stays open holding `shopx`. */
function lostWhileTyping(): Sim {
  const sim = new Sim('INBOX').settle();
  const e = sim.search('shop');
  sim.key('filter');
  sim.line({ type: 'char', text: 'x' });
  sim.dispatch({
    type: 'search-failed',
    generation: e.generation,
    path: 'INBOX',
    code: 'connection-lost',
  });
  expect(sim.state.mode).toBe('filter-edit');
  expect(sim.state.offline).toBe(true);
  return sim;
}

describe('a lost connection while the line is open (fix round 1)', () => {
  it('a search cut by a lost connection while the line is open keeps the line open', () => {
    const sim = new Sim('INBOX').settle();
    const e = sim.search('shop');
    expect(e.generation).toBe(sim.state.generation);
    expect(sim.key('filter')).toEqual([]);
    expect(sim.state.edit).toEqual({ line: 'shop', error: null });
    expect(sim.line({ type: 'char', text: 'x' })).toEqual([]);

    const effects = sim.dispatch({
      type: 'search-failed',
      generation: e.generation,
      path: 'INBOX',
      code: 'connection-lost',
    });
    expect(effects).toEqual([]);
    expect(sim.state.mode).toBe('filter-edit');
    expect(sim.state.edit).toEqual({ line: 'shopx', error: null });
    expect(sim.state.offline).toBe(true);
    expect(sim.state.view?.listing).toBeUndefined();

    // Letters typed after the loss are still text of the line: none of them asks anything.
    expect(sim.line({ type: 'char', text: 'y' })).toEqual([]);
    expect(sim.line({ type: 'char', text: 'r' })).toEqual([]);
    expect(sim.state.mode).toBe('filter-edit');
    expect(sim.state.edit).toEqual({ line: 'shopxyr', error: null });
    expect(sim.effects).toEqual([]);
  });

  it('a page that fails with a lost connection while the line is open keeps the line open', () => {
    // The plain list with its first page loaded; the cursor reaches page 1, which asks for it.
    const sim = new Sim('INBOX').settle();
    const load = pressUntilLoadIn(sim, 'pagedown');
    expect(load).toMatchObject({ path: 'INBOX', page: 1 });

    expect(sim.key('filter')).toEqual([]);
    expect(sim.line({ type: 'char', text: 'a' })).toEqual([]);
    expect(sim.dispatch(failedAt(load, 'connection-lost'))).toEqual([]);
    expect(sim.state.mode).toBe('filter-edit');
    expect(sim.state.edit).toEqual({ line: 'a', error: null });
    expect(sim.state.offline).toBe(true);
  });

  it('Enter in the line while offline asks to reconnect and searches nothing', () => {
    const sim = lostWhileTyping();
    expect(sim.line({ type: 'enter' })).toEqual([]);
    expect(sim.state.mode).toBe('reconnect-ask');
    expect(sim.state).not.toHaveProperty('edit');
    expect(sim.state.view?.listing).toBeUndefined();
    expect(sim.effects).toEqual([]);

    expect(sim.key('yes')).toEqual([{ type: 'reconnect' }]);
    expect(sim.state.mode).toBe('reconnecting');
  });

  it('Esc in the line while offline closes it and stays offline', () => {
    const sim = lostWhileTyping();
    expect(sim.line({ type: 'escape' })).toEqual([]);
    expect(sim.state.mode).toBe('browse');
    expect(sim.state.offline).toBe(true);
    expect(sim.state).not.toHaveProperty('edit');
    expect(sim.effects).toEqual([]);
  });

  it('a blank line while offline, with nothing on, only closes', () => {
    const sim = lostWhileTyping();
    sim.line({ type: 'clear' });
    expect(sim.line({ type: 'enter' })).toEqual([]);
    expect(sim.state.mode).toBe('browse');
    expect(sim.state.offline).toBe(true);
    expect(sim.state).not.toHaveProperty('edit');
    expect(sim.effects).toEqual([]);
  });
});
