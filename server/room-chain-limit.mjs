// A room’s wake chain limit (#1035): how many agent wakes in a row, without the person, before the next waits for their
// Allow. It’s saved on the conversation, beside the count it caps (hops), so a topic thread’s is its conversation’s;
// unset, it’s the server’s default (HOP_LIMIT, which POSTBOX_CHAIN_LIMIT sets). Only the person sets it, through PATCH
// /api/threads/:id behind the page’s token: an agent that could raise the cap that stops agents would remove the
// backstop (designs/intent.md, principle 6). tests/room-chain-limit-routes.test.mjs holds that nothing else writes it.

import { HOP_LIMIT, isRoomChainLimit, ROOM_CHAIN_LIMIT_TAKES } from '../shared/limits.mjs';
import { httpError } from './helpers.mjs';
import { updateThread } from './thread-write.mjs';

/**
 * The chain limit of the room a thread is in: the conversation’s own, else the server’s default. Read pending, as the
 * check that uses it reads the count (#796).
 * @param {any} rt @param {string} threadId  the conversation, or one of its topic or side threads
 * @returns {number}
 */
export function roomChainLimit(rt, threadId) {
  return rt.store.pending.thread(rt.lineage(threadId).at(-1))?.chainLimit ?? HOP_LIMIT;
}

/**
 * The person’s PATCH /api/threads/:id: a new name, the room’s chain limit (a whole number from 1 to MAX_HOP_LIMIT, or
 * null for the server’s default), or both. A bad value of either changes neither. The limit is saved on the
 * conversation, even when the PATCH names one of its topic threads. Returns the thread as last written.
 * @param {any} rt @param {string} threadId @param {{ title?: unknown, chainLimit?: unknown }} body
 */
export function patchThread(rt, threadId, body) {
  const b = body ?? {};
  if (!Object.hasOwn(b, 'chainLimit')) return rt.renameThread(threadId, b.title);
  rt.thread(threadId);
  if (b.chainLimit !== null && !isRoomChainLimit(b.chainLimit)) throw httpError(422, ROOM_CHAIN_LIMIT_TAKES);
  if (Object.hasOwn(b, 'title')) rt.renameThread(threadId, b.title);
  return updateThread(rt, rt.lineage(threadId).at(-1), { chainLimit: b.chainLimit });
}
