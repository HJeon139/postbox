// A turn that dies says what it held (designs/rooms-at-scale.md, “Live state”): its failed reply, which has no words of
// its own, shows a quiet line before its error, with whom it was answering, how far it got and the jobs it left. The
// error, its Retry and Dismiss stay as they were, and nothing new asks for the person: no notice, no focus move.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';
import { heldBackend } from './side-threads.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
/** @type {ReturnType<typeof heldBackend>} */
let held;
test.beforeAll(async () => {
  app = await startPostbox('dead-turn-held');
  held = heldBackend(app);
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

for (const width of [375, 1280])
  test(`a failed reply with no words says what its turn held, before its error (${width} px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const { rt, store } = app;
    const researcher = Object.values(store.state.personas).find((p) => p.handle === 'researcher');
    const t = rt.createThread({ projectId: Object.values(store.state.projects)[0].id, title: `Dead turn ${width}`, personaIds: [researcher.id] });
    const [se] = arrange.sessionsIn(rt, t.id);
    await page.goto(`${app.origin}/#/t/${t.id}`);
    await synced(page, app);
    const focused = await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80));
    held.scripts.set(se.id, async (c) => {
      c.activity({ id: 's1', label: 'Read the shelf', state: 'done' });
      c.activity({ id: 's2', label: 'Ran npm test', state: 'running' });
      throw new Error('Claude Code exited with code 1.');
    });
    rt.sendMessage(t.id, { text: '@researcher which dates are riskiest?' });
    await expect.poll(() => store.state.sessions[se.id].state, { message: 'the failed turn' }).toBe('failed');
    const it = store.items(t.id).find((x) => x.kind === 'agent' && x.status === 'failed');
    const callout = page.locator(`#main [data-key="${it.id}"] .callout`);
    const line = callout.locator('.held');
    await expect(line).toHaveText('It was answering you · got to step 2, Ran npm test.');
    // Before the error, which reads as it did, with its actions.
    await expect(callout).toContainText('Claude Code exited with code 1.');
    expect(await callout.evaluate((c) => (c.textContent ?? '').indexOf('It was answering') < (c.textContent ?? '').indexOf('Claude Code exited'))).toBe(true);
    await expect(callout.getByRole('button')).toHaveText(['Retry', 'Dismiss']);
    // Nothing new: the focus stays where it was.
    expect(await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80))).toBe(focused);
  });
