// Each agent’s state in its row in the sidebar (#1403; designs/rooms-at-scale.md, “Live state”): running with its
// step, waiting on a job, waiting behind another agent, needs you, failed, or idle, read from the room’s records by
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

test('an agent’s row says what it runs or waits on, from its session, its jobs and the inboxes', async ({ page }) => {
  const row = await openIdle(page);

  // Running, with its step: a long one is cut on its one line, and its whole text is the row’s tooltip.
  const step = `Running npm test -- --grep ${'a very long pattern '.repeat(6).trim()}`;
  arrange.setSession(app.rt, indexer.id, { state: 'tool', currentStep: step });
  await expect(words(page, indexer)).toHaveText(` · ${step}`);
  await expect(button(page, indexer).locator('.name > span').first()).toHaveAttribute('title', step);
  await row.sizeHolds('running');

  // Its turn ends with a command it started in the background still running: waiting on that job.
  const job = { kind: 'command', id: 'wc-job', sessionId: indexer.id, handle: 'indexer', command: 'npm run build', description: 'Build the index' };
  app.store.emit('work.add', { convId: planning.id, entry: { ...job, background: true, state: 'background' } });
  arrange.setSession(app.rt, indexer.id, { state: 'idle', currentStep: '' });
  await expect(words(page, indexer)).toHaveText(' · waiting on a job: Build the index');
  await row.sizeHolds('waiting on a job');

  // The job ends, and what it posted to @researcher still waits in its inbox behind its turn.
  arrange.setSession(app.rt, researcher.id, { state: 'tool', currentStep: 'Reading the shelf' });
  app.store.emit('work.patch', { convId: planning.id, id: 'wc-job', patch: { state: 'done' } });
  const at = Date.now();
  const entry = { id: 'en-behind', sessionId: researcher.id, threadId: planning.id, from: 'indexer', source: 'mention', state: 'waiting', at };
  app.store.emit('entry.add', { sessionId: researcher.id, entry });
  await expect(words(page, indexer)).toHaveText(` · waiting behind @researcher since ${clockOf(at)}`);
  await expect(words(page, researcher), 'the agent it waits on says its own state').toHaveText(' · Reading the shelf');
  await row.sizeHolds('waiting behind');

  // @researcher takes it: nothing is left to wait on.
  app.store.emit('entry.patch', { sessionId: researcher.id, id: 'en-behind', patch: { state: 'taken' } });
  arrange.setSession(app.rt, researcher.id, { state: 'idle', currentStep: '' });
  await expect(words(page, indexer)).toHaveText(' · idle');
  await row.sameNode();
});

test('an agent’s row says when it is out of quota, needs you or failed', async ({ page }) => {
  const row = await openIdle(page);
  // Its harness ran out of quota, with the reset time it gave.
  const reset = Date.now() + 3 * 3600_000;
  arrange.setSession(app.rt, indexer.id, { quota: { until: reset } });
  await expect(words(page, indexer)).toHaveText(` · out of quota until ${clockOf(reset)}`);
  await row.sizeHolds('out of quota');
  arrange.setSession(app.rt, indexer.id, { quota: null });

  arrange.setSession(app.rt, indexer.id, { state: 'needs' });
  await expect(words(page, indexer)).toHaveText(' · needs you');
  arrange.setSession(app.rt, indexer.id, { state: 'failed' });
  await expect(words(page, indexer)).toHaveText(' · failed');
  await row.sizeHolds('failed');

  arrange.setSession(app.rt, indexer.id, { state: 'idle' });
  await expect(words(page, indexer)).toHaveText(' · idle');
  await row.sameNode();
});

test('a step or a file in the work list repaints no agent row', async ({ page }) => {
  await page.goto(`${app.origin}/#/t/${planning.id}`);
  await synced(page, app);
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.rowWrites = 0;
    new MutationObserver((list) => {
      w.rowWrites += list.length;
    }).observe(document.querySelector('.rail .agent-rows'), { childList: true, subtree: true, characterData: true, attributes: true });
  });
  for (let i = 0; i < 20; i++)
    app.store.emit('work.add', {
      convId: planning.id,
      entry: { kind: 'read', id: `wr-${i}`, sessionId: indexer.id, handle: 'indexer', path: `/tmp/f${i}`, state: 'done' },
    });
  await synced(page, app);
  expect(await page.evaluate(() => /** @type {any} */ (window).rowWrites)).toBe(0);
});
