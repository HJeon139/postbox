// Inlined after the kit, and before the app’s own code, in every app page (#438). An app’s animation loop can run
// forever, each frame costlier than the last, long after nothing changes on screen. This wraps requestAnimationFrame
// so that:
//   - while the app is off screen, which Postbox’s page tells it (app/js/apps.mjs, onScreen), its frame callbacks wait,
//     and run when it’s back in view;
//   - a loop, each frame asking for the next, that keeps drawing for IDLE_MS with no input from the person is reported
//     once to Postbox, which tells the app’s agent at its next turn. The person sees nothing: only the agent can fix
//     its app.
// An app that animates only while the person drags or clicks, or redraws on a timer, is never reported. The check’s
// hidden frames report nothing. A block, not a function: what it declares stays out of the app’s globals all the same.
{
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
  // Whether a callback runs now, so one it asks for is the next frame of a loop.
  let inFrame = false;
  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart'])
    addEventListener(
      type,
      () => {
        lastInput = performance.now();
      },
      { capture: true, passive: true },
    );

  /**
   * One frame of the app’s, at time `now`: a run of looped frames that lasts IDLE_MS with no input since its start is
   * reported. A frame asked for from outside a frame, by a timer or an event, starts a run again.
   */
  const drew = (now, looped) => {
    if (!looped || now - lastFrame > GAP_MS) runFrom = now;
    lastFrame = now;
    if (reported || now - Math.max(runFrom, lastInput) < IDLE_MS) return;
    reported = true;
    parent.postMessage({ __pb: 1, appId: init.appId, version: init.version, type: 'animating' }, '*');
  };

  // Off screen, callbacks wait in `held` by the id the app was given; once released, `released` maps that id to the
  // browser’s, so the app can still cancel it.
  let inView = true;
  const held = new Map();
  const released = new Map();
  let seq = 0;
  const run = (cb, looped, id) => (now) => {
    if (id !== undefined) released.delete(id);
    drew(now, looped);
    inFrame = true;
    try {
      cb(now);
    } finally {
      inFrame = false;
    }
  };
  window.requestAnimationFrame = (cb) => {
    if (typeof cb !== 'function') return raf(cb);
    const looped = inFrame;
    if (inView) return raf(run(cb, looped));
    const id = -++seq;
    held.set(id, { cb, looped });
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    if (held.delete(id)) return;
    if (released.has(id)) {
      caf(released.get(id));
      released.delete(id);
      return;
    }
    caf(id);
  };
  addEventListener('message', (e) => {
    const m = e.data;
    if (e.source !== parent || m?.__pb !== 1 || m.type !== 'view') return;
    inView = m.on !== false;
    if (!inView) return;
    for (const [id, { cb, looped }] of held) released.set(id, raf(run(cb, looped, id)));
    held.clear();
  });
}
