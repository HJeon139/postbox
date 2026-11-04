// page.size() (tools/browser.mjs, sizePage): it sizes the browser’s window before the page it emulates. Headless
// Chromium starts with an 800×600 window, and a page emulated larger than its window isn’t presented past it, so a key
// typed in a composer drawn there gets no frame (#508, PF-1). A stand-in DevTools session records what it’s sent.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sizePage } from '../tools/browser.mjs';

/** A DevTools session that records each call, with its window as window 3, and a Playwright page that records media. */
function recorder() {
  const calls = [];
  const send = async (method, params) => {
    calls.push([method, params]);
    if (method === 'Browser.getWindowForTarget') return { windowId: 3 };
    return {};
  };
  const pw = { emulateMedia: async (media) => calls.push(['emulateMedia', media]) };
  return { calls, send, pw };
}

test('page.size() sizes the window to the page first, then the page it emulates', async () => {
  const { calls, send, pw } = recorder();
  await sizePage(send, pw, 1280, 900);
  const methods = calls.map(([method]) => method);
  assert.deepEqual(methods, ['Browser.getWindowForTarget', 'Browser.setWindowBounds', 'Emulation.setDeviceMetricsOverride', 'emulateMedia']);
  assert.deepEqual(calls[1][1], { windowId: 3, bounds: { width: 1280, height: 900 } });
  assert.deepEqual(calls[2][1], { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
});

test('page.size() sizes a phone’s window to the phone, at twice the scale', async () => {
  const { calls, send, pw } = recorder();
  await sizePage(send, pw, 390, 844);
  assert.deepEqual(calls[1][1], { windowId: 3, bounds: { width: 390, height: 844 } });
  assert.deepEqual(calls[2][1], { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
});
