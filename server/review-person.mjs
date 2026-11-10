// The person’s review comments as threads on the block (#1143). Their answer turns each submitted comment into an
// open thread, authored PERSON, and records them as the person’s review in the item’s reviews, so a revision keeps
// them as it keeps a reviewer’s (keepReviewThreads). An update may add comments only as the block’s own agent: only
// the answer writes the person’s, and only review_block another agent’s.

import { validateBlock } from '../shared/catalog.mjs';
import { PERSON, personNext, threadsError } from '../shared/review-comments.mjs';
import { httpError } from './helpers.mjs';
import { keepReviewThreads } from './review-comments.mjs';

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
 * The update’s threads with every comment it adds in anyone’s name but the block’s agent’s left out (#1143): in a
 * new thread, or added to one it has. A comment already stored keeps its text and author. dropped says how many went, for the agent’s reply.
 * @param {any} existing  the block item as it was @param {any} block  the update, validated
 */
export function ownComments(existing, block) {
  if (!Array.isArray(block.threads)) return { block, dropped: 0 };
  const own = `@${existing.handle}`;
  const stored = new Map((existing.block.threads ?? []).map((t) => [t.id, t]));
  const key = (c) => JSON.stringify([c.author, c.text]);
  let dropped = 0;
  const threads = [];
  for (const t of block.threads) {
    const said = new Map();
    for (const c of stored.get(t.id)?.comments ?? []) said.set(key(c), (said.get(key(c)) ?? 0) + 1);
    const comments = t.comments.filter((c) => {
      const n = said.get(key(c)) ?? 0;
      if (n) said.set(key(c), n - 1);
      return n > 0 || c.author === own;
    });
    dropped += t.comments.length - comments.length;
    // A thread it has keeps what it held, so its status still changes; a new one with nothing left goes.
    const kept = comments.length ? comments : stored.get(t.id)?.comments;
    if (kept) threads.push({ ...t, comments: kept });
  }
  return { block: { ...block, threads }, dropped };
}

/** What the agent is told of comments ownComments left out. @param {number} n @param {string} handle */
export const droppedText = (n, handle) =>
  n
    ? ` ${n} comment${n === 1 ? ' in another name wasn’t' : 's in another name weren’t'} added: update_block adds comments only as @${handle}. The person’s come from their answer, and another agent’s from review_block.`
    : '';

/**
 * The submitted comment that replies in a thread the review doesn’t have, which only a hand-built answer sends, or
 * undefined. Only a submit is checked: an answer from before #1143 becomes threads as it is (answerThreads).
 * @param {any} it  the review’s item @param {any} values  the answer’s
 */
function strayReply(it, values) {
  const ids = new Set((it.block.threads ?? []).map((t) => t.id));
  return (Array.isArray(values?.comments) ? values.comments : []).find((c) => c.threadId !== undefined && !ids.has(c.threadId));
}

/**
 * What the person’s answer to a review writes beside it (#1143): the block with their comments as threads, and the
 * reviews that record them, checked as a whole; and the event the agent hears, each comment with its threadId.
 * null when it isn’t a review, or has no comments. A reply in a thread it doesn’t have, or past the block’s bounds,
 * it’s refused, and nothing is written.
 * @param {any} rt @param {any} it  the review’s item @param {any} event  the answer’s, from buildEvent @param {number} revision
 */
export function personAnswer(rt, it, event, revision) {
  if (it.block.type !== 'review') return null;
  const stray = strayReply(it, event.values);
  if (stray)
    throw httpError(422, `Your review wasn’t sent: it replies in thread “${stray.threadId}”, which this review doesn’t have. Reload the page and reply again.`);
  const made = personReview(it, event.values, revision);
  if (!made) return null;
  // Past its bounds, said as what the person can do: they can’t resolve a thread or show a block, but its agent can.
  const full = [];
  threadsError(made.block.threads, full, personNext(it.handle));
  if (full.length) throw httpError(422, `Your review wasn’t sent, so it still waits on you. ${full.join(' ')}`);
  const v = validateBlock(made.block, { imageOrigins: rt.config.imageOrigins });
  if (!v.ok)
    throw httpError(
      422,
      `Your review wasn’t sent: this block can’t hold its comments. ${v.errors.join(' ')} Ask @${it.handle} to show a new review block with the text so far, and comment there.`,
    );
  return { patch: { block: v.block, reviews: made.reviews }, event: { ...event, values: made.values } };
}

/**
 * A review update’s threads (#133, #1143): an answer from before #1143 becomes threads first, the update’s comments
 * in any name but its agent’s are left out, and the threads it leaves out that others started stay. existing is the
 * item as the update reads it, reviews what to write beside it when that changed, and note what the agent is told
 * of comments left out. Not a review: the block as it is.
 * @param {any} found  the block item as it was @param {any} block  the update, validated
 */
export function revisedReview(found, block) {
  if (block.type !== 'review') return { existing: found, block, reviews: {}, note: '' };
  const existing = answerThreads(found);
  const own = ownComments(existing, block);
  return {
    existing,
    block: keepReviewThreads(existing, own.block),
    reviews: existing === found ? {} : { reviews: existing.reviews },
    note: droppedText(own.dropped, existing.handle),
  };
}
