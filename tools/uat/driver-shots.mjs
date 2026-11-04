// The UAT driver’s screenshots (tools/uat/driver.mjs): an item as a person sees it, and the whole window. Moved out of
// driver.mjs, which is at its size.

import { writeFile } from 'node:fs/promises';
import { ITEM } from './selectors.mjs';

/**
 * @param {{ ev: (expr: string) => Promise<any>, page: any, sleep: (ms: number) => Promise<unknown> }} o  ev: the
 *   driver’s page.evaluate; page: from tools/browser.mjs launch()
 */
export function shots({ ev, page, sleep }) {
  return {
    /**
     * What a person sees of an item: scrolled to just below the top bar, and only what fits in the window.
     * (Capturing beyond the window paints the sticky top bar mid-item, and leaves sandboxed frames blank.)
     */
    async shotItem(key, file) {
      const ok = await ev(
        `(() => { const n = ${ITEM(key)}; if (!n) return false; n.scrollIntoView({ block: 'start' }); scrollBy(0, -((document.querySelector('header.topbar')?.offsetHeight ?? 0) + 8)); return true; })()`,
      );
      if (!ok) return null;
      // Apps far off screen are unloaded; give them a moment to load again and draw. (The clip is in page
      // coordinates, so the scroll offset is added below.)
      await sleep((await ev(`!!${ITEM(key)}.querySelector('iframe')`)) ? 2500 : 300);
      const r = await ev(
        `(() => { const b = ${ITEM(key)}.getBoundingClientRect(); const top = Math.max(b.top - 6, 0); return { x: Math.max(0, b.left - 6) + scrollX, y: top + scrollY, width: Math.min(b.width + 12, innerWidth), height: Math.max(1, Math.min(b.bottom + 6, innerHeight) - top) }; })()`,
      );
      const { data } = await page.send('Page.captureScreenshot', { format: 'png', clip: { ...r, scale: 1 } });
      await writeFile(file, Buffer.from(data, 'base64'));
      return file;
    },

    async shotScreen(file) {
      const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
      await writeFile(file, Buffer.from(data, 'base64'));
      return file;
    },
  };
}
