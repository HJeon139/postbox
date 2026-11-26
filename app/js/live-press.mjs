// A press on a running reply’s live steps or job rows holds that reply’s refill until just after its click (#1616).
// Each frame with new steps replaces the reply’s live block and its job rows (paintLive, activity-paint.mjs), so a press
// held across one landed its release on a new node, and the browser fired no click: “N earlier steps”, “Show the whole
// reply”, a step’s text and a job’s button did nothing. The Work pane’s panels hold their repaints the same way
// (heldPaint, dom.mjs, #898); a reply’s nodes come and go with its turn, so the hold here is one for the page, by reply.

import { pressEnds, spaceStartsPress } from './dom.mjs';

/** Where a press holds its reply: in its live block or its job rows. */
const PARTS = '.transcript > [data-key] > .live-steps, .transcript > [data-key] > ul.bg-jobs';

/** The replies with a press down in their live parts. */
const held = /** @type {Set<HTMLElement>} */ (new Set());
/** @type {(node: HTMLElement) => void} */
let released = () => {};

/** The reply a press on this target holds, if it’s on one’s live parts. @param {EventTarget | null} target */
const replyOf = (target) => (target instanceof Element ? /** @type {HTMLElement | null} */ (target.closest(PARTS)?.parentElement ?? null) : null);

// The press is over, after its click: each reply it held is let go, and refills if it’s still on the page. A reply that
// went meanwhile (its turn ended and it was drawn whole, or the room changed) is let go too, so nothing keeps it. A
// press that never ends, as when a right-click’s menu takes the mouseup, lets go at the bound.
const press = pressEnds(() => {
  const nodes = [...held];
  held.clear();
  for (const node of nodes) released(node);
});

/** A press began on a reply’s live parts: hold it until the press ends. @param {Event} e */
function start(e) {
  const node = replyOf(e.target);
  if (!node) return;
  held.add(node);
  press.start();
}

for (const type of ['pointerdown', 'mousedown']) addEventListener(type, start, { capture: true });
addEventListener('keydown', (e) => spaceStartsPress(e) && start(e), { capture: true });

/** Whether a press holds this reply’s refill now. @param {HTMLElement} node */
export const pressHolds = (node) => held.has(node);

/** What to do with each reply a press held, once it ends: on the page or not. @param {(node: HTMLElement) => void} fn */
export function onPressEnd(fn) {
  released = fn;
}
