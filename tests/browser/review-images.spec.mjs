// A review block shows images from the agent’s folder (#780, note as_BkHPLMds v3): #780’s example, a draft with two
// figures, one named by its path and one by its name. In Preview both load from the item’s route, at 127.0.0.1 and at
// localhost, with their sizes set; each response carries Cross-Origin-Resource-Policy: same-origin, which doesn’t
// block the page’s own load.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { blockFiles } from '../../server/review-files.mjs';
import { png } from '../png.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

const CONTENT = '# Today’s numbers\n\n![Today](figs/today.png)\n\nAnd the trend:\n\n![Trend](trend.png)';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let projectId;
test.beforeAll(async () => {
  app = await startPostbox('review-images');
  const { rt, store } = app;
  const folder = join(app.root, 'agent-folder');
  await mkdir(join(folder, 'figs'), { recursive: true });
  projectId = Object.values(rt.s.projects)[0].id;
  store.emit('project', { ...rt.s.projects[projectId], folder });
  await writeFile(join(folder, 'figs/today.png'), png(120, 80, 0, 0x30));
  await writeFile(join(folder, 'figs/trend.png'), png(60, 40, 0, 0xc0));
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);
test.use({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });

/** The librarian shows #780’s draft, with its two figures, as a tool call over MCP would (blockFiles, then show_block). */
async function showFigures(title) {
  const { rt } = app;
  const t = rt.createThread({ projectId, title, personaIds: [rt.personaByHandle('librarian').id] });
  const [se] = rt.sessionsIn(t.id);
  const block = { id: 'figures', type: 'review', version: 1, format: 'markdown', fallback: 'A draft with two figures', content: CONTENT };
  const { args, files } = await blockFiles(rt, se.id, 'show_block', { block: { ...block, files: [{ path: 'figs/today.png' }, { path: 'figs/trend.png' }] } });
  const shown = rt.toolsFor(se.id).show_block(args, { files });
  expect(shown.ok, shown.message).toBe(true);
  const item = rt.store.items(t.id).find((i) => i.kind === 'block' && i.block.id === 'figures');
  return { t, item };
}

for (const host of ['127.0.0.1', 'localhost'])
  test(`#780 at ${host}, a review’s two figures load in Preview from the item’s route, with CORP that doesn’t block them`, async ({ page }) => {
    const { t, item } = await showFigures(`Figures at ${host}`);
    /** @type {{ url: string, status: number, corp: string | undefined }[]} */
    const answers = [];
    page.on('response', (r) => {
      if (r.url().includes(`/items/${item.id}/files/`)) answers.push({ url: r.url(), status: r.status(), corp: r.headers()['cross-origin-resource-policy'] });
    });
    await page.goto(`${app.origin.replace('127.0.0.1', host)}/#/t/${t.id}`);
    await synced(page, app);
    const block = page.locator(`[data-block-item="${item.id}"]`);
    const imgs = block.locator('img.md-img');
    await expect(imgs).toHaveCount(2);
    const drawn = () =>
      imgs.evaluateAll((els) =>
        els.map((i) => {
          const img = /** @type {HTMLImageElement} */ (i);
          return { alt: img.alt, natural: img.complete ? `${img.naturalWidth}×${img.naturalHeight}` : 'loading', set: `${img.width}×${img.height}` };
        }),
      );
    await block.scrollIntoViewIfNeeded();
    await expect.poll(drawn, { message: 'both figures load, at the sizes the item keeps' }).toEqual([
      { alt: 'Today', natural: '120×80', set: '120×80' },
      { alt: 'Trend', natural: '60×40', set: '60×40' },
    ]);
    const src = await imgs.evaluateAll((els) => els.map((i) => i.getAttribute('src')));
    expect(
      src.every((s) => s?.startsWith(`/api/threads/${t.id}/items/${item.id}/files/`)),
      'same-origin paths, not absolute URLs',
    ).toBe(true);
    expect(answers.length, 'each figure came from the route').toBeGreaterThanOrEqual(2);
    expect(
      answers.every((a) => a.status === 200 && a.corp === 'same-origin'),
      JSON.stringify(answers),
    ).toBe(true);
    await expect(block.locator('.img-failed')).toHaveCount(0);
  });
