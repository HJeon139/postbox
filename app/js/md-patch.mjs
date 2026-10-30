// Writes rendered Markdown into a box block by block (#564): a top-level block whose HTML is the same as last time keeps
// its node, so a diagram's frame isn't loaded again, a selection or an open <details> stays, and a streaming reply
// replaces only the block still being written. Blocks are only ever inserted before a kept node or removed, never
// moved, since moving a frame reloads it.

/** @type {WeakMap<Element, { html: string, parts: string[] }>} what each box was last written with */
const written = new WeakMap();

/** A top-level node's HTML as renderMarkdown() wrote it, before anything enhanced it. */
const partOf = (/** @type {Node} */ n) => (n instanceof Element ? n.outerHTML : `${n.nodeType}:${n.textContent}`);

/**
 * Puts html (renderMarkdown() output) into box. Returns false, touching nothing, when it's what the box already holds.
 * @param {Element} box  @param {string} html
 */
export function writeMarkdown(box, html) {
  const last = written.get(box);
  if (last?.html === html) return false;
  const t = document.createElement('template');
  t.innerHTML = html; // lint-allow dom: renderMarkdown() output, escaped; parsed here, then moved into the box.
  const fresh = [...t.content.childNodes];
  const parts = fresh.map(partOf);
  const olds = [...box.childNodes];
  // A box written some other way, or changed since at its top level, starts again.
  if (!last || last.parts.length !== olds.length) {
    box.replaceChildren(...fresh);
    written.set(box, { html, parts });
    return true;
  }
  let j = 0;
  for (let i = 0; i < fresh.length; i++) {
    const k = last.parts.indexOf(parts[i], j);
    if (k === -1) {
      box.insertBefore(fresh[i], olds[j] ?? null);
      continue;
    }
    for (; j < k; j++) olds[j].remove();
    j = k + 1;
  }
  for (; j < olds.length; j++) olds[j].remove();
  written.set(box, { html, parts });
  return true;
}
