// #883: a failed reply’s callout offers Dismiss beside Retry. Dismiss keeps the error readable, quiets the callout to
// a “Dismissed” row with Retry (no role=alert, so a screen reader isn’t told again on every redraw), and the agent
// stops asking for the person. Retry after Dismiss still shows “Retried below”. At 375 and 1280 px; the lagged run sets
// POSTBOX_STREAM_LAG.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';
import { heldBackend } from './side-threads.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
/** @type {ReturnType<typeof heldBackend>} */
let held;
test.beforeAll(async () => {
  app = await startPostbox('dismiss-failed');
  held = heldBackend(app);
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

const ERROR = 'API Error: Request rejected (429). Too many tokens, please wait before trying again.';

/** A room whose agent's turn really failed, so its reply is the need and Retry can run it again. */
async function failedRoom(title) {
  const { rt, store } = app;
  const researcher = Object.values(store.state.personas).find((p) => p.handle === 'researcher');
  const t = rt.createThread({ projectId: Object.values(rt.store.state.projects)[0].id, title, personaIds: [researcher.id] });
  const [se] = arrange.sessionsIn(rt, t.id);
  held.scripts.set(se.id, async () => {
    throw new Error(ERROR);
  });
  rt.sendMessage(t.id, { text: '@researcher which dates are riskiest?' });
  await expect.poll(() => store.state.sessions[se.id].state, { message: 'the failed turn' }).toBe('failed');
  const it = store.items(t.id).find((x) => x.kind === 'agent' && x.status === 'failed');
  return { t, se, it };
}

for (const width of [375, 1280])
  test.describe(`${width} px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test(`#883 Dismiss quiets a failed reply, keeps its error and Retry, and the agent stops asking (${width} px)`, async ({ page }) => {
      const { t, se, it } = await failedRoom(`Dismiss ${width}`);
      await page.goto(`${app.origin}/#/t/${t.id}`);
      await synced(page, app);
      const reply = page.locator(`#main [data-key="${it.id}"]`);
      const callout = reply.locator('.callout');
      await expect(callout).toHaveAttribute('role', 'alert');
      await expect(callout.getByRole('button')).toHaveText(['Retry', 'Dismiss']);
      await callout.getByRole('button', { name: 'Dismiss' }).click();
      await expect.poll(() => app.store.state.sessions[se.id].needs, { message: 'the need is released' }).toBe(null);
      await expect(reply.locator('.callout')).not.toHaveAttribute('role', 'alert');
      await expect(reply).toContainText('Dismissed');
      await expect(reply).toContainText('Too many tokens');
      await expect(reply.locator('.callout').getByRole('button')).toHaveText(['Retry']);
      // A reload draws the same quiet row.
      await page.reload();
      await synced(page, app);
      await expect(reply.locator('.callout')).not.toHaveAttribute('role', 'alert');
      await expect(reply.locator('.callout').getByRole('button')).toHaveText(['Retry']);
      expect(await page.locator('#main [role="alert"]').count(), 'no alert left in the room').toBe(0);
    });

    test(`#883 Enter on Dismiss leaves focus on the reply’s Retry, not the page (${width} px)`, async ({ page }) => {
      const { t, it } = await failedRoom(`Dismiss by keyboard ${width}`);
      await page.goto(`${app.origin}/#/t/${t.id}`);
      await synced(page, app);
      const reply = page.locator(`#main [data-key="${it.id}"]`);
      await reply.locator('.callout').getByRole('button', { name: 'Dismiss' }).focus();
      await page.keyboard.press('Enter');
      await expect(reply).toContainText('Dismissed');
      await expect(reply.locator('.callout').getByRole('button', { name: 'Retry' })).toBeFocused();
    });

    test(`#883 Retry after Dismiss runs the turn again and shows “Retried below”, not “Dismissed” (${width} px)`, async ({ page }) => {
      const { t, se, it } = await failedRoom(`Retry after dismiss ${width}`);
      await page.goto(`${app.origin}/#/t/${t.id}`);
      await synced(page, app);
      const reply = page.locator(`#main [data-key="${it.id}"]`);
      await reply.locator('.callout').getByRole('button', { name: 'Dismiss' }).click();
      await expect(reply).toContainText('Dismissed');
      const before = held.turns.length;
      await reply.locator('.callout').getByRole('button', { name: 'Retry' }).click();
      await expect.poll(() => app.store.items(t.id).find((x) => x.id === it.id)?.status, { message: 'the reply is retried' }).toBe('retried');
      expect(held.turns.length, 'the turn ran again').toBeGreaterThan(before);
      await expect(reply).toContainText('Retried below');
      await expect(reply).not.toContainText('Dismissed');
      held.release(se.id);
    });
  });
