// Terminal display width (M2b): CJK and emoji take two columns, non-spacing marks none. JS regex
// has no East_Asian_Width property, so wide characters come from a small range table plus
// \p{Emoji_Presentation}. A grapheme is measured code point by code point (an Indic conjunct or
// a spacing mark takes columns of its own); an emoji grapheme counts 2 plus whatever non-emoji
// characters joined it (spacing marks, extenders like U+FF9E, Prepend). A skin tone counts 2
// unless it directly follows an emoji that takes one (any number of them can join one grapheme).
// Overestimating is fine — the rule is "never wider than the screen". Measure sanitised text:
// controls and zero-width characters are removed before this.

const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2329, 0x232a], // angle brackets
  [0x2630, 0x2637], // Yijing trigrams (wide since Unicode 16)
  [0x268a, 0x268f], // Yijing monograms and digrams (wide since Unicode 16)
  [0x2e80, 0x303e], // CJK radicals, Kangxi, ideographic description, CJK symbols
  [0x3041, 0x33ff], // Hiragana, Katakana, Bopomofo, Hangul compatibility Jamo, CJK compatibility
  [0x3400, 0x4dbf], // CJK Unified Ideographs Extension A
  [0x4dc0, 0x4dff], // Yijing hexagram symbols
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xa000, 0xa4cf], // Yi
  [0xa960, 0xa97f], // Hangul Jamo Extended-A
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe10, 0xfe19], // vertical forms
  [0xfe30, 0xfe4f], // CJK compatibility forms
  [0xfe50, 0xfe6b], // small form variants
  [0xff00, 0xff60], // fullwidth forms
  [0xffe0, 0xffe6], // fullwidth signs
  [0x16fe0, 0x1b2ff], // Tangut, Khitan, Kana Supplement/Extended, Nushu
  [0x1d300, 0x1d356], // Tai Xuan Jing symbols (wide since Unicode 16)
  [0x1d360, 0x1d376], // counting rod numerals (wide since Unicode 16)
  [0x1f200, 0x1f2ff], // enclosed ideographic supplement
  [0x20000, 0x3fffd], // CJK Extension B and later
];

/** Non-spacing and enclosing marks draw over the previous character; spacing marks (Mc) don't. */
const ZERO_WIDTH_MARK = /^[\p{Mn}\p{Me}]$/u;
const EMOJI = /\p{Emoji_Presentation}|\u{fe0f}/u;
/**
 * Emoji parts (pictographs, ZWJ, variation selectors, a tone right after its base, keycap, tags,
 * flags): no extra width.
 */
const EMOJI_PART =
  /^(?:[\p{Extended_Pictographic}\p{Emoji_Component}\p{Mn}\p{Me}]|\u{200d}|\u{fe0e}|\u{fe0f})$/u;
/** Skin tones U+1F3FB–1F3FF: wide on their own, drawn into the emoji only right after a base. */
const SKIN_TONE = /^\p{Emoji_Modifier}$/u;
const TONE_BASE = /^\p{Emoji_Modifier_Base}$/u;
/** ASCII, so it takes three columns in every terminal (no ambiguous width). */
const ELLIPSIS = '...';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function isWide(codePoint: number): boolean {
  return WIDE_RANGES.some(([from, to]) => codePoint >= from && codePoint <= to);
}

function codePointWidth(ch: string): number {
  return isWide(ch.codePointAt(0) ?? 0) ? 2 : 1;
}

function graphemeWidth(g: string): number {
  if (EMOJI.test(g)) {
    let width = 2;
    let prev = '';
    for (const ch of g) {
      if (SKIN_TONE.test(ch)) {
        if (!TONE_BASE.test(prev)) width += 2;
      } else if (!EMOJI_PART.test(ch)) {
        width += codePointWidth(ch);
      }
      prev = ch;
    }
    return width;
  }
  let width = 0;
  for (const ch of g) {
    if (ZERO_WIDTH_MARK.test(ch)) continue;
    width += codePointWidth(ch);
  }
  return width;
}

/** Columns `text` takes in a terminal. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const { segment } of segmenter.segment(text)) width += graphemeWidth(segment);
  return width;
}

/** `text` in exactly `width` columns: cut with "..." when longer, padded with spaces when shorter. */
export function fit(text: string, width: number): string {
  if (!Number.isFinite(width) || width <= 0) return '';
  const w = Math.floor(width);
  const ellipsis = ELLIPSIS.slice(0, w);
  const room = w - ellipsis.length;
  let out = '';
  let used = 0;
  // Where to cut if it doesn't fit: the longest prefix leaving room for the ellipsis.
  let cut = '';
  let cutUsed = 0;
  for (const { segment } of segmenter.segment(text)) {
    const gw = graphemeWidth(segment);
    if (used + gw > w) return `${cut}${ellipsis}${' '.repeat(room - cutUsed)}`;
    out += segment;
    used += gw;
    if (used <= room) {
      cut = out;
      cutUsed = used;
    }
  }
  return out + ' '.repeat(w - used);
}
