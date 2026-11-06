// #883: a failed reply’s callout offers Dismiss beside Retry. Dismiss keeps the error readable, quiets the callout to
// a “Dismissed” row with Retry (no role=alert, so a screen reader isn’t told again on every redraw), and the agent
// stops asking for the person. Retry after Dismiss still shows “Retried below”. At 375 and 1280 px; the lagged run sets
// POSTBOX_STREAM_LAG.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let persona;
test.beforeAll(async () => {
  app = await startPostbox('dismiss-failed');
  persona = app.rt.createPersona({ handle: 'analyst' });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

const ERROR = 'API Error: Request rejected (429). Too many tokens, please wait before trying again.';

/** A room whose agent's last reply failed and is its need, as a failed turn leaves it. */
function failedRoom(title) {
  const { rt } = app;
  const t = rt.createThread({ projectId: Object.values(rt.s.projects)[0].id, title, personaIds: [persona.id] });
  const [se] = rt.sessionsIn(t.id);
  const it = rt.addItem(t.id, { kind: 'agent', sessionId: se.id, handle: 'analyst', turnId: 'turn_f', status: 'failed', error: ERROR, text: '' });
  rt.updateSession(se.id, { lastTurnId: 'turn_f', needs: { kind: 'failed', itemId: it.id, text: ERROR }, state: 'failed' });
  return { t, se, it };
}

for (const width of [375, 1280])
  test.describe(`${width} px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test(`#883 Dismiss quiets a failed reply, keeps its error and Retry, and the agent stops asking (${width} px)`, async ({ page }) => {
      const { t, se, it } = failedRoom(`Dismiss ${width}`);
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

    test(`#883 Retry after Dismiss shows “Retried below”, not “Dismissed” (${width} px)`, async ({ page }) => {
      const { t, it } = failedRoom(`Retry after dismiss ${width}`);
      await page.goto(`${app.origin}/#/t/${t.id}`);
      await synced(page, app);
      const reply = page.locator(`#main [data-key="${it.id}"]`);
      await reply.locator('.callout').getByRole('button', { name: 'Dismiss' }).click();
      await expect(reply).toContainText('Dismissed');
      app.rt.patchItem(t.id, it.id, { status: 'retried' });
      await synced(page, app);
      await expect(reply).toContainText('Retried below');
      await expect(reply).not.toContainText('Dismissed');
    });
  });
