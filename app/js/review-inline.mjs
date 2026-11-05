// A review line’s Markdown and text in the Lines view (#179), moved from app/js/review.mjs.

import { LIST_ITEM, renderMarkdown, toPlainText } from '/shared/markdown.mjs';

/** Bold, italic and code inside a review line, without block structure. A fold shows as its source. */
export function inlineMd(t) {
  return renderMarkdown(t || ' ', { folds: false, pageOrigin: location.origin })
    .replace(/^<p>|<\/p>$/g, '')
    .replace(/^<h\d>|<\/h\d>$/g, '');
}

/** Text to tell one list item from another: what renders, without Markdown or punctuation. @param {string} s */
export const words = (s) => s.replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
/** A list item’s first words, as words() gives them. @param {{ rows: { t: string }[] }} u */
export const itemWords = (u) => words(toPlainText(u.rows[0].t.replace(/^(\s*>)+/, '').match(LIST_ITEM)?.[3] ?? '')).slice(0, 12);
