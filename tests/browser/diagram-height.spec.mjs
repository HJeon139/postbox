// A diagram drawn again starts at the height its source last drew at, so what’s below it doesn’t move as it draws
// (#1631). That height is only where it starts: the frame reports its drawing’s own height, so the same source drawn
// narrower, where its scaled drawing is shorter, shrinks to it instead of keeping the wider draw’s height.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;

test.beforeAll(async () => {
  app = await startPostbox('diagram-height', { demo: false });
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

// Eight boxes abreast: at 1000 px its drawing is taller than the 160 px floor, and scaled to fit 300 px, far shorter.
const WIDE = `graph TD\n  A[Start] --> ${Array.from({ length: 8 }, (_, i) => `B${i}[Branch ${i}]`).join(' & ')} --> C[End]`;

/** Draws WIDE into a fresh box `width` px wide, and answers with its frame’s height once it has measured. */
async function draw(/** @type {import('@playwright/test').Page} */ page, /** @type {number} */ width) {
  const cls = `drawn-${width}`;
  await page.evaluate(
    async ({ src, width, cls }) => {
      const { enhanceMarkdown } = await import('/app/js/md-enhance.mjs');
      const code = document.createElement('code');
      code.textContent = src;
      const pre = document.createElement('pre');
      pre.append(code);
      const fig = document.createElement('figure');
      fig.className = 'md-mermaid';
      fig.append(pre);
      const box = document.createElement('div');
      box.className = `md ${cls}`;
      box.style.cssText = `position: fixed; top: 0; left: 0; z-index: 10; width: ${width}px`;
      box.append(fig);
      document.body.append(box);
      enhanceMarkdown(box);
    },
    { src: WIDE, width, cls },
  );
  const frame = page.locator(`.${cls} figure.diagram iframe`);
  await expect(frame, `the diagram at ${width} px, drawn and sized`).toHaveAttribute('data-sized', '1');
  const height = await frame.evaluate((f) => f.getBoundingClientRect().height);
  await page.evaluate((c) => document.querySelector(`.${c}`)?.remove(), cls);
  return height;
}

test('#1631: the same diagram drawn narrower after wider doesn’t keep the wider draw’s height', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(app.origin);
  await synced(page, app);
  const wide = await draw(page, 1000);
  expect(wide, 'drawn wide, the diagram is taller than the floor').toBeGreaterThan(160);
  expect(await draw(page, 300), 'drawn narrow, it shrinks to the 160 px floor').toBe(160);
});
