// Writes rendered Markdown into a box block by block (#564): a top-level block whose HTML is the same as last time keeps
// its node, so a diagram's frame isn't loaded again, a selection or an open <details> stays, and a streaming reply
// replaces only the block still being written. Blocks are only ever inserted before a kept node or removed, never
// moved, since moving a frame reloads it.

/** @type {WeakMap<Element, { html: string | null, parts: string[] }>} what each box was last written with, html null when written in parts */
const written = new WeakMap();

/** A top-level node's HTML as renderMarkdown() wrote it, before anything enhanced it. */
const partOf = (/** @type {Node} */ n) => (n instanceof Element ? n.outerHTML : `${n.nodeType}:${n.textContent}`);

/**
 * Puts html (renderMarkdown() output) into box. Returns false, touching nothing, when it's what the box already holds.
 * @param {Element} box  @param {string} html
 */
export function writeMarkdown(box, html) {
  if (written.get(box)?.html === html) return false;
  patch(box, 0, [html], html);
  return true;
}

/**
 * Puts html in place of every top-level node after the box's first `keep`, which stay as they are: a streaming reply's
 * blocks before its cut (md-stream.mjs, #850). html is in parts, and it returns how many nodes each part made, with the
 * nodes it put in; null when the box wasn't written this way, so its first `keep` nodes aren't known.
 * @param {Element} box  @param {number} keep  @param {string[]} parts
 * @returns {{ counts: number[], added: Node[] } | null}
 */
export function writeAfter(box, keep, parts) {
  const last = written.get(box);
  if (keep && (!last || last.parts.length !== box.childNodes.length || keep > last.parts.length)) return null;
  return patch(box, keep, parts, null);
}

/**
 * Writes parts' nodes after the box's first `keep` top-level nodes, keeping each one whose HTML is the same as last
 * time. Blocks are only inserted before a kept node or removed, never moved, since moving a frame reloads it.
 * @param {Element} box @param {number} keep @param {string[]} htmls @param {string | null} whole  the box's whole html, when known
 */
function patch(box, keep, htmls, whole) {
  const counts = [];
  /** @type {Node[]} */
  const fresh = [];
  for (const html of htmls) {
    const t = document.createElement('template');
    t.innerHTML = html; // lint-allow dom: renderMarkdown() output, escaped; parsed here, then moved into the box.
    counts.push(t.content.childNodes.length);
    fresh.push(...t.content.childNodes);
  }
  const parts = fresh.map(partOf);
  const last = written.get(box);
  // Only what follows the first `keep`, so a long reply's kept blocks cost nothing a frame.
  /** @type {ChildNode[]} */
  const olds = [];
  for (let n = box.childNodes[keep] ?? null; n; n = n.nextSibling) olds.push(n);
  // A box written some other way, or changed since at its top level, starts again.
  if (!last || last.parts.length !== keep + olds.length) {
    for (const n of olds) n.remove();
    box.append(...fresh);
    written.set(box, { html: whole, parts });
    return { counts, added: fresh };
  }
  const was = last.parts.splice(keep);
  /** @type {Node[]} */
  const added = [];
  let j = 0;
  for (let i = 0; i < fresh.length; i++) {
    const k = was.indexOf(parts[i], j);
    if (k === -1) {
      box.insertBefore(fresh[i], olds[j] ?? null);
      added.push(fresh[i]);
      continue;
    }
    for (; j < k; j++) olds[j].remove();
    j = k + 1;
  }
  for (; j < olds.length; j++) olds[j].remove();
  last.html = whole;
  for (const part of parts) last.parts.push(part);
  return { counts, added };
}
