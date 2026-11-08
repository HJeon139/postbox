// Which agent app frame is under the pointer, and so takes pointer events (#38). The frame that is is “live”;
// apps.mjs’s focus and send rules read it. Why frames take no pointer events until then is in apps.mjs, “Sends in
// your voice”.

/** @type {(el: Element | null | undefined) => boolean} whether an element is a mounted app frame; apps.mjs sets it */
let isAppFrame = () => false;
/** @param {(el: Element | null | undefined) => boolean} test */
export function setAppFrameTest(test) {
  isAppFrame = test;
}

/** @type {HTMLIFrameElement | null} the app frame under the pointer */
export let live = null;

// The app bodies near the view (apps.mjs keeps it: its IntersectionObserver’s, and app reviews while mounted). While
// there are none and no frame is live, no app can be under the pointer, so the page doesn’t look (#930): a look is a
// layout of the whole page, and a change anywhere on it asked for one, a frame at a time.
/** @type {Set<Element>} */
export const nearBodies = new Set();
const mayBeUnder = () => nearBodies.size > 0 || live !== null;

function makeLive(f) {
  if (f === live) return;
  const was = live;
  live = f;
  f?.classList.add('live');
  if (was && was !== f) was.classList.remove('live');
}

/**
 * The app frame at a point of the window, if one is there and nothing of the page covers it. A frame that isn’t
 * live takes no pointer events, so the page finds the element around it (its .app-body) instead.
 * @param {number} x @param {number} y
 */
function frameAt(x, y) {
  const el = document.elementFromPoint(x, y);
  const f = el instanceof HTMLIFrameElement ? el : el?.closest('.app-body')?.querySelector('iframe.app-iframe');
  if (!(f instanceof HTMLIFrameElement) || !isAppFrame(f)) return null;
  const r = f.getBoundingClientRect();
  return x >= r.left && x < r.right && y >= r.top && y < r.bottom ? f : null;
}

// Where the pointer last was on this page. It stays put while the page moves under it (a reply streaming in,
// the wheel, a message landing above), so an app that moves under a resting pointer becomes live, and one that
// moves away stops being live, without the pointer moving (#38). Inside a live frame the page doesn’t see the
// pointer move, so this is where it went in: close enough, and any move over the page corrects it.
/** @type {{ x: number, y: number } | null} */
let pointer = null;
function onPointer(e) {
  pointer = { x: e.clientX, y: e.clientY };
  if (mayBeUnder()) makeLive(frameAt(e.clientX, e.clientY));
}
for (const type of ['pointermove', 'pointerover', 'pointerdown']) addEventListener(type, onPointer, true);

let relook = 0;
/** Looks again, next frame, for the app frame under a resting pointer; apps.mjs calls it when an app comes near. */
export function relookSoon() {
  if (!pointer || relook || !mayBeUnder()) return;
  relook = requestAnimationFrame(() => {
    relook = 0;
    if (pointer) makeLive(frameAt(pointer.x, pointer.y));
  });
}
addEventListener('scroll', relookSoon, { capture: true, passive: true });
addEventListener('resize', relookSoon);
// The transcript renders, an item is added, or an app resizes: what’s under the pointer may have changed.
new MutationObserver(relookSoon).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
