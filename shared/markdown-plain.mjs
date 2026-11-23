// Markdown as plain text, apart from rendering it (markdown.mjs).

import { mapCodeSpans } from './code-spans.mjs';
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
 * The text without its fenced blocks, each opening on a line of its own and running to its closing marker or the end.
 * The renderer finds a fence inside a quote or a list item once it strips the `>`, the item’s marker and its indent, so
 * each line is read without them here.
 */
export function withoutFences(s) {
  // A fence needs three backticks or tildes: most messages have none.
  if (!s.includes('```') && !s.includes('~~~')) return s;
  const out = [];
  let marker = null;
  // A line ends where the renderer ends one (markdown.mjs): at \n, \r\n or a lone \r (#1601).
  for (const line of s.split(/\r\n?|\n/)) {
    const bare = line.replace(/^(\s*>)*\s*/, '');
    if (marker) {
      if (closesFence(marker, bare)) marker = null;
      continue;
    }
    // A list item’s marker can open a fence on its line, but a closer is the marker alone.
    const open = bare.replace(/^([-*+]|\d+[.)])\s+/, '').match(FENCE);
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
  const coded = mapCodeSpans(kept, (code) => code.replaceAll('*', mark));
  return keepMathStars(coded, mark)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^ {0,3}#{1,6}\s+/gm, '')
    .replace(/^ {0,3}>\s?/gm, '')
    .replace(/^\s*([-*+]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|__|~~|\*|_)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replaceAll(mark, '*')
    .replace(/\s+/g, ' ')
    .trim();
}
