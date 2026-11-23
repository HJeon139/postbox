// #1715: a progress step still running read as stalled once its agent wasn't thinking, writing or calling a tool and
// the block hadn't moved for a minute. A long step that's working, such as a 20-minute browser gate, then looked stuck,
// and agents spent turns sending updates only to reset the minute. The server marks a step stalled when the turn that
// owns it ends, fails, stops or hangs (stallSteps, turn-checks.mjs), or when the background job it was held for ends
// (job-records.mjs). So a step still running is under a live turn or a running job, and the page shows it running.

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

for (const [why, state] of [
  ['waiting on the person’s card mid-turn', 'needs'],
  ['its turn ended, with the step held for a background job', 'idle'],
])
  test(`#1715 a step still running stays running past a minute with no update: ${why}`, async ({ page }) => {
    const { rt } = app;
    const projectId = Object.values(rt.store.state.projects)[0].id;
    const t = rt.createThread({ projectId, title: `Gate, ${state}`, personaIds: [arrange.persona(rt, 'researcher').id] });
    const [se] = arrange.sessionsIn(rt, t.id);
    arrange.post(rt, t.id, { kind: 'block', sessionId: se.id, handle: 'researcher', valid: true, block: GATE });
    arrange.setSession(rt, se.id, { state });
    await page.clock.install();
    await page.goto(`${app.origin}/#/t/${t.id}`);
    await synced(page, app);
    const step = page.locator('[data-progress] li[data-s="running"]');
    await expect(step.locator('.g')).toHaveAttribute('aria-label', 'Running');
    // Three minutes with no update, the clock ticking each second.
    await page.clock.runFor(3 * 60_000);
    await expect(step.locator('.g'), 'still running, not stalled').toHaveAttribute('aria-label', 'Running');
    await expect(step, 'not dimmed as stalled').not.toHaveClass(/\bstale\b/);
    await expect(step.locator(':scope > :last-child'), 'its time, not “No update for”').not.toHaveText(/No update for/);
  });
