// #535: times in a conversation were always on a 24-hour clock, so a message sent at 12:30 AM read “00:30” to a person
// whose clock is 12-hour. Times now follow the browser’s locale: “12:30 AM” in en-US, “00:30” in en-GB, and they still
// fit beside the sender’s name in a phone-width window. A quota’s reset time is on the same clock.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced, windowWidth } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('clock');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

// 00:30 on 21 November 2026, in the page’s time zone, which each test sets to UTC.
const HALF_PAST_MIDNIGHT = Date.UTC(2026, 10, 21, 0, 30);
let n = 0;

for (const [locale, shown, reset] of [
  ['en-US', /^12:30\sAM$/, /^12:30 am$/],
  ['en-GB', /^00:30$/, /^00:30$/],
]) {
  test.describe(locale, () => {
    test.use({ locale, timezoneId: 'UTC', viewport: { width: 375, height: 812 } });
    test(`#535 a message sent at 00:30 shows its time on the ${locale} clock, and it fits at 375 px`, async ({ page }) => {
      const { rt } = app;
      const projectId = Object.values(rt.store.state.projects)[0].id;
      const t = rt.createThread({ projectId, title: `Clock ${++n}`, personaIds: [arrange.persona(rt, 'librarian').id] });
      arrange.post(rt, t.id, { kind: 'user', text: 'Late one', at: HALF_PAST_MIDNIGHT });
      await page.goto(`${app.origin}/#/t/${t.id}`);
      await synced(page, app);
      const ts = page.locator('.transcript .ts').first();
      await expect(ts).toHaveText(shown);
      const box = await ts.boundingBox();
      expect(box && box.x + box.width <= windowWidth(page), 'the time fits the window').toBe(true);
      const lines = await ts.evaluate((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)));
      expect(lines, 'on one line').toBe(1);
      // A quota’s reset time, in the composer, on the same clock.
      const at = await page.evaluate((ms) => import('/app/js/quota-words.mjs').then((m) => m.resetTime(ms, ms - 60_000)), HALF_PAST_MIDNIGHT);
      expect(at, 'a quota’s reset time').toMatch(reset);
    });
  });
}
