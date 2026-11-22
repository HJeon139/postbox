// Markdown as plain text, apart from rendering it (markdown.mjs).

import { keepMathStars } from './markdown-inline.mjs';

/** A private-use character the text doesn’t hold, to stand for a kept asterisk while emphasis goes. @param {string} s */
function freeMark(s) {
  let code = 0xe000;
  while (s.includes(String.fromCharCode(code))) code++;
  return String.fromCharCode(code);
}

/** Strips Markdown to plain text, for screen-reader announcements and short previews. */
export function toPlainText(src) {
  const text = String(src ?? '');
  // The asterisks of 10**9 or 2*n, and those in a code span, stay as typed while emphasis goes, as rendering keeps them
  // (#793). A code span’s are kept first, so they don’t count as emphasis opened before the math after them.
  const mark = freeMark(text);
  const kept = text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/<\/?(details|summary)>/g, ' ')
    .replace(/`([^`]*)`/g, (_m, code) => code.replaceAll('*', mark));
  return keepMathStars(kept, mark)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^ {0,3}#{1,6}\s+/gm, '')
    .replace(/^ {0,3}>\s?/gm, '')
    .replace(/^\s*([-*+]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|__|~~|\*|_)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replaceAll(mark, '*')
    .replace(/\s+/g, ' ')
    .trim();
}
