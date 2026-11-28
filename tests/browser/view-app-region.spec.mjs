// view_app with a review region (#856): renders the app at the region’s review width, uncapped in height, with the
// marked region outlined over the frame so the agent sees exactly what the person marked.

import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { AppBrowser } from '../../server/view-app/browser.mjs';
import * as arrange from '../arrange.mjs';
import { playwrightBrowsers } from '../fixtures/playwright-browsers.mjs';
import { failOnPageErrors, startPostbox } from './postbox.mjs';

/** A PNG’s width and height, from its IHDR chunk. @param {string} base64 */
const sizeOf = (base64) => {
  const b = Buffer.from(base64, 'base64');
  return { png: b.subarray(1, 4).toString() === 'PNG', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
};

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;

test.beforeAll(async () => {
  app = await startPostbox('view-app-region');
  const dir = arrange.viewDir(app.rt);
  const shell = new AppBrowser({ dir: playwrightBrowsers() });
  test.skip(shell.status() !== 'ready', 'Playwright’s headless shell isn’t installed');
  await mkdir(dir, { recursive: true });
  const { browsers } = JSON.parse(await readFile(join(shell.pkg ?? '', 'browsers.json'), 'utf8'));
  const rev = browsers.find((b) => b.name === 'chromium-headless-shell').revision;
  await symlink(join(playwrightBrowsers(), `chromium_headless_shell-${rev}`), join(dir, `chromium_headless_shell-${rev}`));
  await writeFile(join(dir, 'consent.json'), JSON.stringify({ answer: 'allowed', at: Date.now() }));
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

test('#856 view_app with a region captures the app at its review width, uncapped in height, with the region outlined', async ({ page }) => {
  test.setTimeout(90_000);
  const { rt } = app;
  const folder = join(app.root, 'work');
  await mkdir(folder, { recursive: true });
  app.store.emit('project', { id: 'pvr', name: 'View region', folder });
  const t = rt.createThread({ projectId: 'pvr', title: 'Region view', personaIds: [arrange.persona(rt, 'researcher').id] });
  const se = arrange.agentIn(rt, t.id);
  // Taller than both the 680 px default window and the 4,000 px viewport cap: renders uncapped so the mark sits at y 4500, then clips to one window height around it.
  const shown = rt.toolsFor(se.id).show_app({
    title: 'Tall report',
    code: '<main style="height:5000px;padding:12px;color:var(--text)"><h2>Top</h2><p style="margin-top:4480px">Bottom note</p></main>',
  });
  const region = { x: 40, y: 4500, w: 220, h: 80, width: 640, height: 5000, version: 1 };
  const r = await arrange.viewApp(rt, se.id, { appId: shown.appId, region }, { threadId: () => t.id, endSegment() {}, images: true });
  expect(r.ok, r.message).toBe(true);
  expect(r.message).toMatch(/x 40, y 4500, 220 × 80 px, on v1, in a 640 × 5000 px frame/);
  expect(r.message).toMatch(/showing y \d+–\d+ of 5000 px/);
  const png = sizeOf(r.image.data);
  expect(png.png, 'a PNG').toBe(true);
  expect(png.width, 'captured at the region’s review width').toBe(640);
  expect(png.height, 'clipped to one window height around the mark, not the whole 5000 px').toBe(680);

  // Open the same capture URL in the page to verify the outline sits at the exact px coordinates over the frame.
  const item = rt.store.items(t.id).find((x) => x.block?.id === shown.appId);
  await page.goto(`${app.origin}/?nocheck&capture=${item.id}&thread=${t.id}&region=40,4500,220,80,640,5000`);
  await expect(page.locator('[data-capture="ready"]')).toBeAttached({ timeout: 15_000 });
  const box = await page.locator('.rv-marks > .rv-region').evaluate((el) => {
    const r0 = el.getBoundingClientRect();
    const f = el.closest('.app-body')?.querySelector('iframe.app-iframe')?.getBoundingClientRect();
    return f
      ? { x: Math.round(r0.left - f.left), y: Math.round(r0.top - f.top), w: Math.round(r0.width), h: Math.round(r0.height), fw: Math.round(f.width) }
      : null;
  });
  expect(box).toEqual({ x: 40, y: 4500, w: 220, h: 80, fw: 640 });
});
