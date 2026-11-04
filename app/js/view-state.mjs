// The transcript’s view (#508’s design, “Browser”): following the newest message, or reading at an anchor, a message
// and how far down the view it starts. Only your own scrolling changes which; every change in size re-applies it.
// It owns that state for one transcript, holds the anchor through changes in size (#88, #297, #341), and publishes what
// it is on the transcript as data-view-* (view-publish.mjs). Moved from thread.mjs’s mountTranscript (#531).

import { anchorIn } from './view-anchor.mjs';
import { register, unregister } from './view-jump.mjs';
import { publish } from './view-publish.mjs';
import { skipOffscreen } from './view-skip.mjs';

/**
 * @typedef {{ el: HTMLElement, inPanel: boolean, nodes: Map<string, HTMLElement>, unseen: number, stuck: boolean,
 *   anchor: { key: string, at: number } | null, pinned: boolean, dead: boolean, shown: number, lastTop: number,
 *   held: { end: number, last: number, width: number }, jump: ((n: number) => void) | null, bound: any, size: string,
 *   sizes: ResizeObserver, changes: MutationObserver }} View
 */

const box = (/** @type {View} */ v) => (v.inPanel ? v.el.parentElement : document.scrollingElement);
const viewTop = (/** @type {View} */ v, /** @type {Element} */ s) => (v.inPanel ? s.getBoundingClientRect().top : 0);
const gapOf = (/** @type {Element} */ s) => s.scrollHeight - s.scrollTop - s.clientHeight;
// At the bottom, give or take a pixel of rounding.
const atEnd = (/** @type {Element} */ s) => gapOf(s) <= 2;
// The pill floats just above the composer. It shows only while the end is further below than that, so what it
// floats over is never the working rows or the end of the last message (#91).
const PILL_ROOM = 48;
/** @param {View} v @param {Element | null} s */
function showJump(v, s) {
  const n = s && gapOf(s) > PILL_ROOM ? v.unseen : 0;
  if (n !== v.shown) v.jump?.((v.shown = n));
}
// The anchor is the message across the middle of the view, where you read, not the first one in view: that one
// usually starts above the view, and when a narrower column (the panel, a smaller window) rewraps it, everything
// under it moves. A wide font rewraps it where macOS’s doesn’t (#88, seen on Linux in #162).
// It runs on every scroll event, so it halves its way to the middle rather than reading every reply above it: in a
// room of 1,000 replies, a dozen rects instead of a thousand (#572).
/** @param {View} v */
function findAnchor(v) {
  const s = box(v);
  return s ? anchorIn(v.el, s, viewTop(v, s)) : null;
}
/** @param {View} v */
function holdAnchor(v) {
  const s = box(v);
  const n = v.anchor && v.nodes.get(v.anchor.key);
  if (!s || !n?.isConnected || !v.anchor) return;
  const d = n.getBoundingClientRect().top - viewTop(v, s) - v.anchor.at;
  if (Math.abs(d) < 1) return;
  s.scrollTop += d;
  v.lastTop = s.scrollTop;
}
/** @param {View} v */
function seen(v) {
  v.unseen = 0;
  showJump(v, null);
}
/** @param {View} v @param {boolean} [smooth] */
function scrollToEnd(v, smooth = false) {
  v.stuck = true;
  v.pinned = false;
  const s = box(v);
  if (s && smooth && !v.inPanel && !matchMedia('(prefers-reduced-motion: reduce)').matches)
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
  else if (s) s.scrollTop = s.scrollHeight;
  seen(v);
}
// While stuck, what comes after the newest message shrinking (a working row going, a card getting shorter once
// answered, the composer) would shorten the page and pull everything down, under your pointer, just as a card
// that needs you arrives. Instead the transcript keeps its height, until the next message or a new width.
/** @param {View} v */
function lastItem(v) {
  for (let n = v.el.lastElementChild; n; n = n.previousElementSibling) {
    if (n instanceof HTMLElement && n.dataset.key) return n;
  }
  return null;
}
/** @param {View} v @param {Element} s */
const measure = (v, s) => ({
  end: s.scrollHeight,
  last: (lastItem(v)?.getBoundingClientRect().top ?? 0) - viewTop(v, s) + s.scrollTop,
  width: v.el.clientWidth,
});
/** @param {View} v */
function release(v) {
  if (v.el.style.minHeight) v.el.style.minHeight = '';
}
// After anything changes size: back to the bottom while stuck, else keep what you were reading in place.
/** @param {View} v */
function follow(v) {
  const s = box(v);
  if (!s || v.dead) return;
  // You scrolled up in this frame, before its scroll event: that counts, so don’t pull you back.
  if (v.stuck && s.scrollTop < v.lastTop - 1 && !atEnd(s)) {
    v.stuck = false;
    v.anchor = findAnchor(v);
    // The anchor is taken where the view now is, so that scroll is heard: heard() below mustn’t take it in again.
    v.lastTop = s.scrollTop;
  }
  if (v.stuck) {
    const now = measure(v, s);
    if (now.width !== v.held.width) release(v);
    else if (now.end < v.held.end && Math.abs(now.last - v.held.last) < 1 && v.held.end > s.clientHeight)
      v.el.style.minHeight = `${v.el.getBoundingClientRect().height + v.held.end - now.end}px`;
    if (!atEnd(s)) s.scrollTop = s.scrollHeight;
    v.held = measure(v, s);
  } else {
    heard(v, s);
    holdAnchor(v);
  }
  showJump(v, s);
}
/** The scroll box’s size, to tell a scroll from the browser keeping the view in a box that changed size. @param {Element} s */
const sizeOf = (s) => `${s.clientWidth}x${s.clientHeight}`;
/**
 * A scroll the transcript hasn’t heard of yet: its event comes in the next frame, after this resize (#341). It moved
 * the anchor by that much, so the place to hold is there, not where the last scroll event left it. A box that changed
 * size (the window, the panel) moves the view itself, and that isn’t you: the anchor holds as before (#88).
 * @param {View} v @param {Element} s
 */
function heard(v, s) {
  const unheard = s.scrollTop - v.lastTop;
  if (!v.anchor || Math.abs(unheard) < 1) return;
  if (sizeOf(s) !== v.size) return;
  v.anchor = { key: v.anchor.key, at: v.anchor.at - unheard };
  v.lastTop = s.scrollTop;
}
// Only your own scrolling unsticks the view: content growing never scrolls, and the browser doesn’t anchor
// (overflow-anchor is off), so the view moving up means you moved it, by wheel, keys or a drag, even over an app.
/** @param {View} v */
function onScroll(v) {
  const s = box(v);
  if (!s) return;
  // The event for a scroll the transcript made itself, holding what you read in place, comes in a later frame, maybe
  // after what’s above has moved again: hold it in place again before taking the anchor there, or you lose your place
  // (#297).
  const moved = s.scrollTop !== v.lastTop;
  if (atEnd(s)) {
    if (!v.stuck) v.held = measure(v, s);
    v.stuck = true;
  } else if (s.scrollTop < v.lastTop) v.stuck = false;
  // However you got near the end, there’s nothing unread below any more (#91).
  if (gapOf(s) <= PILL_ROOM) seen(v);
  v.lastTop = s.scrollTop;
  v.size = sizeOf(s);
  if (moved) v.pinned = false;
  if (v.stuck) return;
  if (!moved) holdAnchor(v);
  // Our own hold after a jump: the target stays the anchor while what’s between it and the middle draws (#712).
  if (v.pinned) return;
  v.anchor = findAnchor(v);
}
/** @param {View} v @param {() => void} scrolled @param {() => void} resized */
function bind(v, scrolled, resized) {
  const s = box(v);
  if (v.bound || !s || !v.el.isConnected) return;
  v.bound = v.inPanel ? s : window;
  v.bound.addEventListener('scroll', scrolled, { passive: true });
  addEventListener('resize', resized);
  v.sizes.observe(v.el);
  // What’s around it changing moves the end too: the composer, the panel’s height, the thread’s root above. A shrink
  // there clamps the view like one in the transcript, so its changes are noted the same way (#360). The panel’s
  // composer isn’t beside the transcript: it’s in the panel’s foot, under the scroll box.
  const parent = v.el.parentElement;
  const around = parent ? [...parent.children].filter((n) => n !== v.el) : [];
  const foot = v.inPanel ? v.el.closest('.sidepanel')?.querySelector('.sp-foot') : null;
  if (parent) v.sizes.observe(parent);
  for (const n of foot ? [...around, foot] : around) {
    v.sizes.observe(n);
    v.changes.observe(n, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
  }
}
/**
 * Once the transcript is on the page: to the newest message, or back where you were before a rebuild.
 * @param {View} v @param {() => void} scrolled @param {() => void} resized
 */
function settle(v, scrolled, resized) {
  // A rebuild can replace this transcript before the frame it was to settle in.
  if (v.dead) return;
  bind(v, scrolled, resized);
  const s = box(v);
  if (v.stuck) scrollToEnd(v);
  else holdAnchor(v);
  if (s) {
    showJump(v, s);
    v.held = measure(v, s);
  }
  v.lastTop = s?.scrollTop ?? 0;
  if (s) v.size = sizeOf(s);
}
/**
 * After the transcript is drawn again from new state (a load, after a restart or a Retry): an anchor that’s no longer
 * there is taken again where the view is, so what’s published names an item on the page.
 * @param {View} v
 */
function rebuilt(v) {
  const kept = v.anchor && v.nodes.get(v.anchor.key)?.isConnected;
  if (!v.stuck && !kept) v.anchor = findAnchor(v);
}
// What arrived counts as unseen when the view isn’t on the newest message, including when follow() finds you
// scrolled up in this frame, before its scroll event told the transcript (#341).
/** @param {View} v */
function grew(v) {
  if (v.stuck) follow(v);
  if (!v.stuck) {
    v.unseen++;
    showJump(v, box(v));
  }
}

/**
 * After a jump has put item where it was sent: it’s the anchor, kept until you scroll (#712, view-jump.mjs).
 * @param {View} v @param {HTMLElement} item
 */
function pin(v, item) {
  const s = box(v);
  if (!s || v.dead) return;
  v.stuck = atEnd(s);
  v.pinned = !v.stuck;
  if (v.stuck) v.held = measure(v, s);
  v.anchor = { key: /** @type {string} */ (item.dataset.key), at: item.getBoundingClientRect().top - viewTop(v, s) };
  v.lastTop = s.scrollTop;
  if (gapOf(s) <= PILL_ROOM) seen(v);
  showJump(v, s);
  publish(v);
}
/** What view-jump.mjs needs of a view. @param {View} v */
const jumpable = (v) => ({
  box: () => box(v),
  seen: () => inSight(v),
  pin: (/** @type {HTMLElement} */ item) => pin(v, item),
});
/**
 * Where what you can see of the view starts and ends, in the page's y: the panel's scroll box, or the window below
 * the main pane's sticky top bar.
 * @param {View} v
 */
function inSight(v) {
  const s = /** @type {Element} */ (box(v));
  if (v.inPanel) {
    const r = s.getBoundingClientRect();
    return { top: r.top, bottom: r.top + s.clientHeight };
  }
  const bar = document.querySelector('header.topbar')?.getBoundingClientRect().bottom ?? 0;
  return { top: Math.max(0, bar), bottom: s.clientHeight };
}

/**
 * A view’s state as it starts: following, unless it comes back from a rebuild while reading (was). Its observers are
 * added by mountView.
 * @param {{ el: HTMLElement, inPanel: boolean, nodes: Map<string, HTMLElement>, was?: { anchor: any, unseen: number } }} o
 * @returns {View}
 */
function newView({ el, inPanel, nodes, was }) {
  return /** @type {any} */ ({
    el,
    inPanel,
    nodes,
    unseen: was?.unseen ?? 0,
    stuck: !was,
    anchor: was?.anchor ?? null,
    pinned: false,
    dead: false,
    shown: -1,
    lastTop: 0,
    held: { end: 0, last: 0, width: 0 },
    jump: null,
    bound: null,
    size: '',
  });
}
/**
 * The view of one transcript.
 * @param {{ el: HTMLElement, inPanel: boolean, nodes: Map<string, HTMLElement>, was?: { anchor: any, unseen: number } }} o
 */
export function mountView({ el, inPanel, nodes, was }) {
  const v = newView({ el, inPanel, nodes, was });
  // Each way in that can change the mode or the anchor without a scroll event of its own ends by publishing: a scroll,
  // the end, a reply in the frame you scrolled in (#341), a redraw from new state, and mounting. An item moved ends in
  // grew(), so it publishes there. A resize or a settle that moves the view does it by scrolling, and its scroll event
  // publishes in the next frame.
  /** @template {any[]} A @param {(...a: A) => any} fn */
  const thenPublish =
    (fn) =>
    (/** @type {A} */ ...a) => {
      const r = fn(...a);
      publish(v);
      return r;
    };
  const resized = () => follow(v);
  const scrolled = thenPublish(() => onScroll(v));
  v.sizes = new ResizeObserver(resized);
  skipOffscreen(el);
  // A change that makes the transcript shorter while stuck (a held height released, an app’s check giving way to its
  // frame) pulls the view up to the page’s new end. That isn’t you, but its scroll event can come after the page grew
  // back, and read as you scrolling up (#297). So note where the view is, if it’s at the new end: a wheel turn moves it
  // before its scroll event too, and only that one leaves it above the end.
  v.changes = new MutationObserver(() => {
    const s = box(v);
    if (v.stuck && s && !v.dead && atEnd(s)) v.lastTop = Math.min(v.lastTop, s.scrollTop);
  });
  v.changes.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
  publish(v);
  register(el, jumpable(v));
  return {
    settle: () => settle(v, scrolled, resized),
    scrollToEnd: thenPublish((/** @type {boolean} */ smooth) => scrollToEnd(v, smooth)),
    grew: thenPublish(() => grew(v)),
    rebuilt: thenPublish(() => rebuilt(v)),
    release: () => release(v),
    setJump: (/** @type {(n: number) => void} */ fn) => (v.jump = fn),
    /** An item moved to the end (item.move): if it was the anchor, its stub holds the place. */
    moved(/** @type {string} */ id, /** @type {string} */ stubId) {
      if (v.anchor?.key === id) v.anchor = { key: stubId, at: Math.max(0, v.anchor.at) };
    },
    /** Where you were reading, to keep through a rebuild; null while following. */
    keep() {
      if (v.stuck || !el.isConnected) return null;
      return { anchor: findAnchor(v) ?? v.anchor, unseen: v.unseen };
    },
    destroy() {
      v.dead = true;
      unregister(el);
      v.sizes.disconnect();
      v.changes.disconnect();
      v.bound?.removeEventListener('scroll', scrolled);
      removeEventListener('resize', resized);
    },
  };
}
