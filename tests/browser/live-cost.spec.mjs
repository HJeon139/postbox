// What a running turn’s steps cost the page (#573’s rule, for the live view, designs/rooms-at-scale.md “Live state”):
// four agents work at once, on a CPU slowed six times, and Chromium counts its layouts while their steps land. Each
// agent’s turn is the mock citation turn’s shape, 11 calls with words between some, sent through the turn’s own
// activity and text, which main has too, so the same stream runs on both. A step paints its reply’s live block, not the
// whole reply, so the page does no more layout a step than main did. MAIN is main’s count, measured with this spec.

import { setTimeout as pace } from 'node:timers/promises';
import { expect, test } from '@playwright/test';
import { failOnPageErrors, frames, startPostbox, synced } from './postbox.mjs';

// Main’s layouts a step for this stream, at 6× throttle: 2.64, 2.64 and 2.66 in three runs on f6ac0e7b.
const MAIN = 2.66;
const AGENTS = ['ana', 'ben', 'cal', 'dee'];

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
const CALLS = [
  'Read cite.py',
  'Ran python cite.py',
  'Edited cite.py',
  'Ran pytest -q',
  'Read refs.bib',
  'Edited refs.bib',
  'Ran pytest -q',
  'Read README.md',
  'Edited README.md',
  'Ran git diff --stat',
  'Ran pytest -q',
];

test.beforeAll(async () => {
  app = await startPostbox('live-cost', { demo: false });
  app.store.emit('project', { id: 'pr_live', name: 'Live', folder: app.root });
  app.rt.adapters.register({
    name: 'mock',
    async deliver(/** @type {any} */ session, /** @type {any} */ _m, /** @type {any} */ ctx) {
      ctx.text('Fixing the citation script.');
      for (const [i, label] of CALLS.entries()) {
        const id = `${session.handle}-${i}`;
        ctx.activity({ id, label, state: 'running', input: `command: step ${i}` });
        await pace(60); // the agents’ own pace: how fast their steps come, not a wait on the page
        ctx.activity({ id, label, state: 'done', ms: 60, output: `step ${i} ok` });
        if (i % 3 === 2) ctx.text(` Step ${i} went through.`);
        await pace(40);
      }
      ctx.text(' Done.');
    },
  });
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

test('four agents’ steps cost the page no more layout a step than main', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const ids = AGENTS.map((handle) => app.rt.createPersona({ handle }).id);
  const t = app.rt.createThread({ projectId: 'pr_live', title: 'Four at once', personaIds: ids });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
  const layouts = async () => (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === 'LayoutCount')?.value ?? 0;
  const before = await layouts();
  for (const who of AGENTS) app.rt.sendMessage(t.id, { text: `@${who} fix the citation script` });
  // The turns end on the server; the page has drawn every step once it has heard all of it.
  await expect.poll(() => app.rt.turns.size === 0 && AGENTS.every((w) => app.store.items(t.id).some((x) => x.handle === w)), { timeout: 120_000 }).toBe(true);
  await synced(page, app);
  await frames(page);
  const after = await layouts();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  const steps = app.store.items(t.id).reduce((n, x) => n + (x.activity?.steps?.length ?? 0), 0);
  const perStep = (after - before) / steps;
  test.info().annotations.push({ type: 'measured', description: JSON.stringify({ layouts: after - before, steps, perStep: +perStep.toFixed(2) }) });
  expect(steps, 'every agent’s steps were drawn').toBe(AGENTS.length * CALLS.length);
  expect(perStep, `layouts a step: ${(after - before).toFixed(0)} for ${steps} steps`).toBeLessThanOrEqual(MAIN);
});
