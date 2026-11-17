// #466 and #1218’s rule: a turn lost to the network sends what it took once more, on its own. Its reply says so, as
// retried below with a note, not as a failure with Retry; the agent isn’t failed, and no blocking alert goes up, since
// the person has nothing to act on. The resend’s reply follows it. At 375 and 1280 px; the lagged run sets
// POSTBOX_STREAM_LAG. And #442: a turn out of quota needs nobody either. Every agent on the backend shows out of
// quota in its row and its ring, and nothing says needs you or raises an alert; its ring isn’t a button to what it
// needs. Its one info notice is a badge, not a toast.

import { expect, test } from '@playwright/test';
import { withQuota } from '../../server/harness-failure.mjs';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';
import { heldBackend } from './side-threads.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
/** @type {ReturnType<typeof heldBackend>} */
let held;
test.beforeAll(async () => {
  app = await startPostbox('lost-resend');
  held = heldBackend(app);
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

for (const width of [375, 1280])
  test.describe(`${width} px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test(`#466 a reply lost to the network shows as retried below, and its resend answers (${width} px)`, async ({ page }) => {
      const { rt, store } = app;
      const researcher = Object.values(store.state.personas).find((p) => p.handle === 'researcher');
      const t = rt.createThread({ projectId: Object.values(store.state.projects)[0].id, title: `Lost ${width}`, personaIds: [researcher.id] });
      const [se] = arrange.sessionsIn(rt, t.id);
      await page.goto(`${app.origin}/#/t/${t.id}`);
      await synced(page, app);
      held.scripts.set(se.id, async (/** @type {any} */ ctx) => {
        ctx.text('Checking the shelf');
        throw new Error('Claude Code couldn’t reach the API.', { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
      });
      rt.sendMessage(t.id, { text: '@researcher which dates are riskiest?' });
      await expect.poll(() => held.turns.filter((x) => x.sessionId === se.id).length, { message: 'the resend started' }).toBe(2);
      const lost = store.items(t.id).find((x) => x.kind === 'agent' && x.status === 'retried');
      const reply = page.locator(`#main [data-key="${lost.id}"]`);
      await expect(reply).toContainText('Retried below');
      await expect(reply).toContainText('Postbox sent it again');
      await expect(reply.locator('.callout')).toHaveCount(0);
      expect(store.state.sessions[se.id].state).not.toBe('failed');
      held.release(se.id);
      await expect(page.locator('#main .turn').last()).toContainText('Done.');
      await expect(page.getByRole('alert')).toHaveCount(0);
    });
  });

test('#442 a turn out of quota marks every agent on its backend in its row, and needs nobody', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const { rt, store } = app;
  const persona = (/** @type {string} */ handle) => Object.values(store.state.personas).find((p) => p.handle === handle);
  const t = rt.createThread({
    projectId: Object.values(store.state.projects)[0].id,
    title: 'Out of quota',
    personaIds: [persona('researcher').id, persona('indexer').id],
  });
  const [researcher, indexer] = ['researcher', 'indexer'].map((h) => arrange.agentIn(rt, t.id, h));
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const until = Date.now() + 3 * 3600_000;
  held.scripts.set(researcher.id, async () => {
    throw withQuota(new Error('You’ve hit your usage limit.'), { until });
  });
  rt.sendMessage(t.id, { text: '@researcher which dates are riskiest?' });
  for (const se of [researcher, indexer]) await expect(page.locator(`#agent-row-${se.id} .agent-state`)).toContainText('out of quota until');
  await expect(page.locator('.agent-state', { hasText: 'needs you' })).toHaveCount(0);
  // Each ring says out of quota, and isn’t a button to what the agent needs, since it needs nothing.
  for (const se of [researcher, indexer]) {
    const rings = page.locator(`pb-ring[data-session="${se.id}"]`);
    await expect(rings.first().locator('svg')).toHaveAttribute('aria-label', /Out of quota/);
    await expect(page.locator(`pb-ring[data-session="${se.id}"][role="button"]`)).toHaveCount(0);
  }
  const reply = page.locator('#main .callout', { hasText: 'You’ve hit your usage limit.' });
  await expect(reply.getByRole('button', { name: 'Retry' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});
