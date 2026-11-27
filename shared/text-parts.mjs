// Reading a long text in parts (#109): where a part starts and ends, and the line under it that says how much it holds
// and how to read on. read_message cuts an item and an app's code this way, and the host's copy can too (#675).

import { INVISIBLE } from './invisible.mjs';
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
 * Text cut to at most n characters, never inside a surrogate pair (partEnd): the whole text when it fits. n is a whole
 * number of 1 or more; any other n can return a lone half (#1686).
 * @param {string} text @param {number} n
 */
export const cutText = (text, n) => (text.length > n ? text.slice(0, partEnd(text, n)) : text);

/** Half of a surrogate pair with no other half beside it. */
const LONE_HALF = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Words another program gave, such as a backend’s error, cleaned before they reach a step, its label or an agent’s note
 * (#1171, #1905): every character that hides or reorders text (INVISIBLE) goes, line and paragraph separators, control
 * characters and runs of space become one space, half a character left alone (a buffer cut from its end can start
 * with one) goes, and the cut to `n` never splits a character.
 * @param {string} text @param {number} n
 */
export const cleanSaid = (text, n) =>
  cutText(
    text
      .replace(/[\u2028\u2029]/g, ' ')
      .replace(INVISIBLE, '')
      .replace(LONE_HALF, '')
      .replace(/[\p{Cc}\s]+/gu, ' ')
      .trim(),
    n,
  );

/**
 * The last n characters of text, never starting inside a surrogate pair: one fewer where they would (#1686). The whole
 * text when it fits. n is a whole number of 1 or more.
 * @param {string} text @param {number} n
 */
export function tailText(text, n) {
  if (text.length <= n) return text;
  const from = text.length - n;
  return text.slice(/[\uDC00-\uDFFF]/.test(text[from]) ? from + 1 : from);
}

/**
 * The last n characters of words another program gave, cleaned as cleanSaid cleans them: for an error whose newest
 * words are its end, such as a CLI’s stderr (#1938). Never starts inside a character (tailText).
 * @param {string} text @param {number} n
 */
export const cleanTail = (text, n) => tailText(cleanSaid(text, Number.POSITIVE_INFINITY), n);

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
