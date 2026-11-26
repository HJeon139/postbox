// A press on a running reply’s live steps or job rows holds that reply’s refill until just after its click (#1616).
// Each frame with new steps replaces the reply’s live block and its job rows (paintLive, activity-paint.mjs), so a press
// held across one landed its release on a new node, and the browser fired no click: “N earlier steps”, “Show the whole
// reply”, a step’s text and a job’s button did nothing. The Work pane’s panels hold their repaints the same way
// (heldPaint, dom.mjs, #898); a reply’s nodes come and go with its turn, so the hold here is one for the page, by reply.

import { HOLD_MS } from './dom.mjs';

/** Where a press holds its reply: in its live block or its job rows. */
const PARTS = '.transcript > [data-key] > .live-steps, .transcript > [data-key] > ul.bg-jobs';
const TEXT_FIELD = 'input, textarea, [contenteditable]';

/** The replies with a press down in their live parts. */
const held = /** @type {Set<HTMLElement>} */ (new Set());
/** @type {AbortController | null} */
let ending = null;
let bound = 0;
/** @type {(node: HTMLElement) => void} */
let released = () => {};

/** The reply a press on this target holds, if it’s on one’s live parts. @param {EventTarget | null} target */
const replyOf = (target) => (target instanceof Element ? /** @type {HTMLElement | null} */ (target.closest(PARTS)?.parentElement ?? null) : null);

/** The press is over, after its click: each reply it held refills now. */
function flush() {
  ending?.abort();
  ending = null;
  clearTimeout(bound);
  const nodes = [...held];
  held.clear();
  for (const node of nodes) if (node.isConnected) released(node);
}

/** A press began on a reply’s live parts: hold it until the press ends, or HOLD_MS, whichever comes first. */
function start(/** @type {Event} */ e) {
  const node = replyOf(e.target);
  if (!node) return;
  held.add(node);
  if (ending) return;
  ending = new AbortController();
  const opts = { capture: true, signal: ending.signal };
  // After the click the press ends in, which the browser dispatches after pointerup and Space’s keyup.
  const end = () => setTimeout(flush);
  for (const type of ['pointerup', 'pointercancel', 'mouseup']) addEventListener(type, end, opts);
  addEventListener('keyup', (k) => k.key === ' ' && end(), opts);
  bound = window.setTimeout(flush, HOLD_MS);
}

for (const type of ['pointerdown', 'mousedown']) addEventListener(type, start, { capture: true });
addEventListener(
  'keydown',
  (e) => {
    if (e.key === ' ' && !e.repeat && !(e.target instanceof Element && e.target.closest(TEXT_FIELD))) start(e);
  },
  { capture: true },
);

/** Whether a press holds this reply’s refill now. @param {HTMLElement} node */
export const pressHolds = (node) => held.has(node);

/** What to do with each reply a press held, once it ends. @param {(node: HTMLElement) => void} fn */
export function onPressEnd(fn) {
  released = fn;
}
