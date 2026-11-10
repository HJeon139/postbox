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

/**
 * Whether the comment highlight paints on the nth review’s text: its preview drawn with the highlight and without it
 * differ. `.size` alone counts ranges that Firefox never paints, as when they were added before the block was on the
 * page (the integrator’s read of #1159).
 * @param {import('@playwright/test').Page} page @param {number} n
 */
async function painted(page, n) {
  const md = page.locator('.rv-preview .md').nth(n);
  const marked = await md.screenshot();
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.pbQuotes = CSS.highlights.get('rv-quote');
    CSS.highlights.delete('rv-quote');
  });
  const plain = await md.screenshot();
  await page.evaluate(() => CSS.highlights.set('rv-quote', /** @type {any} */ (window).pbQuotes));
  return !marked.equals(plain);
}

/** Opens another conversation, once the page has heard of it, and waits for the reviews to leave the page. */
async function switchAway(page) {
  const other = app.rt.createThread({ projectId: Object.values(app.rt.s.projects)[0].id, title: 'Elsewhere', personaIds: [drafter.id] });
  await synced(page, app);
  await page.goto(`${app.origin}/#/t/${other.id}`);
  await expect(page.locator('.rv-preview .md'), 'the other conversation drawn').toHaveCount(0);
}

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
      if (message.kind === 'user' && message.text.endsWith('revise'))
        ctx.tools.update_block({ block: { ...review(1), content: `${CONTENT}\n\nOne more line.` } });
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
  expect(await painted(page, 0), 'the first review’s quote paints').toBe(true);
  expect(await painted(page, REVIEWS - 1), 'and the last one’s').toBe(true);

  // A revised review draws again: its old marks leave the highlight, so it still holds one per review.
  rt.sendMessage(thread.id, { text: '@drafter revise' });
  await expect.poll(() => rt.turns.size, { message: 'the agent to finish' }).toBe(0);
  await synced(page, app);
  await expect(page.locator('.rv-preview .md', { hasText: 'One more line.' }), 'the revision drawn in Preview').toHaveCount(1);
  await expect
    .poll(() => page.evaluate(() => CSS.highlights.get('rv-quote')?.size ?? 0), { message: 'one mark per review, not the old ones too' })
    .toBe(REVIEWS);
  const revised = page.locator('.rv-preview .md').filter({ hasText: 'One more line.' });
  const index = await revised.evaluate((el) => [...document.querySelectorAll('.rv-preview .md')].indexOf(el));
  expect(await painted(page, index), 'the revision’s quote paints').toBe(true);

  // To another conversation and back: the reviews draw again, and their quotes paint again.
  await switchAway(page);
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await expect(page.locator('.rv-preview .md')).toHaveCount(REVIEWS);
  await expect.poll(() => page.evaluate(() => CSS.highlights.get('rv-quote')?.size ?? 0), { message: 'one mark per review after the switch' }).toBe(REVIEWS);
  expect(await painted(page, 0), 'after a room switch, a quote paints').toBe(true);
});
