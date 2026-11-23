// #1715: a progress step still running read as stalled once its agent wasn't thinking, writing or calling a tool and
// the block hadn't moved for a minute. A long step that's working, such as a 20-minute browser gate, then looked stuck,
// and agents spent turns sending updates only to reset the minute. The server marks a step stalled when the turn that
// owns it ends, fails, stops or hangs (stallSteps, turn-checks.mjs), and the page now reads the turn's own state: a step
// is stalled once its turn has ended, with no background job kept running for it, not when a minute passes.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('progress-long-step');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

const GATE = {
  id: 'gate',
  type: 'progress',
  version: 1,
  title: 'The browser gate',
  fallback: 'Running the browser gate.',
  steps: [{ id: 'specs', label: 'Run the browser specs', state: 'running' }],
};

/** A thread with a running gate step for @researcher, its session patched as given, open with a fake clock. */
async function gateWith(page, title, patch) {
  const { rt } = app;
  const projectId = Object.values(rt.store.state.projects)[0].id;
  const t = rt.createThread({ projectId, title, personaIds: [arrange.persona(rt, 'researcher').id] });
  const [se] = arrange.sessionsIn(rt, t.id);
  arrange.post(rt, t.id, { kind: 'block', sessionId: se.id, handle: 'researcher', valid: true, block: GATE });
  arrange.setSession(rt, se.id, patch);
  await page.clock.install();
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  return page.locator('[data-progress] li[data-s="running"]');
}

for (const [why, patch] of [
  ['its turn waits on the person’s card', { state: 'needs', finishedAt: null }],
  [
    'its turn ended with the step held for a background job kept running',
    { state: 'idle', finishedAt: Date.now(), jobs: [{ id: 'j1', state: 'running', kept: true, command: 'npx playwright test' }] },
  ],
])
  test(`#1715 a step still running stays running past a minute with no update: ${why}`, async ({ page }) => {
    const step = await gateWith(page, `Gate, ${why}`, patch);
    await expect(step.locator('.g')).toHaveAttribute('aria-label', 'Running');
    // Three minutes with no update, the clock ticking each second.
    await page.clock.runFor(3 * 60_000);
    await expect(step.locator('.g'), 'still running, not stalled').toHaveAttribute('aria-label', 'Running');
    await expect(step, 'not dimmed as stalled').not.toHaveClass(/\bstale\b/);
    await expect(step.locator(':scope > :last-child'), 'its time, not “No update for”').not.toHaveText(/No update for/);
  });

test('#1715 a step left running by a turn that ended where the server couldn’t mark it, as at a crash, reads as stalled at once', async ({ page }) => {
  const step = await gateWith(page, 'Gate, cut off', { state: 'idle', finishedAt: Date.now() });
  await page.clock.runFor(2000);
  await expect(step.locator('.g'), 'stalled, with no minute to wait').toHaveAttribute('aria-label', 'Stalled');
  await expect(step).toHaveClass(/\bstale\b/);
});
