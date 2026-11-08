// The smooth jump spec's setup (view-skipped-smooth.spec.mjs), moved out at that file's size limit.

import { expect, test } from '@playwright/test';
import { synced } from './postbox.mjs';
import { bigRoom, still } from './view-skipped-fixture.mjs';

/** In the page: whether scrollY stays under 2,000 and unchanged for 30 frames. */
function heldAtTop() {
  return new Promise((done) => {
    const y = scrollY;
    let n = 0;
    const tick = () => {
      if (scrollY !== y || y >= 2000) return done(false);
      if (++n >= 30) return done(true);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/**
 * A 1,000-item room, open and read from its top, with a reply since, so the pill shows: everything between the top
 * and the end has never drawn.
 * @param {any} app @param {any} page @param {string} title
 */
export async function readingAtTop(app, page, title) {
  // The setup alone can take most of a minute on CI's delayed shard, waiting for the reply below.
  test.setTimeout(90_000);
  const conv = bigRoom(app, title);
  const [se] = app.rt.sessionsIn(conv.id);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${app.origin}/#/t/${conv.id}`);
  await synced(page, app);
  await expect(page.locator(`.transcript[data-thread="${conv.id}"] > .item`)).toHaveCount(1000, { timeout: 15_000 });
  await still(page);
  // Straight to the top, so the view reads. A wheel turn up used to come first; on CI's delayed shard it didn't make the
  // view read within 15 s (ebe964fd), and the wheel case still turns the wheel itself. The top is held for 30 frames
  // before the jump.
  await page.evaluate(() => scrollTo(0, 0));
  await expect(page.locator('#main.transcript')).toHaveAttribute('data-view-mode', 'reading', { timeout: 15_000 });
  await expect.poll(() => page.evaluate(heldAtTop), { message: 'the view to hold at the top for 30 frames', timeout: 15_000 }).toBe(true);
  await still(page);
  const reply = app.rt.addItem(conv.id, {
    kind: 'agent',
    sessionId: se.id,
    personaId: se.personaId,
    handle: se.handle,
    text: 'A reply since.',
    status: 'done',
  });
  // With the server's events late and ten of these rooms at once, the reply took over 5 s to reach the page. In CI's
  // late shard the pill didn't show in 15 s on every head from d4f3ebdb: the message says whether the reply had come,
  // and how the view read, so the next run names the cause.
  const state = () =>
    page.evaluate((key) => {
      const t = /** @type {HTMLElement} */ (document.querySelector('#main.transcript'));
      const jumps = [...document.querySelectorAll('.jump')];
      return {
        mode: t?.dataset.viewMode,
        items: t?.children.length,
        replyHere: !!document.querySelector(`[data-key="${key}"]`),
        scrollY,
        gap: Math.round(document.documentElement.scrollHeight - innerHeight - scrollY),
        jumps: jumps.map((j) => ({ hidden: /** @type {HTMLElement} */ (j).hidden, text: j.textContent, inComposer: !!j.closest('.composer') })),
        transcripts: document.querySelectorAll('.transcript').length,
      };
    }, reply.id);
  // CI's report on 039a38ee: when the 15 s ran out the pill was there, unhidden, saying 1 new, with the reply on the
  // page, read just after. The reply had arrived late, in the delayed shard: wait for it, then for its pill.
  await expect(page.locator(`[data-key="${reply.id}"]`), 'the reply to reach the page').toBeAttached({ timeout: 45_000 });
  await expect(page.locator('.jump'))
    .toBeVisible({ timeout: 5_000 })
    .catch(async (e) => {
      throw new Error(`${e.message}\nthe page when the check gave up: ${JSON.stringify(await state())}`);
    });
}
