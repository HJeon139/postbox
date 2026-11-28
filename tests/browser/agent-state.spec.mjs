// Each agent’s state in its row in the sidebar (#1403; designs/rooms-at-scale.md, “Live state”): running with its
// step, waiting on a job, needs you, failed, or idle, read from the room’s records by
// shared/agent-state.mjs. The rail doesn’t scroll with the transcript, so the row is in view wherever you’ve scrolled,
// and a change of state keeps the row’s size, so nothing moves under the pointer.
// On the demo’s Index planning, whose records are written in the server’s store as Running, the work ledger and
// Delivery write them; no agent runs.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let planning;
let indexer;
let researcher;

test.beforeAll(async () => {
  app = await startPostbox('agent-state');
  planning = Object.values(app.store.state.threads).find((t) => t.title === 'Index planning');
  indexer = arrange.agentIn(app.rt, planning.id, 'indexer');
  researcher = arrange.agentIn(app.rt, planning.id, 'researcher');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);
// Times read in the page’s locale (#535), so the words checked here are en-US’s: clock.spec.mjs covers other locales.
test.use({ locale: 'en-US' });

/** An agent’s button in its row, which `agent-row-` names, and its state’s words. */
const button = (page, se) => page.locator(`#agent-row-${se.id}`);
const words = (page, se) => button(page, se).locator('.agent-state');
const box = (page, se) =>
  page
    .locator('.rail .agent-line')
    .filter({ has: button(page, se) })
    .boundingBox();

const clockOf = (ms) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

/**
 * Opens Index planning with @indexer idle, and marks its row, so a test can hold that the row keeps its place and size
 * as its state changes, and is painted in place, never rebuilt (#987, #1130).
 */
async function openIdle(page) {
  await page.goto(`${app.origin}/#/t/${planning.id}`);
  await synced(page, app);
  await expect(words(page, indexer)).toHaveText(' · idle');
  const idle = await box(page, indexer);
  const row = page.locator('.rail .agent-row').filter({ has: button(page, indexer) });
  await row.evaluate((n) => n.setAttribute('data-first', ''));
  return {
    sizeHolds: async (what) => expect(await box(page, indexer), `${what}: the row keeps its place and size`).toEqual(idle),
    sameNode: () => expect(page.locator('.rail .agent-row[data-first]').filter({ has: button(page, indexer) }), 'the same row node throughout').toHaveCount(1),
  };
}

test('an agent’s row says what it runs or waits on, from its session and its jobs', async ({ page }) => {
  const row = await openIdle(page);

  // Running, with its step: a long one is cut on its one line, and its whole text is the row’s tooltip.
  const step = `Running npm test -- --grep ${'a very long pattern '.repeat(6).trim()}`;
  arrange.setSession(app.rt, indexer.id, { state: 'tool', currentStep: step });
  await expect(words(page, indexer)).toHaveText(` · ${step}`);
  await expect(button(page, indexer).locator('.name > span').first()).toHaveAttribute('title', step);
  await row.sizeHolds('running');
  // The person presses Stop: the row says so until the turn ends, not its last step.
  arrange.setSession(app.rt, indexer.id, { state: 'stopping' });
  await expect(words(page, indexer)).toHaveText(' · stopping');

  // Its turn ends with a job it kept running in the background: waiting on that job.
  const job = { id: 'job-1', sessionId: indexer.id, label: 'Build the index', state: 'running', kept: true };
  arrange.setSession(app.rt, indexer.id, { state: 'idle', currentStep: '', jobs: [job] });
  await expect(words(page, indexer)).toHaveText(' · waiting on a job: Build the index');
  await row.sizeHolds('waiting on a job');

  // The job ends, and what it posted to @researcher still waits in its inbox behind its turn: a hand-off never shows its
  // sender as waiting, so its row says idle (#1975).
  arrange.setSession(app.rt, researcher.id, { state: 'tool', currentStep: 'Reading the shelf' });
  arrange.setSession(app.rt, indexer.id, { jobs: [] });
  const entry = { id: 'en-posted', sessionId: researcher.id, threadId: planning.id, from: 'indexer', source: 'mention', state: 'waiting', at: Date.now() };
  app.store.emit('entry.add', { sessionId: researcher.id, entry });
  await expect(words(page, researcher), 'the agent it posted to says its own state').toHaveText(' · Reading the shelf');
  await expect(words(page, indexer)).toHaveText(' · idle');
  await expect(button(page, indexer), 'and no row says it waits behind another').not.toContainText('waiting behind');
  await row.sameNode();
});

test('an agent’s row says when it is out of quota, retrying, needs you or failed', async ({ page }) => {
  const row = await openIdle(page);
  // Its harness ran out of quota, with the reset time it gave.
  const reset = Date.now() + 3 * 3600_000;
  arrange.setSession(app.rt, indexer.id, { quota: { until: reset } });
  await expect(words(page, indexer)).toHaveText(` · out of quota until ${clockOf(reset)}`);
  await row.sizeHolds('out of quota');
  arrange.setSession(app.rt, indexer.id, { quota: null });

  // Its provider failed its turn for a while, and Postbox tries it again on its own at a set time (#1713): the row says
  // when, the ring isn’t the alert color of a failure, and it never reads as needs you.
  const at = Date.now() + 2 * 60_000;
  arrange.setSession(app.rt, indexer.id, { state: 'failed', autoRetry: { tries: 1, at, status: 529 } });
  await expect(words(page, indexer)).toHaveText(` · retrying at ${clockOf(at)}`);
  await expect(page.locator(`.rail pb-ring[name="indexer"]`).first()).toHaveAttribute('state', 'retrying');
  await row.sizeHolds('retrying');
  arrange.setSession(app.rt, indexer.id, { state: 'idle', autoRetry: null });

  arrange.setSession(app.rt, indexer.id, { state: 'needs' });
  await expect(words(page, indexer)).toHaveText(' · needs you');
  arrange.setSession(app.rt, indexer.id, { state: 'failed' });
  await expect(words(page, indexer)).toHaveText(' · failed');
  await row.sizeHolds('failed');

  arrange.setSession(app.rt, indexer.id, { state: 'idle' });
  await expect(words(page, indexer)).toHaveText(' · idle');
  await row.sameNode();
});

test('nothing in the work list repaints an agent row: its jobs are on its session', async ({ page }) => {
  await page.goto(`${app.origin}/#/t/${planning.id}`);
  await synced(page, app);
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.rowWrites = 0;
    new MutationObserver((list) => {
      w.rowWrites += list.length;
    }).observe(document.querySelector('.rail .agent-rows'), { childList: true, subtree: true, characterData: true, attributes: true });
  });
  // A file read, and a background command with its end: the work list grows with the room, and a row reads none of it.
  for (let i = 0; i < 20; i++) {
    const base = { sessionId: indexer.id, handle: 'indexer', state: 'done' };
    app.store.emit('work.add', { convId: planning.id, entry: { ...base, kind: 'read', id: `wr-${i}`, path: `/tmp/f${i}` } });
    const command = { ...base, kind: 'command', id: `wc-${i}`, command: 'npm run build', background: true, state: 'background' };
    app.store.emit('work.add', { convId: planning.id, entry: command });
    app.store.emit('work.patch', { convId: planning.id, id: `wc-${i}`, patch: { state: 'done' } });
  }
  await synced(page, app);
  expect(await page.evaluate(() => /** @type {any} */ (window).rowWrites)).toBe(0);
});
