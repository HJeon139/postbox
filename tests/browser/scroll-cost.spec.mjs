// Scrolling a long conversation costs about the same wherever you are in it (#572). On a seeded conversation of 1,000
// agent replies, each with its five reaction buttons, the page counts the rects it reads on one scroll event near the
// end. Taking the anchor (#88) used to read one per reply above the middle of the view.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, settled, startPostbox, synced } from './postbox.mjs';

test.use({ colorScheme: 'light' });

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;

test.beforeAll(async () => {
  app = await startPostbox('scroll-cost', { demo: false });
  app.store.emit('project', { id: 'pr_scroll', name: 'Scroll', folder: app.root });
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

const REPLIES = 1000;

/** A conversation of 1,000 agent replies, open in the page and held at its end. */
async function seeded(page, name) {
  const { rt } = app;
  const p = rt.createPersona({ handle: name });
  const t = rt.createThread({ projectId: 'pr_scroll', title: `Scroll ${name}`, personaIds: [p.id] });
  const se = rt.sessionsIn(t.id)[0];
  for (let i = 0; i < REPLIES; i++)
    rt.addItem(t.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text: `Reply ${i} says one short thing.`, status: 'done' });
  await page.addInitScript(countRects);
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await expect(page.locator(`.transcript[data-thread="${t.id}"] [data-key]`)).toHaveCount(REPLIES);
  await settled(page);
  return t;
}

/** Runs in the page before Postbox does: counts getBoundingClientRect calls in window.__rects. */
function countRects() {
  const read = Element.prototype.getBoundingClientRect;
  /** @type {any} */ (window).__rects = 0;
  Element.prototype.getBoundingClientRect = function () {
    /** @type {any} */ (window).__rects++;
    return read.call(this);
  };
}

/** Scrolls the window by dy, and returns the rects read from then until its scroll event has been handled. */
const rectsFor = (page, dy) =>
  page.evaluate(
    (d) =>
      new Promise((done) => {
        /** @type {any} */ (window).__rects = 0;
        addEventListener('scroll', () => setTimeout(() => done(/** @type {any} */ (window).__rects)), { once: true });
        scrollBy(0, d);
      }),
    dy,
  );

test('#572: a scroll event near the end of 1,000 replies reads a few rects, not one per reply above', async ({ page }) => {
  await seeded(page, 'anchor');
  // Up from the end, so the view isn’t stuck there and each scroll takes the anchor.
  await rectsFor(page, -2000);
  await settled(page);
  const reads = [];
  for (let i = 0; i < 5; i++) reads.push(await rectsFor(page, -100));
  test.info().annotations.push({ type: 'measured', description: `rects per scroll event: ${reads.join(', ')}` });
  expect(Math.max(...reads), `rects read per scroll event: ${reads.join(', ')}`).toBeLessThanOrEqual(40);
});
