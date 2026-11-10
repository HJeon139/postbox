// A review’s draft comments, added and not yet submitted, survive a reload (#1144), as the composer’s text draft does:
// on their lines at the same revision, and following their lines when the agent revised while the page was away.
// A submit forgets them. Each test has a conversation of its own, where a scripted @drafter shows the draft
// (tests/browser/review.mjs).

import { expect, test } from '@playwright/test';
import { failOnPageErrors, synced } from './postbox.mjs';
import { commentOn, drawn, reviewRoom } from './review.mjs';

/** @type {Awaited<ReturnType<typeof reviewRoom>>} */
let room;
test.beforeAll(async () => {
  room = await reviewRoom('review-drafts-kept');
});
test.afterAll(async () => {
  await room?.app.stop();
});
failOnPageErrors(test);
test.use({ colorScheme: 'light' });

/** The kept drafts on this page, by key. @param {import('@playwright/test').Page} page */
const kept = (page) => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('pb-review-draft-')));

/** Reloads, and waits for the review to be drawn again. */
async function reload(page, block) {
  await page.reload();
  await synced(page, room.app);
  await drawn(block, 'Preview');
}

test('#1144 a draft comment survives a reload, on its line', async ({ page }) => {
  const { block } = await room.withReview(page, 'Kept');
  await drawn(block, 'Preview');
  await commentOn(page, block, 'low', 'Say how low.');
  await reload(page, block);
  await expect(block.locator('.rv-thread', { hasText: 'Say how low.' }), 'the draft is back').toHaveCount(1);
  await expect(block.getByText('1 draft comment', { exact: true }), 'and counted as one').toBeVisible();
});

test('#1144 a draft comment follows its line into a revision made while the page was away', async ({ page }) => {
  const { block, thread, itemOf } = await room.withReview(page, 'Away');
  await drawn(block, 'Preview');
  await commentOn(page, block, 'low', 'Say how low.');
  await page.goto('about:blank');
  room.app.rt.sendMessage(thread.id, { text: '@drafter revise' });
  await expect.poll(() => itemOf().revision, { message: 'the revision' }).toBe(2);
  await room.idle();
  await page.goto(`${room.app.origin}/#/t/${thread.id}`);
  await synced(page, room.app);
  // A revision with previous opens on its diff, in Lines.
  await expect(block.locator('.rv-line').first()).toBeVisible();
  await expect(block.locator('.rv-thread', { hasText: 'Say how low.' }), 'the draft is back on the new revision').toHaveCount(1);
  // Its line is the same in the new text, so it followed it from previous, unmarked.
  await expect(block.locator('.rv-thread', { hasText: 'Say how low.' }).getByText('Its line changed'), 'not marked moved').toHaveCount(0);
});

test('#1144 submitting forgets the kept drafts', async ({ page }) => {
  const { block, itemOf } = await room.withReview(page, 'Sent');
  await drawn(block, 'Preview');
  await commentOn(page, block, 'low', 'Say how low.');
  await expect.poll(() => kept(page), { message: 'the draft is kept' }).toHaveLength(1);
  await block.getByRole('button', { name: 'Submit review', exact: true }).click();
  await expect.poll(() => itemOf().answered, { message: 'the answer' }).toBe(true);
  await expect.poll(() => kept(page), { message: 'nothing kept once submitted' }).toEqual([]);
  await page.reload();
  await synced(page, room.app);
  await expect(block.getByRole('button', { name: 'Submit review', exact: true }), 'it stays answered').toHaveCount(0);
  expect(await kept(page)).toEqual([]);
});

/** In Lines: the lines marked as commented on, and the status tag of each thread holding text. */
const placed = (block, text) =>
  block.evaluate(
    (b, want) => ({
      marked: [...b.querySelectorAll('.rv-doc .marked .g-ln')].map((n) => Number(/\d+$/.exec(n.textContent ?? '')?.[0])),
      tags: [...b.querySelectorAll('.rv-doc .rv-thread')]
        .filter((t) => t.textContent?.includes(want))
        .flatMap((t) => [...t.querySelectorAll('.status-tag')].map((x) => x.textContent ?? '').filter((x) => x !== 'Draft')),
    }),
    text,
  );

/** Leaves the page, has @drafter take cue, and comes back once it’s revised to `revision`. */
async function awayWhile(page, { thread, itemId, itemOf }, cue, revision) {
  await page.goto('about:blank');
  room.app.rt.sendMessage(thread.id, { text: `@drafter ${cue}` });
  await expect.poll(() => itemOf().revision, { message: `revision ${revision}` }).toBe(revision);
  await room.idle();
  await page.goto(`${room.app.origin}/#/t/${thread.id}`);
  await synced(page, room.app);
  void itemId;
}

test('#1144 a draft whose line is gone from a revision made while away is drawn, marked, and can be deleted', async ({ page }) => {
  const r = await room.withReview(page, 'Shrunk');
  await drawn(r.block, 'Preview');
  await commentOn(page, r.block, 'Steps', 'Which script?');
  // The revision is two lines, with no previous: line 21 is gone.
  await awayWhile(page, r, 'header only', 2);
  await r.block.getByRole('radio', { name: 'Lines', exact: true }).click();
  const draft = r.block.locator('.rv-doc .rv-thread', { hasText: 'Which script?' });
  await expect(draft, 'drawn, as on a page left open').toHaveCount(1);
  await expect(draft.getByText(/^Its (line|text) changed$/), 'and marked').toHaveCount(1);
  await expect(draft.getByRole('button', { name: /delete/i }), 'and it can be deleted').toHaveCount(1);
});

test('#1144 a draft written on revision 2 follows its line into revision 3, whose previous isn’t revision 2’s text', async ({ page }) => {
  const r = await room.withReview(page, 'Third');
  room.app.rt.sendMessage(r.thread.id, { text: '@drafter revise 2' });
  await expect.poll(() => r.itemOf().revision, { message: 'revision 2' }).toBe(2);
  await room.idle();
  await synced(page, room.app);
  await r.block.getByRole('radio', { name: 'Preview', exact: true }).click();
  await drawn(r.block, 'Preview');
  // Line 26, “Revision 2.”, is only in revision 2’s text.
  await commentOn(page, r.block, 'Revision 2.', 'Name it.');
  // As #248's agent revises: previous is the first draft, not revision 2’s text.
  await awayWhile(page, r, 'revise 3', 3);
  await r.block.getByRole('radio', { name: 'Lines', exact: true }).click();
  // Its text is gone from revision 3, so it’s marked, as on a page left open; read from the first draft, it was unmarked.
  await expect.poll(() => placed(r.block, 'Name it.'), { message: 'marked as its text changed' }).toEqual({ marked: [26], tags: ['Its text changed'] });
});

test('#1144 a review answered while the page was away has its kept draft forgotten on the next load', async ({ page }) => {
  const r = await room.withReview(page, 'Elsewhere');
  await drawn(r.block, 'Preview');
  await commentOn(page, r.block, 'low', 'Say how low.');
  await expect.poll(() => kept(page), { message: 'the draft is kept' }).toHaveLength(1);
  await page.goto('about:blank');
  // Answered in another tab: the server has it, and this page's storage still has the draft.
  room.app.rt.act(r.thread.id, r.itemOf().id, 'submit', { verdict: 'approve', comments: [] }, 1);
  await room.idle();
  await page.goto(`${room.app.origin}/#/t/${r.thread.id}`);
  await synced(page, room.app);
  await expect(r.block).toBeVisible();
  await expect.poll(() => kept(page), { message: 'forgotten once the review shows answered' }).toEqual([]);
});

test('#1144 at most 20 review drafts are kept, the oldest dropped first, never the one being written', async ({ page }) => {
  await page.goto(`${room.app.origin}/`);
  await synced(page, room.app);
  const left = await page.evaluate(async () => {
    const store = await import('/app/js/review-draft-store.mjs');
    const draft = (text) => ({ comments: [{ line: 1, text }], verdict: 'comment', on: 'one line' });
    for (let i = 1; i <= 22; i++) store.keepReviewDraft(`it_r${i}`, 1, draft(`note ${i}`));
    // Writing an old one again makes it the newest.
    store.keepReviewDraft('it_r3', 1, draft('note 3, again'));
    return Object.keys(localStorage)
      .filter((k) => k.startsWith('pb-review-draft-'))
      .map((k) => k.slice('pb-review-draft-'.length))
      .sort();
  });
  const want = ['it_r3', ...Array.from({ length: 19 }, (_, i) => `it_r${i + 4}`)].sort();
  expect(left).toEqual(want);
});
