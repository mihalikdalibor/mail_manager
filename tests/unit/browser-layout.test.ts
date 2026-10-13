import { describe, it, expect } from 'vitest';
import {
  centred,
  columns,
  fitTail,
  helpLine,
  tooSmallFrame,
} from '../../src/cli/browser/layout.js';
import type { HelpItem } from '../../src/cli/browser/layout.js';
import { displayWidth, fit } from '../../src/cli/browser/width.js';

// The layout helpers shared by the folder browser and the app (M2d-1): moved out of render.ts
// (whose own tests pin the browser's output byte for byte), plus fitTail for typed fields.

const ASCII = /^[\x20-\x7e]*$/;
const LONG = 'Window too small - need at least 40x8';
const SHORT = 'Too small - need 40x8';

function shown(lines: readonly string[]): string[] {
  return lines.map((l) => l.trim()).filter((l) => l !== '');
}

describe('columns', () => {
  it('puts the right cell at the end of exactly `cols` columns', () => {
    expect(columns('left', 'right', 20)).toBe(`left${' '.repeat(11)}right`);
    expect(columns('', 'right', 10)).toBe('right'.padStart(10));
  });

  it('cuts the left cell, never the right one', () => {
    const line = columns('a long left cell', '3 mails', 16);
    expect(line).toBe('a lon... 3 mails');
    expect(displayWidth(line)).toBe(16);
  });

  it('drops the right cell when there is no room for it, or when it is empty', () => {
    expect(columns('left', 'right', 6)).toBe('left  ');
    expect(columns('left', '', 8)).toBe('left    ');
    // One column more and the right cell is back; the left one is cut down to what is left.
    expect(columns('left', 'right', 7)).toBe('. right');
  });

  it('measures wide characters', () => {
    const line = columns('日本語のフォルダ', '日本', 12);
    expect(displayWidth(line)).toBe(12);
    expect(line.endsWith(' 日本')).toBe(true);
  });
});

describe('centred', () => {
  it('centres in exactly `cols` columns, the odd column on the right', () => {
    expect(centred('abc', 9)).toBe('   abc   ');
    expect(centred('abc', 8)).toBe('  abc   ');
    expect(centred('日本', 8)).toBe('  日本  ');
  });

  it('cuts a text wider than the line', () => {
    expect(centred('abcdefghij', 6)).toBe('abc...');
    expect(centred('abc', 0)).toBe('');
  });
});

describe('helpLine', () => {
  const ITEMS: readonly HelpItem[] = [
    { text: 'Up/Down move', rank: 0 },
    { text: 'Enter choose', rank: 2 },
    { text: 'f forget', rank: 3 },
    { text: 'q quit', rank: 1 },
  ];
  const ALL = 'Up/Down move  Enter choose  f forget  q quit';

  it('shows every item in the order given, two spaces apart, when they fit', () => {
    expect(helpLine(ITEMS, 60)).toBe(fit(ALL, 60));
    expect(helpLine(ITEMS, ALL.length)).toBe(ALL);
  });

  it('drops the highest rank first as the line gets narrower, keeping the order', () => {
    expect(helpLine(ITEMS, ALL.length - 1).trimEnd()).toBe('Up/Down move  Enter choose  q quit');
    expect(helpLine(ITEMS, 34).trimEnd()).toBe('Up/Down move  Enter choose  q quit');
    expect(helpLine(ITEMS, 29).trimEnd()).toBe('Up/Down move  q quit');
    expect(helpLine(ITEMS, 20).trimEnd()).toBe('Up/Down move  q quit');
    expect(helpLine(ITEMS, 19).trimEnd()).toBe('Up/Down move');
    expect(helpLine(ITEMS, 12)).toBe('Up/Down move');
  });

  it('an item that does not fit is skipped; a later, shorter one may still fit', () => {
    expect(helpLine(ITEMS, 33).trimEnd()).toBe('Up/Down move  f forget  q quit');
    expect(helpLine(ITEMS, 30)).toBe('Up/Down move  f forget  q quit');
    expect(helpLine(ITEMS, 11).trimEnd()).toBe('q quit');
    expect(helpLine(ITEMS, 6)).toBe('q quit');
    expect(helpLine(ITEMS, 5)).toBe('     ');
  });

  it('the rank decides, not the position', () => {
    const items: HelpItem[] = [
      { text: 'last to stay', rank: 5 },
      { text: 'kept', rank: 0 },
    ];
    expect(helpLine(items, 18)).toBe('last to stay  kept');
    expect(helpLine(items, 17).trimEnd()).toBe('kept');
  });

  it('is always exactly `cols` columns wide', () => {
    for (let cols = 0; cols <= 70; cols++) {
      const line = helpLine(ITEMS, cols);
      expect(displayWidth(line)).toBe(cols);
      expect(line).toMatch(ASCII);
    }
  });

  it('no items → an empty line; the items are not reordered in place', () => {
    expect(helpLine([], 10)).toBe(' '.repeat(10));
    const items: HelpItem[] = [
      { text: 'b', rank: 1 },
      { text: 'a', rank: 0 },
    ];
    helpLine(items, 40);
    expect(items.map((i) => i.text)).toEqual(['b', 'a']);
  });
});

describe('tooSmallFrame', () => {
  it.each([
    { rows: 7, cols: 80 },
    { rows: 8, cols: 39 },
    { rows: 5, cols: 30 },
    { rows: 1, cols: 21 },
    { rows: 3, cols: 1 },
    { rows: 2, cols: 5 },
  ])('%o: exactly rows lines of cols columns, no cursor, with and without a question', (screen) => {
    for (const question of [null, 'Forget anna@example-test-domain.eu? (y/N)']) {
      const out = tooSmallFrame(screen.rows, screen.cols, question);
      expect(out.lines).toHaveLength(screen.rows);
      expect(out.cursorLine).toBeNull();
      for (const line of out.lines) {
        expect(displayWidth(line)).toBe(screen.cols);
        expect(line).toMatch(ASCII);
      }
    }
  });

  it('the long text from 37 columns, the short one below', () => {
    expect(shown(tooSmallFrame(8, 39, null).lines)).toEqual([LONG]);
    expect(shown(tooSmallFrame(8, 37, null).lines)).toEqual([LONG]);
    expect(shown(tooSmallFrame(8, 36, null).lines)).toEqual([SHORT]);
    expect(shown(tooSmallFrame(8, 21, null).lines)).toEqual([SHORT]);
  });

  it('without a question: the text alone, centred on the middle line', () => {
    const out = tooSmallFrame(5, 30, null);
    expect(out.lines).toEqual([
      ' '.repeat(30),
      ' '.repeat(30),
      centred(SHORT, 30),
      ' '.repeat(30),
      ' '.repeat(30),
    ]);
    expect(tooSmallFrame(4, 30, null).lines[1]).toBe(centred(SHORT, 30));
  });

  it('with a question: it goes on the line below the text, centred', () => {
    const out = tooSmallFrame(5, 30, 'Sign out first? (y/N)');
    expect(out.lines[2]).toBe(centred(SHORT, 30));
    expect(out.lines[3]).toBe(centred('Sign out first? (y/N)', 30));
    expect(shown(out.lines)).toHaveLength(2);
  });

  it('one row: the question replaces the text', () => {
    expect(tooSmallFrame(1, 30, 'Sign out first? (y/N)').lines).toEqual([
      centred('Sign out first? (y/N)', 30),
    ]);
    expect(tooSmallFrame(1, 30, null).lines).toEqual([centred(SHORT, 30)]);
  });

  it('a question wider than the window is cut, not wrapped', () => {
    const out = tooSmallFrame(3, 12, 'Forget anna@example-test-domain.eu? (y/N)');
    expect(out.lines[2]).toBe('Forget an...');
  });

  it('no rows → no lines', () => {
    expect(tooSmallFrame(0, 30, 'Sign out first? (y/N)').lines).toEqual([]);
  });
});

describe('fitTail', () => {
  it('pads a text that fits, like fit', () => {
    expect(fitTail('anna', 8)).toBe('anna    ');
    expect(fitTail('anna', 4)).toBe('anna');
    expect(fitTail('', 3)).toBe('   ');
    expect(fitTail('日本', 6)).toBe(fit('日本', 6));
  });

  it('keeps the end of a longer text behind a leading "..."', () => {
    expect(fitTail('anna@example-test-domain.eu', 12)).toBe('...domain.eu');
    expect(fitTail('abcdefghij_', 8)).toBe('...ghij_');
    expect(fitTail('abcde', 4)).toBe('...e');
  });

  it('three columns or fewer: only as much of the "..." as fits', () => {
    expect(fitTail('abcdef', 3)).toBe('...');
    expect(fitTail('abcdef', 2)).toBe('..');
    expect(fitTail('abcdef', 1)).toBe('.');
    expect(fitTail('abc', 3)).toBe('abc');
  });

  it.each([0, -1, -40, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'width %d → an empty text',
    (width) => {
      expect(fitTail('anna', width)).toBe('');
    },
  );

  it('a fractional width is rounded down', () => {
    expect(fitTail('abcdefghij', 6.9)).toBe('...hij');
    expect(fitTail('ab', 4.5)).toBe('ab  ');
  });

  it('never cuts a wide character in half: the freed column is padded at the end', () => {
    // 10 columns; at width 8 the room after "..." is 5: two characters (4) and one space.
    expect(fitTail('日本語日本', 8)).toBe('...日本 ');
    expect(fitTail('日本語日本', 9)).toBe('...語日本');
    expect(fitTail('ab日本', 5)).toBe('...本');
    expect(fitTail('日本語', 4)).toBe('... ');
  });

  it('keeps a combining mark with its letter', () => {
    const text = 'e\u0301'.repeat(6);
    expect(fitTail(text, 5)).toBe('...e\u0301e\u0301');
    expect(fitTail(text, 6)).toBe(text);
    // A cut never starts on a bare mark.
    expect(fitTail(`abcd${text}`, 8)).toBe(`...${'e\u0301'.repeat(5)}`);
  });

  it('keeps an emoji sequence whole or drops it whole', () => {
    const family = '👨\u200D👩\u200D👧';
    expect(fitTail(`abcdef${family}`, 6)).toBe(`...f${family}`);
    expect(fitTail(`abcdef${family}`, 5)).toBe(`...${family}`);
    expect(fitTail(`abcdef${family}xy`, 4)).toBe('...y');
    expect(fitTail(`${family}abcdef`, 7)).toBe('...cdef');
  });

  it('is exactly `width` columns wide for every width and text', () => {
    const texts = [
      '',
      'a',
      'anna@example-test-domain.eu_',
      '日本語のアドレス@example.test',
      'mixed 日本 😀 e\u0301 text',
      'e\u0301e\u0301e\u0301e\u0301',
      '😀😀😀😀😀',
      '👍🏽👍🏽 ok',
    ];
    for (const text of texts) {
      for (let width = 1; width <= 40; width++) {
        const out = fitTail(text, width);
        expect(displayWidth(out)).toBe(width);
        if (displayWidth(text) <= width) expect(out).toBe(fit(text, width));
        else expect(out.startsWith('...'.slice(0, width))).toBe(true);
      }
    }
  });

  it('the kept end is a suffix of the text', () => {
    const text = 'someone.with.a.long.name@example-test-domain.eu_';
    for (let width = 4; width < text.length; width++) {
      const out = fitTail(text, width);
      expect(text.endsWith(out.slice(3))).toBe(true);
      expect(out).toHaveLength(width);
    }
  });
});
