// The Mermaid diagrams in a reply’s Markdown, which the server’s diagram checks read (shared/diagram-lint.mjs,
// server/diagram-check.mjs). Moved out of shared/diagram-lint.mjs, which had reached its length limit.

import { renderMarkdown } from './markdown.mjs';

/** A diagram the renderer draws: its source, escaped, in the figure the page draws it from (md-enhance.mjs). */
const FIGURE = /<figure class="md-mermaid"[^>]*><pre><code>([\s\S]*?)<\/code><\/pre><\/figure>/g;
/** escapeHtml’s entities, back to the characters they stand for. */
const TEXT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };

/**
 * The Mermaid diagrams in a Markdown text, in order, exactly as the page draws them: the renderer decides which fences
 * are diagrams (``` or ~~~, in a list item or a quote, but not mermaid-example or one inside math or another fence),
 * and each source is the text the page reads from its figure, so a page’s report of a diagram finds it here.
 * @param {string | null | undefined} markdown
 */
export function mermaidBlocks(markdown) {
  return [...renderMarkdown(String(markdown ?? '')).matchAll(FIGURE)].map((m, index) => ({
    index,
    src: m[1].replace(/&(?:amp|lt|gt|quot|#39);/g, (e) => TEXT[/** @type {keyof typeof TEXT} */ (e)]),
  }));
}
