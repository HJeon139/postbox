// A live event costs about the same in a long conversation as in a short one (#622). While agents work, the page hears
// a `session` change many times a second and a `thread` change with each message. In a room of 3,499 items, each
// `session` change rebuilt the ring beside every reply its agent ever wrote, about 300 SVGs, and each layout after an
// event walked the whole transcript, 389,000 layout objects: 95 ms of layout a `session` change, 62 ms a `thread` one.
// On a seeded room of 1,000 items (two agents’ replies with activity steps and reactions, your messages, a few diagrams
// and confirm blocks), the page counts the ring SVGs it builds and the activity lists it takes out while session and
// thread events arrive, and Chromium counts the layout work they cost.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, frames, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;

test.beforeAll(async () => {
  app = await startPostbox('live-event-cost', { demo: false });
  app.store.emit('project', { id: 'pr_live', name: 'Live', folder: app.root });
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

/**
 * Runs in the page before Postbox does: counts ring SVGs built (rings: each SVG, the moving overlays too; stills: the
 * SVG of a ring beside a message itself) and activity lists taken out, in window.__work.
 */
function countWork() {
  const w = { rings: 0, stills: 0, activity: 0 };
  Object.defineProperty(window, '__work', { value: w });
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.target instanceof Element && r.target.matches('pb-ring'))
        for (const n of r.addedNodes)
          if (n instanceof SVGSVGElement) {
            w.rings++;
            if (n.getAttribute('role') === 'img' && r.target.closest('.transcript .who')) w.stills++;
          }
      for (const n of r.removedNodes) if (n instanceof Element && n.matches('details.activity')) w.activity++;
    }
  }).observe(document, { childList: true, subtree: true });
}

test('#622: a ring whose agent changes state and context at once builds its SVG once', async ({ page }) => {
  const p = app.rt.createPersona({ handle: 'once' });
  const t = app.rt.createThread({ projectId: 'pr_live', title: 'Once', personaIds: [p.id] });
  const se = app.rt.sessionsIn(t.id)[0];
  app.rt.addItem(t.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text: 'One reply.', status: 'done' });
  await page.addInitScript(countWork);
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const ring = page.locator(`.transcript .who pb-ring[data-session="${se.id}"]`);
  await expect(ring).toHaveAttribute('state', 'idle');
  const was = await page.evaluate(() => /** @type {any} */ (window).__work.stills);
  app.rt.updateSession(se.id, { state: 'think', ctx: 40, subagents: [{ name: 'reader', state: 'tool', ctx: 10 }] });
  await expect(ring).toHaveAttribute('state', 'think');
  await frames(page);
  const built = (await page.evaluate(() => /** @type {any} */ (window).__work.stills)) - was;
  expect(built, 'the ring’s SVG, built once for its state, context and subagent together').toBe(1);
});
