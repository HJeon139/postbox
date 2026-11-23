// Inlined after the kit, and before the app’s own code, in every app page (#438). An app’s animation loop can run forever, each frame
// costlier than the last, long after nothing changes on screen. This wraps requestAnimationFrame so that:
//   - while the app is off screen, its frame callbacks wait, and run when it’s back in view;
//   - a loop that keeps drawing for IDLE_MS with no input from the person is reported once to Postbox, which tells
//     the app’s agent at its next turn. The person sees nothing: only the agent can fix its app.
// An app that animates only while the person drags or clicks is never reported. The check’s hidden frames report
// nothing.
(function () {
  const init = JSON.parse(document.querySelector('script[data-init]')?.dataset.init || '{}');
  // A browser spec sets a shorter time before the page loads (tests/browser/app-animating.spec.mjs); the app’s own code
  // runs after this script, so it can’t.
  const IDLE_MS = Number(window.__pbIdleMs) > 0 ? Number(window.__pbIdleMs) : 30_000;
  // A gap this long between frames ends a run of drawing: the loop stopped, or the browser paused it.
  const GAP_MS = 1_000;
  const raf = window.requestAnimationFrame.bind(window);
  const caf = window.cancelAnimationFrame.bind(window);
  let lastInput = performance.now();
  let runFrom = 0;
  let lastFrame = 0;
  let reported = !!init.check;
  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart'])
    addEventListener(
      type,
      () => {
        lastInput = performance.now();
      },
      { capture: true, passive: true },
    );

  /** One frame of the app’s, at time `now`: a long enough run with no input since its start is reported. */
  const drew = (now) => {
    if (now - lastFrame > GAP_MS) runFrom = now;
    lastFrame = now;
    if (reported || now - Math.max(runFrom, lastInput) < IDLE_MS) return;
    reported = true;
    parent.postMessage({ __pb: 1, appId: init.appId, version: init.version, type: 'animating' }, '*');
  };

  // Off screen, callbacks wait here, by the id the app was given, until the app is in view again.
  let inView = true;
  const held = new Map();
  let seq = 0;
  const run = (cb) => (now) => {
    drew(now);
    cb(now);
  };
  window.requestAnimationFrame = (cb) => {
    if (typeof cb !== 'function') return raf(cb);
    if (inView) return raf(run(cb));
    const id = -++seq;
    held.set(id, cb);
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    if (held.delete(id)) return;
    caf(id);
  };
  if (window.IntersectionObserver)
    new IntersectionObserver((entries) => {
      inView = entries.at(-1)?.isIntersecting ?? true;
      if (!inView) return;
      const waiting = [...held.values()];
      held.clear();
      for (const cb of waiting) raf(run(cb));
    }).observe(document.documentElement);
})();
