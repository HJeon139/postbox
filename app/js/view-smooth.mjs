// Whether you did something while the smooth jump to the end ran (view-state.mjs, scrollToEnd). Where it stops is no
// guide: items it passes draw at their real sizes on the way, and where they’re shorter than their estimates, as the
// Mac’s fonts draw them, the page shortens under it and the scroll ends short of where it was aimed with nobody
// stopping it (view-skipped-smooth.spec.mjs). A wheel turn, a touch, a press or a key is you stopping it.

const INPUTS = ['wheel', 'touchstart', 'pointerdown', 'keydown'];

/**
 * Calls done once the smooth scroll ends (scrollend), saying whether any input of yours came while it ran.
 * @param {(stoppedByYou: boolean) => void} done
 */
export function whenSmoothEnds(done) {
  let came = false;
  const heard = () => {
    came = true;
  };
  for (const type of INPUTS) addEventListener(type, heard, { capture: true, passive: true });
  const ended = () => {
    for (const type of INPUTS) removeEventListener(type, heard, { capture: true });
    done(came);
  };
  addEventListener('scrollend', ended, { once: true });
}
