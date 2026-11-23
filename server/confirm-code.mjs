// The code a confirm block’s statement shows the person. A command a confirmed statement shows exactly runs without a
// card (write-intent.mjs, #296), so what counts as shown is read from the page’s own render of the statement.

import { renderMarkdown } from '../shared/markdown.mjs';

const HTML_ENT = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&amp;': '&' };

/**
 * The code in a confirm’s statement: each `<code…>` element `renderMarkdown` draws on the page (#1659), both fenced
 * blocks and inline spans, so a command hidden in a dropped table cell, a link target, math or an indented line never
 * counts as confirmed.
 * @param {unknown} statement
 */
export function codeIn(statement) {
  const html = renderMarkdown(String(statement ?? ''));
  // A fold hides its code until it’s opened, so a statement with one shows no command.
  if (html.includes('<details>')) return [];
  return [...html.matchAll(/<code(?:\s[^>]*)?>([\s\S]*?)<\/code>/g)].map((m) => m[1].replace(/&(?:lt|gt|quot|#39|amp);/g, (e) => HTML_ENT[e]));
}
