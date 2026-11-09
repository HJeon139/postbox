// Reading a long text in parts (#109): where a part starts and ends, and the line under it that says how much it holds
// and how to read on. read_message cuts an item and an app's code this way, and the host's copy can too (#675).

import { READING } from './limits.mjs';

const count = (/** @type {number} */ n) => n.toLocaleString('en-US');

/**
 * Where a part of text that would end at `end` ends. One earlier when `end` falls between the two halves of a
 * surrogate pair, so the character goes whole into the next part, or a lone first half at the end goes with it. Every
 * cut of text to a length ends here too, so it never leaves half of a pair, which shows as nothing or a box (#1052).
 * @param {string} text @param {number} end
 */
export function partEnd(text, end) {
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) return end - 1;
  return end;
}

/**
 * A Markdown fence for text: longer than any run of backticks in it, so the text can't close it.
 * @param {string} text
 */
export function fenceFor(text) {
  let longest = 0;
  for (const run of text.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  return '`'.repeat(Math.max(3, longest + 1));
}

/**
 * The part of text from `from`, clamped to the text, up to READING.part characters; null when nothing is left.
 * `whole` is a part that is all of the text, which needs no line under it; `footer` is that line, counting
 * characters of text alone, with the call that reads on.
 * @param {string} text @param {unknown} from
 * @param {{ next: (end: number) => string, of?: string }} name  `next` writes the call that reads on from end; `of`
 *   says what the count is of, such as “ of v3’s code”
 * @returns {{ part: string, whole: boolean, footer: string } | null}
 */
export function partOf(text, from, { next, of = '' }) {
  const start = Math.max(0, Math.min(text.length, Math.floor(Number(from) || 0)));
  if (start >= text.length) return null;
  const end = partEnd(text, Math.min(text.length, start + READING.part));
  const more = end < text.length ? ` ${next(end)} reads on.` : '';
  return {
    part: text.slice(start, end),
    whole: start === 0 && end === text.length,
    footer: `(Characters ${count(start + 1)}–${count(end)} of ${count(text.length)}${of}.${more})`,
  };
}
