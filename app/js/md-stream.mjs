// A streaming reply's Markdown, drawn as it grows (#850). Rendered whole each frame, the work grew with the reply: a
// reply of 250 KB took about 8 ms to render each frame, before the page parsed the HTML. Now the blocks it has closed
// render once and stay; each frame renders and draws only what follows the cut (renderMarkdownCut), so its work
// follows the newest block, not the reply's length.

import { renderMarkdownCut } from '/shared/markdown-cut.mjs';
import { writeAfter } from './md-patch.mjs';

/**
 * What each streaming box keeps: what it was drawn with (key), the source its kept blocks came from, and how many
 * top-level nodes they are. @type {WeakMap<Element, { key: string, src: string, nodes: number }>}
 */
const kept = new WeakMap();

/**
 * Draws a streaming reply's text into its box. Returns what changed: the box itself when it was drawn from the start
 * (its kept blocks don't match, or how it's drawn changed), else only the nodes put in, for the caller's marks.
 * @param {Element} box @param {string} text
 * @param {Parameters<typeof renderMarkdownCut>[1]} opts @param {string} key  everything besides text that it draws with
 * @returns {Node[]}
 */
export function writeStreaming(box, text, opts, key) {
  const was = kept.get(box);
  let s = was && was.key === key && text.startsWith(was.src) ? was : { key, src: '', nodes: 0 };
  let r = renderMarkdownCut(text.slice(s.src.length), opts);
  let wrote = writeAfter(box, s.nodes, [r.head, r.tail]);
  if (!wrote) {
    s = { key, src: '', nodes: 0 };
    r = renderMarkdownCut(text, opts);
    wrote = /** @type {NonNullable<typeof wrote>} */ (writeAfter(box, 0, [r.head, r.tail]));
  }
  const fromStart = s.nodes === 0;
  kept.set(box, { key, src: text.slice(0, s.src.length + r.cut), nodes: s.nodes + wrote.counts[0] });
  return fromStart ? [box] : wrote.added;
}

/** Forgets what a box kept, once its reply is drawn whole again. @param {Element} box */
export function forgetStreaming(box) {
  kept.delete(box);
}
