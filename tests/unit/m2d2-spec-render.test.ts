import { beforeAll, describe, it, expect } from 'vitest';
import { messageText, renderApp } from '../../src/cli/app/render.js';
import { reduceApp, startApp } from '../../src/cli/app/reduce.js';
import { initialApp } from '../../src/cli/app/state.js';
import type {
  AppAction,
  AppEffect,
  AppKey,
  AppReduced,
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

// M2d-2 mailbox screen renderer (spec AC2-AC7, AC10, AC11, AC16 and the edge cases). States are
// built through the reducer (Enter on a Home mailbox row, then the result actions); assertions
// are on the drawn lines and on `cursorLine`.

const SCREEN: Screen = { rows: 24, cols: 100 };
const S40: Screen = { rows: 8, cols: 40 };
const S80: Screen = { rows: 24, cols: 80 };
const S200: Screen = { rows: 50, cols: 200 };
const ALICE: AuthUser = { email: 'alice@example.com', userId: 'user-alice' };
const ID1 = '22222222-2222-4222-8222-222222222222';
const EMAIL = 'one@example.com';

const ch = (text: string): AppKey => ({ type: 'char', text });
const key = (type: Exclude<AppKey['type'], 'char'>): AppKey => ({ type });
const ENTER = key('enter');
const ESC = key('escape');
const DOWN = key('down');
const UP = key('up');

// --- building states ------------------------------------------------------------------------

function press(state: AppState, ...keys: AppKey[]): AppState {
  let s = state;
  for (const k of keys) s = reduceApp(s, { type: 'key', key: k }).state;
  return s;
}

function act(state: AppState, action: AppAction): AppState {
  return reduceApp(state, action).state;
}

function effectsOf(state: AppState, k: AppKey): AppEffect[] {
  return reduceApp(state, { type: 'key', key: k }).effects;
}

function home(email = EMAIL, screen: Screen = SCREEN): AppState {
  const row: MailboxRow = { id: ID1, email, provider: 'websupport', lastCheckedAt: null };
  const s0 = startApp(initialApp('1.0.0', screen)).state;
  const s1 = act(s0, {
    type: 'session',
    generation: s0.generation,
    user: ALICE,
    remembered: [ALICE.email],
  });
  const s2 = press(s1, ENTER);
  return act(s2, { type: 'mailboxes', generation: s2.generation, rows: [row] });
}

/** `s` itself, after checking it is the mailbox screen in this mode (a bug in a fixture is loud). */
function inMode(s: AppState, mode: string): AppState {
  if (s.view.kind !== 'mailbox' || s.view.mode !== mode) {
    throw new Error(
      `expected the mailbox screen in "${mode}", got ${JSON.stringify(s.view).slice(0, 80)}`,
    );
  }
  return s;
}

function connecting(screen: Screen = SCREEN, email = EMAIL): AppState {
  return inMode(press(home(email, screen), ENTER), 'connecting');
}

function reading(screen: Screen = SCREEN): AppState {
  const s = connecting(screen);
  return inMode(act(s, { type: 'mailbox-reading', generation: s.generation }), 'reading');
}

function ready(tree: FolderTree, screen: Screen = SCREEN, email = EMAIL): AppState {
  const s0 = connecting(screen, email);
  const s1 = act(s0, { type: 'mailbox-reading', generation: s0.generation });
  return inMode(act(s1, { type: 'mailbox-opened', generation: s1.generation, tree }), 'ready');
}

function failed(text: string, screen: Screen = SCREEN): AppState {
  const s = reading(screen);
  return inMode(act(s, { type: 'mailbox-failed', generation: s.generation, text }), 'failed');
}

function resized(s: AppState, screen: Screen): AppState {
  return act(s, { type: 'resize', screen });
}

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
    totals: { messages: 345, unseen: 7, bytes: 10_000, sizeSource: 'server' },
    quota: null,
    truncated: false,
    unreadable: 0,
    gmailAllHidden: false,
    fallbacks: new Set(),
    ...over,
  };
}

/** Totals 10,000 bytes, so every share is the folder's bytes / 100 per cent. */
const BARS = treeOf([
  folder('INBOX', { bytes: 5000, messages: 123 }),
  folder('Sent', { bytes: 3000, messages: 45 }),
  folder('Mid', { bytes: 2600, messages: 9 }),
  folder('Low', { bytes: 2400, messages: 8 }),
  folder('Rnd', { bytes: 400, messages: 2 }),
  folder('Tiny', { bytes: 20, messages: 1 }),
]);

// --- reading a frame ------------------------------------------------------------------------

const text = (r: Rendered): string => r.lines.join('\n');

function checkFrame(r: Rendered, screen: Screen): void {
  expect(r.lines).toHaveLength(screen.rows);
  for (const line of r.lines) expect(displayWidth(line)).toBe(screen.cols);
}

/** The first line at or below the totals line with `needle` (a folder row). */
function rowOf(r: Rendered, needle: string): string {
  const i = r.lines.findIndex((l, n) => n >= 3 && l.includes(needle));
  if (i < 0) throw new Error(`no row with "${needle}" in:\n${text(r)}`);
  return r.lines[i] ?? '';
}

function indexOfRow(r: Rendered, needle: string): number {
  return r.lines.findIndex((l, n) => n >= 3 && l.includes(needle));
}

const statusLine = (r: Rendered): string => r.lines[r.lines.length - 2] ?? '';
const helpLine = (r: Rendered): string => r.lines[r.lines.length - 1] ?? '';

/** The lines of the folder list: below the two fixed body lines, above status and help. */
function bodyRows(r: Rendered): string[] {
  return r.lines.slice(3, r.lines.length - 2);
}

function collapsed(r: Rendered): string {
  return text(r).replace(/\s+/g, ' ');
}

// --- the embedded browser, for the marks questions ------------------------------------------

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

function loadPageOf(r: AppReduced): Extract<AppEffect, { type: 'load-page' }> {
  const load = r.effects.find((e) => e.type === 'load-page');
  if (load?.type !== 'load-page') throw new Error('no load-page effect');
  return load;
}

/** INBOX (first row) opened and its three mails loaded: the browser is on screen. */
function browsing(tree: FolderTree = BARS, screen: Screen = SCREEN): AppState {
  const r = reduceApp(ready(tree, screen), { type: 'key', key: ENTER });
  const load = loadPageOf(r);
  const rows = [3, 2, 1].map(mailRow);
  return inMode(
    act(r.state, {
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
          rows,
        },
      },
    }),
    'browsing',
  );
}

/** The bars with three marks in the basket (mark screen, then back to the bars). */
function barsWithMarks(screen: Screen = SCREEN): AppState {
  return press(browsing(BARS, screen), ch('a'), ESC);
}

// --- the frame is always exact --------------------------------------------------------------

describe('every frame has exactly rows lines of exactly cols columns', () => {
  const SCREENS: [string, Screen][] = [
    ['40x8', S40],
    ['80x24', S80],
    ['200x50', S200],
  ];
  const HOSTILE = treeOf([
    folder('INBOX'),
    folder('Evil\u202Ename\u0007with\u0000ctrl', { bytes: 4000 }),
    folder('\u4E2D\u6587\u6587\u4EF6\u5939\u540D\u79F0\u975E\u5E38\u957F\u7684\u540D\u5B57'),
    folder('Emoji \u{1F600}\u{1F4E7} box', { messages: 99_999_999, bytes: 999_999_999_999 }),
    folder('a/b/c/d/e/f/g/h/i/j/k/l/m/n'),
  ]);
  const MODES: [string, (s: Screen) => AppState][] = [
    ['connecting', (s) => connecting(s)],
    ['reading', (s) => reading(s)],
    [
      'reading with progress',
      (s) => {
        const r = reading(s);
        return act(r, {
          type: 'mailbox-progress',
          generation: r.generation,
          progress: { folder: 12, folders: 345, done: 5, total: 90 },
        });
      },
    ],
    ['ready', (s) => ready(BARS, s)],
    ['ready, hostile names', (s) => ready(HOSTILE, s)],
    ['ready, no folders', (s) => ready(treeOf([], { totals: null }), s)],
    [
      'ready with quota',
      (s) => ready(treeOf(BARS.folders, { quota: { usedBytes: 30_720, limitBytes: 102_400 } }), s),
    ],
    [
      'ready, gmail all hidden',
      (s) => ready(treeOf(BARS.folders, { gmailAllHidden: true, totals: null }), s),
    ],
    [
      'failed',
      (s) => failed('The server said no. Check the password and try again. '.repeat(6), s),
    ],
    ['confirm-leave', (s) => press(barsWithMarks(s), ESC)],
    ['confirm-quit', (s) => press(barsWithMarks(s), ch('q'))],
    ['browsing', (s) => browsing(BARS, s)],
  ];
  for (const [screenName, screen] of SCREENS) {
    for (const [modeName, make] of MODES) {
      it(`${modeName} at ${screenName}`, () => {
        const r = renderApp(make(screen));
        checkFrame(r, screen);
      });
    }
  }

  it('hostile names leave no control or bidi character in the frame', () => {
    for (const screen of [S40, S80, S200]) {
      const out = text(renderApp(ready(HOSTILE, screen)));
      expect(out).not.toContain('\u202E');
      expect(out.replace(/\n/g, '')).not.toMatch(/\p{Cc}/u);
    }
  });

  it('a hostile mailbox address in the header is sanitised too', () => {
    const r = renderApp(ready(BARS, SCREEN, 'evil\u202E\u0007@example.com'));
    checkFrame(r, SCREEN);
    expect(r.lines[0]).not.toMatch(/[\p{Cc}\u202E]/u);
    expect(r.lines[0]).toContain('Mail Manager - ');
  });
});

// --- AC1: connecting and reading ------------------------------------------------------------

describe('AC1 connecting and reading', () => {
  it('shows "Connecting..." with the mailbox in the header', () => {
    const r = renderApp(connecting());
    expect(statusLine(r)).toContain('Connecting...');
    expect(r.lines[0]).toContain(`Mail Manager - ${EMAIL}`);
    expect(text(r)).not.toContain('Reading folders');
  });

  it('shows "Reading folders..." after the login', () => {
    const r = renderApp(reading());
    expect(statusLine(r)).toContain('Reading folders...');
    expect(statusLine(r)).not.toMatch(/\d+\/\d+/);
    expect(text(r)).not.toContain('Connecting...');
  });

  it('shows "Reading folders... n/m" while the size fallback reports progress', () => {
    const s = reading();
    const r = renderApp(
      act(s, {
        type: 'mailbox-progress',
        generation: s.generation,
        progress: { folder: 7, folders: 12, done: 100, total: 900 },
      }),
    );
    expect(statusLine(r)).toContain('Reading folders... 7/12');
  });

  it('the connecting challenge shows the wait notice on the status line', () => {
    const s = connecting();
    const r = renderApp(act(s, { type: 'challenge', generation: s.generation }));
    expect(statusLine(r)).toContain(CHALLENGE_NOTICE);
  });

  it('shows no folder rows, bars or totals before the folders arrive', () => {
    for (const s of [connecting(), reading()]) {
      const out = text(renderApp(s));
      expect(out).not.toContain('Total');
      expect(out).not.toContain('Quota');
      expect(out).not.toMatch(/\[[#.]{6,10}\]/);
    }
  });
});

// --- messages -------------------------------------------------------------------------------

describe('messageText of the new codes', () => {
  it("folder-unavailable: Couldn't open that folder.", () => {
    expect(messageText('folder-unavailable')).toBe("Couldn't open that folder.");
  });

  it('truncated: Only the first 5,000 folders are shown.', () => {
    expect(messageText('truncated')).toBe('Only the first 5,000 folders are shown.');
  });

  it('challenge: the browser notice', () => {
    expect(messageText('challenge')).toBe(CHALLENGE_NOTICE);
  });

  it('the Add row has no hint any more: Enter on it draws the add screen', () => {
    const out = renderApp(press(home(), DOWN, ENTER));
    expect(text(out)).toContain('Mail Manager - Add a mailbox');
    expect(text(out)).not.toContain('Coming in a next step');
  });
});

// --- AC2: layout ----------------------------------------------------------------------------

describe('AC2 the bars screen', () => {
  let r!: Rendered;
  beforeAll(() => {
    r = renderApp(ready(BARS));
  });

  it('header: Mail Manager - <mailbox e-mail>', () => {
    expect(r.lines[0]).toContain(`Mail Manager - ${EMAIL}`);
  });

  it('header right cell names the order, and follows `o`', () => {
    const s = ready(BARS);
    expect(renderApp(s).lines[0]).toMatch(/tree/i);
    const bySize = renderApp(press(s, ch('o'))).lines[0] ?? '';
    expect(bySize).toMatch(/size/i);
    expect(bySize).not.toMatch(/tree/i);
    const byName = renderApp(press(s, ch('o'), ch('o'))).lines[0] ?? '';
    expect(byName).toMatch(/name/i);
    expect(byName).not.toMatch(/size/i);
    expect(renderApp(press(s, ch('o'), ch('o'), ch('o'))).lines[0]).toMatch(/tree/i);
  });

  it('body line 1 is the totals line, body line 2 the quota line, then one row per folder', () => {
    expect(r.lines[1]).toContain('Total: 345 messages, 7 unread, 9.8 KB');
    expect(r.lines[2]).toContain('Quota: not available from the mail server');
    expect(r.lines[3]).toContain('INBOX');
    expect(r.lines[4]).toContain('Sent');
    expect(r.lines[8]).toContain('Tiny');
  });

  it('a totals size that we added up ourselves has the ~', () => {
    const t = treeOf(BARS.folders, {
      totals: { messages: 345, unseen: 7, bytes: 10_000, sizeSource: 'sum' },
    });
    expect(renderApp(ready(t)).lines[1]).toContain('Total: 345 messages, 7 unread, ~9.8 KB');
  });

  it('the status line and the key help are the last two lines', () => {
    expect(helpLine(r)).toContain('Enter open');
  });

  it('key help of the bars: Up/Down move, Enter open, o sort, Esc back, q quit', () => {
    const help = helpLine(r);
    for (const item of ['Up/Down move', 'Enter open', 'o sort', 'Esc back', 'q quit']) {
      expect(help).toContain(item);
    }
  });

  it('with the cursor on the first folder, cursorLine is its row', () => {
    expect(r.cursorLine).toBe(3);
    expect(r.lines[r.cursorLine ?? -1]).toContain('INBOX');
  });

  it('the app text is plain ASCII (ASCII folder names, every size source)', () => {
    const t = treeOf(
      [
        ...BARS.folders,
        folder('Unknown', { bytes: null, sizeSource: null, messages: 4 }),
        folder('Label', { overlapping: true }),
        folder('Hidden', { subscribed: false }),
        folder('Group', { selectable: false, messages: null, bytes: null }),
        folder('Summed', { sizeSource: 'sum' }),
      ],
      { quota: { usedBytes: 30_720, limitBytes: 102_400 }, unreadable: 2, truncated: true },
    );
    for (const screen of [S40, S80, SCREEN, S200]) {
      for (const line of renderApp(ready(t, screen)).lines) expect(line).toMatch(/^[\x20-\x7E]*$/);
    }
  });
});

// --- AC3: rows and bars ---------------------------------------------------------------------

describe('AC3 a folder row', () => {
  let r!: Rendered;
  beforeAll(() => {
    r = renderApp(ready(BARS));
  });

  it('right cells are: bar, percent, size, messages', () => {
    expect(rowOf(r, 'INBOX')).toMatch(/\[#{5}\.{5}\]\s+50%\s+4\.9 KB\s+123\s*$/);
  });

  it('bar = 10 cells filled by round(share x 10)', () => {
    expect(rowOf(r, 'Sent')).toMatch(/\[#{3}\.{7}\]\s+30%/);
    expect(rowOf(r, 'Mid')).toMatch(/\[#{3}\.{7}\]\s+26%/);
    expect(rowOf(r, 'Low')).toMatch(/\[#{2}\.{8}\]\s+24%/);
  });

  it('a share that rounds to no cell still shows one', () => {
    expect(rowOf(r, 'Rnd')).toMatch(/\[#\.{9}\]\s+4%/);
  });

  it('a share below 0.5 per cent shows <1% and one cell', () => {
    expect(rowOf(r, 'Tiny')).toMatch(/\[#\.{9}\]\s+<1%/);
  });

  it('a share of 0.6 per cent shows 1%', () => {
    const t = treeOf([folder('Six', { bytes: 60 })]);
    expect(rowOf(renderApp(ready(t)), 'Six')).toMatch(/\[#\.{9}\]\s+1%/);
  });

  it('a size we added up ourselves has the ~ in the size cell', () => {
    const t = treeOf([folder('Summed', { bytes: 5000, sizeSource: 'sum' })]);
    expect(rowOf(renderApp(ready(t)), 'Summed')).toMatch(/50%\s+~4\.9 KB/);
  });

  it('a folder larger than the total is clamped to a full bar', () => {
    const t = treeOf([folder('Over', { bytes: 20_000 })]);
    expect(rowOf(renderApp(ready(t)), 'Over')).toMatch(/\[#{10}\]\s+100%/);
  });

  it('an overlapping Gmail label: the tag, no bar, no percent', () => {
    const t = treeOf([folder('Label', { overlapping: true, bytes: 5000 })]);
    const row = rowOf(renderApp(ready(t)), 'Label');
    expect(row).toContain('(overlapping)');
    expect(row).not.toMatch(/\[[#.]+\]/);
    expect(row).not.toContain('%');
  });

  it('an unsubscribed folder is tagged (hidden) and still has its bar', () => {
    const t = treeOf([folder('Quiet', { subscribed: false, bytes: 5000 })]);
    const row = rowOf(renderApp(ready(t)), 'Quiet');
    expect(row).toContain('(hidden)');
    expect(row).toMatch(/\[#{5}\.{5}\]\s+50%/);
  });

  it('an unknown size: shown as -, no bar, no percent', () => {
    const t = treeOf([folder('Unknown', { bytes: null, sizeSource: null, messages: 4 })]);
    const row = rowOf(renderApp(ready(t)), 'Unknown');
    expect(row).not.toMatch(/\[[#.]+\]/);
    expect(row).not.toContain('%');
    expect(row).toMatch(/\s-\s+4\s*$/);
  });

  it('a folder that cannot be selected: no bar, no percent', () => {
    const t = treeOf([
      folder('Group', { selectable: false, messages: null, unseen: null, bytes: null }),
    ]);
    const row = rowOf(renderApp(ready(t)), 'Group');
    expect(row).not.toMatch(/\[[#.]+\]/);
    expect(row).not.toContain('%');
  });

  it('a not selectable folder with a size still has no bar', () => {
    const t = treeOf([folder('Group', { selectable: false, bytes: 5000 })]);
    expect(rowOf(renderApp(ready(t)), 'Group')).not.toMatch(/\[[#.]+\]/);
  });

  it('totals unknown (null): no bars at all', () => {
    const rows = bodyRows(renderApp(ready(treeOf(BARS.folders, { totals: null }))));
    for (const line of rows) {
      expect(line).not.toMatch(/\[[#.]+\]/);
      expect(line).not.toContain('%');
    }
  });

  it('totals of 0 bytes: no bars, no crash', () => {
    const t = treeOf([folder('Empty', { bytes: 0 }), folder('Other', { bytes: 0 })], {
      totals: { messages: 0, unseen: 0, bytes: 0, sizeSource: 'server' },
    });
    const r0 = renderApp(ready(t));
    checkFrame(r0, SCREEN);
    for (const line of bodyRows(r0)) expect(line).not.toMatch(/\[[#.]+\]/);
    expect(rowOf(r0, 'Empty')).toContain('Empty');
  });

  it('tree order: indented by depth, 2 columns per level', () => {
    const t = treeOf([
      folder('Projects', { bytes: 1000 }),
      folder('Projects/Alpha', { bytes: 1000 }),
      folder('Projects/Alpha/Deep', { bytes: 1000 }),
    ]);
    const out = renderApp(ready(t));
    expect(rowOf(out, 'Alpha')).toMatch(/\bAlpha\b/);
    // Compare the indent of the names themselves (a cursor mark may precede every row).
    const nameAt = (line: string, name: string): number => line.indexOf(name);
    expect(nameAt(rowOf(out, 'Alpha'), 'Alpha') - nameAt(rowOf(out, 'Projects'), 'Projects')).toBe(
      2,
    );
    expect(nameAt(rowOf(out, 'Deep'), 'Deep') - nameAt(rowOf(out, 'Projects'), 'Projects')).toBe(4);
  });

  it('size and name order: no indent, the full path', () => {
    const t = treeOf([
      folder('Projects', { bytes: 1000 }),
      folder('Projects/Alpha', { bytes: 2000 }),
    ]);
    for (const presses of [1, 2]) {
      const s = press(ready(t), ...Array.from({ length: presses }, () => ch('o')));
      const out = renderApp(s);
      expect(text(out)).toContain('Projects/Alpha');
      const line = rowOf(out, 'Projects/Alpha');
      const plain = rowOf(out, 'Projects ');
      expect(line.indexOf('Projects/Alpha')).toBe(plain.indexOf('Projects'));
    }
  });
});

// --- AC4: quota, notes ----------------------------------------------------------------------

describe('AC4 the quota line and the notes', () => {
  it('a quota with a limit: its own bar, percent, used of limit', () => {
    const t = treeOf(BARS.folders, { quota: { usedBytes: 30_720, limitBytes: 102_400 } });
    expect(renderApp(ready(t)).lines[2]).toContain('Quota: [###.......] 30%  30.0 KB of 100.0 KB');
  });

  it('a full quota fills the bar', () => {
    const t = treeOf(BARS.folders, { quota: { usedBytes: 102_400, limitBytes: 102_400 } });
    expect(renderApp(ready(t)).lines[2]).toContain('Quota: [##########] 100%');
  });

  it('no quota: not available from the mail server', () => {
    expect(renderApp(ready(treeOf(BARS.folders, { quota: null }))).lines[2]).toContain(
      'Quota: not available from the mail server',
    );
  });

  it('a quota without a limit: not available from the mail server', () => {
    const t = treeOf(BARS.folders, { quota: { usedBytes: 5000, limitBytes: null } });
    const line = renderApp(ready(t)).lines[2] ?? '';
    expect(line).toContain('Quota: not available from the mail server');
    expect(line).not.toMatch(/\[[#.]+\]/);
  });

  it('Gmail with All Mail hidden: the note instead of the totals, and no bars', () => {
    const t = treeOf(BARS.folders, { gmailAllHidden: true, totals: null });
    const out = renderApp(ready(t));
    expect(out.lines[1]?.trimEnd()).toBe(
      'Totals unknown - Gmail hides All Mail from IMAP (Labels > Show in IMAP).',
    );
    for (const line of bodyRows(out)) expect(line).not.toMatch(/\[[#.]+\]/);
  });

  it('Gmail with All Mail hidden: no bars even when the tree says totals exist', () => {
    const t = treeOf(BARS.folders, { gmailAllHidden: true });
    for (const line of bodyRows(renderApp(ready(t)))) expect(line).not.toMatch(/\[[#.]+\]/);
  });

  it("unreadable folders add ', N folders couldn't be read' to the totals line", () => {
    const t = treeOf(BARS.folders, { unreadable: 3 });
    expect(renderApp(ready(t)).lines[1]).toContain(
      "Total: 345 messages, 7 unread, 9.8 KB, 3 folders couldn't be read",
    );
  });

  it('no unreadable folders: no such suffix', () => {
    expect(text(renderApp(ready(BARS)))).not.toContain("couldn't be read");
  });

  it('a truncated tree shows the message on the status line', () => {
    const out = renderApp(ready(treeOf(BARS.folders, { truncated: true })));
    expect(statusLine(out)).toContain('Only the first 5,000 folders are shown.');
  });

  it('a tree that is not truncated shows no such message', () => {
    expect(text(renderApp(ready(BARS)))).not.toContain('Only the first');
  });
});

// --- AC5: order -----------------------------------------------------------------------------

describe('AC5 order in the frame', () => {
  const SHUFFLED = treeOf([
    folder('Tiny', { bytes: 20 }),
    folder('Sent', { bytes: 3000 }),
    folder('Unknown', { bytes: null, sizeSource: null }),
    folder('INBOX', { bytes: 5000 }),
    folder('Mid', { bytes: 2600 }),
  ]);

  it('tree order is the tree list', () => {
    const out = renderApp(ready(SHUFFLED));
    const idx = ['Tiny', 'Sent', 'Unknown', 'INBOX', 'Mid'].map((n) => indexOfRow(out, n));
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
    expect(idx.every((i) => i > 0)).toBe(true);
  });

  it('size order: largest first, unknown last', () => {
    const out = renderApp(press(ready(SHUFFLED), ch('o')));
    const idx = ['INBOX', 'Sent', 'Mid', 'Tiny', 'Unknown'].map((n) => indexOfRow(out, n));
    expect(idx.every((i) => i > 0)).toBe(true);
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
  });

  it('name order: case-insensitive on the path', () => {
    const t = treeOf([folder('cherry'), folder('Banana'), folder('apple'), folder('Date')]);
    const out = renderApp(press(ready(t), ch('o'), ch('o')));
    const idx = ['apple', 'Banana', 'cherry', 'Date'].map((n) => indexOfRow(out, n));
    expect(idx.every((i) => i > 0)).toBe(true);
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
  });

  it('the cursor stays on the same folder after o (cursorLine row is that folder)', () => {
    const s = press(ready(SHUFFLED), DOWN, DOWN, DOWN);
    const before = renderApp(s);
    expect(before.lines[before.cursorLine ?? -1]).toContain('INBOX');
    for (const presses of [1, 2, 3]) {
      const out = renderApp(press(s, ...Array.from({ length: presses }, () => ch('o'))));
      expect(out.lines[out.cursorLine ?? -1]).toContain('INBOX');
    }
  });
});

// --- AC6: narrow windows --------------------------------------------------------------------

describe('AC6 narrow windows', () => {
  const NARROW = treeOf(
    [
      folder('INBOX', { bytes: 5000, messages: 7777 }),
      folder('Sent', { bytes: 3000, messages: 5555 }),
      folder('Folder-12abc', { bytes: 1000, messages: 3333 }),
    ],
    { quota: { usedBytes: 30_720, limitBytes: 102_400 } },
  );

  /** 4 = full bar, 3 = 6-cell bar, 2 = percent, 1 = size + messages, 0 = size only. */
  function tier(line: string): number {
    if (/\[[#.]{10}\]/.test(line)) return 4;
    if (/\[[#.]{6}\]/.test(line)) return 3;
    if (line.includes('%')) return 2;
    if (line.includes('4.9 KB') && line.includes('7777')) return 1;
    if (line.includes('4.9 KB') || line.includes('2.9 KB')) return 0;
    return -1;
  }

  function inbox(cols: number): string {
    return rowOf(renderApp(ready(NARROW, { rows: 12, cols })), 'INBOX');
  }

  it('wide: the whole cell set with the 10-cell bar', () => {
    expect(tier(inbox(100))).toBe(4);
    expect(tier(inbox(200))).toBe(4);
  });

  it('at 40 columns the 10-cell bar is gone', () => {
    expect(tier(inbox(40))).toBeLessThan(4);
  });

  it('the cell set only gets shorter as the window narrows, and every size is a known tier', () => {
    let previous = -1;
    for (let cols = 40; cols <= 130; cols++) {
      const t = tier(inbox(cols));
      expect(t, `${String(cols)} columns`).toBeGreaterThanOrEqual(0);
      expect(t, `${String(cols)} columns`).toBeGreaterThanOrEqual(previous);
      previous = t;
    }
  });

  it('a 6-cell bar is used somewhere between the full and the percent-only set', () => {
    const seen = new Set<number>();
    for (let cols = 40; cols <= 130; cols++) seen.add(tier(inbox(cols)));
    expect(seen.has(3)).toBe(true);
    expect(seen.has(2)).toBe(true);
    expect(seen.has(4)).toBe(true);
  });

  it('one cell set per frame: every row of a frame has the same tier', () => {
    for (let cols = 40; cols <= 120; cols += 3) {
      const out = renderApp(ready(NARROW, { rows: 12, cols }));
      const tiers = ['INBOX', 'Sent', 'Folder-12abc'].map((name) => {
        const line = rowOf(out, name);
        // Tier of a row with unknown digits: look at the bar and percent only.
        if (/\[[#.]{10}\]/.test(line)) return 4;
        if (/\[[#.]{6}\]/.test(line)) return 3;
        if (line.includes('%')) return 2;
        return 1;
      });
      expect(new Set(tiers).size, `${String(cols)} columns`).toBe(1);
    }
  });

  it('the name keeps at least 12 columns at every width', () => {
    for (let cols = 40; cols <= 130; cols++) {
      const out = renderApp(ready(NARROW, { rows: 12, cols }));
      expect(rowOf(out, 'Folder-12abc')).toContain('Folder-12abc');
    }
  });

  it('every width gives an exact frame', () => {
    for (let cols = 40; cols <= 130; cols += 7) {
      checkFrame(renderApp(ready(NARROW, { rows: 12, cols })), { rows: 12, cols });
    }
  });

  it('at 40x8 the frame is exact and the long totals and quota lines are cut to the width', () => {
    const t = treeOf(NARROW.folders, {
      gmailAllHidden: true,
      totals: null,
      quota: { usedBytes: 30_720, limitBytes: 102_400 },
    });
    const out = renderApp(ready(t, S40));
    checkFrame(out, S40);
    expect(out.lines[1]).toMatch(/^Totals unknown/);
    expect(displayWidth(out.lines[1] ?? '')).toBe(40);
    expect(out.lines[2]).toMatch(/^Quota: /);
    expect(displayWidth(out.lines[2] ?? '')).toBe(40);
  });

  it('at 40x8 the folder rows still show the names', () => {
    const out = renderApp(ready(NARROW, S40));
    expect(text(out)).toContain('INBOX');
  });
});

// --- AC7: moving, scrolling, resize ---------------------------------------------------------

describe('AC7 scrolling and resize', () => {
  const MANY = treeOf(
    Array.from({ length: 40 }, (_, i) =>
      folder(`Folder${String(i).padStart(2, '0')}`, { bytes: 100 }),
    ),
  );

  it('the cursor row is always on screen and shows the focused folder', () => {
    let s = ready(MANY, S40);
    for (let i = 0; i < 45; i++) {
      s = press(s, DOWN);
      const out = renderApp(s);
      expect(out.cursorLine).not.toBeNull();
      const line = out.lines[out.cursorLine ?? -1] ?? '';
      const focused = `Folder${String(Math.min(i + 1, 39)).padStart(2, '0')}`;
      expect(line, `after ${String(i + 1)} Down presses`).toContain(focused);
      expect(out.cursorLine).toBeGreaterThanOrEqual(3);
      expect(out.cursorLine).toBeLessThanOrEqual(S40.rows - 3);
    }
  });

  it('the totals and quota lines do not scroll', () => {
    let s = ready(MANY, S40);
    s = press(s, ...Array.from({ length: 30 }, () => DOWN));
    const out = renderApp(s);
    expect(out.lines[1]).toContain('Total');
    expect(out.lines[2]).toContain('Quota');
    expect(out.lines[3]).not.toContain('Folder00');
  });

  it('moving back up scrolls back to the top', () => {
    let s = ready(MANY, S40);
    s = press(
      s,
      ...Array.from({ length: 30 }, () => DOWN),
      ...Array.from({ length: 30 }, () => UP),
    );
    const out = renderApp(s);
    expect(out.lines[3]).toContain('Folder00');
    expect(out.cursorLine).toBe(3);
  });

  it('a resize redraws exactly and keeps the cursor on screen', () => {
    let s = ready(MANY, { rows: 40, cols: 100 });
    s = press(s, ...Array.from({ length: 30 }, () => DOWN));
    for (const screen of [S40, { rows: 12, cols: 60 }, S80, { rows: 40, cols: 100 }]) {
      const out = renderApp(resized(s, screen));
      checkFrame(out, screen);
      expect(out.cursorLine).not.toBeNull();
      expect(out.lines[out.cursorLine ?? -1]).toContain('Folder30');
    }
  });

  it('Down presses beyond the end stay clamped: the last folder is shown', () => {
    const s = press(ready(MANY, S40), ...Array.from({ length: 100 }, () => DOWN));
    const out = renderApp(s);
    expect(out.lines[out.cursorLine ?? -1]).toContain('Folder39');
  });
});

// --- AC10: the failed screen ----------------------------------------------------------------

describe('AC10 the failed screen', () => {
  const WORDS = Array.from({ length: 30 }, (_, i) => `word${String(i)}x`).join(' ');

  it('shows the failure text in the body, not on the status line', () => {
    const out = renderApp(failed('Short failure text.'));
    const i = out.lines.findIndex((l) => l.includes('Short failure text.'));
    expect(i).toBeGreaterThanOrEqual(1);
    expect(i).toBeLessThanOrEqual(out.lines.length - 3);
    expect(statusLine(out)).not.toContain('Short failure');
  });

  it('wraps a long text to the width without breaking words, at 80 and at 40 columns', () => {
    for (const screen of [S80, { rows: 24, cols: 40 }, SCREEN]) {
      const out = renderApp(failed(WORDS, screen));
      checkFrame(out, screen);
      expect(collapsed(out)).toContain(WORDS);
      const body = out.lines.slice(1, out.lines.length - 2);
      expect(body.filter((l) => l.includes('word')).length).toBeGreaterThan(1);
    }
  });

  it('a text longer than the body is cut with ...', () => {
    const long = Array.from({ length: 300 }, (_, i) => `longword${String(i)}`).join(' ');
    const out = renderApp(failed(long, S40));
    checkFrame(out, S40);
    expect(text(out)).toContain('...');
    expect(collapsed(out)).not.toContain('longword299');
  });

  it('non-ASCII punctuation is replaced by ASCII', () => {
    const out = renderApp(failed('Wrong password \u2014 try again\u2026 \u201Csoon\u201D'));
    expect(collapsed(out)).toContain('Wrong password - try again... "soon"');
    for (const line of out.lines) expect(line).toMatch(/^[\x20-\x7E]*$/);
  });

  it('hostile characters in the text never reach the frame', () => {
    const out = renderApp(failed('Bad \u202E\u0007text\u0000 here'));
    checkFrame(out, SCREEN);
    expect(text(out)).not.toContain('\u202E');
    expect(text(out).replace(/\n/g, '')).not.toMatch(/\p{Cc}/u);
    expect(text(out)).toContain('Bad');
    expect(text(out)).toContain('here');
  });

  it('the key help is r try again, Esc back, q quit', () => {
    const help = helpLine(renderApp(failed('x')));
    expect(help).toContain('r try again');
    expect(help).toContain('Esc back');
    expect(help).toContain('q quit');
  });

  it('the header still names the mailbox and no folder list is drawn', () => {
    const out = renderApp(failed('x'));
    expect(out.lines[0]).toContain(`Mail Manager - ${EMAIL}`);
    expect(text(out)).not.toContain('Total:');
  });

  it('after r the connecting screen is back and the failure text is gone', () => {
    const s = press(failed('Old failure text.'), ch('r'));
    const out = renderApp(s);
    expect(statusLine(out)).toContain('Connecting...');
    expect(text(out)).not.toContain('Old failure text.');
  });
});

// --- AC8, AC9: the questions ----------------------------------------------------------------

describe('the questions on the bars', () => {
  it('Esc with marks: "Drop 3 marks? (y/N)" on the status line, keys y / any other key no', () => {
    const out = renderApp(press(barsWithMarks(), ESC));
    expect(statusLine(out)).toContain('Drop 3 marks? (y/N)');
    expect(helpLine(out)).toContain('y yes');
    expect(helpLine(out)).toContain('any other key no');
  });

  it('q with marks: "Quit and drop 3 marks? (y/N)"', () => {
    const out = renderApp(press(barsWithMarks(), ch('q')));
    expect(statusLine(out)).toContain('Quit and drop 3 marks? (y/N)');
    expect(helpLine(out)).toContain('y yes');
  });

  it('the answer no brings the normal help back', () => {
    const out = renderApp(press(barsWithMarks(), ESC, ch('n')));
    expect(statusLine(out)).not.toContain('(y/N)');
    expect(helpLine(out)).toContain('Esc back');
  });

  it('a question frame is exact at 40x8', () => {
    checkFrame(renderApp(press(barsWithMarks(S40), ESC)), S40);
    checkFrame(renderApp(press(barsWithMarks(S40), ch('q'))), S40);
  });

  it('after the browser left with folder-unavailable the bars say "Couldn\'t open that folder."', () => {
    const r = reduceApp(ready(BARS), { type: 'key', key: ENTER });
    const load = loadPageOf(r);
    const s = act(r.state, {
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
    const out = renderApp(s);
    expect(statusLine(out)).toContain("Couldn't open that folder.");
    expect(out.lines[1]).toContain('Total:');
  });
});

// --- AC11: too small ------------------------------------------------------------------------

describe('AC11 window too small', () => {
  const TOO_SMALL: [string, Screen][] = [
    ['39x8', { rows: 8, cols: 39 }],
    ['40x7', { rows: 7, cols: 40 }],
    ['30x5', { rows: 5, cols: 30 }],
  ];

  for (const [name, screen] of TOO_SMALL) {
    it(`${name}: only the too-small text, no folders, exact frame`, () => {
      const out = renderApp(resized(ready(BARS), screen));
      checkFrame(out, screen);
      expect(text(out)).toMatch(/too small/i);
      expect(text(out)).not.toContain('INBOX');
      expect(text(out)).not.toContain('Total');
      expect(text(out)).not.toContain('Quota');
    });

    it(`${name}: the pending leave question is shown`, () => {
      const out = renderApp(resized(press(barsWithMarks(), ESC), screen));
      checkFrame(out, screen);
      expect(text(out)).toMatch(/too small/i);
      expect(text(out)).toContain('Drop 3 marks? (y/N)');
    });

    it(`${name}: the pending quit question is shown`, () => {
      const out = renderApp(resized(press(barsWithMarks(), ch('q')), screen));
      expect(text(out)).toContain('Quit and drop 3 marks? (y/N)');
    });
  }

  it('connecting and the failed screen are too small as well', () => {
    for (const s of [connecting(), failed('x')]) {
      const out = renderApp(resized(s, { rows: 6, cols: 40 }));
      expect(text(out)).toMatch(/too small/i);
      expect(text(out)).not.toContain('Connecting');
    }
  });

  it('exactly 40x8 is big enough', () => {
    expect(text(renderApp(ready(BARS, S40)))).not.toMatch(/too small/i);
  });
});

// --- AC12, AC16: the browser inside the app -------------------------------------------------

describe('browsing in the app', () => {
  it('the frame is the embedded browser as it draws itself (sizes on)', () => {
    const s = browsing();
    if (s.view.kind !== 'mailbox' || s.view.browser === null) throw new Error('no browser');
    const expected = renderBrowser(s.view.browser, { sizes: true });
    const out = renderApp(s);
    expect(out.lines).toEqual(expected.lines);
    expect(out.cursorLine).toBe(expected.cursorLine);
  });

  it('shows the mails of the folder and the mailbox title', () => {
    const out = renderApp(browsing());
    expect(text(out)).toContain('Subject 3');
    expect(out.lines[0]).toContain(EMAIL);
  });

  it('the key help shows Esc back (Esc/Left back) and does not make Esc a quit key', () => {
    const help = helpLine(renderApp(browsing(BARS, { rows: 24, cols: 120 })));
    expect(help).toMatch(/Esc(\/Left)? back/);
    expect(help).not.toMatch(/Esc[^ ]* quit/);
    expect(help).toContain('q quit');
  });

  it('marks show in the browser status line', () => {
    const out = renderApp(press(browsing(), ch('a')));
    expect(statusLine(out)).toContain('marked: 3 mails');
  });

  it('after Esc the bars are drawn again with the folder list', () => {
    const out = renderApp(press(browsing(), ESC));
    expect(out.lines[1]).toContain('Total:');
    expect(rowOf(out, 'INBOX')).toMatch(/\[#{5}\.{5}\]/);
  });

  it('a resize while browsing keeps the frame exact', () => {
    const s = browsing();
    for (const screen of [S40, S80, S200]) checkFrame(renderApp(resized(s, screen)), screen);
  });

  it('o in the browser orders the mails: the bars order is not changed behind it', () => {
    // M3a: o in the browser orders the mail list (the folder is searched); it must not switch
    // the bars order behind it.
    const s = press(browsing(), ch('o'));
    const frame = text(renderApp(s));
    expect(frame).toContain('Filtering...');
    expect(frame).toContain('oldest first');
    expect(effectsOf(browsing(), ch('o')).map((e) => e.type)).toEqual(['search-folder']);
    // Esc returns to the plain list, Esc again to the bars: still the tree order.
    expect(renderApp(press(s, ESC, ESC)).lines[0]).toMatch(/tree/i);
  });
});
