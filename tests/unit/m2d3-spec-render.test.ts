import { describe, it, expect } from 'vitest';
import { renderApp } from '../../src/cli/app/render.js';
import { reduceApp, startApp } from '../../src/cli/app/reduce.js';
import { initialApp } from '../../src/cli/app/state.js';
import type {
  AppAction,
  AppEffect,
  AppKey,
  AppState,
  MailboxRow,
  MailboxView,
} from '../../src/cli/app/state.js';
import type { Rendered } from '../../src/cli/browser/render.js';
import type { Screen } from '../../src/cli/browser/state.js';
import { displayWidth } from '../../src/cli/browser/width.js';
import type { AuthUser } from '../../src/core/auth.js';
import type { FolderInfo, FolderTree } from '../../src/core/mailbox/folders.js';
import type { MessageRow } from '../../src/core/mailbox/messages.js';
import type { MailboxStats } from '../../src/core/mailbox/stats.js';

// M2d-3 stats renderer (spec S3-S5, S7 and the Frame rule): the bars' stats note, the stats
// screen with its four sections, the exact frame size at 40x8, 80x24 and 200x50, ASCII app
// text and hostile strings from outside. States are built through the reducer.

const SCREEN: Screen = { rows: 24, cols: 100 };
const S40: Screen = { rows: 8, cols: 40 };
const S80: Screen = { rows: 24, cols: 80 };
const S200: Screen = { rows: 50, cols: 200 };
const ALICE: AuthUser = { email: 'alice@example.com', userId: 'user-alice' };
const ID1 = '22222222-2222-4222-8222-222222222222';
const EMAIL = 'one@example.com';
const TOKYO = { timeZone: 'Asia/Tokyo' };
const UTC = { timeZone: 'UTC' };

const ch = (text: string): AppKey => ({ type: 'char', text });
const key = (type: Exclude<AppKey['type'], 'char'>): AppKey => ({ type });
const ENTER = key('enter');
const ESC = key('escape');
const DOWN = key('down');

// --- building states ------------------------------------------------------------------------

function press(state: AppState, ...keys: AppKey[]): AppState {
  let s = state;
  for (const k of keys) s = reduceApp(s, { type: 'key', key: k }).state;
  return s;
}

function act(state: AppState, action: AppAction): AppState {
  return reduceApp(state, action).state;
}

function mailbox(s: AppState): MailboxView {
  if (s.view.kind !== 'mailbox') throw new Error(`expected a mailbox view, got ${s.view.kind}`);
  return s.view;
}

function home(screen: Screen, autoStats: boolean, email = EMAIL): AppState {
  const row: MailboxRow = { id: ID1, email, provider: 'websupport', lastCheckedAt: null };
  const s0 = startApp(initialApp('1.0.0', screen, { autoStats })).state;
  const s1 = act(s0, {
    type: 'session',
    generation: s0.generation,
    user: ALICE,
    remembered: [ALICE.email],
  });
  const s2 = press(s1, ENTER);
  return act(s2, { type: 'mailboxes', generation: s2.generation, rows: [row] });
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

const TREE = treeOf([
  folder('INBOX', { bytes: 5000, messages: 123 }),
  folder('Sent', { bytes: 3000, messages: 45 }),
]);

/** The bars (mode ready) of a mailbox opened from Home. */
function bars(
  tree: FolderTree = TREE,
  screen: Screen = SCREEN,
  autoStats = true,
  email = EMAIL,
): AppState {
  const c = press(home(screen, autoStats, email), ENTER);
  const r = act(c, { type: 'mailbox-reading', generation: c.generation });
  return act(r, { type: 'mailbox-opened', generation: r.generation, tree });
}

const token = (s: AppState): number => mailbox(s).statsToken;

function withReady(s: AppState, stats: MailboxStats): AppState {
  return act(s, { type: 'stats-ready', statsToken: token(s), stats });
}

function withFailed(s: AppState, text: string): AppState {
  return act(s, { type: 'stats-failed', statsToken: token(s), text });
}

function withProgress(s: AppState): AppState {
  return act(s, {
    type: 'stats-progress',
    statsToken: token(s),
    progress: { folder: 3, folders: 12, done: 5000, total: 12345 },
  });
}

/** The stats screen of a finished read, at section `k` (1-4), by messages when `byMessages`. */
function screenOf(
  stats: MailboxStats,
  screen: Screen = SCREEN,
  section = '1',
  byMessages = false,
): AppState {
  let s = press(withReady(bars(TREE, screen), stats), ch('s'), ch(section));
  if (byMessages) s = press(s, ch('o'));
  expect(mailbox(s).mode).toBe('stats');
  return s;
}

function resized(s: AppState, screen: Screen): AppState {
  return act(s, { type: 'resize', screen });
}

// --- stats fixtures -------------------------------------------------------------------------

const DOMAIN = 'example-test-domain.eu';

function statsOf(over: Partial<MailboxStats> = {}): MailboxStats {
  return {
    folders: [
      { path: 'INBOX', messages: 100, bytes: 6000, partial: false },
      { path: 'Sent', messages: 60, bytes: 3000, partial: false },
      { path: 'Archive', messages: 40, bytes: 1000, partial: false },
    ],
    notScanned: 0,
    totals: { messages: 200, bytes: 10_000 },
    years: [
      { year: '2022', messages: 20, bytes: 1000 },
      { year: '2023', messages: 40, bytes: 3000 },
      { year: '2024', messages: 80, bytes: 5000 },
      { year: 'unknown', messages: 60, bytes: 1000 },
    ],
    senders: {
      bySize: [
        { key: `big@${DOMAIN}`, messages: 3, bytes: 9000 },
        { key: `mid@${DOMAIN}`, messages: 5, bytes: 4000 },
      ],
      byCount: [
        { key: `many@${DOMAIN}`, messages: 50, bytes: 100 },
        { key: `big@${DOMAIN}`, messages: 3, bytes: 9000 },
      ],
      others: { messages: 7, bytes: 2048 },
    },
    domains: {
      bySize: [{ key: `size.${DOMAIN}`, messages: 8, bytes: 13_000 }],
      byCount: [{ key: `count.${DOMAIN}`, messages: 55, bytes: 100 }],
      others: { messages: 0, bytes: 0 },
    },
    largest: [
      {
        folder: 'Projects/Alpha',
        received: new Date(Date.UTC(2026, 0, 1, 20, 0)),
        from: 'Anna Example',
        subject: 'Hello there',
        bytes: 1_048_576,
      },
      { folder: 'INBOX', received: null, from: null, subject: null, bytes: 2048 },
    ],
    approximate: false,
    unreadable: 0,
    partial: 0,
    ...over,
  };
}

const EMPTY: MailboxStats = statsOf({
  folders: [],
  totals: { messages: 0, bytes: 0 },
  years: [],
  senders: { bySize: [], byCount: [], others: { messages: 0, bytes: 0 } },
  domains: { bySize: [], byCount: [], others: { messages: 0, bytes: 0 } },
  largest: [],
});

// --- reading a frame ------------------------------------------------------------------------

const text = (r: Rendered): string => r.lines.join('\n');
const statusLine = (r: Rendered): string => r.lines[r.lines.length - 2] ?? '';
const helpLine = (r: Rendered): string => r.lines[r.lines.length - 1] ?? '';
const collapsed = (r: Rendered): string => text(r).replace(/\s+/g, ' ');

/** Body lines between the header and the status line. */
const bodyOf = (r: Rendered): string[] => r.lines.slice(1, r.lines.length - 2);

function checkFrame(r: Rendered, screen: Screen): void {
  expect(r.lines).toHaveLength(screen.rows);
  for (const line of r.lines) expect(displayWidth(line)).toBe(screen.cols);
}

function rowWith(r: Rendered, pattern: RegExp): string {
  const line = r.lines.find((l, i) => i >= 1 && pattern.test(l));
  if (line === undefined) throw new Error(`no row matching ${String(pattern)} in:\n${text(r)}`);
  return line;
}

function indexOfRow(r: Rendered, needle: string): number {
  return r.lines.findIndex((l, i) => i >= 1 && l.includes(needle));
}

const render = (s: AppState, opts: { timeZone?: string } = UTC): Rendered => renderApp(s, opts);

// --- the frame is always exact --------------------------------------------------------------

describe('Frame rule: every frame has exactly rows lines of exactly cols columns', () => {
  const SCREENS: [string, Screen][] = [
    ['40x8', S40],
    ['80x24', S80],
    ['200x50', S200],
  ];
  const HOSTILE = statsOf({
    years: [{ year: '2024', messages: 80, bytes: 5000 }],
    senders: {
      bySize: [
        { key: 'evil\u202Ename\u0007@example-test-domain.eu', messages: 3, bytes: 9000 },
        {
          key: '\u4E2D\u6587\u53D1\u4EF6\u4EBA\u540D\u79F0\u975E\u5E38\u957F\u7684\u5730\u5740',
          messages: 2,
          bytes: 100,
        },
        { key: 'emoji\u{1F600}\u{1F4E7}@example-test-domain.eu', messages: 1, bytes: 10 },
        { key: 'x'.repeat(400), messages: 1, bytes: 10 },
      ],
      byCount: [],
      others: { messages: 9_999_999, bytes: 999_999_999_999 },
    },
    domains: {
      bySize: [{ key: 'ev\u200Bil\u202E.example-test-domain.eu', messages: 3, bytes: 90 }],
      byCount: [],
      others: { messages: 0, bytes: 0 },
    },
    largest: [
      {
        folder: 'Evil\u202Efolder\u0007\u4E2D\u6587',
        received: new Date(Date.UTC(2026, 0, 1)),
        from: 'Ev\u202Eil \u{1F600} Sender\u0000',
        subject: 'Sub\u0007ject \u4E2D\u6587 \u{1F4E7} '.repeat(10),
        bytes: 123_456_789,
      },
    ],
  });
  const MAIN = statsOf();
  const sections: [string, string, boolean][] = [
    ['years by size', '1', false],
    ['years by messages', '1', true],
    ['senders by size', '2', false],
    ['senders by messages', '2', true],
    ['domains by size', '3', false],
    ['domains by messages', '3', true],
    ['largest', '4', false],
  ];
  for (const [screenName, screen] of SCREENS) {
    for (const [name, section, by] of sections) {
      it(`${name} at ${screenName}`, () => {
        checkFrame(render(screenOf(MAIN, screen, section, by)), screen);
      });
      it(`${name}, hostile strings, at ${screenName}`, () => {
        const r = render(screenOf(HOSTILE, screen, section, by));
        checkFrame(r, screen);
        const out = text(r);
        expect(out).not.toContain('\u202E');
        expect(out).not.toContain('\u200B');
        expect(out.replace(/\n/g, '')).not.toMatch(/\p{Cc}/u);
      });
    }
    it(`reading, failed and not started at ${screenName}`, () => {
      const auto = bars(TREE, screen);
      checkFrame(render(press(auto, ch('s'))), screen);
      checkFrame(render(press(withProgress(auto), ch('s'))), screen);
      checkFrame(render(press(withFailed(auto, 'It broke. '.repeat(40)), ch('s'))), screen);
      const idle = bars(TREE, screen, false);
      checkFrame(render({ ...idle, view: { ...mailbox(idle), mode: 'stats' } }), screen);
    });
    it(`the bars with every stats note at ${screenName}`, () => {
      const auto = bars(TREE, screen);
      const frames = [
        render(auto),
        render(withProgress(auto)),
        render(withReady(auto, MAIN)),
        render(withFailed(auto, 'x')),
        render(bars(TREE, screen, false)),
      ];
      for (const f of frames) {
        checkFrame(f, screen);
        // The note is on the status line (a frame without it would not test the new text).
        expect(statusLine(f)).toContain('Stats');
      }
    });
    it(`empty stats at ${screenName}`, () => {
      for (const section of ['1', '2', '3', '4']) {
        checkFrame(render(screenOf(EMPTY, screen, section)), screen);
      }
    });
  }

  it('the app text of every section is plain ASCII (ASCII data) at every size', () => {
    for (const screen of [S40, S80, SCREEN, S200]) {
      for (const [, section, by] of sections) {
        for (const line of render(screenOf(MAIN, screen, section, by)).lines) {
          expect(line).toMatch(/^[\x20-\x7E]*$/);
        }
      }
    }
  });

  it('a hostile mailbox address in the header of the stats screen is sanitised', () => {
    const s = press(
      withReady(bars(TREE, SCREEN, true, 'evil\u202E\u0007@example.com'), statsOf()),
      ch('s'),
    );
    expect(mailbox(s).mode).toBe('stats');
    const r = render(s);
    checkFrame(r, SCREEN);
    expect(r.lines[0]).not.toMatch(/[\p{Cc}\u202E]/u);
    expect(r.lines[0]).toContain('Mail Manager - ');
  });
});

describe('Frame rule: a window below 40x8 shows only "Window too small"', () => {
  const TOO_SMALL: [string, Screen][] = [
    ['39x8', { rows: 8, cols: 39 }],
    ['40x7', { rows: 7, cols: 40 }],
    ['30x5', { rows: 5, cols: 30 }],
  ];
  for (const [name, screen] of TOO_SMALL) {
    it(`${name}: the stats screen is replaced, the frame is exact`, () => {
      const r = render(resized(screenOf(statsOf()), screen));
      checkFrame(r, screen);
      expect(text(r)).toMatch(/too small/i);
      expect(text(r)).not.toContain('Scanned');
      expect(text(r)).not.toContain('2024');
    });

    it(`${name}: the bars with a stats note are replaced too`, () => {
      expect(statusLine(render(withReady(bars(), statsOf())))).toContain('Stats ready');
      const r = render(resized(withReady(bars(), statsOf()), screen));
      checkFrame(r, screen);
      expect(text(r)).toMatch(/too small/i);
      expect(text(r)).not.toContain('Stats');
    });
  }

  it('exactly 40x8 is big enough', () => {
    expect(text(render(screenOf(statsOf(), S40)))).not.toMatch(/too small/i);
  });
});

// --- S3: the bars' status line --------------------------------------------------------------

describe('S3 the stats note on the bars', () => {
  it('not started: "Stats: press s to read"', () => {
    expect(statusLine(render(bars(TREE, SCREEN, false)))).toContain('Stats: press s to read');
  });

  it('reading, no progress yet: "Stats: reading..."', () => {
    expect(statusLine(render(bars()))).toContain('Stats: reading...');
  });

  it('reading with progress: "Stats: reading folder F/N - D/T messages"', () => {
    expect(statusLine(render(withProgress(bars())))).toContain(
      'Stats: reading folder 3/12 - 5000/12345 messages',
    );
  });

  it('the progress follows every new progress action', () => {
    const s = act(withProgress(bars()), {
      type: 'stats-progress',
      statsToken: token(bars()),
      progress: { folder: 4, folders: 12, done: 1, total: 9 },
    });
    expect(statusLine(render(s))).toContain('Stats: reading folder 4/12 - 1/9 messages');
  });

  it('ready: "Stats ready - press s"', () => {
    expect(statusLine(render(withReady(bars(), statsOf())))).toContain('Stats ready - press s');
  });

  it('failed: "Stats couldn\'t be read - press s"', () => {
    expect(statusLine(render(withFailed(bars(), 'x')))).toContain(
      "Stats couldn't be read - press s",
    );
  });

  it('Gmail with All Mail hidden: the bars say the stats could not be read', () => {
    const hidden = treeOf(TREE.folders, { gmailAllHidden: true, totals: null });
    expect(statusLine(render(bars(hidden)))).toContain("Stats couldn't be read - press s");
  });

  it('the key help of the bars has "s stats"', () => {
    expect(helpLine(render(bars(TREE, S200)))).toContain('s stats');
    expect(helpLine(render(bars(TREE, SCREEN)))).toContain('s stats');
    expect(helpLine(render(bars(TREE, SCREEN)))).toContain('Enter open');
  });

  it('the note is only shown on the bars: not in a pinned message, a question or the browser', () => {
    expect(statusLine(render(withReady(bars(), statsOf())))).toContain('Stats ready - press s');
    const truncated = treeOf(TREE.folders, { truncated: true });
    const pinned = statusLine(render(bars(truncated)));
    expect(pinned).toContain('Only the first 5,000 folders are shown.');
    expect(pinned).not.toContain('Stats');

    const inFolder = press(withReady(bars(), statsOf()), ENTER);
    expect(text(render(inFolder))).not.toContain('Stats ready');
    expect(text(render(inFolder))).not.toContain('Stats:');
  });

  it('a question is shown instead of the note', () => {
    const base = withReady(bars(), statsOf());
    const opened = reduceApp(base, { type: 'key', key: ENTER });
    const load = opened.effects.find(
      (e): e is Extract<AppEffect, { type: 'load-page' }> => e.type === 'load-page',
    );
    if (load === undefined) throw new Error('no load-page');
    const rows: MessageRow[] = [3, 2, 1].map((seq) => ({
      seq,
      uid: 1000 + seq,
      received: new Date(Date.UTC(2026, 0, 1)),
      from: 'Sender',
      subject: 'Subject',
      bytes: seq,
      attachment: false,
    }));
    const loaded = act(opened.state, {
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
    });
    const asked = press(loaded, ch('a'), ESC, ESC);
    expect(statusLine(render(asked))).toContain('(y/N)');
    expect(statusLine(render(asked))).not.toContain('Stats');
    const answeredNo = press(asked, ch('n'));
    expect(statusLine(render(answeredNo))).toContain('Stats ready - press s');
  });

  it('on the stats screen: the progress while reading, no "press s" note once ready', () => {
    const reading = press(withProgress(bars()), ch('s'));
    expect(statusLine(render(reading))).toContain(
      'Stats: reading folder 3/12 - 5000/12345 messages',
    );
    const done = press(withReady(bars(), statsOf()), ch('s'));
    expect(statusLine(render(done))).not.toContain('press s');
    expect(statusLine(render(done))).not.toContain('Stats ready');
  });
});

// --- S4: header and summary -----------------------------------------------------------------

describe('S4 the stats screen header and the summary line', () => {
  it('header: Mail Manager - <mailbox e-mail>, then the section on the right', () => {
    const r = render(screenOf(statsOf()));
    expect(r.lines[0]).toContain(`Mail Manager - ${EMAIL}`);
    expect(r.lines[0]).toMatch(/Years - by size\s*$/);
  });

  it.each([
    ['1', false, /Years - by size\s*$/],
    ['1', true, /Years - by messages\s*$/],
    ['2', false, /Top senders - by size\s*$/],
    ['2', true, /Top senders - by messages\s*$/],
    ['3', false, /Top domains - by size\s*$/],
    ['3', true, /Top domains - by messages\s*$/],
    ['4', false, /Largest mails\s*$/],
  ] as const)('section %s, by messages %s: the right cell', (section, byMessages, expected) => {
    const quiet = statsOf({
      senders: { ...statsOf().senders, others: { messages: 0, bytes: 0 } },
    });
    const r = render(screenOf(quiet, SCREEN, section, byMessages));
    expect(r.lines[0]).toMatch(expected);
  });

  it('Largest mails ignores o: still "Largest mails"', () => {
    expect(render(screenOf(statsOf(), SCREEN, '4', true)).lines[0]).toMatch(/Largest mails\s*$/);
  });

  it('senders and domains with an others row are marked (approximate)', () => {
    const s = statsOf({
      domains: {
        bySize: [{ key: `size.${DOMAIN}`, messages: 8, bytes: 13_000 }],
        byCount: [],
        others: { messages: 3, bytes: 30 },
      },
    });
    expect(render(screenOf(s, SCREEN, '2')).lines[0]).toMatch(
      /Top senders - by size \(approximate\)\s*$/,
    );
    expect(render(screenOf(s, SCREEN, '3')).lines[0]).toMatch(
      /Top domains - by size \(approximate\)\s*$/,
    );
    expect(render(screenOf(s, SCREEN, '2', true)).lines[0]).toMatch(
      /by messages \(approximate\)\s*$/,
    );
  });

  it('a list without an others row is not marked, nor are years or largest', () => {
    const s = statsOf();
    expect(render(screenOf(s, SCREEN, '3')).lines[0]).not.toContain('(approximate)');
    expect(render(screenOf(s, SCREEN, '1')).lines[0]).not.toContain('(approximate)');
    expect(render(screenOf(s, SCREEN, '4')).lines[0]).not.toContain('(approximate)');
  });

  it('summary: Scanned N folders, M messages, SIZE (approx.)', () => {
    const r = render(screenOf(statsOf()));
    expect(r.lines[1]?.trimEnd()).toBe('Scanned 3 folders, 200 messages, 9.8 KB (approx.)');
  });

  it('1 folder is singular', () => {
    const s = statsOf({ folders: [{ path: 'INBOX', messages: 5, bytes: 100, partial: false }] });
    expect(render(screenOf(s)).lines[1]).toContain('Scanned 1 folder, ');
    expect(render(screenOf(s)).lines[1]).not.toContain('1 folders');
  });

  it('unreadable, partial and skipped folders are added in that order, wide enough to show', () => {
    const s = statsOf({ unreadable: 2, partial: 3, notScanned: 4 });
    const line = render(screenOf(s, S200)).lines[1] ?? '';
    const a = line.indexOf(", 2 folders couldn't be read");
    const b = line.indexOf(', 3 folders read only partly');
    const c = line.indexOf(', 4 folders skipped (counted elsewhere)');
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  it('each of them in the singular with 1', () => {
    const line = (over: Partial<MailboxStats>): string =>
      render(screenOf(statsOf(over), S200)).lines[1] ?? '';
    expect(line({ unreadable: 1 })).toContain(", 1 folder couldn't be read");
    expect(line({ partial: 1 })).toContain(', 1 folder read only partly');
    expect(line({ notScanned: 1 })).toContain(', 1 folder skipped (counted elsewhere)');
  });

  it('nothing to add when all are 0', () => {
    const line = render(screenOf(statsOf(), S200)).lines[1] ?? '';
    expect(line).not.toContain("couldn't");
    expect(line).not.toContain('partly');
    expect(line).not.toContain('skipped');
  });

  it('the summary line does not scroll', () => {
    const many = statsOf({
      years: Array.from({ length: 30 }, (_, i) => ({
        year: String(2025 - i),
        messages: 1,
        bytes: 100,
      })),
    });
    const scrolled = press(screenOf(many), ...Array.from({ length: 500 }, () => DOWN));
    const r = render(scrolled);
    expect(r.lines[1]).toMatch(/^Scanned /);
  });
});

// --- S5: the rows ---------------------------------------------------------------------------

describe('S5 Years', () => {
  it('newest first, unknown last', () => {
    const r = render(screenOf(statsOf()));
    const idx = ['2024', '2023', '2022', 'unknown'].map((n) => indexOfRow(r, n));
    expect(idx.every((i) => i > 1)).toBe(true);
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
  });

  it('by size: [bar] pct size messages, shares of the total bytes', () => {
    const r = render(screenOf(statsOf()));
    expect(rowWith(r, /\b2024\b/)).toMatch(/\b2024\s+\[#{5}\.{5}\]\s+50%\s+4\.9 KB\s+80\s*$/);
    expect(rowWith(r, /\b2023\b/)).toMatch(/\b2023\s+\[#{3}\.{7}\]\s+30%\s+2\.9 KB\s+40\s*$/);
    expect(rowWith(r, /\b2022\b/)).toMatch(/\[#\.{9}\]\s+10%/);
  });

  it('by messages: the same cells, shares of the total messages', () => {
    const r = render(screenOf(statsOf(), SCREEN, '1', true));
    expect(rowWith(r, /\b2024\b/)).toMatch(/\b2024\s+\[#{4}\.{6}\]\s+40%\s+4\.9 KB\s+80\s*$/);
    expect(rowWith(r, /\b2023\b/)).toMatch(/\[#{2}\.{8}\]\s+20%/);
    expect(rowWith(r, /unknown/)).toMatch(/\[#{3}\.{7}\]\s+30%/);
  });

  it('a share that rounds to no cell still shows one; below 0.5 per cent is <1%, above is 1%', () => {
    const s = statsOf({
      totals: { messages: 100_000, bytes: 100_000 },
      years: [
        { year: '2023', messages: 1, bytes: 400 },
        { year: '2024', messages: 1, bytes: 600 },
      ],
    });
    const r = render(screenOf(s));
    expect(rowWith(r, /\b2023\b/)).toMatch(/\[#\.{9}\]\s+<1%/);
    expect(rowWith(r, /\b2024\b/)).toMatch(/\[#\.{9}\]\s+1%/);
  });

  it('a total of 0 bytes: no bar and no percent in any row (by size)', () => {
    const s = statsOf({
      totals: { messages: 5, bytes: 0 },
      years: [{ year: '2024', messages: 5, bytes: 0 }],
    });
    const row = rowWith(render(screenOf(s)), /\b2024\b/);
    expect(row).not.toMatch(/\[[#.]+\]/);
    expect(row).not.toContain('%');
    // The other measure still has its bars.
    expect(rowWith(render(screenOf(s, SCREEN, '1', true)), /\b2024\b/)).toMatch(/\[#{10}\]\s+100%/);
  });

  it('a total of 0 messages: no bar and no percent (by messages)', () => {
    const s = statsOf({
      totals: { messages: 0, bytes: 100 },
      years: [{ year: '2024', messages: 0, bytes: 100 }],
    });
    const row = rowWith(render(screenOf(s, SCREEN, '1', true)), /\b2024\b/);
    expect(row).not.toMatch(/\[[#.]+\]/);
    expect(row).not.toContain('%');
  });

  describe('narrow windows pick one cell set per frame', () => {
    const NARROW = statsOf({
      years: [
        { year: '2022', messages: 7777, bytes: 1000 },
        { year: '2023', messages: 5555, bytes: 3000 },
        { year: '2024', messages: 3333, bytes: 5000 },
      ],
    });

    /** 4 = 10-cell bar, 3 = 6-cell bar, 2 = percent only, 1 = neither. */
    function tier(line: string): number {
      if (/\[[#.]{10}\]/.test(line)) return 4;
      if (/\[[#.]{6}\]/.test(line)) return 3;
      if (line.includes('%')) return 2;
      return 1;
    }

    const frame = (cols: number): Rendered => render(screenOf(NARROW, { rows: 12, cols }));

    it('wide windows have the 10-cell bar, 40 columns do not', () => {
      expect(tier(rowWith(frame(100), /\b2024\b/))).toBe(4);
      expect(tier(rowWith(frame(200), /\b2024\b/))).toBe(4);
      expect(tier(rowWith(frame(40), /\b2024\b/))).toBeLessThan(4);
    });

    it('the cell set only gets shorter as the window narrows; every width is a known tier', () => {
      let previous = 0;
      const seen = new Set<number>();
      for (let cols = 40; cols <= 130; cols++) {
        const t = tier(rowWith(frame(cols), /\b2024\b/));
        expect(t, `${String(cols)} columns`).toBeGreaterThanOrEqual(previous);
        previous = t;
        seen.add(t);
      }
      expect(seen.has(4)).toBe(true);
      expect(seen.has(3)).toBe(true);
      expect(seen.has(2)).toBe(true);
    });

    it('every row of a frame has the same cell set', () => {
      for (let cols = 40; cols <= 120; cols += 3) {
        const r = frame(cols);
        const tiers = [/\b2022\b/, /\b2023\b/, /\b2024\b/].map((p) => tier(rowWith(r, p)));
        expect(new Set(tiers).size, `${String(cols)} columns`).toBe(1);
      }
    });

    it('every width gives an exact frame and keeps the year', () => {
      for (let cols = 40; cols <= 130; cols += 7) {
        const r = frame(cols);
        checkFrame(r, { rows: 12, cols });
        expect(text(r)).toContain('2024');
      }
    });
  });
});

describe('S5 Top senders and Top domains', () => {
  it('by size: the bySize list, key left, size and messages right', () => {
    const r = render(screenOf(statsOf(), SCREEN, '2'));
    expect(rowWith(r, /big@/)).toMatch(/big@example-test-domain\.eu\s+8\.8 KB\s+3\s*$/);
    expect(rowWith(r, /mid@/)).toMatch(/mid@example-test-domain\.eu\s+3\.9 KB\s+5\s*$/);
    expect(text(r)).not.toContain('many@');
  });

  it('by messages: the byCount list', () => {
    const r = render(screenOf(statsOf(), SCREEN, '2', true));
    expect(rowWith(r, /many@/)).toMatch(/many@example-test-domain\.eu\s+100 B\s+50\s*$/);
    expect(text(r)).not.toContain('mid@');
  });

  it('domains use their own lists', () => {
    expect(text(render(screenOf(statsOf(), SCREEN, '3')))).toContain(`size.${DOMAIN}`);
    expect(text(render(screenOf(statsOf(), SCREEN, '3')))).not.toContain(`count.${DOMAIN}`);
    expect(text(render(screenOf(statsOf(), SCREEN, '3', true)))).toContain(`count.${DOMAIN}`);
  });

  it('a last row "others" when others.messages > 0, after every key row', () => {
    const r = render(screenOf(statsOf(), SCREEN, '2'));
    expect(rowWith(r, /\bothers\b/)).toMatch(/\bothers\s+2\.0 KB\s+7\s*$/);
    expect(indexOfRow(r, 'others')).toBeGreaterThan(indexOfRow(r, 'mid@'));
    const by = render(screenOf(statsOf(), SCREEN, '2', true));
    expect(indexOfRow(by, 'others')).toBeGreaterThan(indexOfRow(by, 'big@'));
  });

  it('no others row when there are none', () => {
    expect(text(render(screenOf(statsOf(), SCREEN, '3')))).not.toContain('others');
  });

  it('a missing key is (no address) / (no domain)', () => {
    const s = statsOf({
      senders: {
        bySize: [{ key: null, messages: 2, bytes: 500 }],
        byCount: [],
        others: { messages: 0, bytes: 0 },
      },
      domains: {
        bySize: [{ key: null, messages: 2, bytes: 500 }],
        byCount: [],
        others: { messages: 0, bytes: 0 },
      },
    });
    expect(text(render(screenOf(s, SCREEN, '2')))).toContain('(no address)');
    expect(text(render(screenOf(s, SCREEN, '3')))).toContain('(no domain)');
  });

  it('a key that sanitises to nothing is (unreadable)', () => {
    const s = statsOf({
      senders: {
        bySize: [{ key: '\u202E\u200B\u0007', messages: 2, bytes: 500 }],
        byCount: [],
        others: { messages: 0, bytes: 0 },
      },
    });
    const r = render(screenOf(s, SCREEN, '2'));
    expect(text(r)).toContain('(unreadable)');
    expect(text(r)).not.toContain('\u202E');
  });

  it('a hostile key keeps its readable part: sanitised, not dropped', () => {
    const s = statsOf({
      senders: {
        bySize: [{ key: 'evil\u202E\u0007@example-test-domain.eu', messages: 2, bytes: 500 }],
        byCount: [],
        others: { messages: 0, bytes: 0 },
      },
    });
    expect(text(render(screenOf(s, SCREEN, '2')))).toContain('evil@example-test-domain.eu');
  });
});

describe('S5 Largest mails', () => {
  it('one row: size, date in the app time zone, sender - subject (folder)', () => {
    const r = render(screenOf(statsOf(), SCREEN, '4'), TOKYO);
    expect(rowWith(r, /Anna Example/)).toMatch(
      /1\.0 MB\s+2026-01-02\s+Anna Example - Hello there \(Projects\/Alpha\)/,
    );
  });

  it('the date follows the time zone of the render options', () => {
    const utc = render(screenOf(statsOf(), SCREEN, '4'), UTC);
    expect(rowWith(utc, /Anna Example/)).toContain('2026-01-01');
    expect(rowWith(utc, /Anna Example/)).not.toContain('2026-01-02');
  });

  it('an unknown date is "-"; no sender / subject are (no address) / (no subject)', () => {
    const r = render(screenOf(statsOf(), SCREEN, '4'));
    expect(rowWith(r, /\(no address\)/)).toMatch(
      /2\.0 KB\s+-\s+\(no address\) - \(no subject\) \(INBOX\)/,
    );
  });

  it('the date is left out below 56 columns and shown from 56', () => {
    const at = (cols: number): Rendered =>
      render(screenOf(statsOf(), { rows: 12, cols }, '4'), TOKYO);
    const narrow = at(55);
    expect(text(narrow)).toContain('Anna Example');
    expect(text(narrow)).not.toContain('2026-01-02');
    expect(text(at(56))).toContain('2026-01-02');
    expect(text(at(100))).toContain('2026-01-02');
  });

  it('a long row is cut to the width, the frame stays exact', () => {
    const s = statsOf({
      largest: [
        {
          folder: 'Folder',
          received: new Date(Date.UTC(2026, 0, 1)),
          from: 'Sender',
          subject: 'word '.repeat(80),
          bytes: 5000,
        },
      ],
    });
    for (const screen of [S40, S80, S200]) checkFrame(render(screenOf(s, screen, '4')), screen);
  });
});

describe('S5 empty lists and the empty mailbox', () => {
  it('(none) in every section when the lists are empty', () => {
    for (const section of ['1', '2', '3', '4']) {
      expect(text(render(screenOf(EMPTY, SCREEN, section)))).toContain('(none)');
    }
  });

  it('a mailbox with no selectable folder: the summary of nothing', () => {
    expect(render(screenOf(EMPTY)).lines[1]?.trimEnd()).toBe(
      'Scanned 0 folders, 0 messages, 0 B (approx.)',
    );
  });

  it('(none) only for the empty list: the others keep their rows', () => {
    const s = statsOf({ largest: [] });
    expect(text(render(screenOf(s, SCREEN, '4')))).toContain('(none)');
    expect(text(render(screenOf(s, SCREEN, '1')))).not.toContain('(none)');
  });
});

describe('scrolling the rows', () => {
  const MANY = statsOf({
    years: Array.from({ length: 30 }, (_, i) => ({
      year: String(2025 - i),
      messages: 1,
      bytes: 100,
    })),
  });

  it('opens at the top: the newest year first', () => {
    const r = render(screenOf(MANY));
    expect(indexOfRow(r, '2025')).toBeGreaterThan(1);
    expect(text(render(screenOf(MANY, S40)))).toContain('2025');
  });

  it('Down scrolls the rows and the first ones leave the frame', () => {
    const r = render(press(screenOf(MANY), DOWN, DOWN, DOWN));
    const body = bodyOf(r).slice(1).join('\n');
    expect(body).toContain('2022');
    expect(body).not.toContain('2025');
    expect(body).not.toContain('2023');
  });

  it('at the end the last row is the last one shown and the first is gone', () => {
    for (const screen of [S40, SCREEN]) {
      const r = render(press(screenOf(MANY, screen), ...Array.from({ length: 500 }, () => DOWN)));
      checkFrame(r, screen);
      expect(text(r)).toContain('1996');
      expect(text(r)).not.toContain('2025');
    }
  });
});

// --- S7: reading, failed, not started -------------------------------------------------------

describe('S7 the stats screen while reading, after a failure, before a start', () => {
  it('reading: an empty body and the progress on the status line', () => {
    const s = press(withProgress(bars()), ch('s'));
    const r = render(s);
    for (const line of bodyOf(r)) expect(line.trim()).toBe('');
    expect(statusLine(r)).toContain('Stats: reading folder 3/12 - 5000/12345 messages');
  });

  it('reading without progress: "Stats: reading..." on the status line', () => {
    const r = render(press(bars(), ch('s')));
    for (const line of bodyOf(r)) expect(line.trim()).toBe('');
    expect(statusLine(r)).toContain('Stats: reading...');
  });

  it('failed: the text in the body, wrapped; "r try again" in the key help', () => {
    const words = Array.from({ length: 30 }, (_, i) => `word${String(i)}x`).join(' ');
    for (const screen of [S80, { rows: 24, cols: 40 }, SCREEN]) {
      const r = render(press(withFailed(bars(TREE, screen), words), ch('s')));
      checkFrame(r, screen);
      expect(collapsed(r)).toContain(words);
      expect(bodyOf(r).filter((l) => l.includes('word')).length).toBeGreaterThan(1);
      expect(helpLine(r)).toContain('r try again');
    }
  });

  it('failed: non-ASCII punctuation of the text is written in ASCII', () => {
    const r = render(
      press(withFailed(bars(), 'Stats \u2014 failed\u2026 \u201Cagain\u201D'), ch('s')),
    );
    expect(collapsed(r)).toContain('Stats - failed... "again"');
    for (const line of r.lines) expect(line).toMatch(/^[\x20-\x7E]*$/);
  });

  it('failed: hostile characters of the text never reach the frame', () => {
    const r = render(press(withFailed(bars(), 'Bad \u202E\u0007text\u0000 here'), ch('s')));
    checkFrame(r, SCREEN);
    expect(text(r)).not.toContain('\u202E');
    expect(text(r).replace(/\n/g, '')).not.toMatch(/\p{Cc}/u);
    expect(text(r)).toContain('here');
  });

  it('failed because Gmail hides All Mail: that text, and r try again', () => {
    const hidden = treeOf(TREE.folders, { gmailAllHidden: true, totals: null });
    const r = render(press(bars(hidden), ch('s')));
    expect(collapsed(r)).toContain(
      "Stats can't be read - Gmail hides All Mail from IMAP (Labels > Show in IMAP).",
    );
  });

  it('not started: "Press r to read the stats."', () => {
    const idle = bars(TREE, SCREEN, false);
    const r = render({ ...idle, view: { ...mailbox(idle), mode: 'stats' } });
    expect(collapsed(r)).toContain('Press r to read the stats.');
  });

  it('ready: "r read again" in the help; Esc back and q quit survive at 40 columns', () => {
    const wide = helpLine(render(screenOf(statsOf(), S200)));
    for (const item of ['1-4', 'o', 'Esc back', 'q quit', 'r read again']) {
      expect(wide).toContain(item);
    }
    for (const r of [
      render(screenOf(statsOf(), S40)),
      render(press(withFailed(bars(TREE, S40), 'x'), ch('s'))),
      render(press(bars(TREE, S40), ch('s'))),
    ]) {
      expect(helpLine(r)).toContain('Esc back');
      expect(helpLine(r)).toContain('q quit');
    }
  });
});
