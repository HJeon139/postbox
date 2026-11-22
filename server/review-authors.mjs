// Who wrote a review thread’s comments, as the rule since #1143 reads them: the person, or an agent’s @handle.

import { author, PERSON } from '../shared/review-comments.mjs';

/** Whether a comment’s author fits the rule: the person, or an agent’s @handle. @param {any} c */
const fits = (c) => {
  /** @type {string[]} */
  const errs = [];
  author(c?.author, 'author', errs);
  return errs.length === 0;
};

/**
 * A review stored before the author rule (#1143) may hold a comment whose author isn’t `you` or an @handle, such as
 * the demo’s mock writing “You”. Only the block’s own agent could write one, through show_block or update_block
 * (review_block always wrote its @handle), so each reads as that agent’s: never as the person’s. The item as it is
 * when every author fits, so a review written since costs one pass over its comments.
 * @param {any} it  the block item
 */
export function ownedAuthors(it) {
  const threads = it.block.threads ?? [];
  if (threads.every((t) => t.comments.every(fits))) return it;
  const own = `@${it.handle}`;
  const owned = threads.map((t) => ({ ...t, comments: t.comments.map((c) => (fits(c) ? c : { ...c, author: own })) }));
  return { ...it, block: { ...it.block, threads: owned } };
}

/**
 * A review update as its agent sent it, its authors read before the catalog checks the block (#1208). An agent sends
 * back the person’s comments as it read them, by “The person” (read_message) or “You” (earlier), or with a name the
 * rule doesn’t take. Each such comment reads as the person’s, so ownComments keeps it only where it is a comment the
 * person wrote in that thread, and leaves out any other, which it counts for the agent’s reply. A thread keeps what
 * it held, so its status still changes. Nothing becomes the person’s that wasn’t: only stored comments come back.
 * @param {any} block  the update, unchecked
 */
export function echoedAuthors(block) {
  if (block?.type !== 'review' || !Array.isArray(block.threads)) return block;
  const threads = block.threads.map((t) => {
    if (!Array.isArray(t?.comments)) return t;
    return { ...t, comments: t.comments.map((c) => (fits(c) ? c : { ...c, author: PERSON })) };
  });
  return { ...block, threads };
}

/** The longest author a refusal quotes back. */
const QUOTED = 60;

/**
 * The first author of a new review’s comments that isn’t its agent’s own @handle, as a refusal names it (empty when
 * a comment has none), or null when every comment is the agent’s (#1177, #1208).
 * @param {any} block @param {string} handle
 */
export function otherAuthor(block, handle) {
  const threads = Array.isArray(block?.threads) ? block.threads : [];
  for (const t of threads) {
    const comments = Array.isArray(t?.comments) ? t.comments : [];
    const other = comments.find((c) => c?.author !== `@${handle}`);
    if (!other) continue;
    if (typeof other?.author !== 'string') return '';
    return other.author.length > QUOTED ? `${other.author.slice(0, QUOTED - 1)}…` : other.author;
  }
  return null;
}
