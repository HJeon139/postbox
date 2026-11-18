// The thread panel’s composer never covers what has focus either (#232, WCAG 2.4.11 Focus Not Obscured), now that it
// floats over the end of the panel’s thread (#1500): Shift+Tab from the panel’s input to the thread’s last control,
// just under the card, scrolls the panel so the control is in view above it. At 1280 and 375 px.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, frames, settled, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('focus-clear-panel');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

let count = 0;
/** A topic thread with @librarian’s replies, long enough to scroll, open in the thread panel at its end. */
async function panel(page, width) {
  const { rt, store } = app;
  const t = rt.createThread({
    projectId: Object.keys(store.state.projects)[0],
    title: `Panel focus ${++count}`,
    personaIds: [arrange.persona(rt, 'librarian').id],
  });
  const se = arrange.agentIn(rt, t.id);
  const reply = (threadId, text) =>
    arrange.post(rt, threadId, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text, status: 'done' });
  const said = reply(t.id, 'The shelves are sorted.');
  const { threadId } = rt.startTopic(t.id, said.id);
  for (let i = 1; i <= 12; i++) {
    arrange.post(rt, threadId, { kind: 'user', text: `Question ${i}: which shelf holds the 1874 Middlemarch?` });
    reply(threadId, `Answer ${i}: the third shelf, by the window.`);
  }
  await page.setViewportSize({ width, height: 800 });
  await page.goto(`${app.origin}/#/t/${t.id}/side/${threadId}`);
  await synced(page, app);
  await expect(page.locator('.sidepanel .transcript').getByText('Answer 12:')).toBeVisible();
  await settled(page);
}

const body = (page) => page.locator('.sidepanel .sp-body');
/** Where the panel’s composer starts to cover the thread: its column’s top. */
const coverTop = (page) => page.locator('.sidepanel .composer .col').evaluate((c) => c.getBoundingClientRect().top);

for (const width of [1280, 375])
  test(`#1500 at ${width} px: Shift+Tab from the panel’s input to its thread’s last control leaves it in view above the card`, async ({ page }) => {
    await panel(page, width);
    const last = page.locator('.sidepanel .transcript > .item').last().getByRole('button').last();
    // The last control just under the card: you scrolled up a little to read, say.
    await body(page).evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await settled(page);
    const under = async () => ((await last.boundingBox())?.y ?? 0) - (await coverTop(page));
    await body(page).evaluate(
      (el, by) => {
        el.scrollTop += by;
      },
      (await under()) - 4,
    );
    await expect.poll(async () => Math.round(await under()), { message: 'the last control 4 px under the card' }).toBe(4);
    await page.evaluate(() => document.getElementById('side-input')?.focus({ preventScroll: true }));
    await frames(page);
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Shift+Tab');
      if (await last.evaluate((el) => el === document.activeElement)) break;
    }
    await expect(last, 'Shift+Tab left the panel’s composer for its thread’s last control').toBeFocused();
    await expect
      .poll(async () => Math.max(0, Math.round(((await last.boundingBox())?.y ?? 0) + ((await last.boundingBox())?.height ?? 0) - (await coverTop(page)))), {
        message: 'the control clear of the card',
      })
      .toBe(0);
  });
