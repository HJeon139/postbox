// The UAT driver’s clicks (tools/uat/driver.mjs): where it clicks, and how it gets there.

import { sleep } from '../browser.mjs';
import { JUMP } from './selectors.mjs';

/**
 * The click the driver makes on page, measuring through ev, and telling runnerClick first.
 * @param {any} page @param {(expr: string) => Promise<any>} ev @param {() => void} runnerClick
 */
export function pointer(page, ev, runnerClick) {
  /**
   * Clicks the centre of the first element that matches. As a person does, it scrolls only when it can’t reach that
   * centre where it is, off screen or under the top bar or the composer, and then to the middle, clear of both (#531).
   */
  async function clickAt(findExpr, what) {
    runnerClick();
    const r = await ev(`(async () => {
      const el = ${findExpr};
      if (!el) return null;
      const at = el.getBoundingClientRect();
      if (!el.contains(document.elementFromPoint(at.left + at.width / 2, at.top + at.height / 2))) ${JUMP('el', 'center')};
      const b = el.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    })()`);
    if (!r) throw new Error(`Couldn’t find ${what} on screen.`);
    await sleep(120);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
      await page.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
    await sleep(250);
  }
  return { clickAt };
}
