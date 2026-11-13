// #593: an update that changes nothing the person would answer leaves a waiting review as it was: no “Changes since
// you looked”, and Submit goes through. A real change shows its notice and that diff as it arrives, with no click. From critic’s repro probe (cases 1, 2 and A).

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

const V1 = ['# Draft issue', '', 'Steps to reproduce:', '1. Open a review.', '2. Answer it.'].join('\n');
const V2 = ['# Draft issue', '', 'Seen on 22 October.', 'Steps to reproduce:', '1. Open a review.', '2. Answer it.'].join('\n');
const thread = (status) => ({ id: 't1', line: 3, status, comments: [{ author: '@drafter', text: 'Is this the right heading?' }] });
const review = (content, status = 'open') => ({
  id: 'issue',
  type: 'review',
  version: 1,
  title: 'issue.md',
  fallback: 'The draft issue',
  format: 'markdown',
  content,
  threads: [thread(status)],
});

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let drafter;
test.beforeAll(async () => {
  app = await startPostbox('review-unseen');
  arrange.withAdapter(app.rt, {
    name: 'mock',
    async deliver(_session, message, ctx) {
      if (message.text === 'review') ctx.tools.show_block({ block: review(V1) });
    },
  });
  drafter = app.rt.createPersona({ handle: 'drafter' });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

/** Shows the review, applies the update, answers Approve, and returns what the block showed of the update before Submit. */
async function answerAfter(page, title, update) {
  const { rt } = app;
  const t = rt.createThread({ projectId: Object.values(rt.store.state.projects)[0].id, title, personaIds: [drafter.id] });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  rt.sendMessage(t.id, { text: 'review' });
  const itemOf = () => rt.store.items(t.id).find((i) => i.kind === 'block' && i.block.id === 'issue');
  await expect.poll(() => !!itemOf(), { message: 'the block' }).toBe(true);
  const block = page.locator(`[data-block-item="${itemOf().id}"]`);
  await expect(block).toBeVisible();
  await expect.poll(() => arrange.liveTurns(rt), { message: 'the agent to finish' }).toBe(0);
  // The person reads it line by line, as in the repro, so a diff would show there.
  await block.getByRole('radiogroup', { name: 'View' }).getByRole('radio', { name: 'Lines', exact: true }).click();
  await expect(block.locator('.g-mark[data-line="5"]')).toBeAttached();
  const r = rt.toolsFor(arrange.agentIn(rt, t.id).id).update_block({ block: update });
  expect(r.ok, r.message).toBe(true);
  await synced(page, app);
  // What the block shows of the change as it arrives, before any click (#123).
  const noticed = await block.locator('.stale-note').count();
  const since = await block.getByRole('radio', { name: 'Changes since you looked', exact: true }).count();
  const added = await block.locator('.rv-line.add').count();
  await block.getByRole('radiogroup', { name: 'Verdict' }).getByRole('radio', { name: 'Approve', exact: true }).click();
  await block.getByRole('button', { name: 'Submit review', exact: true }).click();
  await expect.poll(() => !!itemOf().answered, { message: 'answered' }).toBe(true);
  return { item: itemOf(), since, added, noticed, block };
}

test('#593 an identical update: Submit goes through at revision 1, with no “Changes since you looked”', async ({ page }) => {
  const o = await answerAfter(page, 'Identical', review(V1));
  expect.soft(o.item.revision ?? 1).toBe(1);
  expect.soft(o.item.answered).toBe(true);
  expect.soft(o.item.answer?.values.verdict).toBe('approve');
  expect.soft(o.since).toBe(0);
  expect.soft(o.noticed).toBe(0);
});

test('#593 resolving a thread: the resolve shows, and Submit goes through with no marker', async ({ page }) => {
  const o = await answerAfter(page, 'Resolve', review(V1, 'resolved'));
  expect.soft(o.item.block.threads[0].status).toBe('resolved');
  expect.soft(o.item.revision ?? 1).toBe(1);
  expect.soft(o.item.answered).toBe(true);
  expect.soft(o.since).toBe(0);
  expect.soft(o.noticed).toBe(0);
});

test('#593 control: a real change shows its notice and “Changes since you looked” as it arrives, with no comment, and one Submit answers it', async ({
  page,
}) => {
  const o = await answerAfter(page, 'Real change', review(V2));
  expect.soft(o.noticed, 'the notice before any click').toBe(1);
  expect.soft(o.since, 'the diff before any click').toBe(1);
  expect.soft(o.added, 'the added line is marked').toBeGreaterThan(0);
  expect.soft(o.item.answered).toBe(true);
  expect.soft(o.item.answer?.revision, 'the answer is for revision 2').toBe(2);
});
