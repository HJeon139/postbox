// A refused step in a reply’s activity list said “Refused: see the card below.”, but the refusal card sits above the
// reply once the turn ends, and below it while the turn runs (UAT of 26 Nov). Its words now point at the card without
// saying where it is.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let thread;
test.beforeAll(async () => {
  app = await startPostbox('activity-refused');
  arrange.withAdapter(app.rt, {
    name: 'mock',
    async deliver(_session, _message, ctx) {
      ctx.activity({ id: 'ls', label: 'Ran ls -la exports/', state: 'done', ms: 10 });
      ctx.activity({ id: 'rm', label: 'Delete the old exports', state: 'denied' });
      ctx.text('A permission rule refused the delete.');
    },
  });
  const persona = app.rt.createPersona({ handle: 'tidier' });
  thread = app.rt.createThread({ projectId: Object.values(app.store.state.projects)[0].id, title: 'Tidy', personaIds: [persona.id] });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

test('a refused step points at its refusal card without saying the card is below', async ({ page }) => {
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  app.rt.sendMessage(thread.id, { text: 'Tidy the workspace' });
  await expect.poll(() => arrange.liveTurns(app.rt)).toBe(0);
  await synced(page, app);
  const activity = page.locator('details.activity');
  await activity.locator('> summary').click();
  const refused = activity.locator('li.denied');
  await expect(refused).toContainText('Delete the old exports');
  await expect(refused).toContainText('Refused: its refusal card says why.');
  await expect(refused).not.toContainText('below');
});
