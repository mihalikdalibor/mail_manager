import { describe, it, expect } from 'vitest';
import { accountErrorText } from '../../src/cli/account-text.js';
import { browseFinishData, reduceMailbox } from '../../src/cli/app/mailbox.js';
import { reduceApp, startApp } from '../../src/cli/app/reduce.js';
import {
  asciiText,
  browserKeyOf,
  folderRoom,
  initialApp,
  mailboxView,
  orderedFolders,
} from '../../src/cli/app/state.js';
import type {
  AppAction,
  AppEffect,
  AppKey,
  AppReduced,
  AppState,
  FolderOrder,
  HomeView,
  MailboxMode,
  MailboxRow,
  MailboxView,
} from '../../src/cli/app/state.js';
import type { BrowserAction, BrowserKey, Screen } from '../../src/cli/browser/state.js';
import { errorText } from '../../src/cli/error-text.js';
import { AccountError } from '../../src/core/accounts.js';
import type { AuthUser } from '../../src/core/auth.js';
import { ConfigError } from '../../src/core/config.js';
import { IMAP_FAILURE_REASONS, ImapSessionError } from '../../src/core/imap/errors.js';
import { emptyBasket, marksOf } from '../../src/core/mailbox/basket.js';
import { MAILBOX_ERROR_CODES, MailboxError } from '../../src/core/mailbox/errors.js';
import type { MailboxErrorCode } from '../../src/core/mailbox/errors.js';
import type { FolderInfo, FolderTree } from '../../src/core/mailbox/folders.js';
import type { MessageRow } from '../../src/core/mailbox/messages.js';
import { LoginBlockedError } from '../../src/core/security/login-guard.js';

// M2d-2 mailbox screen, state: reduceMailbox through reduceApp, from Enter on a Home row to the
// embedded browser and back, plus the helpers of state.ts (orderedFolders, browserKeyOf,
// asciiText) and browseFinishData. Every step proves that the state it was given is untouched.
// Addresses are placeholders; non-ASCII characters are written as escapes.

// --- fixtures -------------------------------------------------------------------------------

const ANNA: AuthUser = { email: 'anna@example-test-domain.eu', userId: 'user-anna' };
const SCREEN: Screen = { rows: 24, cols: 80 }; // 19 folder rows
const TOO_SMALL: Screen = { rows: 7, cols: 80 };

const MAILBOXES: readonly MailboxRow[] = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'anna@example-test-domain.eu',
    provider: 'websupport',
    lastCheckedAt: new Date(Date.UTC(2026, 9, 3, 18, 22)),
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    email: 'office@example-test-domain.eu',
    provider: 'custom',
    lastCheckedAt: null,
  },
];

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

function treeOf(folders: FolderInfo[], over: Partial<FolderTree> = {}): FolderTree {
  return {
    folders,
    totals: { messages: 20, unseen: 2, bytes: 16_000, sizeSource: 'server' },
    quota: null,
    truncated: false,
    unreadable: 0,
    gmailAllHidden: false,
    fallbacks: new Set(),
    ...over,
  };
}

// Tree order. By size: Projects/Alpha, INBOX, Archive/2023, Projects, Empty, then the two
// unknown ones (Archive, Unknown). By name: Archive, Archive/2023, Empty, INBOX, Projects,
// Projects/Alpha, Unknown.
const TREE = treeOf([
  folder('INBOX', { messages: 5, bytes: 5000, role: 'inbox', roleSource: 'path' }),
  folder('Archive', {
    selectable: false,
    messages: null,
    unseen: null,
    bytes: null,
    sizeSource: null,
  }),
  folder('Archive/2023', { messages: 4, bytes: 3000 }),
  folder('Projects', { messages: 2, bytes: 1000 }),
  folder('Projects/Alpha', { messages: 3, bytes: 7000 }),
  folder('Empty', { messages: 0, bytes: 0 }),
  folder('Unknown', { messages: null, unseen: null, bytes: null, sizeSource: null }),
]);
const TREE_PATHS = TREE.folders.map((f) => f.path);
const LAST = TREE.folders.length - 1;

const EXISTS: Record<string, number> = {
  INBOX: 5,
  'Archive/2023': 4,
  Projects: 2,
  'Projects/Alpha': 3,
  Empty: 0,
};

// --- the driver -----------------------------------------------------------------------------

function key(type: Exclude<AppKey['type'], 'char'>): AppAction {
  return { type: 'key', key: { type } };
}

function ch(text: string): AppAction {
  return { type: 'key', key: { type: 'char', text } };
}

function repeat(action: AppAction, n: number): AppAction[] {
  return Array.from({ length: n }, () => action);
}

const BACK_KEYS: [string, AppAction][] = [
  ['Esc', key('escape')],
  ['Left', key('left')],
  ['Backspace', key('backspace')],
];

/** One step, proving the state it was given wasn't changed. */
function step(state: AppState, action: AppAction): AppReduced {
  const before = structuredClone(state);
  const out = reduceApp(state, action);
  expect(state).toEqual(before);
  return out;
}

/** The actions in order: the last state and every effect on the way. */
function run(state: AppState, ...actions: AppAction[]): AppReduced {
  let s = state;
  const effects: AppEffect[] = [];
  for (const a of actions) {
    const out = step(s, a);
    s = out.state;
    effects.push(...out.effects);
  }
  return { state: s, effects };
}

function act(state: AppState, ...actions: AppAction[]): AppState {
  return run(state, ...actions).state;
}

function resized(state: AppState, screen: Screen): AppState {
  return act(state, { type: 'resize', screen });
}

function view(state: AppState): MailboxView {
  if (state.view.kind !== 'mailbox') throw new Error(`not on a mailbox: ${state.view.kind}`);
  return state.view;
}

function homeOf(state: AppState): HomeView {
  if (state.view.kind !== 'home') throw new Error(`not on Home: ${state.view.kind}`);
  return state.view;
}

/** Home of ANNA with her two mailboxes. */
function atHome(screen: Screen = SCREEN): AppState {
  const s0 = startApp(initialApp('1.2.3', screen)).state;
  const s1 = act(
    s0,
    { type: 'session', generation: s0.generation, user: ANNA, remembered: [ANNA.email] },
    key('enter'),
  );
  return act(s1, { type: 'mailboxes', generation: s1.generation, rows: MAILBOXES });
}

/** Enter on the first mailbox: "Connecting...". */
function connecting(screen: Screen = SCREEN): AppState {
  return act(atHome(screen), key('enter'));
}

function reading(screen: Screen = SCREEN): AppState {
  const s = connecting(screen);
  return act(s, { type: 'mailbox-reading', generation: s.generation });
}

/** The bars. */
function ready(tree: FolderTree = TREE, screen: Screen = SCREEN): AppState {
  const s = reading(screen);
  return act(s, { type: 'mailbox-opened', generation: s.generation, tree });
}

function failed(text = 'It did not work.'): AppState {
  const s = reading();
  return act(s, { type: 'mailbox-failed', generation: s.generation, text });
}

/** The bars with the cursor on `path`. */
function on(state: AppState, path: string): AppState {
  const v = view(state);
  if (v.tree === null) throw new Error('no folders yet');
  const index = orderedFolders(v.tree, v.order).findIndex((f) => f.path === path);
  if (index < 0) throw new Error(`no folder ${path}`);
  return act(state, ...repeat(key('up'), v.cursor), ...repeat(key('down'), index));
}

function focused(state: AppState): string | undefined {
  const v = view(state);
  return v.tree === null ? undefined : orderedFolders(v.tree, v.order)[v.cursor]?.path;
}

// --- the embedded browser -------------------------------------------------------------------

type LoadPage = Extract<AppEffect, { type: 'load-page' }>;

function mail(seq: number): MessageRow {
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

function loadIn(effects: readonly AppEffect[]): LoadPage {
  const load = effects.find((e): e is LoadPage => e.type === 'load-page');
  if (load === undefined) throw new Error('no load-page effect');
  return load;
}

function toBrowser(load: LoadPage, action: BrowserAction): AppAction {
  return { type: 'browser', browserToken: load.browserToken, action };
}

/** What the controller answers for a page of the folder (all its mails, newest first). */
function page(load: LoadPage, uidValidity = '7'): AppAction {
  const exists = EXISTS[load.path];
  if (exists === undefined) throw new Error(`no folder ${load.path} in the fixture`);
  const rows: MessageRow[] = [];
  for (let seq = exists; seq >= 1; seq--) rows.push(mail(seq));
  return toBrowser(load, {
    type: 'page-loaded',
    generation: load.browserGeneration,
    path: load.path,
    page: load.page,
    result: {
      kind: 'page',
      snapshot: { path: load.path, uidValidity, exists },
      page: load.page,
      rows,
    },
  });
}

function loadFailed(load: LoadPage, code: MailboxErrorCode): AppAction {
  return toBrowser(load, {
    type: 'load-failed',
    generation: load.browserGeneration,
    path: load.path,
    page: load.page,
    code,
  });
}

/** Enter on `path` from the bars: the browser is open, its first page asked for. */
function opened(state: AppState, path = 'INBOX'): { state: AppState; load: LoadPage } {
  const out = step(on(state, path), key('enter'));
  return { state: out.state, load: loadIn(out.effects) };
}

/** In `path` with its mails on screen. */
function browsing(state: AppState = ready(), path = 'INBOX'): AppState {
  const o = opened(state, path);
  return act(o.state, page(o.load));
}

/** Back on the bars after marking every mail of INBOX (5 marks, 500 bytes). */
function barsWithMarks(): AppState {
  const bars = act(browsing(), ch('a'), key('escape'));
  expect(view(bars)).toMatchObject({ mode: 'ready', browser: null });
  expect(view(bars).basket.marks.size).toBe(5);
  return bars;
}

// --- Home -> mailbox ------------------------------------------------------------------------

describe('Enter on a mailbox row of Home', () => {
  it('opens its screen: connecting, one open-mailbox effect of a new generation', () => {
    const home = act(atHome(), key('down'));
    const out = step(home, key('enter'));
    expect(out.state.generation).toBe(home.generation + 1);
    expect(out.effects).toEqual([
      { type: 'open-mailbox', generation: home.generation + 1, accountId: MAILBOXES[1]?.id },
    ]);
    expect(out.state.view).toEqual({
      kind: 'mailbox',
      mode: 'connecting',
      mailbox: MAILBOXES[1],
      home: home.view,
      progress: null,
      tree: null,
      failure: null,
      order: 'tree',
      cursor: 0,
      basket: emptyBasket,
      visit: { foldersOpened: 0, mailsLoaded: 0, reconnects: 0 },
      opened: false,
      browserToken: home.generation,
      browser: null,
      stats: { status: 'idle' },
      statsToken: 0,
      statsSection: 'years',
      statsBy: 'size',
      statsTop: 0,
      message: null,
    });
    expect({ ...out.state, view: home.view, generation: home.generation }).toEqual(home);
  });

  it('the kept Home no longer says "Added ..."', () => {
    const s = atHome();
    const said = { ...s, view: { ...homeOf(s), added: 'new@example-test-domain.eu' } };
    expect(homeOf(said).added).toBe('new@example-test-domain.eu');
    const v = view(act(said, key('enter')));
    expect(v.home).toMatchObject({ mode: 'list', cursor: 0, message: null, added: null });
    expect(v.home.mailboxes).toEqual(MAILBOXES);
  });

  it('mailboxView: a fresh visit', () => {
    const home = homeOf(atHome());
    const row = MAILBOXES[0] as MailboxRow;
    expect(mailboxView(row, home, 7)).toMatchObject({
      kind: 'mailbox',
      mode: 'connecting',
      mailbox: row,
      home,
      opened: false,
      browserToken: 7,
    });
  });
});

// --- results of the login and the read ------------------------------------------------------

describe('results while the mailbox opens', () => {
  it('mailbox-reading: the login worked, the folders are read', () => {
    const s = connecting();
    const out = step(s, { type: 'mailbox-reading', generation: s.generation });
    expect(out.effects).toEqual([]);
    expect(out.state).toEqual({ ...s, view: { ...view(s), mode: 'reading' } });
  });

  it('challenge: the notice while connecting; the login ends it', () => {
    const s = connecting();
    const waiting = act(s, { type: 'challenge', generation: s.generation });
    expect(waiting).toEqual({ ...s, view: { ...view(s), message: 'challenge' } });
    const read = act(waiting, { type: 'mailbox-reading', generation: s.generation });
    expect(view(read)).toMatchObject({ mode: 'reading', message: null });
  });

  it('mailbox-progress: kept while reading, the latest wins', () => {
    const s = reading();
    const first = { folder: 1, folders: 3, done: 10, total: 40 };
    const second = { folder: 2, folders: 3, done: 0, total: 9 };
    const one = act(s, { type: 'mailbox-progress', generation: s.generation, progress: first });
    expect(one).toEqual({ ...s, view: { ...view(s), progress: first } });
    const two = act(one, { type: 'mailbox-progress', generation: s.generation, progress: second });
    expect(view(two).progress).toEqual(second);
  });

  it('mailbox-opened: the bars, cursor on the first folder, the progress gone', () => {
    const s = reading();
    const progress = { folder: 1, folders: 3, done: 10, total: 40 };
    const out = run(
      s,
      { type: 'mailbox-progress', generation: s.generation, progress },
      { type: 'mailbox-opened', generation: s.generation, tree: TREE },
    );
    expect(out.effects).toEqual([]);
    expect(out.state).toEqual({ ...s, view: { ...view(s), mode: 'ready', tree: TREE } });
    expect(view(out.state).tree).toBe(TREE);
  });

  it('mailbox-opened straight from connecting works too', () => {
    const s = connecting();
    const out = act(s, { type: 'mailbox-opened', generation: s.generation, tree: TREE });
    expect(view(out)).toMatchObject({ mode: 'ready', cursor: 0, message: null });
  });

  it('a truncated tree says so', () => {
    expect(view(ready(treeOf(TREE.folders, { truncated: true }))).message).toBe('truncated');
  });

  it.each<[string, () => AppState]>([
    ['connecting (the login failed)', connecting],
    ['reading (the read failed)', reading],
  ])('mailbox-failed while %s: the text is kept as it came', (_name, make) => {
    const s = make();
    const text = 'Line one \u2014 with a dash.\nLine two.';
    const out = step(s, { type: 'mailbox-failed', generation: s.generation, text });
    expect(out.effects).toEqual([]);
    expect(out.state).toEqual({ ...s, view: { ...view(s), mode: 'failed', failure: text } });
  });

  it('mailbox-failed drops the progress and the challenge notice', () => {
    const s = connecting();
    const out = act(
      s,
      { type: 'challenge', generation: s.generation },
      { type: 'mailbox-failed', generation: s.generation, text: 'No.' },
    );
    expect(view(out)).toMatchObject({ mode: 'failed', message: null, progress: null });
  });

  it('a result of an older request changes nothing', () => {
    for (const s of [connecting(), reading(), ready(), failed()]) {
      const generation = s.generation - 1;
      const stale: AppAction[] = [
        { type: 'mailbox-reading', generation },
        {
          type: 'mailbox-progress',
          generation,
          progress: { folder: 1, folders: 2, done: 0, total: 1 },
        },
        { type: 'mailbox-opened', generation, tree: treeOf([]) },
        { type: 'mailbox-failed', generation, text: 'late' },
        { type: 'challenge', generation },
      ];
      for (const action of stale) {
        const out = step(s, action);
        expect(out.state).toBe(s);
        expect(out.effects).toEqual([]);
      }
    }
  });

  it('a result that does not fit the mode changes nothing', () => {
    const cases: [AppState, AppAction['type'][]][] = [
      [connecting(), ['mailbox-progress']],
      [reading(), ['mailbox-reading', 'challenge']],
      [
        ready(),
        ['mailbox-reading', 'mailbox-progress', 'mailbox-opened', 'mailbox-failed', 'challenge'],
      ],
      [
        failed(),
        ['mailbox-reading', 'mailbox-progress', 'mailbox-opened', 'mailbox-failed', 'challenge'],
      ],
    ];
    for (const [s, types] of cases) {
      const generation = s.generation;
      const all: AppAction[] = [
        { type: 'mailbox-reading', generation },
        {
          type: 'mailbox-progress',
          generation,
          progress: { folder: 1, folders: 2, done: 0, total: 1 },
        },
        { type: 'mailbox-opened', generation, tree: treeOf([]) },
        { type: 'mailbox-failed', generation, text: 'again' },
        { type: 'challenge', generation },
      ];
      for (const action of all.filter((a) => types.includes(a.type))) {
        const out = step(s, action);
        expect(out.state).toBe(s);
        expect(out.effects).toEqual([]);
      }
    }
  });

  it('after the mailbox was left, its results mean nothing to Home', () => {
    const s = connecting();
    const home = act(s, key('escape'));
    for (const generation of [s.generation, home.generation]) {
      const out = step(home, { type: 'mailbox-opened', generation, tree: TREE });
      expect(out.state).toBe(home);
      expect(out.effects).toEqual([]);
    }
    const browser = step(home, {
      type: 'browser',
      browserToken: view(s).browserToken,
      action: { type: 'reconnected' },
    });
    expect(browser.state).toBe(home);
    expect(browser.effects).toEqual([]);
  });

  it('reduceMailbox leaves a state that shows another view alone', () => {
    const home = atHome();
    for (const action of [key('enter'), ch('q'), { type: 'resize', screen: SCREEN } as const]) {
      const out = reduceMailbox(home, action);
      expect(out.state).toBe(home);
      expect(out.effects).toEqual([]);
    }
  });
});

// --- keys while waiting and on the failed screen --------------------------------------------

describe('keys while connecting and reading', () => {
  const MODES: [string, () => AppState][] = [
    ['connecting', connecting],
    ['reading', reading],
  ];

  for (const [mode, make] of MODES) {
    it.each(BACK_KEYS)(`${mode}: %s goes back to Home and closes the mailbox`, (_name, back) => {
      const s = make();
      const out = step(s, back);
      expect(out.effects).toEqual([{ type: 'close-mailbox', finish: null }]);
      expect(out.state).toEqual({ ...s, generation: s.generation + 1, view: view(s).home });
    });

    it.each(['q', 'Q'])(`${mode}: %s closes the mailbox and quits`, (letter) => {
      const s = make();
      const out = step(s, ch(letter));
      expect(out.effects).toEqual([{ type: 'close-mailbox', finish: null }, { type: 'quit' }]);
      expect(out.state).toBe(s);
    });

    it(`${mode}: every other key does nothing`, () => {
      const s = act(make(), { type: 'challenge', generation: make().generation });
      for (const action of [
        key('up'),
        key('down'),
        key('pageup'),
        key('pagedown'),
        key('enter'),
        key('tab'),
        key('clear'),
        key('other'),
        ch('o'),
        ch('r'),
        ch('y'),
        ch(' '),
      ]) {
        const out = step(s, action);
        expect(out.state).toBe(s);
        expect(out.effects).toEqual([]);
      }
    });
  }

  it('the generation after Esc drops the login that is still under way', () => {
    const s = connecting();
    const home = act(s, key('escape'));
    const late = step(home, { type: 'mailbox-reading', generation: s.generation });
    expect(late.state).toBe(home);
  });
});

describe('keys on the failed screen', () => {
  it.each(['r', 'R'])('%s runs the whole login + read again as a new request', (letter) => {
    const s = failed();
    const out = step(s, ch(letter));
    expect(out.effects).toEqual([
      { type: 'open-mailbox', generation: s.generation + 1, accountId: MAILBOXES[0]?.id },
    ]);
    expect(out.state).toEqual({
      ...s,
      generation: s.generation + 1,
      view: {
        ...view(s),
        mode: 'connecting',
        failure: null,
        statsToken: view(s).statsToken + 1,
      },
    });
  });

  it('the answer of the first attempt is dropped after r; the new one counts', () => {
    const s = failed();
    const again = act(s, ch('r'));
    const late = step(again, { type: 'mailbox-opened', generation: s.generation, tree: TREE });
    expect(late.state).toBe(again);
    const now = act(again, { type: 'mailbox-opened', generation: again.generation, tree: TREE });
    expect(view(now)).toMatchObject({ mode: 'ready', tree: TREE, failure: null });
  });

  it('a second failure shows its own text', () => {
    const again = act(failed('First.'), ch('r'));
    const out = act(again, { type: 'mailbox-failed', generation: again.generation, text: 'Two.' });
    expect(view(out)).toMatchObject({ mode: 'failed', failure: 'Two.' });
  });

  it.each(BACK_KEYS)('%s goes back to Home and closes the mailbox', (_name, back) => {
    const s = failed();
    const out = step(s, back);
    expect(out.effects).toEqual([{ type: 'close-mailbox', finish: null }]);
    expect(out.state).toEqual({ ...s, generation: s.generation + 1, view: view(s).home });
  });

  it('q quits; every other key does nothing', () => {
    const s = failed();
    expect(step(s, ch('q')).effects).toEqual([
      { type: 'close-mailbox', finish: null },
      { type: 'quit' },
    ]);
    for (const action of [key('enter'), key('down'), key('tab'), ch('o'), ch('y'), key('other')]) {
      const out = step(s, action);
      expect(out.state).toBe(s);
      expect(out.effects).toEqual([]);
    }
  });
});

// --- the bars: moving, order ----------------------------------------------------------------

describe('the bars: moving', () => {
  it('Up/Down move by one and stop at the ends', () => {
    let s = ready();
    expect(view(act(s, key('up'))).cursor).toBe(0);
    s = act(s, key('down'));
    expect(view(s).cursor).toBe(1);
    s = act(s, ...repeat(key('down'), 20));
    expect(view(s).cursor).toBe(LAST);
    expect(view(act(s, key('up'))).cursor).toBe(LAST - 1);
  });

  it('PgUp/PgDn move by the folder rows on screen', () => {
    const many = treeOf(Array.from({ length: 60 }, (_, i) => folder(`F${String(i)}`)));
    // 24 rows: header, totals, quota, 19 folders, status, help.
    expect(folderRoom(SCREEN)).toBe(19);
    let s = ready(many);
    s = act(s, key('pagedown'));
    expect(view(s).cursor).toBe(19);
    s = act(s, key('pagedown'), key('pagedown'), key('pagedown'));
    expect(view(s).cursor).toBe(59);
    s = act(s, key('pageup'));
    expect(view(s).cursor).toBe(40);
    s = act(s, ...repeat(key('pageup'), 5));
    expect(view(s).cursor).toBe(0);
    // A smaller window pages by less.
    const small = ready(many, { rows: 8, cols: 40 });
    expect(view(act(small, key('pagedown'))).cursor).toBe(3);
  });

  it('moving changes the cursor and nothing else', () => {
    const s = ready();
    const out = step(s, key('down'));
    expect(out.effects).toEqual([]);
    expect(out.state).toEqual({ ...s, view: { ...view(s), cursor: 1 } });
  });

  it('keys that mean nothing here change nothing: r, y, Tab, others', () => {
    const s = act(ready(), key('down'));
    for (const action of [
      ch('r'),
      ch('y'),
      ch('x'),
      ch(' '),
      key('tab'),
      key('clear'),
      key('other'),
    ]) {
      const out = step(s, action);
      expect(out.state).toEqual(s);
      expect(out.effects).toEqual([]);
    }
  });

  it('no folders: no key moves, opens or breaks anything', () => {
    const s = ready(treeOf([], { totals: null }));
    const out = run(s, key('down'), key('pagedown'), key('up'), ch('o'), key('enter'));
    expect(out.effects).toEqual([]);
    expect(view(out.state)).toMatchObject({
      mode: 'ready',
      cursor: 0,
      order: 'size',
      browser: null,
    });
  });

  it('a resize keeps the view; the cursor is not moved', () => {
    const s = act(ready(), ...repeat(key('down'), 4));
    const out = step(s, { type: 'resize', screen: { rows: 9, cols: 44 } });
    expect(out.effects).toEqual([]);
    expect(out.state).toEqual({ ...s, screen: { rows: 9, cols: 44 } });
  });
});

describe('the bars: o changes the order', () => {
  it('tree -> size -> name -> tree, in either case', () => {
    let s = ready();
    const seen: FolderOrder[] = [];
    for (const letter of ['o', 'O', 'o']) {
      s = act(s, ch(letter));
      seen.push(view(s).order);
    }
    expect(seen).toEqual(['size', 'name', 'tree']);
  });

  it('the cursor stays on the same folder, whatever the order', () => {
    for (const path of TREE_PATHS) {
      let s = on(ready(), path);
      for (let i = 0; i < 6; i++) {
        s = act(s, ch('o'));
        expect(focused(s)).toBe(path);
      }
    }
  });

  it('o changes the order and the cursor only', () => {
    const s = on(ready(), 'Projects/Alpha');
    const out = step(s, ch('o'));
    expect(out.effects).toEqual([]);
    // Projects/Alpha is the largest: first by size.
    expect(out.state).toEqual({ ...s, view: { ...view(s), order: 'size', cursor: 0 } });
  });

  it('moving follows the order on screen', () => {
    const bySize = act(ready(), ch('o'));
    expect(focused(bySize)).toBe('INBOX');
    expect(focused(act(bySize, key('up')))).toBe('Projects/Alpha');
    expect(focused(act(bySize, key('down')))).toBe('Archive/2023');
  });
});

describe('orderedFolders', () => {
  const paths = (tree: FolderTree, order: FolderOrder): string[] =>
    orderedFolders(tree, order).map((f) => f.path);

  it('tree: the list as the tree has it', () => {
    expect(orderedFolders(TREE, 'tree')).toBe(TREE.folders);
  });

  it('size: largest first, unknown sizes last, ties in tree order', () => {
    expect(paths(TREE, 'size')).toEqual([
      'Projects/Alpha',
      'INBOX',
      'Archive/2023',
      'Projects',
      'Empty',
      'Archive',
      'Unknown',
    ]);
    const ties = treeOf([
      folder('c', { bytes: 10 }),
      folder('a', { bytes: null }),
      folder('b', { bytes: 10 }),
      folder('z', { bytes: 0 }),
      folder('d', { bytes: null }),
      folder('e', { bytes: 10 }),
    ]);
    expect(paths(ties, 'size')).toEqual(['c', 'b', 'e', 'z', 'a', 'd']);
  });

  it('name: the full path without letter case, ties in tree order', () => {
    expect(paths(TREE, 'name')).toEqual([
      'Archive',
      'Archive/2023',
      'Empty',
      'INBOX',
      'Projects',
      'Projects/Alpha',
      'Unknown',
    ]);
    const mixed = treeOf([folder('beta'), folder('ALPHA'), folder('Beta'), folder('alpha')]);
    expect(paths(mixed, 'name')).toEqual(['ALPHA', 'alpha', 'beta', 'Beta']);
  });

  it('never changes the tree', () => {
    const before = [...TREE_PATHS];
    orderedFolders(TREE, 'size');
    orderedFolders(TREE, 'name');
    expect(TREE.folders.map((f) => f.path)).toEqual(before);
  });

  it('an empty tree', () => {
    for (const order of ['tree', 'size', 'name'] as const) {
      expect(orderedFolders(treeOf([]), order)).toEqual([]);
    }
  });
});

// --- the bars: leaving and quitting ---------------------------------------------------------

describe('the bars: leaving the mailbox', () => {
  it.each(BACK_KEYS)('%s without marks: Home as it was, one close-mailbox', (_name, back) => {
    const s = on(ready(), 'Projects');
    const out = step(s, back);
    expect(out.effects).toEqual([{ type: 'close-mailbox', finish: null }]);
    expect(out.state).toEqual({ ...s, generation: s.generation + 1, view: view(s).home });
    expect(out.state.view).toBe(view(s).home);
  });

  it('Home is the list that was left: same rows, same cursor, nothing reloaded', () => {
    const home = act(atHome(), key('down'));
    const s = act(home, key('enter'));
    const bars = act(
      s,
      { type: 'mailbox-reading', generation: s.generation },
      { type: 'mailbox-opened', generation: s.generation, tree: TREE },
    );
    const out = step(bars, key('left'));
    expect(out.state.view).toEqual(home.view);
    expect(out.effects.map((e) => e.type)).toEqual(['close-mailbox']);
  });

  it.each(BACK_KEYS)('%s with marks asks first; nothing is closed', (_name, back) => {
    const s = barsWithMarks();
    const out = step(s, back);
    expect(out.effects).toEqual([]);
    expect(out.state).toEqual({ ...s, view: { ...view(s), mode: 'confirm-leave' } });
  });

  it.each(['y', 'Y'])('%s at the question leaves and reports the visit', (letter) => {
    const asked = act(barsWithMarks(), key('escape'));
    const out = step(asked, ch(letter));
    expect(out.state.view).toBe(view(asked).home);
    expect(out.effects).toEqual([
      {
        type: 'close-mailbox',
        finish: { opened: true, folders: 1, mails: 5, reconnects: 0, marked: 5, bytes: 500 },
      },
    ]);
  });

  it('any other key at the question stays on the bars with the marks', () => {
    const asked = act(barsWithMarks(), key('escape'));
    for (const action of [
      ch('n'),
      ch('q'),
      ch('o'),
      key('enter'),
      key('escape'),
      key('left'),
      key('down'),
      key('other'),
    ]) {
      const out = step(asked, action);
      expect(out.effects).toEqual([]);
      expect(out.state).toEqual({ ...asked, view: { ...view(asked), mode: 'ready' } });
    }
  });

  it('a folder was opened but nothing marked: no question, the counts are reported', () => {
    const bars = act(browsing(), key('escape'));
    const out = step(bars, key('escape'));
    expect(out.state.view.kind).toBe('home');
    expect(out.effects).toEqual([
      {
        type: 'close-mailbox',
        finish: { opened: true, folders: 1, mails: 5, reconnects: 0, marked: 0, bytes: 0 },
      },
    ]);
  });

  it('the next visit starts clean: no marks, no counts, nothing opened', () => {
    const home = act(barsWithMarks(), key('escape'), ch('y'));
    const next = view(act(home, key('enter')));
    expect(next.basket.marks.size).toBe(0);
    expect(next.visit).toEqual({ foldersOpened: 0, mailsLoaded: 0, reconnects: 0 });
    expect(next.opened).toBe(false);
  });
});

describe('the bars: q', () => {
  it.each(['q', 'Q'])('%s without marks: close-mailbox, then quit; the state stays', (letter) => {
    const s = ready();
    const out = step(s, ch(letter));
    expect(out.effects).toEqual([{ type: 'close-mailbox', finish: null }, { type: 'quit' }]);
    expect(out.state).toBe(s);
  });

  it('with marks it asks first; y quits and reports the visit', () => {
    const s = barsWithMarks();
    const asked = step(s, ch('q'));
    expect(asked.effects).toEqual([]);
    expect(asked.state).toEqual({ ...s, view: { ...view(s), mode: 'confirm-quit' } });
    const out = step(asked.state, ch('y'));
    expect(out.effects).toEqual([
      {
        type: 'close-mailbox',
        finish: { opened: true, folders: 1, mails: 5, reconnects: 0, marked: 5, bytes: 500 },
      },
      { type: 'quit' },
    ]);
  });

  it('any other key at the question stays', () => {
    const asked = act(barsWithMarks(), ch('q'));
    for (const action of [ch('n'), ch('q'), key('enter'), key('escape'), key('other')]) {
      const out = step(asked, action);
      expect(out.effects).toEqual([]);
      expect(view(out.state)).toMatchObject({ mode: 'ready' });
      expect(view(out.state).basket.marks.size).toBe(5);
    }
  });
});

// --- messages on the bars -------------------------------------------------------------------

describe('the bars: the status message', () => {
  function unavailable(tree: FolderTree = TREE): AppState {
    const o = opened(ready(tree));
    return act(o.state, loadFailed(o.load, 'folder-unavailable'));
  }

  it('"folder-unavailable" is cleared by the next key', () => {
    const s = unavailable();
    expect(view(s).message).toBe('folder-unavailable');
    for (const action of [key('down'), ch('x'), ch('o'), key('other')]) {
      expect(view(act(s, action)).message).toBeNull();
    }
  });

  it('the note about a cut folder list stays, and comes back after another message', () => {
    const cut = treeOf(TREE.folders, { truncated: true });
    const s = ready(cut);
    expect(view(act(s, key('down'), ch('o'), ch('x'))).message).toBe('truncated');
    const failedOpen = unavailable(cut);
    expect(view(failedOpen).message).toBe('folder-unavailable');
    expect(view(act(failedOpen, key('down'))).message).toBe('truncated');
    // Also after a folder was opened and left again.
    expect(view(act(browsing(s), key('escape'))).message).toBe('truncated');
  });
});

// --- window too small -----------------------------------------------------------------------

describe('window too small: only q and the answer to a question act', () => {
  const IGNORED: AppAction[] = [
    key('up'),
    key('down'),
    key('pagedown'),
    key('enter'),
    key('escape'),
    key('left'),
    key('backspace'),
    ch('o'),
    ch('r'),
    ch('y'),
    key('other'),
  ];

  const MODES: [MailboxMode, () => AppState][] = [
    ['connecting', connecting],
    ['reading', reading],
    ['failed', failed],
    ['ready', ready],
  ];

  it.each(MODES)('%s: q quits, nothing else acts', (mode, make) => {
    const s = resized(make(), TOO_SMALL);
    expect(view(s).mode).toBe(mode);
    for (const action of IGNORED) {
      const out = step(s, action);
      expect(out.state).toBe(s);
      expect(out.effects).toEqual([]);
    }
    expect(step(s, ch('q')).effects).toEqual([
      { type: 'close-mailbox', finish: null },
      { type: 'quit' },
    ]);
  });

  it('the bars with marks: q asks, y answers', () => {
    const s = resized(barsWithMarks(), TOO_SMALL);
    const asked = step(s, ch('q'));
    expect(asked.effects).toEqual([]);
    expect(view(asked.state).mode).toBe('confirm-quit');
    expect(step(asked.state, ch('y')).effects.map((e) => e.type)).toEqual([
      'close-mailbox',
      'quit',
    ]);
    expect(view(act(asked.state, ch('n'))).mode).toBe('ready');
  });

  it('a leave question that was open is still answered', () => {
    const asked = resized(act(barsWithMarks(), key('escape')), TOO_SMALL);
    expect(view(asked).mode).toBe('confirm-leave');
    expect(step(asked, ch('y')).state.view.kind).toBe('home');
    expect(view(act(asked, key('down'))).mode).toBe('ready');
  });

  it('in a folder the browser has its own rule: only q acts', () => {
    const s = resized(browsing(), TOO_SMALL);
    for (const action of [key('escape'), key('left'), key('down'), ch(' '), ch('a')]) {
      const out = step(s, action);
      expect(out.effects).toEqual([]);
      expect(view(out.state)).toMatchObject({ mode: 'browsing' });
      expect(view(out.state).browser?.basket.marks.size).toBe(0);
    }
    expect(step(s, ch('q')).effects.map((e) => e.type)).toEqual(['close-mailbox', 'quit']);
  });
});

// --- Enter on a folder: the embedded browser ------------------------------------------------

describe('Enter on a folder', () => {
  it('opens the browser inside it: a new token, the first page asked for under that token', () => {
    const s = on(ready(), 'Projects');
    const out = step(s, key('enter'));
    const v = view(out.state);
    const browser = v.browser;
    if (browser === null) throw new Error('no browser');
    expect(v).toMatchObject({
      mode: 'browsing',
      opened: true,
      browserToken: view(s).browserToken + 1,
      cursor: view(s).cursor,
      tree: TREE,
    });
    expect(browser).toMatchObject({
      title: MAILBOXES[0]?.email,
      path: 'Projects',
      embedded: { entry: 'Projects' },
      screen: SCREEN,
      stats: { foldersOpened: 1, mailsLoaded: 0, reconnects: 0 },
    });
    expect(browser.folders).toBe(TREE.folders);
    expect(out.effects).toEqual([
      {
        type: 'load-page',
        browserToken: v.browserToken,
        browserGeneration: browser.generation,
        path: 'Projects',
        page: 0,
        expected: null,
      },
    ]);
    // The app's own generation is not a browser matter.
    expect(out.state.generation).toBe(s.generation);
  });

  it('opens the folder under the cursor of the order on screen', () => {
    const bySize = act(ready(), ch('o'), ...repeat(key('up'), 9));
    expect(focused(bySize)).toBe('Projects/Alpha');
    const out = step(bySize, key('enter'));
    expect(view(out.state).browser?.embedded).toEqual({ entry: 'Projects/Alpha' });
    expect(loadIn(out.effects).path).toBe('Projects/Alpha');
  });

  it('a folder that holds no mails opens too: its subfolders, no page', () => {
    const out = step(on(ready(), 'Archive'), key('enter'));
    expect(out.effects).toEqual([]);
    expect(view(out.state)).toMatchObject({ mode: 'browsing', opened: true });
    expect(view(out.state).browser).toMatchObject({
      path: 'Archive',
      stats: { foldersOpened: 1 },
    });
  });

  it('the page arrives: the mails are in the browser, counted', () => {
    const s = browsing();
    expect(view(s).browser?.view?.snapshot).toEqual({ path: 'INBOX', uidValidity: '7', exists: 5 });
    expect(view(s).browser?.stats.mailsLoaded).toBe(5);
    // The view's own counts follow when the browser is left.
    expect(view(s).visit).toEqual({ foldersOpened: 0, mailsLoaded: 0, reconnects: 0 });
  });

  it('keys go to the browser as its own keys: Space and a mark, o orders the mails (not the bars)', () => {
    const s = browsing();
    expect(marksOf(view(act(s, ch(' '))).browser?.basket ?? emptyBasket)).toEqual([
      { path: 'INBOX', uidValidity: '7', uid: 1005, bytes: 100 },
    ]);
    expect(view(act(s, ch('a'))).browser?.basket.marks.size).toBe(5);
    // M3a: o orders the mails of the open folder (one search); the bars order behind it stays.
    const o = step(s, ch('o'));
    expect(o.effects.map((e) => e.type)).toEqual(['search-folder']);
    expect(view(o.state)).toMatchObject({ order: 'tree', mode: 'browsing' });
    expect(view(o.state).browser?.view?.listing?.order).toBe('oldest');
  });

  it('subfolders open and close inside the browser; the bars come back only at the entry', () => {
    let s = browsing(ready(), 'Projects');
    const into = step(s, key('enter'));
    expect(view(into.state).browser?.path).toBe('Projects/Alpha');
    s = act(into.state, page(loadIn(into.effects)));
    const back = step(s, key('escape'));
    expect(view(back.state)).toMatchObject({ mode: 'browsing' });
    expect(view(back.state).browser?.path).toBe('Projects');
    // Reopened: its first page is asked for again, under the same token.
    expect(loadIn(back.effects)).toMatchObject({
      path: 'Projects',
      page: 0,
      browserToken: view(s).browserToken,
    });
    const out = step(back.state, key('left'));
    expect(view(out.state)).toMatchObject({ mode: 'ready', browser: null });
    expect(view(out.state).visit.foldersOpened).toBe(2);
  });
});

describe('leaving the folder', () => {
  it.each(BACK_KEYS)(
    '%s at the entry: the bars, marks and counts kept, a new token',
    (_n, back) => {
      const marked = act(browsing(), ch(' '));
      const before = view(marked);
      const out = step(marked, back);
      expect(out.effects).toEqual([]);
      expect(out.state).toEqual({
        ...marked,
        view: {
          ...before,
          mode: 'ready',
          browser: null,
          basket: before.browser?.basket,
          visit: { foldersOpened: 1, mailsLoaded: 5, reconnects: 0 },
          browserToken: before.browserToken + 1,
        },
      });
      expect(marksOf(view(out.state).basket)).toEqual([
        { path: 'INBOX', uidValidity: '7', uid: 1005, bytes: 100 },
      ]);
    },
  );

  it('the marks are in the next browser, in the same folder or another', () => {
    const bars = barsWithMarks();
    const again = browsing(bars);
    expect(view(again).browser?.basket.marks.size).toBe(5);
    expect(view(again).browser?.stats).toEqual({
      foldersOpened: 2,
      mailsLoaded: 10,
      reconnects: 0,
    });
    // Space on the first mail takes its mark away: it was marked when it came back.
    expect(view(act(again, ch(' '))).browser?.basket.marks.size).toBe(4);

    const other = act(browsing(bars, 'Archive/2023'), key('down'), ch(' '));
    expect(view(other).browser?.basket.marks.size).toBe(6);
    const back = view(act(other, key('escape')));
    expect(back.basket.marks.size).toBe(6);
    expect(back.visit).toEqual({ foldersOpened: 2, mailsLoaded: 9, reconnects: 0 });
  });

  it('a folder reset on the server loses its marks in the visit too', () => {
    const o = opened(barsWithMarks());
    const reset = act(o.state, page(o.load, '8'));
    expect(view(reset).browser?.basket.marks.size).toBe(0);
    expect(view(act(reset, key('escape'))).basket.marks.size).toBe(0);
  });

  it('the first page of the entry fails: the bars with "folder-unavailable"', () => {
    const o = opened(ready());
    const out = step(o.state, loadFailed(o.load, 'folder-unavailable'));
    expect(out.effects).toEqual([]);
    expect(view(out.state)).toMatchObject({
      mode: 'ready',
      browser: null,
      message: 'folder-unavailable',
      opened: true,
      visit: { foldersOpened: 1, mailsLoaded: 0, reconnects: 0 },
      browserToken: view(o.state).browserToken + 1,
    });
  });

  it('that failure while the quit question is open: the bars, the marks kept, the question gone', () => {
    const o = opened(barsWithMarks());
    const asked = act(o.state, ch('q'));
    expect(view(asked).browser?.mode).toBe('confirm-quit');
    const out = step(asked, loadFailed(o.load, 'folder-unavailable'));
    expect(out.effects).toEqual([]);
    expect(view(out.state)).toMatchObject({
      mode: 'ready',
      browser: null,
      message: 'folder-unavailable',
    });
    expect(view(out.state).basket.marks.size).toBe(5);
    // Nothing was answered: y means nothing now, and q asks again.
    expect(step(out.state, ch('y')).effects).toEqual([]);
    const again = step(out.state, ch('q'));
    expect(again.effects).toEqual([]);
    expect(view(again.state).mode).toBe('confirm-quit');
  });

  it('a subfolder that fails goes back to its parent inside the browser', () => {
    const s = browsing(ready(), 'Projects');
    const into = step(s, key('enter'));
    const out = step(into.state, loadFailed(loadIn(into.effects), 'folder-unavailable'));
    expect(view(out.state)).toMatchObject({ mode: 'browsing' });
    expect(view(out.state).browser).toMatchObject({
      path: 'Projects',
      message: { code: 'folder-unavailable' },
    });
    expect(loadIn(out.effects)).toMatchObject({ path: 'Projects', page: 0 });
  });
});

describe('q inside a folder', () => {
  it('without marks: close-mailbox with the live counts, then quit', () => {
    const s = browsing();
    const out = step(s, ch('q'));
    expect(out.effects).toEqual([
      {
        type: 'close-mailbox',
        finish: { opened: true, folders: 1, mails: 5, reconnects: 0, marked: 0, bytes: 0 },
      },
      { type: 'quit' },
    ]);
    expect(view(out.state).mode).toBe('browsing');
  });

  it("with marks the browser asks its own question; y quits with the browser's marks", () => {
    const marked = act(browsing(barsWithMarks(), 'Archive/2023'), key('down'), ch(' '));
    const asked = step(marked, ch('q'));
    expect(asked.effects).toEqual([]);
    expect(view(asked.state)).toMatchObject({ mode: 'browsing' });
    expect(view(asked.state).browser?.mode).toBe('confirm-quit');
    const out = step(asked.state, ch('y'));
    expect(out.effects).toEqual([
      {
        type: 'close-mailbox',
        finish: { opened: true, folders: 2, mails: 9, reconnects: 0, marked: 6, bytes: 600 },
      },
      { type: 'quit' },
    ]);
    const stay = step(asked.state, ch('n'));
    expect(stay.effects).toEqual([]);
    expect(view(stay.state).browser?.mode).toBe('browse');
  });

  it('Esc is never quit in a folder', () => {
    const out = run(browsing(), key('escape'), key('escape'));
    expect(out.effects.map((e) => e.type)).not.toContain('quit');
  });
});

// --- tokens ---------------------------------------------------------------------------------

describe('results of a browser that was left', () => {
  it('a late page of the first browser does not reach the second one', () => {
    const first = opened(ready());
    const bars = act(first.state, key('escape'));
    const second = opened(bars);
    expect(second.load.browserToken).toBe(first.load.browserToken + 2);
    expect(second.load.browserGeneration).toBe(first.load.browserGeneration);
    const late = step(second.state, page(first.load));
    expect(late.state).toBe(second.state);
    expect(late.effects).toEqual([]);
    const now = act(second.state, page(second.load));
    expect(view(now).browser?.view?.snapshot?.exists).toBe(5);
  });

  it('a late failure does not throw the new browser out', () => {
    const first = opened(ready());
    const second = opened(act(first.state, key('escape')));
    const late = step(second.state, loadFailed(first.load, 'folder-unavailable'));
    expect(late.state).toBe(second.state);
    expect(late.effects).toEqual([]);
  });

  it('on the bars a browser result changes nothing, whatever its token', () => {
    const first = opened(ready());
    const bars = act(first.state, key('escape'));
    for (const browserToken of [first.load.browserToken, view(bars).browserToken]) {
      const out = step(bars, { ...page(first.load), browserToken } as AppAction);
      expect(out.state).toBe(bars);
      expect(out.effects).toEqual([]);
    }
  });

  it('a browser result has no generation: the app generation does not drop it', () => {
    const o = opened(ready());
    expect('generation' in page(o.load)).toBe(false);
    expect(view(act(o.state, page(o.load))).browser?.view?.snapshot?.exists).toBe(5);
  });

  it('tokens are never used twice, across folders and across visits of mailboxes', () => {
    const tokens: number[] = [];
    // First visit: two folders, one of them twice.
    let s = ready();
    const firstVisit: LoadPage[] = [];
    for (const path of ['INBOX', 'Projects', 'INBOX']) {
      const o = opened(s, path);
      firstVisit.push(o.load);
      tokens.push(o.load.browserToken);
      s = act(o.state, page(o.load), key('escape'));
    }
    const left = step(s, key('escape'));
    expect(left.state.view.kind).toBe('home');
    // Past every token of the visit, not just one more than before.
    expect(left.state.generation).toBeGreaterThan(Math.max(...tokens));

    // Second visit, the other mailbox.
    let next = act(left.state, key('down'), key('enter'));
    next = act(
      next,
      { type: 'mailbox-reading', generation: next.generation },
      { type: 'mailbox-opened', generation: next.generation, tree: TREE },
    );
    const o = opened(next);
    tokens.push(o.load.browserToken);
    expect(new Set(tokens).size).toBe(tokens.length);
    expect([...tokens].sort((a, b) => a - b)).toEqual(tokens);
    // A page of any browser of the first visit means nothing here.
    for (const load of firstVisit) {
      const late = step(o.state, page(load));
      expect(late.state).toBe(o.state);
      expect(late.effects).toEqual([]);
    }
  });

  it('a visit that opened no folder still ends one generation later', () => {
    const s = ready();
    expect(step(s, key('escape')).state.generation).toBe(s.generation + 1);
  });
});

// --- reconnect ------------------------------------------------------------------------------

describe('a lost connection inside a folder', () => {
  function lost(): { state: AppState; load: LoadPage } {
    const o = opened(ready());
    return { state: act(o.state, loadFailed(o.load, 'connection-lost')), load: o.load };
  }

  it('the browser asks; y and r reconnect under the token, n goes offline', () => {
    const { state } = lost();
    expect(view(state)).toMatchObject({ mode: 'browsing' });
    expect(view(state).browser?.mode).toBe('reconnect-ask');
    for (const letter of ['y', 'r']) {
      const out = step(state, ch(letter));
      expect(out.effects).toEqual([
        { type: 'reconnect-mailbox', browserToken: view(state).browserToken },
      ]);
      expect(view(out.state).browser?.mode).toBe('reconnecting');
    }
    const no = step(state, ch('n'));
    expect(no.effects).toEqual([]);
    expect(view(no.state).browser).toMatchObject({ mode: 'browse', offline: true });
  });

  it('reconnected: the page is read again, the reconnect counted and reported', () => {
    const { state, load } = lost();
    const asked = act(state, ch('y'));
    const out = step(asked, toBrowser(load, { type: 'reconnected' }));
    const reload = loadIn(out.effects);
    expect(out.effects).toHaveLength(1);
    expect(reload).toMatchObject({ path: 'INBOX', page: 0, browserToken: load.browserToken });
    expect(reload.browserGeneration).toBe(load.browserGeneration + 1);
    const loaded = act(out.state, page(reload));
    expect(browseFinishData(view(loaded))).toMatchObject({ reconnects: 1, mails: 5 });
    expect(view(act(loaded, key('escape'))).visit.reconnects).toBe(1);
  });

  it('reconnect-failed: offline in the browser with the text, still in the mailbox', () => {
    const { state, load } = lost();
    const out = step(
      act(state, ch('y')),
      toBrowser(load, { type: 'reconnect-failed', text: 'No.' }),
    );
    expect(out.effects).toEqual([]);
    expect(view(out.state)).toMatchObject({ mode: 'browsing' });
    expect(view(out.state).browser).toMatchObject({
      mode: 'browse',
      offline: true,
      message: { code: 'text', text: 'No.' },
    });
  });

  it('a notice goes to the browser status line', () => {
    const { state, load } = lost();
    const out = act(act(state, ch('y')), toBrowser(load, { type: 'notice', text: 'Waiting.' }));
    expect(view(out).browser?.message).toEqual({ code: 'text', text: 'Waiting.' });
  });

  it('while reconnecting no key leaves; a stale reconnected is dropped', () => {
    const { state, load } = lost();
    const asked = act(state, ch('y'));
    for (const [, back] of BACK_KEYS) {
      const out = step(asked, back);
      expect(out.effects).toEqual([]);
      expect(view(out.state).browser?.mode).toBe('reconnecting');
    }
    // Offline, back on the bars, the folder opened again: the old answer is not for this browser.
    const second = opened(act(state, ch('n'), key('escape')));
    const late = step(second.state, toBrowser(load, { type: 'reconnected' }));
    expect(late.state).toBe(second.state);
    expect(late.effects).toEqual([]);
  });
});

// --- resize while in a folder ---------------------------------------------------------------

describe('a resize inside a folder', () => {
  const MANY = treeOf([folder('INBOX', { messages: 450, bytes: 5000 })]);

  function inBig(): AppState {
    const out = step(ready(MANY), key('enter'));
    const load = loadIn(out.effects);
    const rows: MessageRow[] = [];
    for (let seq = 450; seq > 250; seq--) rows.push(mail(seq));
    return act(
      out.state,
      toBrowser(load, {
        type: 'page-loaded',
        generation: load.browserGeneration,
        path: 'INBOX',
        page: 0,
        result: {
          kind: 'page',
          snapshot: { path: 'INBOX', uidValidity: '7', exists: 450 },
          page: 0,
          rows,
        },
      }),
    );
  }

  it('the app and the browser both get the new size', () => {
    const s = inBig();
    const out = step(s, { type: 'resize', screen: { rows: 12, cols: 60 } });
    expect(out.effects).toEqual([]);
    expect(out.state.screen).toEqual({ rows: 12, cols: 60 });
    expect(view(out.state).browser?.screen).toEqual({ rows: 12, cols: 60 });
    expect(view(out.state).mode).toBe('browsing');
  });

  it('rows that come into view are loaded: the browser effect leaves as load-page', () => {
    const s = inBig();
    const out = step(s, { type: 'resize', screen: { rows: 300, cols: 80 } });
    expect(out.effects).toEqual([
      {
        type: 'load-page',
        browserToken: view(s).browserToken,
        browserGeneration: view(s).browser?.generation,
        path: 'INBOX',
        page: 1,
        expected: { path: 'INBOX', uidValidity: '7', exists: 450 },
      },
    ]);
  });

  it('a size that is not a number is normalised for both', () => {
    const out = step(inBig(), { type: 'resize', screen: { rows: Number.NaN, cols: -3 } });
    expect(out.state.screen).toEqual({ rows: 0, cols: 0 });
    expect(view(out.state).browser?.screen).toEqual({ rows: 0, cols: 0 });
  });
});

// --- browse.finish data ---------------------------------------------------------------------

describe('browseFinishData', () => {
  it('null until a folder was opened', () => {
    for (const s of [connecting(), reading(), ready(), failed()]) {
      expect(browseFinishData(view(s))).toBeNull();
    }
  });

  it('in a folder: the live counts and marks of the browser', () => {
    const s = act(browsing(), ch(' '));
    expect(view(s).basket.marks.size).toBe(0);
    expect(browseFinishData(view(s))).toEqual({
      opened: true,
      folders: 1,
      mails: 5,
      reconnects: 0,
      marked: 1,
      bytes: 100,
    });
  });

  it('on the bars: what the browsers of the visit left behind', () => {
    expect(browseFinishData(view(barsWithMarks()))).toEqual({
      opened: true,
      folders: 1,
      mails: 5,
      reconnects: 0,
      marked: 5,
      bytes: 500,
    });
  });

  it('a folder that was opened but never loaded still counts as opened', () => {
    const o = opened(ready());
    expect(browseFinishData(view(o.state))).toEqual({
      opened: true,
      folders: 1,
      mails: 0,
      reconnects: 0,
      marked: 0,
      bytes: 0,
    });
  });
});

// --- helpers of state.ts --------------------------------------------------------------------

describe('browserKeyOf', () => {
  const k = (type: Exclude<AppKey['type'], 'char'>): AppKey => ({ type });
  const c = (text: string): AppKey => ({ type: 'char', text });

  it.each<[AppKey, BrowserKey, BrowserKey]>([
    [k('up'), 'up', 'up'],
    [k('down'), 'down', 'down'],
    [k('pageup'), 'pageup', 'pageup'],
    [k('pagedown'), 'pagedown', 'pagedown'],
    [k('enter'), 'enter', 'enter'],
    [k('left'), 'back', 'back'],
    [k('backspace'), 'back', 'back'],
    // The one difference: in the app Esc goes back, in `mm folders` it quits.
    [k('escape'), 'back', 'quit'],
    [k('tab'), 'other', 'other'],
    [k('clear'), 'other', 'other'],
    [k('other'), 'other', 'other'],
    [c(' '), 'space', 'space'],
    [c('a'), 'mark-screen', 'mark-screen'],
    [c('A'), 'mark-screen', 'mark-screen'],
    [c('q'), 'quit', 'quit'],
    [c('Q'), 'quit', 'quit'],
    [c('y'), 'yes', 'yes'],
    [c('Y'), 'yes', 'yes'],
    [c('n'), 'no', 'no'],
    [c('N'), 'no', 'no'],
    [c('r'), 'reconnect', 'reconnect'],
    [c('R'), 'reconnect', 'reconnect'],
    [c('o'), 'order', 'other'],
    [c('x'), 'other', 'other'],
    [c('1'), 'other', 'other'],
    [c(''), 'other', 'other'],
    [c('aa'), 'other', 'other'],
    [c('  '), 'other', 'other'],
    [c('\u00e1'), 'other', 'other'],
  ])('%j -> %s embedded, %s on its own', (appKey, embedded, standalone) => {
    expect(browserKeyOf(appKey, true)).toBe(embedded);
    expect(browserKeyOf(appKey, false)).toBe(standalone);
  });
});

describe('asciiText', () => {
  it.each<[string, string]>([
    ['', ''],
    [
      'Plain text, as it is: `mm account list` (y/N) ~1.5 MB',
      'Plain text, as it is: `mm account list` (y/N) ~1.5 MB',
    ],
    ['saved \u2014 see', 'saved - see'],
    ['4\u201336 characters', '4-36 characters'],
    ['wait\u2026', 'wait...'],
    ['\u2018one\u2019 \u201ctwo\u201d', '\'one\' "two"'],
    ['Labels \u2192 Show in IMAP', 'Labels -> Show in IMAP'],
    ['caf\u00e9 \u4e2d\u6587', 'caf? ??'],
    ['a\u{1F600}b', 'a?b'],
    ['bidi \u202e and zero width \u200b', 'bidi ? and zero width ?'],
    ['two\nlines\tand a tab', 'two\nlines\tand a tab'],
  ])('%j -> %j', (text, expected) => {
    expect(asciiText(text)).toBe(expected);
  });

  it('every text a failed login or read can show is ASCII afterwards', () => {
    const account = {
      id: MAILBOXES[0]?.id,
      email: MAILBOXES[0]?.email,
      provider: 'websupport',
    } as Parameters<typeof accountErrorText>[1];
    const errors: unknown[] = [
      new AccountError('duplicate'),
      new AccountError('duplicate', MAILBOXES[1]?.id),
      new AccountError('not-found'),
      new AccountError('secret-unreadable'),
      new AccountError('unsupported'),
      ...IMAP_FAILURE_REASONS.map((reason) => new ImapSessionError(reason)),
      ...MAILBOX_ERROR_CODES.map((code) => new MailboxError(code)),
      new LoginBlockedError('too-many-attempts', new Date(Date.UTC(2026, 9, 5, 12))),
      new LoginBlockedError('too-many-attempts', null),
      new LoginBlockedError('ip-blocked', new Date(Date.UTC(2026, 9, 5, 12))),
      new LoginBlockedError('permanent', null),
      new ConfigError([{ variable: 'MM_MASTER_KEY', problem: 'is missing' }]),
    ];
    let replaced = 0;
    for (const err of errors) {
      for (const text of [errorText(err), accountErrorText(err), accountErrorText(err, account)]) {
        const ascii = asciiText(text);
        expect(ascii).toMatch(/^[\n\x20-\x7e]+$/);
        // The known punctuation got its ASCII form: no "?" was needed.
        expect(ascii.split('?').length).toBe(text.split('?').length);
        if (ascii !== text) replaced += 1;
      }
    }
    // The CLI texts do carry such punctuation (a dash at least): the mapping is exercised.
    expect(replaced).toBeGreaterThan(0);
  });
});
