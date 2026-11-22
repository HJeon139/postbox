// Who wrote a review thread’s comments, as the rule since #1143 reads them: the person, or an agent’s @handle.

import { author } from '../shared/review-comments.mjs';

/**
 * A review stored before the author rule (#1143) may hold a comment whose author isn’t `you` or an @handle, such as
 * the demo’s mock writing “You”. Only the block’s own agent could write one, through show_block or update_block
 * (review_block always wrote its @handle), so each reads as that agent’s: never as the person’s. The item as it is
 * when every author fits, so a review written since costs one pass over its comments.
 * @param {any} it  the block item
 */
export function ownedAuthors(it) {
  const fits = (c) => {
    /** @type {string[]} */
    const errs = [];
    author(c.author, 'author', errs);
    return errs.length === 0;
  };
  const threads = it.block.threads ?? [];
  if (threads.every((t) => t.comments.every(fits))) return it;
  const own = `@${it.handle}`;
  const owned = threads.map((t) => ({ ...t, comments: t.comments.map((c) => (fits(c) ? c : { ...c, author: own })) }));
  return { ...it, block: { ...it.block, threads: owned } };
}
