// What the #858 specs share (review-edit-draft and review-edit-focus): a review with draft comments, editing one, and
// what the agent got. Each spec has its room; these take it.

import { expect } from '@playwright/test';
import { viewRadio } from './review.mjs';

/** @param {() => any} roomOf  the spec’s review room (tests/browser/review.mjs, reviewRoom) */
export function editKit(roomOf) {
  /** The comments the agent got for a block, once the person submits. @param {string} blockId */
  const sent = (blockId) => roomOf().calls.find((m) => m.kind === 'event' && m.event.blockId === blockId)?.event.values.comments;

  /** Opens a draft comment for editing, replaces its text, and saves it with Ctrl+Enter. */
  const edit = async (block, from, to, place) => {
    const draft = block.locator('.rv-thread', { hasText: from });
    // Its buttons and its box name its place, so a screen reader tells one draft from another.
    await expect(draft.getByRole('button', { name: `Delete your comment on ${place}`, exact: true })).toBeVisible();
    await draft.getByRole('button', { name: `Edit your comment on ${place}`, exact: true }).click();
    const box = block.getByRole('textbox', { name: `Edit your comment on ${place}`, exact: true });
    await expect(box, 'it opens with focus in it').toBeFocused();
    await expect(box, 'and its text').toHaveValue(from);
    await box.fill(to);
    await box.press('Control+Enter');
    await expect(box).toHaveCount(0);
    await expect(
      block.locator('.rv-thread', { hasText: to }).getByRole('button', { name: /^Edit your comment on / }),
      'focus goes back to its Edit',
    ).toBeFocused();
    await expect(block.locator('.rv-thread', { hasText: from }), 'the old text is gone').toHaveCount(0);
  };

  /** A review in Lines with draft comments on lines 3 and 5. */
  const twoDrafts = async (page, title) => {
    const r = await roomOf().withReview(page, title);
    await viewRadio(r.block, 'Lines').click();
    for (const [line, text] of [
      [3, 'on three'],
      [5, 'on five'],
    ]) {
      await r.block.locator(`.g-mark[data-line="${line}"]`).click();
      await r.block.getByRole('textbox', { name: `Comment on line ${line}` }).fill(text);
      await r.block.getByRole('button', { name: 'Add draft comment', exact: true }).click();
    }
    const open = async (text) => {
      await r.block
        .locator('.rv-thread', { hasText: text })
        .getByRole('button', { name: /^Edit your comment on / })
        .click();
      return r.block.getByRole('textbox', { name: /^Edit your comment on / });
    };
    return { ...r, open };
  };

  return { sent, edit, twoDrafts };
}
