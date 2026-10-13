// Editing the text of a typed field, by code point.

/** Appends the code points of `text` while the result has at most `max` code points. */
export function typed(value: string, text: string, max: number): string {
  let out = value;
  let count = [...value].length;
  for (const ch of text) {
    if (count >= max) break;
    out += ch;
    count += 1;
  }
  return out;
}

/** `value` without its last code point. */
export function erased(value: string): string {
  return [...value].slice(0, -1).join('');
}
