// Inlined after the kit, and before the app’s own code, in every app page (#438). An app’s animation loop can run
// forever, each frame costlier than the last, long after nothing changes on screen. This wraps requestAnimationFrame to
// count the app’s frames: a run of them, each starting within GAP_MS of the end of the last one’s work, that lasts
// IDLE_MS with no input from the person is reported once to Postbox, which tells the app’s agent at its next turn. The
// person sees nothing: only the agent can fix its app. A run is judged by its frames, however the app asks for them: a
// loop, a timer asking for frames, or an async step that waits before the next. An app that animates only while the
// person drags or clicks, or redraws now and then, is never reported. The check’s hidden frames report nothing. A
// browser already runs no frames for an app off screen, so a run ends there by itself.
{
  const init = JSON.parse(document.querySelector('script[data-init]')?.dataset.init || '{}');
  // A browser spec sets a shorter time before the page loads (tests/browser/app-animating.spec.mjs); the app’s own code
  // runs after this script, so it can’t.
  const IDLE_MS = Number(window.__pbIdleMs) > 0 ? Number(window.__pbIdleMs) : 30_000;
  // A rest this long between one frame’s work and the next frame ends a run: a tab in the background or an app off
  // screen draws none, and a loop that rests this long isn’t drawing every frame.
  const GAP_MS = 200;
  const raf = window.requestAnimationFrame.bind(window);
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

  /** One frame of the app’s, at time `now`: a run that lasts IDLE_MS with no input since its start is reported. */
  const drew = (now) => {
    if (now - lastFrame > GAP_MS) runFrom = now;
    lastFrame = now;
    if (reported || now - Math.max(runFrom, lastInput) < IDLE_MS) return;
    reported = true;
    parent.postMessage({ __pb: 1, appId: init.appId, version: init.version, type: 'animating' }, '*');
  };
  window.requestAnimationFrame = (cb) => {
    if (typeof cb !== 'function') return raf(cb);
    return raf((now) => {
      drew(now);
      try {
        cb(now);
      } finally {
        // The next frame’s gap counts from where this one’s work ended, so a loop whose every frame is slow runs on.
        lastFrame = performance.now();
      }
    });
  };
}
