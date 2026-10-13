import { describe, it, expect } from 'vitest';
import { initialApp, STATS_GMAIL_HIDDEN } from '../../src/cli/app/state.js';
import type {
  AppAction,
  AppEffect,
  AppKey,
  AppReduced,
  AppState,
  MailboxRow,
  MailboxView,
} from '../../src/cli/app/state.js';
import { reduceApp, startApp } from '../../src/cli/app/reduce.js';
import { startStats, statsRowCount } from '../../src/cli/app/mailbox-stats.js';
import type { Screen } from '../../src/cli/browser/state.js';
import type { AuthUser } from '../../src/core/auth.js';
import type { FolderInfo, FolderTree } from '../../src/core/mailbox/folders.js';
import type { MessageRow } from '../../src/core/mailbox/messages.js';
import type { MailboxStats } from '../../src/core/mailbox/stats.js';

// M2d-3 stats state (spec S1, S2, S6, S8 and the stats edge cases): the pure reducer driven the
// way a user does - Enter on a Home mailbox row, the result actions the controller would send,
// then keys. The stats actions carry a statsToken instead of a generation.

const SCREEN: Screen = { rows: 24, cols: 100 };
const SMALL: Screen = { rows: 5, cols: 30 };
const ALICE: AuthUser = { email: 'alice@example.com', userId: 'user-alice' };
const ID1 = '22222222-2222-4222-8222-222222222222';

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

const ROW1: MailboxRow = {
  id: ID1,
  email: 'one@example.com',
  provider: 'websupport',
  lastCheckedAt: null,
};

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

type ReadStats = Extract<AppEffect, { type: 'read-stats' }>;

function readStatsOf(r: AppReduced): ReadStats | undefined {
  return r.effects.find((e): e is ReadStats => e.type === 'read-stats');
}

function types(r: AppReduced): string[] {
  return r.effects.map((e) => e.type);
}

function mailbox(s: AppState): MailboxView {
  if (s.view.kind !== 'mailbox') throw new Error(`expected a mailbox view, got ${s.view.kind}`);
  return s.view;
}

// --- trees and stats ------------------------------------------------------------------------

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

const TREE: FolderTree = treeOf([
  folder('INBOX', { bytes: 100, role: 'inbox', roleSource: 'path' }),
  folder('Sent', { bytes: 400 }),
]);

function years(from: number, to: number): MailboxStats['years'] {
  const out: MailboxStats['years'] = [];
  for (let y = from; y <= to; y++) out.push({ year: String(y), messages: 1, bytes: 100 });
  return out;
}

function ranked(keys: string[], others = 0): MailboxStats['senders'] {
  const rows = keys.map((k, i) => ({ key: k, messages: i + 1, bytes: (i + 1) * 100 }));
  return { byCount: rows, bySize: rows, others: { messages: others, bytes: others * 10 } };
}

function statsOf(over: Partial<MailboxStats> = {}): MailboxStats {
  return {
    folders: [{ path: 'INBOX', messages: 30, bytes: 3000, partial: false }],
    notScanned: 0,
    totals: { messages: 30, bytes: 3000 },
    years: years(1996, 2025),
    senders: ranked(['a@example-test-domain.eu', 'b@example-test-domain.eu']),
    domains: ranked(['example-test-domain.eu']),
    largest: [],
    approximate: false,
    unreadable: 0,
    partial: 0,
    ...over,
  };
}

// --- Home -> bars -> stats ------------------------------------------------------------------

function home(screen: Screen = SCREEN, autoStats = false): AppState {
  const s0 = startApp(initialApp('1.0.0', screen, { autoStats })).state;
  const s1 = act(s0, {
    type: 'session',
    generation: s0.generation,
    user: ALICE,
    remembered: [ALICE.email],
  }).state;
  const s2 = press(s1, ENTER).state;
  return act(s2, { type: 'mailboxes', generation: s2.generation, rows: [ROW1] }).state;
}

/** The result of `mailbox-opened` (effects included) for a mailbox opened from Home. */
function opened(tree: FolderTree = TREE, autoStats = false, screen: Screen = SCREEN): AppReduced {
  const connecting = press(home(screen, autoStats), ENTER).state;
  const reading = act(connecting, {
    type: 'mailbox-reading',
    generation: connecting.generation,
  }).state;
  return act(reading, { type: 'mailbox-opened', generation: reading.generation, tree });
}

function bars(tree: FolderTree = TREE, autoStats = false, screen: Screen = SCREEN): AppState {
  return opened(tree, autoStats, screen).state;
}

/** The bars with a finished read (auto on): the stats result arrived with the right token. */
function barsWithStats(stats: MailboxStats = statsOf(), screen: Screen = SCREEN): AppState {
  const s = bars(TREE, true, screen);
  return act(s, { type: 'stats-ready', statsToken: mailbox(s).statsToken, stats }).state;
}

/** The stats screen (`s` on the bars) with a finished read. */
function statsScreen(stats: MailboxStats = statsOf(), screen: Screen = SCREEN): AppState {
  const s = press(barsWithStats(stats, screen), ch('s')).state;
  expect(mailbox(s).mode).toBe('stats');
  return s;
}

// --- the browser, for marks and folder visits -----------------------------------------------

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

function loadOf(r: AppReduced): LoadPage {
  const load = r.effects.find((e): e is LoadPage => e.type === 'load-page');
  if (load === undefined) throw new Error('no load-page effect');
  return load;
}

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

/** INBOX opened from the bars with its three mails shown. */
function inboxLoaded(s: AppState): AppState {
  const r = press(s, ENTER);
  return act(r.state, pageAnswer(loadOf(r), 3)).state;
}

/** The bars with three marks in the basket (mark screen, then back to the bars). */
function marked(s: AppState): AppState {
  const back = press(inboxLoaded(s), ch('a'), ESC).state;
  expect(mailbox(back).mode).toBe('ready');
  return back;
}

// --- S1: starting the read ------------------------------------------------------------------

describe('S1 the folders arriving start one stats read (autoStats on)', () => {
  it('mailbox-opened gives exactly one read-stats effect carrying the new token and the tree', () => {
    const before = press(home(SCREEN, true), ENTER).state;
    expect(mailbox(before).statsToken).toBe(0);
    const r = opened(TREE, true);
    const v = mailbox(r.state);
    expect(v.mode).toBe('ready');
    expect(v.statsToken).toBe(1);
    expect(v.stats).toEqual({ status: 'reading', progress: null });
    expect(r.effects).toEqual([{ type: 'read-stats', statsToken: 1, tree: TREE }]);
  });

  it('with autoStats off nothing starts: idle, token 0, no effect', () => {
    const r = opened(TREE, false);
    const v = mailbox(r.state);
    expect(v.mode).toBe('ready');
    expect(v.stats).toEqual({ status: 'idle' });
    expect(v.statsToken).toBe(0);
    expect(r.effects).toEqual([]);
  });

  it('autoStats is off by default', () => {
    const s0 = startApp(initialApp('1.0.0', SCREEN)).state;
    const s1 = act(s0, {
      type: 'session',
      generation: s0.generation,
      user: ALICE,
      remembered: [ALICE.email],
    }).state;
    const s2 = press(s1, ENTER).state;
    const h = act(s2, { type: 'mailboxes', generation: s2.generation, rows: [ROW1] }).state;
    const c = press(h, ENTER).state;
    const rd = act(c, { type: 'mailbox-reading', generation: c.generation }).state;
    const r = act(rd, { type: 'mailbox-opened', generation: rd.generation, tree: TREE });
    expect(readStatsOf(r)).toBeUndefined();
    expect(mailbox(r.state).stats).toEqual({ status: 'idle' });
  });

  it('s on the bars with autoStats off starts the read and opens the stats screen', () => {
    const r = press(bars(TREE, false), ch('s'));
    const v = mailbox(r.state);
    expect(v.mode).toBe('stats');
    expect(v.stats).toEqual({ status: 'reading', progress: null });
    expect(v.statsToken).toBe(1);
    expect(r.effects).toEqual([{ type: 'read-stats', statsToken: 1, tree: TREE }]);
  });

  it('s on the bars with a read running or finished only opens the screen: no new read', () => {
    for (const state of [bars(TREE, true), barsWithStats()]) {
      const tokenBefore = mailbox(state).statsToken;
      const r = press(state, ch('s'));
      expect(mailbox(r.state).mode).toBe('stats');
      expect(mailbox(r.state).statsToken).toBe(tokenBefore);
      expect(r.effects).toEqual([]);
    }
  });

  it('s after a failed read opens the screen without a new read (r is the retry)', () => {
    const s = bars(TREE, true);
    const failed = act(s, {
      type: 'stats-failed',
      statsToken: mailbox(s).statsToken,
      text: 'No.',
    }).state;
    const r = press(failed, ch('s'));
    expect(mailbox(r.state).mode).toBe('stats');
    expect(r.effects).toEqual([]);
  });

  it('startStats: a normal tree -> reading, token + 1, one read-stats effect', () => {
    const v = mailbox(bars(TREE, false));
    const r = startStats(v, TREE);
    expect(r.view.stats).toEqual({ status: 'reading', progress: null });
    expect(r.view.statsToken).toBe(v.statsToken + 1);
    expect(r.effects).toEqual([{ type: 'read-stats', statsToken: v.statsToken + 1, tree: TREE }]);
  });
});

// --- S2: Gmail with All Mail hidden ---------------------------------------------------------

describe('S2 Gmail with All Mail hidden', () => {
  const HIDDEN = treeOf(TREE.folders, { gmailAllHidden: true, totals: null });

  it('the text is exactly the one of the spec', () => {
    expect(STATS_GMAIL_HIDDEN).toBe(
      "Stats can't be read - Gmail hides All Mail from IMAP (Labels > Show in IMAP).",
    );
  });

  it('mailbox-opened with autoStats: failed with that text, token + 1, no effect', () => {
    const r = opened(HIDDEN, true);
    const v = mailbox(r.state);
    expect(v.stats).toEqual({ status: 'failed', text: STATS_GMAIL_HIDDEN });
    expect(v.statsToken).toBe(1);
    expect(r.effects).toEqual([]);
  });

  it('s with autoStats off: the same, and the stats screen opens', () => {
    const r = press(bars(HIDDEN, false), ch('s'));
    const v = mailbox(r.state);
    expect(v.mode).toBe('stats');
    expect(v.stats).toEqual({ status: 'failed', text: STATS_GMAIL_HIDDEN });
    expect(r.effects).toEqual([]);
  });

  it('startStats on such a tree: failed, token + 1, no effect', () => {
    const v = mailbox(bars(HIDDEN, false));
    const r = startStats(v, HIDDEN);
    expect(r.view.stats).toEqual({ status: 'failed', text: STATS_GMAIL_HIDDEN });
    expect(r.view.statsToken).toBe(v.statsToken + 1);
    expect(r.effects).toEqual([]);
  });
});

// --- statsRowCount --------------------------------------------------------------------------

describe('statsRowCount', () => {
  const s = statsOf({
    years: years(2022, 2024),
    senders: {
      bySize: [1, 2, 3, 4].map((n) => ({ key: `s${String(n)}`, messages: n, bytes: n })),
      byCount: [1, 2].map((n) => ({ key: `c${String(n)}`, messages: n, bytes: n })),
      others: { messages: 5, bytes: 50 },
    },
    domains: {
      bySize: [1, 2, 3].map((n) => ({ key: `d${String(n)}`, messages: n, bytes: n })),
      byCount: [1, 2, 3, 4, 5].map((n) => ({ key: `e${String(n)}`, messages: n, bytes: n })),
      others: { messages: 0, bytes: 0 },
    },
    largest: [1, 2, 3, 4, 5, 6].map((n) => ({
      folder: 'INBOX',
      received: null,
      from: null,
      subject: null,
      bytes: n,
    })),
  });

  it('years: one row per year, by size or by messages', () => {
    expect(statsRowCount(s, 'years', 'size')).toBe(3);
    expect(statsRowCount(s, 'years', 'messages')).toBe(3);
  });

  it('senders: the chosen list, plus the others row when others.messages > 0', () => {
    expect(statsRowCount(s, 'senders', 'size')).toBe(5);
    expect(statsRowCount(s, 'senders', 'messages')).toBe(3);
  });

  it('domains: the chosen list, no others row when there are none', () => {
    expect(statsRowCount(s, 'domains', 'size')).toBe(3);
    expect(statsRowCount(s, 'domains', 'messages')).toBe(5);
  });

  it('largest: one row per mail, whatever the order', () => {
    expect(statsRowCount(s, 'largest', 'size')).toBe(6);
    expect(statsRowCount(s, 'largest', 'messages')).toBe(6);
  });
});

// --- S6: keys on the stats screen -----------------------------------------------------------

describe('S6 keys on the stats screen', () => {
  it('the screen starts at Years, by size, at the top', () => {
    const v = mailbox(statsScreen());
    expect(v.statsSection).toBe('years');
    expect(v.statsBy).toBe('size');
    expect(v.statsTop).toBe(0);
  });

  it.each([
    ['1', 'years'],
    ['2', 'senders'],
    ['3', 'domains'],
    ['4', 'largest'],
  ] as const)('%s chooses the section %s', (k, section) => {
    const r = press(statsScreen(), ch('3'), ch(k));
    expect(mailbox(r.state).statsSection).toBe(section);
    expect(mailbox(r.state).mode).toBe('stats');
    expect(r.effects).toEqual([]);
  });

  it('o switches by size <-> by messages in years, senders and domains', () => {
    for (const k of ['1', '2', '3']) {
      const s = press(statsScreen(), ch(k)).state;
      const once = press(s, ch('o')).state;
      expect(mailbox(once).statsBy).toBe('messages');
      expect(mailbox(press(once, ch('o')).state).statsBy).toBe('size');
    }
  });

  it('o has no effect in Largest mails', () => {
    const s = press(statsScreen(), ch('4')).state;
    const r = press(s, ch('o'));
    expect(mailbox(r.state).statsBy).toBe('size');
    expect(mailbox(r.state).statsSection).toBe('largest');
    expect(mailbox(r.state).statsTop).toBe(0);
    expect(r.effects).toEqual([]);
  });

  it('Down and Up scroll one row at a time and are clamped at the top', () => {
    let s = statsScreen();
    s = press(s, UP).state;
    expect(mailbox(s).statsTop).toBe(0);
    s = press(s, DOWN).state;
    expect(mailbox(s).statsTop).toBe(1);
    s = press(s, DOWN, DOWN).state;
    expect(mailbox(s).statsTop).toBe(3);
    s = press(s, UP).state;
    expect(mailbox(s).statsTop).toBe(2);
  });

  it('scrolling is clamped at the end: never past the last row, and back up reaches 0', () => {
    const rows = statsRowCount(statsOf(), 'years', 'size');
    let s = statsScreen();
    s = press(s, ...Array.from({ length: 500 }, () => DOWN)).state;
    const end = mailbox(s).statsTop;
    expect(end).toBeGreaterThan(0);
    expect(end).toBeLessThanOrEqual(rows - 1);
    s = press(s, DOWN, DOWN, PGDN).state;
    expect(mailbox(s).statsTop).toBe(end);
    s = press(s, ...Array.from({ length: 500 }, () => UP)).state;
    expect(mailbox(s).statsTop).toBe(0);
  });

  it('PgDn / PgUp scroll by more than one row and are clamped too', () => {
    const s = statsScreen();
    const one = mailbox(press(s, DOWN).state).statsTop;
    const page = mailbox(press(s, PGDN).state).statsTop;
    expect(page).toBeGreaterThan(one);
    const back = press(
      press(s, PGDN, PGDN, PGDN, PGDN, PGDN, PGDN).state,
      ...Array.from({ length: 12 }, () => PGUP),
    );
    expect(mailbox(back.state).statsTop).toBe(0);
  });

  it('a new section or o starts at the top again', () => {
    const scrolled = press(statsScreen(), DOWN, DOWN, DOWN).state;
    expect(mailbox(scrolled).statsTop).toBe(3);
    expect(mailbox(press(scrolled, ch('2')).state).statsTop).toBe(0);
    expect(mailbox(press(scrolled, ch('o')).state).statsTop).toBe(0);
  });

  it('keys that mean nothing change nothing', () => {
    const s = statsScreen();
    const r = press(s, ch('x'), ch('5'), ch('0'), key('other'), key('tab'), ENTER);
    expect(r.state).toEqual(s);
    expect(r.effects).toEqual([]);
  });

  it('r after a finished read starts a new one: one read-stats with the next token', () => {
    const s = statsScreen();
    const before = mailbox(s).statsToken;
    const r = press(s, ch('r'));
    expect(mailbox(r.state).stats).toEqual({ status: 'reading', progress: null });
    expect(mailbox(r.state).statsToken).toBe(before + 1);
    expect(mailbox(r.state).mode).toBe('stats');
    expect(r.effects).toEqual([{ type: 'read-stats', statsToken: before + 1, tree: TREE }]);
  });

  it('r after a failed read starts a new one', () => {
    const s0 = press(bars(TREE, true), ch('s')).state;
    const token = mailbox(s0).statsToken;
    const failed = act(s0, { type: 'stats-failed', statsToken: token, text: 'Nope.' }).state;
    const r = press(failed, ch('r'));
    expect(mailbox(r.state).stats).toEqual({ status: 'reading', progress: null });
    expect(readStatsOf(r)?.statsToken).toBe(token + 1);
  });

  it('r while a read runs does nothing; pressed twice quickly only the first counts', () => {
    const s = press(statsScreen(), ch('r')).state;
    const again = press(s, ch('r'));
    expect(again.state).toEqual(s);
    expect(again.effects).toEqual([]);
    const twice = press(statsScreen(), ch('r'), ch('r'));
    expect(twice.effects.filter((e) => e.type === 'read-stats')).toHaveLength(1);
  });

  it.each([
    ['Esc', ESC],
    ['Left', LEFT],
    ['Backspace', BACKSPACE],
  ])('%s returns to the bars; the read goes on, section and order are remembered', (_n, k) => {
    let s = press(statsScreen(), ch('3'), ch('o')).state;
    const r = press(s, k);
    expect(mailbox(r.state).mode).toBe('ready');
    expect(mailbox(r.state).stats).toEqual(mailbox(s).stats);
    expect(r.effects).toEqual([]);
    s = press(r.state, ch('s')).state;
    expect(mailbox(s).statsSection).toBe('domains');
    expect(mailbox(s).statsBy).toBe('messages');
  });

  it('Esc while the read is still running does not stop it (no effect, still reading)', () => {
    const s = press(bars(TREE, true), ch('s')).state;
    const r = press(s, ESC);
    expect(mailbox(r.state).stats.status).toBe('reading');
    expect(r.effects).toEqual([]);
  });

  it('q without marks closes the mailbox and quits', () => {
    expect(press(statsScreen(), ch('q')).effects).toEqual([
      { type: 'close-mailbox', finish: null },
      { type: 'quit' },
    ]);
  });

  it('q with marks asks first; y closes and quits with the marks counted', () => {
    const withMarks = press(marked(barsWithStats()), ch('s')).state;
    expect(mailbox(withMarks).mode).toBe('stats');
    const asked = press(withMarks, ch('q'));
    expect(mailbox(asked.state).mode).toBe('confirm-quit');
    expect(asked.effects).toEqual([]);
    const done = press(asked.state, ch('y'));
    expect(types(done)).toEqual(['close-mailbox', 'quit']);
    const close = done.effects.find((e) => e.type === 'close-mailbox');
    expect(close).toMatchObject({ finish: { marked: 3 } });
  });

  it('q with marks, then another key: back on the bars with the marks, nothing closed', () => {
    const withMarks = press(marked(barsWithStats()), ch('s'), ch('q')).state;
    const r = press(withMarks, ch('n'));
    expect(mailbox(r.state).mode).toBe('ready');
    expect(mailbox(r.state).basket.marks.size).toBe(3);
    expect(r.effects).toEqual([]);
  });

  it('window too small: only q acts on the stats screen', () => {
    const small = act(statsScreen(), { type: 'resize', screen: SMALL }).state;
    const r = press(
      small,
      DOWN,
      UP,
      PGDN,
      ch('1'),
      ch('2'),
      ch('o'),
      ch('r'),
      ESC,
      LEFT,
      BACKSPACE,
      ENTER,
    );
    expect(r.state).toEqual(small);
    expect(r.effects).toEqual([]);
    expect(types(press(small, ch('q')))).toEqual(['close-mailbox', 'quit']);
  });

  it('a resize keeps the section, the order and the scroll position', () => {
    const s = press(statsScreen(), ch('o'), DOWN, DOWN).state;
    const r = act(s, { type: 'resize', screen: { rows: 10, cols: 50 } }).state;
    expect(mailbox(r).mode).toBe('stats');
    expect(mailbox(r).statsBy).toBe('messages');
    expect(mailbox(r).statsTop).toBe(2);
  });
});

// --- S8: results and their lifetime ---------------------------------------------------------

describe('S8 the stats result actions', () => {
  it('stats-progress while reading stores the progress', () => {
    const s = bars(TREE, true);
    const token = mailbox(s).statsToken;
    const progress = { folder: 3, folders: 12, done: 5000, total: 12345 };
    const r = act(s, { type: 'stats-progress', statsToken: token, progress });
    expect(mailbox(r.state).stats).toEqual({ status: 'reading', progress });
    expect(r.effects).toEqual([]);
  });

  it('stats-ready stores the stats; stats-failed stores the text', () => {
    const s = bars(TREE, true);
    const token = mailbox(s).statsToken;
    const stats = statsOf();
    expect(mailbox(act(s, { type: 'stats-ready', statsToken: token, stats }).state).stats).toEqual({
      status: 'ready',
      stats,
    });
    expect(
      mailbox(act(s, { type: 'stats-failed', statsToken: token, text: 'Broke.' }).state).stats,
    ).toEqual({ status: 'failed', text: 'Broke.' });
  });

  it('a result with another token (an earlier read) changes nothing', () => {
    const s = bars(TREE, true);
    const token = mailbox(s).statsToken;
    for (const action of [
      {
        type: 'stats-progress',
        statsToken: token - 1,
        progress: { folder: 1, folders: 2, done: 1, total: 2 },
      },
      { type: 'stats-ready', statsToken: token - 1, stats: statsOf() },
      { type: 'stats-failed', statsToken: token + 1, text: 'late' },
    ] satisfies AppAction[]) {
      const r = act(s, action);
      expect(r.state).toEqual(s);
      expect(r.effects).toEqual([]);
    }
  });

  it('a result of the read before r changes nothing', () => {
    const s = statsScreen();
    const oldToken = mailbox(s).statsToken;
    const again = press(s, ch('r')).state;
    for (const action of [
      { type: 'stats-ready', statsToken: oldToken, stats: statsOf({ years: [] }) },
      { type: 'stats-failed', statsToken: oldToken, text: 'late' },
    ] satisfies AppAction[]) {
      expect(act(again, action).state).toEqual(again);
    }
  });

  it('progress is only taken while reading', () => {
    const s = barsWithStats();
    const r = act(s, {
      type: 'stats-progress',
      statsToken: mailbox(s).statsToken,
      progress: { folder: 1, folders: 2, done: 1, total: 2 },
    });
    expect(r.state).toEqual(s);
  });

  it('a result arriving in any mode is stored and nothing else changes', () => {
    const base = bars(TREE, true);
    const token = mailbox(base).statsToken;
    const stats = statsOf();
    const modes: [string, AppState][] = [
      ['browsing', inboxLoaded(base)],
      ['confirm-leave', press(marked(base), ESC).state],
      ['confirm-quit', press(marked(base), ch('q')).state],
      ['stats', press(base, ch('s')).state],
    ];
    for (const [name, s] of modes) {
      const before = mailbox(s);
      const r = act(s, { type: 'stats-ready', statsToken: token, stats });
      const after = mailbox(r.state);
      expect(after.stats, name).toEqual({ status: 'ready', stats });
      expect(after.mode, name).toBe(before.mode);
      expect(after.browser, name).toEqual(before.browser);
      expect(after.basket.marks.size, name).toBe(before.basket.marks.size);
      expect(r.effects, name).toEqual([]);
    }
  });

  it('opening a folder, marking and leaving it do not touch the stats', () => {
    const base = barsWithStats();
    const before = mailbox(base);
    const back = marked(base);
    expect(mailbox(back).stats).toEqual(before.stats);
    expect(mailbox(back).statsToken).toBe(before.statsToken);
    const again = press(back, ENTER, ESC).state;
    expect(mailbox(again).stats).toEqual(before.stats);
    expect(mailbox(again).statsToken).toBe(before.statsToken);
  });

  it('a lost connection and a reconnect inside the browser do not touch the stats', () => {
    const base = barsWithStats();
    const r = press(base, ENTER);
    const load = loadOf(r);
    const lost = act(r.state, {
      type: 'browser',
      browserToken: load.browserToken,
      action: {
        type: 'load-failed',
        generation: load.browserGeneration,
        path: load.path,
        page: 0,
        code: 'connection-lost',
      },
    }).state;
    const asked = press(lost, ch('y')).state;
    const done = act(asked, {
      type: 'browser',
      browserToken: mailbox(asked).browserToken,
      action: { type: 'reconnected' },
    }).state;
    expect(mailbox(done).stats).toEqual(mailbox(base).stats);
    expect(mailbox(done).statsToken).toBe(mailbox(base).statsToken);
  });

  it('leaving the mailbox drops the stats: Home again, and a late result changes nothing', () => {
    const s = bars(TREE, true);
    const token = mailbox(s).statsToken;
    const left = press(s, ESC).state;
    expect(left.view.kind).toBe('home');
    const r = act(left, { type: 'stats-ready', statsToken: token, stats: statsOf() });
    expect(r.state).toEqual(left);
    expect(r.effects).toEqual([]);
  });

  it('a new visit starts with fresh stats (idle, or a new read), not the old ones', () => {
    const left = press(barsWithStats(), ESC).state;
    const again = press(left, ENTER).state;
    expect(mailbox(again).stats).toEqual({ status: 'idle' });
    expect(mailbox(again).statsSection).toBe('years');
    expect(mailbox(again).statsBy).toBe('size');
    expect(mailbox(again).statsTop).toBe(0);
  });

  it('r on the failed login screen resets the stats and bumps the token', () => {
    const c = press(home(SCREEN, true), ENTER).state;
    const rd = act(c, { type: 'mailbox-reading', generation: c.generation }).state;
    const failed = act(rd, { type: 'mailbox-failed', generation: rd.generation, text: 'x' }).state;
    const before = mailbox(failed);
    const r = press(failed, ch('r'));
    expect(mailbox(r.state).mode).toBe('connecting');
    expect(mailbox(r.state).stats).toEqual({ status: 'idle' });
    expect(mailbox(r.state).statsToken).toBeGreaterThan(before.statsToken);
    // A result of an earlier read cannot be taken for the retry's.
    const late = act(r.state, {
      type: 'stats-ready',
      statsToken: before.statsToken,
      stats: statsOf(),
    });
    expect(late.state).toEqual(r.state);
  });

  it('after r on the failed screen the folders arriving start a new read with a fresh token', () => {
    const c = press(home(SCREEN, true), ENTER).state;
    const rd = act(c, { type: 'mailbox-reading', generation: c.generation }).state;
    const failed = act(rd, { type: 'mailbox-failed', generation: rd.generation, text: 'x' }).state;
    const retry = press(failed, ch('r')).state;
    const rd2 = act(retry, { type: 'mailbox-reading', generation: retry.generation }).state;
    const r = act(rd2, { type: 'mailbox-opened', generation: rd2.generation, tree: TREE });
    const effect = readStatsOf(r);
    expect(effect).toBeDefined();
    expect(effect?.statsToken).toBe(mailbox(r.state).statsToken);
    expect(effect?.tree).toBe(TREE);
  });
});
