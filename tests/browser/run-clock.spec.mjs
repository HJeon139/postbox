// An agent’s run clock in the conversation (server/run-clock-notes.mjs), with run clocks on: each change of it shows as
// a line there, so an expired clock, which holds every message to its agent, isn’t silent (#1526).

import { expect, test } from '@playwright/test';
import { installRunClock } from '../../server/run-clock-install.mjs';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('run-clock');
  // As a Postbox started with POSTBOX_RUN_CLOCK=1 has them (#1526).
  installRunClock(app.rt);
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

test('the conversation shows a clock’s start, its pause and resume, and its expiry, with what the expiry means', async ({ page }) => {
  const p = app.rt.createPersona({ handle: 'timed', description: 'Works against a clock' });
  const t = app.rt.createThread({ projectId: Object.keys(app.store.state.projects)[0], title: 'A timed run', personaIds: [p.id] });
  const se = arrange.agentIn(app.rt, t.id);
  const t0 = Date.now();
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  arrange.runClock(app.rt, se.id, { action: 'start', budgetS: 60 }, () => t0);
  await expect.soft(page.getByText('@timed’s run clock started, with a budget of 60s.')).toBeVisible();
  arrange.runClock(app.rt, se.id, { action: 'pause' }, () => t0 + 10_000);
  await expect.soft(page.getByText(/@timed’s run clock is paused\. Postbox stopped @timed/)).toBeVisible();
  arrange.runClock(app.rt, se.id, { action: 'resume' }, () => t0 + 20_000);
  await expect.soft(page.getByText('@timed’s run clock resumed at 10s of 60s.')).toBeVisible();
  arrange.clockTimer(app.rt, se.id, () => t0 + 90_000);
  await expect.soft(page.getByText(/reached its budget of 60s, so Postbox stopped @timed\. Messages to @timed here now wait/)).toBeVisible();
});
