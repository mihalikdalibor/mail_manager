import { describe, it, expect } from 'vitest';
import { wrap as wrapOfMailbox } from '../../src/cli/app/mailbox-render.js';
import { statsRowCount } from '../../src/cli/app/mailbox-stats.js';
import { reduceApp, startApp } from '../../src/cli/app/reduce.js';
import { renderApp } from '../../src/cli/app/render.js';
import type { AppRenderOptions } from '../../src/cli/app/render.js';
import { STATS_GMAIL_HIDDEN, initialApp } from '../../src/cli/app/state.js';
import type {
  AppAction,
  AppEffect,
  AppKey,
  AppState,
  MailboxRow,
  MailboxView,
  StatsBy,
  StatsSection,
} from '../../src/cli/app/state.js';
import {
  statsBody,
  statsHeaderRight,
  statsHelp,
  statsNote,
} from '../../src/cli/app/stats-render.js';
import { helpLine, wrap } from '../../src/cli/browser/layout.js';
import type { Rendered } from '../../src/cli/browser/render.js';
import { bodyHeight } from '../../src/cli/browser/state.js';
import type { Screen } from '../../src/cli/browser/state.js';
import { displayWidth } from '../../src/cli/browser/width.js';
import type { AuthUser } from '../../src/core/auth.js';
import type { FolderInfo, FolderTree, SizeProgress } from '../../src/core/mailbox/folders.js';
import type { MessageRow } from '../../src/core/mailbox/messages.js';
import type { MailboxStats, RankedRow, RankedStats } from '../../src/core/mailbox/stats.js';

// M2d-3 stats of a mailbox, drawn: renderApp over states built with the reducers - what the
// bars say about the read, and the stats screen (summary, years with their bars, top senders,
// top domains, largest mails) while reading, with the stats there and after a failure. Every
// frame is proven exact in size. Addresses are placeholders; hostile and non-ASCII characters
// are written as escapes.

// --- fixtures -------------------------------------------------------------------------------

const ANNA: AuthUser = { email: 'anna@example-test-domain.eu', userId: 'user-anna' };
const EMAIL = 'box@example-test-domain.eu';
const SCREEN: Screen = { rows: 24, cols: 80 };
const SMALLEST: Screen = { rows: 8, cols: 40 };
const WIDE: Screen = { rows: 50, cols: 200 };
const SCREENS: Screen[] = [SMALLEST, SCREEN, WIDE];
const ASCII = /^[\x20-\x7e]*$/;
/** Anything a terminal would act on instead of drawing: controls, bidi and zero-width marks. */
const UNSAFE = /[\p{Cc}\u200b-\u200f\u202a-\u202e\u2066-\u2069]/u;
const UTC: AppRenderOptions = { timeZone: 'UTC' };
const HELP_STATS = '1-4 section  o size/messages  Up/Down scroll  r read again  Esc back  q quit';
const SECTIONS: StatsSection[] = ['years', 'senders', 'domains', 'largest'];
const SECTION_KEY: Record<StatsSection, string> = {
  years: '1',
  senders: '2',
  domains: '3',
  largest: '4',
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
const NO_OTHERS = { messages: 0, bytes: 0 };
const BIG: RankedRow = { key: 'big@example-test-domain.eu', messages: 10, bytes: 4_000_000 };
const NEWS: RankedRow = { key: 'news@example-test-domain.eu', messages: 600, bytes: 3_000_000 };
const NOBODY: RankedRow = { key: null, messages: 5, bytes: 2000 };
const DOMAIN: RankedRow = { key: 'example-test-domain.eu', messages: 990, bytes: 9_000_000 };
const NO_DOMAIN: RankedRow = { key: null, messages: 10, bytes: 1_000_000 };

/**
 * 1,000 messages of 10,000,000 bytes. By size the years are 25 %, 50 %, 24.6 % and 0.4 %; by
 * messages 30 %, 45 %, 24.9 % and 0.1 %.
 */
function statsOf(over: Partial<MailboxStats> = {}): MailboxStats {
  return {
    folders: [
      { path: 'INBOX', messages: 700, bytes: 7_000_000, partial: false },
      { path: 'Sent', messages: 250, bytes: 2_500_000, partial: false },
      { path: 'Trash', messages: 50, bytes: 500_000, partial: false },
    ],
    notScanned: 0,
    totals: { messages: 1000, bytes: 10_000_000 },
    years: [
      { year: '2022', messages: 300, bytes: 2_500_000 },
      { year: '2023', messages: 450, bytes: 5_000_000 },
      { year: '2024', messages: 249, bytes: 2_460_000 },
      { year: 'unknown', messages: 1, bytes: 40_000 },
    ],
    senders: { byCount: [NEWS, BIG, NOBODY], bySize: [BIG, NEWS, NOBODY], others: NO_OTHERS },
    domains: { byCount: [DOMAIN, NO_DOMAIN], bySize: [DOMAIN, NO_DOMAIN], others: NO_OTHERS },
    largest: [
      {
        folder: 'INBOX',
        // The last half hour of 2024 in UTC: already 2025 further east.
        received: new Date(Date.UTC(2024, 11, 31, 23, 30)),
        from: 'Big Sender',
        subject: 'Quarterly report',
        bytes: 3_000_000,
      },
      { folder: 'Archive/2023', received: null, from: null, subject: null, bytes: 150_000 },
    ],
    approximate: false,
    unreadable: 0,
    partial: 0,
    ...over,
  };
}

const STATS = statsOf();
const NO_RANKED: RankedStats = { byCount: [], bySize: [], others: NO_OTHERS };
const EMPTY = statsOf({
  folders: [],
  totals: { messages: 0, bytes: 0 },
  years: [],
  senders: NO_RANKED,
  domains: NO_RANKED,
  largest: [],
});
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

function act(state: AppState, ...actions: AppAction[]): AppState {
  let s = state;
  for (const a of actions) s = reduceApp(s, a).state;
  return s;
}

function view(state: AppState): MailboxView {
  if (state.view.kind !== 'mailbox') throw new Error(`not on a mailbox: ${state.view.kind}`);
  return state.view;
}

interface Options {
  screen?: Screen;
  tree?: FolderTree;
  email?: string;
}

/** Enter on the one mailbox of Home: "Connecting...". */
function connecting(o: Options, autoStats: boolean): AppState {
  const row: MailboxRow = {
    id: 'box-1',
    email: o.email ?? EMAIL,
    provider: 'websupport',
    lastCheckedAt: null,
  };
  const s0 = startApp(initialApp('1.2.3', o.screen ?? SCREEN, { autoStats })).state;
  const s1 = act(
    s0,
    { type: 'session', generation: s0.generation, user: ANNA, remembered: [ANNA.email] },
    key('enter'),
  );
  return act(s1, { type: 'mailboxes', generation: s1.generation, rows: [row] }, key('enter'));
}

function opened(o: Options, autoStats: boolean): AppState {
  const s = connecting(o, autoStats);
  return act(
    s,
    { type: 'mailbox-reading', generation: s.generation },
    { type: 'mailbox-opened', generation: s.generation, tree: o.tree ?? TREE },
  );
}

/** The bars, nothing asked of the stats yet (autoStats off). */
function barsIdle(o: Options = {}): AppState {
  return opened(o, false);
}

/** The bars with the stats read under way. */
function barsReading(o: Options = {}): AppState {
  return opened(o, true);
}

function progressed(state: AppState, progress: SizeProgress = PROGRESS): AppState {
  return act(state, { type: 'stats-progress', statsToken: view(state).statsToken, progress });
}

function arrived(state: AppState, stats: MailboxStats = STATS): AppState {
  return act(state, { type: 'stats-ready', statsToken: view(state).statsToken, stats });
}

function refused(state: AppState, text: string): AppState {
  return act(state, { type: 'stats-failed', statsToken: view(state).statsToken, text });
}

/** The stats screen with these stats: `section`, in the order `by`. */
function shown(
  stats: MailboxStats = STATS,
  section: StatsSection = 'years',
  by: StatsBy = 'size',
  o: Options = {},
): AppState {
  const s = act(arrived(barsReading(o), stats), ch('s'), ch(SECTION_KEY[section]));
  return by === view(s).statsBy || section === 'largest' ? s : act(s, ch('o'));
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

type LoadPage = Extract<AppEffect, { type: 'load-page' }>;

/** Enter on the first folder; `answer` builds what the controller sends back for its page. */
function inFolder(bars: AppState, answer: (load: LoadPage) => AppAction): AppState {
  const out = reduceApp(bars, key('enter'));
  const load = out.effects.find((e): e is LoadPage => e.type === 'load-page');
  if (load === undefined) throw new Error('no load-page effect');
  return act(out.state, answer(load));
}

/** The first folder open with its three mails on screen. */
function browsing(bars: AppState): AppState {
  return inFolder(bars, (load) => ({
    type: 'browser',
    browserToken: load.browserToken,
    action: {
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
    },
  }));
}

// --- reading a frame ------------------------------------------------------------------------

/** The frame of `state`, proven exact: `rows` lines of `cols` columns. */
function frame(state: AppState, opts: AppRenderOptions = UTC): Rendered {
  const out = renderApp(state, opts);
  expect(out.lines).toHaveLength(state.screen.rows);
  for (const line of out.lines) expect(displayWidth(line)).toBe(state.screen.cols);
  return out;
}

function lineAt(out: Rendered, i: number): string {
  return (out.lines[i] ?? '').trimEnd();
}

function status(out: Rendered): string {
  return lineAt(out, out.lines.length - 2);
}

function help(out: Rendered): string {
  return lineAt(out, out.lines.length - 1);
}

/** Where the rows start: the summary, wrapped or not, is the body above them and never indented. */
function firstRow(out: Rendered): number {
  return out.lines.findIndex((l, i) => i > 0 && l.startsWith('    '));
}

/** The rows of the section: the body below the summary, without the blank rest. */
function rows(out: Rendered): string[] {
  return out.lines
    .slice(firstRow(out), -2)
    .map((l) => l.trimEnd())
    .filter((l) => l !== '');
}

/** The summary lines: the body above the rows, trimmed. */
function summaryLines(out: Rendered): string[] {
  return out.lines.slice(1, firstRow(out)).map((l) => l.trimEnd());
}

function text(out: Rendered): string {
  return out.lines.join('\n');
}

/** Every line free of what a terminal would act on. */
function expectSafe(out: Rendered): void {
  for (const line of out.lines) expect(line).not.toMatch(UNSAFE);
}

/** A row as it is drawn: the left cell, then the right cells `width` columns wide. */
function row(left: string, right: string, width: number, cols = 80): string {
  return `${left.padEnd(cols - width)}${right}`.trimEnd();
}

/** The header as it is drawn: the mailbox on the left, `right` at the right edge. */
function header(right: string, cols = 80): string {
  return `${`Mail Manager - ${EMAIL}`.padEnd(cols - right.length)}${right}`;
}

/** Which cells a year row has: the cells of its bar, and whether it has a percent. */
function cellsOf(line: string): string {
  return `${String(/\[[#.]+\]/.exec(line)?.[0].length ?? 0)} ${String(line.includes('%'))}`;
}

// --- the bars -------------------------------------------------------------------------------

describe('the bars: what the status line says about the stats', () => {
  it('nothing asked yet: "Stats: press s to read"', () => {
    const out = frame(barsIdle());
    expect(status(out)).toBe('Stats: press s to read');
    expect(lineAt(out, 1)).toBe('Total: 6 messages, 0 unread, 2.0 KB');
  });

  it('the read under way: "Stats: reading...", then folder and messages as they are counted', () => {
    const reading = barsReading();
    expect(status(frame(reading))).toBe('Stats: reading...');
    expect(status(frame(progressed(reading)))).toBe(
      'Stats: reading folder 3/12 - 5000/12345 messages',
    );
    const first = progressed(reading, { folder: 1, folders: 1, done: 0, total: 0 });
    expect(status(frame(first))).toBe('Stats: reading folder 1/1 - 0/0 messages');
  });

  it('the stats there: "Stats ready - press s"; a failed read: "Stats couldn\'t be read - press s"', () => {
    expect(status(frame(arrived(barsReading())))).toBe('Stats ready - press s');
    const failed = refused(barsReading(), 'The connection to the mail server was lost.');
    expect(status(frame(failed))).toBe("Stats couldn't be read - press s");
    // Why is said on the stats screen, not here.
    expect(text(frame(failed))).not.toContain('connection');
    const gmail = barsReading({ tree: treeOf({ totals: null, gmailAllHidden: true }) });
    expect(status(frame(gmail))).toBe("Stats couldn't be read - press s");
  });

  it('the key help of the bars has "s stats"; in a narrow window it is the first to go', () => {
    const all = 'Up/Down move  Enter open  o sort  s stats  Esc back  q quit';
    expect(help(frame(barsIdle()))).toBe(all);
    expect(help(frame(barsIdle({ screen: { rows: 8, cols: all.length } })))).toBe(all);
    expect(help(frame(barsIdle({ screen: { rows: 8, cols: all.length - 1 } })))).toBe(
      'Up/Down move  Enter open  o sort  Esc back  q quit',
    );
    expect(help(frame(barsIdle({ screen: SMALLEST })))).toBe(
      'Up/Down move  Enter open  o sort  q quit',
    );
  });

  it('every text fits 40 columns but the longest progress, which is cut', () => {
    const reading = barsReading({ screen: SMALLEST });
    expect(status(frame(reading))).toBe('Stats: reading...');
    expect(status(frame(arrived(reading)))).toBe('Stats ready - press s');
    expect(status(frame(refused(reading, 'No.')))).toBe("Stats couldn't be read - press s");
    expect(status(frame(barsIdle({ screen: SMALLEST })))).toBe('Stats: press s to read');
    const long = { folder: 300, folders: 1200, done: 123_456, total: 1_234_567 };
    expect(status(frame(progressed(reading, long)))).toBe(
      'Stats: reading folder 300/1200 - 1234...',
    );
  });

  it('a message of the bars goes first; the stats are back with the next key', () => {
    const unavailable = inFolder(arrived(barsReading()), (load) => ({
      type: 'browser',
      browserToken: load.browserToken,
      action: {
        type: 'load-failed',
        generation: load.browserGeneration,
        path: load.path,
        page: 0,
        code: 'folder-unavailable',
      },
    }));
    expect(status(frame(unavailable))).toBe("Couldn't open that folder.");
    expect(status(frame(act(unavailable, key('down'))))).toBe('Stats ready - press s');
  });

  it('with more than 5,000 folders their note stays, whatever the stats do', () => {
    const tree = treeOf({ truncated: true });
    const reading = barsReading({ tree });
    for (const s of [
      barsIdle({ tree }),
      reading,
      progressed(reading),
      arrived(reading),
      refused(reading, 'No.'),
      act(arrived(reading), key('down')),
    ]) {
      expect(status(frame(s))).toBe('Only the first 5,000 folders are shown.');
    }
  });

  it('a question goes first', () => {
    const marked = act(browsing(arrived(barsReading())), ch('a'), key('escape'));
    expect(status(frame(marked))).toBe('Stats ready - press s');
    expect(status(frame(act(marked, key('escape'))))).toBe('Drop 3 marks? (y/N)');
    expect(status(frame(act(marked, ch('q'))))).toBe('Quit and drop 3 marks? (y/N)');
    expect(status(frame(act(marked, ch('q'), ch('n'))))).toBe('Stats ready - press s');
  });

  it('nothing about the stats while the mailbox opens, on its failed screen or in a folder', () => {
    const waiting = connecting({}, true);
    const reading = act(waiting, { type: 'mailbox-reading', generation: waiting.generation });
    const failed = act(reading, {
      type: 'mailbox-failed',
      generation: reading.generation,
      text: 'It did not work.',
    });
    expect(status(frame(waiting))).toBe('Connecting...');
    expect(status(frame(reading))).toBe('Reading folders...');
    expect(status(frame(failed))).toBe('');
    expect(text(frame(browsing(progressed(barsReading()))))).not.toContain('Stats');
  });
});

// --- the stats screen: header and summary ---------------------------------------------------

describe('the stats screen: header', () => {
  it.each<[StatsSection, StatsBy, string]>([
    ['years', 'size', 'Years - by size'],
    ['years', 'messages', 'Years - by messages'],
    ['senders', 'size', 'Top senders - by size'],
    ['senders', 'messages', 'Top senders - by messages'],
    ['domains', 'size', 'Top domains - by size'],
    ['domains', 'messages', 'Top domains - by messages'],
    ['largest', 'size', 'Largest mails'],
  ])('%s, by %s: "%s"', (section, by, right) => {
    const s = shown(STATS, section, by);
    expect(lineAt(frame(s), 0)).toBe(header(right));
    expect(statsHeaderRight(view(s))).toBe(right);
  });

  it('the largest mails have no order in the header, whichever was chosen before', () => {
    const s = act(shown(STATS, 'senders', 'messages'), ch('4'));
    expect(lineAt(frame(s), 0)).toBe(header('Largest mails'));
  });

  it('"(approximate)" on a top list whose own cap overflowed - not on the other, not on the years', () => {
    const stats = statsOf({
      approximate: true,
      senders: { ...STATS.senders, others: { messages: 385, bytes: 2_998_000 } },
    });
    expect(lineAt(frame(shown(stats, 'senders', 'size')), 0)).toBe(
      header('Top senders - by size (approximate)'),
    );
    // 39 columns of section: one too many beside this address, so the address gives way.
    expect(lineAt(frame(shown(stats, 'senders', 'messages')), 0)).toBe(
      'Mail Manager - box@example-test-domai... Top senders - by messages (approximate)',
    );
    expect(lineAt(frame(shown(stats, 'senders', 'messages', { screen: WIDE })), 0)).toBe(
      header('Top senders - by messages (approximate)', 200),
    );
    expect(lineAt(frame(shown(stats, 'domains', 'size')), 0)).toBe(header('Top domains - by size'));
    expect(lineAt(frame(shown(stats, 'years', 'size')), 0)).toBe(header('Years - by size'));
    expect(lineAt(frame(shown(stats, 'largest')), 0)).toBe(header('Largest mails'));
    const domains = statsOf({
      approximate: true,
      domains: { ...STATS.domains, others: { messages: 1, bytes: 1 } },
    });
    expect(statsHeaderRight(view(shown(domains, 'domains', 'messages')))).toBe(
      'Top domains - by messages (approximate)',
    );
    expect(statsHeaderRight(view(shown(domains, 'senders', 'size')))).toBe('Top senders - by size');
  });

  it('the section is named while the read runs and after it failed', () => {
    const reading = act(barsReading(), ch('s'), ch('2'));
    expect(lineAt(frame(reading), 0)).toBe(header('Top senders - by size'));
    expect(lineAt(frame(refused(reading, 'No.')), 0)).toBe(header('Top senders - by size'));
  });

  it('a narrow window cuts the mailbox, not the section', () => {
    const out = frame(shown(STATS, 'years', 'size', { screen: SMALLEST }));
    expect(lineAt(out, 0)).toBe('Mail Manager - box@ex... Years - by size');
  });

  it('a cell that cannot fit loses "(approximate)", so the section is still named', () => {
    const stats = statsOf({
      senders: { ...STATS.senders, others: { messages: 1, bytes: 1 } },
      domains: { ...STATS.domains, others: { messages: 1, bytes: 1 } },
    });
    // 39 columns of cell need 41: one for the mailbox and the gap beside them.
    for (const section of ['senders', 'domains'] as const) {
      const title = section === 'senders' ? 'Top senders' : 'Top domains';
      const narrow = shown(stats, section, 'messages', { screen: SMALLEST });
      expect(lineAt(frame(narrow), 0)).toBe(`Mail Manage... ${title} - by messages`);
      expect(statsHeaderRight(view(narrow), 40)).toBe(`${title} - by messages`);
      expect(statsHeaderRight(view(narrow), 41)).toBe(`${title} - by messages (approximate)`);
      // Without a width the whole cell.
      expect(statsHeaderRight(view(narrow))).toBe(`${title} - by messages (approximate)`);
      const wider = shown(stats, section, 'messages', { screen: { rows: 8, cols: 41 } });
      expect(lineAt(frame(wider), 0).endsWith(` ${title} - by messages (approximate)`)).toBe(true);
    }
    // By size the whole cell has 35 columns: it fits the smallest window.
    const bySize = shown(stats, 'senders', 'size', { screen: SMALLEST });
    expect(statsHeaderRight(view(bySize), 40)).toBe('Top senders - by size (approximate)');
    expect(lineAt(frame(bySize), 0).endsWith(' Top senders - by size (approximate)')).toBe(true);
    // Nothing to drop where nothing is approximate.
    expect(statsHeaderRight(view(shown(STATS, 'senders', 'messages')), 20)).toBe(
      'Top senders - by messages',
    );
  });

  it('a hostile address is drawn safe', () => {
    const out = frame(shown(STATS, 'years', 'size', { email: 'a\u001b[2J\u202eb@example.eu' }));
    expect(lineAt(out, 0)).toMatch(/^Mail Manager - a\[2Jb@example\.eu +Years - by size$/);
    expectSafe(out);
  });
});

describe('the stats screen: the summary line', () => {
  const summary = (stats: MailboxStats, screen: Screen = SCREEN): string =>
    lineAt(frame(shown(stats, 'years', 'size', { screen })), 1);

  it('folders, messages and the size, said once to be approximate', () => {
    expect(summary(STATS)).toBe('Scanned 3 folders, 1000 messages, 9.5 MB (approx.)');
  });

  it('what could not be read whole follows, each part only when it is there', () => {
    expect(summary(statsOf({ unreadable: 2 }))).toBe(
      "Scanned 3 folders, 1000 messages, 9.5 MB (approx.), 2 folders couldn't be read",
    );
    expect(summary(statsOf({ partial: 4 }))).toBe(
      'Scanned 3 folders, 1000 messages, 9.5 MB (approx.), 4 folders read only partly',
    );
    expect(summary(statsOf({ notScanned: 7 }), WIDE)).toBe(
      'Scanned 3 folders, 1000 messages, 9.5 MB (approx.), 7 folders skipped (counted elsewhere)',
    );
    expect(summary(statsOf({ unreadable: 2, partial: 4, notScanned: 7 }), WIDE)).toBe(
      "Scanned 3 folders, 1000 messages, 9.5 MB (approx.), 2 folders couldn't be read, " +
        '4 folders read only partly, 7 folders skipped (counted elsewhere)',
    );
  });

  it('one of a kind is in the singular', () => {
    const one = statsOf({
      folders: [{ path: 'INBOX', messages: 1, bytes: 512, partial: true }],
      totals: { messages: 1, bytes: 512 },
      unreadable: 1,
      partial: 1,
      notScanned: 1,
    });
    expect(summary(one, WIDE)).toBe(
      "Scanned 1 folder, 1 message, 512 B (approx.), 1 folder couldn't be read, " +
        '1 folder read only partly, 1 folder skipped (counted elsewhere)',
    );
  });

  it('a mailbox with no folder to read: zeros, and every section "(none)"', () => {
    for (const section of SECTIONS) {
      for (const by of ['size', 'messages'] as const) {
        const out = frame(shown(EMPTY, section, by));
        expect(lineAt(out, 1)).toBe('Scanned 0 folders, 0 messages, 0 B (approx.)');
        expect(rows(out)).toEqual(['    (none)']);
      }
    }
  });

  it('too long for one line: it wraps to the width, and the rows come after it', () => {
    const out = frame(shown(statsOf({ unreadable: 2, partial: 4, notScanned: 7 })));
    expect(lineAt(out, 1)).toBe(
      "Scanned 3 folders, 1000 messages, 9.5 MB (approx.), 2 folders couldn't be read,",
    );
    expect(lineAt(out, 2)).toBe(
      '4 folders read only partly, 7 folders skipped (counted elsewhere)',
    );
    expect(lineAt(out, 3)).toBe(row('    2024', '[##........]  25%   2.3 MB  249', 33));
  });

  it('40x8: the four lines of the summary, then exactly one row', () => {
    const long = statsOf({ unreadable: 2, partial: 4, notScanned: 7 });
    const out = frame(shown(long, 'years', 'size', { screen: SMALLEST }));
    expect([1, 2, 3, 4].map((i) => lineAt(out, i))).toEqual([
      'Scanned 3 folders, 1000 messages, 9.5 MB',
      "(approx.), 2 folders couldn't be read, 4",
      'folders read only partly, 7 folders',
      'skipped (counted elsewhere)',
    ]);
    expect(lineAt(out, 5)).toBe(row('    2024', ' 25%   2.3 MB  249', 20, 40));
    expect(rows(out)).toHaveLength(1);
  });

  it('40x8: the plain summary takes two lines, and three rows follow', () => {
    const out = frame(shown(STATS, 'years', 'size', { screen: SMALLEST }));
    expect(summaryLines(out)).toEqual(['Scanned 3 folders, 1000 messages, 9.5 MB', '(approx.)']);
    expect(rows(out)).toEqual([
      row('    2024', ' 25%   2.3 MB  249', 20, 40),
      row('    2023', ' 50%   4.8 MB  450', 20, 40),
      row('    2022', ' 25%   2.4 MB  300', 20, 40),
    ]);
  });

  it('wrapped or not, the summary lines joined with one space are the whole of it', () => {
    const long = statsOf({ unreadable: 2, partial: 4, notScanned: 7 });
    const whole =
      "Scanned 3 folders, 1000 messages, 9.5 MB (approx.), 2 folders couldn't be read, " +
      '4 folders read only partly, 7 folders skipped (counted elsewhere)';
    for (const cols of [40, 45, 60, 79, 80, 120, 200]) {
      const out = frame(shown(long, 'years', 'size', { screen: { rows: 8, cols } }));
      expect(summaryLines(out).join(' '), `${String(cols)} columns`).toBe(whole);
    }
  });

  it('a body too short for all of the summary: its last line ends in "..." and a row is shown', () => {
    const long = statsOf({ unreadable: 2, partial: 4, notScanned: 7 });
    const body = statsBody(view(shown(long, 'years', 'size', { screen: SMALLEST })), 3, 40, 'UTC');
    expect(body.lines.map((l) => l.trimEnd())).toEqual([
      'Scanned 3 folders, 1000 messages, 9.5 MB',
      "(approx.), 2 folders couldn't be read...",
      row('    2024', ' 25%   2.3 MB  249', 20, 40),
    ]);
  });

  it('40x8: the summary takes two lines, and down or pagedown reaches the last year', () => {
    const years = Array.from({ length: 30 }, (_, i) => ({
      year: String(1995 + i),
      messages: 1,
      bytes: 100,
    }));
    const top = shown(statsOf({ totals: { messages: 30, bytes: 3000 }, years }), 'years', 'size', {
      screen: SMALLEST,
    });
    for (const k of ['down', 'pagedown'] as const) {
      let state = top;
      // Until nothing moves: every frame is the window's size.
      for (let i = 0; i < 40; i++) {
        state = act(state, key(k));
        frame(state);
      }
      // Three rows fit under the two summary lines: the last three years, the last one last.
      expect(view(state).statsTop).toBe(27);
      const out = frame(state);
      expect(rows(out)).toHaveLength(3);
      expect(rows(out)[0]).toContain('    1997 ');
      expect(rows(out)[2]).toContain('    1995 ');
    }
  });
});

// --- the stats screen: the sections ---------------------------------------------------------

describe('the stats screen: years', () => {
  it('80x24 by size: newest first, "unknown" last; bar, percent, size and messages', () => {
    const out = frame(shown(STATS, 'years', 'size'));
    // Right cells: bar (12), percent (4), size (7), messages (3) = 33 columns with the gaps.
    expect(rows(out)).toEqual([
      row('    2024', '[##........]  25%   2.3 MB  249', 33),
      row('    2023', '[#####.....]  50%   4.8 MB  450', 33),
      row('    2022', '[###.......]  25%   2.4 MB  300', 33),
      row('    unknown', '[#.........]  <1%  39.1 KB    1', 33),
    ]);
    expect(status(out)).toBe('');
    expect(help(out)).toBe(HELP_STATS);
    expect(out.cursorLine).toBeNull();
  });

  it('by messages the bar and the percent are the share of the messages', () => {
    expect(rows(frame(shown(STATS, 'years', 'messages')))).toEqual([
      row('    2024', '[##........]  25%   2.3 MB  249', 33),
      row('    2023', '[#####.....]  45%   4.8 MB  450', 33),
      row('    2022', '[###.......]  30%   2.4 MB  300', 33),
      row('    unknown', '[#.........]  <1%  39.1 KB    1', 33),
    ]);
  });

  it('whatever order the years come in, the newest is first and the undated last', () => {
    const shuffled = statsOf({
      years: [
        { year: 'unknown', messages: 1, bytes: 40_000 },
        { year: '2023', messages: 450, bytes: 5_000_000 },
        { year: '1999', messages: 0, bytes: 0 },
        { year: '2024', messages: 249, bytes: 2_460_000 },
      ],
    });
    const labels = rows(frame(shown(shuffled))).map((l) => l.trim().split(' ')[0]);
    expect(labels).toEqual(['2024', '2023', '1999', 'unknown']);
  });

  it('a share above nothing has one cell and "<1%"; nothing has none and "0%"; all of it is full', () => {
    const stats = statsOf({
      years: [
        { year: '2022', messages: 0, bytes: 0 },
        { year: '2023', messages: 1, bytes: 1 },
        { year: '2024', messages: 999, bytes: 9_999_999 },
      ],
    });
    expect(rows(frame(shown(stats)))).toEqual([
      row('    2024', '[##########] 100%  9.5 MB  999', 32),
      row('    2023', '[#.........]  <1%     1 B    1', 32),
      row('    2022', '[..........]   0%     0 B    0', 32),
    ]);
    const half = statsOf({
      totals: { messages: 1000, bytes: 2000 },
      years: [
        { year: '2023', messages: 5, bytes: 9 },
        { year: '2024', messages: 995, bytes: 1991 },
      ],
    });
    // 9 of 2000 bytes is 0.45 %: still "<1%"; 5 of 1000 messages is 0.5 %: "1%".
    expect(rows(frame(shown(half, 'years', 'size')))[1]).toContain('[#.........]  <1%');
    expect(rows(frame(shown(half, 'years', 'messages')))[1]).toContain('[#.........]   1%');
  });

  it('a mailbox whose sizes add up to nothing: no bar and no percent by size, both by messages', () => {
    const stats = statsOf({
      totals: { messages: 3, bytes: 0 },
      years: [
        { year: '2023', messages: 1, bytes: 0 },
        { year: '2024', messages: 2, bytes: 0 },
      ],
    });
    expect(rows(frame(shown(stats, 'years', 'size')))).toEqual([
      row('    2024', '0 B  2', 8),
      row('    2023', '0 B  1', 8),
    ]);
    expect(rows(frame(shown(stats, 'years', 'messages')))).toEqual([
      row('    2024', '[#######...]  67%  0 B  2', 27),
      row('    2023', '[###.......]  33%  0 B  1', 27),
    ]);
  });

  it('narrow windows: one set of cells for the whole frame - bar 10, bar 6, no bar', () => {
    for (let cols = 40; cols <= 80; cols++) {
      const lines = rows(frame(shown(STATS, 'years', 'size', { screen: { rows: 10, cols } })));
      expect(lines).toHaveLength(4);
      // As on the bars the left cell keeps 12 columns: 50 hold the long bar, 46 the short one.
      const expected = cols >= 50 ? '12 true' : cols >= 46 ? '8 true' : '0 true';
      for (const line of lines) expect(cellsOf(line), `${String(cols)} columns`).toBe(expected);
      expect(lines[3]).toContain('    unknown ');
    }
    expect(rows(frame(shown(STATS, 'years', 'size', { screen: SMALLEST })))).toEqual([
      row('    2024', ' 25%   2.3 MB  249', 20, 40),
      row('    2023', ' 50%   4.8 MB  450', 20, 40),
      row('    2022', ' 25%   2.4 MB  300', 20, 40),
    ]);
    // Nine rows: the two summary lines leave four, so the years with the `<1%` one too.
    expect(rows(frame(shown(STATS, 'years', 'size', { screen: { rows: 9, cols: 40 } })))).toEqual([
      row('    2024', ' 25%   2.3 MB  249', 20, 40),
      row('    2023', ' 50%   4.8 MB  450', 20, 40),
      row('    2022', ' 25%   2.4 MB  300', 20, 40),
      row('    unknown', ' <1%  39.1 KB    1', 20, 40),
    ]);
    expect(rows(frame(shown(STATS, 'years', 'size', { screen: { rows: 10, cols: 46 } })))[0]).toBe(
      row('    2024', '[#.....]  25%   2.3 MB  249', 29, 46),
    );
  });

  it('with wide numbers the percent goes too, before a year is cut', () => {
    // Size 6 columns, messages 13: the percent needs 46 columns, the bars 55 and 59.
    const big = statsOf({
      totals: { messages: 2_469_135_780_246, bytes: 10_000_000 },
      years: [
        { year: '2023', messages: 1_234_567_890_123, bytes: 5_000_000 },
        { year: 'unknown', messages: 1_234_567_890_123, bytes: 5_000_000 },
      ],
    });
    for (let cols = 40; cols <= 60; cols++) {
      const lines = rows(frame(shown(big, 'years', 'size', { screen: { rows: 10, cols } })));
      const expected =
        cols >= 59 ? '12 true' : cols >= 55 ? '8 true' : cols >= 46 ? '0 true' : '0 false';
      for (const line of lines) expect(cellsOf(line), `${String(cols)} columns`).toBe(expected);
    }
    expect(rows(frame(shown(big, 'years', 'size', { screen: SMALLEST })))).toEqual([
      row('    2023', '4.8 MB  1234567890123', 23, 40),
      row('    unknown', '4.8 MB  1234567890123', 23, 40),
    ]);
  });

  it('more years than fit: the summary stays and the rows scroll under it', () => {
    const years = Array.from({ length: 30 }, (_, i) => ({
      year: String(1995 + i),
      messages: 1,
      bytes: 100,
    }));
    const many = statsOf({ totals: { messages: 30, bytes: 3000 }, years });
    const top = shown(many);
    const first = frame(top);
    expect(lineAt(first, 1)).toBe('Scanned 3 folders, 30 messages, 2.9 KB (approx.)');
    expect(rows(first)).toHaveLength(20);
    expect(rows(first)[0]).toContain('    2024 ');
    expect(rows(first)[19]).toContain('    2005 ');

    const down = frame(act(top, ...repeat(key('down'), 3)));
    expect(lineAt(down, 1)).toBe('Scanned 3 folders, 30 messages, 2.9 KB (approx.)');
    expect(rows(down)[0]).toContain('    2021 ');
    const end = frame(act(top, key('pagedown')));
    expect(rows(end)[0]).toContain('    2014 ');
    expect(rows(end)[19]).toContain('    1995 ');
    // The same rows from another section's point of view: `o` starts at the top again.
    expect(rows(frame(act(top, key('pagedown'), ch('o'))))[0]).toContain('    2024 ');
  });

  it('a row the keys could not have reached is drawn from the last one that fits', () => {
    const years = Array.from({ length: 30 }, (_, i) => ({
      year: String(1995 + i),
      messages: 1,
      bytes: 100,
    }));
    const end = act(shown(statsOf({ years })), key('pagedown'));
    for (const statsTop of [10, 11, 500]) {
      const state: AppState = { ...end, view: { ...view(end), statsTop } };
      expect(rows(frame(state))[19]).toContain('    1995 ');
    }
    // The window grew: every row is on screen, from the first.
    const grown = frame(act(end, { type: 'resize', screen: { rows: 40, cols: 80 } }));
    expect(rows(grown)).toHaveLength(30);
    expect(rows(grown)[0]).toContain('    2024 ');
  });
});

describe('the stats screen: top senders and top domains', () => {
  it('senders by size: the address on the left, size and messages on the right', () => {
    const out = frame(shown(STATS, 'senders', 'size'));
    expect(rows(out)).toEqual([
      row('    big@example-test-domain.eu', '3.8 MB   10', 13),
      row('    news@example-test-domain.eu', '2.9 MB  600', 13),
      row('    (no address)', '2.0 KB    5', 13),
    ]);
    expect(help(out)).toBe(HELP_STATS);
  });

  it('senders by messages: the other list of the read', () => {
    expect(rows(frame(shown(STATS, 'senders', 'messages')))).toEqual([
      row('    news@example-test-domain.eu', '2.9 MB  600', 13),
      row('    big@example-test-domain.eu', '3.8 MB   10', 13),
      row('    (no address)', '2.0 KB    5', 13),
    ]);
  });

  it('domains: a sender without a domain is "(no domain)"', () => {
    expect(rows(frame(shown(STATS, 'domains', 'size')))).toEqual([
      row('    example-test-domain.eu', '  8.6 MB  990', 15),
      row('    (no domain)', '976.6 KB   10', 15),
    ]);
  });

  it('"others" is the last row when the cap overflowed, in either order', () => {
    const stats = statsOf({
      senders: { ...STATS.senders, others: { messages: 385, bytes: 2_998_000 } },
    });
    expect(rows(frame(shown(stats, 'senders', 'size')))).toEqual([
      row('    big@example-test-domain.eu', '3.8 MB   10', 13),
      row('    news@example-test-domain.eu', '2.9 MB  600', 13),
      row('    (no address)', '2.0 KB    5', 13),
      row('    others', '2.9 MB  385', 13),
    ]);
    expect(rows(frame(shown(stats, 'senders', 'messages'))).at(-1)).toBe(
      row('    others', '2.9 MB  385', 13),
    );
    expect(text(frame(shown(stats, 'domains', 'size')))).not.toContain('others');
  });

  it('a key that is nothing once it is made safe is "(unreadable)"', () => {
    const odd: RankedRow[] = [
      { key: '\u200b\u202e\u0007', messages: 2, bytes: 20 },
      { key: '   ', messages: 1, bytes: 10 },
    ];
    const stats = statsOf({ senders: { byCount: odd, bySize: odd, others: NO_OTHERS } });
    expect(rows(frame(shown(stats, 'senders', 'size')))).toEqual([
      row('    (unreadable)', '20 B  2', 9),
      row('    (unreadable)', '10 B  1', 9),
    ]);
  });

  it('a long address is cut, never its cells', () => {
    const long = `${'a'.repeat(300)}@example-test-domain.eu`;
    const list: RankedRow[] = [{ key: long, messages: 12, bytes: 3_000_000 }];
    const stats = statsOf({ senders: { byCount: list, bySize: list, others: NO_OTHERS } });
    expect(rows(frame(shown(stats, 'senders', 'size', { screen: SMALLEST })))).toEqual([
      `    ${'a'.repeat(20)}... 2.9 MB  12`,
    ]);
  });
});

describe('the stats screen: largest mails', () => {
  it('size, the day it arrived, sender - subject (folder)', () => {
    const out = frame(shown(STATS, 'largest'));
    expect(rows(out)).toEqual([
      '      2.9 MB  2024-12-31  Big Sender - Quarterly report (INBOX)',
      '    146.5 KB  -           (no address) - (no subject) (Archive/2023)',
    ]);
    expect(help(out)).toBe(HELP_STATS);
  });

  it('the day is the day in the zone of the app', () => {
    const state = shown(STATS, 'largest');
    expect(rows(frame(state, { timeZone: 'Europe/Bratislava' }))[0]).toContain('  2025-01-01  ');
    expect(rows(frame(state, { timeZone: 'America/New_York' }))[0]).toContain('  2024-12-31  ');
    // Without a zone the frame is still exact (this computer's zone is used).
    expect(rows(frame(state, {}))[0]).toMatch(/ {2}202[45]-(12-31|01-01) {2}Big Sender - /);
  });

  it('below 56 columns the day is left out', () => {
    const at = (cols: number): string[] =>
      rows(frame(shown(STATS, 'largest', 'size', { screen: { rows: 10, cols } })));
    expect(at(56)[0]).toBe('      2.9 MB  2024-12-31  Big Sender - Quarterly repo...');
    expect(at(55)).toEqual([
      '      2.9 MB  Big Sender - Quarterly report (INBOX)',
      '    146.5 KB  (no address) - (no subject) (Archive/2...',
    ]);
    expect(at(40)).toEqual([
      '      2.9 MB  Big Sender - Quarterly ...',
      '    146.5 KB  (no address) - (no subj...',
    ]);
  });

  it('a sender or subject that is nothing once it is made safe counts as none', () => {
    const stats = statsOf({
      largest: [
        { folder: 'INBOX', received: null, from: ' \u200b ', subject: '\u0007\u202e', bytes: 9 },
      ],
    });
    expect(rows(frame(shown(stats, 'largest')))).toEqual([
      '    9 B  -           (no address) - (no subject) (INBOX)',
    ]);
  });

  it('a date that is no date is "-"', () => {
    const stats = statsOf({
      largest: [
        { folder: 'INBOX', received: new Date(Number.NaN), from: 'A', subject: 'B', bytes: 9 },
      ],
    });
    expect(rows(frame(shown(stats, 'largest')))).toEqual(['    9 B  -           A - B (INBOX)']);
  });
});

// --- hostile and wide strings ---------------------------------------------------------------

describe('what the mail server sent is drawn safe and to the width', () => {
  const ESC = '\u001b[31m';
  const hostile: RankedRow[] = [
    { key: `evil${ESC}\u202e@example-test-domain.eu\u0000`, messages: 3, bytes: 300 },
    { key: '\u4e2d\u6587\u90ae\u4ef6@example-test-domain.eu', messages: 2, bytes: 200 },
    { key: `a\r\nb\tc`, messages: 1, bytes: 100 },
  ];
  const STRANGE = statsOf({
    years: [
      { year: '2024', messages: 1, bytes: 100 },
      { year: `20${ESC}23\u202e`, messages: 1, bytes: 100 },
    ],
    senders: { byCount: hostile, bySize: hostile, others: NO_OTHERS },
    domains: { byCount: hostile, bySize: hostile, others: NO_OTHERS },
    largest: [
      {
        folder: `Folder${ESC}\u202e\u0007/Sub`,
        received: new Date(Date.UTC(2024, 5, 1)),
        from: `Evil${ESC} Sender\u202e`,
        subject: `Line one\r\nLine two\u0000 \ud83d\udce7 \u4e2d\u6587`,
        bytes: 5000,
      },
      {
        folder: '\u4e2d\u6587'.repeat(60),
        received: null,
        from: '\ud83d\udce7'.repeat(40),
        subject: 'x'.repeat(400),
        bytes: 4000,
      },
    ],
  });

  it('no control, bidi or zero-width character reaches a frame, at any size', () => {
    for (const screen of SCREENS) {
      for (const section of SECTIONS) {
        for (const by of ['size', 'messages'] as const) {
          expectSafe(frame(shown(STRANGE, section, by, { screen })));
        }
      }
    }
  });

  it('what is left of them is shown as text', () => {
    expect(rows(frame(shown(STRANGE, 'senders', 'size')))).toEqual([
      row('    evil[31m@example-test-domain.eu', '300 B  3', 10),
      row('    \u4e2d\u6587\u90ae\u4ef6@example-test-domain.eu', '200 B  2', 14),
      row('    abc', '100 B  1', 10),
    ]);
    expect(rows(frame(shown(STRANGE, 'largest', 'size', { screen: WIDE })))[0]).toBe(
      '    4.9 KB  2024-06-01  Evil[31m Sender - Line oneLine two \ud83d\udce7 \u4e2d\u6587 (Folder[31m/Sub)',
    );
    expect(rows(frame(shown(STRANGE, 'years')))[1]).toMatch(/^ {4}20\[31m23 /);
  });

  it('a failure text is drawn in ASCII and safe', () => {
    const failed = refused(act(barsReading(), ch('s')), `Lost${ESC} \u2014 try\u202e again\u2026`);
    const out = frame(failed);
    expect(lineAt(out, 1)).toBe('    Lost[31m - try again...');
    for (const line of out.lines) expect(line).toMatch(ASCII);
  });

  it('with plain data every line of every frame is ASCII', () => {
    const reading = act(barsReading(), ch('s'));
    const states = [
      barsIdle(),
      barsReading(),
      progressed(barsReading()),
      arrived(barsReading()),
      reading,
      progressed(reading),
      refused(reading, 'The mail server closed the connection. Try again later.'),
      ...SECTIONS.flatMap((section) => [shown(STATS, section), shown(EMPTY, section)]),
      shown(STATS, 'senders', 'messages'),
    ];
    for (const s of states) {
      for (const line of frame(s).lines) expect(line).toMatch(ASCII);
    }
  });
});

// --- reading, failed, not started -----------------------------------------------------------

describe('the stats screen without stats', () => {
  it('while reading: an empty body, the progress on the status line, no r in the help', () => {
    const s = act(barsReading(), ch('s'));
    const out = frame(s);
    expect(lineAt(out, 0)).toBe(header('Years - by size'));
    expect(out.lines.slice(1, -2).every((l) => l.trim() === '')).toBe(true);
    expect(status(out)).toBe('Stats: reading...');
    expect(help(out)).toBe('1-4 section  o size/messages  Esc back  q quit');
    expect(out.cursorLine).toBeNull();
    const counting = frame(progressed(s));
    expect(status(counting)).toBe('Stats: reading folder 3/12 - 5000/12345 messages');
    expect(counting.lines.slice(1, -2).every((l) => l.trim() === '')).toBe(true);
  });

  it('s on the bars with nothing read yet shows the same: the read has started', () => {
    const out = frame(act(barsIdle(), ch('s')));
    expect(status(out)).toBe('Stats: reading...');
    expect(out.lines.slice(1, -2).every((l) => l.trim() === '')).toBe(true);
  });

  it('after a failure: its text in the body, wrapped, and "r try again"', () => {
    const sentence =
      "Couldn't reach the mail server - check your internet connection and try again.";
    const out = frame(refused(act(barsReading(), ch('s')), `${sentence} ${sentence}`));
    expect(out.lines.slice(1, 5).map((l) => l.trimEnd())).toEqual([
      "    Couldn't reach the mail server - check your internet connection and try",
      "    again. Couldn't reach the mail server - check your internet connection and",
      '    try again.',
      '',
    ]);
    expect(status(out)).toBe('');
    expect(help(out)).toBe('r try again  Esc back  q quit');
    expect(out.cursorLine).toBeNull();
  });

  it('a failure too long for the body ends in "..."', () => {
    const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${String(i)}.`).join(' ');
    const out = frame(refused(act(barsReading({ screen: SMALLEST }), ch('s')), long));
    const body = out.lines.slice(1, -2).map((l) => l.trimEnd());
    expect(body).toHaveLength(5);
    expect(body[4]?.endsWith('...')).toBe(true);
    expect(help(out)).toBe('r try again  Esc back  q quit');
  });

  it('Gmail with All Mail hidden: its text, at once', () => {
    const gmail = treeOf({ totals: null, gmailAllHidden: true });
    for (const bars of [barsIdle({ tree: gmail }), barsReading({ tree: gmail })]) {
      const out = frame(act(bars, ch('s')));
      expect(out.lines.slice(1, 4).map((l) => l.trimEnd())).toEqual([
        "    Stats can't be read - Gmail hides All Mail from IMAP (Labels > Show in",
        '    IMAP).',
        '',
      ]);
      expect(help(out)).toBe('r try again  Esc back  q quit');
    }
    const wide = frame(act(barsIdle({ tree: gmail, screen: WIDE }), ch('s')));
    expect(lineAt(wide, 1)).toBe(`    ${STATS_GMAIL_HIDDEN}`);
    const narrow = frame(act(barsIdle({ tree: gmail, screen: SMALLEST }), ch('s')));
    expect(narrow.lines.slice(1, 4).map((l) => l.trimEnd())).toEqual([
      "    Stats can't be read - Gmail hides",
      '    All Mail from IMAP (Labels > Show in',
      '    IMAP).',
    ]);
  });

  it('a stats screen that never started a read says how to start one', () => {
    const bars = barsIdle();
    const idle: AppState = { ...bars, view: { ...view(bars), mode: 'stats' } };
    const out = frame(idle);
    expect(lineAt(out, 1)).toBe('    Press r to read the stats.');
    expect(status(out)).toBe('');
    expect(help(out)).toBe(HELP_STATS);
  });

  it('with more than 5,000 folders the stats screen has its own status line', () => {
    const s = act(barsReading({ tree: treeOf({ truncated: true }) }), ch('s'));
    expect(status(frame(progressed(s)))).toBe('Stats: reading folder 3/12 - 5000/12345 messages');
    expect(status(frame(arrived(s)))).toBe('');
    // Back on the bars the note about the folders is there again.
    expect(status(frame(act(arrived(s), key('escape'))))).toBe(
      'Only the first 5,000 folders are shown.',
    );
  });
});

// --- every frame ----------------------------------------------------------------------------

describe('the stats screen: frames and key help', () => {
  it('every section and state is an exact frame at 40x8, 80x24 and 200x50', () => {
    for (const screen of SCREENS) {
      const reading = act(barsReading({ screen }), ch('s'));
      const states = [
        reading,
        progressed(reading),
        refused(reading, 'The read failed. '.repeat(30)),
        ...SECTIONS.flatMap((section) =>
          (['size', 'messages'] as const).flatMap((by) => [
            shown(STATS, section, by, { screen }),
            shown(EMPTY, section, by, { screen }),
          ]),
        ),
      ];
      for (const s of states) {
        const out = frame(s);
        expect(out.cursorLine).toBeNull();
        expect(lineAt(out, 0).startsWith('Mail Manage')).toBe(true);
      }
    }
  });

  it('200x50: everything in one frame, the long bar', () => {
    const out = frame(shown(STATS, 'years', 'size', { screen: WIDE }));
    expect(lineAt(out, 0)).toBe(header('Years - by size', 200));
    expect(rows(out)[0]).toBe(row('    2024', '[##........]  25%   2.3 MB  249', 33, 200));
    expect(help(out)).toBe(HELP_STATS);
  });

  it('40 columns: "Esc back" and "q quit" stay in the help, whatever the state', () => {
    const screen = SMALLEST;
    const reading = act(barsReading({ screen }), ch('s'));
    expect(help(frame(shown(STATS, 'years', 'size', { screen })))).toBe(
      '1-4 section  Esc back  q quit',
    );
    expect(help(frame(reading))).toBe('1-4 section  Esc back  q quit');
    expect(help(frame(refused(reading, 'No.')))).toBe('r try again  Esc back  q quit');
  });

  it('the help by state: reading has no r, a failure only "r try again"', () => {
    const reading = view(act(barsReading(), ch('s')));
    const ready = view(shown());
    const failed = view(refused(act(barsReading(), ch('s')), 'No.'));
    expect(helpLine(statsHelp(ready), 80).trimEnd()).toBe(HELP_STATS);
    expect(helpLine(statsHelp(reading), 80).trimEnd()).toBe(
      '1-4 section  o size/messages  Esc back  q quit',
    );
    expect(helpLine(statsHelp(failed), 80).trimEnd()).toBe('r try again  Esc back  q quit');
    for (const v of [reading, ready, failed]) {
      for (let cols = 40; cols <= 80; cols++) {
        const line = helpLine(statsHelp(v), cols);
        expect(line).toContain('Esc back');
        expect(line).toContain('q quit');
      }
    }
  });

  it('below 40x8 only "window too small" is shown', () => {
    for (const screen of [
      { rows: 7, cols: 80 },
      { rows: 24, cols: 39 },
    ]) {
      const small = act(shown(), { type: 'resize', screen });
      const out = frame(small);
      expect(text(out)).toMatch(/[Tt]oo small/);
      expect(text(out)).not.toContain('Scanned');
      expect(text(out)).not.toContain('2024');
      expect(out.cursorLine).toBeNull();
    }
  });

  it('a resize is drawn at the new size', () => {
    const s = shown(STATS, 'senders', 'size');
    const out = frame(act(s, { type: 'resize', screen: { rows: 12, cols: 60 } }));
    expect(out.lines).toHaveLength(12);
    expect(rows(out)[0]).toBe(row('    big@example-test-domain.eu', '3.8 MB   10', 13, 60));
  });

  it('Esc: the bars again, with their own header, status line and key help', () => {
    const out = frame(act(shown(STATS, 'domains', 'messages'), key('escape')));
    expect(lineAt(out, 0)).toBe(header('tree order'));
    expect(lineAt(out, 1)).toBe('Total: 6 messages, 0 unread, 2.0 KB');
    expect(status(out)).toBe('Stats ready - press s');
    expect(out.cursorLine).toBe(3);
  });
});

// --- any stats, any window ------------------------------------------------------------------

describe('any stats in any window', () => {
  // Deterministic PRNG so a failure is reproducible.
  function prng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x1_0000_0000;
    };
  }

  /** Plain, wide, combining, control, bidi, zero-width, an escape sequence, half a surrogate pair. */
  const PIECES = [
    'a',
    'Z',
    '7',
    ' ',
    '@',
    '.',
    '-',
    'e\u0301',
    '\u4e2d\u6587',
    '\ud83d\udce7',
    '\u001b[31m',
    '\u202e',
    '\u200b',
    '\u200d',
    '\t',
    '\r\n',
    '\u0000',
    '\ud83d',
  ];

  function word(rand: () => number, max: number): string {
    const n = Math.floor(rand() * max);
    let out = '';
    for (let i = 0; i < n; i++) out += PIECES[Math.floor(rand() * PIECES.length)] ?? '';
    return out;
  }

  function count(rand: () => number): number {
    // Mostly small, sometimes huge.
    return Math.floor(rand() * (rand() < 0.2 ? 1e13 : 5000));
  }

  function rankedOf(rand: () => number): RankedStats {
    const list = (): RankedRow[] =>
      Array.from({ length: Math.floor(rand() * 12) }, () => ({
        key: rand() < 0.15 ? null : word(rand, 40),
        messages: count(rand),
        bytes: count(rand),
      }));
    const others = rand() < 0.5 ? NO_OTHERS : { messages: count(rand), bytes: count(rand) };
    return { byCount: list(), bySize: list(), others };
  }

  function randomStats(rand: () => number): MailboxStats {
    const years = Array.from({ length: Math.floor(rand() * 60) }, (_, i) => ({
      year: rand() < 0.05 ? word(rand, 6) : String(1970 + i),
      messages: count(rand),
      bytes: count(rand),
    }));
    if (rand() < 0.5) years.push({ year: 'unknown', messages: count(rand), bytes: count(rand) });
    return {
      folders: Array.from({ length: Math.floor(rand() * 4) }, () => ({
        path: word(rand, 20),
        messages: count(rand),
        bytes: count(rand),
        partial: rand() < 0.3,
      })),
      notScanned: Math.floor(rand() * 3),
      totals: { messages: rand() < 0.1 ? 0 : count(rand), bytes: rand() < 0.1 ? 0 : count(rand) },
      years,
      senders: rankedOf(rand),
      domains: rankedOf(rand),
      largest: Array.from({ length: Math.floor(rand() * 11) }, () => ({
        folder: word(rand, 30),
        received: rand() < 0.2 ? null : new Date(rand() * 4e12 - 1e12),
        from: rand() < 0.2 ? null : word(rand, 60),
        subject: rand() < 0.2 ? null : word(rand, 120),
        bytes: count(rand),
      })),
      approximate: rand() < 0.5,
      unreadable: Math.floor(rand() * 3),
      partial: Math.floor(rand() * 3),
    };
  }

  it('every frame is exact in size and free of what a terminal would act on', () => {
    const rand = prng(20261008);
    const zones = ['UTC', 'Europe/Bratislava', 'Pacific/Kiritimati', 'America/Los_Angeles'];
    for (let i = 0; i < 60; i++) {
      const screen = { rows: 8 + Math.floor(rand() * 50), cols: 40 + Math.floor(rand() * 180) };
      const stats = randomStats(rand);
      const section = SECTIONS[Math.floor(rand() * SECTIONS.length)] ?? 'years';
      const base = shown(stats, section, rand() < 0.5 ? 'size' : 'messages', {
        screen,
        email: `${word(rand, 30)}@example-test-domain.eu`,
      });
      // Any row, also one no key could have reached.
      const state: AppState = {
        ...base,
        view: { ...view(base), statsTop: Math.floor(rand() * 80) - 5 },
      };
      const timeZone = zones[Math.floor(rand() * zones.length)] ?? 'UTC';
      const out = frame(state, { timeZone });
      expectSafe(out);
      expect(out.cursorLine).toBeNull();
      expect(lineAt(out, 1).startsWith('Scanned ')).toBe(true);
      // The failure text of the same stats: wrapped, in ASCII.
      const failed = frame(refused(act(base, ch('r')), `${word(rand, 200)} ${word(rand, 200)}`));
      for (const line of failed.lines.slice(1)) expect(line).toMatch(ASCII);
    }
    // Many wide frames are measured: room for a busy machine.
  }, 30_000);
});

// --- the pieces -----------------------------------------------------------------------------

describe('the pieces of stats-render.ts', () => {
  it('statsBody: exactly the height asked for, every line the width, no cursor', () => {
    for (const s of [shown(), shown(EMPTY, 'largest'), act(barsReading(), ch('s'))]) {
      for (const [height, cols] of [
        [5, 40],
        [21, 80],
        [1, 40],
      ] as const) {
        const body = statsBody(view(s), height, cols, 'UTC');
        expect(body.lines).toHaveLength(height);
        for (const line of body.lines) expect(displayWidth(line)).toBe(cols);
        expect(body.cursorLine).toBeNull();
      }
    }
  });

  it('statsBody draws as many rows as statsRowCount counts', () => {
    const stats = statsOf({
      senders: { ...STATS.senders, others: { messages: 1, bytes: 1 } },
    });
    for (const section of SECTIONS) {
      for (const by of ['size', 'messages'] as const) {
        const body = statsBody(view(shown(stats, section, by)), 100, 120, 'UTC');
        const drawn = body.lines.slice(1).filter((l) => l.trim() !== '');
        expect(drawn).toHaveLength(statsRowCount(stats, section, by));
      }
    }
    expect(bodyHeight(SCREEN)).toBe(21);
  });

  it('an unknown time zone falls back to UTC instead of failing', () => {
    const body = statsBody(view(shown(STATS, 'largest')), 5, 80, 'Not/A_Zone');
    expect(body.lines[1]).toContain('  2024-12-31  ');
  });

  it('statsNote: the bars and a running read on the stats screen, nothing anywhere else', () => {
    const reading = barsReading();
    expect(statsNote(view(reading))).toBe('Stats: reading...');
    expect(statsNote(view(act(reading, ch('s'))))).toBe('Stats: reading...');
    expect(statsNote(view(shown()))).toBeNull();
    expect(statsNote(view(refused(act(reading, ch('s')), 'No.')))).toBeNull();
    expect(statsNote(view(connecting({}, true)))).toBeNull();
    expect(statsNote(view(browsing(reading)))).toBeNull();
    const marked = act(browsing(arrived(reading)), ch('a'), key('escape'));
    expect(statsNote(view(act(marked, key('escape'))))).toBeNull();
    expect(statsNote(view(act(marked, ch('q'))))).toBeNull();
  });

  it('wrap moved to the shared layout and is still what the mailbox screen exports', () => {
    expect(wrapOfMailbox).toBe(wrap);
    expect(wrap('one two three', 7)).toEqual(['one two', 'three']);
  });
});
