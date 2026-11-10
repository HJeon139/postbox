// #1151: the comment highlight (CSS Custom Highlight, `rv-quote`) was rebuilt from every review’s ranges, and set
// again, once for each review drawn, so opening a room with many reviews cost reviews × all their ranges. In the
// person’s Firefox profile of 9 November that was 4.8 s of an 11.6 s room switch. One highlight is now built once and
// kept: each review adds and removes only its own ranges.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

const REVIEWS = 8;
const CONTENT = ['Line one is really bold here.', '', 'A second paragraph.'].join('\n');
/** A review whose one open thread is on “really bold” (line 1, columns 13 to 23, from 1). */
const review = (n) => ({
  id: `hl-${n}`,
  type: 'review',
  version: 1,
  title: `notes-${n}.md`,
  fallback: 'The notes',
  format: 'markdown',
  content: CONTENT,
  threads: [
    { id: 't1', line: 1, col: 13, endLine: 1, endCol: 23, quote: 'really bold', status: 'open', comments: [{ author: '@drafter', text: 'Too loud.' }] },
  ],
});

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
/** @type {any} */
let drafter;
test.beforeAll(async () => {
  app = await startPostbox('review-highlight-cost');
  app.rt.adapters.register({
    name: 'mock',
    async deliver(_session, message, ctx) {
      if (message.kind === 'user' && message.text.endsWith('reviews')) for (let n = 1; n <= REVIEWS; n++) ctx.tools.show_block({ block: review(n) });
    },
  });
  drafter = app.rt.createPersona({ handle: 'drafter' });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

test('#1151 opening a room of eight commented reviews builds the comment highlight once, and marks every review’s text', async ({ page }) => {
  // Counts each Highlight built and each one set, from before the page’s own scripts run.
  await page.addInitScript(() => {
    const w = /** @type {any} */ (window);
    w.pbHighlights = { built: 0, set: 0 };
    if (typeof w.Highlight !== 'function' || !w.CSS?.highlights) return;
    const Real = w.Highlight;
    w.Highlight = class extends Real {
      constructor(...ranges) {
        super(...ranges);
        w.pbHighlights.built++;
      }
    };
    const set = w.CSS.highlights.set.bind(w.CSS.highlights);
    w.CSS.highlights.set = (name, h) => {
      if (name === 'rv-quote') w.pbHighlights.set++;
      return set(name, h);
    };
  });
  const { rt, store } = app;
  const thread = rt.createThread({ projectId: Object.values(rt.s.projects)[0].id, title: 'Many reviews', personaIds: [drafter.id] });
  rt.sendMessage(thread.id, { text: '@drafter reviews' });
  await expect.poll(() => store.items(thread.id).filter((i) => i.kind === 'block').length, { message: 'the reviews' }).toBe(REVIEWS);
  await expect.poll(() => rt.turns.size, { message: 'the agent to finish' }).toBe(0);

  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  await expect(page.locator('.rv-preview .md'), 'every review drawn').toHaveCount(REVIEWS);
  await expect.poll(() => page.evaluate(() => CSS.highlights.get('rv-quote')?.size ?? 0), { message: 'every review’s text marked' }).toBe(REVIEWS);
  const counts = await page.evaluate(() => /** @type {any} */ (window).pbHighlights);
  test.info().annotations.push({ type: 'measured', description: `Highlight built ${counts.built}, set ${counts.set}` });
  expect(counts.built, 'the highlight is built once, not once per review').toBeLessThanOrEqual(1);
  expect(counts.set, 'and set once').toBeLessThanOrEqual(1);
});
