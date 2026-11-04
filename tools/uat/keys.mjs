// A key press in the page, as the UAT driver (tools/uat/driver.mjs) types one: down and up over the DevTools protocol.

import { sleep } from '../browser.mjs';

/**
 * Presses Enter, Escape, Tab, PageUp, PageDown, End or Home. @param {any} page  from tools/browser.mjs launch()
 * @param {string} key
 */
export async function pressKey(page, key) {
  const codes = { Enter: 13, Escape: 27, Tab: 9, PageUp: 33, PageDown: 34, End: 35, Home: 36 };
  for (const type of ['keyDown', 'keyUp'])
    await page.send('Input.dispatchKeyEvent', {
      type,
      key,
      code: key,
      windowsVirtualKeyCode: codes[key],
      ...(type === 'keyDown' && key === 'Enter' ? { text: '\r' } : {}),
    });
  await sleep(150);
}
