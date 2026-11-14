// An agent sheet that fills in late moves nothing under the pointer (#1326). The New agent sheet and a persona’s
// sheet ask for your MCP servers and the skills the agent loads once they open, and each list, of any length, takes
// the place of its “Looking for…” line when it comes. A sheet that grew to fit moved Save or Create agent from under
// the pointer. So such a sheet keeps one height, the most the window gives it (fullHeight), and what comes late scrolls
// inside its body, which holds still whatever is under the pointer when what’s above it changes (holdSheet).

import { onPointerMoved, pointer } from './pointer-rest.mjs';

/** Where an element is under the body, child by child, to find its place again once the sheet is drawn anew. */
function pathOf(/** @type {Element} */ body, /** @type {Element} */ n) {
  const path = [];
  for (let at = n; at !== body && at.parentElement; at = at.parentElement) path.unshift([...at.parentElement.children].indexOf(at));
  return path;
}

/**
 * Gives an agent sheet the most height the window gives it, or lets it fit what it shows again: only while it shows an
 * agent’s form, whose lists come late (.dialog.held, workbench.css). The other Settings tabs fit what they show.
 * @param {HTMLElement | null | undefined} dialog @param {boolean} on
 */
export const fullHeight = (dialog, on) => dialog?.classList.toggle('held', on);

/**
 * Keeps the element under the pointer where it is in the dialog’s body, until the function it returns is called, as
 * the dialog closes.
 * The sheet draws itself anew as each answer comes, so the element is found again by its place in the body, and only
 * if it’s the same kind of element saying the same thing: Save is still Save.
 * @param {HTMLElement} dialog  as openDialog made it @returns {() => void}
 */
export function holdSheet(dialog) {
  const body = /** @type {HTMLElement} */ (dialog.querySelector('.d-body'));
  /** @type {{ path: number[], tag: string, text: string | null, at: number } | null} */
  let held = null;
  let ownTop = body.scrollTop;
  const take = () => {
    held = null;
    const p = pointer();
    const n = p && document.elementFromPoint(p.x, p.y);
    if (!n || n === body || !body.contains(n)) return;
    held = { path: pathOf(body, n), tag: n.tagName, text: n.textContent, at: n.getBoundingClientRect().top };
  };
  const find = () => {
    if (!held) return null;
    /** @type {Element | undefined} */
    let n = body;
    for (const i of held.path) n = n?.children[i];
    return n && n.tagName === held.tag && n.textContent === held.text ? n : null;
  };
  const hold = () => {
    const n = find();
    if (n && held) {
      const d = n.getBoundingClientRect().top - held.at;
      if (Math.abs(d) >= 1) body.scrollTop += d;
      ownTop = body.scrollTop;
      if (Math.abs(n.getBoundingClientRect().top - held.at) < 1) return;
    }
    take();
  };
  const sizes = new ResizeObserver(hold);
  const observe = () => {
    for (const child of body.children) sizes.observe(child);
  };
  observe();
  const added = new MutationObserver(observe);
  added.observe(body, { childList: true });
  // Your own scroll moves what’s under the pointer: it’s taken again there. The body’s own hold isn’t yours.
  body.addEventListener('scroll', () => body.scrollTop !== ownTop && take(), { passive: true });
  const stop = onPointerMoved(() => {
    hold();
    take();
  });
  return () => {
    stop();
    sizes.disconnect();
    added.disconnect();
  };
}
