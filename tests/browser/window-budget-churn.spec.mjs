// The window’s element budget (#1155, item 2) doesn’t churn: an item that alone is near the budget, a table of 800 rows,
// once kept the range over it, so each growth past the margin was unmounted again by the element budget’s shrink and
// mounted again on the next scroll. Scrolling up a room of them on a phone remounted its first items up to 131 times;
// each item now mounts at most twice.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, frames, settled, startPostbox, synced } from './postbox.mjs';

const ITEMS = 300;
const TALL_EVERY = 30;
const TALL_ROWS = 800;

test.use({ viewport: { width: 375, height: 812 }, trace: 'off' });

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let threadId = '';
test.beforeAll(async () => {
  app = await startPostbox('window-budget-churn');
  const projectId = Object.values(app.rt.store.state.projects)[0].id;
  const t = app.rt.createThread({ projectId, title: 'Tall tables', personaIds: [arrange.persona(app.rt, 'librarian').id] });
  const se = arrange.agentIn(app.rt, t.id);
  const columns = [
    { id: 'a', label: 'Name' },
    { id: 'b', label: 'Count', kind: 'number' },
  ];
  const rows = Array.from({ length: TALL_ROWS }, (_, r) => ({ id: `r${r}`, cells: { a: `Row ${r}`, b: r } }));
  for (let i = 0; i < ITEMS; i++) {
    const at = 1_700_000_000_000 + i;
    const block = { id: `tall${i}`, type: 'table', version: 1, title: `Table ${i}`, fallback: `Table ${i}`, columns, rows };
    const item =
      i % TALL_EVERY === 0
        ? { id: `it_c${i}`, at, kind: 'block', handle: se.handle, sessionId: se.id, valid: true, block }
        : { id: `it_c${i}`, at, kind: 'user', text: `Note ${i}.` };
    app.store.emit('item.add', { threadId: t.id, item });
  }
  threadId = t.id;
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

test('#1155 scrolling up a room of 800-row tables on a phone mounts each item at most twice', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(`${app.origin}/#/t/${threadId}`);
  await synced(page, app);
  await expect(page.locator('#main > .item').last()).toBeVisible();
  await settled(page);
  // Counts each item’s mounts from here on: every time its node is added to the transcript.
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.__mounts = {};
    new MutationObserver((records) => {
      for (const r of records)
        for (const n of r.addedNodes) {
          const key = n instanceof HTMLElement ? n.dataset.key : undefined;
          if (key) w.__mounts[key] = (w.__mounts[key] ?? 0) + 1;
        }
    }).observe(/** @type {Element} */ (document.querySelector('#main')), { childList: true });
  });
  // A person’s wheel turns, not leaps: the range grows toward each one. Not settled(): a page that churns never holds still.
  for (let i = 0; i < 30; i++) {
    await page.mouse.wheel(0, -400);
    await frames(page);
    await frames(page);
  }
  const mounts = /** @type {Record<string, number>} */ (await page.evaluate(() => /** @type {any} */ (window).__mounts));
  const churned = Object.entries(mounts).filter(([, n]) => n > 2);
  expect(Object.keys(mounts).length, 'it scrolled: items mounted as it went up').toBeGreaterThan(0);
  expect(churned, 'items mounted more than twice').toEqual([]);
});
