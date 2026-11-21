// Markdown as plain text, apart from rendering it (markdown.mjs).

import { keepMathStars } from './markdown-inline.mjs';

/** Strips Markdown to plain text, for screen-reader announcements and short previews. */
export function toPlainText(src) {
  // The asterisks of 10**9 or 2*n stay as typed while emphasis goes, as rendering keeps them (#793).
  return keepMathStars(String(src ?? ''), '\uE000')
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/<\/?(details|summary)>/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^ {0,3}#{1,6}\s+/gm, '')
    .replace(/^ {0,3}>\s?/gm, '')
    .replace(/^\s*([-*+]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|__|~~|\*|_)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/\uE000/g, '*')
    .replace(/\s+/g, ' ')
    .trim();
}
