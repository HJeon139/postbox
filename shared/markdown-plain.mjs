// Markdown as plain text, apart from rendering it (markdown.mjs).

import { closesFence, FENCE } from './markdown.mjs';
import { keepMathStars } from './markdown-inline.mjs';

/**
 * A private-use character the text doesn’t hold, to stand for a kept asterisk while emphasis goes, or a run of them
 * when the text holds every one. @param {string} s
 */
function freeMark(s) {
  for (let code = 0xe000; code <= 0xf8ff; code++) {
    const c = String.fromCharCode(code);
    if (!s.includes(c)) return c;
  }
  let mark = '\ue000\uf8ff';
  while (s.includes(mark)) mark += '\uf8ff';
  return mark;
}

/**
 * The longest run of backticks that starts at or after each place in s, so a run with no close of its length is known
 * at once: an open run of n backticks can close only where n of them come later. Kept linear on the server, where a
 * block’s fallback of 200,000 characters is cut to plain text (#793).
 */
function longestRunFrom(s) {
  const run = new Int32Array(s.length + 1);
  const longest = new Int32Array(s.length + 1);
  for (let i = s.length - 1; i >= 0; i--) {
    run[i] = s[i] === '`' ? run[i + 1] + 1 : 0;
    longest[i] = Math.max(run[i], longest[i + 1]);
  }
  return longest;
}

/**
 * Code spans with their asterisks as `mark`, read left to right as the renderer reads them (markdown-inline.mjs): a run
 * of backticks closes at the next same run, even inside a longer one, less one space each side; with no close, it’s text.
 */
function keepCodeStars(s, mark) {
  const longest = longestRunFrom(s);
  let out = '';
  let i = 0;
  while (i < s.length) {
    const at = s.indexOf('`', i);
    if (at < 0) break;
    const run = /** @type {RegExpMatchArray} */ (s.slice(at).match(/^`+/))[0];
    const end = longest[at + run.length] >= run.length ? s.indexOf(run, at + run.length) : -1;
    out += s.slice(i, at);
    if (end < 0) {
      out += run;
      i = at + run.length;
      continue;
    }
    out += s
      .slice(at + run.length, end)
      .replace(/^ (.*) $/, '$1')
      .replaceAll('*', mark);
    i = end + run.length;
  }
  return out + s.slice(i);
}

/**
 * The text without its fenced blocks, each opening on a line of its own and running to its closing marker or the end.
 * The renderer finds a fence inside a quote or a list item once it strips the `>` and the item’s indent, so each line is
 * read without them here.
 */
function withoutFences(s) {
  const out = [];
  let marker = null;
  for (const line of s.split('\n')) {
    const bare = line.replace(/^(\s*>)*\s*/, '');
    if (marker) {
      if (closesFence(marker, bare)) marker = null;
      continue;
    }
    const open = bare.match(FENCE);
    if (open) marker = open[1];
    else out.push(line);
  }
  return out.join('\n');
}

/** Strips Markdown to plain text, for screen-reader announcements and short previews. */
export function toPlainText(src) {
  const text = String(src ?? '');
  // The asterisks of 10**9 or 2*n, and those in a code span, stay as typed while emphasis goes, as rendering keeps them
  // (#793). A code span’s are kept first, so they don’t count as emphasis opened before the math after them.
  const mark = freeMark(text);
  const kept = withoutFences(text).replace(/<\/?(details|summary)>/g, ' ');
  return keepMathStars(keepCodeStars(kept, mark), mark)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^ {0,3}#{1,6}\s+/gm, '')
    .replace(/^ {0,3}>\s?/gm, '')
    .replace(/^\s*([-*+]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|__|~~|\*|_)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replaceAll(mark, '*')
    .replace(/\s+/g, ' ')
    .trim();
}
