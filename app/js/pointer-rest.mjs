// Where the mouse rests, for what holds still under it (#1326): the transcript’s view (view-hold.mjs) and an agent
// sheet (sheet-hold.mjs). Each hears of a move, a press or a let-go once a frame.

// The mouse’s place in the window, whether it moved there since the last click (aimed), and whether a click has
// started there: null outside the window, or when the last pointer was a finger, which rests nowhere. Inside an app’s
// frame the page doesn’t see the pointer move, so this is where it went in, on the frame, and a click there takes
// the focus from the page (blur), which ends the aim as a click on the page does, and as a wheel turn does.
/** @type {{ x: number, y: number } | null} */
let at = null;
let aimedNow = false;
let pressedNow = false;
/** @type {Set<() => void>} the answer of each view and sheet that holds still under the pointer */
const listeners = new Set();
let soon = 0;
function tell() {
  if (soon) return;
  soon = requestAnimationFrame(() => {
    soon = 0;
    for (const fn of listeners) fn();
  });
}
/** @param {PointerEvent} e */
function onPointer(e) {
  if (e.pointerType === 'touch') {
    at = null;
    pressedNow = false;
    return;
  }
  at = { x: e.clientX, y: e.clientY };
  if (e.type === 'pointermove') aimedNow = true;
  if (e.type === 'pointerdown') pressedNow = true;
  if (e.type === 'pointerup' || e.type === 'pointercancel') pressedNow = aimedNow = false;
  tell();
}
for (const type of ['pointermove', 'pointerdown', 'pointerup', 'pointercancel']) addEventListener(type, onPointer, { capture: true, passive: true });
document.documentElement.addEventListener('pointerleave', (e) => {
  if (e.clientX > 0 && e.clientY > 0 && e.clientX < innerWidth && e.clientY < innerHeight) return;
  at = null;
  pressedNow = aimedNow = false;
  tell();
});
// A wheel turn scrolls with the pointer where it is: it aims at nothing until the pointer moves again.
addEventListener(
  'wheel',
  () => {
    aimedNow = false;
    tell();
  },
  { capture: true, passive: true },
);
addEventListener('blur', () => {
  pressedNow = aimedNow = false;
  tell();
});

/** Calls fn, a frame after the pointer moves, presses or lets go; returns how to stop. @param {() => void} fn */
export function onPointerMoved(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Where the mouse is in the window, or null. */
export const pointer = () => at;
/** Whether it moved since the last click: aimed at something, as a click on its way. */
export const aimed = () => aimedNow;
/** Whether a click has started: pressed, not yet let go. */
export const pressed = () => pressedNow;
