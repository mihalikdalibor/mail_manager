import { describe, it, expect } from 'vitest';
import { render, statusText } from '../../src/cli/browser/render.js';
import type { RenderOptions, Rendered } from '../../src/cli/browser/render.js';
import { initialState, openEmbedded, reduce } from '../../src/cli/browser/state.js';
import type {
  BrowserAction,
  BrowserEffect,
  BrowserState,
  BrowserStats,
  Reduced,
  Screen,
  StatusMessage,
} from '../../src/cli/browser/state.js';
import { displayWidth } from '../../src/cli/browser/width.js';
import { formatBytes } from '../../src/cli/folders-text.js';
import { emptyBasket } from '../../src/core/mailbox/basket.js';
import type { FolderInfo } from '../../src/core/mailbox/folders.js';
import type { MessageRow } from '../../src/core/mailbox/messages.js';
import type { Match, SearchResult } from '../../src/core/mailbox/search.js';

// M3a mail list on screen (spec): the filter row, the header counts, "Filtering...", the rows of a
// result, the key help and the status texts. Pure render() over states built with openEmbedded and
// reduce only. A state without a listing is drawn as before.

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
  folder('INBOX', { messages: 450, role: 'inbox', roleSource: 'path' }),
];

const TITLE = 'me@example-test-domain.eu';
const SCREEN: Screen = { rows: 24, cols: 100 };
const SCREENS: Screen[] = [
  { cols: 40, rows: 8 },
  { cols: 80, rows: 24 },
  { cols: 200, rows: 50 },
];
const NO_STATS: BrowserStats = { foldersOpened: 0, mailsLoaded: 0, reconnects: 0 };
// Ten columns like the default YYYY-MM-DD, but independent of the local time zone.
const FMT: RenderOptions = { formatDate: (d) => d.toISOString().slice(0, 10) };
const DAY = 86_400_000;
const JAN_1 = Date.UTC(2026, 0, 1);
const PAGE = 200; // rows per page of the browser

const HELP_BEFORE =
  'Up/Down move  PgUp/PgDn page  Enter open  Left back  Space mark  a mark screen  q quit  + = attachment';

/** A mail of the plain list (newest first, UIDs 1000 + seq). */
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

/** The first page of a folder with `exists` mails, as loadPage returns it. */
function pageRows(exists: number): MessageRow[] {
  const rows: MessageRow[] = [];
  for (let seq = exists; seq >= Math.max(1, exists - PAGE + 1); seq--) rows.push(mailRow(seq));
  return rows;
}

/** A match: its INTERNALDATE is `uid` days after 1 Jan 2026, 100 bytes, no attachment. */
function hit(uid: number, over: Partial<Match> = {}): Match {
  return { uid, bytes: 100, received: JAN_1 + DAY * uid, ...over };
}

/** A row of a match page, as loadMatches returns it. */
function rowOf(uid: number, over: Partial<MessageRow> = {}): MessageRow {
  return {
    seq: uid,
    uid,
    received: new Date(JAN_1 + DAY * uid),
    from: `Sender ${String(uid)}`,
    subject: `Subject ${String(uid)}`,
    bytes: 100,
    attachment: false,
    ...over,
  };
}

// --- effects and answers --------------------------------------------------------------------

type SearchEffect = Extract<BrowserEffect, { type: 'search' }>;
type MatchesEffect = Extract<BrowserEffect, { type: 'load-matches' }>;

function effectOf<T extends BrowserEffect['type']>(
  effects: readonly BrowserEffect[],
  type: T,
): Extract<BrowserEffect, { type: T }> {
  const found = effects.find((e): e is Extract<BrowserEffect, { type: T }> => e.type === type);
  if (found === undefined) throw new Error(`expected a ${type} effect`);
  return found;
}

/** INBOX opened embedded, its first page answered: `exists` mails. */
function openInbox(exists = 450, screen: Screen = SCREEN): BrowserState {
  const out = openEmbedded(TITLE, FOLDERS, screen, 'INBOX', emptyBasket, NO_STATS);
  const load = effectOf(out.effects, 'load');
  return reduce(out.state, {
    type: 'page-loaded',
    generation: load.generation,
    path: 'INBOX',
    page: 0,
    result: {
      kind: 'page',
      snapshot: { path: 'INBOX', uidValidity: '7', exists },
      page: 0,
      rows: pageRows(exists),
    },
  }).state;
}

/** `/` pressed, the line cleared and `text` typed; the line is still open. */
function typing(state: BrowserState, text: string): BrowserState {
  let s = reduce(state, { type: 'key', key: 'filter' }).state;
  s = reduce(s, { type: 'line', key: { type: 'clear' } }).state;
  for (const ch of [...text])
    s = reduce(s, { type: 'line', key: { type: 'char', text: ch } }).state;
  return s;
}

/** The line typed as `text` and Entered: the reduction, with the search it starts. */
function filterWith(state: BrowserState, text: string): Reduced {
  const s = typing(state, text);
  return reduce(s, { type: 'line', key: { type: 'enter' } });
}

/** The search of `text` started (not answered). */
function searchOf(
  state: BrowserState,
  text: string,
): { state: BrowserState; search: SearchEffect } {
  const out = filterWith(state, text);
  return { state: out.state, search: effectOf(out.effects, 'search') };
}

/** The search answered with `matches` (UID descending). */
function answerSearch(
  state: BrowserState,
  search: SearchEffect,
  matches: Match[],
  opts: { exists?: number; bytes?: number } = {},
): Reduced {
  let bytes = 0;
  for (const m of matches) bytes += m.bytes ?? 0;
  const result: SearchResult = {
    snapshot: { path: 'INBOX', uidValidity: '7', exists: opts.exists ?? 450 },
    matches,
    bytes: opts.bytes ?? bytes,
    missing: 0,
  };
  return reduce(state, {
    type: 'search-done',
    generation: search.generation,
    path: search.path,
    result,
  });
}

/** The page of matches answered with `rows`. */
function pageOf(e: MatchesEffect, rows: MessageRow[]): BrowserAction {
  return {
    type: 'page-loaded',
    generation: e.generation,
    path: e.path,
    page: e.page,
    result: { kind: 'page', snapshot: e.expected, page: e.page, rows },
  };
}

/**
 * The search of `text` answered with `matches`, and their page answered with `rows` (by default
 * every match). With no match there is no page to answer.
 */
function shown(
  state: BrowserState,
  search: SearchEffect,
  matches: Match[],
  opts: { rows?: MessageRow[]; exists?: number; bytes?: number } = {},
): BrowserState {
  const done = answerSearch(state, search, matches, opts);
  const load = done.effects.find((e): e is MatchesEffect => e.type === 'load-matches');
  if (load === undefined) return done.state;
  return reduce(done.state, pageOf(load, opts.rows ?? matches.map((m) => rowOf(m.uid)))).state;
}

/** The text of the last line (the key help). */
function helpOf(out: Rendered): string {
  return (out.lines[out.lines.length - 1] ?? '').trimEnd();
}

/** The status line: the line above the key help. */
function statusOf(out: Rendered): string {
  return out.lines[out.lines.length - 2] ?? '';
}

// --- the filter row -------------------------------------------------------------------------

describe('render: the filter row', () => {
  it('the filter row while typing', () => {
    const state = typing(openInbox(), 'shop.sk older:1y');
    const out = render(state, FMT);
    expect(out.lines[1]).toBe('Filter: shop.sk older:1y_'.padEnd(100));
    expect(out.cursorLine).toBeNull();
  });

  it('a line longer than the window keeps its end', () => {
    const state = typing(
      openInbox(450, { rows: 24, cols: 40 }),
      'from:anna@example-test-domain.eu older:1y larger:5mb unread',
    );
    const row = render(state, FMT).lines[1] ?? '';
    expect(displayWidth(row)).toBe(40);
    expect(row).toContain('...');
    expect(row.trimEnd().endsWith('unread_')).toBe(true);
    expect(row).not.toContain('from:anna');
  });

  it('the filter row with a result', () => {
    const shownList = openInbox();
    const { state: pending, search } = searchOf(shownList, 'shop.sk older:1y');
    const withOrder = answerSearch(pending, search, [hit(30)]);
    const row = render(withOrder.state, FMT).lines[1] ?? '';
    expect(row.startsWith('Filter: shop.sk older:1y')).toBe(true);
    expect(row.endsWith('newest first')).toBe(true);
    expect(displayWidth(row)).toBe(100);
    // The gap between the two parts is spaces.
    expect(row.slice('Filter: shop.sk older:1y'.length, 100 - 'newest first'.length).trim()).toBe(
      '',
    );

    // A blank line with the order largest: "(none)" and "largest first".
    let s = withOrder.state;
    s = reduce(s, { type: 'key', key: 'order' }).state;
    s = reduce(s, { type: 'key', key: 'order' }).state;
    s = reduce(s, { type: 'key', key: 'filter' }).state;
    s = reduce(s, { type: 'line', key: { type: 'clear' } }).state;
    s = reduce(s, { type: 'line', key: { type: 'enter' } }).state;
    const blank = render(s, FMT).lines[1] ?? '';
    expect(blank.startsWith('Filter: (none)')).toBe(true);
    expect(blank.endsWith('largest first')).toBe(true);
  });
});

// --- the header -----------------------------------------------------------------------------

describe('render: the header', () => {
  it('the header counts the matches', () => {
    const bytes = 50541363;
    const matches = Array.from({ length: 37 }, (_, i) => hit(37 - i));
    const { state, search } = searchOf(openInbox(4521), 'shop');
    const shownList = shown(state, search, matches, { exists: 4521, bytes });
    const head = render(shownList, FMT).lines[0] ?? '';
    expect(head.trimEnd().endsWith(`37 of 4521 mails, ${formatBytes(bytes)}`)).toBe(true);

    // One match of one mail.
    const one = searchOf(openInbox(1), 'shop');
    const oneShown = shown(one.state, one.search, [hit(1)], { exists: 1, bytes: 1536 });
    const oneHead = render(oneShown, FMT).lines[0] ?? '';
    expect(oneHead.trimEnd().endsWith(`1 of 1 mail, ${formatBytes(1536)}`)).toBe(true);

    // While filtering the header shows the folder's count, as before.
    const filtering = searchOf(openInbox(4521), 'shop');
    expect(render(filtering.state, FMT).lines[0]).toBe(render(openInbox(), FMT).lines[0]);
    expect(render(filtering.state, FMT).lines[0]).not.toContain(' of ');
  });

  it('a result with no match: the header counts 0', () => {
    const { state, search } = searchOf(openInbox(450), 'shop');
    const empty = shown(state, search, [], { exists: 450, bytes: 0 });
    const head = render(empty, FMT).lines[0] ?? '';
    expect(head.trimEnd().endsWith(`0 of 450 mails, ${formatBytes(0)}`)).toBe(true);
  });
});

// --- the list under a filter ----------------------------------------------------------------

describe('render: the list under a filter', () => {
  it('Filtering... with and without progress', () => {
    const { state, search } = searchOf(openInbox(), 'shop');
    expect(render(state, FMT).lines[2]?.trimEnd()).toBe('    Filtering...');
    const progressed = reduce(state, {
      type: 'search-progress',
      generation: search.generation,
      path: 'INBOX',
      done: 5000,
      total: 12000,
    }).state;
    expect(render(progressed, FMT).lines[2]?.trimEnd()).toBe('    Filtering... 5000/12000');
  });

  it('No mails match.', () => {
    const { state, search } = searchOf(openInbox(), 'shop');
    const empty = shown(state, search, []);
    expect(render(empty, FMT).lines[2]?.trimEnd()).toBe('    No mails match.');
  });

  it('rows of a result', () => {
    const { state, search } = searchOf(openInbox(), 'shop');
    // Before the page of matches arrives, every row says so.
    const waiting = render(answerSearch(state, search, [hit(30), hit(20), hit(10)]).state, FMT);
    expect(waiting.lines[2]).toContain('loading...');
    expect(waiting.lines[3]).toContain('loading...');
    expect(waiting.lines[4]).toContain('loading...');
    // UID 30 loaded with an attachment and marked, UID 20 loaded, UID 10 missing from the page.
    let s = shown(state, search, [hit(30), hit(20), hit(10)], {
      rows: [rowOf(30, { bytes: 1536, attachment: true }), rowOf(20, { bytes: 2048 })],
    });
    s = reduce(s, { type: 'key', key: 'space' }).state;
    const out = render(s, FMT);
    const first = out.lines[2] ?? '';
    expect(first).toContain('Subject 30');
    expect(first).toContain('Sender 30');
    expect(first).toContain('2026-01-31');
    expect(first).toContain(formatBytes(1536));
    expect(first).toContain('+');
    expect(first).toContain('[x]');
    const second = out.lines[3] ?? '';
    expect(second).toContain('Subject 20');
    expect(second).toContain(formatBytes(2048));
    expect(second).toContain('[ ]');
    expect(second).not.toContain('+');
    expect(out.lines[4]).toContain('(not readable)');
  });

  it('the cursor line is one lower under a filter row', () => {
    const plain = openInbox();
    expect(render(plain, FMT).cursorLine).toBe(1);
    const { state, search } = searchOf(plain, 'shop');
    const listed = shown(state, search, [hit(30), hit(20), hit(10)]);
    expect(render(listed, FMT).cursorLine).toBe(2);
    expect(render(typing(plain, 'shop'), FMT).cursorLine).toBeNull();
  });

  it('every frame is exactly rows lines, each cols wide', () => {
    for (const screen of SCREENS) {
      const plain = openInbox(450, screen);
      const typed = typing(plain, 'shop.sk older:1y');
      const { state: pending, search } = searchOf(plain, 'shop.sk older:1y');
      const result = shown(pending, search, [hit(30), hit(20), hit(10)]);
      const frames: [string, BrowserState][] = [
        ['plain', plain],
        ['typing', typed],
        ['filtering', pending],
        ['result', result],
      ];
      for (const [name, state] of frames) {
        const out = render(state, FMT);
        try {
          expect(out.lines).toHaveLength(screen.rows);
          for (const line of out.lines) expect(displayWidth(line)).toBe(screen.cols);
        } catch (err) {
          throw new Error(
            `${name} at ${String(screen.cols)}x${String(screen.rows)}: ${(err as Error).message}`,
            { cause: err },
          );
        }
      }
    }
  });

  it('the line error is the status line', () => {
    // An unreadable line: its message, from the line.
    const typedBad = typing(openInbox(), 'form:x');
    const bad = reduce(typedBad, { type: 'line', key: { type: 'enter' } }).state;
    expect(statusOf(render(bad, FMT))).toMatch(/^Don't know "form:x"/);

    // A result that comes while the line is open: its message is still said.
    const { state, search } = searchOf(openInbox(), 'shop');
    const open = reduce(state, { type: 'key', key: 'filter' }).state;
    const failed = reduce(open, {
      type: 'search-failed',
      generation: search.generation,
      path: 'INBOX',
      code: 'search-failed',
    }).state;
    expect(failed.mode).toBe('filter-edit');
    expect(statusOf(render(failed, FMT))).toMatch(/^The mail server couldn't run this filter/);
  });

  it('help while typing', () => {
    const typed = typing(openInbox(), '');
    expect(helpOf(render(typed, FMT))).toBe(
      'Enter apply  Esc cancel  e.g. shop.sk  from:x  older:1y  larger:5mb  unread  att',
    );
    const narrow = typing(openInbox(450, { rows: 8, cols: 40 }), '');
    expect(helpOf(render(narrow, FMT)).startsWith('Enter apply  Esc cancel')).toBe(true);
  });

  it('embedded help names the new keys', () => {
    const at80 = openInbox(450, { rows: 24, cols: 80 });
    const out80 = render(at80, FMT);
    expect(out80.lines[23]).toBe(
      'Up/Down move  Enter open  Esc/Left back  / filter  o order  Space mark  q quit'.padEnd(80),
    );

    const at200 = openInbox(450, { rows: 50, cols: 200 });
    expect(helpOf(render(at200, FMT))).toBe(
      'Up/Down move  PgUp/PgDn page  Enter open  Esc/Left back  / filter  o order  Space mark  a mark screen  m mark all  q quit  + = attachment',
    );
  });

  it('the stand-alone help is unchanged', () => {
    const root = initialState(TITLE, FOLDERS, { rows: 50, cols: 200 });
    expect(helpOf(render(root, FMT))).toBe(HELP_BEFORE);
  });

  it('the stand-alone frame has no filter row', () => {
    // A positive control: the same browser embedded does draw one.
    expect(render(typing(openInbox(), 'shop'), FMT).lines[1]).toContain('Filter:');
    for (const screen of SCREENS) {
      const root = initialState(TITLE, FOLDERS, screen);
      const frame = render(root, FMT).lines.join('\n');
      expect(frame).not.toContain('Filter');
    }
  });

  it('status texts', () => {
    const cases: [StatusMessage, string][] = [
      [{ code: 'search-failed' }, "The mail server couldn't run this filter - try a simpler one."],
      [{ code: 'too-many-matches' }, 'More than 500,000 mails to go through - narrow the filter.'],
      [
        { code: 'mark-all-needs-list' },
        'm marks every mail of a filtered list - press / and type a filter first.',
      ],
      [
        { code: 'too-many-to-mark', count: 100001 },
        'Too many mails to mark at once (100001) - narrow the filter.',
      ],
      [{ code: 'marked-all', count: 3 }, 'Marked 3 mails.'],
      [{ code: 'marked-all', count: 1 }, 'Marked 1 mail.'],
      [{ code: 'unmarked-all', count: 3 }, 'Unmarked 3 mails.'],
      [
        { code: 'search-partial', count: 4 },
        "4 mails couldn't be read - the list may be incomplete (/ and Enter tries again).",
      ],
      [
        { code: 'search-partial', count: 1 },
        "1 mail couldn't be read - the list may be incomplete (/ and Enter tries again).",
      ],
    ];
    for (const [message, text] of cases) {
      expect(statusText(message)).toBe(text);
      expect(statusText(message)).toMatch(/^[\x20-\x7e]+$/);
    }
  });

  it('typed text is sanitised', () => {
    // A right-to-left override typed into the line is not drawn.
    const state = typing(openInbox(), 'a\u202eb');
    const out = render(state, FMT);
    expect(out.lines[1]).not.toContain('\u202e');
    expect(out.lines[1]).toContain('Filter: ');

    // The same in the error text of an unreadable line.
    const bad = reduce(typing(openInbox(), 'form:\u202ex'), {
      type: 'line',
      key: { type: 'enter' },
    }).state;
    expect(statusOf(render(bad, FMT))).not.toContain('\u202e');
  });

  it('too small with the line open', () => {
    const open = typing(openInbox(), 'shop');
    const small = reduce(open, { type: 'resize', screen: { rows: 8, cols: 39 } }).state;
    const out = render(small, FMT);
    expect(out.lines).toHaveLength(8);
    expect(out.lines.join('\n')).toContain('Filter - Esc cancels');
  });

  it('an unreadable match row says (not readable)', () => {
    const { state, search } = searchOf(openInbox(), 'shop');
    // UID 20 is gone from its page: its row says so.
    const s = shown(state, search, [hit(30), hit(20), hit(10)], {
      rows: [rowOf(30), rowOf(10)],
    });
    const out = render(s, FMT);
    expect(out.lines[3]).toContain('(not readable)');
    expect(out.lines[3]).not.toContain('Subject 20');
  });
});
