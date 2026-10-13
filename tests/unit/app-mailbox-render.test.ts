import { describe, it, expect } from 'vitest';
import { wrap } from '../../src/cli/app/mailbox-render.js';
import { reduceApp, startApp } from '../../src/cli/app/reduce.js';
import { messageText, renderApp } from '../../src/cli/app/render.js';
import { initialApp } from '../../src/cli/app/state.js';
import type {
  AppAction,
  AppEffect,
  AppKey,
  AppState,
  MailboxRow,
} from '../../src/cli/app/state.js';
import { CHALLENGE_NOTICE } from '../../src/cli/browser/controller.js';
import { render as renderBrowser } from '../../src/cli/browser/render.js';
import type { Rendered } from '../../src/cli/browser/render.js';
import type { Screen } from '../../src/cli/browser/state.js';
import { displayWidth } from '../../src/cli/browser/width.js';
import type { AuthUser } from '../../src/core/auth.js';
import type { FolderInfo, FolderTree } from '../../src/core/mailbox/folders.js';
import type { MessageRow } from '../../src/core/mailbox/messages.js';

// M2d-2 mailbox screen, drawn: renderApp over states built with the reducers - the waiting
// screens, the bars (totals, quota, one row per folder), the failed screen, the questions, and
// the browser's own frame inside a folder. Addresses are placeholders; hostile and non-ASCII
// characters are written as escapes.

// --- fixtures -------------------------------------------------------------------------------

const ANNA: AuthUser = { email: 'anna@example-test-domain.eu', userId: 'user-anna' };
const EMAIL = 'box@example-test-domain.eu';
const SCREEN: Screen = { rows: 24, cols: 80 };
const SMALLEST: Screen = { rows: 8, cols: 40 };
const WIDE: Screen = { rows: 50, cols: 200 };
const SCREENS: Screen[] = [SMALLEST, SCREEN, WIDE];
const ASCII = /^[\x20-\x7e]*$/;
const NO_QUOTA = 'Quota: not available from the mail server';
const HELP_BARS = 'Up/Down move  Enter open  o sort  s stats  Esc back  q quit';

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

/** The mailbox adds up to 10,000 bytes unless said otherwise: 100 bytes are one per cent. */
function treeOf(folders: FolderInfo[], over: Partial<FolderTree> = {}): FolderTree {
  return {
    folders,
    totals: { messages: 222, unseen: 9, bytes: 10_000, sizeSource: 'server' },
    quota: null,
    truncated: false,
    unreadable: 0,
    gmailAllHidden: false,
    fallbacks: new Set(),
    ...over,
  };
}

// One folder of every kind. Widest size cell: 7 columns, widest count: 3.
const MIXED = treeOf(
  [
    folder('INBOX', { bytes: 5000, messages: 123 }),
    folder('Archive', {
      selectable: false,
      messages: null,
      unseen: null,
      bytes: null,
      sizeSource: null,
    }),
    folder('Archive/2023', { bytes: 3000, messages: 45, sizeSource: 'sum' }),
    folder('Label', { overlapping: true, bytes: 1500, messages: 7 }),
    folder('Old', { subscribed: false, bytes: 400, messages: 2 }),
    folder('Tiny', { bytes: 20, messages: 1 }),
    folder('Empty', { bytes: 0, messages: 0 }),
    folder('Unknown', { bytes: null, sizeSource: null, messages: 4 }),
  ],
  { totals: { messages: 222, unseen: 9, bytes: 10_000, sizeSource: 'sum' } },
);

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

function resized(state: AppState, screen: Screen): AppState {
  return act(state, { type: 'resize', screen });
}

/** Enter on the one mailbox of Home: "Connecting...". */
function connecting(screen: Screen = SCREEN, email = EMAIL): AppState {
  const row: MailboxRow = { id: 'box-1', email, provider: 'websupport', lastCheckedAt: null };
  const s0 = startApp(initialApp('1.2.3', screen)).state;
  const s1 = act(
    s0,
    { type: 'session', generation: s0.generation, user: ANNA, remembered: [ANNA.email] },
    key('enter'),
  );
  return act(s1, { type: 'mailboxes', generation: s1.generation, rows: [row] }, key('enter'));
}

function reading(screen: Screen = SCREEN): AppState {
  const s = connecting(screen);
  return act(s, { type: 'mailbox-reading', generation: s.generation });
}

function ready(tree: FolderTree, screen: Screen = SCREEN, email = EMAIL): AppState {
  const s = connecting(screen, email);
  return act(
    s,
    { type: 'mailbox-reading', generation: s.generation },
    { type: 'mailbox-opened', generation: s.generation, tree },
  );
}

function failed(text: string, screen: Screen = SCREEN): AppState {
  const s = reading(screen);
  return act(s, { type: 'mailbox-failed', generation: s.generation, text });
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

/** Enter on the first folder; `answer` builds what the controller sends back for its page. */
function inFolder(
  bars: AppState,
  answer: (load: Extract<AppEffect, { type: 'load-page' }>) => AppAction,
): AppState {
  const out = reduceApp(bars, key('enter'));
  const load = out.effects.find((e) => e.type === 'load-page');
  if (load?.type !== 'load-page') throw new Error('no load-page effect');
  return act(out.state, answer(load));
}

/** The first folder open with its three mails on screen. */
function browsing(tree: FolderTree = MIXED, screen: Screen = SCREEN): AppState {
  return inFolder(ready(tree, screen), (load) => ({
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

/** The bars again, three mails marked. */
function barsWithMarks(screen: Screen = SCREEN): AppState {
  return act(browsing(MIXED, screen), ch('a'), key('escape'));
}

// --- reading a frame ------------------------------------------------------------------------

/** The frame of `state`, proven exact: `rows` lines of `cols` columns. */
function frame(state: AppState): Rendered {
  const out = renderApp(state);
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

/** The body below the totals and quota lines, without the blank rest. */
function rows(out: Rendered): string[] {
  return out.lines
    .slice(3, -2)
    .map((l) => l.trimEnd())
    .filter((l) => l !== '');
}

function text(out: Rendered): string {
  return out.lines.join('\n');
}

/** A folder row as it is drawn: the name cell, then the right cells `width` columns wide. */
function row(left: string, right: string, width: number, cols = 80): string {
  return `${left.padEnd(cols - width)}${right}`.trimEnd();
}

/** The frame of a mailbox with this one folder: its row. */
function only(f: FolderInfo, over: Partial<FolderTree> = {}): string {
  return rows(frame(ready(treeOf([f], over))))[0] ?? '';
}

// --- waiting --------------------------------------------------------------------------------

describe('connecting and reading', () => {
  it('"Connecting...": the mailbox in the header, an empty body, Esc and q', () => {
    const out = frame(connecting());
    expect(lineAt(out, 0)).toBe(`Mail Manager - ${EMAIL}`);
    expect(out.lines.slice(1, -2).every((l) => l.trim() === '')).toBe(true);
    expect(status(out)).toBe('Connecting...');
    expect(help(out)).toBe('Esc back  q quit');
    expect(out.cursorLine).toBeNull();
  });

  it('"Reading folders...", then with the size fallback\'s n/m', () => {
    const s = reading();
    const out = frame(s);
    expect(lineAt(out, 0)).toBe(`Mail Manager - ${EMAIL}`);
    expect(status(out)).toBe('Reading folders...');
    expect(help(out)).toBe('Esc back  q quit');
    const progress = { folder: 7, folders: 12, done: 400, total: 9000 };
    const counting = act(s, { type: 'mailbox-progress', generation: s.generation, progress });
    expect(status(frame(counting))).toBe('Reading folders... 7/12');
  });

  it('the login guard waits: its notice instead of "Connecting..."', () => {
    const s = connecting();
    const out = frame(act(s, { type: 'challenge', generation: s.generation }));
    expect(status(out)).toBe(CHALLENGE_NOTICE);
    expect(text(out)).not.toContain('Connecting...');
  });

  it('nothing of the bars is drawn before the folders are there', () => {
    for (const s of [connecting(), reading()]) {
      const out = text(frame(s));
      expect(out).not.toContain('Total');
      expect(out).not.toContain('Quota');
      expect(out).not.toContain('order');
    }
  });
});

describe('messageText of the mailbox screen', () => {
  it('the three new messages, in ASCII', () => {
    expect(messageText('folder-unavailable')).toBe("Couldn't open that folder.");
    expect(messageText('truncated')).toBe('Only the first 5,000 folders are shown.');
    expect(messageText('challenge')).toBe(CHALLENGE_NOTICE);
    for (const m of ['folder-unavailable', 'truncated', 'challenge'] as const) {
      expect(messageText(m)).toMatch(ASCII);
    }
  });
});

// --- the bars -------------------------------------------------------------------------------

describe('the bars: the whole frame', () => {
  it('80x24: header, totals, quota, one row per folder, status, key help', () => {
    const out = frame(ready(MIXED));
    expect(lineAt(out, 0)).toBe(`${`Mail Manager - ${EMAIL}`.padEnd(70)}tree order`);
    expect(lineAt(out, 1)).toBe('Total: 222 messages, 9 unread, ~9.8 KB');
    expect(lineAt(out, 2)).toBe(NO_QUOTA);
    // Right cells: bar (12), percent (4), size (7), messages (3) = 33 columns with the gaps.
    const blank = ' '.repeat(19);
    expect(rows(out)).toEqual([
      row('    INBOX', '[#####.....]  50%   4.9 KB  123', 33),
      row('    Archive', `${blank}      -    -`, 33),
      row('      2023', '[###.......]  30%  ~2.9 KB   45', 33),
      row('    Label (overlapping)', `${blank} 1.5 KB    7`, 33),
      row('    Old (hidden)', '[#.........]   4%    400 B    2', 33),
      row('    Tiny', '[#.........]  <1%     20 B    1', 33),
      row('    Empty', '[..........]   0%      0 B    0', 33),
      row('    Unknown', `${blank}      -    4`, 33),
    ]);
    expect(status(out)).toBe('Stats: press s to read');
    expect(help(out)).toBe(HELP_BARS);
    expect(out.cursorLine).toBe(3);
  });

  it('every mode is an exact frame at 40x8, 80x24 and 200x50', () => {
    const modes: [string, (screen: Screen) => AppState][] = [
      ['connecting', (s) => connecting(s)],
      ['reading', (s) => reading(s)],
      ['ready', (s) => ready(MIXED, s)],
      ['by size', (s) => act(ready(MIXED, s), ch('o'))],
      ['by name', (s) => act(ready(MIXED, s), ch('o'), ch('o'))],
      ['no folders', (s) => ready(treeOf([], { totals: null }), s)],
      ['failed', (s) => failed('It did not work. Try it again later. '.repeat(20), s)],
      ['leave question', (s) => act(barsWithMarks(s), key('escape'))],
      ['quit question', (s) => act(barsWithMarks(s), ch('q'))],
      ['in a folder', (s) => browsing(MIXED, s)],
    ];
    for (const screen of SCREENS) {
      for (const [name, make] of modes) {
        try {
          frame(make(screen));
        } catch (err) {
          throw new Error(
            `${name} at ${String(screen.cols)}x${String(screen.rows)}: ${(err as Error).message}`,
            { cause: err },
          );
        }
      }
    }
  });

  it('what the app draws itself is plain ASCII', () => {
    const tree = treeOf(MIXED.folders, {
      quota: { usedBytes: 30_720, limitBytes: 102_400 },
      unreadable: 2,
      truncated: true,
    });
    for (const screen of SCREENS) {
      for (const s of [ready(tree, screen), act(ready(tree, screen), ch('o'))]) {
        for (const line of frame(s).lines) expect(line).toMatch(ASCII);
      }
    }
  });

  it('no folders: "No folders" below the two lines, no cursor', () => {
    const out = frame(ready(treeOf([], { totals: null })));
    expect(lineAt(out, 1)).toBe('Totals unknown.');
    expect(lineAt(out, 2)).toBe(NO_QUOTA);
    expect(rows(out)).toEqual(['    No folders']);
    expect(out.cursorLine).toBeNull();
  });
});

describe('the bars: bar and percent of a folder', () => {
  // Of 10,000 bytes: [bytes, filled cells, percent].
  it.each<[number, number, string]>([
    [0, 0, '0%'],
    [1, 1, '<1%'],
    [49, 1, '<1%'],
    [50, 1, '1%'],
    [400, 1, '4%'],
    [1499, 1, '15%'],
    [1500, 2, '15%'],
    [2400, 2, '24%'],
    [2600, 3, '26%'],
    [5000, 5, '50%'],
    [9400, 9, '94%'],
    [9500, 10, '95%'],
    [10_000, 10, '100%'],
    // Larger than the sum (it changed since): never more than full.
    [25_000, 10, '100%'],
  ])('%i bytes: %i cells, %s', (bytes, cells, percent) => {
    const line = only(folder('Box', { bytes, messages: 1 }));
    const bar = `[${'#'.repeat(cells)}${'.'.repeat(10 - cells)}]`;
    expect(line).toContain(`${bar} ${percent.padStart(4)}  `);
  });

  it.each<[string, Partial<FolderInfo>, Partial<FolderTree>]>([
    ['a Gmail label (overlapping)', { overlapping: true, bytes: 5000 }, {}],
    ['a size that is unknown', { bytes: null, sizeSource: null }, {}],
    ['a folder that holds no mails', { selectable: false, bytes: 5000 }, {}],
    ['a mailbox whose sum is unknown', { bytes: 5000 }, { totals: null }],
    [
      'a sum without a size',
      { bytes: 5000 },
      { totals: { messages: 1, unseen: 0, bytes: null, sizeSource: null } },
    ],
    [
      'a sum of nothing',
      { bytes: 0 },
      { totals: { messages: 0, unseen: 0, bytes: 0, sizeSource: 'server' } },
    ],
    ['Gmail with All Mail hidden', { bytes: 5000 }, { gmailAllHidden: true }],
  ])('%s has no bar and no percent', (_name, over, tree) => {
    const line = only(folder('Box', { messages: 1, ...over }), tree);
    expect(line).toContain('Box');
    expect(line).not.toMatch(/[[\]#%]/);
  });

  it('without any bar in the mailbox the bar columns are not kept free', () => {
    const tree = treeOf(
      [folder('One', { bytes: 5000, messages: 12 }), folder('Two', { bytes: null, messages: 3 })],
      { totals: null },
    );
    expect(rows(frame(ready(tree)))).toEqual([
      row('    One', '4.9 KB  12', 12),
      row('    Two', '     -   3', 12),
    ]);
  });

  it('an unknown size is "-", a size we added up has "~", an unknown count is "-"', () => {
    expect(only(folder('Box', { bytes: null, sizeSource: null, messages: 4 }))).toMatch(/ - {2}4$/);
    expect(only(folder('Box', { bytes: 5000, sizeSource: 'sum', messages: 4 }))).toMatch(
      / 50% {2}~4\.9 KB {2}4$/,
    );
    expect(only(folder('Box', { bytes: 5000, messages: null }))).toMatch(/ 50% {2}4\.9 KB {2}-$/);
  });

  it('the tags: (hidden), (overlapping), both', () => {
    expect(only(folder('Box', { subscribed: false, bytes: 5000 }))).toMatch(
      /^ {4}Box \(hidden\) +\[#####\.\.\.\.\.\] {2}50% /,
    );
    expect(only(folder('Box', { overlapping: true }))).toMatch(/^ {4}Box \(overlapping\) /);
    expect(only(folder('Box', { subscribed: false, overlapping: true }))).toMatch(
      /^ {4}Box \(hidden\) \(overlapping\) /,
    );
    // Not tagged: what kind of folder it is otherwise.
    const plain = only(
      folder('Box', { selectable: false, role: 'trash', roleSource: 'extension' }),
    );
    expect(plain).toMatch(/^ {4}Box +0 B/);
  });
});

describe('the bars: the totals line', () => {
  const totals = (over: Partial<FolderTree>, screen: Screen = SCREEN): string =>
    lineAt(frame(ready(treeOf(MIXED.folders, over), screen)), 1);

  it('messages, unread and the size as the server gave it or as we added it up', () => {
    expect(totals({})).toBe('Total: 222 messages, 9 unread, 9.8 KB');
    expect(totals({ totals: { messages: 1, unseen: 0, bytes: 2048, sizeSource: 'sum' } })).toBe(
      'Total: 1 messages, 0 unread, ~2.0 KB',
    );
  });

  it('a part that is unknown is "-"', () => {
    expect(
      totals({ totals: { messages: null, unseen: null, bytes: null, sizeSource: null } }),
    ).toBe('Total: - messages, - unread, -');
  });

  it("folders that couldn't be read are counted on it", () => {
    expect(totals({ unreadable: 1 })).toBe(
      "Total: 222 messages, 9 unread, 9.8 KB, 1 folder couldn't be read",
    );
    expect(totals({ unreadable: 3 })).toBe(
      "Total: 222 messages, 9 unread, 9.8 KB, 3 folders couldn't be read",
    );
  });

  it('Gmail with All Mail hidden: the note, whatever the totals say', () => {
    const note = 'Totals unknown - Gmail hides All Mail from IMAP (Labels > Show in IMAP).';
    expect(totals({ gmailAllHidden: true, totals: null })).toBe(note);
    expect(totals({ gmailAllHidden: true })).toBe(note);
    expect(totals({ gmailAllHidden: true, totals: null, unreadable: 2 }, WIDE)).toBe(
      `${note} 2 folders couldn't be read.`,
    );
  });

  it('unknown without Gmail', () => {
    expect(totals({ totals: null })).toBe('Totals unknown.');
    expect(totals({ totals: null, unreadable: 1 })).toBe(
      "Totals unknown. 1 folder couldn't be read.",
    );
  });
});

describe('the bars: the quota line', () => {
  const quota = (used: number, limit: number | null): string =>
    lineAt(
      frame(ready(treeOf(MIXED.folders, { quota: { usedBytes: used, limitBytes: limit } }))),
      2,
    );

  it('with a limit: its own bar, percent, used of limit', () => {
    expect(quota(30_720, 102_400)).toBe('Quota: [###.......] 30%  30.0 KB of 100.0 KB');
    expect(quota(0, 102_400)).toBe('Quota: [..........] 0%  0 B of 100.0 KB');
    expect(quota(100, 102_400)).toBe('Quota: [#.........] <1%  100 B of 100.0 KB');
    expect(quota(102_400, 102_400)).toBe('Quota: [##########] 100%  100.0 KB of 100.0 KB');
  });

  it('over the limit: the bar is full, the percent says by how much', () => {
    expect(quota(122_880, 102_400)).toBe('Quota: [##########] 120%  120.0 KB of 100.0 KB');
  });

  it('no limit, a limit of nothing, or no quota at all: not available', () => {
    expect(quota(5000, null)).toBe(NO_QUOTA);
    expect(quota(5000, 0)).toBe(NO_QUOTA);
    expect(lineAt(frame(ready(treeOf(MIXED.folders, { quota: null }))), 2)).toBe(NO_QUOTA);
  });
});

describe('the bars: the order', () => {
  const NESTED = treeOf([
    folder('beta', { bytes: 1000 }),
    folder('beta/Deep', { bytes: 6000 }),
    folder('beta/Deep/est', { bytes: null, sizeSource: null }),
    folder('Alpha', { bytes: 3000 }),
  ]);
  const names = (out: Rendered): string[] => rows(out).map((l) => l.slice(0, 22).trimEnd());

  it('tree order: the last name, two columns deeper per level', () => {
    const out = frame(ready(NESTED));
    expect(lineAt(out, 0).endsWith('tree order')).toBe(true);
    expect(names(out)).toEqual(['    beta', '      Deep', '        est', '    Alpha']);
  });

  it('o: by size, largest first, the unknown one last; full paths, no indent', () => {
    const out = frame(act(ready(NESTED), ch('o')));
    expect(lineAt(out, 0).endsWith('by size')).toBe(true);
    expect(names(out)).toEqual(['    beta/Deep', '    Alpha', '    beta', '    beta/Deep/est']);
  });

  it('o again: by name, whatever the letter case; then the tree again', () => {
    const byName = frame(act(ready(NESTED), ch('o'), ch('o')));
    expect(lineAt(byName, 0).endsWith('by name')).toBe(true);
    expect(names(byName)).toEqual(['    Alpha', '    beta', '    beta/Deep', '    beta/Deep/est']);
    const again = frame(act(ready(NESTED), ch('o'), ch('o'), ch('o')));
    expect(lineAt(again, 0).endsWith('tree order')).toBe(true);
  });

  it('the highlighted row is the same folder after o', () => {
    const s = act(ready(NESTED), key('down'));
    for (const presses of [0, 1, 2, 3]) {
      const out = frame(act(s, ...repeat(ch('o'), presses)));
      expect(out.lines[out.cursorLine ?? -1]).toMatch(/^ +(beta\/)?Deep /);
    }
  });
});

// --- narrow windows -------------------------------------------------------------------------

describe('the bars: right cells of a narrow window', () => {
  // Size cells 6 wide, counts 4 wide.
  const SMALL_CELLS = treeOf([
    folder('INBOX', { bytes: 5000, messages: 7777 }),
    folder('Folder-12abc', { bytes: 3000, messages: 55 }),
  ]);
  // Size cells 10 wide, counts 10 wide.
  const BIG_CELLS = treeOf(
    [
      folder('INBOX', { bytes: 1_073_636_966, sizeSource: 'sum', messages: 1_234_567_890 }),
      folder('Folder-12abc', { bytes: 322_122_547, messages: 55 }),
    ],
    { totals: { messages: 1, unseen: 0, bytes: 2_147_273_932, sizeSource: 'sum' } },
  );
  const inbox = (tree: FolderTree, cols: number): string =>
    (rows(frame(ready(tree, { rows: 10, cols })))[0] ?? '').slice(4 + 'INBOX'.length).trim();

  it.each<[number, string]>([
    [200, '[#####.....]  50%  4.9 KB  7777'],
    [50, '[#####.....]  50%  4.9 KB  7777'],
    // One column less: the bar shrinks to six cells.
    [49, '[###...]  50%  4.9 KB  7777'],
    [46, '[###...]  50%  4.9 KB  7777'],
    // Then the bar goes.
    [45, '50%  4.9 KB  7777'],
    [40, '50%  4.9 KB  7777'],
  ])('%i columns: %s', (cols, cells) => {
    expect(inbox(SMALL_CELLS, cols)).toBe(cells);
  });

  it.each<[number, string]>([
    [60, '[#####.....]  50%  ~1023.9 MB  1234567890'],
    [59, '[###...]  50%  ~1023.9 MB  1234567890'],
    [56, '[###...]  50%  ~1023.9 MB  1234567890'],
    [55, '50%  ~1023.9 MB  1234567890'],
    [47, '50%  ~1023.9 MB  1234567890'],
    // Then the percent goes, then the count.
    [46, '~1023.9 MB  1234567890'],
    [41, '~1023.9 MB  1234567890'],
    [40, '~1023.9 MB'],
  ])('wide cells, %i columns: %s', (cols, cells) => {
    expect(inbox(BIG_CELLS, cols)).toBe(cells);
  });

  it('one set for the whole frame, and the name keeps its twelve columns', () => {
    for (const tree of [SMALL_CELLS, BIG_CELLS]) {
      for (let cols = 40; cols <= 70; cols++) {
        const [first, second] = rows(frame(ready(tree, { rows: 10, cols })));
        expect(second).toContain('    Folder-12abc ');
        const kind = (line = ''): string =>
          `${String(/\[[#.]+\]/.exec(line)?.[0].length ?? 0)} ${String(line.includes('%'))}`;
        expect(kind(first)).toBe(kind(second));
      }
    }
  });

  it('40x8: the totals and quota lines are cut to the width, three folder rows fit', () => {
    const tree = treeOf(MIXED.folders, {
      gmailAllHidden: true,
      quota: { usedBytes: 30_720, limitBytes: 102_400 },
    });
    const out = frame(ready(tree, SMALLEST));
    expect(lineAt(out, 0)).toBe('Mail Manager - box@example... tree order');
    expect(lineAt(out, 1)).toBe('Totals unknown - Gmail hides All Mail...');
    expect(lineAt(out, 2)).toBe('Quota: [###.......] 30%  30.0 KB of 1...');
    expect(rows(out)).toEqual([
      row('    INBOX', ' 4.9 KB  123', 14, 40),
      row('    Archive', '      -    -', 14, 40),
      row('      2023', '~2.9 KB   45', 14, 40),
    ]);
    expect(help(out)).toBe('Up/Down move  Enter open  o sort  q quit');
  });

  it('a long name is cut, never the cells', () => {
    const long = 'A folder name that is much longer than its window';
    const line = rows(frame(ready(treeOf([folder(long, { bytes: 5000, messages: 9 })]), SMALLEST)));
    expect(line).toEqual(['    A folder name t...  50%  4.9 KB  9']);
  });

  it("a deep folder's indent gives way before its name does", () => {
    const deep = Array.from({ length: 14 }, (_, i) => 'abcdefghijklmn'.slice(i, i + 1)).join('/');
    const tree = treeOf([folder('INBOX', { bytes: 5000 }), folder(deep, { name: 'Deep-folder1' })]);
    // 40 columns leave 18 for the indent and the name: 12 are the name's, so 6 of the 26
    // columns of indent stay.
    expect(rows(frame(ready(tree, SMALLEST)))[1]).toBe('          Deep-folder1   0%     0 B  0');
    // With room, the whole indent.
    expect(rows(frame(ready(tree, WIDE)))[1]?.startsWith(`${' '.repeat(30)}Deep-folder1 `)).toBe(
      true,
    );
  });
});

// --- scrolling ------------------------------------------------------------------------------

describe('the bars: more folders than rows', () => {
  const MANY = treeOf(
    Array.from({ length: 40 }, (_, i) =>
      folder(`Folder${String(i).padStart(2, '0')}`, { bytes: 250 }),
    ),
  );

  it('the totals and quota lines stay; the rows follow the cursor', () => {
    let s = ready(MANY, SMALLEST);
    expect(rows(frame(s)).map((l) => l.slice(4, 12))).toEqual(['Folder00', 'Folder01', 'Folder02']);
    for (let i = 1; i <= 45; i++) {
      s = act(s, key('down'));
      const out = frame(s);
      expect(lineAt(out, 1)).toBe('Total: 222 messages, 9 unread, 9.8 KB');
      expect(lineAt(out, 2)).toBe(fitted(NO_QUOTA, 40));
      const name = `Folder${String(Math.min(i, 39)).padStart(2, '0')}`;
      expect(out.lines[out.cursorLine ?? -1]?.slice(4, 12)).toBe(name);
      expect(out.cursorLine).toBeGreaterThanOrEqual(3);
      expect(out.cursorLine).toBeLessThanOrEqual(5);
    }
    s = act(s, ...repeat(key('up'), 45));
    expect(frame(s).cursorLine).toBe(3);
    expect(rows(frame(s))[0]?.slice(4, 12)).toBe('Folder00');
  });

  it('a resize keeps the highlighted folder on screen', () => {
    const s = act(ready(MANY, { rows: 45, cols: 100 }), ...repeat(key('down'), 30));
    for (const screen of [SMALLEST, { rows: 12, cols: 60 }, SCREEN, WIDE]) {
      const out = frame(resized(s, screen));
      expect(out.lines[out.cursorLine ?? -1]?.slice(4, 12)).toBe('Folder30');
    }
  });

  it('a cursor beyond the folders (the state never holds one) is drawn on the last', () => {
    const s = ready(MANY);
    if (s.view.kind !== 'mailbox') throw new Error('not on a mailbox');
    const out = frame({ ...s, view: { ...s.view, cursor: 999 } });
    expect(out.lines[out.cursorLine ?? -1]?.slice(4, 12)).toBe('Folder39');
  });
});

// --- strings from outside -------------------------------------------------------------------

describe('the bars: names from the mail server and the address', () => {
  const HOSTILE = treeOf([
    folder('Evil\u202ename\u0007with\u0000control\u200b', { bytes: 4000 }),
    folder('\u4e2d\u6587\u6587\u4ef6\u5939\u540d\u79f0\u975e\u5e38\u957f\u7684\u540d\u5b57'),
    folder('Emoji \u{1F600}\u{1F4E7} box', { messages: 99_999_999, bytes: 999_999_999_999 }),
    folder(`long/${'x'.repeat(400)}`),
  ]);

  it('are cleaned and fitted: exact frames, no control or bidi character', () => {
    for (const screen of SCREENS) {
      for (const presses of [0, 1, 2]) {
        const out = text(frame(act(ready(HOSTILE, screen), ...repeat(ch('o'), presses))));
        expect(out.replace(/\n/g, '')).not.toMatch(
          /[\p{Cc}\u202a-\u202e\u2066-\u2069\u200b-\u200f]/u,
        );
      }
    }
    const wide = rows(frame(ready(HOSTILE, WIDE)));
    expect(wide[0]?.startsWith('    Evilnamewithcontrol ')).toBe(true);
    expect(wide[1]?.startsWith('    \u4e2d\u6587\u6587\u4ef6\u5939')).toBe(true);
  });

  it('the address of the mailbox too', () => {
    const out = frame(ready(MIXED, SCREEN, 'evil\u202e\u0007\u200b@example-test-domain.eu'));
    expect(lineAt(out, 0)).toBe(
      `${'Mail Manager - evil@example-test-domain.eu'.padEnd(70)}tree order`,
    );
  });
});

// --- messages and questions -----------------------------------------------------------------

describe('the bars: status line', () => {
  it('a cut folder list says so', () => {
    const out = frame(ready(treeOf(MIXED.folders, { truncated: true })));
    expect(status(out)).toBe('Only the first 5,000 folders are shown.');
  });

  it('a folder that could not be opened', () => {
    const bars = inFolder(ready(MIXED), (load) => ({
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
    const out = frame(bars);
    expect(status(out)).toBe("Couldn't open that folder.");
    expect(lineAt(out, 1)).toBe('Total: 222 messages, 9 unread, ~9.8 KB');
    expect(help(out)).toBe(HELP_BARS);
  });

  it('Esc with marks: "Drop 3 marks? (y/N)", the row still highlighted', () => {
    const out = frame(act(barsWithMarks(), key('escape')));
    expect(status(out)).toBe('Drop 3 marks? (y/N)');
    expect(help(out)).toBe('y yes  any other key no');
    expect(out.cursorLine).toBe(3);
    expect(lineAt(out, 0).endsWith('tree order')).toBe(true);
    expect(rows(out)).toHaveLength(8);
  });

  it('q with marks: "Quit and drop 3 marks? (y/N)"', () => {
    const out = frame(act(barsWithMarks(), ch('q')));
    expect(status(out)).toBe('Quit and drop 3 marks? (y/N)');
    expect(help(out)).toBe('y yes  any other key no');
  });

  it('one mark is "1 mark"', () => {
    const one = act(browsing(), ch(' '), key('escape'), key('escape'));
    expect(status(frame(one))).toBe('Drop 1 mark? (y/N)');
  });

  it('no: the bars as they were', () => {
    const out = frame(act(barsWithMarks(), key('escape'), ch('n')));
    expect(status(out)).toBe('Stats: press s to read');
    expect(help(out)).toBe(HELP_BARS);
  });
});

// --- the failed screen ----------------------------------------------------------------------

describe('a failed login or read', () => {
  it('the text in the body, wrapped at spaces; r, Esc and q', () => {
    const sentence =
      "Couldn't sign in to the mailbox - check the address, the password and the IMAP server.";
    const out = frame(failed(`${sentence} ${sentence}`));
    expect(lineAt(out, 0)).toBe(`Mail Manager - ${EMAIL}`);
    expect(out.lines.slice(1, 5).map((l) => l.trimEnd())).toEqual([
      "    Couldn't sign in to the mailbox - check the address, the password and the",
      "    IMAP server. Couldn't sign in to the mailbox - check the address, the",
      '    password and the IMAP server.',
      '',
    ]);
    expect(status(out)).toBe('');
    expect(help(out)).toBe('r try again  Esc back  q quit');
    expect(out.cursorLine).toBeNull();
    expect(text(out)).not.toContain('Total');
  });

  it('punctuation of the CLI texts becomes ASCII', () => {
    const out = frame(
      failed('Not saved \u2014 see \u201cmm account list\u201d \u2192 4\u201336 chars\u2026'),
    );
    expect(lineAt(out, 1)).toBe('    Not saved - see "mm account list" -> 4-36 chars...');
    for (const line of out.lines) expect(line).toMatch(ASCII);
  });

  it('a line break in the text starts a new line', () => {
    const out = frame(failed('Invalid configuration:\n  - MM_MASTER_KEY is missing\n\nSet it.'));
    expect(out.lines.slice(1, 5).map((l) => l.trimEnd())).toEqual([
      '    Invalid configuration:',
      '    - MM_MASTER_KEY is missing',
      '    Set it.',
      '',
    ]);
  });

  it('hostile characters never reach the frame', () => {
    const out = frame(failed('Bad \u202e\u0007text\u0000 here \u{1F600} caf\u00e9\u200b.'));
    expect(lineAt(out, 1)).toBe('    Bad text here ? caf?.');
  });

  it('40x8: wrapped to 36 columns; what does not fit ends in "..."', () => {
    const words = Array.from({ length: 60 }, (_, i) => `word${String(i)}`).join(' ');
    const out = frame(failed(words, SMALLEST));
    expect(out.lines.slice(1, 6).map((l) => l.trimEnd())).toEqual([
      '    word0 word1 word2 word3 word4 word5',
      '    word6 word7 word8 word9 word10',
      '    word11 word12 word13 word14 word15',
      '    word16 word17 word18 word19 word20',
      '    word21 word22 word23 word24 word2...',
    ]);
    expect(help(out)).toBe('r try again  Esc back  q quit');
  });

  it('a text that just fits is not cut', () => {
    const five = Array.from({ length: 5 }, (_, i) => `line${String(i)}`).join('\n');
    const out = frame(failed(five, SMALLEST));
    expect(out.lines.slice(1, 6).map((l) => l.trim())).toEqual([
      'line0',
      'line1',
      'line2',
      'line3',
      'line4',
    ]);
  });

  it('after r: "Connecting..." again, the text gone', () => {
    const out = frame(act(failed('Old failure text.'), ch('r')));
    expect(status(out)).toBe('Connecting...');
    expect(text(out)).not.toContain('Old failure');
  });
});

describe('wrap', () => {
  it.each<[string, number, string[]]>([
    ['', 10, []],
    ['   ', 10, []],
    ['one', 10, ['one']],
    ['one two three', 13, ['one two three']],
    ['one two three', 12, ['one two', 'three']],
    ['one two three', 7, ['one two', 'three']],
    ['one two three', 5, ['one', 'two', 'three']],
    ['  spaces   are\tcollapsed  ', 20, ['spaces are collapsed']],
    // A word longer than a line is split.
    ['abcdefghij', 4, ['abcd', 'efgh', 'ij']],
    ['ab abcdefghij cd', 4, ['ab', 'abcd', 'efgh', 'ij', 'cd']],
    ['ab abcdefgh', 4, ['ab', 'abcd', 'efgh']],
    ['abc', 0, ['a', 'b', 'c']],
    ['abc def', 3.9, ['abc', 'def']],
  ])('wrap(%j, %d) = %j', (input, width, expected) => {
    expect(wrap(input, width)).toEqual(expected);
  });

  it('no line is longer than the width, and no word is lost', () => {
    const words = 'The quick brown fox jumps over the lazy dog and then keeps on running';
    for (let width = 1; width <= 80; width++) {
      const lines = wrap(words, width);
      for (const line of lines) expect(line.length).toBeLessThanOrEqual(width);
      expect(lines.join('').replace(/ /g, '')).toBe(words.replace(/ /g, ''));
    }
  });
});

// --- window too small -----------------------------------------------------------------------

describe('window too small', () => {
  const TOO_SMALL: Screen[] = [
    { rows: 8, cols: 39 },
    { rows: 7, cols: 40 },
    { rows: 3, cols: 21 },
  ];

  it('only the "too small" text, in every mode', () => {
    const states = [connecting(), reading(), ready(MIXED), failed('It did not work.')];
    for (const screen of TOO_SMALL) {
      for (const s of states) {
        const out = text(frame(resized(s, screen)));
        expect(out).toMatch(/[Tt]oo small - need /);
        for (const hidden of [
          'Mail Manager',
          'Connecting',
          'Reading',
          'Total',
          'INBOX',
          'did not',
        ]) {
          expect(out).not.toContain(hidden);
        }
      }
    }
  });

  it('plus the question that is still open', () => {
    for (const screen of TOO_SMALL) {
      const leave = text(frame(resized(act(barsWithMarks(), key('escape')), screen)));
      expect(leave).toMatch(/[Tt]oo small - need /);
      expect(leave).toContain('Drop 3 marks? (y/N)');
      const quit = text(frame(resized(act(barsWithMarks(), ch('q')), screen)));
      expect(quit).toContain(fitted('Quit and drop 3 marks? (y/N)', screen.cols));
    }
  });

  it('40x8 itself is big enough', () => {
    expect(text(frame(ready(MIXED, SMALLEST)))).not.toMatch(/too small/i);
  });
});

/** As `fit` cuts a text that is longer than the line. */
function fitted(value: string, cols: number): string {
  return value.length <= cols ? value : `${value.slice(0, cols - 3)}...`;
}

// --- in a folder ----------------------------------------------------------------------------

describe('inside a folder', () => {
  it('the frame is the browser drawing itself, sizes on', () => {
    for (const screen of SCREENS) {
      const s = browsing(MIXED, screen);
      if (s.view.kind !== 'mailbox' || s.view.browser === null) throw new Error('no browser');
      expect(frame(s)).toEqual(renderBrowser(s.view.browser, { sizes: true }));
    }
  });

  it('title, mails, the marks, and Esc as a way back', () => {
    const out = frame(act(browsing(), ch('a')));
    expect(lineAt(out, 0)).toMatch(/^box@example-test-domain\.eu \/ INBOX +3 mails$/);
    expect(out.lines[1]).toContain('[x]');
    expect(out.lines[1]).toContain('Subject 3');
    expect(status(out)).toBe('marked: 3 mails, 300 B'.padStart(80));
    expect(help(out)).toBe(
      'Up/Down move  Enter open  Esc/Left back  / filter  o order  Space mark  q quit',
    );
  });

  it('subfolder rows keep their size cell', () => {
    // Archive holds no mails itself: the browser lists its subfolder.
    const out = frame(act(ready(MIXED), key('down'), key('enter')));
    expect(lineAt(out, 0)).toBe('box@example-test-domain.eu / Archive');
    expect(lineAt(out, 1)).toMatch(/^ {4}2023\/ +45 +~2\.9 KB$/);
  });

  it('Esc: the bars again, with their own key help', () => {
    const out = frame(act(browsing(), key('escape')));
    expect(lineAt(out, 1)).toBe('Total: 222 messages, 9 unread, ~9.8 KB');
    expect(help(out)).toBe(HELP_BARS);
    expect(out.cursorLine).toBe(3);
  });

  it("too small: the browser's own frame, with its question", () => {
    const asked = resized(act(browsing(), ch('a'), ch('q')), { rows: 6, cols: 40 });
    const out = text(frame(asked));
    expect(out).toContain('Window too small - need at least 40x8');
    expect(out).toContain('Drop 3 marks? (y/N)');
    expect(out).not.toContain('Subject');
  });

  it('a resize is drawn at the new size', () => {
    const s = browsing();
    for (const screen of SCREENS) {
      const out = frame(resized(s, screen));
      expect(out.lines[1]).toContain('Sender 3');
    }
  });
});
