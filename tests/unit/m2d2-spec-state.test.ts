import { describe, it, expect } from 'vitest';
import { asciiText, browserKeyOf, initialApp, orderedFolders } from '../../src/cli/app/state.js';
import type {
  AppAction,
  AppEffect,
  AppKey,
  AppReduced,
  AppState,
  FolderOrder,
  MailboxRow,
  MailboxView,
} from '../../src/cli/app/state.js';
import { reduceApp, startApp } from '../../src/cli/app/reduce.js';
import { accountErrorText } from '../../src/cli/account-text.js';
import type { BrowserKey, Screen } from '../../src/cli/browser/state.js';
import { AccountError } from '../../src/core/accounts.js';
import type { AuthUser } from '../../src/core/auth.js';
import { IMAP_FAILURE_REASONS, ImapSessionError } from '../../src/core/imap/errors.js';
import { isMarked } from '../../src/core/mailbox/basket.js';
import { MAILBOX_ERROR_CODES, MailboxError } from '../../src/core/mailbox/errors.js';
import type { FolderInfo, FolderTree } from '../../src/core/mailbox/folders.js';
import type { MessageRow } from '../../src/core/mailbox/messages.js';
import { LoginBlockedError } from '../../src/core/security/login-guard.js';

// M2d-2 mailbox state (spec AC1, AC5, AC7-AC9, AC12-AC15 and the edge cases): the pure reducer
// reached the way a user does - Enter on a Home mailbox row through reduceApp, then the result
// actions the controller would send. Plus the exported helpers orderedFolders, browserKeyOf and
// asciiText.

const SCREEN: Screen = { rows: 24, cols: 100 };
const SMALL: Screen = { rows: 5, cols: 30 };
const ALICE: AuthUser = { email: 'alice@example.com', userId: 'user-alice' };
const ID1 = '22222222-2222-4222-8222-222222222222';
const ID2 = '33333333-3333-4333-8333-333333333333';

// --- keys and actions -----------------------------------------------------------------------

const ch = (text: string): AppKey => ({ type: 'char', text });
const key = (type: Exclude<AppKey['type'], 'char'>): AppKey => ({ type });
const ENTER = key('enter');
const ESC = key('escape');
const LEFT = key('left');
const BACKSPACE = key('backspace');
const UP = key('up');
const DOWN = key('down');
const PGUP = key('pageup');
const PGDN = key('pagedown');
const OTHER = key('other');

function row(id: string, email: string): MailboxRow {
  return { id, email, provider: 'websupport', lastCheckedAt: null };
}
const ROW1 = row(ID1, 'one@example.com');
const ROW2 = row(ID2, 'two@example.com');

function press(state: AppState, ...keys: AppKey[]): AppReduced {
  let current = state;
  const effects: AppEffect[] = [];
  for (const k of keys) {
    const r = reduceApp(current, { type: 'key', key: k });
    current = r.state;
    effects.push(...r.effects);
  }
  return { state: current, effects };
}

function act(state: AppState, action: AppAction): AppReduced {
  return reduceApp(state, action);
}

function effectOf<T extends AppEffect['type']>(
  r: AppReduced,
  type: T,
): Extract<AppEffect, { type: T }> | undefined {
  return r.effects.find((e): e is Extract<AppEffect, { type: T }> => e.type === type);
}

function types(r: AppReduced): string[] {
  return r.effects.map((e) => e.type);
}

function mailbox(s: AppState): MailboxView {
  if (s.view.kind !== 'mailbox') throw new Error(`expected a mailbox view, got ${s.view.kind}`);
  return s.view;
}

// --- Home -> mailbox ------------------------------------------------------------------------

/** Signed-in ALICE on Home with these mailboxes (cursor on the first row). */
function home(rows: readonly MailboxRow[] = [ROW1, ROW2], screen: Screen = SCREEN): AppState {
  const s0 = startApp(initialApp('1.0.0', screen)).state;
  const s1 = act(s0, {
    type: 'session',
    generation: s0.generation,
    user: ALICE,
    remembered: [ALICE.email],
  }).state;
  const s2 = press(s1, ENTER).state;
  return act(s2, { type: 'mailboxes', generation: s2.generation, rows }).state;
}

/** Enter on a mailbox row (`downs` rows below the first). */
function opening(downs = 0, screen: Screen = SCREEN): AppReduced {
  const h = home([ROW1, ROW2], screen);
  return press(h, ...Array.from({ length: downs }, () => DOWN), ENTER);
}

function connecting(screen: Screen = SCREEN): AppState {
  return opening(0, screen).state;
}

function reading(s: AppState = connecting()): AppState {
  return act(s, { type: 'mailbox-reading', generation: s.generation }).state;
}

// --- trees ----------------------------------------------------------------------------------

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
    messages: 3,
    unseen: 1,
    bytes: 1000,
    sizeSource: 'server',
    overlapping: false,
    ...over,
  };
}

function treeOf(folders: FolderInfo[], over: Partial<FolderTree> = {}): FolderTree {
  return {
    folders,
    totals: { messages: 30, unseen: 5, bytes: 10_000, sizeSource: 'server' },
    quota: null,
    truncated: false,
    unreadable: 0,
    gmailAllHidden: false,
    fallbacks: new Set(),
    ...over,
  };
}

// Tree order: INBOX (3 mails, no subfolder), Archive (not selectable) with 2023, Projects with
// Alpha, Zeta. Sizes make size order differ from tree order.
const TREE: FolderTree = treeOf([
  folder('INBOX', { bytes: 100, role: 'inbox', roleSource: 'path' }),
  folder('Archive', { selectable: false, messages: null, unseen: null, bytes: null }),
  folder('Archive/2023', { bytes: 400 }),
  folder('Projects', { bytes: 200 }),
  folder('Projects/Alpha', { bytes: 50 }),
  folder('Zeta', { bytes: 900 }),
]);
const LAST = TREE.folders.length - 1;

function ready(tree: FolderTree = TREE, screen: Screen = SCREEN, rowsDown = 0): AppState {
  const s = reading(opening(rowsDown, screen).state);
  return act(s, { type: 'mailbox-opened', generation: s.generation, tree }).state;
}

function cursorPath(s: AppState): string | undefined {
  const v = mailbox(s);
  const tree = v.tree;
  if (tree === null) return undefined;
  return orderedFolders(tree, v.order)[v.cursor]?.path;
}

// --- the embedded browser, driven through the app -------------------------------------------

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

type LoadPage = Extract<AppEffect, { type: 'load-page' }>;

/** The page-loaded answer for a load-page effect: `exists` mails, newest first. */
function pageAnswer(load: LoadPage, exists: number): AppAction {
  const rows: MessageRow[] = [];
  for (let seq = exists; seq >= 1; seq--) rows.push(mailRow(seq));
  return {
    type: 'browser',
    browserToken: load.browserToken,
    action: {
      type: 'page-loaded',
      generation: load.browserGeneration,
      path: load.path,
      page: load.page,
      result: {
        kind: 'page',
        snapshot: { path: load.path, uidValidity: '7', exists },
        page: load.page,
        rows,
      },
    },
  };
}

function loadOf(r: AppReduced): LoadPage {
  const load = effectOf(r, 'load-page');
  if (load === undefined) throw new Error('no load-page effect');
  return load;
}

/** Enter on the first folder (INBOX) of a ready screen: the browser opens, page 0 requested. */
function openInbox(s: AppState = ready()): { state: AppState; load: LoadPage } {
  const r = press(s, ENTER);
  return { state: r.state, load: loadOf(r) };
}

/** INBOX open with its three mails shown. */
function inboxLoaded(s: AppState = ready()): { state: AppState; load: LoadPage } {
  const { state, load } = openInbox(s);
  return { state: act(state, pageAnswer(load, 3)).state, load };
}

/** The bars screen with `n` marks made in INBOX (browser left again). */
function barsWithMarks(n = 3): AppState {
  const { state } = inboxLoaded();
  const marked = n === 3 ? press(state, ch('a')).state : press(state, ch(' ')).state;
  const left = press(marked, ESC).state;
  expect(mailbox(left).mode).toBe('ready');
  return left;
}

// --- AC1: Enter on a mailbox row ------------------------------------------------------------

describe('AC1 Enter on a Home mailbox row', () => {
  it('opens the mailbox screen in "connecting" with one open-mailbox effect for that mailbox', () => {
    const before = home();
    const r = press(before, ENTER);
    const v = mailbox(r.state);
    expect(v.mode).toBe('connecting');
    expect(v.mailbox).toEqual(ROW1);
    expect(r.effects).toEqual([
      { type: 'open-mailbox', generation: r.state.generation, accountId: ID1 },
    ]);
    expect(r.state.generation).toBe(before.generation + 1);
  });

  it('the second row opens the second mailbox', () => {
    const r = opening(1);
    expect(effectOf(r, 'open-mailbox')?.accountId).toBe(ID2);
    expect(mailbox(r.state).mailbox).toEqual(ROW2);
  });

  it('the view starts clean: tree order, cursor 0, no tree, empty basket, nothing opened', () => {
    const v = mailbox(connecting());
    expect(v.order).toBe('tree');
    expect(v.cursor).toBe(0);
    expect(v.tree).toBeNull();
    expect(v.progress).toBeNull();
    expect(v.failure).toBeNull();
    expect(v.browser).toBeNull();
    expect(v.opened).toBe(false);
    expect(v.basket.marks.size).toBe(0);
    expect(v.visit).toEqual({ foldersOpened: 0, mailsLoaded: 0, reconnects: 0 });
    expect(v.message).toBeNull();
  });

  it('keeps Home as it was (list mode, mailboxes, cursor) for Left to restore', () => {
    const before = home();
    const down = press(before, DOWN).state;
    const v = mailbox(press(down, ENTER).state);
    expect(v.home.kind).toBe('home');
    expect(v.home.mode).toBe('list');
    expect(v.home.cursor).toBe(1);
    expect(v.home.mailboxes).toEqual([ROW1, ROW2]);
  });

  it('no longer answers with the "coming in a next step" message', () => {
    const v = mailbox(connecting());
    expect(v.message).toBeNull();
  });

  it('the Add row opens the add screen; the Logs row opens the logs screen', () => {
    const base = home();
    const add = press(base, DOWN, DOWN, ENTER).state;
    expect(add.view.kind).toBe('add');
    if (add.view.kind === 'add') expect(add.view.step).toBe('address');
    const logs = press(base, DOWN, DOWN, DOWN, ENTER).state;
    expect(logs.view.kind).toBe('logs');
    if (logs.view.kind === 'logs') expect(logs.view.mode).toBe('reading');
  });
});

// --- result actions -------------------------------------------------------------------------

describe('result actions', () => {
  it('mailbox-reading: connecting -> reading', () => {
    expect(mailbox(reading()).mode).toBe('reading');
  });

  it('mailbox-progress: stores the n/m progress while reading', () => {
    const s = reading();
    const progress = { folder: 2, folders: 5, done: 10, total: 100 };
    const r = act(s, { type: 'mailbox-progress', generation: s.generation, progress });
    expect(mailbox(r.state).mode).toBe('reading');
    expect(mailbox(r.state).progress).toEqual(progress);
    expect(r.effects).toEqual([]);
  });

  it('mailbox-opened: ready with the tree and the cursor on the first folder', () => {
    const v = mailbox(ready());
    expect(v.mode).toBe('ready');
    expect(v.tree).toBe(TREE);
    expect(v.cursor).toBe(0);
    expect(v.message).toBeNull();
  });

  it('mailbox-opened with a truncated tree: the "truncated" message', () => {
    const v = mailbox(ready(treeOf(TREE.folders, { truncated: true })));
    expect(v.message).toBe('truncated');
  });

  it('mailbox-failed: the failed mode with the controller text', () => {
    const s = reading();
    const r = act(s, {
      type: 'mailbox-failed',
      generation: s.generation,
      text: 'Something broke.',
    });
    const v = mailbox(r.state);
    expect(v.mode).toBe('failed');
    expect(v.failure).toBe('Something broke.');
    expect(r.effects).toEqual([]);
  });

  it('mailbox-failed also works while connecting (a failed login)', () => {
    const s = connecting();
    const r = act(s, { type: 'mailbox-failed', generation: s.generation, text: 'No login.' });
    expect(mailbox(r.state).mode).toBe('failed');
  });

  it('challenge while connecting: the "challenge" message', () => {
    const s = connecting();
    const r = act(s, { type: 'challenge', generation: s.generation });
    expect(mailbox(r.state).message).toBe('challenge');
    expect(mailbox(r.state).mode).toBe('connecting');
  });

  it('results of an older generation change nothing', () => {
    const s = connecting();
    expect(mailbox(s).mode).toBe('connecting');
    for (const action of [
      { type: 'mailbox-reading', generation: s.generation - 1 },
      {
        type: 'mailbox-progress',
        generation: s.generation - 1,
        progress: { folder: 1, folders: 2, done: 1, total: 2 },
      },
      { type: 'mailbox-opened', generation: s.generation - 1, tree: TREE },
      { type: 'mailbox-failed', generation: s.generation - 1, text: 'late' },
      { type: 'challenge', generation: s.generation - 1 },
    ] satisfies AppAction[]) {
      const r = act(s, action);
      expect(r.state).toEqual(s);
      expect(r.effects).toEqual([]);
    }
  });

  it('a result for a visit that was left (Home again) changes nothing', () => {
    const s = connecting();
    const left = press(s, ESC).state;
    expect(left.view.kind).toBe('home');
    const late = act(left, { type: 'mailbox-opened', generation: s.generation, tree: TREE });
    expect(late.state.view.kind).toBe('home');
    expect(late.effects).toEqual([]);
  });

  it('mailbox results arriving on Home (no mailbox view) are ignored', () => {
    const h = home();
    const r = act(h, { type: 'mailbox-opened', generation: h.generation, tree: TREE });
    expect(r.state).toEqual(h);
    expect(r.effects).toEqual([]);
  });

  it('browser actions arriving without a mailbox view are ignored', () => {
    const h = home();
    const r = act(h, {
      type: 'browser',
      browserToken: 1,
      action: { type: 'reconnected' },
    });
    expect(r.state).toEqual(h);
    expect(r.effects).toEqual([]);
  });
});

// --- AC7: cursor ----------------------------------------------------------------------------

describe('AC7 moving on the bars', () => {
  it('Down and Up move one row and are clamped at both ends', () => {
    let s = ready();
    s = press(s, UP).state;
    expect(mailbox(s).cursor).toBe(0);
    s = press(s, DOWN).state;
    expect(mailbox(s).cursor).toBe(1);
    s = press(s, ...Array.from({ length: 20 }, () => DOWN)).state;
    expect(mailbox(s).cursor).toBe(LAST);
    s = press(s, UP).state;
    expect(mailbox(s).cursor).toBe(LAST - 1);
  });

  it('PgDn / PgUp move by a page and are clamped', () => {
    let s = ready();
    s = press(s, PGDN).state;
    expect(mailbox(s).cursor).toBeGreaterThan(0);
    expect(mailbox(s).cursor).toBeLessThanOrEqual(LAST);
    s = press(s, PGDN, PGDN, PGDN).state;
    expect(mailbox(s).cursor).toBe(LAST);
    s = press(s, PGUP, PGUP, PGUP, PGUP).state;
    expect(mailbox(s).cursor).toBe(0);
  });

  it('a tree with no folders: keys do not crash and the cursor stays at 0', () => {
    let s = ready(treeOf([], { totals: null }));
    s = press(s, DOWN, DOWN, PGDN, UP, ch('o'), ENTER).state;
    expect(mailbox(s).cursor).toBe(0);
    expect(mailbox(s).mode).toBe('ready');
  });

  it('keys that mean nothing change nothing', () => {
    const s = ready();
    const r = press(s, OTHER, ch('x'), key('tab'), ch('r'));
    expect(r.state).toEqual(s);
    expect(r.effects).toEqual([]);
  });

  it('resize keeps the mailbox view and its cursor', () => {
    const s = press(ready(), DOWN, DOWN).state;
    const r = act(s, { type: 'resize', screen: { rows: 10, cols: 50 } });
    expect(r.state.screen).toEqual({ rows: 10, cols: 50 });
    expect(mailbox(r.state).cursor).toBe(2);
    expect(mailbox(r.state).mode).toBe('ready');
  });
});

// --- AC5: order -----------------------------------------------------------------------------

describe('AC5 order', () => {
  it('o cycles tree -> size -> name -> tree', () => {
    let s = ready();
    const seen: FolderOrder[] = [mailbox(s).order];
    for (let i = 0; i < 3; i++) {
      s = press(s, ch('o')).state;
      seen.push(mailbox(s).order);
    }
    expect(seen).toEqual(['tree', 'size', 'name', 'tree']);
  });

  it('o in either case', () => {
    expect(mailbox(press(ready(), ch('O')).state).order).toBe('size');
  });

  it('the cursor stays on the same folder (by path) in every order', () => {
    for (const downs of [0, 1, 3, LAST]) {
      let s = press(ready(), ...Array.from({ length: downs }, () => DOWN)).state;
      const focused = cursorPath(s);
      expect(focused).toBe(TREE.folders[downs]?.path);
      for (let i = 0; i < 3; i++) {
        s = press(s, ch('o')).state;
        expect(cursorPath(s)).toBe(focused);
      }
    }
  });

  it('Enter opens the focused folder of the current order, not the tree row of the same index', () => {
    // Size order: Zeta (900) first, then Archive/2023, Projects, INBOX, Alpha, Archive.
    const s = press(ready(), ch('o')).state;
    expect(cursorPath(s)).toBe('INBOX');
    const top = press(s, ...Array.from({ length: 10 }, () => UP)).state;
    expect(cursorPath(top)).toBe('Zeta');
    const r = press(top, ENTER);
    expect(mailbox(r.state).browser?.embedded?.entry).toBe('Zeta');
    expect(loadOf(r).path).toBe('Zeta');
  });

  it('o is ignored while a question is open (any other key = no)', () => {
    const asked = press(barsWithMarks(), ESC).state;
    expect(mailbox(asked).mode).toBe('confirm-leave');
    const r = press(asked, ch('o'));
    expect(mailbox(r.state).mode).toBe('ready');
    expect(mailbox(r.state).order).toBe('tree');
  });
});

describe('orderedFolders', () => {
  const ORDER_TREE = treeOf([
    folder('b-lower', { bytes: 10 }),
    folder('apple', { bytes: 30 }),
    folder('c', { bytes: null }),
    folder('Apple', { bytes: 30 }),
    folder('D', { bytes: 5 }),
  ]);
  const paths = (order: FolderOrder): string[] =>
    orderedFolders(ORDER_TREE, order).map((f) => f.path);

  it('tree: the tree list as it is', () => {
    expect(paths('tree')).toEqual(['b-lower', 'apple', 'c', 'Apple', 'D']);
  });

  it('size: largest first, unknown last, ties in tree order', () => {
    expect(paths('size')).toEqual(['apple', 'Apple', 'b-lower', 'D', 'c']);
  });

  it('name: case-insensitive path, ties in tree order', () => {
    expect(paths('name')).toEqual(['apple', 'Apple', 'b-lower', 'c', 'D']);
  });

  it('name sorts the full path, not the last segment', () => {
    const t = treeOf([folder('Z/a'), folder('Z'), folder('A/z'), folder('A')]);
    expect(orderedFolders(t, 'name').map((f) => f.path)).toEqual(['A', 'A/z', 'Z', 'Z/a']);
  });

  it('does not change the tree it was given', () => {
    const before = ORDER_TREE.folders.map((f) => f.path);
    orderedFolders(ORDER_TREE, 'size');
    orderedFolders(ORDER_TREE, 'name');
    expect(ORDER_TREE.folders.map((f) => f.path)).toEqual(before);
  });

  it('an empty tree gives an empty list', () => {
    for (const order of ['tree', 'size', 'name'] as const) {
      expect(orderedFolders(treeOf([]), order)).toEqual([]);
    }
  });
});

// --- AC8: leaving the bars ------------------------------------------------------------------

describe('AC8 leaving the bars', () => {
  it.each([
    ['Esc', ESC],
    ['Left', LEFT],
    ['Backspace', BACKSPACE],
  ])('%s without marks: back to Home as it was, one close-mailbox with no finish data', (_n, k) => {
    const s = ready();
    const homeBefore = mailbox(s).home;
    const r = press(s, k);
    expect(r.state.view).toEqual(homeBefore);
    expect(r.effects).toEqual([{ type: 'close-mailbox', finish: null }]);
    expect(r.state.generation).toBe(s.generation + 1);
  });

  it('Home comes back with the cursor it had and without reloading the list', () => {
    const base = press(home(), DOWN).state;
    const s = reading(press(base, ENTER).state);
    const open = act(s, { type: 'mailbox-opened', generation: s.generation, tree: TREE }).state;
    const r = press(open, ESC);
    expect(r.state.view.kind).toBe('home');
    if (r.state.view.kind === 'home') {
      expect(r.state.view.cursor).toBe(1);
      expect(r.state.view.mailboxes).toEqual([ROW1, ROW2]);
      expect(r.state.view.loadFailed).toBe(false);
    }
    expect(types(r)).not.toContain('load-mailboxes');
  });

  it.each([
    ['connecting', connecting],
    ['reading', () => reading()],
    [
      'failed',
      () => {
        const s = reading();
        return act(s, { type: 'mailbox-failed', generation: s.generation, text: 'x' }).state;
      },
    ],
  ])('Esc while %s goes to Home and closes the mailbox', (_n, make) => {
    const r = press(make(), ESC);
    expect(r.state.view.kind).toBe('home');
    expect(r.effects).toEqual([{ type: 'close-mailbox', finish: null }]);
  });

  it('marks: Esc asks "Drop N marks?" and stays; nothing is closed yet', () => {
    const s = barsWithMarks(3);
    const r = press(s, ESC);
    expect(mailbox(r.state).mode).toBe('confirm-leave');
    expect(r.effects).toEqual([]);
    expect(mailbox(r.state).basket.marks.size).toBe(3);
  });

  it.each([ESC, LEFT, BACKSPACE])('marks: y after %j leaves, drops the marks and closes', (k) => {
    const asked = press(barsWithMarks(3), k).state;
    const r = press(asked, ch('y'));
    expect(r.state.view.kind).toBe('home');
    const close = effectOf(r, 'close-mailbox');
    expect(close?.finish).toMatchObject({
      folders: 1,
      mails: 3,
      marked: 3,
      reconnects: 0,
    });
  });

  it('marks: Y in capitals also confirms', () => {
    const asked = press(barsWithMarks(3), ESC).state;
    expect(press(asked, ch('Y')).state.view.kind).toBe('home');
  });

  it.each([ENTER, ch('n'), ch('x'), DOWN, ESC, LEFT, OTHER])(
    'marks: any other key (%j) answers no and stays on the bars with the marks',
    (k) => {
      const asked = press(barsWithMarks(3), ESC).state;
      const r = press(asked, k);
      expect(mailbox(r.state).mode).toBe('ready');
      expect(mailbox(r.state).basket.marks.size).toBe(3);
      expect(r.effects).toEqual([]);
    },
  );

  it('the finish data of a leave with a folder opened but no marks: counts only', () => {
    const { state } = inboxLoaded();
    const bars = press(state, ESC).state;
    const r = press(bars, ESC);
    const close = effectOf(r, 'close-mailbox');
    expect(close?.finish).toMatchObject({
      folders: 1,
      mails: 3,
      marked: 0,
      bytes: 0,
      reconnects: 0,
    });
  });
});

// --- AC9: quit ------------------------------------------------------------------------------

describe('AC9 q on the bars', () => {
  it('without marks: close-mailbox, then quit', () => {
    const r = press(ready(), ch('q'));
    expect(r.effects).toEqual([{ type: 'close-mailbox', finish: null }, { type: 'quit' }]);
  });

  it('Q in capitals also quits', () => {
    expect(types(press(ready(), ch('Q')))).toEqual(['close-mailbox', 'quit']);
  });

  it('with marks: asks first, then y closes and quits', () => {
    const asked = press(barsWithMarks(3), ch('q'));
    expect(mailbox(asked.state).mode).toBe('confirm-quit');
    expect(asked.effects).toEqual([]);
    const r = press(asked.state, ch('y'));
    expect(types(r)).toEqual(['close-mailbox', 'quit']);
    expect(effectOf(r, 'close-mailbox')?.finish).toMatchObject({ marked: 3, folders: 1, mails: 3 });
  });

  it.each([ch('n'), ENTER, ESC, ch('x')])('with marks: %j answers no', (k) => {
    const asked = press(barsWithMarks(3), ch('q')).state;
    const r = press(asked, k);
    expect(mailbox(r.state).mode).toBe('ready');
    expect(r.effects).toEqual([]);
  });

  it.each([
    ['connecting', connecting],
    ['reading', () => reading()],
  ])('q while %s closes the mailbox and quits', (_n, make) => {
    expect(types(press(make(), ch('q')))).toEqual(['close-mailbox', 'quit']);
  });

  it('q on a failed screen quits too', () => {
    const s = reading();
    const failed = act(s, { type: 'mailbox-failed', generation: s.generation, text: 'x' }).state;
    expect(types(press(failed, ch('q')))).toEqual(['close-mailbox', 'quit']);
  });

  it('keys while connecting and reading that mean nothing are ignored', () => {
    for (const s of [connecting(), reading()]) {
      const r = press(s, DOWN, UP, ENTER, ch('o'), ch('r'), OTHER);
      expect(r.state).toEqual(s);
      expect(r.effects).toEqual([]);
    }
  });
});

// --- AC10: failed, retry --------------------------------------------------------------------

describe('AC10 a failed login or read', () => {
  function failed(): AppState {
    const s = reading();
    return act(s, { type: 'mailbox-failed', generation: s.generation, text: 'Try later.' }).state;
  }

  it('r runs the whole login + read again: connecting, new generation, one open-mailbox', () => {
    const f = failed();
    const r = press(f, ch('r'));
    const v = mailbox(r.state);
    expect(v.mode).toBe('connecting');
    expect(v.failure).toBeNull();
    expect(v.tree).toBeNull();
    expect(v.progress).toBeNull();
    expect(r.state.generation).toBe(f.generation + 1);
    expect(r.effects).toEqual([
      { type: 'open-mailbox', generation: r.state.generation, accountId: ID1 },
    ]);
  });

  it('R in capitals also retries', () => {
    expect(types(press(failed(), ch('R')))).toEqual(['open-mailbox']);
  });

  it('a result of the old attempt after r is dropped', () => {
    const f = failed();
    const retry = press(f, ch('r')).state;
    const late = act(retry, {
      type: 'mailbox-opened',
      generation: f.generation,
      tree: TREE,
    });
    expect(mailbox(late.state).mode).toBe('connecting');
  });

  it('a second failure after r shows the new text', () => {
    const retry = press(failed(), ch('r')).state;
    const r = act(retry, { type: 'mailbox-failed', generation: retry.generation, text: 'Again.' });
    expect(mailbox(r.state).failure).toBe('Again.');
  });

  it('r is ignored when the bars are shown', () => {
    const s = ready();
    const r = press(s, ch('r'));
    expect(r.state).toEqual(s);
    expect(r.effects).toEqual([]);
  });

  it.each([ESC, LEFT, BACKSPACE])('%j on the failed screen goes back to Home and closes', (k) => {
    const r = press(failed(), k);
    expect(r.state.view.kind).toBe('home');
    expect(r.effects).toEqual([{ type: 'close-mailbox', finish: null }]);
  });

  it('other keys on the failed screen do nothing', () => {
    const f = failed();
    const r = press(f, DOWN, ENTER, ch('o'), OTHER);
    expect(r.state).toEqual(f);
    expect(r.effects).toEqual([]);
  });
});

// --- AC11: too small ------------------------------------------------------------------------

describe('AC11 window too small', () => {
  function small(make: () => AppState): AppState {
    return act(make(), { type: 'resize', screen: SMALL }).state;
  }

  it('on the bars only q acts: moving, o, Enter, Esc, Left do nothing', () => {
    const s = small(() => ready());
    expect(mailbox(s).mode).toBe('ready');
    const r = press(s, DOWN, UP, PGDN, ch('o'), ENTER, ESC, LEFT, BACKSPACE, ch('r'));
    expect(r.state).toEqual(s);
    expect(r.effects).toEqual([]);
  });

  it('q quits from the too-small bars', () => {
    const s = small(() => ready());
    expect(types(press(s, ch('q')))).toEqual(['close-mailbox', 'quit']);
  });

  it('a pending leave question is answered by y even when too small', () => {
    const s = small(() => press(barsWithMarks(3), ESC).state);
    expect(mailbox(s).mode).toBe('confirm-leave');
    const r = press(s, ch('y'));
    expect(r.state.view.kind).toBe('home');
  });

  it('a pending quit question is answered by y even when too small', () => {
    const s = small(() => press(barsWithMarks(3), ch('q')).state);
    expect(types(press(s, ch('y')))).toEqual(['close-mailbox', 'quit']);
  });

  it('growing the window again brings the keys back', () => {
    const s = small(() => ready());
    const big = act(s, { type: 'resize', screen: SCREEN }).state;
    expect(mailbox(press(big, DOWN).state).cursor).toBe(1);
  });
});

// --- AC12: opening a folder -----------------------------------------------------------------

describe('AC12 Enter on a folder', () => {
  it('opens the embedded browser inside that folder and asks for page 0', () => {
    const s = ready();
    const r = press(s, ENTER);
    const v = mailbox(r.state);
    expect(v.mode).toBe('browsing');
    expect(v.opened).toBe(true);
    expect(v.browser).not.toBeNull();
    expect(v.browser?.embedded).toEqual({ entry: 'INBOX' });
    expect(v.browser?.path).toBe('INBOX');
    expect(v.browser?.title).toBe('one@example.com');
    const load = loadOf(r);
    expect(load).toMatchObject({ path: 'INBOX', page: 0, expected: null });
    expect(load.browserToken).toBe(v.browserToken);
    expect(load.browserGeneration).toBe(v.browser?.generation);
    expect(types(r)).toEqual(['load-page']);
  });

  it('the focused folder is the entry (cursor on the third row)', () => {
    const r = press(ready(), DOWN, DOWN, ENTER);
    expect(mailbox(r.state).browser?.embedded?.entry).toBe(TREE.folders[2]?.path);
  });

  it('a non-selectable folder opens too: its subfolders, no page load, counted as opened', () => {
    const r = press(ready(), DOWN, ENTER);
    const v = mailbox(r.state);
    expect(v.mode).toBe('browsing');
    expect(v.browser?.embedded).toEqual({ entry: 'Archive' });
    expect(effectOf(r, 'load-page')).toBeUndefined();
    expect(v.opened).toBe(true);
    expect(v.browser?.stats.foldersOpened).toBe(1);
  });

  it('the page answer reaches the browser state', () => {
    const { state } = inboxLoaded();
    expect(mailbox(state).browser?.view?.snapshot?.exists).toBe(3);
  });

  it('the browser starts with the screen of the app', () => {
    const s = ready(TREE, { rows: 30, cols: 90 });
    const v = mailbox(press(s, ENTER).state);
    expect(v.browser?.screen).toEqual({ rows: 30, cols: 90 });
  });

  it('Esc, Left and Backspace at the entry folder return to the bars', () => {
    for (const k of [ESC, LEFT, BACKSPACE]) {
      const { state } = inboxLoaded();
      const r = press(state, k);
      const v = mailbox(r.state);
      expect(v.mode).toBe('ready');
      expect(v.browser).toBeNull();
      expect(v.message).toBeNull();
      expect(v.opened).toBe(true);
      expect(r.effects).toEqual([]);
    }
  });

  it('leaving the folder keeps the bars cursor and the tree', () => {
    const base = press(ready(), DOWN, DOWN).state;
    const { state, load } = openInbox(base);
    expect(load.path).toBe(TREE.folders[2]?.path);
    const back = press(act(state, pageAnswer(load, 0)).state, ESC).state;
    expect(mailbox(back).cursor).toBe(2);
    expect(mailbox(back).tree).toBe(TREE);
  });

  it('subfolders open and are left again before Esc returns to the bars', () => {
    // Projects (row 3) has the subfolder Alpha.
    const s = press(ready(), DOWN, DOWN, DOWN).state;
    const { state, load } = openInbox(s);
    expect(load.path).toBe('Projects');
    const atProjects = act(state, pageAnswer(load, 0)).state;
    const enter = press(atProjects, ENTER);
    expect(mailbox(enter.state).browser?.path).toBe('Projects/Alpha');
    const back = press(enter.state, ESC);
    expect(mailbox(back.state).mode).toBe('browsing');
    expect(mailbox(back.state).browser?.path).toBe('Projects');
    const out = press(back.state, ESC);
    expect(mailbox(out.state).mode).toBe('ready');
  });

  it('a first page that fails at the entry folder: back on the bars with "folder-unavailable"', () => {
    const { state, load } = openInbox();
    const r = act(state, {
      type: 'browser',
      browserToken: load.browserToken,
      action: {
        type: 'load-failed',
        generation: load.browserGeneration,
        path: load.path,
        page: 0,
        code: 'folder-unavailable',
      },
    });
    const v = mailbox(r.state);
    expect(v.mode).toBe('ready');
    expect(v.browser).toBeNull();
    expect(v.message).toBe('folder-unavailable');
    expect(v.opened).toBe(true);
  });

  it('q in the browser quits the app (no marks): close-mailbox with the finish data, then quit', () => {
    const { state } = inboxLoaded();
    const r = press(state, ch('q'));
    expect(types(r)).toEqual(['close-mailbox', 'quit']);
    expect(effectOf(r, 'close-mailbox')?.finish).toMatchObject({
      folders: 1,
      mails: 3,
      marked: 0,
    });
  });

  it('q in the browser with marks asks the browser question; y then quits with the marks counted', () => {
    const { state } = inboxLoaded();
    const marked = press(state, ch('a')).state;
    const asked = press(marked, ch('q'));
    expect(asked.effects).toEqual([]);
    expect(mailbox(asked.state).mode).toBe('browsing');
    expect(mailbox(asked.state).browser?.mode).toBe('confirm-quit');
    const r = press(asked.state, ch('y'));
    expect(types(r)).toEqual(['close-mailbox', 'quit']);
    expect(effectOf(r, 'close-mailbox')?.finish).toMatchObject({ marked: 3, folders: 1, mails: 3 });
  });

  it('n at the browser question stays in the browser', () => {
    const { state } = inboxLoaded();
    const asked = press(press(state, ch('a')).state, ch('q')).state;
    const r = press(asked, ch('n'));
    expect(mailbox(r.state).mode).toBe('browsing');
    expect(mailbox(r.state).browser?.mode).toBe('browse');
    expect(r.effects).toEqual([]);
  });

  it('in the browser, Esc does not quit even with the browser question closed', () => {
    const { state } = inboxLoaded();
    const r = press(state, ESC);
    expect(types(r)).not.toContain('quit');
  });
});

// --- AC13: the basket -----------------------------------------------------------------------

describe('AC13 the basket belongs to the mailbox visit', () => {
  it('Space marks the mail under the cursor in the browser', () => {
    const { state } = inboxLoaded();
    const r = press(state, ch(' '));
    expect(mailbox(r.state).browser?.basket.marks.size).toBe(1);
  });

  it('marks are written back on leave and survive Left to the bars', () => {
    const bars = barsWithMarks(1);
    const v = mailbox(bars);
    expect(v.basket.marks.size).toBe(1);
    expect(isMarked(v.basket, { path: 'INBOX', uidValidity: '7', uid: 1003 })).toBe(true);
  });

  it('the stats are written back on leave', () => {
    const v = mailbox(barsWithMarks(3));
    expect(v.visit.foldersOpened).toBe(1);
    expect(v.visit.mailsLoaded).toBe(3);
    expect(v.visit.reconnects).toBe(0);
  });

  it('opening the folder again seeds the browser with the marks and keeps counting', () => {
    const bars = barsWithMarks(3);
    const r = press(bars, ENTER);
    const v = mailbox(r.state);
    expect(v.browser?.basket.marks.size).toBe(3);
    expect(v.browser?.stats.foldersOpened).toBe(2);
    expect(v.browser?.stats.mailsLoaded).toBe(3);
    const second = pageAnswer(loadOf(r), 3);
    const loaded = act(r.state, second).state;
    // The marks are marked again in the freshly loaded page; Space on the first mail unmarks it.
    const unmarked = press(loaded, ch(' ')).state;
    expect(mailbox(unmarked).browser?.basket.marks.size).toBe(2);
  });

  it('marks accumulate across two visits of the same folder (a second mark is added, not replaced)', () => {
    const bars = barsWithMarks(1);
    const r = press(bars, ENTER);
    const loaded = act(r.state, pageAnswer(loadOf(r), 3)).state;
    // The cursor is on mail 1003 (marked); move down and mark the next one.
    const two = press(loaded, DOWN, ch(' ')).state;
    expect(mailbox(two).browser?.basket.marks.size).toBe(2);
    const back = press(two, ESC).state;
    expect(mailbox(back).basket.marks.size).toBe(2);
  });

  it('a leave to Home drops the marks: a new mailbox visit starts with an empty basket', () => {
    const asked = press(barsWithMarks(3), ESC).state;
    const homeAgain = press(asked, ch('y')).state;
    const next = press(homeAgain, ENTER).state;
    expect(mailbox(next).basket.marks.size).toBe(0);
    expect(mailbox(next).visit).toEqual({ foldersOpened: 0, mailsLoaded: 0, reconnects: 0 });
    expect(mailbox(next).opened).toBe(false);
  });
});

// --- AC14: tokens ---------------------------------------------------------------------------

describe('AC14 results of a browser that was left', () => {
  it('a page result with a stale token is dropped by the new browser of the same folder', () => {
    const first = openInbox();
    const bars = press(first.state, ESC).state;
    const second = openInbox(bars);
    expect(second.load.browserToken).not.toBe(first.load.browserToken);
    const late = act(second.state, pageAnswer(first.load, 3));
    expect(late.state).toEqual(second.state);
    expect(late.effects).toEqual([]);
    expect(mailbox(late.state).browser?.view?.snapshot).toBeNull();
    // The right answer still works.
    const fresh = act(second.state, pageAnswer(second.load, 3));
    expect(mailbox(fresh.state).browser?.view?.snapshot?.exists).toBe(3);
  });

  it('a browser action when no browser is open is dropped', () => {
    const first = openInbox();
    const bars = press(first.state, ESC).state;
    const late = act(bars, pageAnswer(first.load, 3));
    expect(late.state).toEqual(bars);
    expect(late.effects).toEqual([]);
  });

  it('a failure with a stale token is dropped too (it must not make the new browser leave)', () => {
    const first = openInbox();
    const bars = press(first.state, ESC).state;
    const second = openInbox(bars);
    const late = act(second.state, {
      type: 'browser',
      browserToken: first.load.browserToken,
      action: {
        type: 'load-failed',
        generation: first.load.browserGeneration,
        path: 'INBOX',
        page: 0,
        code: 'folder-unavailable',
      },
    });
    expect(mailbox(late.state).mode).toBe('browsing');
    expect(late.effects).toEqual([]);
  });

  it('tokens never repeat across browsers, also across mailbox visits', () => {
    const tokens = new Set<number>();
    const a = openInbox();
    tokens.add(a.load.browserToken);
    const bars = press(a.state, ESC).state;
    const b = openInbox(bars);
    tokens.add(b.load.browserToken);
    // Leave the mailbox, open the other one, open its first folder.
    const homeAgain = press(press(b.state, ESC).state, ESC).state;
    expect(homeAgain.view.kind).toBe('home');
    const s2 = reading(press(homeAgain, DOWN, ENTER).state);
    const opened = act(s2, { type: 'mailbox-opened', generation: s2.generation, tree: TREE }).state;
    const c = openInbox(opened);
    tokens.add(c.load.browserToken);
    expect(tokens.size).toBe(3);
    // The first browser's answer means nothing to the third.
    const late = act(c.state, pageAnswer(a.load, 3));
    expect(late.state).toEqual(c.state);
  });
});

// --- AC15: reconnect ------------------------------------------------------------------------

describe('AC15 reconnect inside the embedded browser', () => {
  function lost(): { state: AppState; load: LoadPage } {
    const { state, load } = openInbox();
    const r = act(state, {
      type: 'browser',
      browserToken: load.browserToken,
      action: {
        type: 'load-failed',
        generation: load.browserGeneration,
        path: load.path,
        page: 0,
        code: 'connection-lost',
      },
    });
    return { state: r.state, load };
  }

  it('a lost connection asks "reconnect?" inside the browser', () => {
    const { state } = lost();
    expect(mailbox(state).mode).toBe('browsing');
    expect(mailbox(state).browser?.mode).toBe('reconnect-ask');
  });

  it('y gives one reconnect-mailbox effect carrying the browser token', () => {
    const { state } = lost();
    const r = press(state, ch('y'));
    expect(r.effects).toEqual([
      { type: 'reconnect-mailbox', browserToken: mailbox(r.state).browserToken },
    ]);
    expect(mailbox(r.state).browser?.mode).toBe('reconnecting');
  });

  it('r at the question also reconnects', () => {
    const { state } = lost();
    expect(types(press(state, ch('r')))).toEqual(['reconnect-mailbox']);
  });

  it('n declines: offline, no effect', () => {
    const { state } = lost();
    const r = press(state, ch('n'));
    expect(r.effects).toEqual([]);
    expect(mailbox(r.state).browser?.offline).toBe(true);
  });

  it('the reconnected answer reloads the page (load-page) and counts one reconnect', () => {
    const { state } = lost();
    const asked = press(state, ch('y')).state;
    const token = mailbox(asked).browserToken;
    const r = act(asked, { type: 'browser', browserToken: token, action: { type: 'reconnected' } });
    expect(types(r)).toEqual(['load-page']);
    expect(loadOf(r)).toMatchObject({ path: 'INBOX', page: 0, browserToken: token });
    expect(mailbox(r.state).browser?.stats.reconnects).toBe(1);
  });

  it('reconnects are carried into the finish data', () => {
    const { state } = lost();
    const asked = press(state, ch('y')).state;
    const token = mailbox(asked).browserToken;
    const reloaded = act(asked, {
      type: 'browser',
      browserToken: token,
      action: { type: 'reconnected' },
    });
    const back = act(reloaded.state, pageAnswer(loadOf(reloaded), 3)).state;
    const r = press(back, ch('q'));
    expect(effectOf(r, 'close-mailbox')?.finish).toMatchObject({ reconnects: 1 });
  });

  it('a failed reconnect leaves the browser offline, text shown, and does not leave the mailbox', () => {
    const { state } = lost();
    const asked = press(state, ch('y')).state;
    const token = mailbox(asked).browserToken;
    const r = act(asked, {
      type: 'browser',
      browserToken: token,
      action: { type: 'reconnect-failed', text: 'No luck.' },
    });
    expect(mailbox(r.state).mode).toBe('browsing');
    expect(mailbox(r.state).browser?.offline).toBe(true);
    expect(r.effects).toEqual([]);
  });

  it('a reconnect notice (challenge) goes to the browser status line while browsing', () => {
    const { state } = openInbox();
    const token = mailbox(state).browserToken;
    const r = act(state, {
      type: 'browser',
      browserToken: token,
      action: { type: 'notice', text: 'Waiting 5 seconds.' },
    });
    expect(mailbox(r.state).browser?.message).toEqual({ code: 'text', text: 'Waiting 5 seconds.' });
  });

  it('a reconnected answer of a stale browser token is dropped', () => {
    const first = lost();
    const stale = mailbox(first.state).browserToken;
    const declined = press(first.state, ch('n')).state;
    const bars = press(declined, ESC).state;
    expect(mailbox(bars).mode).toBe('ready');
    const second = openInbox(bars);
    const r = act(second.state, {
      type: 'browser',
      browserToken: stale,
      action: { type: 'reconnected' },
    });
    expect(r.state).toEqual(second.state);
    expect(r.effects).toEqual([]);
  });

  it('while reconnecting, Esc does nothing', () => {
    const { state } = lost();
    const asked = press(state, ch('y')).state;
    const r = press(asked, ESC);
    expect(mailbox(r.state).mode).toBe('browsing');
    expect(mailbox(r.state).browser?.mode).toBe('reconnecting');
    expect(r.effects).toEqual([]);
  });
});

// --- resize while browsing ------------------------------------------------------------------

describe('resize while browsing', () => {
  it('the app screen and the browser screen are both updated', () => {
    const { state } = inboxLoaded();
    const r = act(state, { type: 'resize', screen: { rows: 12, cols: 60 } });
    expect(r.state.screen).toEqual({ rows: 12, cols: 60 });
    expect(mailbox(r.state).browser?.screen).toEqual({ rows: 12, cols: 60 });
    expect(mailbox(r.state).mode).toBe('browsing');
  });
});

// --- browserKeyOf ---------------------------------------------------------------------------

describe('browserKeyOf', () => {
  const same: [AppKey, BrowserKey][] = [
    [UP, 'up'],
    [DOWN, 'down'],
    [PGUP, 'pageup'],
    [PGDN, 'pagedown'],
    [ENTER, 'enter'],
  ];

  it.each(same)('%j is %s in both browsers', (k, expected) => {
    expect(browserKeyOf(k, true)).toBe(expected);
    expect(browserKeyOf(k, false)).toBe(expected);
  });

  it.each([
    ['left', LEFT],
    ['backspace', BACKSPACE],
    ['escape', ESC],
  ])('embedded: %s is back', (_n, k) => {
    expect(browserKeyOf(k, true)).toBe('back');
  });

  it.each([
    ['left', LEFT],
    ['backspace', BACKSPACE],
  ])('not embedded: %s is back as in the M2b browser', (_n, k) => {
    expect(browserKeyOf(k, false)).toBe('back');
  });

  it.each<[string, BrowserKey]>([
    [' ', 'space'],
    ['a', 'mark-screen'],
    ['A', 'mark-screen'],
    ['q', 'quit'],
    ['Q', 'quit'],
    ['y', 'yes'],
    ['Y', 'yes'],
    ['n', 'no'],
    ['N', 'no'],
    ['r', 'reconnect'],
    ['R', 'reconnect'],
  ])('embedded: the character %j is %s', (text, expected) => {
    expect(browserKeyOf(ch(text), true)).toBe(expected);
  });

  it.each(['x', '1', '?', 'ab', ''])('embedded: the character %j is other', (text) => {
    expect(browserKeyOf(ch(text), true)).toBe('other');
  });

  it.each([key('tab'), key('clear'), OTHER])('embedded: %j is other', (k) => {
    expect(browserKeyOf(k, true)).toBe('other');
  });
});

// --- asciiText ------------------------------------------------------------------------------

describe('asciiText', () => {
  it.each<[string, string]>([
    ['plain ASCII stays', 'plain ASCII stays'],
    ['a \u2014 b', 'a - b'],
    ['a \u2013 b', 'a - b'],
    ['wait\u2026', 'wait...'],
    ['\u2018x\u2019', "'x'"],
    ['\u201cx\u201d', '"x"'],
    ['a \u2192 b', 'a -> b'],
    ['caf\u00e9', 'caf?'],
  ])('%j -> %j', (input, expected) => {
    expect(asciiText(input)).toBe(expected);
  });

  it('every other non-ASCII character becomes "?", never stays', () => {
    const out = asciiText('x\u202ey\u00ad\ufe50z\u{1F600}w\u4e2d');
    expect(out).toMatch(/^[\x20-\x7E]*$/);
    expect(out.startsWith('x')).toBe(true);
    expect(out).toContain('?');
    expect(out).toContain('w');
  });

  it('the empty string stays empty', () => {
    expect(asciiText('')).toBe('');
  });

  it('is ASCII for every user-facing error text (every AccountError code, IMAP reason, login block, mailbox error)', () => {
    const account = {
      id: ID1,
      userId: 'u',
      label: null,
      email: 'one@example.com',
      provider: 'websupport',
      host: 'imap.example.com',
      port: 993,
      username: 'one@example.com',
      authType: 'password',
    } as unknown as Parameters<typeof accountErrorText>[1];
    const errors: unknown[] = [
      new AccountError('duplicate'),
      new AccountError('duplicate', ID2),
      new AccountError('not-found'),
      new AccountError('secret-unreadable'),
      new AccountError('unsupported'),
      ...IMAP_FAILURE_REASONS.map((r) => new ImapSessionError(r)),
      ...MAILBOX_ERROR_CODES.map((c) => new MailboxError(c)),
      new LoginBlockedError('too-many-attempts', new Date(Date.UTC(2026, 9, 5, 12))),
      new LoginBlockedError('too-many-attempts', null),
      new LoginBlockedError('ip-blocked', new Date(Date.UTC(2026, 9, 5, 12))),
      new LoginBlockedError('permanent', null),
    ];
    for (const err of errors) {
      for (const text of [accountErrorText(err), accountErrorText(err, account)]) {
        const ascii = asciiText(text);
        expect(ascii, String(err)).toMatch(/^[\n\x20-\x7E]+$/);
        // Nothing else is lost: ASCII-only input is unchanged by construction.
        expect(asciiText(ascii)).toBe(ascii);
      }
    }
  });
});
