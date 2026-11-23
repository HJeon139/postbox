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
  // @timed is idle, so the pause and the expiry stop no turn, and their lines don’t say Postbox stopped it.
  await expect.soft(page.getByText('@timed’s run clock is paused. Postbox starts no turn of @timed until the clock resumes.')).toBeVisible();
  arrange.runClock(app.rt, se.id, { action: 'resume' }, () => t0 + 20_000);
  await expect.soft(page.getByText('@timed’s run clock resumed at 10s of 60s.')).toBeVisible();
  arrange.clockTimer(app.rt, se.id, () => t0 + 90_000);
  await expect.soft(page.getByText(/@timed’s run clock reached its budget of 60s\. Messages to @timed here now wait/)).toBeVisible();
});

test('a reply a run clock stopped says the clock stopped it, at its budget or its pause, not the person', async ({ page }) => {
  const p = app.rt.createPersona({ handle: 'stopped', description: 'Stopped by its clock' });
  const t = app.rt.createThread({ projectId: Object.keys(app.store.state.projects)[0], title: 'Clock stops', personaIds: [p.id] });
  const se = arrange.agentIn(app.rt, t.id);
  // As server/turn-stop.mjs records them: the clock’s expiry and its pause each set their own stopReason (#1526).
  const reply = (stopReason, text) =>
    arrange.post(app.rt, t.id, { kind: 'agent', sessionId: se.id, handle: 'stopped', text, status: 'stopped', stoppedAt: Date.now(), stopReason });
  const expired = reply('clock', 'Working on it until the budget.');
  const paused = reply('pause', 'Working on it until the pause.');
  const yours = reply('stop', 'Working on it until you stopped me.');
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const tag = (it) => page.locator(`.transcript [data-key="${it.id}"] .stopped-tag`);
  await expect.soft(tag(expired)).toHaveText(/^Stopped at .+: its run clock reached its budget$/);
  await expect.soft(tag(paused)).toHaveText(/^Stopped at .+: its run clock was paused$/);
  await expect.soft(tag(yours)).toHaveText(/^Stopped by you at /);
});
