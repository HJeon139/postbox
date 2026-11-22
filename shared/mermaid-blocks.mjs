// The Mermaid diagrams in a reply’s Markdown, which the server’s diagram checks read (shared/diagram-lint.mjs,
// server/diagram-check.mjs). Moved out of shared/diagram-lint.mjs, which had reached its length limit.

import { closesFence, FENCE } from './markdown.mjs';

/**
 * The closed Mermaid fences in a Markdown text, in order, read as the renderer draws them (shared/markdown.mjs,
 * fenced): ``` or ~~~, the language “mermaid” in any case, to a closing marker as long or longer. A fence of any other
 * language, such as mermaid-example, is code, and so is a Mermaid fence inside one. One pass over the lines.
 * @param {string | null | undefined} markdown
 */
export function mermaidBlocks(markdown) {
  const lines = String(markdown ?? '').split('\n');
  /** @type {{ index: number, src: string }[]} */
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE.exec(lines[i]);
    if (!open) continue;
    let end = i + 1;
    while (end < lines.length && !closesFence(open[1], lines[end])) end++;
    if (open[2].toLowerCase() === 'mermaid' && end < lines.length) blocks.push({ index: blocks.length, src: lines.slice(i + 1, end).join('\n') });
    i = end;
  }
  return blocks;
}
