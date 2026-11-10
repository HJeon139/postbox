// The person’s submitted comments as review threads (#1143), pure, so the server writes them and the page can draw an
// old answer’s comments the same way. Moved out of server/review-person.mjs.

import { author, PERSON } from './review-comments.mjs';

/**
 * The block with the person’s comments added, each a thread of its own, or a reply in the thread it names; the
 * review that records them; and the comments as the agent hears them, each with its threadId. Ids are
 * you-<revision>-<n>, past any the block already has, so no round collides with another. null with no comments.
 * @param {any} it  the review’s item @param {any} values  the answer’s, checked by buildEvent @param {number} revision
 */
export function personReview(it, values, revision) {
  const given = Array.isArray(values?.comments) ? values.comments : [];
  if (!given.length) return null;
  const threads = [...(it.block.threads ?? [])];
  const ids = new Set(threads.map((t) => t.id));
  const made = new Set();
  let n = 0;
  const comments = given.map(({ text, threadId, ...anchor }) => {
    const k = threadId === undefined ? -1 : threads.findIndex((t) => t.id === threadId);
    if (k > -1) {
      threads[k] = { ...threads[k], comments: [...threads[k].comments, { author: PERSON, text }] };
      made.add(threadId);
      return { ...anchor, threadId, text };
    }
    let id = `you-${revision}-${++n}`;
    while (ids.has(id)) id = `you-${revision}-${++n}`;
    ids.add(id);
    threads.push({ id, status: 'open', ...anchor, comments: [{ author: PERSON, text }] });
    made.add(id);
    return { ...anchor, text, threadId: id };
  });
  return {
    block: { ...it.block, threads },
    reviews: [...(it.reviews ?? []), { person: true, revision, threads: [...made] }],
    values: { ...values, comments },
  };
}

/**
 * An answered review stored before #1143 holds the person’s comments only in its answer: the item as it would be
 * had the answer made them threads, so its first update keeps them. The item as it is when there’s nothing to make.
 * @param {any} it  the block item
 */
export function answerThreads(it) {
  const a = it.answer;
  if (it.block.type !== 'review' || !it.answered || a?.action !== 'submit' || !a.values?.comments?.length) return it;
  const revision = a.revision ?? 1;
  if ((it.reviews ?? []).some((r) => r.person && r.revision === revision)) return it;
  const made = personReview(it, a.values, revision);
  return made ? { ...it, block: made.block, reviews: made.reviews } : it;
}

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
