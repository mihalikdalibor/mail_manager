import { describe, it, expect } from 'vitest';
import { CHALLENGE_NOTICE } from '../../src/cli/browser/controller.js';
import { MIN_COLS, MIN_ROWS, render, statusText } from '../../src/cli/browser/render.js';
import type { RenderOptions, Rendered } from '../../src/cli/browser/render.js';
import { childFolders, initialState, reduce } from '../../src/cli/browser/state.js';
import type {
  BrowserAction,
  BrowserKey,
  BrowserState,
  Screen,
  StatusMessage,
} from '../../src/cli/browser/state.js';
import { displayWidth, fit } from '../../src/cli/browser/width.js';
import { formatBytes } from '../../src/cli/folders-text.js';
import { sanitize } from '../../src/cli/log-text.js';
import type { FolderInfo } from '../../src/core/mailbox/folders.js';
import type { FolderSnapshot, MessageRow } from '../../src/core/mailbox/messages.js';

// M2b-1 browser screen (spec): width.ts and the pure render(), over states built with
// initialState + reduce only.

// --- helpers --------------------------------------------------------------------------------

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

function mail(seq: number, over: Partial<MessageRow> = {}): MessageRow {
  return {
    seq,
    uid: 1000 + seq,
    received: new Date(Date.UTC(2026, 0, 2, 12)),
    from: `Sender ${seq}`,
    subject: `Subject ${seq}`,
    bytes: 100,
    attachment: false,
    ...over,
  };
}

function rowsOf(
  exists: number,
  page: number,
  make: (seq: number) => MessageRow = mail,
): MessageRow[] {
  const to = exists - 200 * page;
  const rows: MessageRow[] = [];
  for (let seq = to; seq >= Math.max(1, to - 199); seq--) rows.push(make(seq));
  return rows;
}

// Ten columns like the default YYYY-MM-DD, but independent of the local time zone.
const FMT: RenderOptions = { formatDate: (d) => d.toISOString().slice(0, 10) };

function act(state: BrowserState, ...actions: BrowserAction[]): BrowserState {
  let s = state;
  for (const a of actions) s = reduce(s, a).state;
  return s;
}

function keys(state: BrowserState, ...ks: BrowserKey[]): BrowserState {
  return act(state, ...ks.map((key): BrowserAction => ({ type: 'key', key })));
}

function repeat(key: BrowserKey, n: number): BrowserKey[] {
  return Array.from({ length: n }, () => key);
}

/** Moves to the child folder `path` of the current place and presses Enter. */
function enter(state: BrowserState, path: string): BrowserState {
  const index = childFolders(state).findIndex((f) => f.path === path);
  if (index < 0) throw new Error(`no child folder ${path}`);
  let s = keys(state, ...repeat('up', state.cursor));
  s = keys(s, ...repeat('down', index));
  return keys(s, 'enter');
}

/** Answers the open folder's page `page`. */
function loaded(
  state: BrowserState,
  snapshot: FolderSnapshot,
  page: number,
  rows: MessageRow[],
): BrowserState {
  const path = state.path;
  if (path === null) throw new Error('no open folder');
  return act(state, {
    type: 'page-loaded',
    generation: state.generation,
    path,
    page,
    result: { kind: 'page', snapshot, page, rows },
  });
}

function controlChars(line: string): string[] {
  return [...line].filter((c) => {
    const cp = c.codePointAt(0) ?? 0;
    return cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f);
  });
}

function checkScreen(out: Rendered, screen: Screen): void {
  expect(out.lines).toHaveLength(screen.rows);
  for (const line of out.lines) {
    expect(displayWidth(line)).toBeLessThanOrEqual(screen.cols);
    expect(controlChars(line)).toEqual([]);
    expect(line).not.toMatch(/[\u202A-\u202E\u2066-\u2069\u200B-\u200F\uFEFF]/u);
  }
}

function body(out: Rendered, rows: number): string[] {
  return out.lines.slice(1, rows - 2);
}

function lineWith(lines: string[], text: string): string {
  const line = lines.find((l) => l.includes(text));
  if (line === undefined) throw new Error(`no line with ${text}`);
  return line;
}

/** An unknown value: a lone "-" between spaces (a date's dashes don't match). */
const UNKNOWN_CELL = /(^|\s)-(\s|$)/;

// --- width.ts -------------------------------------------------------------------------------

describe('displayWidth', () => {
  it.each<[string, number]>([
    ['', 0],
    ['abc', 3],
    ['日本語', 6],
    ['ひらがな', 8],
    ['カタカナ', 8],
    ['한글', 4],
    ['ＡＢ', 4],
    ['￥', 2],
    ['😀', 2],
    ['👍🏽', 2],
    ['👨\u200D👩\u200D👧', 2],
    ['e\u0301', 1],
    ['\u0301', 0],
    ['\u0301\u0302', 0],
    ['a\u0301\u0302', 1],
    ['aé日😀', 6],
    ['…', 1],
    ['—', 1],
  ])('%j → %i', (text, width) => {
    expect(displayWidth(text)).toBe(width);
  });
});

describe('fit', () => {
  it.each<[string, number, string]>([
    ['abc', 5, 'abc  '],
    ['abcdef', 4, 'a...'],
    ['abc', 0, ''],
    ['', 0, ''],
    ['abc', 3, 'abc'],
    ['abcd', 3, '...'],
    ['', 3, '   '],
    ['abc', 1, '.'],
    ['abc', 2, '..'],
    ['日本', 4, '日本'],
    ['日本', 5, '日本 '],
    ['日本', 3, '...'],
    ['日本語', 5, '日...'],
    ['😀😀', 3, '...'],
    ['😀😀😀', 5, '😀...'],
    ['e\u0301e\u0301e\u0301', 2, '..'],
    ['e\u0301e\u0301e\u0301e\u0301e\u0301', 4, 'e\u0301...'],
    ['e\u0301e\u0301', 2, 'e\u0301e\u0301'],
  ])('fit(%j, %i) = %j', (text, width, expected) => {
    expect(fit(text, width)).toBe(expected);
  });

  it('a wide char that does not fit before ... becomes padding', () => {
    const out = fit('日本語x', 6);
    expect(displayWidth(out)).toBe(6);
    expect(out.startsWith('日')).toBe(true);
    expect(out).toContain('...');
    expect(out).not.toContain('本');
    expect(displayWidth(fit('日本', 1))).toBe(1);
  });

  it('displayWidth(fit(s, w)) === w for every string and width', () => {
    const strings = [
      '',
      'a',
      'abc',
      'hello world',
      '日本語のテキスト',
      'a日b本c',
      '😀😀😀',
      '👨\u200D👩\u200D👧 family',
      'e\u0301e\u0301e\u0301e\u0301',
      '\u0301\u0301',
      '한글 텍스트',
      'ＦＵＬＬ',
      'mixed 日本 😀 e\u0301 text',
      'x'.repeat(300),
    ];
    for (const s of strings) {
      for (let w = 0; w <= 20; w++) {
        expect(displayWidth(fit(s, w)), `fit(${JSON.stringify(s)}, ${w})`).toBe(w);
      }
      expect(displayWidth(fit(s, 250))).toBe(250);
    }
  });
});

// --- render: hostile data -----------------------------------------------------------------------

const MB_SUBJECT = 'y'.repeat(1_000_000);

const HOSTILE = [
  '\x1b[31mred\x1b[0m',
  '\x1b]0;title\x07',
  'evil\u202Etxt.exe',
  'zero\u200Bwidth\uFEFF',
  '日本語のメール件名です',
  '😀🎉👍🏽👨\u200D👩\u200D👧',
  'e\u0301\u0301\u0301 cafe\u0301',
  'line1\nline2\ttab\rcr\x00nul\x7fdel\x9bcsi',
];

const SCREENS: Screen[] = [
  { cols: 40, rows: 8 },
  { cols: 80, rows: 24 },
  { cols: 200, rows: 60 },
];

function hostileFolders(): FolderInfo[] {
  return [
    folder('INBOX', { messages: 30 }),
    ...HOSTILE.map((name, i) =>
      folder(`F${i}${name}`, {
        name,
        messages: i * 1000,
        bytes: i * 123_456,
        sizeSource: i % 2 ? 'sum' : 'server',
      }),
    ),
    folder('Long', { name: 'L'.repeat(5000), messages: null, bytes: null, sizeSource: null }),
  ];
}

function hostileRows(): MessageRow[] {
  return rowsOf(30, 0, (seq) =>
    mail(seq, {
      from: HOSTILE[seq % HOSTILE.length] ?? null,
      subject: seq === 29 ? MB_SUBJECT : (HOSTILE[(seq + 3) % HOSTILE.length] ?? null),
      received: seq % 3 === 0 ? null : new Date(Date.UTC(2026, 0, seq)),
      bytes: seq % 4 === 0 ? null : seq * 1000,
      attachment: seq % 2 === 0,
    }),
  );
}

function hostileStates(screen: Screen): [string, BrowserState][] {
  const title = `\x1b[2J${HOSTILE.join(' ')}`;
  const root = initialState(title, hostileFolders(), screen);
  const inbox = loaded(
    enter(root, 'INBOX'),
    { path: 'INBOX', uidValidity: '7', exists: 30 },
    0,
    hostileRows(),
  );
  const marked = keys(inbox, 'space', 'down', 'space', 'down', 'down', 'space');
  const lost: BrowserAction = {
    type: 'load-failed',
    generation: marked.generation,
    path: 'INBOX',
    page: 0,
    code: 'connection-lost',
  };
  return [
    ['root', root],
    ['root + notice', act(root, { type: 'notice', text: HOSTILE.join('|') })],
    ['root scrolled to the end', keys(root, ...repeat('down', 20))],
    ['inbox', inbox],
    ['inbox scrolled', keys(inbox, ...repeat('down', 29))],
    ['inbox + marks', marked],
    ['inbox + notice', act(marked, { type: 'notice', text: `${MB_SUBJECT}${HOSTILE.join('')}` })],
    ['confirm-quit', keys(marked, 'quit')],
    ['reconnect-ask', act(marked, lost)],
    ['reconnecting', keys(act(marked, lost), 'yes')],
    [
      'reconnect-failed',
      act(keys(act(marked, lost), 'yes'), { type: 'reconnect-failed', text: HOSTILE.join(' ') }),
    ],
    ['offline', keys(act(marked, lost), 'no')],
  ];
}

describe('render: every line fits, no control characters', () => {
  for (const screen of SCREENS) {
    it(`${screen.cols}×${screen.rows}`, () => {
      for (const [name, state] of hostileStates(screen)) {
        const out = render(state, FMT);
        try {
          checkScreen(out, screen);
        } catch (err) {
          throw new Error(`${name}: ${(err as Error).message}`, { cause: err });
        }
        if (out.cursorLine !== null) {
          expect(out.cursorLine).toBeGreaterThanOrEqual(1);
          expect(out.cursorLine).toBeLessThanOrEqual(screen.rows - 3);
        }
      }
    });
  }

  it('the default formatDate works too', () => {
    const screen = { cols: 80, rows: 24 };
    for (const [, state] of hostileStates(screen)) checkScreen(render(state), screen);
  });

  it('server text is sanitised, not dropped', () => {
    const screen = { cols: 200, rows: 60 };
    const root = initialState(
      'Acct \x1b[31mRed\x1b[0m',
      [folder('Evil\u202Ename', { name: 'Evil\u202Ename' })],
      screen,
    );
    const out = render(root, FMT);
    expect(out.lines[0]).toContain('Acct [31mRed[0m');
    lineWith(body(out, 60), 'Evilname/');
  });
});

// --- render: layout -----------------------------------------------------------------------------

const TREE: FolderInfo[] = [
  folder('INBOX', { messages: 450, bytes: 2048, sizeSource: 'server' }),
  folder('Archive', {
    selectable: false,
    messages: null,
    unseen: null,
    bytes: null,
    sizeSource: null,
  }),
  folder('Archive/2023', { messages: 10, bytes: 1536, sizeSource: 'sum' }),
  folder('Empty', { messages: 0, bytes: 0 }),
  folder('Server', { messages: 12, bytes: 1536, sizeSource: 'server' }),
  folder('Sum', { messages: 12, bytes: 1536, sizeSource: 'sum' }),
  folder('Unknown', { messages: null, unseen: null, bytes: null, sizeSource: null }),
  folder('Two', { messages: 230 }),
];

const WIDE: Screen = { cols: 200, rows: 30 };

function at(screen: Screen = WIDE): BrowserState {
  return initialState('Test account', TREE, screen);
}

function inbox(screen: Screen = WIDE, rows: MessageRow[] = rowsOf(450, 0)): BrowserState {
  return loaded(
    enter(at(screen), 'INBOX'),
    { path: 'INBOX', uidValidity: '7', exists: 450 },
    0,
    rows,
  );
}

describe('render: structure', () => {
  it('exactly rows lines: header, body, status, help', () => {
    for (const screen of SCREENS) {
      const out = render(inbox(screen), FMT);
      expect(out.lines).toHaveLength(screen.rows);
      expect(out.lines[0]).toContain('Test account');
      expect(out.lines[screen.rows - 1]?.startsWith('Up/Down move')).toBe(true);
    }
  });

  it('help mentions the attachment marker when it fits', () => {
    const out = render(at(), FMT);
    expect(out.lines[WIDE.rows - 1]).toContain('+ = attachment');
  });

  it('header: title, path segments, message count from the snapshot or the tree', () => {
    expect(render(inbox(), FMT).lines[0]).toContain('450 mails');
    const archived = enter(enter(at(), 'Archive'), 'Archive/2023');
    const header = render(archived, FMT).lines[0] ?? '';
    expect(header).toContain('Test account');
    expect(header).toContain('Archive');
    expect(header).toContain('2023');
    expect(header).toContain('10 mails');
    const after = loaded(
      archived,
      { path: 'Archive/2023', uidValidity: '1', exists: 11 },
      0,
      rowsOf(11, 0),
    );
    expect(render(after, FMT).lines[0]).toContain('11 mails');
  });

  it('folder rows: name/, count, size with ~ only for summed sizes', () => {
    const lines = body(render(at(), FMT), WIDE.rows);
    const server = lineWith(lines, 'Server/');
    expect(server).toContain('12');
    expect(server).toContain(formatBytes(1536));
    expect(server).not.toContain('~');
    const sum = lineWith(lines, 'Sum/');
    expect(sum).toContain('12');
    expect(sum).toContain(`~${formatBytes(1536)}`);
    // Count (padded to 9) and size (padded to 10) are each a lone "-".
    expect(lineWith(lines, 'Unknown/')).toMatch(/Unknown\/ +- +- *$/);
    expect(lineWith(lines, 'INBOX/')).toContain('450');
  });

  it('mail rows: [x]/[ ], date, from, subject, size, + for attachments, - when unknown', () => {
    const rows = [
      mail(3, { from: 'Alice', subject: 'Hello', bytes: 1536, attachment: true }),
      mail(2, { from: 'Bob', subject: 'Re', received: null, bytes: null }),
      mail(1, { from: 'Carol', subject: 'Plain', bytes: 2048 }),
    ];
    let s = loaded(enter(at(), 'INBOX'), { path: 'INBOX', uidValidity: '7', exists: 3 }, 0, rows);
    s = keys(s, 'space');
    const lines = body(render(s, FMT), WIDE.rows);
    const alice = lineWith(lines, 'Alice');
    expect(alice).toContain('[x]');
    expect(alice).toContain('2026-01-02');
    expect(alice).toContain('Hello');
    expect(alice).toContain(formatBytes(1536));
    expect(alice).toContain('+');
    const bob = lineWith(lines, 'Bob');
    expect(bob).toContain('[ ]');
    expect(bob).toContain('Re');
    expect(bob).toMatch(UNKNOWN_CELL);
    expect(bob).not.toContain('2026-');
    expect(bob).not.toContain('+');
    const carol = lineWith(lines, 'Carol');
    expect(carol).toContain('[ ]');
    expect(carol).toContain(formatBytes(2048));
    expect(carol).not.toMatch(UNKNOWN_CELL);
    expect(carol).not.toContain('+');
  });

  it("placeholders: loading..., couldn't load, (not readable)", () => {
    // 'Two' has 230 mails: page 0 = seq 230…31, page 1 = seq 30…1.
    const missing = rowsOf(230, 0).filter((r) => r.seq !== 229);
    let s = loaded(enter(at(), 'Two'), { path: 'Two', uidValidity: '7', exists: 230 }, 0, missing);
    expect(lineWith(body(render(s, FMT), WIDE.rows), '(not readable)')).not.toContain('Subject');
    s = keys(s, ...repeat('pagedown', 9));
    const lines = body(render(s, FMT), WIDE.rows);
    lineWith(lines, 'loading...');
    s = act(s, {
      type: 'load-failed',
      generation: s.generation,
      path: 'Two',
      page: 1,
      code: 'folder-unavailable',
    });
    lineWith(body(render(s, FMT), WIDE.rows), "couldn't load");
  });

  it('empty folder → "This folder is empty", cursorLine null', () => {
    const s = loaded(enter(at(), 'Empty'), { path: 'Empty', uidValidity: '7', exists: 0 }, 0, []);
    const out = render(s, FMT);
    lineWith(body(out, WIDE.rows), 'This folder is empty');
    expect(out.cursorLine).toBeNull();
  });

  it('cursorLine: body starts at line 1, follows scrolling', () => {
    const screen = { cols: 80, rows: 24 };
    let s = at(screen);
    expect(render(s, FMT).cursorLine).toBe(1);
    s = keys(s, 'down', 'down');
    const out = render(s, FMT);
    expect(out.cursorLine).toBe(3);
    expect(out.lines[3]).toContain('Empty/');

    let mails = inbox(screen);
    mails = keys(mails, ...repeat('down', 30));
    const out2 = render(mails, FMT);
    expect(out2.cursorLine).toBe(1 + mails.cursor - mails.scrollTop);
    expect(out2.lines[out2.cursorLine ?? 0]).toContain('Subject 420');
    expect(out2.lines[1]).toContain(`Subject ${450 - mails.scrollTop}`);
  });
});

describe('render: status line', () => {
  function twoMarked(): BrowserState {
    const rows = rowsOf(450, 0, (seq) =>
      mail(seq, { bytes: seq === 450 ? 1000 : seq === 449 ? 536 : 1 }),
    );
    return keys(inbox(WIDE, rows), 'space', 'down', 'space');
  }

  function status(s: BrowserState): string {
    return render(s, FMT).lines[s.screen.rows - 2] ?? '';
  }

  it('browse: marked count and size', () => {
    expect(status(twoMarked())).toContain(`marked: 2 mails, ${formatBytes(1536)}`);
    expect(status(at())).toContain('marked: 0 mails');
  });

  it('browse: the message text and the marked count', () => {
    const s = act(twoMarked(), { type: 'notice', text: 'Saved the list' });
    const line = status(s);
    expect(line).toContain('Saved the list');
    expect(line).toContain('marked: 2 mails');
    const hint = keys(at(), 'space');
    expect(status(hint)).toContain(statusText({ code: 'only-mails' }));
  });

  it('confirm-quit', () => {
    expect(status(keys(twoMarked(), 'quit'))).toContain('Quit and drop 2 marks? (y/N)');
  });

  it('reconnect-ask and reconnecting', () => {
    const s = twoMarked();
    const asked = act(s, {
      type: 'load-failed',
      generation: s.generation,
      path: 'INBOX',
      page: 0,
      code: 'connection-lost',
    });
    expect(asked.mode).toBe('reconnect-ask');
    expect(status(asked)).toContain('Connection closed - reconnect? (y/N)');
    expect(status(keys(asked, 'yes'))).toContain('Reconnecting...');
  });
});

describe('render: window too small', () => {
  it.each<Screen>([
    { cols: 39, rows: 8 },
    { cols: 40, rows: 7 },
    { cols: 39, rows: 7 },
  ])('%o → "Window too small", cursorLine null', (screen) => {
    // Built at a usable size, then shrunk: keys don't act while the window is too small.
    for (const s of [at(screen), act(inbox(), { type: 'resize', screen })]) {
      const out = render(s, FMT);
      checkScreen(out, screen);
      expect(lineWith(out.lines, 'Window too small')).toContain('need at least 40x8');
      expect(out.cursorLine).toBeNull();
    }
  });

  it.each<Screen>([
    { cols: 10, rows: 3 },
    { cols: 5, rows: 1 },
    { cols: 1, rows: 2 },
  ])('%o → still exactly rows lines within cols', (screen) => {
    const out = render(act(inbox(), { type: 'resize', screen }), FMT);
    checkScreen(out, screen);
    expect(out.cursorLine).toBeNull();
  });

  it('MIN_COLS 40, MIN_ROWS 8 is enough', () => {
    expect(MIN_COLS).toBe(40);
    expect(MIN_ROWS).toBe(8);
    const out = render(inbox({ cols: 40, rows: 8 }), FMT);
    expect(out.lines.some((l) => l.includes('Window too small'))).toBe(false);
    expect(out.cursorLine).toBe(1);
  });
});

describe('statusText', () => {
  const codes: StatusMessage[] = [
    { code: 'only-mails' },
    { code: 'folder-changed' },
    { code: 'folder-unavailable' },
    { code: 'page-failed' },
    { code: 'offline' },
    { code: 'marks-cleared', count: 3 },
  ];

  it('plain, distinct words for every code', () => {
    const texts = codes.map((m) => statusText(m));
    for (const t of texts) {
      expect(t.trim().length).toBeGreaterThan(5);
      expect(controlChars(t)).toEqual([]);
    }
    expect(new Set(texts).size).toBe(texts.length);
  });

  it('marks-cleared includes the count', () => {
    expect(statusText({ code: 'marks-cleared', count: 3 })).toContain('3');
    expect(statusText({ code: 'marks-cleared', count: 12 })).toContain('12');
  });

  it('text is sanitised', () => {
    const text = '\x1b[31mhi\u202E there\u200B\x07';
    expect(statusText({ code: 'text', text })).toBe(sanitize(text));
    expect(statusText({ code: 'text', text: 'Plain words.' })).toBe('Plain words.');
  });
});

// --- review fixes (independent review of M2b-1) -----------------------------------------------

describe('review fixes: width of Indic and supplementary wide scripts', () => {
  it.each<[string, string, number]>([
    // Devanagari: the spacing vowel signs (Mc) count 1 each, the virama (Mn) 0 — like wcwidth.
    ['Devanagari word', '\u0939\u093f\u0928\u094d\u0926\u0940', 5],
    ['spacing marks only', '\u0903'.repeat(10), 10],
    ['Tangut', '\u{17000}'.repeat(3), 6],
    ['Kana Supplement', '\u{1B000}', 2],
    ['non-spacing mark on a base', 'e\u0301', 1],
  ])('%s', (_label, text, width) => {
    expect(displayWidth(text)).toBe(width);
  });

  it('a hostile subject of spacing marks never widens a mail row', () => {
    const rows = rowsOf(450, 0, (seq) => mail(seq, { subject: '\u0903'.repeat(500) }));
    for (const screen of [
      { cols: 40, rows: 8 },
      { cols: 80, rows: 24 },
    ]) {
      checkScreen(render(inbox(screen, rows), FMT), screen);
    }
  });
});

describe('review fixes: status line keeps the question and the message whole', () => {
  const MESSAGES: StatusMessage[] = [
    { code: 'only-mails' },
    { code: 'folder-changed' },
    { code: 'folder-unavailable' },
    { code: 'page-failed' },
    { code: 'offline' },
    { code: 'marks-cleared', count: 12 },
  ];

  it.each(MESSAGES)('%j fits whole at 80 columns', (message) => {
    expect(displayWidth(statusText(message))).toBeLessThanOrEqual(80);
  });

  it('a message drops "marked:" rather than being cut', () => {
    const rows = rowsOf(450, 0, (seq) => mail(seq, { bytes: 360_000_000 }));
    const marked = keys(inbox({ cols: 80, rows: 24 }, rows), 'mark-screen');
    expect(render(marked, FMT).lines[22]).toContain('marked: 21 mails');
    const text = statusText({ code: 'folder-unavailable' });
    const line = render(act(marked, { type: 'notice', text }), FMT).lines[22] ?? '';
    expect(line).toContain(text);
    expect(line).not.toContain('...');
  });

  it('the y/N questions are whole at 40 columns with many marks', () => {
    const screen = { cols: 40, rows: 8 };
    const rows = rowsOf(450, 0, (seq) => mail(seq, { bytes: 360_000_000 }));
    const marked = keys(inbox(screen, rows), 'mark-screen');
    const quit = render(keys(marked, 'quit'), FMT).lines[6] ?? '';
    expect(quit).toContain('(y/N)');
    const asked = act(marked, {
      type: 'load-failed',
      generation: marked.generation,
      path: 'INBOX',
      page: 1,
      code: 'connection-lost',
    });
    expect(asked.mode).toBe('reconnect-ask');
    expect(render(asked, FMT).lines[6]).toContain('Connection closed - reconnect? (y/N)');
  });
});

describe('review fixes: a screen size that is not a number', () => {
  it.each<Screen>([
    { rows: Number.NaN, cols: Number.NaN },
    { rows: Number.POSITIVE_INFINITY, cols: 80 },
    { rows: -5, cols: 80 },
  ])('%j \u2192 treated as 0 (no lines, no NaN state)', (screen) => {
    const s = initialState('Test account', TREE, screen);
    expect(Number.isFinite(s.screen.rows) && Number.isFinite(s.screen.cols)).toBe(true);
    expect(render(s, FMT)).toEqual({ lines: [], cursorLine: null });
    const resized = act(at(), { type: 'resize', screen });
    expect(Number.isFinite(resized.scrollTop)).toBe(true);
    expect(render(resized, FMT).lines).toEqual([]);
  });
});

describe('review fixes: keys while the window is too small', () => {
  it('only quit acts: no marking or moving what is not shown', () => {
    const small = act(inbox(), { type: 'resize', screen: { cols: 39, rows: 8 } });
    for (const key of ['space', 'mark-screen', 'down', 'pagedown', 'enter', 'back'] as const) {
      const r = reduce(small, { type: 'key', key });
      expect(r.state).toEqual(small);
      expect(r.effects).toEqual([]);
    }
    expect(reduce(small, { type: 'key', key: 'quit' }).effects).toEqual([{ type: 'quit' }]);
  });
});

describe('ASCII screen text (no ambiguous-width glyphs)', () => {
  it('the fixed UI text is plain ASCII at every size', () => {
    for (const screen of [
      { cols: 40, rows: 8 },
      { cols: 80, rows: 24 },
      { cols: 39, rows: 8 },
    ]) {
      const rows = rowsOf(450, 0, (seq) =>
        mail(seq, { from: 'a', subject: 'b'.repeat(300), received: null, bytes: null }),
      );
      const small = act(inbox(), { type: 'resize', screen });
      for (const out of [
        render(small, FMT),
        render(act(inbox(WIDE, rows), { type: 'resize', screen }), FMT),
      ]) {
        for (const line of out.lines) expect(line).toMatch(/^[\x20-\x7e]*$/);
      }
    }
    const asked = keys(keys(inbox(), 'space'), 'quit');
    for (const line of render(asked, FMT).lines) expect(line).toMatch(/^[\x20-\x7e]*$/);
  });

  it.each<Screen>([
    { cols: 40, rows: 8 },
    { cols: 80, rows: 24 },
  ])('root, loading, reconnect and offline screens are plain ASCII at %o', (screen) => {
    // 'Two' has 230 mails: the cursor moves onto page 1 (seq 30…1), which starts loading.
    const two = loaded(
      enter(at(), 'Two'),
      { path: 'Two', uidValidity: '7', exists: 230 },
      0,
      rowsOf(230, 0),
    );
    const paging = keys(two, ...repeat('pagedown', 9));
    expect(paging.view?.loading).toBe(1);
    const asked = act(paging, {
      type: 'load-failed',
      generation: paging.generation,
      path: 'Two',
      page: 1,
      code: 'connection-lost',
    });
    const sized = (s: BrowserState): BrowserState => act(s, { type: 'resize', screen });
    const cases: [string, BrowserState, string | RegExp][] = [
      ['root', keys(at(screen), ...repeat('down', 6)), /Unknown\/ +- +- *$/m],
      ['opening', enter(at(screen), 'Two'), 'Loading...'],
      ['page loading', sized(paging), 'loading...'],
      ['reconnect-ask', sized(asked), 'Connection closed - reconnect? (y/N)'],
      ['reconnecting', sized(keys(asked, 'yes')), 'Reconnecting...'],
      ['offline', sized(keys(asked, 'no')), 'not loaded (offline)'],
    ];
    for (const [name, state, shown] of cases) {
      const out = render(state, FMT);
      expect(out.lines.join('\n'), name).toMatch(shown);
      for (const line of out.lines) expect(line, name).toMatch(/^[\x20-\x7e]*$/);
    }
  });

  it.each<StatusMessage>([
    { code: 'only-mails' },
    { code: 'folder-changed' },
    { code: 'folder-busy' },
    { code: 'folder-unavailable' },
    { code: 'page-failed' },
    { code: 'offline' },
    { code: 'marks-cleared', count: 2 },
  ])('statusText %j is ASCII', (message) => {
    expect(statusText(message)).toMatch(/^[\x20-\x7e]*$/);
  });
});

// --- M2b-2: reconnect texts, offline, --no-size, sender width, short too-small, emoji width ----

describe('M2b-2: emoji graphemes with joined non-emoji characters', () => {
  it.each<[string, string, number]>([
    ['emoji + 400 spacing marks', '\u{1F600}' + 'ः'.repeat(400), 402],
    ['emoji + 5 halfwidth voiced marks (extender)', '\u{1F600}' + 'ﾞ'.repeat(5), 7],
    ['3 Prepend characters + emoji', 'ൎ'.repeat(3) + '\u{1F600}', 5],
    ['heavy heart + VS16', '❤️', 2],
    ['ZWJ family of four', '\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}', 2],
    ['keycap 1', '1️⃣', 2],
    ['flag SK', '\u{1F1F8}\u{1F1F0}', 2],
    ['thumbs up + skin tone', '\u{1F44D}\u{1F3FD}', 2],
    ['grinning face', '\u{1F600}', 2],
  ])('%s', (_label, text, width) => {
    expect(displayWidth(text)).toBe(width);
  });

  it.each<[string, string]>([
    ['spacing marks', '\u{1F600}' + 'ः'.repeat(400)],
    ['extenders', '\u{1F600}' + 'ﾞ'.repeat(50)],
    ['Prepend', 'ൎ'.repeat(50) + '\u{1F600}'],
  ])('fit keeps an emoji + %s grapheme within 40 columns', (_label, text) => {
    expect(displayWidth(fit(text, 40))).toBe(40);
    expect(displayWidth(fit(`ab ${text} cd`, 40))).toBe(40);
  });

  it('a hostile emoji subject never widens a mail row', () => {
    const subject = '\u{1F600}' + 'ﾞ'.repeat(50);
    const rows = rowsOf(450, 0, (seq) => mail(seq, { from: subject, subject }));
    for (const screen of [
      { cols: 40, rows: 8 },
      { cols: 80, rows: 24 },
    ]) {
      checkScreen(render(inbox(screen, rows), FMT), screen);
    }
  });
});

describe('M2b-2: reconnect and offline texts', () => {
  function status(s: BrowserState): string {
    return render(s, FMT).lines[s.screen.rows - 2] ?? '';
  }

  function asked(): BrowserState {
    const s = inbox();
    return act(s, {
      type: 'load-failed',
      generation: s.generation,
      path: 'INBOX',
      page: 0,
      code: 'connection-lost',
    });
  }

  it('reconnecting shows a notice text when set, else Reconnecting...', () => {
    const reconnecting = keys(asked(), 'yes');
    expect(status(reconnecting)).toContain('Reconnecting...');
    const notice = CHALLENGE_NOTICE;
    const waiting = act(reconnecting, { type: 'notice', text: notice });
    expect(waiting.mode).toBe('reconnecting');
    expect(status(waiting)).toContain(notice);
    expect(status(waiting)).not.toContain('Reconnecting...');
  });

  it('the challenge notice is exactly the short text and stays whole at 80x24 with marks', () => {
    expect(CHALLENGE_NOTICE).toBe(
      'Several wrong passwords - waiting 5 seconds before trying again.',
    );
    expect(CHALLENGE_NOTICE).toMatch(/^[\x20-\x7e]+$/);
    const screen = { cols: 80, rows: 24 };
    const rows = rowsOf(450, 0, (seq) => mail(seq, { bytes: 360_000_000 }));
    let s = keys(inbox(screen, rows), 'mark-screen');
    s = act(s, {
      type: 'load-failed',
      generation: s.generation,
      path: 'INBOX',
      page: 1,
      code: 'connection-lost',
    });
    s = act(keys(s, 'yes'), { type: 'notice', text: CHALLENGE_NOTICE });
    const out = render(s, FMT);
    checkScreen(out, screen);
    const line = out.lines[screen.rows - 2] ?? '';
    expect(line.startsWith(CHALLENGE_NOTICE)).toBe(true);
    expect(line).not.toContain('...');
  });

  it('offline status names the r key', () => {
    expect(statusText({ code: 'offline' })).toBe(
      'Offline - showing what is loaded (r = reconnect).',
    );
    const offline = keys(asked(), 'no');
    expect(status(offline)).toContain('Offline - showing what is loaded (r = reconnect).');
    // Still shown once the message is gone (any key clears it).
    expect(status(keys(offline, 'other'))).toContain('(r = reconnect)');
  });

  it('an opened folder with no mails loaded: "not loaded (offline)" offline, blank online', () => {
    const opening = enter(at(), 'Empty');
    expect(body(render(opening, FMT), WIDE.rows).every((l) => l.trim() === '')).toBe(true);
    const lost = act(opening, {
      type: 'load-failed',
      generation: opening.generation,
      path: 'Empty',
      page: 0,
      code: 'connection-lost',
    });
    const offline = keys(lost, 'no');
    expect(offline.path).toBe('Empty');
    expect(offline.view?.snapshot ?? null).toBeNull();
    const out = render(offline, FMT);
    lineWith(body(out, WIDE.rows), 'not loaded (offline)');
    expect(out.cursorLine).toBeNull();
    for (const line of out.lines) expect(line).toMatch(/^[\x20-\x7e]*$/);
  });
});

describe('M2b-2: sizes: false (--no-size)', () => {
  it('folder rows have no size cell; the count stays', () => {
    const lines = body(render(at(), { ...FMT, sizes: false }), WIDE.rows);
    const server = lineWith(lines, 'Server/');
    expect(server).toMatch(/Server\/ +12 *$/);
    expect(server).not.toContain(formatBytes(1536));
    expect(lineWith(lines, 'Sum/')).not.toContain('~');
    expect(lineWith(lines, 'INBOX/')).not.toContain(formatBytes(2048));
    expect(lineWith(lines, 'Unknown/')).toMatch(/Unknown\/ +- *$/);
  });

  it('default (and sizes: true) keeps the size cell', () => {
    for (const opts of [FMT, { ...FMT, sizes: true }]) {
      expect(lineWith(body(render(at(), opts), WIDE.rows), 'Server/')).toContain(formatBytes(1536));
    }
  });

  it('mail rows still show their size', () => {
    const rows = [mail(1, { from: 'Alice', bytes: 1536 })];
    const s = loaded(enter(at(), 'INBOX'), { path: 'INBOX', uidValidity: '7', exists: 1 }, 0, rows);
    expect(lineWith(body(render(s, { ...FMT, sizes: false }), WIDE.rows), 'Alice')).toContain(
      formatBytes(1536),
    );
  });
});

describe('M2b-2: sender column at least 8 wide', () => {
  const screen = { cols: 40, rows: 8 };

  it('an 8-character sender stays whole at 40 columns; the subject shrinks', () => {
    const rows = rowsOf(450, 0, (seq) => mail(seq, { from: 'Abcdefgh', subject: 'Subject' }));
    const out = render(inbox(screen, rows), FMT);
    checkScreen(out, screen);
    const line = lineWith(body(out, screen.rows), 'Abcdefgh');
    expect(line).toMatch(/^\[ \] 2026-01-02 {2}Abcdefgh /);
    expect(displayWidth(line)).toBe(40);
  });

  it('a longer sender is cut to 8 columns at 40 columns', () => {
    const rows = rowsOf(450, 0, (seq) => mail(seq, { from: 'Abcdefghijkl' }));
    const line = body(render(inbox(screen, rows), FMT), screen.rows)[0] ?? '';
    expect(line).toMatch(/^\[ \] 2026-01-02 {2}Abcde\.\.\. /);
  });
});

describe('M2b-2: short too-small text', () => {
  const LONG = 'Window too small - need at least 40x8';
  const SHORT = 'Too small - need 40x8';

  it.each(Array.from({ length: 16 }, (_, i) => 21 + i))('%i columns → the short text', (cols) => {
    const screen = { cols, rows: 8 };
    const out = render(act(inbox(), { type: 'resize', screen }), FMT);
    checkScreen(out, screen);
    expect(lineWith(out.lines, SHORT)).not.toContain('Window');
    expect(lineWith(out.lines, SHORT)).not.toContain('...');
    for (const line of out.lines) expect(line).toMatch(/^[\x20-\x7e]*$/);
  });

  it.each([37, 38, 39])('%i columns → the long text, whole', (cols) => {
    const screen = { cols, rows: 8 };
    const out = render(act(inbox(), { type: 'resize', screen }), FMT);
    checkScreen(out, screen);
    lineWith(out.lines, LONG);
  });

  it('below 21 columns the short text is cut but every line still fits', () => {
    for (const cols of [1, 10, 20]) {
      const screen = { cols, rows: 8 };
      checkScreen(render(act(inbox(), { type: 'resize', screen }), FMT), screen);
    }
  });
});

// --- fix round 1: the pending question while too small; offline placeholder after subfolders --

describe('too small with a pending question', () => {
  const SMALLS: Screen[] = [
    { cols: 30, rows: 5 },
    { cols: 21, rows: 1 },
  ];

  function marked(n: number): BrowserState {
    return keys(inbox(), ...Array.from({ length: n }, () => ['space', 'down'] as const).flat());
  }

  function lost(s: BrowserState): BrowserState {
    return act(s, {
      type: 'load-failed',
      generation: s.generation,
      path: 'INBOX',
      page: 0,
      code: 'connection-lost',
    });
  }

  function small(s: BrowserState, screen: Screen): BrowserState {
    return act(s, { type: 'resize', screen });
  }

  function questionLines(out: Rendered): string[] {
    return out.lines.map((l) => l.trim()).filter((l) => l !== '');
  }

  it.each(SMALLS)('confirm-quit at %o: "Drop N marks? (y/N)" is shown', (screen) => {
    for (const [n, text] of [
      [1, 'Drop 1 mark? (y/N)'],
      [2, 'Drop 2 marks? (y/N)'],
    ] as const) {
      const s = keys(small(marked(n), screen), 'quit');
      expect(s.mode).toBe('confirm-quit');
      const out = render(s, FMT);
      checkScreen(out, screen);
      // The question is on screen whole (lineWith throws when no line has it).
      expect(lineWith(out.lines, text).trim()).toBe(text);
      expect(out.cursorLine).toBeNull();
      for (const line of out.lines) expect(line).toMatch(/^[\x20-\x7e]*$/);
    }
  });

  it.each(SMALLS)('reconnect-ask at %o: "Reconnect? (y/N)" is shown', (screen) => {
    const s = small(lost(inbox()), screen);
    expect(s.mode).toBe('reconnect-ask');
    const out = render(s, FMT);
    checkScreen(out, screen);
    lineWith(out.lines, 'Reconnect? (y/N)');
  });

  it.each(SMALLS)('reconnecting at %o: "Reconnecting..." is shown', (screen) => {
    const s = small(keys(lost(inbox()), 'yes'), screen);
    expect(s.mode).toBe('reconnecting');
    const out = render(s, FMT);
    checkScreen(out, screen);
    lineWith(out.lines, 'Reconnecting...');
  });

  it('30x5: the too-small text, the question on the next line, both centred', () => {
    const screen = { cols: 30, rows: 5 };
    const out = render(keys(small(marked(2), screen), 'quit'), FMT);
    expect(out.lines[2]).toBe(centredLine('Too small - need 40x8', 30));
    expect(out.lines[3]).toBe(centredLine('Drop 2 marks? (y/N)', 30));
    expect(questionLines(out)).toHaveLength(2);
  });

  it('one row: the question replaces the too-small text', () => {
    const screen = { cols: 21, rows: 1 };
    const out = render(keys(small(marked(1), screen), 'quit'), FMT);
    expect(out.lines).toEqual([centredLine('Drop 1 mark? (y/N)', 21)]);
  });

  it('browse: only the too-small text, no question', () => {
    const screen = { cols: 30, rows: 5 };
    const out = render(small(marked(1), screen), FMT);
    expect(questionLines(out)).toEqual(['Too small - need 40x8']);
  });

  it('never wider than the screen, even when the question must be cut', () => {
    for (const screen of [
      { cols: 10, rows: 1 },
      { cols: 5, rows: 2 },
      { cols: 1, rows: 3 },
    ]) {
      for (const s of [
        keys(small(marked(2), screen), 'quit'),
        small(lost(inbox()), screen),
        small(keys(lost(inbox()), 'yes'), screen),
      ]) {
        checkScreen(render(s, FMT), screen);
      }
    }
  });

  it('walk: mark, 30x5, q shows the question, q again cancels it, q + y quits', () => {
    const screen = { cols: 30, rows: 5 };
    let s = small(marked(1), screen);
    s = keys(s, 'quit');
    lineWith(render(s, FMT).lines, 'Drop 1 mark? (y/N)');
    s = keys(s, 'quit');
    expect(s.mode).toBe('browse');
    expect(render(s, FMT).lines.join('\n')).not.toContain('(y/N)');
    s = keys(s, 'quit');
    lineWith(render(s, FMT).lines, 'Drop 1 mark? (y/N)');
    expect(reduce(s, { type: 'key', key: 'yes' }).effects).toEqual([{ type: 'quit' }]);
  });

  it('walk: the connection drops while too small, the question is shown, n goes offline', () => {
    const screen = { cols: 30, rows: 5 };
    const s = lost(small(inbox(), screen));
    lineWith(render(s, FMT).lines, 'Reconnect? (y/N)');
    const offline = keys(s, 'no');
    expect(offline.offline).toBe(true);
    expect(render(offline, FMT).lines.join('\n')).not.toContain('(y/N)');
  });
});

function centredLine(text: string, cols: number): string {
  return fit(' '.repeat(Math.max(0, Math.floor((cols - displayWidth(text)) / 2))) + text, cols);
}

describe('offline: "not loaded (offline)" after the subfolders of an opened folder', () => {
  function tree(children: number): FolderInfo[] {
    return [
      folder('INBOX', { messages: 5 }),
      ...Array.from({ length: children }, (_, i) => folder(`INBOX/Sub${String(i + 1)}`)),
    ];
  }

  /** INBOX/Sub1 opened, its load lost, N, Left: back in INBOX, offline, nothing loaded. */
  function backOffline(children: number, screen: Screen = WIDE): BrowserState {
    let s = initialState('Test account', tree(children), screen);
    s = enter(s, 'INBOX');
    s = enter(s, 'INBOX/Sub1');
    s = act(s, {
      type: 'load-failed',
      generation: s.generation,
      path: 'INBOX/Sub1',
      page: 0,
      code: 'connection-lost',
    });
    s = keys(s, 'no', 'back');
    expect(s.path).toBe('INBOX');
    expect(s.offline).toBe(true);
    expect(s.view?.snapshot ?? null).toBeNull();
    return s;
  }

  it('the line follows the last subfolder row', () => {
    const out = render(backOffline(1), FMT);
    const lines = body(out, WIDE.rows);
    expect(lines[0]).toContain('Sub1/');
    expect(lines[1]).toBe(fit('    not loaded (offline)', WIDE.cols));
    expect(out.lines[0]).toContain('5 mails');
    expect(out.cursorLine).toBe(1);
  });

  it('online (mails loading) there is no such line', () => {
    let s = initialState('Test account', tree(1), WIDE);
    s = enter(s, 'INBOX');
    expect(render(s, FMT).lines.join('\n')).not.toContain('not loaded');
  });

  it('only when it fits below the rows: a full body has no room for it', () => {
    const screen = { cols: 40, rows: 8 }; // body height 5
    const fits = render(backOffline(4, screen), FMT);
    checkScreen(fits, screen);
    expect(body(fits, screen.rows)[4]).toContain('not loaded (offline)');
    const full = backOffline(5, screen);
    const out = render(keys(full, ...repeat('down', 5)), FMT);
    checkScreen(out, screen);
    expect(out.lines.join('\n')).not.toContain('not loaded');
  });
});

// --- M2-fix: a chain of skin-tone modifiers cannot widen a row ---------------------------------

describe('M2-fix: skin-tone modifiers in displayWidth and fit', () => {
  const T = '\u{1F3FD}';
  const THUMB = '\u{1F44D}';

  it.each<[string, string, number]>([
    ['emoji + 400 spacing marks', '\u{1F600}' + 'ः'.repeat(400), 402],
    ['emoji + 5 halfwidth voiced marks', '\u{1F600}' + 'ﾞ'.repeat(5), 7],
    ['3 Prepend characters + emoji', 'ൎ'.repeat(3) + '\u{1F600}', 5],
    ['heavy heart + VS16', '❤\ufe0f', 2],
    ['ZWJ family of four', '\u{1F468}\u200d\u{1F469}\u200d\u{1F467}\u200d\u{1F466}', 2],
    ['keycap 1', '1\ufe0f\u20e3', 2],
    ['flag SK', '\u{1F1F8}\u{1F1F0}', 2],
    ['thumbs up + tone', THUMB + T, 2],
    ['grinning face', '\u{1F600}', 2],
    ['three waving hands, each with a tone', ('\u{1F44B}' + T).repeat(3), 6],
    [
      'ZWJ handshake sequence with tones',
      '\u{1F9D1}' + T + '\u200d\u{1F91D}\u200d\u{1F9D1}\u{1F3FB}',
      2,
    ],
  ])('unchanged: %s', (_label, text, width) => {
    expect(displayWidth(text)).toBe(width);
  });

  it.each<[string, string, number]>([
    ['"a" + 60 tones', 'a' + T.repeat(60), 123],
    ['thumbs up + 60 tones', THUMB + T.repeat(60), 120],
    ['60 x ("1" + tone)', ('1' + T).repeat(60), 240],
    ['thumbs up + 2 tones', THUMB + T + T, 4],
    ['thumbs up + VS16 + tone', THUMB + '\ufe0f' + T, 4],
    ['a lone tone', T, 4],
    ['grinning face + tone', '\u{1F600}' + T, 4],
    ['CJK + tone', '日' + T, 6],
  ])('new: %s', (_label, text, width) => {
    expect(displayWidth(text)).toBe(width);
  });

  it.each<[string, string]>([
    ['"a" + 60 tones', 'a' + T.repeat(60)],
    ['thumbs up + 60 tones', THUMB + T.repeat(60)],
  ])('fit(%s, 8) cuts the grapheme: no modifier is left', (_label, text) => {
    expect(fit(text, 8)).toBe('...     ');
    expect(fit(text, 8)).not.toContain(T);
  });

  it('a valid tone sequence is still kept whole by fit', () => {
    expect(fit(THUMB + T, 2)).toBe(THUMB + T);
    expect(fit(THUMB + T, 4)).toBe(THUMB + T + '  ');
  });

  it('a chain of tones after text never exceeds the width fit was asked for', () => {
    for (const text of ['a' + T.repeat(60), THUMB + T.repeat(60), 'x '.repeat(5) + T.repeat(30)]) {
      for (let w = 0; w <= 20; w++) {
        expect(displayWidth(fit(text, w)), `fit(${JSON.stringify(text)}, ${w})`).toBe(w);
      }
    }
  });
});

describe('M2-fix: a mail with a skin-tone chain never widens a row', () => {
  const T = '\u{1F3FD}';
  const from = 'a' + T.repeat(60);
  const subject = '\u{1F44D}' + T.repeat(60);

  it('80x12: no line holds a modifier and every line measures at most 80', () => {
    const screen: Screen = { cols: 80, rows: 12 };
    const rows = rowsOf(450, 0, (seq) => mail(seq, { from, subject }));
    const out = render(inbox(screen, rows), FMT);
    checkScreen(out, screen);
    expect(out.lines.filter((l) => l.includes(T))).toEqual([]);
    // The mail rows are really there (their date column), not an empty body.
    expect(body(out, screen.rows).filter((l) => l.includes('2026-01-02')).length).toBeGreaterThan(
      0,
    );
  });

  it('40x8: no modifier survives; 200x30: every line still measures at most 200', () => {
    const rows = rowsOf(450, 0, (seq) => mail(seq, { from, subject }));
    const narrow: Screen = { cols: 40, rows: 8 };
    const small = render(inbox(narrow, rows), FMT);
    checkScreen(small, narrow);
    expect(small.lines.filter((l) => l.includes(T))).toEqual([]);
    // Room for the 120-column subject at 200 columns: it may stay whole, but never overflow.
    const wide: Screen = { cols: 200, rows: 30 };
    checkScreen(render(inbox(wide, rows), FMT), wide);
  });
});

// --- wide symbols outside the CJK blocks (C-029) ----------------------------------------------

describe('displayWidth: East Asian Wide symbols outside the CJK blocks take two columns', () => {
  it.each<[string, string, number]>([
    ['left-pointing angle bracket U+2329', '\u2329', 2],
    ['right-pointing angle bracket U+232A', '\u232a', 2],
    ['Yijing hexagram U+4DC0', '\u4dc0', 2],
    ['Yijing hexagram U+4DFF', '\u4dff', 2],
    ['vertical form U+FE10', '\ufe10', 2],
    ['vertical form U+FE19', '\ufe19', 2],
    ['small comma U+FE50', '\ufe50', 2],
    ['small full stop U+FE52', '\ufe52', 2],
    ['small semicolon U+FE54', '\ufe54', 2],
    ['small equals sign U+FE66', '\ufe66', 2],
    ['small reverse solidus U+FE68', '\ufe68', 2],
    ['small commercial at U+FE6B', '\ufe6b', 2],
    ['trigram for heaven U+2630 (wide since Unicode 16)', '\u2630', 2],
    ['trigram for earth U+2637', '\u2637', 2],
    ['monogram for yang U+268A', '\u268a', 2],
    ['digram for greater yin U+268F', '\u268f', 2],
    ['Tai Xuan Jing monogram U+1D300', '\u{1d300}', 2],
    ['Tai Xuan Jing tetragram U+1D356', '\u{1d356}', 2],
    ['counting rod U+1D360', '\u{1d360}', 2],
    ['ideographic tally mark U+1D376', '\u{1d376}', 2],
    ['70 small commas', '\ufe50'.repeat(70), 140],
  ])('%s', (_label, text, width) => {
    expect(displayWidth(text)).toBe(width);
  });

  it.each<[string, string, number]>([
    ['keyboard U+2328, before the angle brackets', '\u2328', 1],
    ['erase to the left U+232B, after them', '\u232b', 1],
    ['ideographic half fill space U+303F', '\u303f', 1],
    ['wheel of dharma U+2638, after the trigrams', '\u2638', 1],
    ['white flag U+2690, after the digrams', '\u2690', 1],
    ['tally mark U+1D377, after the counting rods', '\u{1d377}', 1],
    ['U+FE1A, after the vertical forms', '\ufe1a', 1],
    ['combining half mark U+FE20', 'a\ufe20', 1],
    ['Arabic presentation form U+FE70, after the small forms', '\ufe70', 1],
  ])('a narrow neighbour stays as it was: %s', (_label, text, width) => {
    expect(displayWidth(text)).toBe(width);
  });

  it('fit cuts a run of small commas to the width: 38 of them, "...", one space', () => {
    const out = fit('\ufe50'.repeat(70), 80);
    expect(out).toBe(`${'\ufe50'.repeat(38)}... `);
    expect(displayWidth(out)).toBe(80);
  });

  it('80x12: a subject of 70 small commas keeps every line within 80 terminal columns', () => {
    const screen: Screen = { cols: 80, rows: 12 };
    const rows = rowsOf(450, 0, (seq) => mail(seq, { from: 'Ann', subject: '\ufe50'.repeat(70) }));
    const out = render(inbox(screen, rows), FMT);
    checkScreen(out, screen);
    // Counted here, not with displayWidth: the rest of these lines is ASCII (1 column each),
    // a small comma takes 2.
    const commas = (l: string): number => [...l].filter((c) => c === '\ufe50').length;
    expect(Math.max(...out.lines.map(commas))).toBeGreaterThan(0);
    for (const l of out.lines) expect([...l].length + commas(l)).toBeLessThanOrEqual(80);
  });
});
