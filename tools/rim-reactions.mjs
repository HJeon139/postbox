// Draws each reaction icon’s light-theme copy, with its 1 px rim in light `--dim` (app/media/reactions/README.md,
// “Contrast”). The rim used to be four drop-shadow filters on every icon in the page, and a long conversation’s
// thousands of filters made each scroll repaint slow (#572). So it is drawn into the file once, with the same filter,
// at the scale the page draws the 64 px file: 20 px, so 1 px there is 3.2 px here. The filter drew outside the icon’s box, so
// the copy is 72 px, the 64 px icon with 4 px of room on each side, and the page draws it 22.5 px across.
// Usage: node tools/rim-reactions.mjs, after changing an icon or light `--dim`. Writes reaction-<name>-rim-72.png.

import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const DIR = new URL('../app/media/reactions/', import.meta.url);
const NAMES = ['approve', 'disapprove', 'flag', 'unclear', 'done'];
const css = readFileSync(new URL('../app/workbench.css', import.meta.url), 'utf8');
const light = css.slice(css.indexOf(':root[data-theme="light"] {'));
const dim = light.match(/--dim:\s*(#[0-9a-fA-F]{6})/)?.[1];
if (!dim) throw new Error('No light --dim in app/workbench.css');
const px = 64 / 20;

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  for (const name of NAMES) {
    const src = `data:image/png;base64,${readFileSync(new URL(`reaction-${name}-64.png`, DIR)).toString('base64')}`;
    const out = await page.evaluate(
      async ({ src, dim, px }) => {
        const img = new Image();
        img.src = src;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = c.height = 72;
        const ctx = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
        ctx.filter = [`${px}px 0`, `-${px}px 0`, `0 ${px}px`, `0 -${px}px`].map((at) => `drop-shadow(${at} 0 ${dim})`).join(' ');
        ctx.drawImage(img, 4, 4, 64, 64);
        // A rim cut off at the edge would show as a flat side: the 4 px of room holds it.
        const a = ctx.getImageData(0, 0, 72, 72).data;
        let edge = 0;
        const alpha = (x, y) => a[(y * 72 + x) * 4 + 3];
        for (let i = 0; i < 72; i++) edge = Math.max(edge, alpha(i, 0), alpha(i, 71), alpha(0, i), alpha(71, i));
        return { url: c.toDataURL('image/png'), edge };
      },
      { src, dim, px },
    );
    if (out.edge > 0) console.warn(`${name}: the rim reaches the edge (alpha ${out.edge}), so it’s cut off there`);
    writeFileSync(new URL(`reaction-${name}-rim-72.png`, DIR), Buffer.from(out.url.split(',')[1], 'base64'));
    console.log(`reaction-${name}-rim-72.png`);
  }
} finally {
  await browser.close();
}
