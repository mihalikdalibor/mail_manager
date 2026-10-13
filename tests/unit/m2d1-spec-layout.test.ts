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

// M2d-1 layout helpers (moved out of the folder browser's renderer, same behaviour, plus the new
// fitTail). Spec: the interface and the behaviour the browser tests already pin.

const LONG = 'Window too small - need at least 40x8';
const SHORT = 'Too small - need 40x8';

function centredLine(text: string, cols: number): string {
  return fit(' '.repeat(Math.max(0, Math.floor((cols - displayWidth(text)) / 2))) + text, cols);
}

describe('columns', () => {
  it('left and right in exactly `cols` columns, right aligned', () => {
    const line = columns('abc', 'xyz', 20);
    expect(displayWidth(line)).toBe(20);
    expect(line.startsWith('abc')).toBe(true);
    expect(line.endsWith('xyz')).toBe(true);
  });

  it('a long left is cut with "..." so the right still fits, one space between', () => {
    expect(columns('abcdefghijklmnop', 'xyz', 12)).toBe('abcde... xyz');
  });

  it('an empty right gives the left fitted to `cols`', () => {
    expect(columns('abc', '', 8)).toBe('abc     ');
  });

  it('a right that has no room (needs width + 2 columns) is dropped', () => {
    const line = columns('abc', 'xyzxyz', 7);
    expect(line).toBe('abc    ');
    expect(line).not.toContain('xyz');
  });

  it('never wider than `cols`, also with wide characters', () => {
    const line = columns('\u3042\u3042\u3042\u3042\u3042\u3042', '12', 10);
    expect(displayWidth(line)).toBe(10);
  });
});

describe('centred', () => {
  it('pads on the left by half of the free room, to exactly `cols` columns', () => {
    expect(centred('abc', 10)).toBe('   abc    ');
  });

  it('text as wide as `cols` is unchanged', () => {
    expect(centred('abcdef', 6)).toBe('abcdef');
  });

  it('text wider than `cols` is cut to `cols` columns', () => {
    const line = centred('abcdefghij', 6);
    expect(displayWidth(line)).toBe(6);
    expect(line).toContain('...');
  });
});

describe('helpLine', () => {
  const items: HelpItem[] = [
    { text: 'Up/Down move', rank: 0 },
    { text: 'Enter open', rank: 2 },
    { text: 'q quit', rank: 1 },
    { text: 'x extra', rank: 3 },
  ];

  it('all items fit: display order, two spaces apart, padded to `cols`', () => {
    const line = helpLine(items, 80);
    expect(line.trimEnd()).toBe('Up/Down move  Enter open  q quit  x extra');
    expect(displayWidth(line)).toBe(80);
  });

  it('too narrow: the highest ranks go first, the rest stay in display order', () => {
    // "Up/Down move" (12) + "q quit" (6) + gap (2) = 20; "Enter open" would need 12 more.
    const line = helpLine(items, 20);
    expect(line).toBe('Up/Down move  q quit');
  });

  it('rank 0 is kept first: it still shows when only it fits', () => {
    const line = helpLine(items, 12);
    expect(line).toBe('Up/Down move');
  });

  it('an item that does not fit does not stop a lower-priority shorter one that does', () => {
    const mixed: HelpItem[] = [
      { text: 'aaaa', rank: 0 },
      { text: 'a very long help item', rank: 1 },
      { text: 'bb', rank: 2 },
    ];
    expect(helpLine(mixed, 10).trimEnd()).toBe('aaaa  bb');
  });

  it('always exactly `cols` columns, even when nothing fits', () => {
    for (const cols of [1, 5, 11, 12, 30, 80]) {
      expect(displayWidth(helpLine(items, cols))).toBe(cols);
    }
  });

  it('no items -> a blank line of `cols` columns', () => {
    expect(helpLine([], 10)).toBe(' '.repeat(10));
  });
});

describe('tooSmallFrame', () => {
  it('rows lines of exactly `cols` columns, the long text centred on the middle line', () => {
    const frame = tooSmallFrame(7, 45, null);
    expect(frame.lines).toHaveLength(7);
    for (const line of frame.lines) expect(displayWidth(line)).toBe(45);
    expect(frame.lines[3]).toBe(centredLine(LONG, 45));
    expect(frame.cursorLine).toBeNull();
    expect(frame.lines.filter((l) => l.trim() !== '')).toHaveLength(1);
  });

  it.each([37, 38, 39, 45])('%i columns -> the long text, whole', (cols) => {
    const frame = tooSmallFrame(8, cols, null);
    expect(frame.lines.some((l) => l.includes(LONG))).toBe(true);
  });

  it.each([21, 25, 30, 36])('%i columns -> the short text, whole', (cols) => {
    const frame = tooSmallFrame(8, cols, null);
    expect(frame.lines.some((l) => l.includes(SHORT))).toBe(true);
    expect(frame.lines.some((l) => l.includes('Window'))).toBe(false);
  });

  it('below 21 columns every line still has exactly `cols` columns', () => {
    for (const cols of [1, 10, 20]) {
      for (const line of tooSmallFrame(8, cols, null).lines) {
        expect(displayWidth(line)).toBe(cols);
      }
    }
  });

  it('a pending question goes on the line after the text, centred', () => {
    const frame = tooSmallFrame(5, 30, 'Drop 2 marks? (y/N)');
    expect(frame.lines).toHaveLength(5);
    expect(frame.lines[2]).toBe(centredLine(SHORT, 30));
    expect(frame.lines[3]).toBe(centredLine('Drop 2 marks? (y/N)', 30));
    expect(frame.cursorLine).toBeNull();
  });

  it('with one row the question replaces the text', () => {
    const frame = tooSmallFrame(1, 30, 'Reconnect? (y/N)');
    expect(frame.lines).toHaveLength(1);
    expect(frame.lines[0]).toBe(centredLine('Reconnect? (y/N)', 30));
  });

  it('no question -> no second text line', () => {
    const frame = tooSmallFrame(5, 30, null);
    expect(frame.lines.filter((l) => l.trim() !== '')).toHaveLength(1);
  });
});

describe('fitTail', () => {
  it('text that fits is kept whole', () => {
    expect(fitTail('abc@example.com', 30).trimEnd()).toBe('abc@example.com');
    expect(fitTail('abc', 3).trimEnd()).toBe('abc');
  });

  it('text that is too long keeps its END and is at most `width` columns', () => {
    const text = 'a-very-long-local-part-of-an-address@example.com';
    const out = fitTail(text, 20);
    expect(displayWidth(out)).toBeLessThanOrEqual(20);
    expect(out.trimEnd().endsWith('@example.com')).toBe(true);
    expect(out.trimEnd().startsWith('a-very-long')).toBe(false);
  });

  it('exactly one column too long still keeps the end', () => {
    const out = fitTail('abcdefghij', 9);
    expect(displayWidth(out)).toBeLessThanOrEqual(9);
    expect(out.trimEnd().endsWith('j')).toBe(true);
  });

  it('wide characters: never wider than `width`, the last one stays', () => {
    const text = '\u3042'.repeat(20);
    const out = fitTail(text, 11);
    expect(displayWidth(out)).toBeLessThanOrEqual(11);
    expect(out.trimEnd().endsWith('\u3042')).toBe(true);
  });

  it('a typed password-length string cut to a small width is still at most `width`', () => {
    for (const width of [1, 2, 3, 4, 5, 10]) {
      expect(displayWidth(fitTail('x'.repeat(300), width))).toBeLessThanOrEqual(width);
    }
  });
});
