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
 * Lets the browser skip the transcript's items off screen, where it can.
 * @param {HTMLElement} el  the transcript
 */
export function skipOffscreen(el) {
  if (typeof CSS === 'undefined' || !CSS.supports('content-visibility', 'auto')) return;
  el.classList.add(SKIP_CLASS);
}

/**
 * Draws a skipped item now, at its real size, and lets the browser skip it again once it has painted, when it has
 * remembered that size (contain-intrinsic-size: auto). For an item that must not first lay out at its estimate: a
 * jump’s target (view-jump.mjs), and a message appended while the view follows, which would otherwise make the view
 * scroll twice, a frame apart (view-skipped-append.spec.mjs). Returns a function that lets it be skipped again now.
 * @param {HTMLElement} item  @returns {() => void}
 */
export function drawUntilPainted(item) {
  const was = item.style.contentVisibility;
  item.style.contentVisibility = 'visible';
  let done = false;
  const release = () => {
    if (done) return;
    done = true;
    item.style.contentVisibility = was;
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
