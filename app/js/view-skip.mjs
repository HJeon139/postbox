// Skipped items (#712): the transcript keeps every item mounted, and the browser skips the layout and paint of those off
// screen (`content-visibility: auto` on `.transcript.cv-skip > .item`, app/workbench.css), laying each out at an
// estimate until it draws. An item drawing for the first time changes size, and the view (view-state.mjs) holds the
// anchor: through its ResizeObserver on the transcript, and on each item's draw (DRAWN), since a draw inside the height
// the transcript holds while following changes nothing that observer sees (composer-grow.spec.mjs, #422).

/** The event a skipped item gets when it's drawn or skipped again; heard in capture, whether or not it bubbles. */
export const DRAWN = 'contentvisibilityautostatechange';

/** The class on a transcript whose items the browser may skip. */
export const SKIP_CLASS = 'cv-skip';

/**
 * Lets the browser skip the transcript's items off screen, where it can: now, or once the window lets it go.
 * @param {HTMLElement} el  the transcript
 */
export function skipOffscreen(el) {
  if (typeof CSS === 'undefined' || !CSS.supports('content-visibility', 'auto')) return;
  el.dataset.skip = 'wanted';
  if (!el.dataset.window) el.classList.add(SKIP_CLASS);
}

/**
 * A transcript the window holds (#866, window.mjs) mounts only the items near the view, and must measure them at their
 * real heights, so skipping is off while it holds it, and on again when it lets go if the transcript wants it,
 * whichever came first. The one place that decides.
 * @param {HTMLElement} el  the transcript  @param {boolean} held
 */
export function holdSkipping(el, held) {
  if (held) {
    el.dataset.window = 'on';
    el.classList.remove(SKIP_CLASS);
    return;
  }
  delete el.dataset.window;
  if (el.dataset.skip === 'wanted') el.classList.add(SKIP_CLASS);
}

/**
 * How many draws hold each item: two can overlap on one (a jump’s second placement, or drawNewest on a jump’s target),
 * and the item is let go when the last is. Nothing else sets content-visibility inline.
 * @type {WeakMap<HTMLElement, number>}
 */
const holders = new WeakMap();

/**
 * Draws a skipped item now, at its real size, and lets the browser skip it again once it has painted, when it has
 * remembered that size (contain-intrinsic-size: auto). For an item that must not first lay out at its estimate: a
 * jump’s target (view-jump.mjs), and a message appended while the view follows, which would otherwise make the view
 * scroll twice, a frame apart (view-skipped-append.spec.mjs). Returns a function that lets it be skipped again now.
 * @param {HTMLElement} item  @returns {() => void}
 */
export function drawUntilPainted(item) {
  holders.set(item, (holders.get(item) ?? 0) + 1);
  item.style.contentVisibility = 'visible';
  // The pending release holds the item weakly: a redraw as a room is left would otherwise keep that room's whole page
  // alive through the item's parents until two frames have passed (page-leak.spec.mjs, #1246).
  const ref = new WeakRef(item);
  let done = false;
  const release = () => {
    const held = ref.deref();
    if (done || !held) return;
    done = true;
    const left = /** @type {number} */ (holders.get(held)) - 1;
    holders.set(held, left);
    if (!left) held.style.removeProperty('content-visibility');
  };
  requestAnimationFrame(() => requestAnimationFrame(release));
  return release;
}

/** Each transcript’s newest message drawn by drawNewest, and how to let it be skipped again. */
const newest = /** @type {WeakMap<Element, { item: Element, release: () => void }>} */ (new WeakMap());

/**
 * Draws the transcript’s newest message until it has painted: its last keyed child, since the working rows come after
 * it. Only one at a time: messages arriving together, before a frame (a burst of events after a lag), would otherwise
 * all be drawn, and each append would lay out every one of them again (view-skipped-tab.spec.mjs, lagged).
 * @param {HTMLElement} el  the transcript
 */
export function drawNewest(el) {
  let last = el.lastElementChild;
  while (last && !(last instanceof HTMLElement && last.dataset.key)) last = last.previousElementSibling;
  if (!(last instanceof HTMLElement)) return;
  const was = newest.get(el);
  if (was?.item === last) return;
  was?.release();
  newest.set(el, { item: last, release: drawUntilPainted(last) });
}
