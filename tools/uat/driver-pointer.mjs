// The UAT driver’s clicks (tools/uat/driver.mjs): where it clicks, and how it gets there.

import { sleep } from '../browser.mjs';
import { JUMP } from './selectors.mjs';

/** A move of more than this, in px, between the runner aiming and clicking is reported. */
const MOVED_PX = 1;

/**
 * The click the driver makes on page, measuring through ev, telling runnerClick first, and telling input when what it
 * aimed at moved before it clicked (#1320): a button moving under the pointer is a defect the run’s checks report.
 * @param {any} page @param {(expr: string) => Promise<any>} ev @param {() => void} runnerClick
 * @param {(entry: any) => void} [input]  the driver’s hooks.input (tools/uat/probes.mjs, recordInput)
 */
export function pointer(page, ev, runnerClick, input) {
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
    const at = await heldStill(findExpr, r);
    // Clicked where it is, so the run goes on; but the move is the page’s defect, and the checks hear of it.
    if (Math.abs(at.x - r.x) > MOVED_PX || Math.abs(at.y - r.y) > MOVED_PX) input?.({ kind: 'target-moved', what, from: r, to: at });
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
      await page.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
    await sleep(250);
  }

  /**
   * Where an element’s center is once it holds still: measured again until two readings agree, up to five times. A
   * list or a note that answered during the pause can move it, as the Model field’s help moved Save 16.8 px (#1320),
   * and a person aims at where it is, not where it was. Gone meanwhile: where it was.
   * @param {string} findExpr @param {{ x: number, y: number }} was
   */
  async function heldStill(findExpr, was) {
    const where = () =>
      ev(
        `(() => { const el = ${findExpr}; if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`,
      );
    let last = was;
    for (let i = 0; i < 5; i++) {
      const now = await where();
      if (!now) return last;
      if (now.x === last.x && now.y === last.y) return now;
      last = now;
      await sleep(60);
    }
    return last;
  }
  return { clickAt };
}
