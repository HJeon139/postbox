// The person corrects a comment of theirs on a review after they submitted it (#858). Their answer belongs to the revision
// they saw (#123), and the agent has read the comment, so it stays as written: the correction is added after it in its
// thread, marked edited, and the agent hears it as an event that names the comment it replaces.

import { COMMENT_MAX, PERSON } from '../shared/review-comments.mjs';
import { httpError, refuseRetired } from './helpers.mjs';

/** The action a correction is, as the page sends it and the agent’s event names it. */
export const CORRECT = 'correct';

/**
 * Adds the person’s correction to their thread, and tells the review’s agent.
 * @param {any} rt @param {string} threadId @param {string} itemId @param {any} values  { threadId, text }
 */
export function correctComment(rt, threadId, itemId, values) {
  const it = rt.store.item(threadId, itemId);
  if (it?.kind !== 'block' || !it.valid || it.block.type !== 'review') throw httpError(409, 'Only a comment on a review can be corrected.');
  const text = typeof values?.text === 'string' ? values.text.trim() : '';
  if (!text) throw httpError(422, 'The correction is empty. Write what your comment should say.');
  if (text.length > COMMENT_MAX) throw httpError(422, `The correction is longer than ${COMMENT_MAX} characters. Shorten it.`);
  const threads = it.block.threads ?? [];
  const at = threads.findIndex((t) => t.id === values?.threadId);
  const thread = threads[at];
  // The comment it replaces: the person’s last in the thread, a correction of theirs included.
  const replaces = thread?.comments.findLast((c) => c.author === PERSON);
  if (!replaces) throw httpError(404, 'That isn’t a comment of yours on this review. Reload the page to see its comments as they are.');
  if (replaces.text === text) return { ok: true, unchanged: true };
  refuseRetired(rt.s.sessions[it.sessionId]);
  const corrected = { ...thread, comments: [...thread.comments, { author: PERSON, text, edited: true }] };
  rt.threads.patchItem(threadId, itemId, { block: { ...it.block, threads: threads.map((t, i) => (i === at ? corrected : t)) } });
  const se = rt.s.sessions[it.sessionId];
  const where = Object.fromEntries(['line', 'col', 'endLine', 'endCol', 'quote', 'anchor'].filter((k) => thread[k] !== undefined).map((k) => [k, thread[k]]));
  const event = { blockId: it.block.id, revision: it.revision ?? 1, action: CORRECT, values: { threadId: thread.id, ...where, replaces: replaces.text, text } };
  // As an answer reaches it (blocks.mjs, act): an entry in the agent’s inbox, pointing at the block.
  if (se) rt.delivery.send({ sessionId: se.id, threadId, source: 'answer', itemId, from: 'you', message: { kind: 'event', event, blockItemId: itemId } });
  return { ok: true };
}
