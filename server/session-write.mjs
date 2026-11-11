// The writes of a session that exists: its changed fields as a session.patch (server/session-patch.mjs), and the
// Postbox notices it reads at the start of its next turn. Each starts from the session as memory will hold it once what
// is held behind a commit is released (store.pending.session), as a thread write does (#796, server/thread-write.mjs):
// diffed against the published session, a change back to its published value was dropped behind a held change, and a
// notice appended to the published context dropped the one before it. A field built from the session's own is built
// in a function of the pending session; tests/session-write-guard.test.mjs places those still built from a published one.

import { itemOf } from '../shared/item-index.mjs';
import { sessionPatch } from './session-patch.mjs';

/**
 * Writes the fields of `change` that change the session, with updatedAt. `change` is the fields to set, or a function
 * of the pending session that returns them, so a field built from the session's own (its context, its backend state)
 * starts from what a held write left. A session that doesn’t exist isn’t written.
 * @param {import('./runtime.mjs').Runtime} rt @param {string} id
 * @param {Record<string, unknown> | ((se: any) => Record<string, unknown>)} change
 */
export function updateSession(rt, id, change) {
  const se = rt.store.pending.session(id);
  if (!se) return;
  const patch = typeof change === 'function' ? change(se) : change;
  rt.store.emit('session.patch', sessionPatch(se, { ...patch, ...needAt(rt, se, patch), updatedAt: Date.now() }));
}

/**
 * With a new need, the time its item was posted, as needsAt (#1155): ⌃J orders by it (shared/needs.mjs, waitedSince),
 * and the page holds no items of a conversation it hasn't opened. It names the need's item, so a need written another
 * way isn't given another's time; a cleared need clears it. Read pending, as the item may have been added behind a commit.
 * @param {import('./runtime.mjs').Runtime} rt @param {any} se @param {Record<string, any>} patch
 */
function needAt(rt, se, patch) {
  if (!Object.hasOwn(patch, 'needs')) return {};
  const need = patch.needs;
  const where = need?.threadId ?? (patch.sideTurn ?? se.sideTurn)?.threadId ?? se.threadId;
  const at = need?.itemId ? itemOf(rt.store.pending.items(where), need.itemId)?.at : undefined;
  return { needsAt: at === undefined ? undefined : { itemId: need.itemId, at } };
}

/** Context the agent reads at the start of its next turn, as a Postbox notice. @param {import('./runtime.mjs').Runtime} rt @param {string} sessionId @param {string} text */
export function tellAgent(rt, sessionId, text) {
  rt.updateSession(sessionId, (se) => ({ context: [...(se.context ?? []), `[Postbox] ${text}`].slice(-20) }));
}

/**
 * A thread's sessions as memory will hold them once what is held is released, as sessionsIn reads the published ones:
 * for a read that decides whether to make a session. One made behind a held commit is only pending, so a second
 * @-mention of the same new agent in that window made a second session, and one persona answered from two (intent.md:
 * one session per persona per conversation).
 * @param {import('./runtime.mjs').Runtime} rt @param {string} threadId @returns {any[]}
 */
export function pendingSessionsIn(rt, threadId) {
  const { members = [] } = rt.store.pending.thread(threadId) ?? {};
  return members.map((/** @type {string} */ id) => rt.store.pending.session(id)).filter((/** @type {any} */ x) => x && !x.deleting);
}
