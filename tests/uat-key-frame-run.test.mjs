// The run’s own key-to-frame measurement (#508, tools/uat/key-frame-run.mjs): it measures the seeded room on the
// run’s page and leaves the tester an empty composer, whether or not the measurement finished.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { measureRunRoom } from '../tools/uat/key-frame-run.mjs';

/**
 * A page whose composer is on screen and that fails on its third key, as one does when the browser goes away
 * mid-measurement. It records what it was asked to run.
 */
function failingPage() {
  const ran = [];
  let keys = 0;
  const page = {
    ran,
    waitFor: async () => true,
    evaluate: async (expr) => {
      ran.push(expr);
      if (expr.includes('rect:')) return { rect: { top: 500, bottom: 560, left: 0, right: 800 }, window: { width: 1280, height: 800 } };
      if (expr.includes('getBoundingClientRect')) return { x: 400, y: 530 };
      return undefined;
    },
    send: async (method) => {
      if (method === 'Browser.getWindowForTarget') return { windowId: 1 };
      if (method === 'Browser.getWindowBounds') return { bounds: { left: 0, top: 0, width: 1280, height: 800 } };
      if (method === 'Input.dispatchKeyEvent' && ++keys > 4) throw new Error('Target closed.');
      return {};
    },
  };
  return page;
}

test('a measurement that fails partway still empties the composer of the keys it typed', async () => {
  const page = failingPage();
  const probes = { keyFrame: [] };
  const lines = [];
  await measureRunRoom({ page, root: '/repo', threadId: 'th_big', items: 1000, out: '/tmp/kf.md', probes, log: (l) => lines.push(l) });
  assert.equal(probes.keyFrame.length, 1);
  assert.equal(probes.keyFrame[0].report, null);
  assert.match(probes.keyFrame[0].error, /Target closed/);
  const typedAt = page.ran.findIndex((e) => e.includes('__keyFrame ='));
  assert.ok(typedAt >= 0, 'the measurement started recording');
  const clearedAfter = page.ran.slice(typedAt + 1).some((e) => e.includes("ta.value = ''"));
  assert.ok(clearedAfter, 'the draft was emptied after the keys were typed');
});
