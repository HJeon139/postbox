// A stand-in for the UAT runner’s page (tools/browser.mjs) over a Playwright page, so a spec drives the runner’s own
// code against the real app.

/**
 * tools/browser.mjs’s page, over this one: evaluate, the frame an element shows, and send, whose key presses `onKey`
 * sees first.
 *
 * Its session sets the window’s size, as tools/browser.mjs’s size() does on the one session it shoots with. Left to
 * Playwright’s own session, a shot sent on this one shrank the window on macOS (800 to 713 px tall), and the view’s
 * middle, and so its anchor, moved with it.
 */
export async function runnerPage(page, onKey = async () => {}) {
  const cdp = await page.context().newCDPSession(page);
  const { width, height } = /** @type {{ width: number, height: number }} */ (page.viewportSize());
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  return {
    evaluate: (/** @type {string} */ expr) => page.evaluate(expr),
    waitFor: (/** @type {string} */ expr) => page.waitForFunction(expr),
    frameOf: async (/** @type {string} */ expr) => {
      const handle = await page.evaluateHandle(expr);
      const frame = (await handle.asElement()?.contentFrame()) ?? null;
      await handle.dispose();
      return frame;
    },
    send: async (/** @type {string} */ method, /** @type {any} */ params) => {
      if (method === 'Input.dispatchKeyEvent' && params.type === 'keyDown') await onKey(params.key);
      return cdp.send(/** @type {any} */ (method), params);
    },
  };
}
