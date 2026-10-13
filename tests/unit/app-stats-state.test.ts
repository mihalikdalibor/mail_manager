import { describe, it, expect } from 'vitest';
import {
  STATS_FIXED_LINES,
  rankedRows,
  startStats,
  statsKey,
  statsResult,
  statsRoom,
  statsRowCount,
  statsSummary,
} from '../../src/cli/app/mailbox-stats.js';
import { browseFinishData } from '../../src/cli/app/mailbox.js';
import { reduceApp, startApp } from '../../src/cli/app/reduce.js';
import { STATS_GMAIL_HIDDEN, initialApp, mailboxView } from '../../src/cli/app/state.js';
import type {
  AppAction,
  AppEffect,
  AppKey,
  AppReduced,
  AppState,
  MailboxMode,
  MailboxRow,
  MailboxView,
  StatsBy,
  StatsRead,
  StatsSection,
} from '../../src/cli/app/state.js';
import { bodyHeight } from '../../src/cli/browser/state.js';
import type { BrowserAction, Screen } from '../../src/cli/browser/state.js';
import type { AuthUser } from '../../src/core/auth.js';
import type { FolderInfo, FolderTree, SizeProgress } from '../../src/core/mailbox/folders.js';
import type { MessageRow } from '../../src/core/mailbox/messages.js';
import type { MailboxStats, RankedRow } from '../../src/core/mailbox/stats.js';

// M2d-3 stats of a mailbox, state: startStats, the folders arriving with autoStats on and off,
// `s` on the bars, every key of the stats screen, what a read reports in every mode of the
// mailbox screen, the token that drops an earlier read, and `r` on the failed screen - through
// reduceApp, plus the functions of mailbox-stats.ts on their own. Every step proves that the
// state it was given is untouched. Addresses are placeholders.

// --- fixtures -------------------------------------------------------------------------------

const ANNA: AuthUser = { email: 'anna@example-test-domain.eu', userId: 'user-anna' };
const SCREEN: Screen = { rows: 24, cols: 80 }; // 20 rows of a section
const TOO_SMALL: Screen = { rows: 7, cols: 80 };
const ROW: MailboxRow = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'box@example-test-domain.eu',
  provider: 'websupport',
  lastCheckedAt: null,
};

function folder(path: string, over: Partial<FolderInfo> = {}): FolderInfo {
  return {
    path,
    name: path,
    parentPath: null,
    depth: 0,
    delimiter: '/',
    role: null,
    roleSource: null,
    selectable: true,
    subscribed: true,
    messages: 3,
    unseen: 0,
    bytes: 1000,
    sizeSource: 'server',
    overlapping: false,
    ...over,
  };
}

function treeOf(over: Partial<FolderTree> = {}): FolderTree {
  return {
    folders: [folder('INBOX'), folder('Sent')],
    totals: { messages: 6, unseen: 0, bytes: 2000, sizeSource: 'server' },
    quota: null,
    truncated: false,
    unreadable: 0,
    gmailAllHidden: false,
    fallbacks: new Set(),
    ...over,
  };
}

const TREE = treeOf();
const GMAIL_HIDDEN = treeOf({ totals: null, gmailAllHidden: true });
const TRUNCATED = treeOf({ truncated: true });

function ranked(n: number, key: (i: number) => string): RankedRow[] {
  return Array.from({ length: n }, (_, i) => ({ key: key(i), messages: n - i, bytes: 100 * i }));
}

/** 30 years, 4 senders (and `others`), 2 domains, 3 largest mails. */
function statsOf(over: Partial<MailboxStats> = {}): MailboxStats {
  const senders = ranked(4, (i) => `sender${String(i)}@example-test-domain.eu`);
  const domains = ranked(2, (i) => `domain${String(i)}.example-test-domain.eu`);
  return {
    folders: [
      { path: 'INBOX', messages: 40, bytes: 4000, partial: false },
      { path: 'Sent', messages: 20, bytes: 2000, partial: false },
    ],
    notScanned: 0,
    totals: { messages: 60, bytes: 6000 },
    years: Array.from({ length: 30 }, (_, i) => ({
      year: String(1995 + i),
      messages: 2,
      bytes: 200,
    })),
    senders: {
      byCount: senders,
      bySize: [...senders].reverse(),
      others: { messages: 7, bytes: 70 },
    },
    domains: {
      byCount: domains,
      bySize: [...domains].reverse(),
      others: { messages: 0, bytes: 0 },
    },
    largest: [3, 2, 1].map((n) => ({
      folder: 'INBOX',
      received: new Date(Date.UTC(2024, 0, n)),
      from: `Sender ${String(n)}`,
      subject: `Subject ${String(n)}`,
      bytes: n * 1000,
    })),
    approximate: true,
    unreadable: 0,
    partial: 0,
    ...over,
  };
}

const STATS = statsOf();
const PROGRESS: SizeProgress = { folder: 3, folders: 12, done: 5000, total: 12_345 };

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

function view(state: AppState): MailboxView {
  if (state.view.kind !== 'mailbox') throw new Error(`not on a mailbox: ${state.view.kind}`);
  return state.view;
}

/** The stats part of a view: what a visit keeps of them. */
function kept(
  state: AppState,
): Pick<MailboxView, 'stats' | 'statsToken' | 'statsSection' | 'statsBy' | 'statsTop'> {
  const { stats, statsToken, statsSection, statsBy, statsTop } = view(state);
  return { stats, statsToken, statsSection, statsBy, statsTop };
}

interface Options {
  screen?: Screen;
  autoStats?: boolean;
  tree?: FolderTree;
}

/** Home of ANNA with her one mailbox. */
function atHome(o: Options = {}): AppState {
  const options = o.autoStats === undefined ? {} : { autoStats: o.autoStats };
  const s0 = startApp(initialApp('1.2.3', o.screen ?? SCREEN, options)).state;
  const s1 = act(
    s0,
    { type: 'session', generation: s0.generation, user: ANNA, remembered: [ANNA.email] },
    key('enter'),
  );
  return act(s1, { type: 'mailboxes', generation: s1.generation, rows: [ROW] });
}

function reading(o: Options = {}): AppState {
  const s = act(atHome(o), key('enter'));
  return act(s, { type: 'mailbox-reading', generation: s.generation });
}

/** The bars; with `autoStats` the read (token 1) is under way. */
function bars(o: Options = {}): AppState {
  const s = reading(o);
  return act(s, { type: 'mailbox-opened', generation: s.generation, tree: o.tree ?? TREE });
}

function failed(o: Options = {}): AppState {
  const s = reading(o);
  return act(s, { type: 'mailbox-failed', generation: s.generation, text: 'It did not work.' });
}

/** What the read that is under way reports. */
function progress(state: AppState, p: SizeProgress = PROGRESS): AppAction {
  return { type: 'stats-progress', statsToken: view(state).statsToken, progress: p };
}

function arrived(state: AppState, stats: MailboxStats = STATS): AppAction {
  return { type: 'stats-ready', statsToken: view(state).statsToken, stats };
}

function refused(state: AppState, text = 'The read failed.'): AppAction {
  return { type: 'stats-failed', statsToken: view(state).statsToken, text };
}

/** The stats screen with the read still under way. */
function statsReading(o: Options = {}): AppState {
  return act(bars({ autoStats: true, ...o }), ch('s'));
}

/** The stats screen with the stats there. */
function statsReady(stats: MailboxStats = STATS, o: Options = {}): AppState {
  const s = statsReading(o);
  return act(s, arrived(s, stats));
}

function statsFailed(o: Options = {}): AppState {
  const s = statsReading(o);
  return act(s, refused(s));
}

type LoadPage = Extract<AppEffect, { type: 'load-page' }>;

function toBrowser(load: LoadPage, action: BrowserAction): AppAction {
  return { type: 'browser', browserToken: load.browserToken, action };
}

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

/** Enter on INBOX from the bars: the browser with its three mails. */
function browsing(state: AppState): AppState {
  const out = step(state, key('enter'));
  const load = out.effects.find((e): e is LoadPage => e.type === 'load-page');
  if (load === undefined) throw new Error('no load-page effect');
  return act(
    out.state,
    toBrowser(load, {
      type: 'page-loaded',
      generation: load.browserGeneration,
      path: load.path,
      page: 0,
      result: {
        kind: 'page',
        snapshot: { path: load.path, uidValidity: '7', exists: 3 },
        page: 0,
        rows: [3, 2, 1].map(mail),
      },
    }),
  );
}

/** The bars again, the three mails of INBOX marked. */
function barsWithMarks(o: Options = {}): AppState {
  const s = act(browsing(bars(o)), ch('a'), key('escape'));
  expect(view(s).basket.marks.size).toBe(3);
  return s;
}

/** Every mode a result can arrive in, the read (token 1) under way in each. */
const MODES: [MailboxMode, () => AppState][] = [
  ['ready', () => bars({ autoStats: true })],
  ['stats', () => statsReading()],
  ['browsing', () => browsing(bars({ autoStats: true }))],
  ['confirm-leave', () => act(barsWithMarks({ autoStats: true }), key('escape'))],
  ['confirm-quit', () => act(barsWithMarks({ autoStats: true }), ch('q'))],
];

// --- the pieces -----------------------------------------------------------------------------

describe('initialApp options', () => {
  it('by default the stats wait for `s`, and a mailbox can be added', () => {
    const state = initialApp('1.2.3', SCREEN);
    expect(state.autoStats).toBe(false);
    expect(state.addProblem).toBeNull();
    expect(initialApp('1.2.3', SCREEN, {})).toEqual(state);
  });

  it('autoStats and addProblem are taken as given', () => {
    const state = initialApp('1.2.3', SCREEN, { autoStats: true, addProblem: 'No key.' });
    expect(state.autoStats).toBe(true);
    expect(state.addProblem).toBe('No key.');
    expect({ ...state, autoStats: false, addProblem: null }).toEqual(initialApp('1.2.3', SCREEN));
  });

  it('a fresh mailbox view has no stats yet: the years by size, from the top', () => {
    const home = atHome().view;
    if (home.kind !== 'home') throw new Error('not on Home');
    expect(mailboxView(ROW, home, 7)).toMatchObject({
      stats: { status: 'idle' },
      statsToken: 0,
      statsSection: 'years',
      statsBy: 'size',
      statsTop: 0,
    });
  });
});

describe('startStats', () => {
  it('a new token, "reading" without progress, and one read-stats effect with the tree', () => {
    const v = view(bars());
    const before = structuredClone(v);
    const out = startStats(v, TREE);
    expect(out.effects).toEqual([{ type: 'read-stats', statsToken: 1, tree: TREE }]);
    expect(out.view).toEqual({
      ...v,
      stats: { status: 'reading', progress: null },
      statsToken: 1,
    });
    expect(v).toEqual(before);
  });

  it('every start is one token further', () => {
    const first = startStats(view(bars()), TREE);
    const second = startStats(first.view, TREE);
    expect(second.view.statsToken).toBe(2);
    expect(second.effects).toEqual([{ type: 'read-stats', statsToken: 2, tree: TREE }]);
  });

  it('Gmail with All Mail hidden: its text at once, a new token, nothing to read', () => {
    const v = view(bars());
    const out = startStats(v, GMAIL_HIDDEN);
    expect(out.effects).toEqual([]);
    expect(out.view).toEqual({
      ...v,
      stats: { status: 'failed', text: STATS_GMAIL_HIDDEN },
      statsToken: 1,
    });
    expect(STATS_GMAIL_HIDDEN).toBe(
      "Stats can't be read - Gmail hides All Mail from IMAP (Labels > Show in IMAP).",
    );
  });
});

describe('statsRowCount and statsRoom', () => {
  it('the rows of each section; a top list counts `others` when it has any', () => {
    expect(statsRowCount(STATS, 'years', 'size')).toBe(30);
    expect(statsRowCount(STATS, 'years', 'messages')).toBe(30);
    expect(statsRowCount(STATS, 'senders', 'size')).toBe(5);
    expect(statsRowCount(STATS, 'senders', 'messages')).toBe(5);
    expect(statsRowCount(STATS, 'domains', 'size')).toBe(2);
    expect(statsRowCount(STATS, 'largest', 'size')).toBe(3);
    expect(statsRowCount(STATS, 'largest', 'messages')).toBe(3);
  });

  it('the two orders of a top list are counted on their own', () => {
    const stats = statsOf({
      senders: {
        byCount: ranked(3, (i) => `c${String(i)}`),
        bySize: ranked(1, () => 's'),
        others: { messages: 0, bytes: 0 },
      },
    });
    expect(statsRowCount(stats, 'senders', 'messages')).toBe(3);
    expect(statsRowCount(stats, 'senders', 'size')).toBe(1);
    expect(rankedRows(stats.senders, 'messages')).toBe(stats.senders.byCount);
    expect(rankedRows(stats.senders, 'size')).toBe(stats.senders.bySize);
  });

  it('an empty mailbox has no rows anywhere', () => {
    const none = { byCount: [], bySize: [], others: { messages: 0, bytes: 0 } };
    const empty = statsOf({ years: [], senders: none, domains: none, largest: [] });
    for (const section of ['years', 'senders', 'domains', 'largest'] as const) {
      expect(statsRowCount(empty, section, 'size')).toBe(0);
    }
  });

  it('the room of a section: the body without the summary line, at least one row', () => {
    expect(STATS_FIXED_LINES).toBe(1);
    expect(statsRoom(SCREEN)).toBe(bodyHeight(SCREEN) - 1);
    expect(statsRoom(SCREEN)).toBe(20);
    expect(statsRoom({ rows: 8, cols: 40 })).toBe(4);
    expect(statsRoom({ rows: 3, cols: 40 })).toBe(1);
  });

  it('the summary takes its lines from the room: two at 40 columns, one at 80', () => {
    const four = statsOf({ unreadable: 2, partial: 4, notScanned: 7 });
    expect(statsRoom({ rows: 8, cols: 40 }, STATS)).toBe(3);
    expect(statsRoom({ rows: 8, cols: 40 }, four)).toBe(1);
    expect(statsRoom(SCREEN, STATS)).toBe(20);
  });

  it('statsSummary: lines of the width, at most the body less one row', () => {
    const four = statsOf({ unreadable: 2, partial: 4, notScanned: 7 });
    const whole =
      "Scanned 2 folders, 60 messages, 5.9 KB (approx.), 2 folders couldn't be read, " +
      '4 folders read only partly, 7 folders skipped (counted elsewhere)';
    expect(statsSummary(STATS, 80, 21)).toEqual([
      'Scanned 2 folders, 60 messages, 5.9 KB (approx.)',
    ]);
    expect(statsSummary(STATS, 40, 5)).toEqual([
      'Scanned 2 folders, 60 messages, 5.9 KB',
      '(approx.)',
    ]);
    expect(statsSummary(four, 40, 5)).toHaveLength(4);
    // A body of three lines: the summary takes two, the rest of it is joined to the second.
    expect(statsSummary(four, 40, 3)).toEqual([
      'Scanned 2 folders, 60 messages, 5.9 KB',
      "(approx.), 2 folders couldn't be read, 4 folders read only partly, " +
        '7 folders skipped (counted elsewhere)',
    ]);
    // A body of one line or none: the whole of it on one line.
    expect(statsSummary(four, 40, 1)).toEqual([whole]);
    expect(statsSummary(four, 40, 0)).toEqual([whole]);
  });
});

// --- the folders arrive ---------------------------------------------------------------------

describe('the folders arrive (mailbox-opened)', () => {
  it('autoStats off (the default): the bars, nothing is started', () => {
    for (const s of [reading(), reading({ autoStats: false })]) {
      const out = step(s, { type: 'mailbox-opened', generation: s.generation, tree: TREE });
      expect(out.effects).toEqual([]);
      expect(view(out.state)).toMatchObject({ mode: 'ready', tree: TREE });
      expect(kept(out.state)).toEqual(kept(s));
      expect(view(out.state).stats).toEqual({ status: 'idle' });
    }
  });

  it('autoStats on: the bars, and one read starts behind them', () => {
    const s = reading({ autoStats: true });
    const out = step(s, { type: 'mailbox-opened', generation: s.generation, tree: TREE });
    expect(out.effects).toEqual([{ type: 'read-stats', statsToken: 1, tree: TREE }]);
    expect(out.state).toEqual({
      ...s,
      view: {
        ...view(s),
        mode: 'ready',
        tree: TREE,
        stats: { status: 'reading', progress: null },
        statsToken: 1,
      },
    });
  });

  it('autoStats on, straight from "Connecting...": the same', () => {
    const s = act(atHome({ autoStats: true }), key('enter'));
    const out = step(s, { type: 'mailbox-opened', generation: s.generation, tree: TREE });
    expect(out.effects.map((e) => e.type)).toEqual(['read-stats']);
  });

  it('autoStats on, more than 5,000 folders: the read starts and the note of the bars stays', () => {
    const s = reading({ autoStats: true });
    const out = step(s, { type: 'mailbox-opened', generation: s.generation, tree: TRUNCATED });
    expect(out.effects).toEqual([{ type: 'read-stats', statsToken: 1, tree: TRUNCATED }]);
    expect(view(out.state).message).toBe('truncated');
  });

  it('autoStats on, Gmail with All Mail hidden: no read, the stats say why', () => {
    const s = reading({ autoStats: true });
    const out = step(s, { type: 'mailbox-opened', generation: s.generation, tree: GMAIL_HIDDEN });
    expect(out.effects).toEqual([]);
    expect(kept(out.state)).toEqual({
      ...kept(s),
      stats: { status: 'failed', text: STATS_GMAIL_HIDDEN },
      statsToken: 1,
    });
  });

  it('folders that arrive a second time, or for an older request, start nothing', () => {
    const s = bars({ autoStats: true });
    const again = step(s, { type: 'mailbox-opened', generation: s.generation, tree: TREE });
    expect(again.state).toBe(s);
    expect(again.effects).toEqual([]);
    const waiting = reading({ autoStats: true });
    const stale = step(waiting, {
      type: 'mailbox-opened',
      generation: waiting.generation - 1,
      tree: TREE,
    });
    expect(stale.state).toBe(waiting);
    expect(stale.effects).toEqual([]);
  });
});

// --- s on the bars --------------------------------------------------------------------------

describe('s on the bars', () => {
  it.each(['s', 'S'])(
    '%s with nothing read yet: the stats screen, and the read starts',
    (letter) => {
      const s = bars();
      const out = step(s, ch(letter));
      expect(out.effects).toEqual([{ type: 'read-stats', statsToken: 1, tree: TREE }]);
      expect(out.state).toEqual({
        ...s,
        view: {
          ...view(s),
          mode: 'stats',
          stats: { status: 'reading', progress: null },
          statsToken: 1,
        },
      });
    },
  );

  it('a read under way, done or failed: only the screen changes, no second read', () => {
    const under = bars({ autoStats: true });
    const withProgress = act(under, progress(under));
    const done = act(under, arrived(under));
    const broken = act(under, refused(under));
    for (const s of [under, withProgress, done, broken]) {
      const out = step(s, ch('s'));
      expect(out.effects).toEqual([]);
      expect(out.state).toEqual({ ...s, view: { ...view(s), mode: 'stats' } });
    }
  });

  it('Gmail with All Mail hidden: the stats screen with its text, no read', () => {
    const out = step(bars({ tree: GMAIL_HIDDEN }), ch('s'));
    expect(out.effects).toEqual([]);
    expect(view(out.state)).toMatchObject({
      mode: 'stats',
      stats: { status: 'failed', text: STATS_GMAIL_HIDDEN },
      statsToken: 1,
    });
  });

  it('the cursor of the bars, their order and the marks are there again after Esc', () => {
    const marked = act(barsWithMarks(), key('down'), ch('o'));
    const back = act(marked, ch('s'), key('escape'));
    expect(view(back)).toMatchObject({ mode: 'ready', cursor: view(marked).cursor, order: 'size' });
    expect(view(back).basket).toBe(view(marked).basket);
  });

  it('a message of the bars goes with the key, the note about 5,000 folders stays', () => {
    const o = step(bars(), key('enter'));
    const load = o.effects.find((e): e is LoadPage => e.type === 'load-page');
    if (load === undefined) throw new Error('no load-page effect');
    const unavailable = act(
      o.state,
      toBrowser(load, {
        type: 'load-failed',
        generation: load.browserGeneration,
        path: load.path,
        page: 0,
        code: 'folder-unavailable',
      }),
    );
    expect(view(unavailable).message).toBe('folder-unavailable');
    expect(view(act(unavailable, ch('s'), key('escape'))).message).toBeNull();

    const pinned = act(bars({ tree: TRUNCATED }), ch('s'), key('escape'));
    expect(view(pinned)).toMatchObject({ mode: 'ready', message: 'truncated' });
  });

  it('below 40x8 nothing opens', () => {
    const s = bars({ screen: TOO_SMALL });
    const out = step(s, ch('s'));
    expect(out.state).toBe(s);
    expect(out.effects).toEqual([]);
  });

  it('s does nothing while the mailbox opens, on its failed screen or at a question', () => {
    const asked = act(barsWithMarks(), key('escape'));
    for (const s of [act(atHome(), key('enter')), reading(), failed()]) {
      const out = step(s, ch('s'));
      expect(out.state).toBe(s);
      expect(out.effects).toEqual([]);
    }
    // Any key but y answers "no": the bars, not the stats screen.
    expect(view(act(asked, ch('s')))).toMatchObject({ mode: 'ready', stats: { status: 'idle' } });
  });
});

// --- keys of the stats screen ---------------------------------------------------------------

describe('keys on the stats screen: section and order', () => {
  const SECTIONS: [string, StatsSection][] = [
    ['1', 'years'],
    ['2', 'senders'],
    ['3', 'domains'],
    ['4', 'largest'],
  ];

  it.each(SECTIONS)('%s chooses %s, from its first row', (digit, section) => {
    const scrolled = act(statsReady(), ...repeat(key('down'), 3));
    expect(view(scrolled).statsTop).toBe(3);
    const out = step(scrolled, ch(digit));
    expect(out.effects).toEqual([]);
    expect(out.state).toEqual({
      ...scrolled,
      view: { ...view(scrolled), statsSection: section, statsTop: 0 },
    });
  });

  it('the sections can be chosen while the read runs, and after it failed', () => {
    for (const s of [statsReading(), statsFailed()]) {
      const out = step(s, ch('3'));
      expect(out.effects).toEqual([]);
      expect(kept(out.state)).toEqual({ ...kept(s), statsSection: 'domains' });
    }
  });

  it.each(['o', 'O'])('%s switches by size and by messages, from the first row', (letter) => {
    for (const section of ['1', '2', '3']) {
      const scrolled = act(statsReady(), ch(section), key('down'));
      const out = step(scrolled, ch(letter));
      expect(out.effects).toEqual([]);
      expect(out.state).toEqual({
        ...scrolled,
        view: { ...view(scrolled), statsBy: 'messages', statsTop: 0 },
      });
      expect(view(act(out.state, ch(letter))).statsBy).toBe('size');
    }
  });

  it('o does nothing in the largest mails', () => {
    for (const by of ['size', 'messages'] as const) {
      const s = act(statsReady(), ...(by === 'messages' ? [ch('o')] : []), ch('4'));
      expect(view(s)).toMatchObject({ statsSection: 'largest', statsBy: by });
      const out = step(s, ch('o'));
      expect(out.state).toBe(s);
      expect(out.effects).toEqual([]);
    }
  });

  it('the order is kept from one section to the next', () => {
    const s = act(statsReady(), ch('o'), ch('2'), ch('4'), ch('3'));
    expect(view(s)).toMatchObject({ statsSection: 'domains', statsBy: 'messages' });
  });
});

describe('keys on the stats screen: scrolling', () => {
  it('Up / Down by one row, PgUp / PgDn by what fits, never past either end', () => {
    // 30 years in 20 rows: the last possible top row is 10.
    const top = statsReady();
    const atTop = step(top, key('up'));
    expect(atTop.state).toBe(top);
    expect(view(act(top, key('down'))).statsTop).toBe(1);
    expect(view(act(top, key('down'), key('down'), key('up'))).statsTop).toBe(1);
    expect(view(act(top, key('pagedown'))).statsTop).toBe(10);
    expect(view(act(top, ...repeat(key('down'), 14))).statsTop).toBe(10);
    const end = act(top, key('pagedown'));
    const atEnd = step(end, key('down'));
    expect(atEnd.state).toBe(end);
    expect(step(end, key('pagedown')).state).toBe(end);
    expect(view(act(end, key('pageup'))).statsTop).toBe(0);
    expect(view(act(end, key('up'), key('pageup'))).statsTop).toBe(0);
    for (const k of ['up', 'down', 'pageup', 'pagedown'] as const) {
      expect(step(top, key(k)).effects).toEqual([]);
    }
  });

  it('only the row moves', () => {
    const s = statsReady();
    expect(act(s, key('down'))).toEqual({ ...s, view: { ...view(s), statsTop: 1 } });
  });

  it('a section that fits has nowhere to go', () => {
    for (const digit of ['2', '3', '4']) {
      const s = act(statsReady(), ch(digit));
      for (const k of ['up', 'down', 'pageup', 'pagedown'] as const) {
        expect(step(s, key(k)).state).toBe(s);
      }
    }
  });

  it('a smaller window scrolls further: 30 years in 3 rows end at row 27', () => {
    // At 40 columns the summary takes two lines, so three rows fit below it.
    const s = statsReady(STATS, { screen: { rows: 8, cols: 40 } });
    expect(view(act(s, key('pagedown'))).statsTop).toBe(3);
    expect(view(act(s, ...repeat(key('pagedown'), 9))).statsTop).toBe(27);
  });

  it('at 40x8 Down stops at the last row that fits under the two summary lines', () => {
    const s = statsReady(STATS, { screen: { rows: 8, cols: 40 } });
    expect(view(act(s, ...repeat(key('down'), 40))).statsTop).toBe(STATS.years.length - 3);
  });

  it('nothing to scroll while the read runs or after it failed', () => {
    for (const s of [statsReading(), statsFailed()]) {
      for (const k of ['up', 'down', 'pageup', 'pagedown'] as const) {
        expect(step(s, key(k)).state).toBe(s);
      }
    }
  });

  it('after the window grew the next key brings the row back inside', () => {
    const end = act(statsReady(), key('pagedown'));
    expect(view(end).statsTop).toBe(10);
    const grown = act(end, { type: 'resize', screen: { rows: 34, cols: 80 } });
    // A resize alone leaves the row: the frame is drawn from what fits.
    expect(view(grown).statsTop).toBe(10);
    expect(view(act(grown, key('down'))).statsTop).toBe(0);
    expect(view(act(grown, key('up'))).statsTop).toBe(0);
  });

  it('new stats with fewer rows: the next key brings the row back inside', () => {
    const end = act(statsReady(), key('pagedown'));
    const again = act(end, ch('r'));
    const fewer = act(again, arrived(again, statsOf({ years: STATS.years.slice(0, 22) })));
    expect(view(fewer).statsTop).toBe(10);
    expect(view(act(fewer, key('down'))).statsTop).toBe(2);
  });
});

describe('keys on the stats screen: r', () => {
  it.each(['r', 'R'])('%s with the stats there: one new read, the old ones gone', (letter) => {
    const s = statsReady();
    const out = step(s, ch(letter));
    expect(out.effects).toEqual([{ type: 'read-stats', statsToken: 2, tree: TREE }]);
    expect(out.state).toEqual({
      ...s,
      view: { ...view(s), stats: { status: 'reading', progress: null }, statsToken: 2 },
    });
  });

  it('r after a failure: one new read', () => {
    const s = statsFailed();
    const out = step(s, ch('r'));
    expect(out.effects).toEqual([{ type: 'read-stats', statsToken: 2, tree: TREE }]);
    expect(view(out.state).stats).toEqual({ status: 'reading', progress: null });
  });

  it('r while a read runs does nothing - however often it is pressed', () => {
    const s = statsReading();
    const withProgress = act(s, progress(s));
    for (const running of [s, withProgress]) {
      const out = run(running, ch('r'), ch('r'), ch('R'));
      expect(out.state).toBe(running);
      expect(out.effects).toEqual([]);
    }
    // Twice quickly after the stats arrived: the second press finds the new read running.
    const twice = run(statsReady(), ch('r'), ch('r'));
    expect(twice.effects.map((e) => e.type)).toEqual(['read-stats']);
    expect(view(twice.state).statsToken).toBe(2);
  });

  it('r for Gmail with All Mail hidden: its text again, and still no read', () => {
    const s = act(bars({ tree: GMAIL_HIDDEN }), ch('s'));
    const out = step(s, ch('r'));
    expect(out.effects).toEqual([]);
    expect(kept(out.state)).toEqual({ ...kept(s), statsToken: 2 });
  });

  it('r on a stats screen that never started a read starts the first one', () => {
    const idle: MailboxView = { ...view(bars()), mode: 'stats' };
    const state: AppState = { ...bars(), view: idle };
    const out = step(state, ch('r'));
    expect(out.effects).toEqual([{ type: 'read-stats', statsToken: 1, tree: TREE }]);
  });

  it('the section, the order and the row stay as they are', () => {
    const s = act(statsReady(), ch('o'), key('down'), key('down'));
    expect(kept(act(s, ch('r')))).toEqual({
      ...kept(s),
      stats: { status: 'reading', progress: null },
      statsToken: 2,
    });
  });
});

describe('keys on the stats screen: back, quit and the rest', () => {
  it.each(BACK_KEYS)('%s: the bars again, the read and the choices kept', (_name, back) => {
    for (const make of [statsReading, statsFailed, () => act(statsReady(), ch('3'), ch('o'))]) {
      const s = make();
      const out = step(s, back);
      expect(out.effects).toEqual([]);
      expect(out.state).toEqual({ ...s, view: { ...view(s), mode: 'ready' } });
    }
  });

  it('s after Esc shows the section and the order that were left', () => {
    const left = act(statsReady(), ch('2'), ch('o'), key('escape'));
    const again = step(left, ch('s'));
    expect(again.effects).toEqual([]);
    expect(view(again.state)).toMatchObject({
      mode: 'stats',
      statsSection: 'senders',
      statsBy: 'messages',
      stats: { status: 'ready', stats: STATS },
    });
  });

  it.each(['q', 'Q'])(
    '%s without marks quits as the bars do: close-mailbox, then quit',
    (letter) => {
      for (const s of [statsReading(), statsReady(), statsFailed()]) {
        const out = step(s, ch(letter));
        expect(out.state).toBe(s);
        expect(out.effects).toEqual([{ type: 'close-mailbox', finish: null }, { type: 'quit' }]);
      }
      // After a folder was opened the visit is reported as the bars would report it.
      const visited = act(browsing(bars({ autoStats: true })), key('escape'), ch('s'));
      const out = step(visited, ch(letter));
      expect(out.effects).toEqual([
        { type: 'close-mailbox', finish: browseFinishData(view(visited)) },
        { type: 'quit' },
      ]);
      expect(browseFinishData(view(visited))).toMatchObject({ folders: 1, mails: 3, marked: 0 });
    },
  );

  it('q with marks asks first: y quits, any other key is back on the bars', () => {
    const s = act(barsWithMarks({ autoStats: true }), ch('s'));
    const asked = step(s, ch('q'));
    expect(asked.effects).toEqual([]);
    expect(asked.state).toEqual({ ...s, view: { ...view(s), mode: 'confirm-quit' } });
    const yes = step(asked.state, ch('y'));
    expect(yes.effects.map((e) => e.type)).toEqual(['close-mailbox', 'quit']);
    expect(yes.effects[0]).toMatchObject({ finish: { marked: 3 } });
    const no = step(asked.state, ch('n'));
    expect(no.effects).toEqual([]);
    expect(view(no.state)).toMatchObject({ mode: 'ready' });
    expect(view(no.state).basket.marks.size).toBe(3);
    expect(kept(no.state)).toEqual(kept(s));
  });

  it('every other key changes nothing', () => {
    for (const s of [statsReading(), statsReady(), statsFailed()]) {
      for (const other of [key('enter'), key('tab'), key('clear'), key('other')]) {
        expect(step(s, other).state).toBe(s);
      }
      for (const letter of ['x', '0', '5', ' ', 'a', 'y', 'n', 's']) {
        const out = step(s, ch(letter));
        expect(out.state).toBe(s);
        expect(out.effects).toEqual([]);
      }
    }
  });

  it('below 40x8 only q acts', () => {
    const s = act(statsReady(), { type: 'resize', screen: TOO_SMALL });
    const keys = [
      key('escape'),
      key('left'),
      key('backspace'),
      key('up'),
      key('down'),
      key('pageup'),
      key('pagedown'),
      ch('1'),
      ch('2'),
      ch('o'),
      ch('r'),
    ];
    for (const k of keys) {
      const out = step(s, k);
      expect(out.state).toBe(s);
      expect(out.effects).toEqual([]);
    }
    expect(step(s, ch('q')).effects.map((e) => e.type)).toEqual(['close-mailbox', 'quit']);
    const marked = act(barsWithMarks(), ch('s'), { type: 'resize', screen: TOO_SMALL });
    expect(view(act(marked, ch('q'))).mode).toBe('confirm-quit');
  });

  it('statsKey is what reduceApp runs for a key of the stats screen', () => {
    const s = statsReady();
    const keys: AppKey[] = [
      { type: 'char', text: '2' },
      { type: 'char', text: 'o' },
      { type: 'char', text: 'r' },
      { type: 'char', text: 'q' },
      { type: 'down' },
      { type: 'escape' },
      { type: 'enter' },
    ];
    for (const k of keys) {
      expect(statsKey(s, view(s), k)).toEqual(reduceApp(s, { type: 'key', key: k }));
    }
  });
});

// --- what the read reports ------------------------------------------------------------------

describe('what a stats read reports', () => {
  it.each(MODES)('progress in mode %s: stored, nothing else changes', (mode, make) => {
    const s = make();
    expect(view(s).mode).toBe(mode);
    const out = step(s, progress(s));
    expect(out.effects).toEqual([]);
    expect(out.state).toEqual({
      ...s,
      view: { ...view(s), stats: { status: 'reading', progress: PROGRESS } },
    });
    const later = { folder: 4, folders: 12, done: 1, total: 9 };
    expect(view(act(out.state, progress(s, later))).stats).toEqual({
      status: 'reading',
      progress: later,
    });
  });

  it.each(MODES)('the stats in mode %s: kept, nothing else changes', (mode, make) => {
    const s = make();
    const out = step(s, arrived(s));
    expect(out.effects).toEqual([]);
    expect(out.state).toEqual({
      ...s,
      view: { ...view(s), stats: { status: 'ready', stats: STATS } },
    });
    expect(view(out.state).mode).toBe(mode);
    expect(view(out.state).browser).toBe(view(s).browser);
  });

  it.each(MODES)('a failure in mode %s: its text, nothing else changes', (_mode, make) => {
    const s = make();
    const out = step(s, refused(s, 'No connection.'));
    expect(out.effects).toEqual([]);
    expect(out.state).toEqual({
      ...s,
      view: { ...view(s), stats: { status: 'failed', text: 'No connection.' } },
    });
  });

  it('progress that still arrives after the result changes nothing', () => {
    const s = bars({ autoStats: true });
    for (const done of [act(s, arrived(s)), act(s, refused(s))]) {
      const out = step(done, progress(done));
      expect(out.state).toBe(done);
      expect(out.effects).toEqual([]);
    }
  });

  it('a result with another token belongs to another read: dropped', () => {
    const s = statsReading();
    const token = view(s).statsToken;
    const results: AppAction[] = [
      { type: 'stats-progress', statsToken: token - 1, progress: PROGRESS },
      { type: 'stats-ready', statsToken: token - 1, stats: STATS },
      { type: 'stats-failed', statsToken: token - 1, text: 'Old.' },
      { type: 'stats-progress', statsToken: token + 1, progress: PROGRESS },
      { type: 'stats-ready', statsToken: token + 1, stats: STATS },
      { type: 'stats-failed', statsToken: token + 1, text: 'New.' },
    ];
    for (const result of results) {
      const out = step(s, result);
      expect(out.state).toBe(s);
      expect(out.effects).toEqual([]);
    }
  });

  it('after r what the first read still reports is dropped, the second one counts', () => {
    const first = statsReady();
    const second = act(first, ch('r'));
    const late: AppAction[] = [
      { type: 'stats-progress', statsToken: 1, progress: PROGRESS },
      { type: 'stats-ready', statsToken: 1, stats: STATS },
      { type: 'stats-failed', statsToken: 1, text: 'Late.' },
    ];
    for (const result of late) expect(step(second, result).state).toBe(second);
    const other = statsOf({ totals: { messages: 1, bytes: 1 } });
    expect(view(act(second, arrived(second, other))).stats).toEqual({
      status: 'ready',
      stats: other,
    });
  });

  it('a result needs no generation: a request made meanwhile does not drop it', () => {
    const s = bars({ autoStats: true });
    const moved: AppState = { ...s, generation: s.generation + 5 };
    expect(view(act(moved, arrived(moved))).stats).toEqual({ status: 'ready', stats: STATS });
  });

  it('a result for a mailbox that is not on screen changes nothing', () => {
    const home = atHome({ autoStats: true });
    const left = act(bars({ autoStats: true }), key('escape'));
    const signIn = startApp(initialApp('1.2.3', SCREEN)).state;
    const opening = [act(home, key('enter')), reading({ autoStats: true }), failed()];
    const results: AppAction[] = [
      { type: 'stats-progress', statsToken: 1, progress: PROGRESS },
      { type: 'stats-ready', statsToken: 1, stats: STATS },
      { type: 'stats-failed', statsToken: 1, text: 'Late.' },
    ];
    for (const s of [home, left, signIn, ...opening]) {
      for (const result of results) {
        const out = step(s, result);
        expect(out.state).toBe(s);
        expect(out.effects).toEqual([]);
      }
    }
  });

  it('statsResult is what reduceApp runs for a result', () => {
    const s = statsReading();
    const result = { type: 'stats-ready', statsToken: view(s).statsToken, stats: STATS } as const;
    expect(statsResult(s, view(s), result)).toEqual(reduceApp(s, result));
    const stale = { type: 'stats-failed', statsToken: 9, text: 'Old.' } as const;
    expect(statsResult(s, view(s), stale)).toEqual({ state: s, effects: [] });
  });
});

// --- while the mailbox is open --------------------------------------------------------------

describe('the stats stay while the mailbox is open', () => {
  const READY: StatsRead = { status: 'ready', stats: STATS };

  /** The bars with the stats there, the domains by messages chosen. */
  function chosen(): AppState {
    const s = bars({ autoStats: true });
    return act(s, arrived(s), ch('s'), ch('3'), ch('o'), key('escape'));
  }

  it('a folder opened and left, marks made on the way', () => {
    const s = chosen();
    const inFolder = browsing(s);
    expect(kept(inFolder)).toEqual(kept(s));
    const marked = act(inFolder, ch('a'));
    expect(kept(marked)).toEqual(kept(s));
    const back = act(marked, key('escape'));
    expect(view(back).basket.marks.size).toBe(3);
    expect(kept(back)).toEqual(kept(s));
    expect(view(back).stats).toEqual(READY);
  });

  it('a lost connection of the browser and its reconnect', () => {
    const s = chosen();
    const o = step(s, key('enter'));
    const load = o.effects.find((e): e is LoadPage => e.type === 'load-page');
    if (load === undefined) throw new Error('no load-page effect');
    const lost = act(
      o.state,
      toBrowser(load, {
        type: 'load-failed',
        generation: load.browserGeneration,
        path: load.path,
        page: 0,
        code: 'connection-lost',
      }),
    );
    const asked = step(lost, ch('y'));
    expect(asked.effects).toEqual([{ type: 'reconnect-mailbox', browserToken: load.browserToken }]);
    const again = act(asked.state, toBrowser(load, { type: 'reconnected' }));
    for (const state of [lost, asked.state, again]) expect(kept(state)).toEqual(kept(s));
  });

  it('a question about the marks, answered with no', () => {
    const s = barsWithMarks({ autoStats: true });
    const done = act(s, arrived(s));
    expect(kept(act(done, key('escape'), ch('n')))).toEqual(kept(done));
    expect(kept(act(done, ch('q'), ch('n')))).toEqual(kept(done));
  });

  it('sorting the bars and moving on them', () => {
    const s = chosen();
    expect(kept(act(s, ch('o'), key('down'), key('up'), key('pagedown')))).toEqual(kept(s));
  });

  it('a read can end while a folder is open: the stats are there on the bars', () => {
    const s = browsing(bars({ autoStats: true }));
    const done = act(s, arrived(s), key('escape'));
    expect(view(done)).toMatchObject({ mode: 'ready', stats: READY });
  });

  it('leaving the mailbox drops them: the next visit starts with none', () => {
    const s = chosen();
    const home = act(s, key('escape'));
    expect(home.view.kind).toBe('home');
    expect(JSON.stringify(home.view)).not.toContain('statsToken');
    const again = act(home, key('enter'));
    expect(kept(again)).toEqual({
      stats: { status: 'idle' },
      statsToken: 0,
      statsSection: 'years',
      statsBy: 'size',
      statsTop: 0,
    });
  });
});

// --- r on the failed screen -----------------------------------------------------------------

describe('r on the failed screen of the mailbox', () => {
  it('the stats start over: none yet, and a new token', () => {
    const s = failed({ autoStats: true });
    const out = step(s, ch('r'));
    expect(out.effects.map((e) => e.type)).toEqual(['open-mailbox']);
    expect(kept(out.state)).toEqual({ ...kept(s), stats: { status: 'idle' }, statsToken: 1 });
  });

  it('whatever the view still held of an earlier read is gone with it', () => {
    const base = failed();
    const sections: [StatsSection, StatsBy] = ['domains', 'messages'];
    const held: MailboxView = {
      ...view(base),
      stats: { status: 'ready', stats: STATS },
      statsToken: 5,
      statsSection: sections[0],
      statsBy: sections[1],
    };
    const out = step({ ...base, view: held }, ch('r'));
    expect(view(out.state)).toMatchObject({
      mode: 'connecting',
      stats: { status: 'idle' },
      statsToken: 6,
    });
    // What that read still reports finds another token.
    const late = step(out.state, { type: 'stats-ready', statsToken: 5, stats: STATS });
    expect(late.state).toBe(out.state);
  });

  it('with autoStats the new attempt reads the stats under the next token', () => {
    const again = act(failed({ autoStats: true }), ch('r'));
    const opened = step(again, {
      type: 'mailbox-opened',
      generation: again.generation,
      tree: TREE,
    });
    expect(opened.effects).toEqual([{ type: 'read-stats', statsToken: 2, tree: TREE }]);
    expect(view(opened.state)).toMatchObject({ mode: 'ready', statsToken: 2 });
  });
});
