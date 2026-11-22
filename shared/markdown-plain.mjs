// Markdown as plain text, apart from rendering it (markdown.mjs).

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
 * Code spans with their asterisks as `mark`, read left to right as the renderer reads them (markdown-inline.mjs): a run
 * of backticks closes at the next same run, even inside a longer one, less one space each side; with no close, it’s text.
 */
function keepCodeStars(s, mark) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const at = s.indexOf('`', i);
    if (at < 0) break;
    const run = /** @type {RegExpMatchArray} */ (s.slice(at).match(/^`+/))[0];
    const end = s.indexOf(run, at + run.length);
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

/** Strips Markdown to plain text, for screen-reader announcements and short previews. */
export function toPlainText(src) {
  const text = String(src ?? '');
  // The asterisks of 10**9 or 2*n, and those in a code span, stay as typed while emphasis goes, as rendering keeps them
  // (#793). A code span’s are kept first, so they don’t count as emphasis opened before the math after them.
  const mark = freeMark(text);
  const kept = text.replace(/```[\s\S]*?(```|$)/g, ' ').replace(/<\/?(details|summary)>/g, ' ');
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
