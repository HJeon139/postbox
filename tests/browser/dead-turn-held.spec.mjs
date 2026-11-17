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

test('the line shows on a host’s Interrupted reply, and on replies a store outage or a restart stopped, before what ended them', async ({ page }) => {
  const { rt, store } = app;
  const researcher = Object.values(store.state.personas).find((p) => p.handle === 'researcher');
  const t = rt.createThread({ projectId: Object.values(store.state.projects)[0].id, title: 'Cut off', personaIds: [researcher.id] });
  const [se] = arrange.sessionsIn(rt, t.id);
  const held = { took: [{ from: 'you' }], steps: 3, last: 'Read the shelf', running: [], stopped: [] };
  const reply = (/** @type {any} */ o) =>
    arrange.post(rt, t.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, turnId: `tu_${o.key}`, text: '', held, ...o.item });
  const host = reply({
    key: 'host',
    item: { status: 'failed', error: 'Interrupted on devbox: the agent’s process there ended.', remote: { state: 'interrupted', hostId: 'h1' } },
  });
  const outage = reply({ key: 'store', item: { status: 'stopped', stopReason: 'store' } });
  const restart = reply({ key: 'restart', item: { status: 'stopped' } });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const line = 'It was answering you · got to step 3, Read the shelf.';
  const hostCallout = page.locator(`#main [data-key="${host.id}"] .host-callout`);
  await expect(hostCallout.locator('.held')).toHaveText(line);
  await expect(hostCallout).toContainText('Interrupted on');
  for (const it of [outage, restart]) {
    const item = page.locator(`#main [data-key="${it.id}"]`);
    await expect(item.locator('.held')).toHaveText(line);
    expect(await item.evaluate((n) => (n.textContent ?? '').indexOf('It was answering') < (n.textContent ?? '').indexOf('Stopped'))).toBe(true);
  }
});
