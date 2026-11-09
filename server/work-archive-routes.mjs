// The Work view’s route for an archived turn (#305; designs/305-archive-turns.md, A2): GET
// /api/threads/:id/work/turns/:turnId, which “Show details” on a turn’s summary row calls. A module of its own, as
// runtime.mjs is at its ceiling: a function that takes the runtime first.

import { archived } from './work-archive-read.mjs';

/**
 * An archived turn’s entries, for the conversation a thread is (a side or topic thread is refused, as every work route
 * refuses it). Only the work: a reply’s steps are another route’s. Cost: archived()’s, one summary lookup through the
 * work index and one blob read and parse.
 * @param {import('./runtime.mjs').Runtime} rt @param {string} threadId @param {string} turnId
 */
export async function workTurn(rt, threadId, turnId) {
  const convId = rt.workConversation(threadId);
  const turn = await archived(rt.store.state, rt.ledger.blobs, convId, { turnId });
  return { turnId: turn.turnId, work: turn.work };
}
