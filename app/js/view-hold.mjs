// What you read or point at holds still while agents work (#1326). The view holds a place in the transcript
// (view-state.mjs): reading, the reply across the middle; following, the end. Holding a reply’s top lets what’s inside
// it move: a picture loading above the line you read, and anything between that reply and the pointer, as an app
// above the button you’re about to press grows. So the view also holds the element at one point: the pointer, when
// it’s over the transcript, else the middle of the view. Following, the end comes in unless a click is on its way:
// the pointer moved onto something you could click, or pressed. Then the view holds that, and goes on to the end once
// the click is done or the pointer leaves it. A pointer left resting where you clicked aims at nothing.

import { aimed, pointer, pressed } from './pointer-rest.mjs';
import { inSight } from './view-box.mjs';
import { atEnd, box, skipped, viewTop } from './view-geometry.mjs';

/** @typedef {import('./view-state.mjs').View} View */
/**
 * The element held, and the view it was taken in: where it and its item were, the item before that one, the scroll
 * box’s size, and whether the view was following.
 * @typedef {{ node: Element, key: string, after: string | undefined, at: number, itemAt: number, size: string, stuck: boolean }} Hold
 */

// What a click lands on: a control, a link, or an agent app (its frame, or its body while the frame takes no pointer
// events, app-pointer.mjs).
const CONTROL =
  'button, a[href], input, select, textarea, summary, label, iframe, .app-body, [role="button"], [role="radio"], [role="checkbox"], [role="tab"], [role="link"], [role="menuitem"], [role="option"], [role="switch"]';

/** The transcript’s item an element is in. @param {View} v @param {Element | null} n */
function itemOf(v, n) {
  for (let at = n; at && at !== v.el; at = at.parentElement) {
    if (at.parentElement === v.el && at instanceof HTMLElement && at.dataset.key) return at;
  }
  return null;
}
const sizeOf = (/** @type {Element} */ s) => `${s.clientWidth}x${s.clientHeight}`;
/** The key of the item before this one: an item drawn anew in its place has the same, one moved to the end doesn’t. */
function keyBefore(/** @type {Element} */ item) {
  let n = item.previousElementSibling;
  while (n && !(n instanceof HTMLElement && n.dataset.key)) n = n.previousElementSibling;
  return n instanceof HTMLElement ? n.dataset.key : undefined;
}
/**
 * Whether an item in sight, the given one or one around it, is still laid out at the browser’s estimate (view-skip.mjs):
 * one drawn anew, as an app’s stub is, takes its real height a frame later and moves what’s around it.
 * @param {View} v @param {Element} item
 */
function settling(v, item) {
  const sight = inSight(v);
  for (const step of ['previousElementSibling', 'nextElementSibling']) {
    for (let n = /** @type {Element | null} */ (item); n; n = /** @type {any} */ (n)[step]) {
      const r = n.getBoundingClientRect();
      if (r.bottom < sight.top || r.top > sight.bottom) break;
      if (n instanceof HTMLElement && n.dataset.key && skipped(n)) return true;
    }
  }
  return false;
}
/** The pointer, when it’s over the transcript and in sight. @param {View} v */
function pointerOver(v) {
  const p = pointer();
  if (!p) return null;
  const sight = inSight(v);
  const r = v.el.getBoundingClientRect();
  const { x, y } = p;
  return y >= sight.top && y < sight.bottom && x >= r.left && x < r.right ? p : null;
}

/**
 * Takes the element to hold, where it is now: called once the view has held its place, so nothing has moved since
 * the last frame drew. Reading, at the pointer, else the middle of the view; not while a jump’s target holds the
 * place (view-jump.mjs), nor at the end, where a window grown taller clamps the view short of the place its anchor
 * keeps to go back to (#837), nor while a reply in sight is laid out at an estimate, which moves what’s around it as it
 * draws (#1257): once it draws, the view holds its place again and takes the hold then (holdAnchor).
 * Following, only where a click would land: a control the pointer moved onto, or anything under a click started.
 * @param {View} v
 */
export function takeHold(v) {
  v.hold = null;
  const s = box(v);
  if (!s || v.dead || !v.el.isConnected) return;
  let p = null;
  if (v.stuck) {
    p = pointerOver(v);
  } else if (v.anchor && !v.pinned && !atEnd(s)) {
    const r = v.el.getBoundingClientRect();
    p = pointerOver(v) ?? { x: r.left + r.width / 2, y: viewTop(v, s) + s.clientHeight / 2 };
  }
  if (!p) return;
  const node = document.elementFromPoint(p.x, p.y);
  const item = itemOf(v, node);
  if (!node || !item || settling(v, item)) return;
  if (v.stuck && !pressed() && !(aimed() && node.closest(CONTROL))) return;
  // Not one that isn’t laid out in its item, as an app full screen, fixed over the page: a scroll doesn’t move it.
  const r = node.getBoundingClientRect();
  const ir = item.getBoundingClientRect();
  if (r.top < ir.top - 1 || r.bottom > ir.bottom + 1) return;
  v.hold = { node, key: /** @type {string} */ (item.dataset.key), after: keyBefore(item), at: r.top, itemAt: ir.top, size: sizeOf(s), stuck: v.stuck };
}

/**
 * What holds, and where: the element held, or its item’s top once the element is gone, as when a block is drawn
 * anew in its place. Null once the item is gone from there too (an app or a block updated moves to the end, #49),
 * while the view holds a jump’s target, and once the view changed since the hold was taken: following or not, or a
 * scroll box of another size, which moves the view itself (view-state.mjs, heard); the view’s anchor holds then.
 * @param {View} v @returns {{ n: Element, at: number, item: Element } | null}
 */
export function heldNode(v) {
  const h = v.hold;
  const s = box(v);
  if (!h || !s || v.pinned || h.stuck !== v.stuck || h.size !== sizeOf(s)) return null;
  const item = v.nodes.get(h.key);
  if (!item?.isConnected || keyBefore(item) !== h.after) return null;
  if (h.node.isConnected && item.contains(h.node)) return { n: h.node, at: h.at, item };
  return { n: item, at: h.itemAt, item };
}

/**
 * Scrolls so what holds (heldNode) is back where it was, and says whether it is, noting where its item is now. A scroll
 * stopped at an end lets the hold go.
 * @param {View} v @param {{ n: Element, at: number, item: Element }} held @param {Element} s
 */
export function holdNode(v, { n, at, item }, s) {
  const d = n.getBoundingClientRect().top - at;
  if (Math.abs(d) >= 1) {
    s.scrollTop += d;
    v.lastTop = s.scrollTop;
  }
  if (!v.hold || Math.abs(n.getBoundingClientRect().top - at) >= 1) {
    v.hold = null;
    return false;
  }
  v.hold.itemAt = item.getBoundingClientRect().top;
  return true;
}
