// #1130: a wide table the person had scrolled sideways went back to its first column when its agent refilled it with
// update_block, as it did on Sort and Expand, since each draws the table anew. Each now keeps where the person was,
// sideways and down, cut back to the new table’s size when it’s smaller.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let n = 0;
test.beforeAll(async () => {
  app = await startPostbox('table-keeps-scroll');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

/** A table of `cols` columns of long values, and `rows` rows: wider than its block at 1280 px. */
const works = (cols, rows = 3) => ({
  id: 'works',
  type: 'table',
  version: 1,
  title: 'Works',
  fallback: 'Works',
  columns: Array.from({ length: cols }, (_, i) => ({ id: `c${i}`, label: `Column ${i}` })),
  rows: Array.from({ length: rows }, (_, r) => ({
    id: `r${r}`,
    cells: Object.fromEntries(Array.from({ length: cols }, (_, i) => [`c${i}`, `Value${r}${i}ABCDEFGHIJKLMNOPQRS`])),
  })),
});

/** A conversation showing the wide table, open in the page, with its scroll region and the agent’s tools. */
async function shown(page) {
  const { rt } = app;
  const projectId = Object.values(rt.store.state.projects)[0].id;
  const t = rt.createThread({ projectId, title: `Shelf ${++n}`, personaIds: [arrange.persona(rt, 'librarian').id] });
  const tools = rt.toolsFor(arrange.agentIn(rt, t.id).id);
  tools.show_block({ block: works(12) });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const region = page.getByRole('region', { name: 'Works, scrolls' });
  await expect(region).toBeVisible();
  return { tools, region };
}
const left = (region) => region.evaluate((el) => el.scrollLeft);
const at = (region) => region.evaluate((el) => ({ left: el.scrollLeft, top: el.scrollTop }));
const most = (region) => region.evaluate((el) => el.scrollWidth - el.clientWidth);

test('#1130 a table refilled by update_block keeps its scroll, sideways and down', async ({ page }) => {
  const { tools, region } = await shown(page);
  tools.update_block({ block: works(12, 40) });
  await expect(page.getByText('40 rows')).toBeVisible();
  await region.evaluate((el) => {
    el.scrollLeft = 400;
    el.scrollTop = 300;
  });
  const before = await at(region);
  expect(before.left, 'scrolled sideways').toBeGreaterThan(300);
  expect(before.top, 'scrolled down').toBeGreaterThan(200);
  tools.update_block({ block: works(12, 41) });
  await expect(page.getByText('41 rows')).toBeVisible();
  // The frame’s observer puts it back before the next paint, so the read waits for that frame.
  await expect.poll(() => at(region), { message: 'where the person was' }).toEqual(before);
});

test('#1130 a narrower table keeps as much of the scroll as it has, and Sort and Expand keep it too', async ({ page }) => {
  const { tools, region } = await shown(page);
  await region.evaluate((el) => {
    el.scrollLeft = el.scrollWidth;
  });
  tools.update_block({ block: works(9) });
  await expect(page.getByRole('columnheader')).toHaveCount(9);
  await expect.poll(async () => (await left(region)) - (await most(region)), { message: 'at the narrower table’s right edge' }).toBe(0);
  await region.evaluate((el) => {
    el.scrollLeft = 200;
  });
  // A column in view there, so the click doesn’t scroll its header into view first.
  await page.getByRole('button', { name: 'Column 2' }).click();
  await expect(page.locator('th[aria-sort="ascending"]')).toHaveCount(1);
  await expect.poll(() => left(region), { message: 'after Sort' }).toBe(200);
  await page.getByRole('button', { name: 'Expand table' }).click();
  await expect(page.getByRole('button', { name: 'Collapse table' })).toBeVisible();
  await expect.poll(() => left(region), { message: 'after Expand' }).toBe(200);
});

test('#1130 two redraws in one frame keep the scroll, though the first’s region hasn’t been put back yet', async ({ page }) => {
  const { tools, region } = await shown(page);
  tools.update_block({ block: works(12, 40) });
  await expect(page.getByText('40 rows')).toBeVisible();
  await region.evaluate((el) => {
    el.scrollLeft = 400;
    el.scrollTop = 300;
  });
  const before = await at(region);
  expect(before.left, 'scrolled sideways').toBeGreaterThan(300);
  // Two updates back to back: the second draws before the first’s region has had its position put back, so that
  // region still reads 0, and the position must come from the draft instead.
  tools.update_block({ block: works(12, 41) });
  tools.update_block({ block: works(12, 42) });
  await expect(page.getByText('42 rows')).toBeVisible();
  await expect.poll(() => at(region), { message: 'where the person was' }).toEqual(before);
});
