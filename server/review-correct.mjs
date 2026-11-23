// The person corrects a comment of theirs on a review after they submitted it (#858). Their answer belongs to the revision
// they saw (#123), and the agent has read the comment, so it stays as written: the correction is added after it in its
// thread, marked edited, and the agent hears it as an event that names the comment it replaces.

import { validateBlock } from '../shared/catalog.mjs';
import { COMMENT_MAX, PERSON, personNext, threadsError } from '../shared/review-comments.mjs';
import { httpError, refuseRetired } from './helpers.mjs';

/** The act a correction is, as the page sends it. Like a reaction’s, it can’t be a block’s own action id, which starts
 * with a letter or digit; the agent’s event names it `correct`. */
export const CORRECT = '@correct';

/**
 * Adds the person’s correction to their thread, and tells the review’s agent.
 * @param {any} rt @param {string} threadId @param {string} itemId @param {any} values  { threadId, text }
 */
export function correctComment(rt, threadId, itemId, values) {
  const it = rt.store.item(threadId, itemId);
  if (it?.kind !== 'block' || !it.valid || it.block.type !== 'review') throw httpError(409, 'Only a comment on a review can be corrected.');
  if (it.closed?.by === 'agent') throw httpError(409, `@${it.closed.handle} withdrew this review, so it takes no corrections. Say it in a message instead.`);
  if (it.deletedAgent) throw httpError(409, 'That agent was deleted, so it can’t hear a correction. Say it in a message instead.');
  const text = typeof values?.text === 'string' ? values.text.trim() : '';
  if (!text) throw httpError(422, 'The correction is empty. Write what your comment should say.');
  if (text.length > COMMENT_MAX) throw httpError(422, `The correction is longer than ${COMMENT_MAX.toLocaleString('en-US')} characters. Shorten it.`);
  const threads = it.block.threads ?? [];
  const at = threads.findIndex((t) => t.id === values?.threadId);
  const thread = threads[at];
  // The comment it replaces: the person’s last in the thread, a correction of theirs included.
  const replaces = thread?.comments.findLast((c) => c.author === PERSON);
  if (!replaces) throw httpError(404, 'That isn’t a comment of yours on this review. Reload the page to see its comments as they are.');
  if (replaces.text === text) return { ok: true, unchanged: true };
  refuseRetired(rt.s.sessions[it.sessionId]);
  const corrected = { ...thread, comments: [...thread.comments, { author: PERSON, text, edited: true }] };
  const block = keptWith(
    rt,
    it,
    threads.map((t, i) => (i === at ? corrected : t)),
  );
  rt.threads.patchItem(threadId, itemId, { block });
  const se = rt.s.sessions[it.sessionId];
  const where = Object.fromEntries(['line', 'col', 'endLine', 'endCol', 'quote', 'anchor'].filter((k) => thread[k] !== undefined).map((k) => [k, thread[k]]));
  const event = {
    blockId: it.block.id,
    revision: it.revision ?? 1,
    action: 'correct',
    values: { threadId: thread.id, ...where, replaces: replaces.text, text },
  };
  // As an answer reaches it (blocks.mjs, act): an entry in the agent’s inbox, pointing at the block.
  if (se) rt.delivery.send({ sessionId: se.id, threadId, source: 'answer', itemId, from: 'you', message: { kind: 'event', event, blockItemId: itemId } });
  return { ok: true };
}

/**
 * The review with its corrected threads, within the bounds the catalog keeps for a review (its comments per thread,
 * its threads and their text): a block past them would refuse every update its agent makes.
 * @param {any} rt @param {any} it @param {any[]} threads
 */
function keptWith(rt, it, threads) {
  const full = [];
  threadsError(threads, full, personNext(it.handle));
  if (full.length) throw httpError(422, `Your correction wasn’t sent. ${full.join(' ')}`);
  const v = validateBlock({ ...it.block, threads }, { imageOrigins: rt.apps.config.imageOrigins });
  if (!v.ok)
    throw httpError(
      422,
      `Your correction wasn’t sent: this review can’t hold another comment. ${v.errors.join(' ')} Ask @${it.handle} to show a new review block, and comment there.`,
    );
  return v.block;
}
