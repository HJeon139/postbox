// What an app has under a region the person marked in its review (#856), for the agent: the page asks the kit already
// in the app’s frame (app/kit/kit.js, probe), so no script of Postbox’s goes into the app. The answer is the app’s own
// data, so it’s cut and checked (shared/review-regions.mjs, underOf), and an app that doesn’t answer in time leaves the
// region without it: the comment never waits on the app.

import { underOf } from '/shared/review-regions.mjs';

/** How long the page waits for the kit’s answer, in ms. */
const WAIT_MS = 1500;
let asked = 0;

/**
 * What the app has under a region, or null when it doesn’t answer in time or answers with nothing usable.
 * @param {HTMLIFrameElement | null} frame  the app’s @param {{ x: number, y: number, w: number, h: number }} r  in px of its page
 * @returns {Promise<any>}
 */
export function probeRegion(frame, r) {
  const win = frame?.contentWindow;
  if (!win) return Promise.resolve(null);
  const id = `probe-${++asked}`;
  return new Promise((resolve) => {
    const done = (/** @type {any} */ under) => {
      clearTimeout(timer);
      removeEventListener('message', heard);
      resolve(under);
    };
    // Only this frame’s answer to this question, from a sandboxed page, as the bridge takes it (apps.mjs).
    const heard = (/** @type {MessageEvent} */ e) => {
      const m = e.data;
      if (e.source !== win || e.origin !== 'null' || m?.__pb !== 1 || m.type !== 'probed' || m.id !== id) return;
      done(underOf(m));
    };
    const timer = setTimeout(() => done(null), WAIT_MS);
    addEventListener('message', heard);
    win.postMessage({ __pb: 1, type: 'probe', id, x: r.x, y: r.y, w: r.w, h: r.h }, '*');
  });
}
