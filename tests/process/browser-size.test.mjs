// page.size() sizes the browser’s window as well as the page it emulates. Playwright’s headless Chromium starts with an
// 800×600 window, and emulating a larger page left the window as it was: a composer drawn below 600 px was off the
// surface, so typing in it presented no frame, and the key-to-frame tool’s Event Timing entries waited seconds for
// one (#508, PF-1).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { launch } from '../../tools/browser.mjs';
import { chromiumMissing } from './chrome.mjs';

const skip = await chromiumMissing();

test('page.size() makes the window exactly the size of the page it emulates', { skip, timeout: 90_000 }, async () => {
  const page = await launch();
  try {
    await page.size(1280, 900);
    await page.goto('about:blank');
    const { outer, inner } = await page.evaluate('({ outer: [outerWidth, outerHeight], inner: [innerWidth, innerHeight] })');
    assert.deepEqual(inner, [1280, 900]);
    assert.deepEqual(outer, inner, 'headless, the window has no frame: its outer size is the page’s');
  } finally {
    await page.close();
  }
});
