// #518: an answer settles after the agent has already revised the block. Every revision of a review draws from one
// draft on the page, and submit() deleted that draft once its answer settled, so what the person had started on the
// newer revision in the meantime, a comment or a verdict, was lost. Now a settled answer leaves the draft to the newer
// revision, and what it sent leaves the draft where that revision is drawn, once the answer landed, so what’s on
// screen is what’s sent. A form’s and a choice’s drafts are kept the same way.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
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

/** A gate a test opens: wait() resolves once open() is called. */
function gate() {
  /** @type {() => void} */
  let open = () => {};
  const opened = new Promise((r) => {
    open = () => r(undefined);
  });
  return { open, wait: () => opened };
}

/**
 * Holds a block’s answer on its way: its reply to the page until release(), and, with untilSent, the request itself
 * until send(). @param {import('@playwright/test').Page} page @param {string} threadId @param {string} itemId
 */
async function holdAct(page, threadId, itemId, { untilSent = false } = {}) {
  const sent = gate();
  const released = gate();
  if (!untilSent) sent.open();
  await page.route(`**/api/threads/${threadId}/items/${itemId}/act`, async (route) => {
    await sent.wait();
    const response = await route.fetch();
    await released.wait();
    await route.fulfill({ response });
  });
  return { send: sent.open, release: released.open };
}

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
  release();
  await page.waitForResponse(`**/api/threads/${r.t.id}/items/${r.item.id}/act`);
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
  release();
  await page.waitForResponse(`**/api/threads/${r.t.id}/items/${r.item.id}/act`);
  await page.reload();
  await synced(page, app);
  await expect(r.block.getByText('Rank by date.'), 'kept over a reload').toBeVisible();
});

test('#518 when the page never drew the answered block, what it sent leaves the draft as revision 2 is drawn', async ({ page }) => {
  const r = await room(page, 'Away');
  const elsewhere = app.rt.createThread({ projectId: r.projectId, title: 'Elsewhere', personaIds: [arrange.persona(app.rt, 'researcher').id] });
  // The answer is held before it reaches Postbox and sent once the page is elsewhere, so it lands while the block isn’t
  // drawn; its reply to the page is held until after the agent revises.
  const { send, release } = await answeredThenRevised(page, r, { untilSent: true });
  // A second comment, after the answer went, open for editing with more typed: the sent one comes before it.
  await comment(page, r.block, 5, 'Then by author.');
  await r.block.getByRole('button', { name: 'Edit your comment on line 5' }).click();
  await page.keyboard.press('End');
  await page.keyboard.insertText(' And by date.');
  await page.goto(`${app.origin}/#/t/${elsewhere.id}`);
  await synced(page, app);
  send();
  await expect.poll(() => r.now().answer?.read).toBe(true);
  revise(r);
  await page.goto(`${app.origin}/#/t/${r.t.id}`);
  await synced(page, app);
  await expect(r.block.locator('.rv-receipt'), 'revision 2 is drawn').toBeVisible();
  // Sent, the comment is the person’s thread on the block; drawn, it isn’t also a draft, before or after the settle.
  const drafted = r.block.locator('.rv-thread', { has: page.locator('.status-tag.draft') });
  await expect(drafted.filter({ hasText: 'Index the titles too.' })).toHaveCount(0);
  await expect(drafted.filter({ hasText: 'Then by author. And by date.' }), 'the edit open on the later comment is kept').toHaveCount(1);
  release();
  await page.waitForResponse(`**/api/threads/${r.t.id}/items/${r.item.id}/act`);
  await expect(drafted.filter({ hasText: 'Index the titles too.' })).toHaveCount(0);
  await expect(approve(r.block), 'the verdict on screen').toHaveAttribute('aria-checked', 'true');
  await submit(r.block).click();
  await expect.poll(() => r.now().answer?.revision).toBe(2);
  expect(r.now().answer.values).toEqual({ verdict: 'approve', comments: [expect.objectContaining({ line: 5, text: 'Then by author. And by date.' })] });
});

test('#518 what the person types into a form’s newer revision survives the older answer settling and the next revision', async ({ page }) => {
  const { rt, store } = app;
  const t = rt.createThread({ projectId: Object.values(store.state.projects)[0].id, title: 'Form', personaIds: [arrange.persona(rt, 'researcher').id] });
  const tools = rt.toolsFor(arrange.agentIn(rt, t.id).id);
  const form = { id: 'trip', type: 'form', version: 1, fallback: 'Plan the trip', fields: [{ id: 'a', label: 'Where to?', kind: 'text' }] };
  tools.show_block({ block: form });
  const item = store.items(t.id).find((i) => i.kind === 'block' && i.block.id === 'trip');
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const block = page.locator(`#main [data-key="${item.id}"]`);
  const { release } = await holdAct(page, t.id, item.id);
  await block.getByRole('textbox', { name: 'Where to?' }).fill('Lisbon');
  await block.getByRole('button', { name: 'Send form' }).click();
  await expect.poll(() => store.item(t.id, item.id).answer?.read).toBe(true);
  const two = { ...form, fields: [...form.fields, { id: 'b', label: 'When?', kind: 'text' }] };
  expect(tools.update_block({ block: two }).ok).toBe(true);
  await block.getByRole('textbox', { name: 'When?' }).fill('May');
  release();
  await page.waitForResponse(`**/api/threads/${t.id}/items/${item.id}/act`);
  // The agent revises once more, which draws the form again from its draft.
  expect(tools.update_block({ block: { ...two, title: 'Plan the trip' } }).ok).toBe(true);
  await expect(block.getByRole('textbox', { name: 'When?' })).toHaveValue('May');
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

test('#518 a choice picked on a newer revision survives the older answer settling and the next revision', async ({ page }) => {
  const { rt, store } = app;
  const t = rt.createThread({ projectId: Object.values(store.state.projects)[0].id, title: 'Choice', personaIds: [arrange.persona(rt, 'researcher').id] });
  const tools = rt.toolsFor(arrange.agentIn(rt, t.id).id);
  const choice = {
    id: 'when',
    type: 'choice',
    version: 1,
    fallback: 'When?',
    multiple: true,
    options: [
      { id: 'mon', label: 'Monday' },
      { id: 'tue', label: 'Tuesday' },
    ],
  };
  tools.show_block({ block: choice });
  const item = store.items(t.id).find((i) => i.kind === 'block' && i.block.id === 'when');
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const block = page.locator(`#main [data-key="${item.id}"]`);
  const { release } = await holdAct(page, t.id, item.id);
  await block.getByRole('button', { name: 'Monday' }).click();
  await block.getByRole('button', { name: /^Send/ }).click();
  await expect.poll(() => store.item(t.id, item.id).answer?.read).toBe(true);
  const two = { ...choice, options: [...choice.options, { id: 'wed', label: 'Wednesday' }] };
  expect(tools.update_block({ block: two }).ok).toBe(true);
  await block.getByRole('button', { name: 'Wednesday' }).click();
  release();
  await page.waitForResponse(`**/api/threads/${t.id}/items/${item.id}/act`);
  expect(tools.update_block({ block: { ...two, title: 'When?' } }).ok).toBe(true);
  await expect(block.getByRole('button', { name: 'Wednesday' })).toHaveAttribute('aria-pressed', 'true');
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
