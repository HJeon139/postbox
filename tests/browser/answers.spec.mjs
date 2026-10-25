// Answering a block that changed while you were answering it (#123):
// - a review: the agent replaces the draft while you comment. Your Submit is refused, the block says “This draft
//   changed while you were answering”, shows the diff from the text you saw, keeps your comment on its line, and moves
//   focus to the notice. A further revision before you submit again is refused again. Then Submit sends the review,
//   for the revision on screen;
// - a choice: the same refusal, with a plain notice, and your pick kept.
// SHOTS=<folder> saves a screenshot of the review after the refusal. Each story has a conversation of its own, with a
// scripted agent. Moved from tools/check-answers.mjs (#303).

import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { allowPageError, failOnPageErrors, startPostbox, synced, watchWrites } from './postbox.mjs';

const V1 = ['# Draft issue', '', 'Steps to reproduce:', '1. Open a review.', '2. Answer it.'].join('\n');
// Revision 2 adds a line near the top, so the line you commented on (“Steps to reproduce:”) moves from 3 to 4.
const V2 = ['# Draft issue', '', 'Seen on 22 October.', 'Steps to reproduce:', '1. Open a review.', '2. Answer it.'].join('\n');
// Revision 3 adds a last line, so the comment stays on line 4.
const V3 = `${V2}\n3. Watch the answer vanish.`;
const review = (content) => ({ id: 'issue', type: 'review', version: 1, title: 'issue.md', fallback: 'The draft issue', format: 'markdown', content });
const choice = (prompt) => ({
  id: 'pick',
  type: 'choice',
  version: 1,
  title: 'Which first?',
  fallback: 'Corpus or claims?',
  prompt,
  options: [
    { id: 'corpus', label: 'The corpus' },
    { id: 'claims', label: 'The claims' },
  ],
});

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
/** Every message Postbox sends the agent, with the conversation it was in. */
const calls = [];
let drafter;
test.beforeAll(async () => {
  app = await startPostbox('answers');
  // The agent: shows a block on cue, and records every message Postbox sends it.
  app.rt.adapters.register({
    name: 'mock',
    async deliver(session, message, ctx) {
      calls.push({ ...message, threadId: session.threadId });
      if (message.text === 'review') ctx.tools.show_block({ block: review(V1) });
      if (message.text === 'choice') ctx.tools.show_block({ block: choice('Load which first?') });
    },
  });
  drafter = app.rt.createPersona({ handle: 'drafter' });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);
test.use({ colorScheme: 'light' });

/** A conversation of its own, open in the page, where the agent shows what it’s asked for. */
async function conversation(page, title, ask, id) {
  const { rt } = app;
  const thread = rt.createThread({ projectId: Object.values(rt.s.projects)[0].id, title, personaIds: [drafter.id] });
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  rt.sendMessage(thread.id, { text: ask });
  const itemOf = () => rt.store.items(thread.id).find((i) => i.kind === 'block' && i.block.id === id);
  await expect.poll(() => !!itemOf(), { message: 'the block' }).toBe(true);
  const block = page.locator(`[data-block-item="${itemOf().id}"]`);
  await expect(block).toBeVisible();
  const events = () => calls.filter((m) => m.kind === 'event' && m.threadId === thread.id);
  return { thread, itemOf, block, events, tools: rt.toolsFor(rt.sessionsIn(thread.id)[0].id) };
}
const button = (block, label) => block.getByRole('button', { name: label, exact: true });
const focusOnNotice = (page) =>
  expect.poll(() => page.evaluate(() => !!document.activeElement?.classList.contains('stale-note')), { message: 'focus on the notice' }).toBe(true);

test('#123 a review that changed while you commented: refused with the diff and your comment kept, refused again on another change, then sent', async ({
  page,
}) => {
  // Each refusal logs the refused request.
  allowPageError(page, /status of 409/, { times: 2 });
  const { itemOf, block, events, tools } = await conversation(page, 'Review changes', 'review', 'issue');
  await test.step('you comment on line 3, “Steps to reproduce:”, while the agent replaces the draft with revision 2', async () => {
    // The draft opens in Preview (#179); lines take their comments in Lines.
    await block.locator('[aria-label="View"]').getByRole('radio', { name: 'Lines', exact: true }).click();
    await block.locator('.g-mark[data-line="3"]').click();
    await block.locator('textarea').fill('Say which build.');
    await button(block, 'Add draft comment').click();
    await expect(block.locator('.status-tag.draft')).toBeVisible();
    tools.update_block({ block: review(V2) });
    await expect(block.locator('.g-mark[data-line="6"]'), 'revision 2 on screen').toBeAttached();
  });
  await test.step('Submit is refused: the notice, the diff, your comment on its line, now line 4, and focus on the notice', async () => {
    await button(block, 'Submit review').focus();
    await page.keyboard.press('Enter');
    await expect(block.locator('.stale-note')).toHaveText(/^This draft changed while you were answering\./);
    expect(itemOf().answered, 'refused, so the block is still open').toBeFalsy();
    expect(events().length, 'nothing reached the agent').toBe(0);
    const since = block.getByRole('radiogroup', { name: 'Changes' }).getByRole('radio', { name: 'Changes since you looked', exact: true });
    await expect(since, 'the diff from the text you saw').toHaveAttribute('aria-checked', 'true');
    await expect(block.locator('.rv-line.add', { hasText: 'Seen on 22 October.' }), 'the added line is marked').toHaveCount(1);
    const draft = block.locator('.rv-thread', { has: page.locator('.status-tag.draft') });
    await expect(draft, 'your draft comment is kept').toContainText('Say which build.');
    expect(await draft.evaluate((d) => d.previousElementSibling?.textContent ?? ''), 'it follows its line').toContain('Steps to reproduce:');
    await expect(block.locator('.stale-note'), 'the notice is announced').toHaveAttribute('role', 'alert');
    await focusOnNotice(page);
    if (process.env.SHOTS) await block.screenshot({ path: join(process.env.SHOTS, 'review-changed.png') });
  });
  await test.step('revision 3 before you submit again: refused again, and announced', async () => {
    tools.update_block({ block: review(V3) });
    await expect(block.locator('.g-mark[data-line="7"]'), 'revision 3 on screen').toBeAttached();
    const writes = watchWrites(page);
    await button(block, 'Submit review').click();
    await writes.answered();
    expect(itemOf().answered, 'still open').toBeFalsy();
    await expect(block.locator('.stale-note')).toHaveAttribute('role', 'alert');
  });
  await test.step('Submit again goes through, for revision 3, with the comment on line 4', async () => {
    await button(block, 'Submit review').click();
    await expect.poll(() => events().find((m) => m.event.blockId === 'issue')?.event.revision, { message: 'the answer, for revision 3' }).toBe(3);
    expect(events()[0].event.values.comments?.[0]?.line, 'the comment on line 4').toBe(4);
    expect(itemOf().answered).toBe(true);
  });
});

test('#123 a choice that changed while you picked: refused with a plain notice, your pick kept and focus on the notice, then sent', async ({ page }) => {
  allowPageError(page, /status of 409/);
  const { itemOf, block, events, tools } = await conversation(page, 'Choice changes', 'choice', 'pick');
  const claims = block.locator('.chip[data-n="2"]');
  await claims.click();
  tools.update_block({ block: choice('Load which first? The claims are ready now.') });
  await expect(block, 'revision 2 of the choice').toContainText('ready now');
  await button(block, 'Send choice').focus();
  await page.keyboard.press('Enter');
  await expect(block.locator('.stale-note')).toHaveText(/^This changed while you were answering\./);
  await expect(claims, 'your pick is kept').toHaveAttribute('aria-checked', 'true');
  await focusOnNotice(page);
  expect(itemOf().answered, 'refused, still open').toBeFalsy();
  await button(block, 'Send choice').click();
  await expect
    .poll(() => events().find((m) => m.event.blockId === 'pick')?.event, { message: 'sent again, for revision 2' })
    .toMatchObject({ revision: 2, values: { selected: ['claims'] } });
});
