// #1654: the ring beside an agent’s newest message goes to what it needs, also when the turn that asked began with a
// part that holds only steps. The page hides such a part (recordMoved, activity-paint.mjs), but the speaker line went
// with it: its ring was the one that followed the agent, and the choice after it drew no line. So the only ring left
// on screen was the resting one on the agent’s earlier write-up, and a click stayed there.
//
// The items are UAT run 2026-11-22T19-14-39-needsnav’s, step 7 (thread th_j2bVFjqm, items 1 to 9): a long write-up,
// your message, then a turn whose first part is one thought step with no words, its choice block, and a short reply.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('needs-ring-steps');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);
test.use({ viewport: { width: 1280, height: 800 } });

// The run's block, cut to what the page draws.
const CHOICE = {
  id: 'partition-choice',
  type: 'choice',
  version: 1,
  title: 'Partition the year of click logs by',
  fallback: 'Partition the year of click logs by day or by customer?',
  options: [
    { id: 'day', label: 'Day (Recommended)' },
    { id: 'customer', label: 'Customer' },
  ],
};
// The run's step: a thought, done, with no words of the turn's own.
const THOUGHT = { id: 'thought-1', label: 'I’m setting up a choice block so the user can pick…', state: 'done', ms: null, kind: 'thought' };

test('#1654 the ring beside an agent’s newest message goes to its choice when its turn began with steps alone', async ({ page }) => {
  const { rt } = app;
  const projectId = Object.values(rt.store.state.projects)[0].id;
  const researcher = arrange.persona(rt, 'researcher');
  const t = rt.createThread({ projectId, title: 'Click logs', personaIds: [researcher.id] });
  const [se] = arrange.sessionsIn(rt, t.id);
  const agent = (turnId, fields) => arrange.post(rt, t.id, { kind: 'agent', sessionId: se.id, handle: 'researcher', turnId, status: 'done', ...fields });
  arrange.post(rt, t.id, { kind: 'user', text: '@researcher write up how to store a year of click logs.' });
  agent('turn_A', { text: `## Storing a year of click logs\n\n${'Each day’s logs go to their own file. '.repeat(120)}` });
  arrange.post(rt, t.id, { kind: 'user', text: '@researcher which partition do you recommend? Ask me with a choice.' });
  const stepsOnly = agent('turn_B', { text: '', activity: { steps: [THOUGHT] } });
  const ask = arrange.post(rt, t.id, { kind: 'block', sessionId: se.id, handle: 'researcher', turnId: 'turn_B', valid: true, block: CHOICE });
  agent('turn_B', { text: 'Pick a partition above, and I’ll write the layout for it.' });
  arrange.setSession(rt, se.id, { state: 'needs', needs: { kind: 'block', itemId: ask.id, text: CHOICE.title } });

  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  // The part with steps alone draws nothing, and the choice after it names its speaker instead.
  await expect(page.locator(`[data-key="${stepsOnly.id}"]`), 'the steps-only part is hidden').toBeHidden();
  await expect(page.locator(`[data-key="${ask.id}"] .who pb-ring[data-session="${se.id}"]`), 'the choice has the speaker line').toBeVisible();
  // As the UAT runner clicks: the last ring of the agent's that shows beside a message.
  const ring = page.locator(`#main .who pb-ring[data-session="${se.id}"]`).filter({ visible: true }).last();
  await expect(ring, 'the ring on screen follows the agent').toHaveAttribute('state', 'needs');
  await page.evaluate(() => /** @type {HTMLElement | null} */ (document.activeElement)?.blur());
  await ring.click();
  const landed = () => page.evaluate(() => document.activeElement?.closest('[data-key]')?.getAttribute('data-key') ?? null);
  await expect.poll(landed, { message: 'focus lands in the choice, not the write-up' }).toBe(ask.id);
  await expect(page.locator(`[data-key="${ask.id}"]`), 'and outlines it').toHaveClass(/arrived/);
});

test('#1654 the same turn ending while the page is open: the ring follows the agent to its choice', async ({ page }) => {
  const { rt } = app;
  const projectId = Object.values(rt.store.state.projects)[0].id;
  const t = rt.createThread({ projectId, title: 'Click logs, live', personaIds: [arrange.persona(rt, 'researcher').id] });
  const [se] = arrange.sessionsIn(rt, t.id);
  arrange.post(rt, t.id, { kind: 'user', text: '@researcher which partition do you recommend? Ask me with a choice.' });
  // The turn runs, with the page open: its first part holds a step, then its choice, then its words stream in.
  arrange.setSession(rt, se.id, { state: 'tool', lastTurnId: 'turn_live' });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const part = { kind: 'agent', sessionId: se.id, handle: 'researcher', turnId: 'turn_live' };
  const stepsOnly = arrange.post(rt, t.id, { ...part, status: 'done', text: '', activity: { steps: [THOUGHT] } });
  const ask = arrange.post(rt, t.id, { kind: 'block', sessionId: se.id, handle: 'researcher', turnId: 'turn_live', valid: true, block: CHOICE });
  const last = arrange.post(rt, t.id, { ...part, status: 'streaming', text: 'Pick a partition above.' });
  await synced(page, app);
  // The turn ends in the server's order (turn-finish.mjs): its parts settle first, then the session says it needs you.
  arrange.setItem(rt, t.id, last.id, { status: 'done' });
  arrange.setSession(rt, se.id, { state: 'needs', needs: { kind: 'block', itemId: ask.id, text: CHOICE.title } });
  await synced(page, app);
  await expect(page.locator(`[data-key="${stepsOnly.id}"]`), 'the steps-only part is hidden once the turn ends').toBeHidden();
  const ring = page.locator(`[data-key="${ask.id}"] .who pb-ring[data-session="${se.id}"]`);
  await expect(ring, 'the choice now names the speaker, with the ring that follows').toHaveAttribute('state', 'needs');
  await page.evaluate(() => /** @type {HTMLElement | null} */ (document.activeElement)?.blur());
  await ring.click();
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.closest('[data-key]')?.getAttribute('data-key') ?? null), { message: 'focus lands in the choice' })
    .toBe(ask.id);
});

test('#1654 a background job that ends after the turn hides its part, and the ring moves to the choice', async ({ page }) => {
  const { rt } = app;
  const projectId = Object.values(rt.store.state.projects)[0].id;
  const t = rt.createThread({ projectId, title: 'Click logs, job', personaIds: [arrange.persona(rt, 'researcher').id] });
  const [se] = arrange.sessionsIn(rt, t.id);
  const part = { kind: 'agent', sessionId: se.id, handle: 'researcher', turnId: 'turn_job', status: 'done' };
  arrange.post(rt, t.id, { kind: 'user', text: '@researcher index the logs, then ask me how to partition them.' });
  // The turn ended with its first part's job still running, so that part shows, with the turn's speaker line.
  const JOB = { id: 'job_1', label: 'npm run index', state: 'running', job: 'j1' };
  const stepsOnly = arrange.post(rt, t.id, { ...part, text: '', activity: { steps: [THOUGHT, JOB] } });
  const ask = arrange.post(rt, t.id, { kind: 'block', sessionId: se.id, handle: 'researcher', turnId: 'turn_job', valid: true, block: CHOICE });
  arrange.post(rt, t.id, { ...part, text: 'Pick a partition above.' });
  arrange.setSession(rt, se.id, { state: 'needs', needs: { kind: 'block', itemId: ask.id, text: CHOICE.title } });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await expect(page.locator(`[data-key="${stepsOnly.id}"]`), 'shown while its job runs').toBeVisible();
  // The job ends: only an item patch, with no session event after it.
  arrange.setItem(rt, t.id, stepsOnly.id, { activity: { steps: [THOUGHT, { ...JOB, state: 'done' }] } });
  await synced(page, app);
  await expect(page.locator(`[data-key="${stepsOnly.id}"]`), 'hidden once its job is done').toBeHidden();
  await expect(page.locator(`[data-key="${ask.id}"] .who pb-ring[data-session="${se.id}"]`), 'the choice takes the speaker line').toHaveAttribute(
    'state',
    'needs',
  );
});

test('#1654 an app shown after a steps-only part keeps its frame when the turn ends, and takes the speaker line', async ({ page }) => {
  const { rt } = app;
  const projectId = Object.values(rt.store.state.projects)[0].id;
  const t = rt.createThread({ projectId, title: 'Click logs, app', personaIds: [arrange.persona(rt, 'researcher').id] });
  const [se] = arrange.sessionsIn(rt, t.id);
  arrange.post(rt, t.id, { kind: 'user', text: '@researcher build me a partition explorer.' });
  arrange.setSession(rt, se.id, { state: 'tool', lastTurnId: 'turn_app' });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const part = { kind: 'agent', sessionId: se.id, handle: 'researcher', turnId: 'turn_app' };
  const stepsOnly = arrange.post(rt, t.id, { ...part, status: 'done', text: '', activity: { steps: [THOUGHT] } });
  const { appId } = rt.toolsFor(se.id).show_app({ title: 'Partitions', code: '<p style="padding:12px">Pick a partition.</p>' });
  const shown = rt.store.items(t.id).find((it) => it.kind === 'block' && it.block?.type === 'app' && it.block.id === appId);
  arrange.setItem(rt, t.id, shown.id, { turnId: 'turn_app' });
  const last = arrange.post(rt, t.id, { ...part, status: 'streaming', text: 'Try the explorer above.' });
  await synced(page, app);
  const frame = page.locator(`[data-key="${shown.id}"] .appframe iframe`).first();
  await expect(frame).toBeAttached();
  // Mark the running frame: a reload draws a new one, and what the person did in it is gone.
  await frame.evaluate((f) => {
    f.dataset.kept = 'yes';
  });
  // The turn ends in the server's order: its last part settles, then the session stops working.
  arrange.setItem(rt, t.id, last.id, { status: 'done' });
  arrange.setSession(rt, se.id, { state: 'idle' });
  await synced(page, app);
  await expect(page.locator(`[data-key="${stepsOnly.id}"]`), 'the steps-only part is hidden').toBeHidden();
  await expect(page.locator(`[data-key="${shown.id}"] .who pb-ring[data-session="${se.id}"]`), 'the app takes the speaker line').toBeVisible();
  await expect(page.locator(`[data-key="${shown.id}"] .appframe iframe[data-kept="yes"]`), 'the same frame, not reloaded').toHaveCount(1);
});
