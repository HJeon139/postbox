// #518: an answer settles after the agent has already revised the block. Every revision of a review draws from one
// draft on the page, and submit() deleted that draft once its answer settled, so what the person had started on the
// newer revision in the meantime, a comment or a verdict, was lost. Now a settled answer leaves the draft to the newer
// revision, and what it sent leaves the draft where that revision is drawn, once the answer landed, so what’s on
// screen is what’s sent. A form’s and a choice’s drafts are kept the same way (block-answer-race.spec.mjs).

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { away, back, gate, holdAct } from './answer-hold.mjs';
import { allowPageError, failOnPageErrors, startPostbox, synced } from './postbox.mjs';

const DRAFT = {
  id: 'plan',
  type: 'review',
  version: 1,
  title: 'Plan',
  fallback: 'Review the plan',
  format: 'markdown',
  content: '# Plan\n\nIndex first.\n\nThen search.',
};

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('review-answer-race');
  // The agent’s turn takes the answer and ends at once, so the answer is read, and an update can reopen the block.
  arrange.withAdapter(app.rt, { name: 'mock', async deliver() {} });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

/** A room with the plan for review, open on the page, and the agent’s tools. @param {any} page @param {string} title */
async function room(page, title) {
  const { rt, store } = app;
  const projectId = Object.values(store.state.projects)[0].id;
  const t = rt.createThread({ projectId, title, personaIds: [arrange.persona(rt, 'researcher').id] });
  const tools = rt.toolsFor(arrange.agentIn(rt, t.id).id);
  tools.show_block({ block: DRAFT });
  const item = store.items(t.id).find((i) => i.kind === 'block' && i.block.id === 'plan');
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  return { t, tools, item, block: page.locator(`#main [data-key="${item.id}"]`), now: () => store.item(t.id, item.id), projectId };
}

/** In Lines, a comment on a line, added as a draft. */
async function comment(page, block, line, text) {
  await block.locator(`.g-mark[data-line="${line}"]`).click();
  await page.keyboard.insertText(text);
  await block.getByRole('button', { name: 'Add draft comment' }).click();
  await expect(block.getByText(text)).toBeVisible();
}

const approve = (block) => block.getByRole('radio', { name: 'Approve', exact: true });
const submit = (block) => block.getByRole('button', { name: 'Submit review', exact: true });
const revise = (r) => {
  const said = r.tools.update_block({ block: { ...DRAFT, content: `${DRAFT.content}\n\nThen rank.` } });
  expect(said.ok, said.message).toBe(true);
};

/** Revision 1 approved with a comment, its reply held; the agent reads it and revises; revision 2 is drawn. */
async function answeredThenRevised(page, r, hold = {}) {
  const held = await holdAct(page, r.t.id, r.item.id, hold);
  await r.block.getByRole('radio', { name: 'Lines' }).click();
  await comment(page, r.block, 3, 'Index the titles too.');
  await approve(r.block).click();
  await submit(r.block).click();
  return held;
}

test('#518 revision 2’s draft and the verdict on screen are what’s sent, with no redraw after the older answer settles', async ({ page }) => {
  const r = await room(page, 'Sent as shown');
  const { release } = await answeredThenRevised(page, r);
  await expect.poll(() => r.now().answer?.read, { message: 'the agent read the approval' }).toBe(true);
  revise(r);
  await expect(r.block.locator('.rv-receipt'), 'revision 2 is drawn').toBeVisible();
  await comment(page, r.block, 7, 'Rank by date.');
  const settled = page.waitForResponse(`**/api/threads/${r.t.id}/items/${r.item.id}/act`);
  release();
  await settled;
  // Nothing draws the block again: the person sees Approve picked, and that is what goes.
  await expect(approve(r.block)).toHaveAttribute('aria-checked', 'true');
  await submit(r.block).click();
  await expect.poll(() => r.now().answer?.revision).toBe(2);
  expect(r.now().answer.values).toEqual({ verdict: 'approve', comments: [expect.objectContaining({ line: 7, text: 'Rank by date.' })] });
});

test('#518 revision 2’s draft is kept over a reload after the older answer settles', async ({ page }) => {
  const r = await room(page, 'Kept');
  const { release } = await answeredThenRevised(page, r);
  await expect.poll(() => r.now().answer?.read).toBe(true);
  revise(r);
  await expect(r.block.locator('.rv-receipt')).toBeVisible();
  await comment(page, r.block, 7, 'Rank by date.');
  const settled = page.waitForResponse(`**/api/threads/${r.t.id}/items/${r.item.id}/act`);
  release();
  await settled;
  await page.reload();
  await synced(page, app);
  await expect(r.block.getByText('Rank by date.'), 'kept over a reload').toBeVisible();
});

test('#518 when the page never drew the answered block, what it sent leaves the draft as revision 2 is drawn', async ({ page }) => {
  const r = await room(page, 'Away');
  page.on('console', (m) => m.text().startsWith('DRAW') && console.log(m.text()));
  // The answer is held before it reaches Postbox and sent once the page is elsewhere, so it lands while the block isn’t
  // drawn; its reply to the page is held until after the agent revises.
  const { send, release } = await answeredThenRevised(page, r, { untilSent: true });
  // A second comment, after the answer went, open for editing with more typed: the sent one comes before it.
  await comment(page, r.block, 5, 'Then by author.');
  await r.block.getByRole('button', { name: 'Edit your comment on line 5' }).click();
  await page.keyboard.press('End');
  await page.keyboard.insertText(' And by date.');
  await away(page, app, r.projectId);
  send();
  await expect.poll(() => r.now().answer?.read).toBe(true);
  revise(r);
  await back(page, app, r.t.id);
  await expect(r.block.locator('.rv-receipt'), 'revision 2 is drawn').toBeVisible();
  // Sent, the comment is the person’s thread on the block; drawn, it isn’t also a draft, before or after the settle.
  const drafted = r.block.locator('.rv-thread', { has: page.locator('.status-tag.draft') });
  await expect(drafted.filter({ hasText: 'Index the titles too.' })).toHaveCount(0);
  await expect(drafted.filter({ hasText: 'Then by author. And by date.' }), 'the edit open on the later comment is kept').toHaveCount(1);
  const settled = page.waitForResponse(`**/api/threads/${r.t.id}/items/${r.item.id}/act`);
  release();
  await settled;
  await expect(drafted.filter({ hasText: 'Index the titles too.' })).toHaveCount(0);
  await expect(approve(r.block), 'the verdict on screen').toHaveAttribute('aria-checked', 'true');
  await submit(r.block).click();
  await expect.poll(() => r.now().answer?.revision).toBe(2);
  expect(r.now().answer.values).toEqual({ verdict: 'approve', comments: [expect.objectContaining({ line: 5, text: 'Then by author. And by date.' })] });
});

test('#518 a dismissal elsewhere of revision 2 takes what revision 1’s answer sent out of the draft too', async ({ page }) => {
  const r = await room(page, 'Dismissed elsewhere');
  const { send, release } = await answeredThenRevised(page, r, { untilSent: true });
  await away(page, app, r.projectId);
  send();
  await expect.poll(() => r.now().answer?.read).toBe(true);
  // Revision 2 is never drawn here: another page dismisses it, and the agent revises again.
  revise(r);
  app.rt.act(r.t.id, r.item.id, 'dismiss', {}, 2);
  await expect.poll(() => r.now().answer?.read, { message: 'the agent read the dismissal' }).toBe(true);
  revise(r);
  await back(page, app, r.t.id);
  await expect(r.block.locator('.rv-receipt'), 'revision 3 is drawn').toBeVisible();
  const drafted = r.block.locator('.rv-thread', { has: page.locator('.status-tag.draft') });
  await expect(drafted.filter({ hasText: 'Index the titles too.' }), 'what revision 1 sent isn’t a draft').toHaveCount(0);
  const settled = page.waitForResponse(`**/api/threads/${r.t.id}/items/${r.item.id}/act`);
  release();
  await settled;
  await comment(page, r.block, 7, 'Rank by date.');
  await submit(r.block).click();
  await expect.poll(() => r.now().answer?.revision).toBe(3);
  expect(r.now().answer.values.comments).toEqual([expect.objectContaining({ line: 7, text: 'Rank by date.' })]);
});

test('#518 an answer that failed leaves its comments as drafts after its revision is dismissed elsewhere', async ({ page }) => {
  const r = await room(page, 'Failed, then dismissed');
  allowPageError(page, /status of 422/);
  await page.route(`**/api/threads/${r.t.id}/items/${r.item.id}/act`, (route) =>
    route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: 'That answer didn’t go through. Try again.' }) }),
  );
  await r.block.getByRole('radio', { name: 'Lines' }).click();
  await comment(page, r.block, 3, 'Index the titles too.');
  const refused = page.waitForResponse((res) => res.url().endsWith(`/items/${r.item.id}/act`) && res.status() === 422);
  await submit(r.block).click();
  await refused;
  // Another page dismisses revision 1, and the agent revises: the comment never went, so it’s still the person’s.
  app.rt.act(r.t.id, r.item.id, 'dismiss', {}, 1);
  await expect.poll(() => r.now().answer?.read).toBe(true);
  revise(r);
  await expect(r.block.locator('.rv-receipt'), 'revision 2 is drawn').toBeVisible();
  const drafted = r.block.locator('.rv-thread', { has: page.locator('.status-tag.draft') });
  await expect(drafted.filter({ hasText: 'Index the titles too.' }), 'the comment that never went is a draft').toHaveCount(1);
});

test('#518 a second answer refused as already answered leaves what the first one sent out of the draft', async ({ page }) => {
  const r = await room(page, 'Twice');
  allowPageError(page, /status of 409/);
  // Submit clicked twice: the first answer lands, its reply held; the second is refused, and its refusal comes back first.
  const first = gate();
  const second = gate();
  const reply = gate();
  let sent = 0;
  await page.route(`**/api/threads/${r.t.id}/items/${r.item.id}/act`, async (route) => {
    const mine = ++sent;
    await (mine === 1 ? first : second).wait();
    const response = await route.fetch();
    if (mine === 1) await reply.wait();
    await route.fulfill({ response });
  });
  await r.block.getByRole('radio', { name: 'Lines' }).click();
  await comment(page, r.block, 3, 'Index the titles too.');
  await submit(r.block).click();
  await submit(r.block).click();
  await expect.poll(() => sent, { message: 'both answers are on their way' }).toBe(2);
  await away(page, app, r.projectId);
  first.open();
  await expect.poll(() => r.now().answer?.read).toBe(true);
  const refused = page.waitForResponse((res) => res.url().endsWith(`/items/${r.item.id}/act`) && res.status() === 409);
  second.open();
  await refused;
  revise(r);
  await back(page, app, r.t.id);
  await expect(r.block.locator('.rv-receipt'), 'revision 2 is drawn').toBeVisible();
  const drafted = r.block.locator('.rv-thread', { has: page.locator('.status-tag.draft') });
  await expect(drafted.filter({ hasText: 'Index the titles too.' }), 'what the first answer sent isn’t a draft').toHaveCount(0);
  const settled = page.waitForResponse((res) => res.url().endsWith(`/items/${r.item.id}/act`) && res.ok());
  reply.open();
  await settled;
  await expect(drafted.filter({ hasText: 'Index the titles too.' })).toHaveCount(0);
});

test('#518 an answer that fails leaves its comments as drafts, through a redraw while it was on its way and the next revision', async ({ page }) => {
  const r = await room(page, 'Failed');
  allowPageError(page, /status of 422/);
  const back = gate();
  // The answer never reaches Postbox: the page waits, then hears it was refused.
  await page.route(`**/api/threads/${r.t.id}/items/${r.item.id}/act`, async (route) => {
    await back.wait();
    await route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: 'That answer didn’t go through. Try again.' }) });
  });
  await r.block.getByRole('radio', { name: 'Lines' }).click();
  await comment(page, r.block, 3, 'Index the titles too.');
  await submit(r.block).click();
  // The block is drawn again while the answer is on its way.
  await r.block.getByRole('radio', { name: 'Preview' }).click();
  await r.block.getByRole('radio', { name: 'Lines' }).click();
  const refused = page.waitForResponse((res) => res.url().endsWith(`/items/${r.item.id}/act`) && res.status() === 422);
  back.open();
  await refused;
  const drafted = r.block.locator('.rv-thread', { has: page.locator('.status-tag.draft') });
  await expect(drafted.filter({ hasText: 'Index the titles too.' }), 'still a draft after the failure').toHaveCount(1);
  // The agent revises before the person answers again: the unsent comment goes with the draft to revision 2.
  revise(r);
  await expect(r.block.getByText('Then rank.')).toBeVisible();
  await expect(drafted.filter({ hasText: 'Index the titles too.' }), 'and on revision 2').toHaveCount(1);
});

test('#518 an answer refused as stale, because the agent’s revision got there first, leaves its comments as drafts on that revision', async ({ page }) => {
  const r = await room(page, 'Stale');
  allowPageError(page, /status of 409/);
  // The answer is held before it reaches Postbox; the agent revises meanwhile, so the answer lands on revision 1 after
  // revision 2 exists, and Postbox refuses it. Its reply to the page is held until revision 2 is drawn.
  const { send, release } = await answeredThenRevised(page, r, { untilSent: true });
  revise(r);
  await expect(r.block.getByText('Then rank.'), 'revision 2 is drawn').toBeVisible();
  const refused = page.waitForResponse((res) => res.url().endsWith(`/items/${r.item.id}/act`) && res.status() === 409);
  send();
  release();
  await refused;
  const drafted = r.block.locator('.rv-thread', { has: page.locator('.status-tag.draft') });
  await expect(drafted.filter({ hasText: 'Index the titles too.' }), 'still a draft after the refusal').toHaveCount(1);
  await r.block.getByRole('radio', { name: 'Preview' }).click();
  await r.block.getByRole('radio', { name: 'Lines' }).click();
  await expect(drafted.filter({ hasText: 'Index the titles too.' }), 'and after the next draw').toHaveCount(1);
  expect(r.now().answer ?? null, 'nothing reached the agent').toBe(null);
});

test('#518 after an answer landed, a later revision’s own answer on its way keeps its comments through a redraw', async ({ page }) => {
  const r = await room(page, 'Second answer');
  allowPageError(page, /status of 422/);
  // Revision 1’s answer lands, and the agent revises.
  await r.block.getByRole('radio', { name: 'Lines' }).click();
  await comment(page, r.block, 3, 'Index the titles too.');
  await approve(r.block).click();
  await submit(r.block).click();
  await expect.poll(() => r.now().answer?.read).toBe(true);
  revise(r);
  await expect(r.block.locator('.rv-receipt'), 'revision 2 is drawn').toBeVisible();
  // Revision 2’s answer is refused, after a redraw while it was on its way.
  const back = gate();
  await page.route(`**/api/threads/${r.t.id}/items/${r.item.id}/act`, async (route) => {
    await back.wait();
    await route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: 'That answer didn’t go through. Try again.' }) });
  });
  await r.block.getByRole('radio', { name: 'Lines' }).click();
  await comment(page, r.block, 7, 'Rank by date.');
  await submit(r.block).click();
  await r.block.getByRole('radio', { name: 'Preview' }).click();
  await r.block.getByRole('radio', { name: 'Lines' }).click();
  const refused = page.waitForResponse((res) => res.url().endsWith(`/items/${r.item.id}/act`) && res.status() === 422);
  back.open();
  await refused;
  const drafted = r.block.locator('.rv-thread', { has: page.locator('.status-tag.draft') });
  await expect(drafted.filter({ hasText: 'Rank by date.' }), 'revision 2’s comment is still a draft').toHaveCount(1);
});
