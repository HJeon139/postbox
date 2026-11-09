// The transcript reads its gap to the end (`gapOf`, view-geometry.mjs) to decide whether the pill shows and whether
// you’re at the end, and a read with a layout pending lays out the whole page (#1047). A reply that arrived while you
// read higher up read it at once (grew() → showJump()), before the frame’s own layout, so each reply cost a layout of
// its own: in the person’s Firefox profile, 12 of about 130 ms in one 1.28 s task. Chromium’s trace marks a layout
// that script forced with the script’s stack; here none may come from Postbox’s own code during the burst.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, frames, settled, startPostbox, synced } from './postbox.mjs';

// Tracing is off: Playwright’s trace snapshot walks the page each action, which Chromium counts as layouts too.
test.use({ trace: 'off' });

const ITEMS = 1000;
const BURST = 50;

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('gap-read-cost');
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

/** A room of ITEMS lines with an agent, open in the page and held still. */
async function bigRoom(page, title) {
  const { rt } = app;
  const project = Object.values(app.store.state.projects)[0];
  const t = rt.createThread({ projectId: project.id, title, personaIds: [rt.personaByHandle('critic').id] });
  const [se] = rt.sessionsIn(t.id);
  for (let i = 0; i < ITEMS; i++)
    app.store.emit('item.add', { threadId: t.id, item: { id: `it_g${title.length}_${i}`, at: Date.now(), kind: 'user', text: `Line ${i}` } });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await expect(page.locator('#main > .item')).toHaveCount(ITEMS, { timeout: 15_000 });
  await settled(page);
  return { t, se };
}

/**
 * The page’s layouts while `run` ran, and until it held still after (Chromium’s LayoutCount), and those that
 * Postbox’s own script forced, by the line that forced each: Chromium’s trace gives a forced layout the stack of the
 * script that asked for it.
 */
async function forcedOver(page, run) {
  const browser = /** @type {import('@playwright/test').Browser} */ (page.context().browser());
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const count = async () => (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === 'LayoutCount')?.value ?? 0;
  const before = await count();
  await browser.startTracing(page, { categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline.stack'] });
  await run();
  await settled(page);
  const layouts = (await count()) - before;
  const trace = JSON.parse((await browser.stopTracing()).toString());
  const forced = new Map();
  for (const e of trace.traceEvents ?? trace) {
    if (e.name !== 'Layout' || e.ph === 'E') continue;
    const at = (e.args?.beginData?.stackTrace ?? []).find((/** @type {any} */ f) => f.url?.includes('/app/js/'));
    if (!at) continue;
    const key = `${at.functionName}@${at.url.split('/').pop()}:${at.lineNumber + 1}`;
    forced.set(key, (forced.get(key) ?? 0) + 1);
  }
  return { layouts, forced: Object.fromEntries(forced) };
}

test(`#1047 ${BURST} replies arriving one a frame while you read higher up force no layout of their own`, async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'the layout count comes from Chromium’s DevTools protocol');
  const { t, se } = await bigRoom(page, 'Read up');
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight - innerHeight - 400));
  await settled(page);
  await expect(page.locator('#main')).toHaveAttribute('data-view-mode', 'reading');
  const { layouts, forced } = await forcedOver(page, async () => {
    for (let i = 0; i < BURST; i++) {
      app.rt.addItem(t.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text: `Reply ${i}`, status: 'done' });
      await frames(page);
    }
    await expect(page.locator('#main > .item')).toHaveCount(ITEMS + BURST, { timeout: 15_000 });
  });
  test.info().annotations.push({ type: 'measured', description: JSON.stringify({ layouts, forced }) });
  await expect(page.getByRole('button', { name: new RegExp(`Jump to latest · ${BURST} new`) })).toBeVisible();
  // Before the fix, 98 with skipping: 50 in grew() → showJump() → gapOf, and 48 in follow(), after the pill’s write.
  // With events late, a reply can land in the frame an item draws in, and follow() reads then: 3 of 50 once.
  const all = Object.values(forced).reduce((a, b) => a + b, 0);
  expect.soft(all, `layouts Postbox forced over ${BURST} replies`).toBeLessThanOrEqual(5);
  // Each reply’s frame lays out once, with a few more as the page settles. A pill written after the frame’s layout
  // lays it out again, once a reply: about 100 layouts in all.
  expect.soft(layouts, `layouts over ${BURST} replies`).toBeLessThanOrEqual(BURST + 25);
});

test(`#1047 a reply streaming one delta a frame for ${BURST} frames, followed, forces at most one layout a delta`, async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'the layout count comes from Chromium’s DevTools protocol');
  const { t, se } = await bigRoom(page, 'Following');
  await expect(page.locator('#main')).toHaveAttribute('data-view-mode', 'following');
  const it = app.rt.addItem(t.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text: '', status: 'streaming' });
  await expect(page.locator(`[data-key="${it.id}"]`), 'the reply to reach the page').toBeAttached({ timeout: 15_000 });
  await settled(page);
  const { forced } = await forcedOver(page, async () => {
    for (let i = 0; i < BURST; i++) {
      app.store.emit('item.text', { threadId: t.id, id: it.id, text: `word${i} ` });
      await frames(page);
    }
    await expect(page.locator(`[data-key="${it.id}"]`)).toContainText(`word${BURST - 1}`, { timeout: 15_000 });
  });
  test.info().annotations.push({ type: 'measured', description: JSON.stringify(forced) });
  // noteEnd() reads the end at most once a frame (#866), in the change watcher, before the frame. The page then has
  // nothing left to lay out, so that read is the frame’s one layout, not one more: 50 on 50 deltas, 51 or 52 layouts
  // in all on main and with skipping. More than one a frame would be the per-batch cost #866 fixed.
  const all = Object.values(forced).reduce((a, b) => a + b, 0);
  expect(all, `layouts Postbox forced over ${BURST} deltas`).toBeLessThanOrEqual(BURST);
  const gap = await page.evaluate(() => Math.round(document.documentElement.scrollHeight - scrollY - innerHeight));
  expect(gap, 'still at the end').toBeLessThanOrEqual(2);
});
