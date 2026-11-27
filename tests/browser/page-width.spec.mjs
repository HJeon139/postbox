// The page-width helper (page-width.mjs, #966) sees what the page’s clip hides: a box past the window’s edge widens
// it, as the page’s scrollWidth did before the clip, and a box inside its own scroll box or fixed to the window doesn’t.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { pageWidth } from './page-width.mjs';
import { PHONE, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('page-width');
});
test.afterAll(async () => app?.stop());
test.use({ viewport: { width: 375, height: 700 }, ...PHONE });

test('#966 a box past the window’s edge widens the page as laid out, though its scrollWidth reads the window’s', async ({ page }) => {
  await page.goto(app.origin);
  await expect(page.locator('.topbar')).toBeVisible();
  // Each case’s boxes are marked, so clearing them can’t take the page’s own last element instead.
  const add = (/** @type {string} */ html) =>
    page.evaluate((h) => {
      const box = Object.assign(document.createElement('div'), { innerHTML: h });
      box.dataset.case = '';
      document.body.append(box);
    }, html);
  const clear = () =>
    page.evaluate(() => {
      for (const el of document.querySelectorAll('[data-case]')) el.remove();
    });
  expect(await pageWidth(page), 'nothing past the edge').toBe(375);
  await add('<div style="width: 900px; height: 1px; overflow-x: auto"><div style="width: 2000px; height: 1px"></div></div>');
  expect(await page.evaluate(() => document.documentElement.scrollWidth), 'the clip hides it from scrollWidth').toBe(375);
  expect(await pageWidth(page), 'a 900 px box, its own scroller’s content left out').toBe(900);
  await clear();
  await add('<div style="position: fixed; left: 0; width: 900px; height: 1px"></div>');
  expect(await pageWidth(page), 'fixed to the window').toBe(375);
  await clear();
  // Boxes that escape a clip: what clips a box is its containing block’s chain, not its parents.
  await add(
    '<div style="position: relative"><div style="overflow: hidden; width: 100px"><div style="position: absolute; width: 900px; height: 1px"></div></div></div>',
  );
  expect(await pageWidth(page), 'an absolute box past a clip that isn’t its containing block').toBe(900);
  await clear();
  await add('<div style="transform: translateX(0)"><div style="position: fixed; left: 0; width: 900px; height: 1px"></div></div>');
  expect(await pageWidth(page), 'a fixed box in a transformed one lays out as an absolute one').toBe(900);
  await clear();
  // Each style that makes a box the containing block of an absolute one, so its clip holds the box in, though a
  // positioned ancestor further out would otherwise hold it.
  for (const style of ['transform: translateX(0)', 'will-change: transform', 'perspective: 100px', 'backdrop-filter: blur(1px)']) {
    await add(
      `<div style="position: relative"><div style="${style}; overflow: hidden; width: 100px"><div style="position: absolute; width: 900px; height: 1px"></div></div></div>`,
    );
    expect(await pageWidth(page), `an absolute box clipped by one with ${style}`).toBe(375);
    await clear();
  }
  // A word that doesn’t wrap runs past its box, and the box stays its own width: only the box’s scrollWidth sees it.
  await add(`<p style="width: 300px">${'w'.repeat(150)}</p>`);
  expect(await pageWidth(page), 'a word that runs past its box').toBeGreaterThan(375);
});

test('#966 at 375 px a wide code block and a wide table each scroll inside themselves, and the page stays put', async ({ page }) => {
  const { rt } = app;
  const projectId = /** @type {any} */ (Object.values(rt.store.state.projects)[0]).id;
  const t = rt.createThread({ projectId, title: 'Wide things', personaIds: [arrange.persona(rt, 'librarian').id] });
  const se = arrange.agentIn(rt, t.id);
  const line = `const wide = '${'x'.repeat(160)}';`;
  rt.threads.addItem(t.id, {
    kind: 'agent',
    sessionId: se.id,
    personaId: se.personaId,
    handle: se.handle,
    text: `A long line:\n\n\`\`\`js\n${line}\n\`\`\`\n`,
  });
  // A long token with no space in a message’s words: a hash or a path, bare and in backticks.
  const token = 'a1b2c3d4'.repeat(25);
  const path = `/srv/${'deeply-nested-folder/'.repeat(8)}file.mjs`;
  rt.threads.addItem(t.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text: `Hash ${token}, path \`${path}\`.` });
  const columns = Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, label: `Column ${i}` }));
  const rows = [{ id: 'r0', cells: Object.fromEntries(columns.map((c) => [c.id, `${c.label} value, long enough`])) }];
  rt.toolsFor(se.id).show_block({ block: { id: 'wide', type: 'table', version: 1, title: 'Wide', fallback: 'Wide', columns, rows } });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const code = page.locator('#main pre.md-code').first();
  const table = page.getByRole('region', { name: 'Wide, scrolls' });
  for (const [what, box] of /** @type {const} */ ([
    ['the code block', code],
    ['the table', table],
  ])) {
    // To the middle of the view, so no sticky bar at the top or the composer lies over where the wheel turns.
    await box.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    expect(await box.evaluate((el) => el.scrollWidth > el.clientWidth + 1), `${what} is wider than its box`).toBe(true);
    const b = /** @type {{ x: number, y: number, width: number, height: number }} */ (await box.boundingBox());
    await page.mouse.move(b.x + b.width / 2, b.y + Math.min(b.height / 2, 20));
    await page.mouse.wheel(200, 0);
    await expect.poll(() => box.evaluate((el) => el.scrollLeft), `${what} scrolls sideways inside itself`).toBeGreaterThan(0);
    // Nothing around it took the wheel: the box is where it was.
    expect((await box.boundingBox())?.x, `${what} stays put`).toBe(b.x);
  }
  // The page clips what runs past it, so a word that doesn’t wrap would be cut off with nothing to scroll to it.
  const words = page.locator('#main .md p', { hasText: 'Hash ' });
  await expect(words).toHaveCount(1);
  expect(await words.evaluate((el) => el.scrollWidth - el.clientWidth), 'the long word and path wrap inside their paragraph').toBeLessThanOrEqual(1);
  expect(await pageWidth(page), 'nothing past the window').toBe(375);
});
