// One session event costs the same in a long room as in a short one (#564-b1). Each one ran three queries over the
// whole document: the rail's for its rings (shell.mjs), the open asks' for their buttons (open-asks.mjs), and the
// reply rings' for every transcript (reply-rings.mjs). With 10,000 items on the page a session event cost 8.8 ms,
// against 1.3 ms at 1,000. Each now looks only in its own containers. The page counts the queries over the whole
// document while session events arrive, and the rail's rings, the strip's, the open-asks button and the speaker
// lines still follow the session.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, frames, startPostbox, synced } from './postbox.mjs';

// No trace: its snapshots walk the whole page around each action, which a 10,000-item room makes slow.
test.use({ trace: 'off' });

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('session-event-scope', { demo: false });
  app.store.emit('project', { id: 'pr_scope', name: 'Scope', folder: app.root });
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

const confirm = { id: 'ok1', type: 'confirm', version: 1, fallback: 'Ship it?', statement: 'Ship it to main?', confirmLabel: 'Ship it' };

let rooms = 0;
/** A room of `n` replies, with an open confirm the agent showed in an earlier turn, open in the page at `width`. */
async function seeded(page, n, width = 1280) {
  const { rt } = app;
  const p = rt.createPersona({ handle: `scoped${++rooms}` });
  const t = rt.createThread({ projectId: 'pr_scope', title: `Scoped ${rooms}`, personaIds: [p.id] });
  const se = rt.sessionsIn(t.id)[0];
  rt.toolsFor(se.id).show_block({ block: confirm });
  for (let i = 0; i < n; i++)
    rt.addItem(t.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text: `Reply ${i}.`, status: 'done' });
  await page.setViewportSize({ width, height: 800 });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  // The items first: a room this size takes longer to load than synced()'s wait.
  await expect(page.locator('#main .item')).toHaveCount(n + 1, { timeout: 90_000 });
  await synced(page, app);
  return { t, se };
}

/** Counts querySelectorAll and querySelector calls on the document itself, from here on. */
const countDocQueries = (page) =>
  page.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.__docQueries = [];
    for (const name of ['querySelectorAll', 'querySelector']) {
      const real = Document.prototype[name];
      Document.prototype[name] = function (sel) {
        if (this === document) w.__docQueries.push(String(sel).slice(0, 80));
        return real.call(this, sel);
      };
    }
  });

test('#564-b1 a session event in a 10,000-item room runs no query over the whole document', async ({ page }) => {
  test.setTimeout(240_000);
  const { se } = await seeded(page, 10_000);
  await countDocQueries(page);
  for (const state of ['think', 'tool', 'gen', 'idle']) {
    app.rt.updateSession(se.id, { state });
    await synced(page, app);
    await frames(page);
  }
  const queries = await page.evaluate(() => /** @type {any} */ (window).__docQueries);
  expect(queries, 'whole-document queries during 4 session events').toEqual([]);
});

test('#564-b1 the rail’s ring, the open-asks button and the latest reply’s ring still follow the session', async ({ page }) => {
  const { t, se } = await seeded(page, 30);
  app.rt.updateSession(se.id, { state: 'tool' });
  await expect(page.locator(`.rail pb-ring[data-session="${se.id}"]`).first()).toHaveAttribute('state', 'tool');
  await expect(page.locator(`.transcript[data-thread="${t.id}"] .who pb-ring[data-session="${se.id}"]`).last()).toHaveAttribute('state', 'tool');
  await expect(page.locator(`[data-open-asks="${se.id}"]`).first()).toHaveText('1 open confirmation');
  app.rt.updateSession(se.id, { state: 'idle' });
  await expect(page.locator(`.rail pb-ring[data-session="${se.id}"]`).first()).toHaveAttribute('state', 'idle');
});

test('#564-b1 at 375 px the ring strip’s ring follows the session too', async ({ page }) => {
  const { se } = await seeded(page, 30, 375);
  app.rt.updateSession(se.id, { state: 'gen' });
  await expect(page.locator(`.ringstrip pb-ring[data-session="${se.id}"]`).first()).toHaveAttribute('state', 'gen');
});
