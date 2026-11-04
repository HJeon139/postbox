// PF-1’s key-to-frame measurement on one open conversation (#508, tools/key-frame-measure.mjs): it refuses a composer
// outside the browser’s real window, which it reads from Chromium, not from the page’s outerHeight.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { measureKeys } from '../tools/key-frame-measure.mjs';

/**
 * A page emulating a tall phone screen in a shorter window: outerHeight follows the emulation, 1,000 px, while the
 * window Chromium reports is 800 px, and the composer ends at 900 px. It types nothing: no key is ever sent.
 */
function emulatedPage() {
  const sent = [];
  const page = {
    sent,
    waitFor: async () => true,
    evaluate: async (expr) => {
      if (expr.includes('rect:')) return { rect: { top: 860, bottom: 900, left: 0, right: 390 }, window: { width: 390, height: 1000 } };
      if (expr.includes('getBoundingClientRect')) return { x: 195, y: 880 };
      return undefined;
    },
    send: async (method, params) => {
      sent.push(method);
      if (method === 'Browser.getWindowForTarget') return { windowId: 7 };
      if (method === 'Browser.getWindowBounds') return params?.windowId === 7 ? { bounds: { left: 0, top: 0, width: 390, height: 800 } } : {};
      return {};
    },
  };
  return page;
}

test('a composer below the window Chromium reports is refused, even when the emulated outerHeight would hold it', async () => {
  const page = emulatedPage();
  await assert.rejects(measureKeys(page, { keys: 1, warmup: 0, intervalMs: 1 }), /ends at 900 px, below the window’s 800 px/);
  assert.equal(page.sent.includes('Input.dispatchKeyEvent'), false, 'no key was typed');
});
